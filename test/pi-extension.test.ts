import { describe, expect, test } from "bun:test";
import { configFromEnv, type Config } from "../src/config";
import {
  createPiAdapter,
  piCandidatesFor,
  resolveEffort,
  estimateContextTokens,
  activate,
  type PiModelRegistry,
  type PiClamp,
  type PiModelInfo,
  type PiRequest,
  type PiThinkingLevel,
  type AdapterResult,
} from "../src/pi-extension";
import type { RoutingResult } from "../src/router";
import type { Candidate } from "../src/types";

function fakeRegistry(models: PiModelInfo[]): PiModelRegistry {
  const map = new Map(models.map(m => [`${m.provider}/${m.modelId}`, m]));
  return {
    find(provider, modelId) { return map.get(`${provider}/${modelId}`); },
    list() { return models; },
  };
}

function fakeClamp(levels?: Record<string, PiThinkingLevel[]>): PiClamp {
  const defaultLevels: PiThinkingLevel[] = ["off", "low", "medium", "high"];
  return {
    getSupportedThinkingLevels(model) {
      return levels?.[`${model.provider}/${model.modelId}`] ?? defaultLevels;
    },
    clampThinkingLevel(model, level) {
      const supported = this.getSupportedThinkingLevels(model);
      if (supported.includes(level)) return level;
      const ordered: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const idx = ordered.indexOf(level);
      for (let i = idx + 1; i < ordered.length; i++) {
        if (supported.includes(ordered[i])) return ordered[i];
      }
      for (let i = idx - 1; i >= 0; i--) {
        if (supported.includes(ordered[i])) return ordered[i];
      }
      return supported[0] ?? "off";
    },
  };
}

const DEFAULT_MODELS: PiModelInfo[] = [
  { provider: "openai-codex", modelId: "gpt-6-luna", displayName: "Luna", contextWindow: 200_000, thinkingLevels: ["off", "low", "medium"], authenticated: true },
  { provider: "openai-codex", modelId: "gpt-6.1-sol", displayName: "Sol", contextWindow: 1_000_000, thinkingLevels: ["off", "low", "medium", "high", "xhigh"], authenticated: true },
];

const DEFAULT_LEVELS: Record<string, PiThinkingLevel[]> = {
  "openai-codex/gpt-6-luna": ["off", "low", "medium"],
  "openai-codex/gpt-6.1-sol": ["off", "low", "medium", "high", "xhigh"],
};

function defaultConfig(): Config {
  return configFromEnv({});
}

function fakeRoute(tier: string = "fast", effort: string = "medium", confidence: number = 0.85): (input: unknown) => Promise<RoutingResult> {
  return async () => ({
    request: {} as any,
    response: {
      answers: {
        model: { type: "choice", choice: tier, confidence, probabilities: {} },
        reasoning_effort: { type: "choice", choice: effort, confidence, probabilities: {} },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    } as any,
    ms: 5,
  });
}

function countingRoute(tier: string = "fast", effort: string = "medium", confidence: number = 0.85) {
  let count = 0;
  const route = async () => {
    count++;
    return {
      request: {} as any,
      response: {
        answers: {
          model: { type: "choice", choice: tier, confidence, probabilities: {} },
          reasoning_effort: { type: "choice", choice: effort, confidence, probabilities: {} },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      } as any,
      ms: 5,
    };
  };
  return { route, getCount: () => count };
}

function makeAdapter(opts?: { tier?: string; effort?: string; confidence?: number; config?: Config; registry?: PiModelRegistry; clamp?: PiClamp; route?: (input: unknown) => Promise<RoutingResult> }) {
  const registry = opts?.registry ?? fakeRegistry(DEFAULT_MODELS);
  const clamp = opts?.clamp ?? fakeClamp(DEFAULT_LEVELS);
  const route = opts?.route ?? fakeRoute(opts?.tier ?? "fast", opts?.effort ?? "medium", opts?.confidence ?? 0.85);
  return createPiAdapter({
    config: opts?.config ?? defaultConfig(),
    route,
    registry,
    clamp,
  });
}

describe("piCandidatesFor", () => {
  test("builds candidates from default config and registry", () => {
    const registry = fakeRegistry(DEFAULT_MODELS);
    const { candidates, errors } = piCandidatesFor(defaultConfig(), registry);
    expect(errors).toHaveLength(0);
    expect(candidates).toHaveLength(3);
    expect(candidates.map(c => c.tier)).toEqual(["fast", "balanced", "strong"]);
    expect(candidates[0].id).toBe("openai-codex/gpt-6-luna");
    expect(candidates[1].id).toBe("openai-codex/gpt-6.1-sol");
    expect(candidates[2].id).toBe("openai-codex/gpt-6.1-sol");
  });

  test("reports missing model as error", () => {
    const registry = fakeRegistry([DEFAULT_MODELS[0]]);
    const { candidates, errors } = piCandidatesFor(defaultConfig(), registry);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].tier).toBe("fast");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("not found in Pi registry");
  });

  test("reports unauthenticated model as error", () => {
    const registry = fakeRegistry([
      { ...DEFAULT_MODELS[0], authenticated: false },
      DEFAULT_MODELS[1],
    ]);
    const { candidates, errors } = piCandidatesFor(defaultConfig(), registry);
    expect(candidates.map(c => c.tier)).toEqual(["balanced", "strong"]);
    expect(errors[0]).toContain("not authenticated");
  });

  test("shared-model tiers are distinct candidates", () => {
    const registry = fakeRegistry(DEFAULT_MODELS);
    const { candidates } = piCandidatesFor(defaultConfig(), registry);
    expect(candidates[1].tier).toBe("balanced");
    expect(candidates[2].tier).toBe("strong");
    expect(candidates[1].id).toBe(candidates[2].id);
    expect(candidates[1].tier).not.toBe(candidates[2].tier);
  });

  test("includes capacity when contextWindow is available", () => {
    const registry = fakeRegistry(DEFAULT_MODELS);
    const { candidates } = piCandidatesFor(defaultConfig(), registry);
    expect(candidates[0].capacity).toEqual({ contextWindow: 200_000 });
    expect(candidates[1].capacity).toEqual({ contextWindow: 1_000_000 });
  });

  test("long tier excluded when not enabled", () => {
    const registry = fakeRegistry([
      ...DEFAULT_MODELS,
      { provider: "openai-codex", modelId: "gpt-6-astra", displayName: "Astra", contextWindow: 2_000_000, thinkingLevels: ["off", "low", "medium", "high"], authenticated: true },
    ]);
    const { candidates } = piCandidatesFor(defaultConfig(), registry);
    expect(candidates.map(c => c.tier)).not.toContain("long");
  });

  test("long tier included when enabled", () => {
    const registry = fakeRegistry([
      ...DEFAULT_MODELS,
      { provider: "openai-codex", modelId: "gpt-6-astra", displayName: "Astra", contextWindow: 2_000_000, thinkingLevels: ["off", "low", "medium", "high"], authenticated: true },
    ]);
    const config = configFromEnv({ CODING_ROUTER_LONG_MODEL_ENABLE: "true" });
    const { candidates } = piCandidatesFor(config, registry);
    expect(candidates.map(c => c.tier)).toContain("long");
  });
});

describe("resolveEffort", () => {
  const clamp = fakeClamp(DEFAULT_LEVELS);
  const lunaConfig = { provider: "openai-codex", modelId: "gpt-6-luna" };
  const solConfig = { provider: "openai-codex", modelId: "gpt-6.1-sol" };
  const lunaCandidate: Candidate = { tier: "fast", id: "openai-codex/gpt-6-luna", description: "Luna", efforts: ["off", "low", "medium"], defaultEffort: "medium" };
  const solCandidate: Candidate = { tier: "strong", id: "openai-codex/gpt-6.1-sol", description: "Sol", efforts: ["off", "low", "medium", "high", "xhigh"], defaultEffort: "medium" };

  test("uses JEV effort when supported", () => {
    expect(resolveEffort("low", lunaCandidate, undefined, clamp, lunaConfig)).toBe("low");
    expect(resolveEffort("high", solCandidate, undefined, clamp, solConfig)).toBe("high");
  });

  test("falls back to prior level when JEV effort unsupported", () => {
    expect(resolveEffort("high", lunaCandidate, "low", clamp, lunaConfig)).toBe("low");
  });

  test("uses default when no prior and no valid JEV effort", () => {
    expect(resolveEffort("xhigh", lunaCandidate, undefined, clamp, lunaConfig)).toBe("medium");
  });

  test("keep preserves prior level", () => {
    expect(resolveEffort("keep", lunaCandidate, "low", clamp, lunaConfig)).toBe("low");
  });

  test("non-reasoning model returns off", () => {
    const offClamp = fakeClamp({ "openai-codex/gpt-6-luna": ["off"] });
    expect(resolveEffort("medium", lunaCandidate, "medium", offClamp, lunaConfig)).toBe("off");
  });

  test("clamps upward when level below minimum", () => {
    const limitedClamp = fakeClamp({ "openai-codex/gpt-6.1-sol": ["medium", "high", "xhigh"] });
    expect(resolveEffort("low", solCandidate, undefined, limitedClamp, solConfig)).toBe("medium");
  });

  test("clamps downward when level above maximum", () => {
    const limitedClamp = fakeClamp({ "openai-codex/gpt-6-luna": ["off", "low"] });
    const limitedCandidate: Candidate = { tier: "fast", id: "openai-codex/gpt-6-luna", description: "Luna", efforts: ["off", "low"], defaultEffort: "low" };
    expect(resolveEffort("medium", limitedCandidate, undefined, limitedClamp, lunaConfig)).toBe("low");
  });
});

describe("estimateContextTokens", () => {
  test("estimates tokens from text length", () => {
    const evidence = estimateContextTokens({ reason: "user", text: "a".repeat(400) });
    expect(evidence.tokens).toBe(100);
    expect(evidence.source).toBe("estimated");
    expect(evidence.accuracy).toContain("heuristic");
  });

  test("empty text produces minimum 1 token", () => {
    expect(estimateContextTokens({ reason: "user" }).tokens).toBe(1);
  });
});

describe("createPiAdapter — user reason", () => {
  test("first user intent routes through JEV and returns physical pair", async () => {
    const { route, getCount } = countingRoute("fast", "medium", 0.85);
    const adapter = makeAdapter({ route });
    const result = await adapter.resolveModel({ reason: "user", text: "fix the bug" });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6-luna");
    expect(result.thinkingLevel).toBe("medium");
    expect(result.tier).toBe("fast");
    expect(result.fromClassifier).toBe(true);
    expect(getCount()).toBe(1);
  });

  test("subsequent user intent reclassifies", async () => {
    const { route, getCount } = countingRoute("strong", "high", 0.9);
    const adapter = makeAdapter({ route });
    await adapter.resolveModel({ reason: "user", text: "first request" });
    expect(getCount()).toBe(1);
    await adapter.resolveModel({ reason: "user", text: "debug this complex issue" });
    expect(getCount()).toBe(2);
  });

  test("leading override is honored", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "medium", confidence: 0.9 });
    const result = await adapter.resolveModel({ reason: "user", text: "use strong then debug" });
    expect(result.tier).toBe("strong");
  });

  test("shared-model tiers (balanced+strong) produce distinct tiers with same model", async () => {
    const adapter = makeAdapter({ tier: "balanced", effort: "medium", confidence: 0.9 });
    const r1 = await adapter.resolveModel({ reason: "user", text: "implement feature" });
    expect(r1.tier).toBe("balanced");
    expect(r1.modelId).toBe("gpt-6.1-sol");

    const adapter2 = makeAdapter({ tier: "strong", effort: "high", confidence: 0.9 });
    const r2 = await adapter2.resolveModel({ reason: "user", text: "complex debugging" });
    expect(r2.tier).toBe("strong");
    expect(r2.modelId).toBe("gpt-6.1-sol");
  });

  test("low confidence prevents downgrade", async () => {
    let callIdx = 0;
    const route = async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          request: {} as any,
          response: {
            answers: {
              model: { type: "choice", choice: "strong", confidence: 0.9, probabilities: {} },
              reasoning_effort: { type: "choice", choice: "high", confidence: 0.9, probabilities: {} },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          } as any,
          ms: 5,
        };
      }
      return {
        request: {} as any,
        response: {
          answers: {
            model: { type: "choice", choice: "fast", confidence: 0.1, probabilities: {} },
            reasoning_effort: { type: "choice", choice: "low", confidence: 0.1, probabilities: {} },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        } as any,
        ms: 5,
      };
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    const r1 = await adapter.resolveModel({ reason: "user", text: "establish strong tier" });
    expect(r1.tier).toBe("strong");
    const r2 = await adapter.resolveModel({ reason: "user", text: "try downgrade with low confidence" });
    expect(r2.tier).toBe("strong");
  });

  test("unsupported effort falls back to prior", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "xhigh", confidence: 0.9 });
    const result = await adapter.resolveModel({ reason: "user", text: "test" });
    expect(["off", "low", "medium"]).toContain(result.thinkingLevel);
  });

  test("high→low same-model transition on single adapter", async () => {
    let callIdx = 0;
    const route = async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          request: {} as any,
          response: {
            answers: {
              model: { type: "choice", choice: "strong", confidence: 0.9, probabilities: {} },
              reasoning_effort: { type: "choice", choice: "high", confidence: 0.9, probabilities: {} },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          } as any,
          ms: 5,
        };
      }
      return {
        request: {} as any,
        response: {
          answers: {
            model: { type: "choice", choice: "balanced", confidence: 0.9, probabilities: {} },
            reasoning_effort: { type: "choice", choice: "low", confidence: 0.9, probabilities: {} },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        } as any,
        ms: 5,
      };
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    const r1 = await adapter.resolveModel({ reason: "user", text: "complex task" });
    expect(r1.thinkingLevel).toBe("high");
    expect(r1.modelId).toBe("gpt-6.1-sol");
    const r2 = await adapter.resolveModel({ reason: "user", text: "simple task" });
    expect(r2.thinkingLevel).toBe("low");
    expect(r2.modelId).toBe("gpt-6.1-sol");
  });

  test("low→high same-model transition on single adapter", async () => {
    let callIdx = 0;
    const route = async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          request: {} as any,
          response: {
            answers: {
              model: { type: "choice", choice: "balanced", confidence: 0.9, probabilities: {} },
              reasoning_effort: { type: "choice", choice: "low", confidence: 0.9, probabilities: {} },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          } as any,
          ms: 5,
        };
      }
      return {
        request: {} as any,
        response: {
          answers: {
            model: { type: "choice", choice: "strong", confidence: 0.9, probabilities: {} },
            reasoning_effort: { type: "choice", choice: "high", confidence: 0.9, probabilities: {} },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        } as any,
        ms: 5,
      };
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    const r1 = await adapter.resolveModel({ reason: "user", text: "easy task" });
    expect(r1.thinkingLevel).toBe("low");
    expect(r1.modelId).toBe("gpt-6.1-sol");
    const r2 = await adapter.resolveModel({ reason: "user", text: "hard task" });
    expect(r2.thinkingLevel).toBe("high");
    expect(r2.modelId).toBe("gpt-6.1-sol");
  });

  test("non-reasoning model uses off", async () => {
    const registry = fakeRegistry([
      { provider: "openai-codex", modelId: "gpt-6-luna", displayName: "Luna", contextWindow: 200_000, thinkingLevels: ["off"], authenticated: true },
      DEFAULT_MODELS[1],
    ]);
    const clamp = fakeClamp({
      "openai-codex/gpt-6-luna": ["off"],
      "openai-codex/gpt-6.1-sol": ["off", "low", "medium", "high", "xhigh"],
    });
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route: fakeRoute("fast", "medium", 0.9),
      registry,
      clamp,
    });
    const result = await adapter.resolveModel({ reason: "user", text: "hello" });
    expect(result.thinkingLevel).toBe("off");
  });

  test("empty text returns current state without classifying", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    const result = await adapter.resolveModel({ reason: "user", text: "" });
    expect(getCount()).toBe(0);
    expect(result.fromClassifier).toBe(false);
  });

  test("null response retains current model with JEV/unavailable decision", async () => {
    let callIdx = 0;
    const route = async () => {
      callIdx++;
      if (callIdx === 1) {
        return {
          request: {} as any,
          response: {
            answers: {
              model: { type: "choice", choice: "strong", confidence: 0.9, probabilities: {} },
              reasoning_effort: { type: "choice", choice: "high", confidence: 0.9, probabilities: {} },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          } as any,
          ms: 5,
        };
      }
      return { request: {} as any, response: null, error: "service down", ms: 0 };
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    await adapter.resolveModel({ reason: "user", text: "establish" });
    const vBefore = adapter.state?.version;
    const r2 = await adapter.resolveModel({ reason: "user", text: "trigger failure" });
    expect(r2.fromClassifier).toBe(false);
    expect(r2.decision).toBe("JEV/unavailable");
    expect(adapter.state?.version).toBe(vBefore);
  });

  test("validates contextTokens — NaN falls back to estimate", async () => {
    const { route, getCount } = countingRoute("fast", "medium", 0.9);
    const adapter = makeAdapter({ route });
    const result = await adapter.resolveModel({ reason: "user", text: "test", contextTokens: NaN });
    expect(result.fromClassifier).toBe(true);
    expect(getCount()).toBe(1);
  });
});

describe("createPiAdapter — continuation reason", () => {
  test("returns previous physical pair", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    const result = await adapter.resolveModel({
      reason: "continuation",
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
    });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6.1-sol");
    expect(result.thinkingLevel).toBe("high");
    expect(result.fromClassifier).toBe(false);
    expect(getCount()).toBe(0);
  });

  test("falls back to stored selection when no previous", async () => {
    const { route, getCount } = countingRoute("strong", "high");
    const adapter = makeAdapter({ route });
    await adapter.resolveModel({ reason: "user", text: "start session" });
    const countBefore = getCount();
    const result = await adapter.resolveModel({ reason: "continuation" });
    expect(result.fromClassifier).toBe(false);
    expect(getCount()).toBe(countBefore);
    expect(result.tier).toBe("strong");
    expect(result.modelId).toBe("gpt-6.1-sol");
  });
});

describe("createPiAdapter — retry reason", () => {
  test("returns failed pair when available", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    const result = await adapter.resolveModel({
      reason: "retry",
      failed: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low" },
    });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6-luna");
    expect(result.thinkingLevel).toBe("low");
    expect(getCount()).toBe(0);
  });

  test("falls back to previous when no failed pair", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    const result = await adapter.resolveModel({
      reason: "retry",
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "medium" },
    });
    expect(result.modelId).toBe("gpt-6.1-sol");
    expect(getCount()).toBe(0);
  });

  test("falls back to stored selection when no failed or previous", async () => {
    const { route, getCount } = countingRoute("strong", "high");
    const adapter = makeAdapter({ route });
    await adapter.resolveModel({ reason: "user", text: "start" });
    const countBefore = getCount();
    const result = await adapter.resolveModel({ reason: "retry" });
    expect(result.fromClassifier).toBe(false);
    expect(getCount()).toBe(countBefore);
    expect(result.tier).toBe("strong");
    expect(result.modelId).toBe("gpt-6.1-sol");
  });
});

describe("createPiAdapter — direct reason", () => {
  test("uses provided previous pair without classifying", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    const result = await adapter.resolveModel({
      reason: "direct",
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
    });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6.1-sol");
    expect(result.fromClassifier).toBe(false);
    expect(getCount()).toBe(0);
  });

  test("uses fast pair when no previous", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    const result = await adapter.resolveModel({ reason: "direct" });
    expect(result.tier).toBe("fast");
    expect(result.modelId).toBe("gpt-6-luna");
    expect(getCount()).toBe(0);
  });
});

describe("createPiAdapter — cancellation", () => {
  test("does not commit state on abort", async () => {
    const route = async () => ({
      request: {} as any,
      response: null,
      error: "Routing cancelled by caller",
      aborted: true,
      ms: 0,
    } as RoutingResult);
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    await adapter.resolveModel({ reason: "user", text: "initial" });
    const stateBefore = adapter.state;
    const abortController = new AbortController();
    abortController.abort();
    const result = await adapter.resolveModel({
      reason: "user",
      text: "should be cancelled",
      signal: abortController.signal,
    });
    expect(result.fromClassifier).toBe(false);
    expect(adapter.state?.version).toBe(stateBefore?.version);
  });
});

describe("createPiAdapter — classifier failure", () => {
  test("retains current model/effort on classifier error", async () => {
    let callCount = 0;
    const route = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          request: {} as any,
          response: {
            answers: {
              model: { type: "choice", choice: "strong", confidence: 0.9, probabilities: {} },
              reasoning_effort: { type: "choice", choice: "high", confidence: 0.9, probabilities: {} },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          ms: 5,
        } as unknown as RoutingResult;
      }
      throw new Error("classifier timeout");
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    const r1 = await adapter.resolveModel({ reason: "user", text: "establish state" });
    expect(r1.tier).toBe("strong");
    const vBefore = adapter.state?.version;
    const r2 = await adapter.resolveModel({ reason: "user", text: "trigger timeout" });
    expect(r2.tier).toBe("strong");
    expect(r2.modelId).toBe("gpt-6.1-sol");
    expect(r2.fromClassifier).toBe(false);
    expect(adapter.state?.version).toBe(vBefore);
  });
});

describe("createPiAdapter — missing model/auth errors", () => {
  test("throws when no eligible models", async () => {
    const registry = fakeRegistry([]);
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route: fakeRoute(),
      registry,
      clamp: fakeClamp(),
    });
    await expect(adapter.resolveModel({ reason: "user", text: "test" })).rejects.toThrow("No eligible Pi models");
  });

  test("getStartupState includes actionable errors", () => {
    const registry = fakeRegistry([]);
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route: fakeRoute(),
      registry,
      clamp: fakeClamp(),
    });
    expect(() => adapter.resolveModel({ reason: "continuation" })).toThrow("not found in Pi registry");
  });
});

describe("capacity eligibility", () => {
  test("200K candidate rejected for 300K context; 1M candidate eligible", async () => {
    const adapter = makeAdapter({ tier: "strong", effort: "high", confidence: 0.9 });
    const result = await adapter.resolveModel({
      reason: "user",
      text: "large context task",
      contextTokens: 300_000,
    });
    expect(result.modelId).toBe("gpt-6.1-sol");
  });
});

describe("exact classifier call counts", () => {
  test("continuation: 0 classifier calls", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    await adapter.resolveModel({ reason: "continuation", previous: { provider: "openai-codex", modelId: "gpt-6-luna" } });
    expect(getCount()).toBe(0);
  });

  test("retry: 0 classifier calls", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    await adapter.resolveModel({ reason: "retry", failed: { provider: "openai-codex", modelId: "gpt-6-luna" } });
    expect(getCount()).toBe(0);
  });

  test("direct: 0 classifier calls", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    await adapter.resolveModel({ reason: "direct" });
    expect(getCount()).toBe(0);
  });

  test("user: exactly 1 classifier call per intent", async () => {
    const { route, getCount } = countingRoute();
    const adapter = makeAdapter({ route });
    await adapter.resolveModel({ reason: "user", text: "first" });
    expect(getCount()).toBe(1);
    await adapter.resolveModel({ reason: "user", text: "second" });
    expect(getCount()).toBe(2);
  });
});

describe("activate", () => {
  test("registers virtual model and wires resolver", async () => {
    let resolverFn: ((req: PiRequest) => Promise<AdapterResult>) | undefined;
    const mockPi = {
      version: "1.0.2",
      registerVirtualModel: (opts: { provider: string; id: string; name: string }) => {
        expect(opts.provider).toBe("jev");
        expect(opts.id).toBe("auto");
        expect(opts.name).toBe("Auto (Jev)");
        return {
          onResolve(fn: (req: PiRequest) => Promise<AdapterResult>) { resolverFn = fn; },
        };
      },
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    const adapter = activate(mockPi, fakeClamp(DEFAULT_LEVELS), { route: fakeRoute() });
    expect(resolverFn).toBeDefined();
    const result = await resolverFn!({ reason: "user", text: "test" });
    expect(result.provider).toBe("openai-codex");
    expect(result.fromClassifier).toBe(true);
  });

  test("rejects Pi 0.5.0 as unsupported", () => {
    const mockPi = {
      version: "0.5.0",
      registerVirtualModel: () => ({ onResolve: () => {} }),
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    expect(() => activate(mockPi, fakeClamp(DEFAULT_LEVELS))).toThrow("does not support virtual models");
  });

  test("rejects Pi 1.0.0 as too old", () => {
    const mockPi = {
      version: "1.0.0",
      registerVirtualModel: () => ({ onResolve: () => {} }),
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    expect(() => activate(mockPi, fakeClamp(DEFAULT_LEVELS))).toThrow("does not support virtual models");
  });

  test("rejects Pi 1.0.1 as too old", () => {
    const mockPi = {
      version: "1.0.1",
      registerVirtualModel: () => ({ onResolve: () => {} }),
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    expect(() => activate(mockPi, fakeClamp(DEFAULT_LEVELS))).toThrow("does not support virtual models");
  });

  test("accepts Pi 1.0.2", () => {
    const mockPi = {
      version: "1.0.2",
      registerVirtualModel: () => ({ onResolve: () => {} }),
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    expect(() => activate(mockPi, fakeClamp(DEFAULT_LEVELS))).not.toThrow();
  });

  test("accepts Pi 1.1.0", () => {
    const mockPi = {
      version: "1.1.0",
      registerVirtualModel: () => ({ onResolve: () => {} }),
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    expect(() => activate(mockPi, fakeClamp(DEFAULT_LEVELS))).not.toThrow();
  });

  test("throws on conflicting registration", () => {
    const mockPi = {
      version: "1.0.2",
      registerVirtualModel: () => { throw new Error("already registered"); },
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    expect(() => activate(mockPi, fakeClamp(DEFAULT_LEVELS))).toThrow("already registered");
  });

  test("onResult callback is called", async () => {
    const results: AdapterResult[] = [];
    let resolverFn: ((req: PiRequest) => Promise<AdapterResult>) | undefined;
    const mockPi = {
      version: "1.0.2",
      registerVirtualModel: () => ({
        onResolve(fn: (req: PiRequest) => Promise<AdapterResult>) { resolverFn = fn; },
      }),
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    activate(mockPi, fakeClamp(DEFAULT_LEVELS), { route: fakeRoute(), onResult: r => results.push(r) });
    await resolverFn!({ reason: "user", text: "test" });
    expect(results).toHaveLength(1);
    expect(results[0].fromClassifier).toBe(true);
  });

  test("rejects malformed version string", () => {
    const mockPi = {
      version: "abc.def.ghi",
      registerVirtualModel: () => ({ onResolve: () => {} }),
      modelRegistry: fakeRegistry(DEFAULT_MODELS),
    };
    expect(() => activate(mockPi, fakeClamp(DEFAULT_LEVELS))).toThrow("does not support virtual models");
  });
});

describe("prior context capping", () => {
  test("caps user and assistant excerpts at 1000 characters", async () => {
    let capturedInput: any;
    const route = async (input: unknown) => {
      capturedInput = input;
      return {
        request: {} as any,
        response: {
          answers: {
            model: { type: "choice", choice: "fast", confidence: 0.9, probabilities: {} },
            reasoning_effort: { type: "choice", choice: "medium", confidence: 0.9, probabilities: {} },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        } as any,
        ms: 5,
      };
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    await adapter.resolveModel({
      reason: "user",
      text: "test",
      priorContext: {
        userExcerpt: "u".repeat(2000),
        assistantExcerpt: "a".repeat(2000),
      },
    });
    expect(capturedInput.recentContext.previous_user_request.length).toBe(1000);
    expect(capturedInput.recentContext.previous_assistant_excerpt.length).toBe(1000);
  });

  test("user-only prior context omits assistant excerpt", async () => {
    let capturedInput: any;
    const route = async (input: unknown) => {
      capturedInput = input;
      return {
        request: {} as any,
        response: {
          answers: {
            model: { type: "choice", choice: "fast", confidence: 0.9, probabilities: {} },
            reasoning_effort: { type: "choice", choice: "medium", confidence: 0.9, probabilities: {} },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        } as any,
        ms: 5,
      };
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    await adapter.resolveModel({
      reason: "user",
      text: "test",
      priorContext: { userExcerpt: "previous question" },
    });
    expect(capturedInput.recentContext.previous_user_request).toBe("previous question");
    expect(capturedInput.recentContext.previous_assistant_excerpt).toBeUndefined();
  });

  test("sendRecentContext=false omits prior context", async () => {
    let capturedInput: any;
    const route = async (input: unknown) => {
      capturedInput = input;
      return {
        request: {} as any,
        response: {
          answers: {
            model: { type: "choice", choice: "fast", confidence: 0.9, probabilities: {} },
            reasoning_effort: { type: "choice", choice: "medium", confidence: 0.9, probabilities: {} },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        } as any,
        ms: 5,
      };
    };
    const adapter = createPiAdapter({
      config: configFromEnv({ CODING_ROUTER_SEND_RECENT_CONTEXT: "false" }),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    await adapter.resolveModel({
      reason: "user",
      text: "test",
      priorContext: { userExcerpt: "should be ignored", assistantExcerpt: "also ignored" },
    });
    expect(capturedInput.recentContext).toBeUndefined();
  });
});

describe("capacity — all candidates rejected", () => {
  test("returns current model with capacity/no-eligible decision when all rejected", async () => {
    const smallModels: PiModelInfo[] = [
      { provider: "openai-codex", modelId: "gpt-6-luna", displayName: "Luna", contextWindow: 50_000, thinkingLevels: ["off", "low", "medium"], authenticated: true },
    ];
    const smallLevels: Record<string, PiThinkingLevel[]> = {
      "openai-codex/gpt-6-luna": ["off", "low", "medium"],
    };
    const { route, getCount } = countingRoute("fast", "medium", 0.9);
    const adapter = createPiAdapter({
      config: configFromEnv({ CODING_ROUTER_BALANCED_MODEL_PI: "openai-codex/gpt-6-luna", CODING_ROUTER_STRONG_MODEL_PI: "openai-codex/gpt-6-luna" }),
      route,
      registry: fakeRegistry(smallModels),
      clamp: fakeClamp(smallLevels),
    });
    const result = await adapter.resolveModel({
      reason: "user",
      text: "huge context",
      contextTokens: 100_000,
    });
    expect(getCount()).toBe(0);
    expect(result.fromClassifier).toBe(false);
    expect(result.decision).toBe("capacity/no-eligible");
  });
});

describe("concurrent user resolves are serialized", () => {
  test("second call waits for first to complete", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    let callCount = 0;
    const route = async () => {
      callCount++;
      if (callCount === 1) {
        order.push("first-start");
        await new Promise<void>(r => { resolveFirst = r; });
        order.push("first-end");
      } else {
        order.push("second");
      }
      return {
        request: {} as any,
        response: {
          answers: {
            model: { type: "choice", choice: "fast", confidence: 0.9, probabilities: {} },
            reasoning_effort: { type: "choice", choice: "medium", confidence: 0.9, probabilities: {} },
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        } as any,
        ms: 5,
      };
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    const p1 = adapter.resolveModel({ reason: "user", text: "first" });
    const p2 = adapter.resolveModel({ reason: "user", text: "second" });
    await Bun.sleep(10);
    resolveFirst!();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("route throw with aborted signal", () => {
  test("catch path detects aborted signal and does not commit state", async () => {
    let callCount = 0;
    const route = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          request: {} as any,
          response: {
            answers: {
              model: { type: "choice", choice: "strong", confidence: 0.9, probabilities: {} },
              reasoning_effort: { type: "choice", choice: "high", confidence: 0.9, probabilities: {} },
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          } as any,
          ms: 5,
        };
      }
      throw new Error("connection reset");
    };
    const adapter = createPiAdapter({
      config: defaultConfig(),
      route,
      registry: fakeRegistry(DEFAULT_MODELS),
      clamp: fakeClamp(DEFAULT_LEVELS),
    });
    await adapter.resolveModel({ reason: "user", text: "establish" });
    const vBefore = adapter.state?.version;
    const controller = new AbortController();
    controller.abort();
    const r = await adapter.resolveModel({ reason: "user", text: "fail with abort", signal: controller.signal });
    expect(r.fromClassifier).toBe(false);
    expect(adapter.state?.version).toBe(vBefore);
  });
});
