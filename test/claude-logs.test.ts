import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveActiveSession,
  claudeQueryLogs,
  mergeObservations,
} from "../src/claude-logs";
import type { LogRecord, ResponseObservation } from "../src/jev-logs";

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    id: "test-id",
    at: "2026-10-04T14:30:00.000Z",
    conversation: "conv-1",
    turn: "turn-1",
    prompt: "fix the bug in auth module",
    jev: {
      response: {
        answers: {
          model: { choice: "strong", confidence: 0.85 },
          reasoning_effort: { choice: "high", confidence: 0.9 },
        },
        usage: { input_tokens: 150, output_tokens: 42 },
      },
      ms: 230,
    },
    previous: { tier: "balanced", model: "claude-sonnet-4-20250514" },
    decision: { tier: "strong", reason: "jev", model: "claude-sonnet-4-20250514", effort: "high" },
    cache: {
      window: "up to 1 hour, stopping at the most recent model switch",
      observed_responses: 3,
      cache_read_tokens_avg: 1024,
      cache_created_tokens_avg: 512,
    },
    ...overrides,
  };
}

function recordLine(r: LogRecord | ResponseObservation): string {
  return JSON.stringify(r);
}

describe("resolveActiveSession", () => {
  test("returns undefined when JEV_SESSION_LOG is not set", () => {
    expect(resolveActiveSession({})).toBeUndefined();
  });

  test("returns undefined when JEV_SESSION_LOG is empty", () => {
    expect(resolveActiveSession({ JEV_SESSION_LOG: "" })).toBeUndefined();
    expect(resolveActiveSession({ JEV_SESSION_LOG: "  " })).toBeUndefined();
  });

  test("returns undefined when file does not exist", () => {
    expect(resolveActiveSession({ JEV_SESSION_LOG: "/nonexistent/path.jsonl" })).toBeUndefined();
  });

  test("returns path when file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-resolve-"));
    try {
      const logPath = join(dir, "claude-test.jsonl");
      await writeFile(logPath, recordLine(makeRecord()));
      expect(resolveActiveSession({ JEV_SESSION_LOG: logPath })).toBe(logPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("claudeQueryLogs", () => {
  test("returns message for missing file", () => {
    const result = claudeQueryLogs("/nonexistent/path.jsonl");
    expect(result).toContain("No active session log found");
  });

  test("returns message for empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, "");
      expect(claudeQueryLogs(path)).toContain("empty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns message for all-malformed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, "bad json\nalso bad\n");
      expect(claudeQueryLogs(path)).toContain("no valid decision records");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shows last entry by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        recordLine(makeRecord({ prompt: "first" })),
        recordLine(makeRecord({ prompt: "second" })),
        recordLine(makeRecord({ prompt: "third" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = claudeQueryLogs(path);
      expect(result).toContain("third");
      expect(result).not.toContain("first");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("respects last N option", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        recordLine(makeRecord({ prompt: "first" })),
        recordLine(makeRecord({ prompt: "second" })),
        recordLine(makeRecord({ prompt: "third" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = claudeQueryLogs(path, { last: 2 });
      expect(result).toContain("second");
      expect(result).toContain("third");
      expect(result).not.toContain("first");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("caps at 100 entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = Array.from({ length: 150 }, (_, i) =>
        recordLine(makeRecord({ prompt: `entry-${i}` })),
      ).join("\n");
      await writeFile(path, lines);
      const result = claudeQueryLogs(path, { last: 150 });
      expect(result).toContain("entry-149");
      expect(result).toContain("entry-50");
      expect(result).not.toContain("entry-49");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("filters by tier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        recordLine(makeRecord({ decision: { tier: "fast", reason: "jev", model: "claude-haiku", effort: "low" } })),
        recordLine(makeRecord({ decision: { tier: "strong", reason: "jev", model: "claude-sonnet", effort: "high" } })),
      ].join("\n");
      await writeFile(path, lines);
      const result = claudeQueryLogs(path, { last: 10, filterTier: "fast" });
      expect(result).toContain("fast");
      expect(result).not.toContain("strong");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("filters by keyword", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        recordLine(makeRecord({ prompt: "debug the auth" })),
        recordLine(makeRecord({ prompt: "add feature" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = claudeQueryLogs(path, { last: 10, filterKeyword: "debug" });
      expect(result).toContain("debug");
      expect(result).not.toContain("feature");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports filter names in empty result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord()));
      const result = claudeQueryLogs(path, { filterTier: "long" });
      expect(result).toContain("tier=long");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns error for invalid limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord()));
      expect(claudeQueryLogs(path, { last: 0 })).toContain("Invalid limit");
      expect(claudeQueryLogs(path, { last: -1 })).toContain("Invalid limit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detail mode shows full prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord({ prompt: "fix the complex authentication bug" })));
      const result = claudeQueryLogs(path, { detail: true });
      expect(result).toContain("Full prompt:");
      expect(result).toContain("fix the complex authentication bug");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("separates observations from decisions and merges them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const obs: ResponseObservation = {
        type: "response-observation",
        decision_id: "test-id",
        input_tokens: 5000,
        output_tokens: 1200,
        cache_read_tokens: 3000,
      };
      const lines = [
        recordLine(makeRecord({ id: "test-id", prompt: "test merge" })),
        recordLine(obs),
      ].join("\n");
      await writeFile(path, lines);
      const result = claudeQueryLogs(path, { detail: true });
      expect(result).toContain("test merge");
      expect(result).toContain("Agent usage:");
      expect(result).toContain("5000 in");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles malformed final line gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord({ prompt: "good" })) + "\n{truncated");
      const result = claudeQueryLogs(path);
      expect(result).toContain("good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns error for unreadable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord()));
      await chmod(path, 0o000);
      const result = claudeQueryLogs(path);
      expect(result).toContain("Could not read");
    } finally {
      await chmod(join(dir, "test.jsonl"), 0o644).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles observation-only log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const obs: ResponseObservation = {
        type: "response-observation",
        decision_id: "d1",
        input_tokens: 500,
      };
      await writeFile(path, recordLine(obs));
      const result = claudeQueryLogs(path);
      expect(result).toContain("no valid decision records");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("filters by model, decision, and date", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        recordLine(makeRecord({ decision: { tier: "fast", reason: "override", model: "claude-haiku", effort: "low" }, at: "2026-10-04T10:00:00Z" })),
        recordLine(makeRecord({ decision: { tier: "strong", reason: "jev", model: "claude-sonnet", effort: "high" }, at: "2026-10-05T10:00:00Z" })),
      ].join("\n");
      await writeFile(path, lines);

      expect(claudeQueryLogs(path, { last: 10, filterModel: "haiku" })).toContain("haiku");
      expect(claudeQueryLogs(path, { last: 10, filterDecision: "override" })).toContain("override");
      expect(claudeQueryLogs(path, { last: 10, filterDate: "2026-10-05" })).toContain("sonnet");
      expect(claudeQueryLogs(path, { last: 10, filterDate: "2026-10-05" })).not.toContain("haiku");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("invalid limit NaN and Infinity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord()));
      expect(claudeQueryLogs(path, { last: NaN })).toContain("Invalid limit");
      expect(claudeQueryLogs(path, { last: Infinity })).toContain("Invalid limit");
      expect(claudeQueryLogs(path, { last: -Infinity })).toContain("Invalid limit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two simultaneous wrappers cannot leak logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-logs-test-"));
    try {
      const pathA = join(dir, "claude-session-a.jsonl");
      const pathB = join(dir, "claude-session-b.jsonl");
      await writeFile(pathA, recordLine(makeRecord({ prompt: "session A prompt" })));
      await writeFile(pathB, recordLine(makeRecord({ prompt: "session B prompt" })));

      const resultA = claudeQueryLogs(pathA);
      const resultB = claudeQueryLogs(pathB);

      expect(resultA).toContain("session A");
      expect(resultA).not.toContain("session B");
      expect(resultB).toContain("session B");
      expect(resultB).not.toContain("session A");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeObservations", () => {
  test("returns decisions unchanged when no observations", () => {
    const decisions = [makeRecord()];
    expect(mergeObservations(decisions, [])).toEqual(decisions);
  });

  test("merges by decision_id", () => {
    const decisions = [makeRecord({ id: "d1" })];
    const obs: ResponseObservation[] = [{
      type: "response-observation",
      decision_id: "d1",
      input_tokens: 500,
      output_tokens: 100,
    }];
    const merged = mergeObservations(decisions, obs);
    expect(merged[0].cache).toBeDefined();
    const usage = (merged[0].cache as Record<string, unknown>).agent_usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(500);
    expect(usage.output_tokens).toBe(100);
  });

  test("merges by turn key when no decision_id", () => {
    const decisions = [makeRecord({ id: undefined, turn: "t1" })];
    const obs: ResponseObservation[] = [{
      type: "response-observation",
      turn: "t1",
      cache_read_tokens: 2000,
    }];
    const merged = mergeObservations(decisions, obs);
    const usage = (merged[0].cache as Record<string, unknown>).agent_usage as Record<string, unknown>;
    expect(usage.cache_read_tokens).toBe(2000);
  });

  test("skips unmatched observations", () => {
    const decisions = [makeRecord({ id: "d1" })];
    const obs: ResponseObservation[] = [{
      type: "response-observation",
      decision_id: "d999",
      input_tokens: 500,
    }];
    const merged = mergeObservations(decisions, obs);
    expect(merged[0]).toEqual(decisions[0]);
  });

  test("merges cache_write_tokens and preserves existing cache fields", () => {
    const decisions = [makeRecord({ id: "d1", cache: { window: "test", observed_responses: 5 } })];
    const obs: ResponseObservation[] = [{
      type: "response-observation",
      decision_id: "d1",
      cache_write_tokens: 1500,
    }];
    const merged = mergeObservations(decisions, obs);
    const cache = merged[0].cache as Record<string, unknown>;
    expect(cache.window).toBe("test");
    expect(cache.observed_responses).toBe(5);
    const usage = cache.agent_usage as Record<string, unknown>;
    expect(usage.cache_write_tokens).toBe(1500);
  });
});
