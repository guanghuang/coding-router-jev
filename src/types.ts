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
export type Candidate = { tier: Tier; id: string; description: string; efforts: string[]; defaultEffort?: string };
export type RecentContext = { previous_user_request: string; previous_assistant_excerpt?: string };
