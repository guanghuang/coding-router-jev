import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type TokenUsage = { input_tokens: number | null; cached_input_tokens: number | null; cache_write_tokens: number | null; output_tokens: number | null; reasoning_output_tokens: number | null; total_tokens: number | null };
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeModel = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value) ? value : null;
export function extractUsage(response: any): TokenUsage | null {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") return null;
  return { input_tokens: count(usage.input_tokens), cached_input_tokens: count(usage.input_tokens_details?.cached_tokens), cache_write_tokens: count(usage.input_tokens_details?.cache_write_tokens), output_tokens: count(usage.output_tokens), reasoning_output_tokens: count(usage.output_tokens_details?.reasoning_tokens), total_tokens: count(usage.total_tokens) };
}

export function createTelemetry(path?: string) {
  const launchId = randomUUID();
  function emit(record: object) {
    if (!path) return;
    try { appendFileSync(path, JSON.stringify({ schema: 1, launch_id: launchId, ...record }) + "\n", { mode: 0o600 }); }
    catch { console.error("[Jev] telemetry write failed"); }
  }
  return {
    enabled: !!path,
    decision(decisionId: string, input: unknown, output: unknown) {
      emit({ kind: "routing_decision", event_id: randomUUID(), decision_id: decisionId, at: new Date().toISOString(), classifier_usage: { input_tokens: count(input), output_tokens: count(output) } });
    },
    start(model: string | undefined, effort: string | undefined, decisionId?: string, requestKind = "other", routingMode = "unknown") {
      const requestId = randomUUID();
      const safeEffort = effort && ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort) ? effort : null;
      emit({ kind: "request_start", event_id: randomUUID(), request_id: requestId, at: new Date().toISOString(), model: safeModel(model), effort: safeEffort, decision_id: decisionId ?? null, decision_link: decisionId ? "router_state_inferred" : "unavailable", request_kind: requestKind, routing_mode: routingMode });
      return requestId;
    },
    finish(requestId: string, status: string, usage: TokenUsage | null, reportedModel?: unknown) {
      emit({ kind: "request_end", event_id: randomUUID(), request_id: requestId, at: new Date().toISOString(), status, usage, reported_model: safeModel(reportedModel) });
    },
    conflict(requestId: string) {
      emit({ kind: "request_conflict", event_id: randomUUID(), request_id: requestId, at: new Date().toISOString() });
    },
  };
}
