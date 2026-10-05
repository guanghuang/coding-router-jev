import { describe, expect, test } from "bun:test";
import { utimesSync, readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleLogs, sessionHistory } from "../src/history";

async function createFile(dir: string, name: string, ageMs: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "test\n");
  const past = new Date(Date.now() - ageMs);
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

  test("file just inside retention is preserved; file just outside is deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-inside.jsonl", 5 * DAY_MS - 60_000);
      await createFile(dir, "codex-outside.jsonl", 5 * DAY_MS + 60_000);

      cleanupStaleLogs(dir, 5);

      const remaining = await readdir(dir);
      expect(remaining).toContain("codex-inside.jsonl");
      expect(remaining).not.toContain("codex-outside.jsonl");
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

      const immutable = join(dir, "codex-b.jsonl");
      const { chattr } = await (async () => {
        try {
          const { execSync } = await import("node:child_process");
          execSync(`chattr +i "${immutable}"`, { stdio: "ignore" });
          return { chattr: true };
        } catch {
          return { chattr: false };
        }
      })();

      if (!chattr) {
        await chmod(join(dir, "codex-b.jsonl"), 0o000);
        await chmod(dir, 0o500);
      }

      cleanupStaleLogs(dir, 5);

      if (!chattr) {
        await chmod(dir, 0o700);
      } else {
        const { execSync } = await import("node:child_process");
        execSync(`chattr -i "${immutable}"`, { stdio: "ignore" });
      }

      const remaining = await readdir(dir);
      expect(remaining).toContain("codex-b.jsonl");
    } finally {
      await chmod(dir, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips cleanup for non-positive or invalid retentionDays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old.jsonl", 100 * DAY_MS);

      cleanupStaleLogs(dir, 0);
      cleanupStaleLogs(dir, -5);
      cleanupStaleLogs(dir, NaN);

      const remaining = await readdir(dir);
      expect(remaining).toEqual(["codex-old.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("pi agent cleanup deletes only pi-prefixed logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "pi-old-session.jsonl", 10 * DAY_MS);
      await createFile(dir, "pi-recent-session.jsonl", 1 * DAY_MS);
      await createFile(dir, "codex-old.jsonl", 10 * DAY_MS);

      cleanupStaleLogs(dir, 5, "pi");

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["codex-old.jsonl", "pi-recent-session.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("codex agent cleanup does not delete pi-prefixed logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old.jsonl", 10 * DAY_MS);
      await createFile(dir, "pi-old.jsonl", 10 * DAY_MS);

      cleanupStaleLogs(dir, 5, "codex");

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["pi-old.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("default agent cleanup is codex", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-cleanup-test-"));
    try {
      await createFile(dir, "codex-old.jsonl", 10 * DAY_MS);
      await createFile(dir, "pi-old.jsonl", 10 * DAY_MS);

      cleanupStaleLogs(dir, 5);

      const remaining = (await readdir(dir)).sort();
      expect(remaining).toEqual(["pi-old.jsonl"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sessionHistory", () => {
  test("startup cleanup recognizes unified logs for every agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-history-test-"));
    try {
      for (const agent of ["codex", "pi", "claude"] as const) {
        await createFile(dir, "jev-old.jsonl", 10 * DAY_MS);
        await createFile(dir, "jev-recent.jsonl", DAY_MS);
        cleanupStaleLogs(dir, 5, agent);
        expect(existsSync(join(dir, "jev-old.jsonl"))).toBe(false);
        expect(existsSync(join(dir, "jev-recent.jsonl"))).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("creates unified log file for Pi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-history-test-"));
    try {
      const hist = sessionHistory("test-session", dir, "pi");
      expect(hist.path).toContain("jev-test-session.jsonl");
      hist.append({ id: "test" });
      const content = readFileSync(hist.path, "utf-8");
      expect(content).toContain('"id":"test"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates unified log file by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-history-test-"));
    try {
      const hist = sessionHistory("test-session", dir);
      expect(hist.path).toContain("jev-test-session.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects unsupported agent prefix", () => {
    expect(() => sessionHistory("test", undefined, "other" as any)).toThrow("Unsupported agent prefix");
  });

  test("sanitizes session id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-history-test-"));
    try {
      const hist = sessionHistory("../../../etc/passwd", dir, "pi");
      expect(hist.path).not.toContain("..");
      expect(hist.path).toContain("jev-etcpasswd.jsonl");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
