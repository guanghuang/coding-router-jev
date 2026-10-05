import { describe, expect, test } from "bun:test";
import {
  lookupCapabilities,
  claudeEffortsFor,
  normalizeClaudeEffort,
  resolveClaudeThinking,
  claudeCapacity,
  safeVirtualContextBound,
  CLAUDE_OVERRIDE_ALIASES,
  type ClaudeModelCapabilities,
} from "../src/claude-capabilities";
import { checkEligibility } from "../src/policy";
import { claudeCandidatesFor } from "../src/claude-proxy";
import { configFromEnv } from "../src/config";
import type { Candidate } from "../src/types";

describe("lookupCapabilities", () => {
  test("exact match for known model IDs", () => {
    const haiku = lookupCapabilities("claude-haiku-4-5-20251001");
    expect(haiku).toBeDefined();
    expect(haiku!.contextWindow).toBe(200_000);
    expect(haiku!.thinkingMode).toBe("budgeted");
    expect(haiku!.supportedEfforts).toEqual([]);

    const sonnet = lookupCapabilities("claude-sonnet-4-20250514");
    expect(sonnet).toBeDefined();
    expect(sonnet!.contextWindow).toBe(200_000);
    expect(sonnet!.thinkingMode).toBe("adaptive");
    expect(sonnet!.supportedEfforts).toContain("medium");

    const sonnet55 = lookupCapabilities("claude-sonnet-5-5");
    expect(sonnet55).toBeDefined();
    expect(sonnet55!.contextWindow).toBe(1_000_000);

    const opus = lookupCapabilities("claude-opus-5-5");
    expect(opus).toBeDefined();
    expect(opus!.contextWindow).toBe(1_000_000);
    expect(opus!.defaultEffort).toBe("high");
  });

  test("unknown version within known family returns undefined (no family inference)", () => {
    const future = lookupCapabilities("claude-sonnet-9-9-20280101");
    expect(future).toBeUndefined();
  });

  test("unknown custom model returns undefined", () => {
    expect(lookupCapabilities("my-custom-model")).toBeUndefined();
    expect(lookupCapabilities("gpt-4o")).toBeUndefined();
    expect(lookupCapabilities("")).toBeUndefined();
  });
});

describe("claudeEffortsFor", () => {
  test("adaptive model returns supported efforts", () => {
    const caps = lookupCapabilities("claude-sonnet-5-5");
    expect(claudeEffortsFor(caps)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("budgeted model returns empty efforts", () => {
    const caps = lookupCapabilities("claude-haiku-4-5-20251001");
    expect(claudeEffortsFor(caps)).toEqual([]);
  });

  test("undefined caps returns empty efforts", () => {
    expect(claudeEffortsFor(undefined)).toEqual([]);
  });
});

describe("normalizeClaudeEffort", () => {
  test("maps requested effort to highest supported at or below", () => {
    const caps = lookupCapabilities("claude-sonnet-4-20250514")!;
    expect(normalizeClaudeEffort("high", caps)).toBe("high");
    expect(normalizeClaudeEffort("medium", caps)).toBe("medium");
    expect(normalizeClaudeEffort("low", caps)).toBe("low");
    expect(normalizeClaudeEffort("xhigh", caps)).toBe("high"); // falls back
  });

  test("requested effort above max supported falls to highest available", () => {
    const caps = lookupCapabilities("claude-sonnet-4-20250514")!; // supports low/medium/high
    expect(normalizeClaudeEffort("max", caps)).toBe("high");
    expect(normalizeClaudeEffort("ultra", caps)).toBe("high");
  });

  test("keep returns default effort", () => {
    const caps = lookupCapabilities("claude-sonnet-4-20250514")!;
    expect(normalizeClaudeEffort("keep", caps)).toBe("medium");
  });

  test("undefined requested returns default effort", () => {
    const caps = lookupCapabilities("claude-opus-5-5")!;
    expect(normalizeClaudeEffort(undefined, caps)).toBe("high");
  });

  test("budgeted model returns undefined regardless of requested effort", () => {
    const caps = lookupCapabilities("claude-haiku-4-5-20251001")!;
    expect(normalizeClaudeEffort("high", caps)).toBeUndefined();
  });

  test("unknown model returns undefined", () => {
    expect(normalizeClaudeEffort("high", undefined)).toBeUndefined();
  });

  test("larger model accepts xhigh and max", () => {
    const caps = lookupCapabilities("claude-sonnet-5-5")!;
    expect(normalizeClaudeEffort("xhigh", caps)).toBe("xhigh");
    expect(normalizeClaudeEffort("max", caps)).toBe("max");
  });

  test("none/minimal below all supported fall back to default effort", () => {
    const caps = lookupCapabilities("claude-sonnet-4-20250514")!; // supports low/medium/high, default=medium
    // "none" and "minimal" rank below "low" (the lowest supported), so no match; uses default
    expect(normalizeClaudeEffort("none", caps)).toBe("medium");
    expect(normalizeClaudeEffort("minimal", caps)).toBe("medium");
  });
});

describe("resolveClaudeThinking", () => {
  test("adaptive model sets output_config.effort", () => {
    const caps = lookupCapabilities("claude-sonnet-5-5")!;
    const body: Record<string, unknown> = {};
    const effective = resolveClaudeThinking("high", caps, body);
    expect(effective).toBe("high");
    expect(body.output_config).toEqual({ effort: "high" });
  });

  test("budgeted model removes incompatible effort from output_config", () => {
    const caps = lookupCapabilities("claude-haiku-4-5-20251001")!;
    const body: Record<string, unknown> = { output_config: { effort: "high", other: "keep" } };
    const effective = resolveClaudeThinking("high", caps, body);
    expect(effective).toBeUndefined();
    expect(body.output_config).toEqual({ other: "keep" });
  });

  test("budgeted model clears output_config when only effort was present", () => {
    const caps = lookupCapabilities("claude-haiku-4-5-20251001")!;
    const body: Record<string, unknown> = { output_config: { effort: "high" } };
    resolveClaudeThinking("high", caps, body);
    expect(body.output_config).toBeUndefined();
  });

  test("unknown model returns undefined and does not modify body", () => {
    const body: Record<string, unknown> = {};
    const effective = resolveClaudeThinking("high", undefined, body);
    expect(effective).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  test("preserves existing output_config fields for adaptive model", () => {
    const caps = lookupCapabilities("claude-sonnet-5-5")!;
    const body: Record<string, unknown> = { output_config: { format: "json" } };
    resolveClaudeThinking("medium", caps, body);
    expect(body.output_config).toEqual({ format: "json", effort: "medium" });
  });
});

describe("claudeCapacity", () => {
  test("returns capacity from known model", () => {
    const caps = lookupCapabilities("claude-haiku-4-5-20251001")!;
    const capacity = claudeCapacity(caps, undefined);
    expect(capacity).toEqual({ contextWindow: 200_000, outputBudget: 8_192 });
  });

  test("user override caps at physical capacity", () => {
    const caps = lookupCapabilities("claude-haiku-4-5-20251001")!;
    const capacity = claudeCapacity(caps, 500_000);
    expect(capacity!.contextWindow).toBe(200_000); // cannot exceed physical
  });

  test("user override below physical capacity is honored", () => {
    const caps = lookupCapabilities("claude-sonnet-5-5")!;
    const capacity = claudeCapacity(caps, 500_000);
    expect(capacity!.contextWindow).toBe(500_000);
  });

  test("unknown model returns undefined", () => {
    expect(claudeCapacity(undefined, undefined)).toBeUndefined();
  });
});

describe("safeVirtualContextBound", () => {
  test("returns minimum context of enabled candidates", () => {
    const candidates: Candidate[] = [
      { tier: "fast", id: "haiku", description: "H", efforts: [], capacity: { contextWindow: 200_000 } },
      { tier: "balanced", id: "sonnet", description: "S", efforts: ["medium"], capacity: { contextWindow: 1_000_000 } },
    ];
    expect(safeVirtualContextBound(candidates)).toBe(200_000);
  });

  test("defaults to 200K when no capacity info", () => {
    const candidates: Candidate[] = [
      { tier: "fast", id: "unknown", description: "U", efforts: [] },
    ];
    expect(safeVirtualContextBound(candidates)).toBe(200_000);
  });

  test("single 1M candidate returns 1M", () => {
    const candidates: Candidate[] = [
      { tier: "balanced", id: "sonnet", description: "S", efforts: ["medium"], capacity: { contextWindow: 1_000_000 } },
    ];
    expect(safeVirtualContextBound(candidates)).toBe(1_000_000);
  });
});

describe("override aliases", () => {
  test("standard aliases map correctly", () => {
    expect(CLAUDE_OVERRIDE_ALIASES.haiku).toBe("fast");
    expect(CLAUDE_OVERRIDE_ALIASES.sonnet).toBe("balanced");
    expect(CLAUDE_OVERRIDE_ALIASES.opus).toBe("strong");
    expect(CLAUDE_OVERRIDE_ALIASES.fable).toBe("long");
    expect(CLAUDE_OVERRIDE_ALIASES.claude).toBe("balanced");
  });
});

describe("eligibility integration with Claude candidates", () => {
  test("300K input excludes 200K Haiku but permits 1M Sonnet 5.5", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
      CODING_ROUTER_BALANCED_MODEL_CLAUDE: "claude-sonnet-5-5",
      CODING_ROUTER_STRONG_MODEL_CLAUDE: "claude-opus-5-5",
    });
    const candidates = claudeCandidatesFor(config);
    const result = checkEligibility(candidates, 300_000, 16_384);
    expect(result.eligible.map(c => c.id)).toContain("claude-sonnet-5-5");
    expect(result.eligible.map(c => c.id)).toContain("claude-opus-5-5");
    expect(result.rejected.map(r => r.candidate.id)).toContain("claude-haiku-4-5-20251001");
  });

  test("small input makes all candidates eligible", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
      CODING_ROUTER_BALANCED_MODEL_CLAUDE: "claude-sonnet-5-5",
      CODING_ROUTER_STRONG_MODEL_CLAUDE: "claude-opus-5-5",
    });
    const candidates = claudeCandidatesFor(config);
    const result = checkEligibility(candidates, 10_000, 8_192);
    expect(result.eligible).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
  });

  test("output reserve pushes near-boundary input out", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
    });
    const candidates = claudeCandidatesFor(config);
    // Haiku: 200K context - 8192 output = 191808 usable
    const result = checkEligibility(candidates, 191_809, 8_192);
    expect(result.rejected.map(r => r.candidate.id)).toContain("claude-haiku-4-5-20251001");
  });

  test("no eligible candidate when all known capacities are too small", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
      CODING_ROUTER_BALANCED_MODEL_CLAUDE: "claude-sonnet-4-20250514",
      CODING_ROUTER_STRONG_MODEL_CLAUDE: "claude-sonnet-4-20250514",
    });
    const candidates = claudeCandidatesFor(config);
    const result = checkEligibility(candidates, 300_000, 16_384);
    expect(result.eligible).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
  });

  test("unknown/custom model ID has unknown capacity", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CLAUDE: "my-custom-claude-model",
    });
    const candidates = claudeCandidatesFor(config);
    const fast = candidates.find(c => c.tier === "fast");
    expect(fast?.capacity).toBeUndefined();
    const result = checkEligibility(candidates, 100_000, 16_384);
    expect(result.unknown.some(c => c.id === "my-custom-claude-model")).toBe(true);
  });
});

describe("claudeCandidatesFor with capabilities", () => {
  test("candidates have populated efforts and capacity for known models", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
      CODING_ROUTER_BALANCED_MODEL_CLAUDE: "claude-sonnet-5-5",
      CODING_ROUTER_STRONG_MODEL_CLAUDE: "claude-opus-5-5",
    });
    const candidates = claudeCandidatesFor(config);
    const haiku = candidates.find(c => c.tier === "fast")!;
    expect(haiku.efforts).toEqual([]);
    expect(haiku.capacity?.contextWindow).toBe(200_000);

    const sonnet = candidates.find(c => c.tier === "balanced")!;
    expect(sonnet.efforts).toContain("medium");
    expect(sonnet.efforts).toContain("max");
    expect(sonnet.capacity?.contextWindow).toBe(1_000_000);

    const opus = candidates.find(c => c.tier === "strong")!;
    expect(opus.efforts).toContain("high");
    expect(opus.defaultEffort).toBe("high");
  });

  test("Fable opt-in via long tier", () => {
    const config = configFromEnv({
      CODING_ROUTER_LONG_MODEL_CLAUDE: "claude-fable-5-1",
      CODING_ROUTER_LONG_MODEL_ENABLE: "true",
    });
    const candidates = claudeCandidatesFor(config);
    const fable = candidates.find(c => c.tier === "long");
    expect(fable).toBeDefined();
    expect(fable!.id).toBe("claude-fable-5-1");
    expect(fable!.capacity?.contextWindow).toBe(1_000_000);
    expect(fable!.efforts).toContain("max");
  });

  test("default config candidates have capacity from known defaults", () => {
    const config = configFromEnv({});
    const candidates = claudeCandidatesFor(config);
    for (const c of candidates) {
      expect(c.capacity?.contextWindow).toBe(c.tier === "fast" ? 200_000 : 1_000_000);
      if (c.tier === "fast") expect(c.efforts).toEqual([]);
      else expect(c.efforts).toContain("medium");
    }
  });

  test("context window override from config", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-sonnet-5-5",
      CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "500000",
    });
    const candidates = claudeCandidatesFor(config);
    const fast = candidates.find(c => c.tier === "fast")!;
    expect(fast.capacity?.contextWindow).toBe(500_000);
  });

  test("context window override cannot exceed physical capacity", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
      CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "500000",
    });
    const candidates = claudeCandidatesFor(config);
    const haiku = candidates.find(c => c.tier === "fast")!;
    expect(haiku.capacity?.contextWindow).toBe(200_000);
  });
});

describe("config: claudeContextWindow", () => {
  test("valid positive integer is accepted", () => {
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "200000" }).claudeContextWindow).toBe(200_000);
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "1000000" }).claudeContextWindow).toBe(1_000_000);
  });

  test("empty or whitespace returns undefined", () => {
    expect(configFromEnv({}).claudeContextWindow).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "" }).claudeContextWindow).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "  " }).claudeContextWindow).toBeUndefined();
  });

  test("non-positive or invalid values return undefined", () => {
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "0" }).claudeContextWindow).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "-100" }).claudeContextWindow).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "abc" }).claudeContextWindow).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "Infinity" }).claudeContextWindow).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_CONTEXT_WINDOW_CLAUDE: "1.5" }).claudeContextWindow).toBeUndefined();
  });
});
