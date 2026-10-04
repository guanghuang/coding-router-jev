import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStatusLine,
  writeStatusFile,
  updateStatusLine,
  removeStatusFile,
} from "../src/claude-status";
import type { FeedbackValues } from "../src/feedback";

function makeFeedbackValues(overrides: Partial<FeedbackValues> = {}): FeedbackValues {
  return {
    tier: "balanced",
    model: "claude-sonnet-4-20250514",
    effort: "medium",
    decision: "jev",
    confidence: 0.85,
    previous_model: "claude-haiku-4-5-20251001",
    cache_read: 1024,
    cache_write: 512,
    jev_tokens_input: 100,
    jev_tokens_output: 50,
    ...overrides,
  };
}

describe("buildStatusLine", () => {
  test("uses default format from feedback module", () => {
    const line = buildStatusLine(makeFeedbackValues());
    expect(line).toContain("balanced");
    expect(line).toContain("claude-sonnet-4-20250514");
    expect(line).toContain("medium");
    expect(line).toContain("[Jev]");
  });

  test("uses custom format", () => {
    const line = buildStatusLine(makeFeedbackValues(), "{model} ({tier})");
    expect(line).toBe("claude-sonnet-4-20250514 (balanced)");
  });

  test("handles missing effort", () => {
    const line = buildStatusLine(makeFeedbackValues({ effort: undefined }));
    expect(line).toContain("default");
    expect(line).not.toContain("undefined");
  });
});

describe("writeStatusFile", () => {
  test("creates settings.json in the target directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      const settingsDir = join(dir, "status");
      const path = writeStatusFile("[Jev] test status", settingsDir);
      expect(existsSync(path)).toBe(true);
      const data = JSON.parse(readFileSync(path, "utf-8"));
      expect(data.status_line).toBe("[Jev] test status");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("overwrites existing file without user_status_line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      writeStatusFile("first", dir);
      writeStatusFile("second", dir);
      const data = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
      expect(data.status_line).toBe("second");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves existing user_status_line when preserveExisting is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ user_status_line: "my custom status" }));

      const path = writeStatusFile("new status", dir, { preserveExisting: true });
      expect(path).toBe(settingsPath);

      const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(data.user_status_line).toBe("my custom status");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes over corrupt JSON with preserveExisting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, "not valid json{{{");

      writeStatusFile("recovered", dir, { preserveExisting: true });
      const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(data.status_line).toBe("recovered");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("updateStatusLine", () => {
  test("updates existing settings file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      const path = writeStatusFile("original", dir);
      const updated = updateStatusLine("updated", path);
      expect(updated).toBe(true);
      const data = JSON.parse(readFileSync(path, "utf-8"));
      expect(data.status_line).toBe("updated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false for missing file", () => {
    expect(updateStatusLine("test", "/nonexistent/settings.json")).toBe(false);
  });

  test("returns false for corrupt JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, "corrupt {{{ json");
      const updated = updateStatusLine("new", path);
      expect(updated).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false when user_status_line exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, JSON.stringify({ user_status_line: "custom", status_line: "old" }));
      const updated = updateStatusLine("new", path);
      expect(updated).toBe(false);
      const data = JSON.parse(readFileSync(path, "utf-8"));
      expect(data.status_line).toBe("old");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("removeStatusFile", () => {
  test("removes existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      const path = writeStatusFile("test", dir);
      expect(existsSync(path)).toBe(true);
      removeStatusFile(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not throw for missing file", () => {
    expect(() => removeStatusFile("/nonexistent/settings.json")).not.toThrow();
  });

  test("is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-status-test-"));
    try {
      const path = writeStatusFile("test", dir);
      removeStatusFile(path);
      removeStatusFile(path); // should not throw
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
