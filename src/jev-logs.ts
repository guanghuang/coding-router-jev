#!/usr/bin/env bun

import { readFileSync, existsSync } from "node:fs";

export type LogRecord = {
  id?: string;
  at?: string;
  conversation?: string;
  turn?: string;
  prompt?: string;
  jev?: {
    request?: unknown;
    response?: { answers?: { model?: { choice?: string; confidence?: number }; reasoning_effort?: { choice?: string; confidence?: number } }; usage?: { input_tokens?: number; output_tokens?: number } } | null;
    error?: string;
    ms?: number;
  };
  previous?: { tier?: string; model?: string; effort?: string | null };
  decision?: { tier?: string; reason?: string; model?: string; effort?: string | null; effort_update_preserves_prefix?: boolean };
  cache?: Record<string, unknown>;
};

export type QueryOptions = {
  last?: number;
  filterTier?: string;
  filterModel?: string;
  filterDecision?: string;
  filterKeyword?: string;
  filterDate?: string;
  detail?: boolean;
};

export function parseRecords(content: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as LogRecord);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

export function filterRecords(records: LogRecord[], options: QueryOptions): LogRecord[] {
  let filtered = records;

  if (options.filterTier) {
    const tier = options.filterTier.toLowerCase();
    filtered = filtered.filter(r => r.decision?.tier?.toLowerCase() === tier);
  }

  if (options.filterModel) {
    const model = options.filterModel.toLowerCase();
    filtered = filtered.filter(r => r.decision?.model?.toLowerCase().includes(model));
  }

  if (options.filterDecision) {
    const decision = options.filterDecision.toLowerCase();
    filtered = filtered.filter(r => r.decision?.reason?.toLowerCase().includes(decision));
  }

  if (options.filterKeyword) {
    const keyword = options.filterKeyword.toLowerCase();
    filtered = filtered.filter(r => r.prompt?.toLowerCase().includes(keyword));
  }

  if (options.filterDate) {
    const datePrefix = options.filterDate;
    filtered = filtered.filter(r => r.at?.startsWith(datePrefix));
  }

  return filtered;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "unavailable";
  return String(value);
}

export function formatSummary(record: LogRecord): string {
  const parts: string[] = [];
  const time = record.at ? new Date(record.at).toLocaleString() : "unknown time";
  parts.push(`Time: ${time}`);

  if (record.prompt !== undefined) {
    parts.push(`Prompt: ${truncate(record.prompt, 120)}`);
  }

  if (record.decision) {
    parts.push(`Tier: ${formatValue(record.decision.tier)}`);
    parts.push(`Model: ${formatValue(record.decision.model)}`);
    parts.push(`Effort: ${formatValue(record.decision.effort)}`);
    parts.push(`Decision: ${formatValue(record.decision.reason)}`);
  }

  if (record.jev?.response?.answers?.model) {
    const confidence = record.jev.response.answers.model.confidence;
    parts.push(`Confidence: ${confidence !== null && confidence !== undefined ? confidence.toFixed(2) : "unavailable"}`);
  } else {
    parts.push(`Confidence: unavailable`);
  }

  const jevUsage = record.jev?.response?.usage;
  if (jevUsage) {
    const input = typeof jevUsage.input_tokens === "number" ? jevUsage.input_tokens : null;
    const output = typeof jevUsage.output_tokens === "number" ? jevUsage.output_tokens : null;
    if (input !== null || output !== null) {
      parts.push(`JEV usage: ${input ?? "unavailable"} in / ${output ?? "unavailable"} out`);
    }
  }

  if (record.cache) {
    const last = record.cache.last_turn as { cache_read_tokens?: number; cache_created_tokens?: number } | null | undefined;
    if (last && (last.cache_read_tokens !== undefined || last.cache_created_tokens !== undefined)) {
      parts.push(`Cache: ${formatValue(last.cache_read_tokens)} read / ${formatValue(last.cache_created_tokens)} write`);
    }
  }

  if (record.jev?.error) {
    parts.push(`Error: ${record.jev.error}`);
  }

  return parts.join("\n");
}

export function formatDetail(record: LogRecord): string {
  const summary = formatSummary(record);
  const extras: string[] = [summary];

  if (record.prompt !== undefined) {
    extras.push(`\nFull prompt:\n${record.prompt}`);
  }

  if (record.previous) {
    extras.push(`\nPrevious: tier=${formatValue(record.previous.tier)}, model=${formatValue(record.previous.model)}, effort=${formatValue(record.previous.effort)}`);
  }

  if (record.jev?.ms !== undefined) {
    extras.push(`JEV latency: ${record.jev.ms}ms`);
  }

  return extras.join("\n");
}

export function queryLogs(filePath: string, options: QueryOptions = {}): string {
  if (!existsSync(filePath)) {
    return "No active session log found. The router may not have started or no routing decisions have been made yet.";
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return "Could not read the session log file.";
  }

  if (!content.trim()) {
    return "The session log is empty. No routing decisions have been recorded yet.";
  }

  const allRecords = parseRecords(content);
  if (allRecords.length === 0) {
    return "The session log contains no valid records.";
  }

  const filtered = filterRecords(allRecords, options);
  if (filtered.length === 0) {
    const appliedFilters: string[] = [];
    if (options.filterTier) appliedFilters.push(`tier=${options.filterTier}`);
    if (options.filterModel) appliedFilters.push(`model=${options.filterModel}`);
    if (options.filterDecision) appliedFilters.push(`decision=${options.filterDecision}`);
    if (options.filterKeyword) appliedFilters.push(`keyword=${options.filterKeyword}`);
    if (options.filterDate) appliedFilters.push(`date=${options.filterDate}`);
    return appliedFilters.length
      ? `No records match the applied filters: ${appliedFilters.join(", ")}.`
      : "No matching records found.";
  }

  const limit = options.last ?? 1;
  if (limit <= 0) {
    return "Invalid limit: must be a positive number.";
  }
  const selected = filtered.slice(-limit);
  const formatter = options.detail ? formatDetail : formatSummary;

  if (selected.length === 1) {
    return formatter(selected[0]);
  }

  return selected
    .map((record, index) => `--- Entry ${filtered.length - selected.length + index + 1} of ${filtered.length} ---\n${formatter(record)}`)
    .join("\n\n");
}

function parseArgs(argv: string[]): { filePath: string; options: QueryOptions } | { error: string } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return {
      error: `Usage: jev-logs <jsonl-path> [options]

Options:
  --last N              Show last N entries (default: 1)
  --filter-tier TIER    Filter by tier (fast, balanced, strong, long)
  --filter-model MODEL  Filter by model name (substring match)
  --filter-decision D   Filter by decision reason (substring match)
  --filter-keyword K    Filter by prompt keyword (substring match)
  --filter-date DATE    Filter by date prefix (e.g. 2026-10-04)
  --detail              Show full prompt and JEV details
  --help                Show this help`,
    };
  }

  const filePath = args[0];
  const options: QueryOptions = {};

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--last":
        options.last = parseInt(args[++i] ?? "", 10) || undefined;
        break;
      case "--filter-tier":
        options.filterTier = args[++i];
        break;
      case "--filter-model":
        options.filterModel = args[++i];
        break;
      case "--filter-decision":
        options.filterDecision = args[++i];
        break;
      case "--filter-keyword":
        options.filterKeyword = args[++i];
        break;
      case "--filter-date":
        options.filterDate = args[++i];
        break;
      case "--detail":
        options.detail = true;
        break;
    }
  }

  return { filePath, options };
}

if (import.meta.main) {
  const result = parseArgs(process.argv);
  if ("error" in result) {
    console.log(result.error);
    process.exitCode = result.error.startsWith("Usage:") ? 0 : 1;
  } else {
    console.log(queryLogs(result.filePath, result.options));
  }
}
