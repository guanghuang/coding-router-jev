import type { Candidate, CapacityInfo, Tier } from "./types";

/**
 * Thinking mode a Claude model supports.
 * - "adaptive": supports output_config.effort (Sonnet 5.5, Opus 5.5, etc.)
 * - "budgeted": supports budgeted extended thinking only (Haiku 4.5)
 * - "none": no explicit thinking control
 */
export type ClaudeThinkingMode = "adaptive" | "budgeted" | "none";

export type ClaudeModelCapabilities = {
  modelId: string;
  family: string;
  contextWindow: number;
  maxOutput: number;
  thinkingMode: ClaudeThinkingMode;
  /** Effort levels accepted by this model's adaptive thinking interface. */
  supportedEfforts: string[];
  /** Default effort when the model supports adaptive thinking. */
  defaultEffort: string | undefined;
};

const KNOWN_MODELS: ClaudeModelCapabilities[] = [
  {
    modelId: "claude-haiku-4-5-20251001",
    family: "haiku",
    contextWindow: 200_000,
    maxOutput: 8_192,
    thinkingMode: "budgeted",
    supportedEfforts: [],
    defaultEffort: undefined,
  },
  {
    modelId: "claude-sonnet-4-20250514",
    family: "sonnet",
    contextWindow: 200_000,
    maxOutput: 16_384,
    thinkingMode: "adaptive",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    modelId: "claude-sonnet-4-5-20250514",
    family: "sonnet",
    contextWindow: 200_000,
    maxOutput: 16_384,
    thinkingMode: "adaptive",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    modelId: "claude-sonnet-5-5",
    family: "sonnet",
    contextWindow: 1_000_000,
    maxOutput: 16_384,
    thinkingMode: "adaptive",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  {
    modelId: "claude-opus-5-5",
    family: "opus",
    contextWindow: 1_000_000,
    maxOutput: 16_384,
    thinkingMode: "adaptive",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
  {
    modelId: "claude-fable-5-1",
    family: "fable",
    contextWindow: 1_000_000,
    maxOutput: 16_384,
    thinkingMode: "adaptive",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
];

const BY_ID = new Map(KNOWN_MODELS.map(m => [m.modelId, m]));

const FAMILY_PATTERNS: [RegExp, string][] = [
  [/^claude-haiku-/i, "haiku"],
  [/^claude-sonnet-/i, "sonnet"],
  [/^claude-opus-/i, "opus"],
  [/^claude-fable-/i, "fable"],
];

function familyOf(modelId: string): string | undefined {
  for (const [re, family] of FAMILY_PATTERNS) {
    if (re.test(modelId)) return family;
  }
  return undefined;
}

/**
 * Look up capabilities for a model ID. Returns capabilities only for
 * exactly registered model IDs. Unknown, custom, or unrecognized version
 * IDs return undefined — no family-based inference per issue #30.
 */
export function lookupCapabilities(modelId: string): ClaudeModelCapabilities | undefined {
  return BY_ID.get(modelId);
}

/**
 * Return the supported effort levels for a model based on its capabilities.
 * Budgeted-thinking and no-thinking models return an empty array.
 */
export function claudeEffortsFor(caps: ClaudeModelCapabilities | undefined): string[] {
  if (!caps || caps.thinkingMode !== "adaptive") return [];
  return [...caps.supportedEfforts];
}

/** Override aliases for textual routing overrides ("use sonnet" etc.) */
export const CLAUDE_OVERRIDE_ALIASES: Record<string, Tier> = {
  claude: "balanced",
  haiku: "fast",
  sonnet: "balanced",
  opus: "strong",
  fable: "long",
};

/**
 * Map a requested JEV effort level to one supported by the target model.
 * For adaptive models: picks the highest supported effort at or below the
 * requested level (Claude native fallback). Returns undefined when the
 * model does not support adaptive effort.
 */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const effortRank = (e: string): number => { const i = EFFORT_ORDER.indexOf(e as typeof EFFORT_ORDER[number]); return i >= 0 ? i : -1; };

export function normalizeClaudeEffort(
  requested: string | undefined,
  caps: ClaudeModelCapabilities | undefined,
): string | undefined {
  if (!caps || caps.thinkingMode !== "adaptive" || !caps.supportedEfforts.length) return undefined;
  if (!requested || requested === "keep") return caps.defaultEffort;

  const requestedRank = effortRank(requested);
  if (requestedRank < 0) return caps.defaultEffort;

  // Pick highest supported at or below requested
  let best: string | undefined;
  let bestRank = -1;
  for (const e of caps.supportedEfforts) {
    const r = effortRank(e);
    if (r >= 0 && r <= requestedRank && r > bestRank) {
      best = e;
      bestRank = r;
    }
  }
  // If no supported effort is at or below requested, use default (not first)
  return best ?? caps.defaultEffort;
}

/**
 * Apply Claude-native effort/thinking fields to the request body.
 * For adaptive models: sets output_config.effort.
 * For budgeted models: preserves any existing thinking config, removes
 * incompatible adaptive/effort fields.
 * Returns the effective effort string for feedback, or undefined.
 */
export function resolveClaudeThinking(
  effort: string | undefined,
  caps: ClaudeModelCapabilities | undefined,
  body: Record<string, unknown>,
): string | undefined {
  if (!caps) return undefined;

  if (caps.thinkingMode === "adaptive") {
    const effectiveEffort = normalizeClaudeEffort(effort, caps);
    if (effectiveEffort) {
      // Anthropic output_config.effort for adaptive thinking models
      body.output_config = { ...(body.output_config as Record<string, unknown> ?? {}), effort: effectiveEffort };
    }
    return effectiveEffort;
  }

  if (caps.thinkingMode === "budgeted") {
    // Haiku: remove any adaptive effort fields that are incompatible
    if (body.output_config && typeof body.output_config === "object") {
      const oc = { ...(body.output_config as Record<string, unknown>) };
      delete oc.effort;
      body.output_config = Object.keys(oc).length ? oc : undefined;
    }
    return undefined;
  }

  return undefined;
}

/**
 * Build capacity info for a Claude model candidate, applying optional
 * user-configured context window override with physical eligibility enforcement.
 */
export function claudeCapacity(
  caps: ClaudeModelCapabilities | undefined,
  configuredContextWindow: number | undefined,
): CapacityInfo | undefined {
  if (!caps) return undefined;
  let contextWindow = caps.contextWindow;
  if (configuredContextWindow !== undefined && configuredContextWindow > 0) {
    // User override cannot exceed physical capacity
    contextWindow = Math.min(configuredContextWindow, caps.contextWindow);
  }
  return { contextWindow, outputBudget: caps.maxOutput };
}

/**
 * Compute the conservative default virtual context window: the minimum
 * usable context of all enabled candidates. This ensures compaction is
 * proactively triggered before any candidate would be excluded.
 */
export function safeVirtualContextBound(candidates: Candidate[]): number {
  let min = Infinity;
  for (const c of candidates) {
    const w = c.capacity?.contextWindow;
    if (w && w > 0 && w < min) min = w;
  }
  return Number.isFinite(min) ? min : 200_000;
}
