import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piQueryLogs } from "../src/pi-logs";
import type { LogRecord, ResponseObservation } from "../src/jev-logs";

function makeDecision(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    id: "pi-sess1-1",
    at: "2026-10-04T14:30:00.000Z",
    agent: "pi",
    session: "sess1",
    branch: "main",
    turn: "turn-1",
    prompt: "fix the bug in auth module",
    provider_model: "openai-codex/gpt-6.1-sol",
    decision: { tier: "strong", reason: "JEV", model: "openai-codex/gpt-6.1-sol", effort: "high" },
    effective_effort: "high",
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
    cache: { observed_responses: 3, cache_read_tokens_avg: 1024, cache_created_tokens_avg: 512 },
    ...overrides,
  };
}

function makeObservation(overrides: Partial<ResponseObservation> = {}): ResponseObservation {
  return {
    type: "response-observation",
    decision_id: "pi-sess1-1",
    turn: "turn-1",
    at: "2026-10-04T14:30:05.000Z",
    agent: "pi",
    session: "sess1",
    branch: "main",
    provider_model: "openai-codex/gpt-6.1-sol",
    input_tokens: 5000,
    output_tokens: 1200,
    cache_read_tokens: 3500,
    cache_write_tokens: 800,
    ...overrides,
  };
}

function line(r: LogRecord | ResponseObservation): string {
  return JSON.stringify(r);
}

describe("piQueryLogs — basic", () => {
  test("returns message for missing file", () => {
    const result = piQueryLogs("/nonexistent/path.jsonl");
    expect(result).toContain("No active session log found");
  });

  test("returns message for empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, "");
      expect(piQueryLogs(path)).toContain("empty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns message for all-malformed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, "bad json\nalso bad\n");
      expect(piQueryLogs(path)).toContain("no valid decision records");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns message for unreadable file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision()));
      await chmod(path, 0o000);
      const result = piQueryLogs(path);
      expect(result).toContain("Could not read");
    } finally {
      await chmod(join(dir, "test.jsonl"), 0o644).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shows last entry by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        line(makeDecision({ prompt: "first", id: "pi-1" })),
        line(makeDecision({ prompt: "second", id: "pi-2" })),
        line(makeDecision({ prompt: "third", id: "pi-3" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = piQueryLogs(path);
      expect(result).toContain("third");
      expect(result).not.toContain("first");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("caps limit at 100", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const records = Array.from({ length: 110 }, (_, i) =>
        line(makeDecision({ prompt: `entry-${i}`, id: `pi-${i}` }))
      );
      await writeFile(path, records.join("\n"));
      const result = piQueryLogs(path, { last: 200 });
      const entries = result.split("--- Entry").length - 1;
      expect(entries).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns error for invalid limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision()));
      expect(piQueryLogs(path, { last: 0 })).toContain("Invalid limit");
      expect(piQueryLogs(path, { last: -1 })).toContain("Invalid limit");
      expect(piQueryLogs(path, { last: NaN })).toContain("Invalid limit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("piQueryLogs — branch filtering", () => {
  test("filters records by branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        line(makeDecision({ prompt: "on main", branch: "main", id: "pi-1" })),
        line(makeDecision({ prompt: "on fork", branch: "fork-1", id: "pi-2" })),
        line(makeDecision({ prompt: "also main", branch: "main", id: "pi-3" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = piQueryLogs(path, { last: 10, branch: "main" });
      expect(result).toContain("on main");
      expect(result).toContain("also main");
      expect(result).not.toContain("on fork");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns message when no records match branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision({ branch: "main" })));
      const result = piQueryLogs(path, { branch: "nonexistent" });
      expect(result).toContain('No decision records found for branch "nonexistent"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("piQueryLogs — observation merging", () => {
  test("excludes observation records from decision count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        line(makeDecision({ id: "pi-1", prompt: "first" })),
        line(makeObservation({ decision_id: "pi-1" })),
        line(makeDecision({ id: "pi-2", prompt: "second" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = piQueryLogs(path, { last: 10 });
      expect(result).toContain("first");
      expect(result).toContain("second");
      expect(result).not.toContain("response-observation");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges observation usage into decision view", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        line(makeDecision({ id: "pi-1", prompt: "test", cache: {} })),
        line(makeObservation({ decision_id: "pi-1", input_tokens: 5000, output_tokens: 1200 })),
      ].join("\n");
      await writeFile(path, lines);
      const result = piQueryLogs(path, { last: 1, detail: true });
      expect(result).toContain("test");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("matches observation by turn when decision_id is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        line(makeDecision({ id: "pi-1", turn: "turn-5", prompt: "by turn", cache: {} })),
        line(makeObservation({ decision_id: undefined, turn: "turn-5", input_tokens: 3000 })),
      ].join("\n");
      await writeFile(path, lines);
      const result = piQueryLogs(path, { last: 1 });
      expect(result).toContain("by turn");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles file with only observation records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeObservation()));
      const result = piQueryLogs(path);
      expect(result).toContain("no valid decision records");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("piQueryLogs — Pi-specific formatting", () => {
  test("shows effective effort in summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision({ effective_effort: "high" })));
      const result = piQueryLogs(path);
      expect(result).toContain("Effective effort: high");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shows provider model in summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision({ provider_model: "openai-codex/gpt-6.1-sol" })));
      const result = piQueryLogs(path);
      expect(result).toContain("Provider model: openai-codex/gpt-6.1-sol");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shows requested vs effective effort in detail when different", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision({
        requested_effort: "xhigh",
        effective_effort: "high",
      })));
      const result = piQueryLogs(path, { detail: true });
      expect(result).toContain("Requested effort: xhigh");
      expect(result).toContain("effective: high");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shows capacity status in detail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision({
        capacity_status: "no-eligible",
        capacity_reason: "all candidates rejected",
      })));
      const result = piQueryLogs(path, { detail: true });
      expect(result).toContain("Capacity: no-eligible");
      expect(result).toContain("all candidates rejected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("piQueryLogs — malformed/trailing lines", () => {
  test("handles malformed final line gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision({ prompt: "good" })) + "\n{truncated");
      const result = piQueryLogs(path);
      expect(result).toContain("good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles orphan observation without crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      const lines = [
        line(makeDecision({ id: "pi-1", prompt: "valid decision" })),
        line(makeObservation({ decision_id: "orphan-id" })),
      ].join("\n");
      await writeFile(path, lines);
      const result = piQueryLogs(path);
      expect(result).toContain("valid decision");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("piQueryLogs — filters", () => {
  test("reports filter names in empty result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-logs-test-"));
    try {
      const path = join(dir, "test.jsonl");
      await writeFile(path, line(makeDecision()));
      const result = piQueryLogs(path, { filterTier: "long", branch: "main" });
      expect(result).toContain("tier=long");
      expect(result).toContain("branch=main");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
