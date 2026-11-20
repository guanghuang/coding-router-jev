import { lookupCapabilities, type ClaudeModelCapabilities } from "./claude-capabilities";

type Support = { supported?: boolean };
type ModelEntry = {
  id: string;
  created_at?: unknown;
  lifecycle?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  capabilities?: {
    effort?: Support & Record<string, Support>;
    thinking?: Support & { types?: Record<string, Support> };
  };
};

export const claudeLatestFamily = (id: string) => /^(haiku|sonnet|opus|fable):latest$/i.exec(id)?.[1].toLowerCase();

export async function fetchClaudeCatalog(upstream: string, headers: Headers): Promise<ModelEntry[]> {
  const url = new URL(`${upstream.replace(/\/$/, "")}/v1/models`);
  url.searchParams.set("limit", "100");
  const signal = AbortSignal.timeout(10_000);
  const entries: ModelEntry[] = [];
  const cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const response = await fetch(url, { headers, signal, redirect: "manual" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data?.data) || typeof data.has_more !== "boolean") {
      throw new Error("invalid model catalog");
    }
    for (const entry of data.data) {
      if (typeof entry?.id !== "string") throw new Error("invalid model catalog entry");
      entries.push(entry);
    }
    if (!data.has_more) return entries;
    const cursor = data.last_id;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) {
      throw new Error("invalid model catalog pagination");
    }
    cursors.add(cursor);
    url.searchParams.set("after_id", cursor);
  }
  throw new Error("model catalog pagination limit reached");
}

export function latestClaudeModel(entries: ModelEntry[], family: string): ModelEntry | undefined {
  const pattern = new RegExp(`^claude-${family}-\\d+(?:-\\d+)*$`, "i");
  // Anthropic lists newer models first. Use release timestamps when provided.
  const released = (entry: ModelEntry) => (typeof entry.created_at === "string" ? Date.parse(entry.created_at) : NaN) || 0;
  return entries
    .filter(entry => (entry.lifecycle === "active" || entry.lifecycle === undefined) && pattern.test(entry.id))
    .sort((a, b) => released(b) - released(a))[0];
}

export function claudeCatalogCapabilities(entry: ModelEntry, family: string): ClaudeModelCapabilities {
  const fallback = lookupCapabilities(entry.id);
  const limit = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const contextWindow = limit(entry.max_input_tokens);
  const maxOutput = limit(entry.max_tokens);
  const thinking = entry.capabilities?.thinking;
  const effort = entry.capabilities?.effort;
  const thinkingTypes = thinking && (thinking.supported === false ? [] :
    Object.keys(thinking.types ?? {}).filter(type => thinking.types?.[type]?.supported === true));
  const thinkingMode = thinkingTypes ? thinkingTypes.includes("adaptive") ? "adaptive" :
    thinkingTypes.includes("enabled") ? "budgeted" : "none" : fallback?.thinkingMode ?? "none";
  const supportedEfforts = effort ? ["low", "medium", "high", "xhigh", "max", "ultra"]
    .filter(level => effort.supported === true && effort[level]?.supported === true) : fallback?.supportedEfforts ?? [];
  const preferredEffort = fallback?.defaultEffort ?? "medium";
  return {
    modelId: entry.id, family, contextWindow, maxOutput,
    thinkingMode, thinkingTypes, supportedEfforts,
    defaultEffort: supportedEfforts.includes(preferredEffort) ? preferredEffort : supportedEfforts[0],
  };
}
