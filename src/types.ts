export const TIERS = ["fast", "balanced", "strong", "long"] as const;
export type Tier = typeof TIERS[number];
export type Item = {
  type?: string;
  role?: string;
  content?: string | { type?: string; text?: string; [key: string]: unknown }[];
  reasoning?: { effort?: string; [key: string]: unknown };
  [key: string]: unknown;
};
export type CodexBody = {
  model: string;
  input?: Item[] | string;
  reasoning?: { effort?: string; [key: string]: unknown };
  prompt_cache_key?: string;
  previous_response_id?: string;
  instructions?: string;
  client_metadata?: Record<string, unknown>;
  context_management?: unknown;
  truncation?: string;
  [key: string]: unknown;
};
export type CapacityInfo = { contextWindow?: number; outputBudget?: number };
export type Candidate = { tier: Tier; id: string; description: string; efforts: string[]; defaultEffort?: string; capacity?: CapacityInfo };
export type RecentContext = { previous_user_request: string; previous_assistant_excerpt?: string };
export type ContextEvidence = { tokens: number; source: "measured" | "estimated"; accuracy?: string };
export type EligibilityResult = {
  eligible: Candidate[];
  rejected: { candidate: Candidate; reason: string }[];
  unknown: Candidate[];
};
export type RoutingDecision = {
  candidate: Candidate;
  tier: Tier;
  effort?: string;
  effectiveEffort?: string;
  confidence?: number;
  reason: string;
  capacityStatus: "eligible" | "ineligible" | "unknown";
};
