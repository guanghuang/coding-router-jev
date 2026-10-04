import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, skillTargetDir } from "../src/skill-install";

const MANAGED_HEADER = "<!-- managed by coding-router-jev -->";

const SKILL_CONTENT = `${MANAGED_HEADER}\n---\nname: jev-logs\n---\n# test skill content\n`;

describe("skillTargetDir", () => {
  test("uses CODEX_HOME when set", () => {
    const dir = skillTargetDir({ CODEX_HOME: "/custom/codex" });
    expect(dir).toBe(join("/custom/codex", "skills", "jev-logs"));
  });

  test("falls back to ~/.codex when CODEX_HOME is unset", () => {
    const dir = skillTargetDir({});
    expect(dir).toContain(".codex");
    expect(dir).toContain("jev-logs");
  });

  test("ignores empty CODEX_HOME", () => {
    const dir = skillTargetDir({ CODEX_HOME: "  " });
    expect(dir).toContain(".codex");
  });
});

describe("installSkill", () => {
  test("installs skill to target directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-skill-test-"));
    try {
      const result = installSkill({
        env: { CODEX_HOME: dir },
        content: SKILL_CONTENT,
        silent: true,
      });
      expect(result.installed).toBe(true);
      expect(result.reason).toBe("installed");
      const written = readFileSync(result.path, "utf-8");
      expect(written).toBe(SKILL_CONTENT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips when content matches (idempotent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-skill-test-"));
    try {
      const first = installSkill({
        env: { CODEX_HOME: dir },
        content: SKILL_CONTENT,
        silent: true,
      });
      expect(first.installed).toBe(true);

      const second = installSkill({
        env: { CODEX_HOME: dir },
        content: SKILL_CONTENT,
        silent: true,
      });
      expect(second.installed).toBe(false);
      expect(second.reason).toBe("up-to-date");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("updates when content changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-skill-test-"));
    try {
      installSkill({
        env: { CODEX_HOME: dir },
        content: SKILL_CONTENT,
        silent: true,
      });

      const updatedContent = `${MANAGED_HEADER}\n---\nname: jev-logs\n---\n# updated content\n`;
      const result = installSkill({
        env: { CODEX_HOME: dir },
        content: updatedContent,
        silent: true,
      });
      expect(result.installed).toBe(true);
      expect(readFileSync(result.path, "utf-8")).toBe(updatedContent);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves user-modified files (no managed header)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-skill-test-"));
    try {
      const targetDir = join(dir, "skills", "jev-logs");
      mkdirSync(targetDir, { recursive: true });
      const targetPath = join(targetDir, "SKILL.md");
      writeFileSync(targetPath, "# My custom skill\nUser modified content\n");

      const result = installSkill({
        env: { CODEX_HOME: dir },
        content: SKILL_CONTENT,
        silent: true,
      });
      expect(result.installed).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("user-modified");
      expect(readFileSync(targetPath, "utf-8")).toContain("custom skill");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("opt-out via CODING_ROUTER_JEV_LOGS_SKILL_INSTALL=false", async () => {
    for (const value of ["false", "0", "no", "False", "NO"]) {
      const result = installSkill({
        env: { CODING_ROUTER_JEV_LOGS_SKILL_INSTALL: value },
        content: SKILL_CONTENT,
        silent: true,
      });
      expect(result.installed).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("opt-out");
    }
  });

  test("non-opt-out values allow installation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-skill-test-"));
    try {
      const result = installSkill({
        env: { CODEX_HOME: dir, CODING_ROUTER_JEV_LOGS_SKILL_INSTALL: "true" },
        content: SKILL_CONTENT,
        silent: true,
      });
      expect(result.installed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates nested directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-skill-test-"));
    try {
      const nested = join(dir, "deep", "nested", "codex");
      const result = installSkill({
        env: { CODEX_HOME: nested },
        content: SKILL_CONTENT,
        silent: true,
      });
      expect(result.installed).toBe(true);
      expect(existsSync(result.path)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
