import { configFromEnv, type Config } from "./config";
import { createRouter, buildRequest, type CallerOptions, type Route, type RoutingResult } from "./router";
import { decide, decisionLabel, checkEligibility } from "./policy";
import { TIERS, type Candidate, type Tier, type ContextEvidence } from "./types";

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

type CreateAdapterOptions = {
  config?: Config;
  route?: Route;
  registry: PiModelRegistry;
  clamp: PiClamp;
  onResult?: (result: AdapterResult) => void;
};

export function createPiAdapter(options: CreateAdapterOptions) {
  const config = options.config ?? configFromEnv();
  const route = options.route ?? createRouter();
  const { registry, clamp, onResult } = options;

  let state: AdapterState | undefined;
  let pending: Promise<AdapterResult> | undefined;

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

  async function resolveModel(request: PiRequest): Promise<AdapterResult> {
    if (request.reason === "continuation") {
      return handleContinuation(request);
    }
    if (request.reason === "retry") {
      return handleRetry(request);
    }
    if (request.reason === "direct") {
      return handleDirect(request);
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
    if (!prompt) {
      return buildResult(state.provider, state.modelId, state.effectiveEffort, state.tier, false);
    }

    const contextEvidence = estimateContextTokens(request);
    const contextTokens = Number.isFinite(request.contextTokens) && request.contextTokens! >= 0
      ? request.contextTokens! : contextEvidence.tokens;

    const eligibility = checkEligibility(candidates, contextTokens, 16_000);
    const eligibleCandidates = [...eligibility.eligible, ...eligibility.unknown];
    if (eligibleCandidates.length === 0) {
      return buildResult(state.provider, state.modelId, state.effectiveEffort, state.tier, false, "capacity/no-eligible", null);
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
      return buildResult(state.provider, state.modelId, state.effectiveEffort, state.tier, false, "JEV/unavailable", null);
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

    return buildResult(selProvider, selModelId, effort, selected.tier, true, decisionLabel(decision.reason), confidence);
  }

  function buildResult(
    provider: string,
    modelId: string,
    thinkingLevel: PiThinkingLevel,
    tier: Tier,
    fromClassifier: boolean,
    decision?: string,
    confidence?: number | null,
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
    return result;
  }

  return { resolveModel, get state() { return state; } };
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
