import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRecords,
  filterRecords,
  formatSummary,
  formatDetail,
  queryLogs,
  type LogRecord,
} from "../src/jev-logs";

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
    previous: { tier: "balanced", model: "gpt-6.1-sol", effort: "medium" },
    decision: { tier: "strong", reason: "jev", model: "gpt-6.1-sol", effort: "high" },
    cache: {
      window: "up to 1 hour, stopping at the most recent model switch",
      observed_responses: 3,
      newest_seconds_ago: 60,
      oldest_seconds_ago: 900,
      cache_read_tokens_avg: 1024,
      cache_created_tokens_avg: 512,
    },
    ...overrides,
  };
}

function recordLine(r: LogRecord): string {
  return JSON.stringify(r);
}

describe("parseRecords", () => {
  test("parses valid JSONL lines", () => {
    const content = [recordLine(makeRecord()), recordLine(makeRecord({ id: "2" }))].join("\n");
    const records = parseRecords(content);
    expect(records).toHaveLength(2);
    expect(records[0].id).toBe("test-id");
    expect(records[1].id).toBe("2");
  });

  test("skips malformed lines", () => {
    const content = [recordLine(makeRecord()), "not valid json", "{incomplete", recordLine(makeRecord({ id: "ok" }))].join("\n");
    const records = parseRecords(content);
    expect(records).toHaveLength(2);
  });

  test("handles empty content", () => {
    expect(parseRecords("")).toHaveLength(0);
    expect(parseRecords("\n\n")).toHaveLength(0);
  });

  test("handles trailing newline", () => {
    const content = recordLine(makeRecord()) + "\n";
    expect(parseRecords(content)).toHaveLength(1);
  });
});

describe("filterRecords", () => {
  const records: LogRecord[] = [
    makeRecord({ decision: { tier: "fast", reason: "jev", model: "gpt-6-luna", effort: "low" }, prompt: "hello" }),
    makeRecord({ decision: { tier: "strong", reason: "override", model: "gpt-6.1-sol", effort: "high" }, prompt: "debug the issue" }),
    makeRecord({ at: "2026-10-05T10:00:00.000Z", decision: { tier: "balanced", reason: "jev", model: "gpt-6.1-sol", effort: "medium" }, prompt: "explain code" }),
  ];

  test("filters by tier", () => {
    expect(filterRecords(records, { filterTier: "fast" })).toHaveLength(1);
    expect(filterRecords(records, { filterTier: "Fast" })).toHaveLength(1);
    expect(filterRecords(records, { filterTier: "long" })).toHaveLength(0);
  });

  test("filters by model (substring)", () => {
    expect(filterRecords(records, { filterModel: "luna" })).toHaveLength(1);
    expect(filterRecords(records, { filterModel: "sol" })).toHaveLength(2);
  });

  test("filters by decision reason", () => {
    expect(filterRecords(records, { filterDecision: "jev" })).toHaveLength(2);
    expect(filterRecords(records, { filterDecision: "override" })).toHaveLength(1);
  });

  test("filters by keyword in prompt", () => {
    expect(filterRecords(records, { filterKeyword: "debug" })).toHaveLength(1);
    expect(filterRecords(records, { filterKeyword: "hello" })).toHaveLength(1);
    expect(filterRecords(records, { filterKeyword: "nonexistent" })).toHaveLength(0);
  });

  test("filters by date prefix", () => {
    expect(filterRecords(records, { filterDate: "2026-10-05" })).toHaveLength(1);
    expect(filterRecords(records, { filterDate: "2026-10-04" })).toHaveLength(2);
  });

  test("combines filters", () => {
    expect(filterRecords(records, { filterTier: "strong", filterKeyword: "debug" })).toHaveLength(1);
    expect(filterRecords(records, { filterTier: "fast", filterKeyword: "debug" })).toHaveLength(0);
  });

  test("handles sparse records without crashing", () => {
    const sparse: LogRecord[] = [
      { id: "1" },
      { id: "2", decision: {} },
      { id: "3", decision: { tier: "fast" } },
    ];
    expect(filterRecords(sparse, { filterTier: "fast" })).toHaveLength(1);
    expect(filterRecords(sparse, { filterModel: "gpt" })).toHaveLength(0);
    expect(filterRecords(sparse, { filterDecision: "jev" })).toHaveLength(0);
    expect(filterRecords(sparse, { filterKeyword: "test" })).toHaveLength(0);
    expect(filterRecords(sparse, { filterDate: "2026" })).toHaveLength(0);
  });
});

describe("formatSummary", () => {
  test("produces human-readable summary", () => {
    const summary = formatSummary(makeRecord());
    expect(summary).toContain("Tier: strong");
    expect(summary).toContain("Model: gpt-6.1-sol");
    expect(summary).toContain("Effort: high");
    expect(summary).toContain("Decision: jev");
    expect(summary).toContain("Confidence: 0.85");
    expect(summary).toContain("fix the bug");
  });

  test("truncates long prompts", () => {
    const longPrompt = "a".repeat(200);
    const summary = formatSummary(makeRecord({ prompt: longPrompt }));
    expect(summary).toContain("...");
    expect(summary.length).toBeLessThan(longPrompt.length + 200);
  });

  test("handles missing fields gracefully", () => {
    const summary = formatSummary({ id: "x", at: "2026-01-01T00:00:00Z" });
    expect(summary).toContain("unavailable");
    expect(summary).not.toContain("undefined");
    expect(summary).not.toContain("null");
  });

  test("shows cache info when available", () => {
    const summary = formatSummary(makeRecord());
    expect(summary).toContain("Cache:");
    expect(summary).toContain("3 observations");
    expect(summary).toContain("1024 avg read");
    expect(summary).toContain("512 avg write");
  });

  test("shows legacy cache info when last_turn is present", () => {
    const summary = formatSummary(makeRecord({ cache: { last_turn: { cache_read_tokens: 2048, cache_created_tokens: 256 } } }));
    expect(summary).toContain("Cache:");
    expect(summary).toContain("2048 read");
    expect(summary).toContain("256 write");
  });

  test("shows JEV usage", () => {
    const summary = formatSummary(makeRecord());
    expect(summary).toContain("150 in");
    expect(summary).toContain("42 out");
  });

  test("shows error when present", () => {
    const record = makeRecord({ jev: { error: "timeout", ms: 3000 } });
    const summary = formatSummary(record);
    expect(summary).toContain("Error: timeout");
  });
});

describe("formatDetail", () => {
  test("includes full prompt", () => {
    const detail = formatDetail(makeRecord());
    expect(detail).toContain("Full prompt:");
    expect(detail).toContain("fix the bug in auth module");
  });

  test("includes previous state", () => {
    const detail = formatDetail(makeRecord());
    expect(detail).toContain("Previous: tier=balanced");
    expect(detail).toContain("model=gpt-6.1-sol");
  });

  test("includes JEV latency", () => {
    const detail = formatDetail(makeRecord());
    expect(detail).toContain("230ms");
  });
});

describe("queryLogs", () => {
  test("returns message for missing file", () => {
    const result = queryLogs("/nonexistent/path.jsonl");
    expect(result).toContain("No active session log found");
  });

  test("returns message for empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, "");
      expect(queryLogs(path)).toContain("empty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns message for all-malformed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, "bad json\nalso bad\n");
      expect(queryLogs(path)).toContain("no valid records");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shows last entry by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        recordLine(makeRecord({ prompt: "first" })),
        recordLine(makeRecord({ prompt: "second" })),
        recordLine(makeRecord({ prompt: "third" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = queryLogs(path);
      expect(result).toContain("third");
      expect(result).not.toContain("first");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("respects --last N", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        recordLine(makeRecord({ prompt: "first" })),
        recordLine(makeRecord({ prompt: "second" })),
        recordLine(makeRecord({ prompt: "third" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = queryLogs(path, { last: 2 });
      expect(result).toContain("second");
      expect(result).toContain("third");
      expect(result).not.toContain("first");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns error for invalid limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord()));
      expect(queryLogs(path, { last: 0 })).toContain("Invalid limit");
      expect(queryLogs(path, { last: -1 })).toContain("Invalid limit");
      expect(queryLogs(path, { last: NaN })).toContain("Invalid limit");
      expect(queryLogs(path, { last: Infinity })).toContain("Invalid limit");
      expect(queryLogs(path, { last: -Infinity })).toContain("Invalid limit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns error for unreadable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord()));
      await chmod(path, 0o000);
      const result = queryLogs(path);
      expect(result).toContain("Could not read");
    } finally {
      await chmod(join(dir, "test.jsonl"), 0o644).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports filter names in empty result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord()));
      const result = queryLogs(path, { filterTier: "long" });
      expect(result).toContain("tier=long");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles malformed final line gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord({ prompt: "good" })) + "\n{truncated");
      const result = queryLogs(path);
      expect(result).toContain("good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detail mode shows full prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, recordLine(makeRecord({ prompt: "fix the complex authentication bug" })));
      const result = queryLogs(path, { detail: true });
      expect(result).toContain("Full prompt:");
      expect(result).toContain("fix the complex authentication bug");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("N entries with separator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        recordLine(makeRecord({ prompt: "one" })),
        recordLine(makeRecord({ prompt: "two" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = queryLogs(path, { last: 2 });
      expect(result).toContain("--- Entry");
      expect(result).toContain("one");
      expect(result).toContain("two");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
