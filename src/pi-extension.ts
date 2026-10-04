import { configFromEnv, type Config } from "./config";
import { createRouter, buildRequest, type CallerOptions, type Route, type RoutingResult } from "./router";
import { decide, decisionLabel, checkEligibility } from "./policy";
import { TIERS, type Candidate, type Tier, type ContextEvidence } from "./types";
import { formatFeedback, type FeedbackValues } from "./feedback";

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

export type PiModelInfo = {
  provider: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  thinkingLevels?: PiThinkingLevel[];
  authenticated?: boolean;
};

export type AdapterState = {
  tier: Tier;
  provider: string;
  modelId: string;
  effectiveEffort: PiThinkingLevel;
  version: number;
};

export type AdapterResult = {
  provider: string;
  modelId: string;
  thinkingLevel: PiThinkingLevel;
  tier: Tier;
  decision?: string;
  confidence?: number | null;
  fromClassifier: boolean;
  state: AdapterState;
};

export type PiRequest = {
  reason: "user" | "continuation" | "retry" | "direct";
  text?: string;
  previous?: { provider: string; modelId: string; thinkingLevel?: string };
  failed?: { provider: string; modelId: string; thinkingLevel?: string };
  priorContext?: { userExcerpt?: string; assistantExcerpt?: string };
  contextTokens?: number;
  signal?: AbortSignal;
  state?: AdapterState;
};

export type PiModelRegistry = {
  find(provider: string, modelId: string): PiModelInfo | undefined;
  list(): PiModelInfo[];
};

export type PiClamp = {
  getSupportedThinkingLevels(model: { provider: string; modelId: string }): PiThinkingLevel[];
  clampThinkingLevel(model: { provider: string; modelId: string }, level: PiThinkingLevel): PiThinkingLevel;
};

function splitPiModelId(qualified: string): { provider: string; modelId: string } {
  const idx = qualified.indexOf("/");
  if (idx < 0) return { provider: "", modelId: qualified };
  return { provider: qualified.slice(0, idx), modelId: qualified.slice(idx + 1) };
}

export function piCandidatesFor(
  config: Config,
  registry: PiModelRegistry,
): { candidates: Candidate[]; errors: string[] } {
  const errors: string[] = [];
  const candidates: Candidate[] = [];

  for (const tier of TIERS) {
    if (tier === "long" && !config.longModelEnabled) continue;
    const qualified = config.piModels[tier];
    const { provider, modelId } = splitPiModelId(qualified);
    const info = registry.find(provider, modelId);

    if (!info) {
      errors.push(`Tier ${tier}: model ${qualified} not found in Pi registry. Check CODING_ROUTER_${tier.toUpperCase()}_MODEL_PI or verify the model is available.`);
      continue;
    }

    if (info.authenticated === false) {
      errors.push(`Tier ${tier}: model ${qualified} is not authenticated. Provide credentials for provider "${provider}".`);
      continue;
    }

    const efforts = (info.thinkingLevels ?? []).filter(l => typeof l === "string") as string[];
    const capacity = info.contextWindow ? { contextWindow: info.contextWindow } : undefined;
    const description = [
      info.displayName ?? modelId,
      info.contextWindow && `${info.contextWindow} context tokens`,
    ].filter(Boolean).join("; ");

    candidates.push({
      tier,
      id: qualified,
      description,
      efforts,
      defaultEffort: efforts.includes("medium") ? "medium" : efforts[0],
      capacity,
    });
  }

  return { candidates, errors };
}

export function resolveEffort(
  jevEffort: string | undefined,
  candidate: Candidate,
  priorLevel: PiThinkingLevel | undefined,
  clamp: PiClamp,
  modelRef: { provider: string; modelId: string },
): PiThinkingLevel {
  const supported = clamp.getSupportedThinkingLevels(modelRef);

  if (supported.length === 0 || (supported.length === 1 && supported[0] === "off")) {
    return "off";
  }

  if (jevEffort && jevEffort !== "keep" && supported.includes(jevEffort as PiThinkingLevel)) {
    return clamp.clampThinkingLevel(modelRef, jevEffort as PiThinkingLevel);
  }

  if (priorLevel && supported.includes(priorLevel)) {
    return clamp.clampThinkingLevel(modelRef, priorLevel);
  }

  const fallback = candidate.defaultEffort as PiThinkingLevel | undefined;
  if (fallback && supported.includes(fallback)) {
    return clamp.clampThinkingLevel(modelRef, fallback);
  }

  return clamp.clampThinkingLevel(modelRef, supported.includes("medium") ? "medium" : supported[0]);
}

export function estimateContextTokens(request: PiRequest): ContextEvidence {
  const text = request.text ?? "";
  const tokens = Math.max(1, Math.round(text.length / 4));
  return { tokens, source: "estimated", accuracy: "character-based heuristic, not a tokenizer measurement" };
}

export function validateSavedState(
  saved: unknown,
  registry: PiModelRegistry,
): AdapterState | null {
  if (!saved || typeof saved !== "object") return null;
  const s = saved as Record<string, unknown>;
  if (s.version !== 1) return null;
  if (typeof s.provider !== "string" || !s.provider || typeof s.modelId !== "string" || !s.modelId) return null;
  if (typeof s.tier !== "string" || !TIERS.includes(s.tier as Tier)) return null;
  if (typeof s.effectiveEffort !== "string" || !PI_THINKING_LEVELS.includes(s.effectiveEffort as PiThinkingLevel)) return null;

  const info = registry.find(s.provider, s.modelId);
  if (!info) return null;
  if (info.authenticated === false) return null;

  return {
    tier: s.tier as Tier,
    provider: s.provider,
    modelId: s.modelId,
    effectiveEffort: s.effectiveEffort as PiThinkingLevel,
    version: 1,
  };
}

export function reconcileState(
  saved: AdapterState,
  previous: { provider: string; modelId: string; thinkingLevel?: string } | undefined,
  config: Config,
  registry: PiModelRegistry,
  clamp: PiClamp,
): AdapterState {
  if (!previous) return saved;

  if (previous.provider === saved.provider && previous.modelId === saved.modelId) {
    const level = previous.thinkingLevel as PiThinkingLevel | undefined;
    const supported = clamp.getSupportedThinkingLevels({ provider: saved.provider, modelId: saved.modelId });
    const effort = level && supported.includes(level)
      ? clamp.clampThinkingLevel({ provider: saved.provider, modelId: saved.modelId }, level)
      : saved.effectiveEffort;
    return { ...saved, effectiveEffort: effort };
  }

  const prevInfo = registry.find(previous.provider, previous.modelId);
  if (!prevInfo || prevInfo.authenticated === false) return saved;

  const { candidates } = piCandidatesFor(config, registry);
  const qualifiedPrev = `${previous.provider}/${previous.modelId}`;
  const matchingCandidate = candidates.find(
    c => c.id === qualifiedPrev && c.tier === saved.tier,
  ) ?? candidates.find(c => c.id === qualifiedPrev);

  if (!matchingCandidate) return saved;

  const level = previous.thinkingLevel as PiThinkingLevel | undefined;
  const supported = clamp.getSupportedThinkingLevels({ provider: previous.provider, modelId: previous.modelId });
  const effort = level && supported.includes(level)
    ? clamp.clampThinkingLevel({ provider: previous.provider, modelId: previous.modelId }, level)
    : resolveEffort(undefined, matchingCandidate, undefined, clamp, { provider: previous.provider, modelId: previous.modelId });

  return {
    tier: matchingCandidate.tier,
    provider: previous.provider,
    modelId: previous.modelId,
    effectiveEffort: effort,
    version: 1,
  };
}

export type PiHistoryHandle = {
  path: string;
  append(record: unknown): void;
};

export type PiNotify = (message: string) => void;

type CreateAdapterOptions = {
  config?: Config;
  route?: Route;
  registry: PiModelRegistry;
  clamp: PiClamp;
  onResult?: (result: AdapterResult) => void;
  history?: PiHistoryHandle;
  onNotify?: PiNotify;
  feedbackFormat?: string;
  sessionId?: string;
  branchId?: string;
};

export function createPiAdapter(options: CreateAdapterOptions) {
  const config = options.config ?? configFromEnv();
  const route = options.route ?? createRouter();
  const { registry, clamp, onResult, history, onNotify, feedbackFormat, sessionId, branchId } = options;

  let state: AdapterState | undefined;
  let pending: Promise<AdapterResult> | undefined;
  let decisionCounter = 0;

  function getStartupState(): AdapterState {
    const { candidates, errors } = piCandidatesFor(config, registry);
    const startTier = config.startTier;
    const startCandidate = candidates.find(c => c.tier === startTier) ?? candidates.find(c => c.tier === "fast");
    if (!startCandidate) {
      throw new Error(`No valid Pi models configured: ${errors.join("; ")}. Check CODING_ROUTER_*_MODEL_PI environment variables.`);
    }
    const { provider, modelId } = splitPiModelId(startCandidate.id);
    const effort = resolveEffort(undefined, startCandidate, undefined, clamp, { provider, modelId });
    return { tier: startCandidate.tier, provider, modelId, effectiveEffort: effort, version: 1 };
  }

  function restoreFromRequest(request: PiRequest): void {
    if (!request.state) return;
    const validated = validateSavedState(request.state, registry);
    if (!validated) {
      state = undefined;
      return;
    }
    state = reconcileState(validated, request.previous, config, registry, clamp);
  }

  async function resolveModel(request: PiRequest): Promise<AdapterResult> {
    if (request.reason === "direct") {
      return handleDirect(request);
    }
    restoreFromRequest(request);
    if (request.reason === "continuation") {
      return handleContinuation(request);
    }
    if (request.reason === "retry") {
      return handleRetry(request);
    }
    const prior = pending ?? Promise.resolve();
    const job = prior.catch(() => {}).then(() => handleUser(request));
    pending = job;
    try { return await job; } finally { if (pending === job) pending = undefined; }
  }

  function normalizePreviousLevel(
    prev: { provider: string; modelId: string; thinkingLevel?: string },
    piClamp: PiClamp,
  ): PiThinkingLevel {
    const supported = piClamp.getSupportedThinkingLevels({ provider: prev.provider, modelId: prev.modelId });
    if (prev.thinkingLevel && supported.includes(prev.thinkingLevel as PiThinkingLevel)) {
      return piClamp.clampThinkingLevel({ provider: prev.provider, modelId: prev.modelId }, prev.thinkingLevel as PiThinkingLevel);
    }
    if (supported.length === 0 || (supported.length === 1 && supported[0] === "off")) return "off";
    return piClamp.clampThinkingLevel(
      { provider: prev.provider, modelId: prev.modelId },
      supported.includes("medium") ? "medium" : supported[0],
    );
  }

  function handleContinuation(request: PiRequest): AdapterResult {
    if (request.previous) {
      const level = normalizePreviousLevel(request.previous, clamp);
      return buildResult(request.previous.provider, request.previous.modelId, level, state?.tier ?? config.startTier, false);
    }
    const s = state ?? getStartupState();
    return buildResult(s.provider, s.modelId, s.effectiveEffort, s.tier, false);
  }

  function handleRetry(request: PiRequest): AdapterResult {
    if (request.failed) {
      const level = normalizePreviousLevel(request.failed, clamp);
      return buildResult(request.failed.provider, request.failed.modelId, level, state?.tier ?? config.startTier, false);
    }
    if (request.previous) {
      const level = normalizePreviousLevel(request.previous, clamp);
      return buildResult(request.previous.provider, request.previous.modelId, level, state?.tier ?? config.startTier, false);
    }
    const s = state ?? getStartupState();
    return buildResult(s.provider, s.modelId, s.effectiveEffort, s.tier, false);
  }

  function handleDirect(request: PiRequest): AdapterResult {
    if (request.previous) {
      const level = normalizePreviousLevel(request.previous, clamp);
      return buildResult(request.previous.provider, request.previous.modelId, level, state?.tier ?? config.startTier, false);
    }
    const { candidates } = piCandidatesFor(config, registry);
    const fastCandidate = candidates.find(c => c.tier === "fast");
    if (!fastCandidate) {
      const s = state ?? getStartupState();
      return buildResult(s.provider, s.modelId, s.effectiveEffort, s.tier, false);
    }
    const { provider, modelId } = splitPiModelId(fastCandidate.id);
    const effort = resolveEffort(undefined, fastCandidate, undefined, clamp, { provider, modelId });
    return buildResult(provider, modelId, effort, "fast", false);
  }

  async function handleUser(request: PiRequest): Promise<AdapterResult> {
    const { candidates, errors } = piCandidatesFor(config, registry);
    if (candidates.length === 0) {
      throw new Error(`No eligible Pi models: ${errors.join("; ")}`);
    }

    if (!state) state = getStartupState();

    const prompt = request.text ?? "";
    const prevTier = state.tier;
    const prevModel = `${state.provider}/${state.modelId}`;
    const prevEffort = state.effectiveEffort;
    const baseMeta = { reason: "user" as const, prompt, previousTier: prevTier, previousModel: prevModel, previousEffort: prevEffort };

    if (!prompt) {
      return buildResult(state.provider, state.modelId, state.effectiveEffort, state.tier, false, undefined, undefined, baseMeta);
    }

    const contextEvidence = estimateContextTokens(request);
    const contextTokens = Number.isFinite(request.contextTokens) && request.contextTokens! >= 0
      ? request.contextTokens! : contextEvidence.tokens;

    const eligibility = checkEligibility(candidates, contextTokens, 16_000);
    const eligibleCandidates = [...eligibility.eligible, ...eligibility.unknown];
    if (eligibleCandidates.length === 0) {
      return buildResult(state.provider, state.modelId, state.effectiveEffort, state.tier, false, "capacity/no-eligible", null,
        { ...baseMeta, capacityStatus: "no-eligible", capacityReason: "all candidates rejected by capacity check" });
    }

    const recentContext = config.sendRecentContext && request.priorContext ? {
      previous_user_request: (request.priorContext.userExcerpt ?? "").slice(0, 1000),
      ...(request.priorContext.assistantExcerpt ? { previous_assistant_excerpt: request.priorContext.assistantExcerpt.slice(0, 1000) } : {}),
    } : undefined;

    const currentQualifiedModel = `${state.provider}/${state.modelId}`;
    const callerOptions: CallerOptions = { signal: request.signal };
    const routingInput = {
      prompt,
      currentTier: state.tier,
      currentModel: currentQualifiedModel,
      currentEffort: state.effectiveEffort,
      contextTokens,
      candidates: eligibleCandidates,
      recentContext,
      agent: "pi" as const,
      callerOptions,
    };

    let result: RoutingResult;
    try {
      result = await route(routingInput);
    } catch (error) {
      const callerAborted = request.signal?.aborted === true;
      result = {
        request: buildRequest(routingInput),
        response: null,
        error: callerAborted ? "Routing cancelled by caller" : (error instanceof Error ? error.message : "JEV routing failed"),
        ...(callerAborted ? { aborted: true } : {}),
        ms: 0,
      };
    }

    if (result.aborted) {
      return buildResult(state.provider, state.modelId, state.effectiveEffort, state.tier, false);
    }

    if (!result.response) {
      return buildResult(state.provider, state.modelId, state.effectiveEffort, state.tier, false, "JEV/unavailable", null,
        { ...baseMeta, jevResponse: null });
    }

    const modelAnswer = result.response.answers?.model;
    const confidence = modelAnswer?.type === "choice" && Number.isFinite(modelAnswer.confidence)
      && modelAnswer.confidence >= 0 && modelAnswer.confidence <= 1
      ? modelAnswer.confidence : null;

    const decision = decide(
      prompt,
      modelAnswer?.type === "choice" ? modelAnswer.choice : undefined,
      confidence ?? undefined,
      state.tier,
      eligibleCandidates,
      config.minConfidence,
    );

    const selected = eligibleCandidates.find(c => c.tier === decision.tier) ?? eligibleCandidates[0];
    const { provider: selProvider, modelId: selModelId } = splitPiModelId(selected.id);

    const effortAnswer = result.response.answers?.reasoning_effort;
    const desiredEffort = effortAnswer?.type === "choice"
      && Number.isFinite(effortAnswer.confidence)
      && effortAnswer.confidence >= config.minConfidence
      && effortAnswer.confidence <= 1
      && selected.efforts.includes(effortAnswer.choice)
      ? effortAnswer.choice : undefined;

    const effort = resolveEffort(
      desiredEffort,
      selected,
      state.effectiveEffort,
      clamp,
      { provider: selProvider, modelId: selModelId },
    );

    state = {
      tier: selected.tier,
      provider: selProvider,
      modelId: selModelId,
      effectiveEffort: effort,
      version: state.version + 1,
    };

    const jevUsage = result.response.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return buildResult(selProvider, selModelId, effort, selected.tier, true, decisionLabel(decision.reason), confidence,
      { ...baseMeta, requestedEffort: desiredEffort, jevUsage, jevMs: result.ms });
  }

  function buildResult(
    provider: string,
    modelId: string,
    thinkingLevel: PiThinkingLevel,
    tier: Tier,
    fromClassifier: boolean,
    decision?: string,
    confidence?: number | null,
    meta?: { reason?: string; prompt?: string; requestedEffort?: string; capacityStatus?: string; capacityReason?: string; jevUsage?: { input_tokens?: number; output_tokens?: number }; jevMs?: number; jevResponse?: unknown; previousTier?: string; previousModel?: string; previousEffort?: string | null; cache?: Record<string, unknown> },
  ): AdapterResult {
    const result: AdapterResult = {
      provider,
      modelId,
      thinkingLevel,
      tier,
      fromClassifier,
      state: state ?? { tier, provider, modelId, effectiveEffort: thinkingLevel, version: 0 },
    };
    if (decision !== undefined) result.decision = decision;
    if (confidence !== undefined) result.confidence = confidence;
    onResult?.(result);

    if (history && meta?.reason === "user") {
      const decisionId = `pi-${sessionId ?? "unknown"}-${++decisionCounter}`;
      const record: Record<string, unknown> = {
        id: decisionId,
        at: new Date().toISOString(),
        agent: "pi",
        ...(sessionId ? { session: sessionId } : {}),
        ...(branchId ? { branch: branchId } : {}),
        prompt: meta.prompt,
        provider_model: `${provider}/${modelId}`,
        decision: {
          tier,
          reason: decision ?? "unknown",
          model: `${provider}/${modelId}`,
          effort: thinkingLevel,
        },
        ...(meta.requestedEffort !== undefined ? { requested_effort: meta.requestedEffort } : {}),
        effective_effort: thinkingLevel,
        ...(meta.previousTier || meta.previousModel ? {
          previous: {
            tier: meta.previousTier,
            model: meta.previousModel,
            effort: meta.previousEffort,
          },
        } : {}),
        ...(meta.jevUsage ? { jev: { response: { usage: meta.jevUsage }, ms: meta.jevMs } } : meta.jevResponse === null ? { jev: { response: null, error: decision } } : {}),
        ...(meta.capacityStatus ? { capacity_status: meta.capacityStatus } : {}),
        ...(meta.capacityReason ? { capacity_reason: meta.capacityReason } : {}),
        ...(meta.cache ? { cache: meta.cache } : {}),
      };
      history.append(record);
    }

    if (onNotify && meta?.reason === "user" && decision !== undefined) {
      const feedbackValues: FeedbackValues = {
        tier,
        model: `${provider}/${modelId}`,
        effort: thinkingLevel,
        decision: decision ?? "unknown",
        confidence: confidence ?? null,
        previous_model: meta.previousModel ?? "none",
        cache_read: null,
        cache_write: null,
        jev_tokens_input: meta.jevUsage?.input_tokens,
        jev_tokens_output: meta.jevUsage?.output_tokens,
      };
      onNotify(formatFeedback(feedbackFormat, feedbackValues));
    }

    return result;
  }

  function recordObservation(obs: {
    decisionId?: string;
    turn?: string;
    providerModel?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    if (!history) return;
    const record = {
      type: "response-observation" as const,
      at: new Date().toISOString(),
      agent: "pi",
      ...(sessionId ? { session: sessionId } : {}),
      ...(branchId ? { branch: branchId } : {}),
      ...(obs.decisionId ? { decision_id: obs.decisionId } : {}),
      ...(obs.turn ? { turn: obs.turn } : {}),
      ...(obs.providerModel ? { provider_model: obs.providerModel } : {}),
      ...(obs.inputTokens !== undefined ? { input_tokens: obs.inputTokens } : {}),
      ...(obs.outputTokens !== undefined ? { output_tokens: obs.outputTokens } : {}),
      ...(obs.cacheReadTokens !== undefined ? { cache_read_tokens: obs.cacheReadTokens } : {}),
      ...(obs.cacheWriteTokens !== undefined ? { cache_write_tokens: obs.cacheWriteTokens } : {}),
    };
    history.append(record);
  }

  return { resolveModel, recordObservation, get state() { return state; } };
}

const MIN_PI_MAJOR = 1;
const MIN_PI_MINOR = 0;
const MIN_PI_PATCH = 2;

export function activate(pi: {
  registerVirtualModel: (opts: { provider: string; id: string; name: string }) => { onResolve: (fn: (req: PiRequest) => Promise<AdapterResult>) => void };
  version?: string;
  modelRegistry: PiModelRegistry;
}, clamp: PiClamp, options?: { config?: Config; route?: Route; onResult?: (result: AdapterResult) => void }) {
  if (pi.version) {
    const parts = pi.version.split(".").map(Number);
    const [major, minor, patch] = parts;
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch ?? 0)
      || major < MIN_PI_MAJOR
      || (major === MIN_PI_MAJOR && minor < MIN_PI_MINOR)
      || (major === MIN_PI_MAJOR && minor === MIN_PI_MINOR && (patch ?? 0) < MIN_PI_PATCH)) {
      throw new Error(
        `Pi ${pi.version} does not support virtual models. Upgrade to @earendil-works/pi-coding-agent >=1.0.2.`,
      );
    }
  }

  const adapter = createPiAdapter({
    config: options?.config,
    route: options?.route,
    registry: pi.modelRegistry,
    clamp,
    onResult: options?.onResult,
  });

  let registration: { onResolve: (fn: (req: PiRequest) => Promise<AdapterResult>) => void };
  try {
    registration = pi.registerVirtualModel({ provider: "jev", id: "auto", name: "Auto (Jev)" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already registered") || message.includes("conflict")) {
      throw new Error(`Virtual model jev/auto is already registered. Another extension may have claimed it. ${message}`);
    }
    throw error;
  }

  registration.onResolve(request => adapter.resolveModel(request));
  return adapter;
}
