import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readdir, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleLogs } from "../src/history.ts";

async function createFile(dir: string, name: string, ageMs: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "test\n");
  const past = new Date(Date.now() - ageMs);
  const { utimesSync } = await import("node:fs");
  utimesSync(path, past, past);
  return path;
}

const DAY_MS = 86_400_000;

describe("cleanupStaleLogs", () => {
  test("deletes old session logs beyond retention period", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old-session.jsonl", 10 * DAY_MS);
      await createFile(dir, "codex-recent-session.jsonl", 1 * DAY_MS);

      cleanupStaleLogs(dir, 5);

      const remaining = await readdir(dir);
      expect(remaining).toEqual(["codex-recent-session.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves recent files within retention period", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-a.jsonl", 2 * DAY_MS);
      await createFile(dir, "codex-b.jsonl", 3 * DAY_MS);

      cleanupStaleLogs(dir, 5);

      const remaining = await readdir(dir);
      expect(remaining.sort()).toEqual(["codex-a.jsonl", "codex-b.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores unrelated files and directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old.jsonl", 10 * DAY_MS);
      await createFile(dir, "other-file.txt", 10 * DAY_MS);
      await createFile(dir, "notes.jsonl", 10 * DAY_MS);
      await mkdir(join(dir, "codex-subdir.jsonl"));

      cleanupStaleLogs(dir, 5);

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["codex-subdir.jsonl", "notes.jsonl", "other-file.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no-ops when directory does not exist", () => {
    expect(() => cleanupStaleLogs("/nonexistent/path/jev-test", 5)).not.toThrow();
  });

  test("no-ops when directory is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      expect(() => cleanupStaleLogs(dir, 5)).not.toThrow();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("continues when individual file deletion fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-a.jsonl", 10 * DAY_MS);
      await createFile(dir, "codex-b.jsonl", 10 * DAY_MS);
      await createFile(dir, "codex-c.jsonl", 10 * DAY_MS);

      await chmod(join(dir, "codex-b.jsonl"), 0o000);
      await chmod(dir, 0o500);

      try {
        cleanupStaleLogs(dir, 5);
      } catch {
        // Should not throw
      }

      await chmod(dir, 0o700);
      const remaining = await readdir(dir);
      expect(remaining).toContain("codex-b.jsonl");
    } finally {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
