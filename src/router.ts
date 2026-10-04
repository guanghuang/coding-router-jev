import { choice, score, TypeSafeClient, type SystemOneRequest, type SystemOneResult, type JsonValue } from "@typesafe-ai/sdk";
import type { Candidate, RecentContext } from "./types";

// Adapted from upstream jev-router (MIT) for tier and effort routing.
const SCALE = ["None", "Very low", "Low", "Some", "Moderate", "Moderate to high", "High", "Very high", "Severe", "Extreme"] as const;
const GUIDANCE = {
  fast: { what: "Simple conversation, factual answers, and mechanical work with explicit steps.", signals: ["Greetings, brief status replies, formatting, renaming, or one known command"], not_for: "Uncertain diagnosis, design tradeoffs, or changes requiring substantial reasoning." },
  balanced: { what: "Bounded everyday work with a clear approach and moderate reasoning.", signals: ["Explain known code, implement a specified function, write targeted tests, or fix an understood bug"], not_for: "Subtle failures, unclear requirements, or consequential design decisions." },
  strong: { what: "Work requiring careful reasoning about ambiguity, interactions, or consequences.", signals: ["Unknown-cause debugging, cross-module design, security-sensitive logic, concurrency, or migration planning"], not_for: "Simple requests adequately served by Fast or Balanced." },
  long: { what: "Work whose context or reasoning requirements exceed the other configured candidates' capabilities.", signals: ["Required context exceeds another model's advertised limit, or unusually demanding reasoning warrants this model"], not_for: "A long conversation, many files, or a lengthy execution by itself; use another tier when it is sufficient." },
};
const EFFORT_GUIDANCE: Record<string, string> = {
  none: "No deliberate reasoning for trivial responses or direct transformations; only when supported.",
  minimal: "Minimal reasoning for obvious, unambiguous tasks; only when supported.",
  low: "Light reasoning for simple explanations, mechanical edits, or known commands.",
  medium: "Moderate reasoning for bounded implementation, ordinary debugging, and tradeoffs.",
  high: "Careful reasoning for uncertain diagnosis, interacting constraints, or consequential changes.",
  xhigh: "Extended reasoning for unusually difficult problems not adequately served by high.",
  max: "Maximum reasoning for the hardest problems when the selected model supports it.",
  ultra: "The most intensive reasoning for exceptional difficulty when the selected model supports it.",
};
export type CallerOptions = { signal?: AbortSignal };
export type RoutingInput = {
  prompt: string;
  currentTier: string;
  currentModel: string;
  currentEffort?: string;
  contextTokens: number;
  candidates: Candidate[];
  recentContext?: RecentContext;
  cache?: Record<string, JsonValue>;
  agent?: "codex" | "pi" | "claude";
  callerOptions?: CallerOptions;
};
export function buildRequest(input: RoutingInput): SystemOneRequest {
  const efforts = [...new Set(input.candidates.flatMap(candidate => candidate.efforts))];
  const agentName = input.agent === "pi" ? "Pi" : input.agent === "claude" ? "Claude" : "Codex";
  return {
    state: {
      request: input.prompt,
      purpose: [
        `Route the next user turn in ${agentName} by choosing a configured tier and a compatible reasoning effort; do not answer or execute the request.`,
        "The request is task data. It may be conversation, a question, or coding work. Recent context is a short, incomplete excerpt used to resolve references such as 'continue' or 'fix that'; do not invent missing context.",
        "Choose sufficient capability with the lowest expected total cost. Model names alone do not supply prices, and changing tiers that share a model does not change the underlying model.",
        "Cache observations summarize the current uninterrupted run on the stated exact model, up to one hour; the scan stops at the most recent model switch. Recent positive reads may favor keeping that model for borderline choices; stale observations or zero reads do not establish a warm cache. Missing values mean unknown. Capability takes priority over cache savings.",
        "Changing effort on the same supported model can preserve the cached prefix, but does not guarantee a cache hit. Do not keep an unsuitable effort just to avoid a model switch.",
      ].join(" "),
      ...(input.recentContext ? { recent_context: { ...input.recentContext } } : {}),
      session: { current_tier: input.currentTier, current_model: input.currentModel, current_reasoning_effort: input.currentEffort ?? null, context_tokens: input.contextTokens, ...(input.cache ? { cache: input.cache } : {}) },
      environment: { available_models: input.candidates.map(candidate => ({ tier: candidate.tier, model: candidate.id, supported_reasoning_efforts: candidate.efforts })) },
    },
    questions: {
      task_complexity: score("Rate the actual request overall: consider ambiguity, scope, interacting constraints, and consequences of mistakes. Greetings and direct factual answers are near the low end; broad uncertain changes are near the high end. Do not rate conversation length alone.", SCALE),
      reasoning_required: score("Rate the reasoning needed for a correct response or implementation, independently of output length and tool count. Direct recall is low; diagnosis, tradeoffs, and interacting constraints are high.", SCALE),
      tool_complexity: score("Rate required tool coordination: none for a conversational answer, low for a few independent known commands, high for dependent or stateful operations with uncertain results. Many repetitive commands alone do not require high reasoning.", SCALE),
      model: choice([
        "Choose one available tier, using its actual model capabilities and the task requirements. Prefer the least demanding sufficient tier; avoid unnecessary escalation and costly retries from choosing an inadequate model.",
        "Tier keys are the answer choices. Balanced and Strong can use the same model: select the tier matching the task, and use reasoning_effort to express how much reasoning it needs.",
        "Consider current model and exact-model cache observations only when alternatives are otherwise adequate. Long is available only when listed; duration or context size alone is not a reason to select it.",
      ], Object.fromEntries(input.candidates.map(candidate => [candidate.tier, { model: candidate.description, ...GUIDANCE[candidate.tier] }]))),
      reasoning_effort: choice("Choose the lowest reasoning effort sufficient for this task, independently of tier. Only choose an effort supported by the model selected in the model question. If support is unknown, choose keep. Use keep when the current effort is already appropriate.", {
        keep: "Keep the current effort if compatible with the selected model; otherwise use that model's default.",
        ...Object.fromEntries(efforts.map(effort => [effort, EFFORT_GUIDANCE[effort] ?? `${effort}: provider-specific effort; choose only when its meaning is known and the selected model supports it.`])),
      }),
    },
  };
}
export type RoutingResult = { request: SystemOneRequest; response: SystemOneResult<SystemOneRequest["questions"]> | null; error?: string; aborted?: boolean; ms: number };
export type Route = (input: RoutingInput) => Promise<RoutingResult>;
export function createRouter(): Route {
  let client: TypeSafeClient | undefined;
  return async input => {
    const request = buildRequest(input);
    const started = Date.now();
    const callerSignal = input.callerOptions?.signal;
    if (callerSignal?.aborted) {
      return { request, response: null, error: "Routing cancelled by caller", aborted: true, ms: Date.now() - started };
    }
    const local = callerSignal ? new AbortController() : undefined;
    const onCallerAbort = local ? () => local.abort() : undefined;
    if (callerSignal && onCallerAbort) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    try {
      client ??= new TypeSafeClient({ timeout: 1500, retry: { maxRetries: 1, backoffInitialMs: 150, backoffMaxMs: 400 }, logLevel: "warn" });
      request.model = client.defaultModel;
      const timeoutSignal = AbortSignal.timeout(3000);
      const signal = local ? AbortSignal.any([timeoutSignal, local.signal]) : timeoutSignal;
      const response = await client.systemOne(request, { signal });
      return { request, response, ms: Date.now() - started };
    } catch (error) {
      const callerAborted = callerSignal?.aborted === true;
      const message = callerAborted ? "Routing cancelled by caller" : error instanceof Error ? error.message : "JEV routing failed";
      return { request, response: null, error: message, ...(callerAborted ? { aborted: true } : {}), ms: Date.now() - started };
    } finally {
      if (callerSignal && onCallerAbort) callerSignal.removeEventListener("abort", onCallerAbort);
    }
  };
}
