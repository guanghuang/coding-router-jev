import { readFileSync, existsSync } from "node:fs";
import {
  parseRecords,
  filterRecords,
  formatSummary,
  formatDetail,
  isObservation,
  type LogRecord,
  type QueryOptions,
  type ResponseObservation,
} from "./jev-logs";

export type PiQueryOptions = QueryOptions & {
  branch?: string;
};

function filterByBranch(records: LogRecord[], branch: string): LogRecord[] {
  return records.filter(r => r.branch === branch);
}

export function mergeObservations(
  decisions: LogRecord[],
  observations: ResponseObservation[],
): LogRecord[] {
  if (observations.length === 0) return decisions;
  const obsMap = new Map<string, ResponseObservation>();
  for (const obs of observations) {
    if (obs.decision_id) obsMap.set(obs.decision_id, obs);
    else if (obs.turn) obsMap.set(`turn:${obs.turn}`, obs);
  }
  return decisions.map(d => {
    const obs = (d.id && obsMap.get(d.id)) || (d.turn && obsMap.get(`turn:${d.turn}`)) || null;
    if (!obs) return d;
    const merged: LogRecord = { ...d };
    if (!merged.cache) merged.cache = {};
    const agentUsage: Record<string, unknown> = {};
    if (obs.input_tokens !== undefined) agentUsage.input_tokens = obs.input_tokens;
    if (obs.output_tokens !== undefined) agentUsage.output_tokens = obs.output_tokens;
    if (obs.cache_read_tokens !== undefined) agentUsage.cache_read_tokens = obs.cache_read_tokens;
    if (obs.cache_write_tokens !== undefined) agentUsage.cache_write_tokens = obs.cache_write_tokens;
    if (Object.keys(agentUsage).length > 0) {
      merged.cache = { ...merged.cache, agent_usage: agentUsage };
    }
    return merged;
  });
}

function isDecisionRecord(record: unknown): record is LogRecord {
  if (!record || typeof record !== "object" || isObservation(record)) return false;
  const r = record as Record<string, unknown>;
  return (r.id !== undefined || r.at !== undefined || r.decision !== undefined);
}

export function piQueryLogs(filePath: string, options: PiQueryOptions = {}): string {
  if (!existsSync(filePath)) {
    return "No active session log found. The router may not have started or no routing decisions have been made yet.";
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    return `Could not read the session log file: ${reason}`;
  }

  if (!content.trim()) {
    return "The session log is empty. No routing decisions have been recorded yet.";
  }

  const allParsed = parseRecords(content);
  const observations: ResponseObservation[] = [];
  const decisions: LogRecord[] = [];
  for (const record of allParsed) {
    if (isObservation(record)) observations.push(record as unknown as ResponseObservation);
    else if (isDecisionRecord(record)) decisions.push(record);
  }

  if (decisions.length === 0) {
    return "The session log contains no valid decision records.";
  }

  let filtered = decisions;
  if (options.branch) {
    filtered = filterByBranch(filtered, options.branch);
    if (filtered.length === 0) {
      return `No decision records found for branch "${options.branch}".`;
    }
  }

  filtered = filterRecords(filtered, options);
  if (filtered.length === 0) {
    const appliedFilters: string[] = [];
    if (options.filterTier) appliedFilters.push(`tier=${options.filterTier}`);
    if (options.filterModel) appliedFilters.push(`model=${options.filterModel}`);
    if (options.filterDecision) appliedFilters.push(`decision=${options.filterDecision}`);
    if (options.filterKeyword) appliedFilters.push(`keyword=${options.filterKeyword}`);
    if (options.filterDate) appliedFilters.push(`date=${options.filterDate}`);
    if (options.branch) appliedFilters.push(`branch=${options.branch}`);
    return appliedFilters.length
      ? `No records match the applied filters: ${appliedFilters.join(", ")}.`
      : "No matching records found.";
  }

  const limit = options.last ?? 1;
  if (!Number.isFinite(limit) || limit <= 0) {
    return "Invalid limit: must be a positive number.";
  }
  const cappedLimit = Math.min(limit, 100);

  const selected = filtered.slice(-cappedLimit);
  const merged = mergeObservations(selected, observations);
  const formatter = options.detail ? formatDetail : formatSummary;

  if (merged.length === 1) {
    return formatter(merged[0]);
  }

  return merged
    .map((record, index) => `--- Entry ${filtered.length - selected.length + index + 1} of ${filtered.length} ---\n${formatter(record)}`)
    .join("\n\n");
}
