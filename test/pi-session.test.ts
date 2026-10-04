import { describe, expect, test } from "bun:test";
import { configFromEnv, type Config } from "../src/config";
import {
  createPiAdapter,
  piCandidatesFor,
  validateSavedState,
  reconcileState,
  type PiModelRegistry,
  type PiClamp,
  type PiModelInfo,
  type PiRequest,
  type PiThinkingLevel,
  type AdapterResult,
  type AdapterState,
} from "../src/pi-extension";
import type { RoutingResult } from "../src/router";

const DEFAULT_MODELS: PiModelInfo[] = [
  { provider: "openai-codex", modelId: "gpt-6-luna", displayName: "Luna", contextWindow: 200_000, thinkingLevels: ["off", "low", "medium"], authenticated: true },
  { provider: "openai-codex", modelId: "gpt-6.1-sol", displayName: "Sol", contextWindow: 1_000_000, thinkingLevels: ["off", "low", "medium", "high", "xhigh"], authenticated: true },
];

const DEFAULT_LEVELS: Record<string, PiThinkingLevel[]> = {
  "openai-codex/gpt-6-luna": ["off", "low", "medium"],
  "openai-codex/gpt-6.1-sol": ["off", "low", "medium", "high", "xhigh"],
};

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

function makeAdapter(opts?: { tier?: string; effort?: string; confidence?: number; config?: Config; registry?: PiModelRegistry; clamp?: PiClamp; route?: (input: unknown) => Promise<RoutingResult>; onResult?: (r: AdapterResult) => void }) {
  const registry = opts?.registry ?? fakeRegistry(DEFAULT_MODELS);
  const clamp = opts?.clamp ?? fakeClamp(DEFAULT_LEVELS);
  const route = opts?.route ?? fakeRoute(opts?.tier ?? "fast", opts?.effort ?? "medium", opts?.confidence ?? 0.85);
  return createPiAdapter({
    config: opts?.config ?? defaultConfig(),
    route,
    registry,
    clamp,
    onResult: opts?.onResult,
  });
}

function savedState(overrides?: Partial<AdapterState>): AdapterState {
  return {
    tier: "strong",
    provider: "openai-codex",
    modelId: "gpt-6.1-sol",
    effectiveEffort: "high",
    version: 1,
    ...overrides,
  };
}

describe("validateSavedState", () => {
  const registry = fakeRegistry(DEFAULT_MODELS);

  test("accepts valid version-1 state", () => {
    const result = validateSavedState(savedState(), registry);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("strong");
    expect(result!.provider).toBe("openai-codex");
    expect(result!.modelId).toBe("gpt-6.1-sol");
    expect(result!.effectiveEffort).toBe("high");
    expect(result!.version).toBe(1);
  });

  test("rejects null", () => {
    expect(validateSavedState(null, registry)).toBeNull();
  });

  test("rejects undefined", () => {
    expect(validateSavedState(undefined, registry)).toBeNull();
  });

  test("rejects non-object", () => {
    expect(validateSavedState("string", registry)).toBeNull();
    expect(validateSavedState(42, registry)).toBeNull();
  });

  test("rejects version 0", () => {
    expect(validateSavedState(savedState({ version: 0 }), registry)).toBeNull();
  });

  test("rejects version 2 (future)", () => {
    expect(validateSavedState(savedState({ version: 2 }), registry)).toBeNull();
  });

  test("rejects invalid tier", () => {
    expect(validateSavedState({ ...savedState(), tier: "turbo" }, registry)).toBeNull();
  });

  test("rejects invalid effectiveEffort", () => {
    expect(validateSavedState({ ...savedState(), effectiveEffort: "ultra" }, registry)).toBeNull();
  });

  test("rejects missing provider", () => {
    expect(validateSavedState({ ...savedState(), provider: undefined }, registry)).toBeNull();
  });

  test("rejects missing modelId", () => {
    expect(validateSavedState({ ...savedState(), modelId: undefined }, registry)).toBeNull();
  });

  test("rejects model not in registry", () => {
    expect(validateSavedState(savedState({ provider: "unknown", modelId: "nonexistent" }), registry)).toBeNull();
  });

  test("rejects unauthenticated model", () => {
    const unauthRegistry = fakeRegistry([
      { ...DEFAULT_MODELS[1], authenticated: false },
    ]);
    expect(validateSavedState(savedState(), unauthRegistry)).toBeNull();
  });
});

describe("reconcileState", () => {
  const config = defaultConfig();
  const registry = fakeRegistry(DEFAULT_MODELS);
  const clamp = fakeClamp(DEFAULT_LEVELS);

  test("returns saved state when no previous", () => {
    const saved = savedState();
    const result = reconcileState(saved, undefined, config, registry, clamp);
    expect(result).toEqual(saved);
  });

  test("retains saved tier when previous matches saved model", () => {
    const saved = savedState({ tier: "strong", effectiveEffort: "high" });
    const result = reconcileState(
      saved,
      { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "medium" },
      config, registry, clamp,
    );
    expect(result.tier).toBe("strong");
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6.1-sol");
    expect(result.effectiveEffort).toBe("medium");
  });

  test("keeps saved effort when previous has no thinkingLevel", () => {
    const saved = savedState({ effectiveEffort: "high" });
    const result = reconcileState(
      saved,
      { provider: "openai-codex", modelId: "gpt-6.1-sol" },
      config, registry, clamp,
    );
    expect(result.effectiveEffort).toBe("high");
  });

  test("uses previous physical pair when it differs from saved (failed switch)", () => {
    const saved = savedState({ tier: "strong", provider: "openai-codex", modelId: "gpt-6.1-sol" });
    const result = reconcileState(
      saved,
      { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "medium" },
      config, registry, clamp,
    );
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6-luna");
    expect(result.tier).toBe("fast");
    expect(result.effectiveEffort).toBe("medium");
  });

  test("retains saved state when previous model is not in registry", () => {
    const saved = savedState();
    const result = reconcileState(
      saved,
      { provider: "unknown", modelId: "nonexistent" },
      config, registry, clamp,
    );
    expect(result).toEqual(saved);
  });

  test("retains saved state when previous model is unauthenticated", () => {
    const unauthRegistry = fakeRegistry([
      DEFAULT_MODELS[0],
      { ...DEFAULT_MODELS[1], authenticated: true },
      { provider: "other", modelId: "unauth-model", authenticated: false },
    ]);
    const saved = savedState();
    const result = reconcileState(
      saved,
      { provider: "other", modelId: "unauth-model" },
      config, unauthRegistry, clamp,
    );
    expect(result).toEqual(saved);
  });

  test("balanced/strong same model preserves tier identity", () => {
    const saved = savedState({ tier: "balanced", provider: "openai-codex", modelId: "gpt-6.1-sol", effectiveEffort: "medium" });
    const result = reconcileState(
      saved,
      { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "low" },
      config, registry, clamp,
    );
    expect(result.tier).toBe("balanced");
    expect(result.effectiveEffort).toBe("low");
  });
});

describe("session fresh start", () => {
  test("fresh session defaults to configured Fast baseline", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "medium", confidence: 0.9 });
    const result = await adapter.resolveModel({ reason: "user", text: "hello" });
    expect(result.tier).toBe("fast");
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6-luna");
    expect(result.state.version).toBe(2);
  });

  test("fresh session with no saved state and no previous uses startup tier", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "medium", confidence: 0.9 });
    const result = await adapter.resolveModel({ reason: "user", text: "test" });
    expect(result.state.tier).toBe("fast");
  });
});

describe("session resume with saved state", () => {
  test("valid resumed state restores actual prior model/effort and tier", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "medium", confidence: 0.9 });
    const result = await adapter.resolveModel({
      reason: "user",
      text: "continue working",
      state: savedState({ tier: "strong", effectiveEffort: "high" }),
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
    });
    expect(result.state.version).toBeGreaterThan(1);
  });

  test("continuation with saved state uses restored state", async () => {
    const adapter = makeAdapter();
    const result = await adapter.resolveModel({
      reason: "continuation",
      state: savedState({ tier: "strong", effectiveEffort: "high" }),
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
    });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6.1-sol");
    expect(result.thinkingLevel).toBe("high");
    expect(result.tier).toBe("strong");
  });

  test("continuation with saved state and no previous falls back to saved", async () => {
    const adapter = makeAdapter();
    const result = await adapter.resolveModel({
      reason: "continuation",
      state: savedState({ tier: "strong", effectiveEffort: "high" }),
    });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6.1-sol");
    expect(result.thinkingLevel).toBe("high");
    expect(result.tier).toBe("strong");
  });

  test("retry with saved state uses restored state as fallback", async () => {
    const adapter = makeAdapter();
    const result = await adapter.resolveModel({
      reason: "retry",
      state: savedState({ tier: "strong", effectiveEffort: "high" }),
      failed: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "medium" },
    });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6.1-sol");
    expect(result.thinkingLevel).toBe("medium");
  });
});

describe("failed first request", () => {
  test("saved selection retained as fallback when no successful response exists", async () => {
    const adapter = makeAdapter();
    const result = await adapter.resolveModel({
      reason: "continuation",
      state: savedState({ tier: "fast", provider: "openai-codex", modelId: "gpt-6-luna", effectiveEffort: "medium" }),
    });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6-luna");
    expect(result.tier).toBe("fast");
    expect(result.thinkingLevel).toBe("medium");
  });
});

describe("failed switch Luna→Sol", () => {
  test("last successful Luna is used when saved Sol switch failed", async () => {
    const adapter = makeAdapter();
    const result = await adapter.resolveModel({
      reason: "user",
      text: "continue after failed switch",
      state: savedState({ tier: "strong", provider: "openai-codex", modelId: "gpt-6.1-sol", effectiveEffort: "high" }),
      previous: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "medium" },
    });
    expect(adapter.state!.provider).toBe("openai-codex");
  });
});

describe("same-model tier change (balanced→strong)", () => {
  test("successful same-model tier change preserves distinct tier identities", async () => {
    const adapter = makeAdapter({ tier: "strong", effort: "high", confidence: 0.9 });
    const result = await adapter.resolveModel({
      reason: "user",
      text: "complex task",
      state: savedState({ tier: "balanced", provider: "openai-codex", modelId: "gpt-6.1-sol", effectiveEffort: "medium" }),
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "medium" },
    });
    expect(result.tier).toBe("strong");
    expect(result.modelId).toBe("gpt-6.1-sol");
  });
});

describe("unknown state version", () => {
  test("unknown version triggers startup fallback", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "medium", confidence: 0.9 });
    const result = await adapter.resolveModel({
      reason: "user",
      text: "test",
      state: { tier: "strong", provider: "openai-codex", modelId: "gpt-6.1-sol", effectiveEffort: "high", version: 99 } as AdapterState,
    });
    expect(result.state.tier).toBe("fast");
    expect(result.state.version).toBe(2);
  });
});

describe("removed model/auth", () => {
  test("removed model falls back to startup with no crash", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "medium", confidence: 0.9 });
    const result = await adapter.resolveModel({
      reason: "user",
      text: "test after model removal",
      state: { tier: "strong", provider: "removed-provider", modelId: "removed-model", effectiveEffort: "high", version: 1 } as AdapterState,
    });
    expect(result.state.tier).toBe("fast");
  });

  test("unauthenticated model in saved state falls back to startup", async () => {
    const unauthModels: PiModelInfo[] = [
      DEFAULT_MODELS[0],
      { ...DEFAULT_MODELS[1], authenticated: false },
    ];
    const adapter = makeAdapter({
      registry: fakeRegistry(unauthModels),
      clamp: fakeClamp(DEFAULT_LEVELS),
      tier: "fast", effort: "medium", confidence: 0.9,
    });
    const result = await adapter.resolveModel({
      reason: "user",
      text: "test",
      state: savedState({ tier: "strong" }),
    });
    expect(result.state.tier).toBe("fast");
  });
});

describe("fork/tree navigation isolation", () => {
  test("separate restore calls produce independent state", async () => {
    const adapter = makeAdapter();

    const r1 = await adapter.resolveModel({
      reason: "continuation",
      state: savedState({ tier: "strong", effectiveEffort: "high" }),
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
    });
    expect(r1.tier).toBe("strong");

    const r2 = await adapter.resolveModel({
      reason: "continuation",
      state: savedState({ tier: "fast", provider: "openai-codex", modelId: "gpt-6-luna", effectiveEffort: "low" }),
      previous: { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low" },
    });
    expect(r2.tier).toBe("fast");
    expect(r2.modelId).toBe("gpt-6-luna");
  });
});

describe("direct calls ignore state", () => {
  test("direct reason does not restore saved state", async () => {
    const adapter = makeAdapter();
    const result = await adapter.resolveModel({
      reason: "direct",
      state: savedState({ tier: "strong", effectiveEffort: "high" }),
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
    });
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6.1-sol");
    expect(result.fromClassifier).toBe(false);
    expect(adapter.state).toBeUndefined();
  });
});

describe("cancellation with saved state", () => {
  test("cancelled request does not mutate restored state", async () => {
    const route = async () => ({
      request: {} as any,
      response: null,
      error: "Routing cancelled by caller",
      aborted: true,
      ms: 0,
    } as RoutingResult);

    const adapter = makeAdapter({ route });
    await adapter.resolveModel({
      reason: "user",
      text: "establish",
      state: savedState({ tier: "strong", effectiveEffort: "high" }),
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
    });
    const vBefore = adapter.state?.version;
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.resolveModel({
      reason: "user",
      text: "cancelled request",
      signal: controller.signal,
    });
    expect(result.fromClassifier).toBe(false);
    expect(adapter.state?.version).toBe(vBefore);
  });
});

describe("reload clears state", () => {
  test("no saved state on reload defaults to startup", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "medium", confidence: 0.9 });
    const result = await adapter.resolveModel({ reason: "user", text: "fresh after reload" });
    expect(result.state.tier).toBe("fast");
    expect(result.provider).toBe("openai-codex");
    expect(result.modelId).toBe("gpt-6-luna");
  });
});

describe("state in AdapterResult", () => {
  test("result always includes serializable state", async () => {
    const adapter = makeAdapter({ tier: "fast", effort: "medium", confidence: 0.9 });
    const result = await adapter.resolveModel({ reason: "user", text: "test" });
    expect(result.state).toBeDefined();
    expect(result.state.version).toBeGreaterThanOrEqual(1);
    expect(typeof result.state.tier).toBe("string");
    expect(typeof result.state.provider).toBe("string");
    expect(typeof result.state.modelId).toBe("string");
    expect(typeof result.state.effectiveEffort).toBe("string");
  });

  test("state from continuation is serializable", async () => {
    const adapter = makeAdapter();
    const result = await adapter.resolveModel({
      reason: "continuation",
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
    });
    const parsed = JSON.parse(JSON.stringify(result.state));
    expect(parsed.version).toBeGreaterThanOrEqual(0);
    expect(parsed.tier).toBeDefined();
  });
});

describe("compaction preserves state", () => {
  test("state is preserved through Pi compaction (same as restore)", async () => {
    const adapter = makeAdapter();
    const r1 = await adapter.resolveModel({
      reason: "continuation",
      state: savedState({ tier: "strong", effectiveEffort: "xhigh" }),
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "xhigh" },
    });
    expect(r1.tier).toBe("strong");
    expect(r1.thinkingLevel).toBe("xhigh");

    const r2 = await adapter.resolveModel({
      reason: "continuation",
      state: savedState({ tier: "strong", effectiveEffort: "xhigh" }),
      previous: { provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "xhigh" },
    });
    expect(r2.tier).toBe("strong");
    expect(r2.thinkingLevel).toBe("xhigh");
  });
});
