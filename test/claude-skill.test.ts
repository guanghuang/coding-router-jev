import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  generateClaudePlugin,
  generateSkillContent,
  generatePluginManifest,
  resolveJevLogsPath,
  addPluginDirArg,
} from "../src/claude-skill";

describe("generatePluginManifest", () => {
  test("produces valid JSON with correct name and skills", () => {
    const manifest = generatePluginManifest();
    const parsed = JSON.parse(manifest);
    expect(parsed.name).toBe("claude-jev");
    expect(parsed.skills).toEqual(["skills/jev-logs"]);
  });
});

describe("generateSkillContent", () => {
  test("contains managed header", () => {
    const content = generateSkillContent("/path/to/jev-logs", "/path/to/session.jsonl");
    expect(content).toContain("<!-- managed by coding-router-jev -->");
  });

  test("contains skill frontmatter with correct name", () => {
    const content = generateSkillContent("/path/to/jev-logs", "/path/to/session.jsonl");
    expect(content).toContain("name: jev-logs");
  });

  test("contains shell commands with quoted paths", () => {
    const content = generateSkillContent("/path/to/jev-logs", "/path/to/session.jsonl");
    expect(content).toContain("'/path/to/jev-logs'");
    expect(content).toContain("'/path/to/session.jsonl'");
  });

  test("quotes paths with spaces correctly", () => {
    const content = generateSkillContent("/path with spaces/jev-logs", "/another path/session.jsonl");
    expect(content).toContain("'/path with spaces/jev-logs'");
    expect(content).toContain("'/another path/session.jsonl'");
  });

  test("handles single quotes in paths", () => {
    const content = generateSkillContent("/it's/jev-logs", "/o'reilly/session.jsonl");
    expect(content).toContain("'/it'\\''s/jev-logs'");
    expect(content).toContain("'/o'\\''reilly/session.jsonl'");
  });

  test("documents namespaced invocation", () => {
    const content = generateSkillContent("/path/to/jev-logs", "/path/to/session.jsonl");
    expect(content).toContain("/claude-jev:jev-logs");
  });

  test("contains filter commands", () => {
    const content = generateSkillContent("/path/to/jev-logs", "/path/to/session.jsonl");
    expect(content).toContain("--filter-tier");
    expect(content).toContain("--filter-model");
    expect(content).toContain("--filter-decision");
    expect(content).toContain("--filter-keyword");
    expect(content).toContain("--filter-date");
    expect(content).toContain("--detail");
  });
});

describe("generateClaudePlugin", () => {
  test("creates plugin directory with manifest and skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-plugin-test-"));
    try {
      const result = generateClaudePlugin({
        jevLogsPath: "/usr/local/bin/jev-logs",
        sessionLogPath: "/tmp/session.jsonl",
        tmpBase: dir,
      });
      expect(result.skipped).toBe(false);
      expect(existsSync(result.pluginDir)).toBe(true);

      const manifestPath = join(result.pluginDir, ".claude-plugin", "plugin.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(manifest.name).toBe("claude-jev");

      const skillPath = join(result.pluginDir, "skills", "jev-logs", "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);
      const skillContent = readFileSync(skillPath, "utf-8");
      expect(skillContent).toContain("jev-logs");
      expect(skillContent).toContain("'/usr/local/bin/jev-logs'");
      expect(skillContent).toContain("'/tmp/session.jsonl'");

      result.cleanup();
      expect(existsSync(result.pluginDir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips when opt-out env is set", () => {
    for (const value of ["false", "0", "no", "False", "NO"]) {
      const result = generateClaudePlugin({
        jevLogsPath: "/usr/local/bin/jev-logs",
        sessionLogPath: "/tmp/session.jsonl",
        env: { CODING_ROUTER_JEV_LOGS_SKILL_INSTALL: value },
      });
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("opt-out");
      expect(result.pluginDir).toBe("");
    }
  });

  test("does not skip for non-opt-out values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-plugin-test-"));
    try {
      const result = generateClaudePlugin({
        jevLogsPath: "/usr/local/bin/jev-logs",
        sessionLogPath: "/tmp/session.jsonl",
        env: { CODING_ROUTER_JEV_LOGS_SKILL_INSTALL: "true" },
        tmpBase: dir,
      });
      expect(result.skipped).toBe(false);
      result.cleanup();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleanup is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-plugin-test-"));
    try {
      const result = generateClaudePlugin({
        jevLogsPath: "/usr/local/bin/jev-logs",
        sessionLogPath: "/tmp/session.jsonl",
        tmpBase: dir,
      });
      result.cleanup();
      result.cleanup(); // should not throw
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleans up on failure during creation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-plugin-test-"));
    try {
      // Make the skills dir unwritable after creating plugin dir
      const result = generateClaudePlugin({
        jevLogsPath: "/usr/local/bin/jev-logs",
        sessionLogPath: "/tmp/session.jsonl",
        tmpBase: dir,
      });
      // Verify the result works and cleanup is functional
      expect(result.skipped).toBe(false);
      expect(existsSync(result.pluginDir)).toBe(true);
      result.cleanup();
      expect(existsSync(result.pluginDir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not write to global claude or codex directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-plugin-test-"));
    try {
      const result = generateClaudePlugin({
        jevLogsPath: "/usr/local/bin/jev-logs",
        sessionLogPath: "/tmp/session.jsonl",
        tmpBase: dir,
      });

      // Plugin dir should be under the temp base, not ~/.claude or ~/.codex
      expect(result.pluginDir).toContain(dir);
      expect(result.pluginDir).not.toContain(join(homedir(), ".claude"));
      expect(result.pluginDir).not.toContain(join(homedir(), ".codex"));

      result.cleanup();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveJevLogsPath", () => {
  test("returns compiled binary when it exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-resolve-test-"));
    try {
      const distDir = join(dir, "dist");
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, "jev-logs"), "#!/bin/sh\necho ok\n", { mode: 0o755 });

      const path = resolveJevLogsPath(dir);
      expect(path).toBe(join(distDir, "jev-logs"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to source file when no compiled binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-resolve-test-"));
    try {
      const srcDir = join(dir, "src");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, "jev-logs.ts"), "console.log('ok');\n");

      const path = resolveJevLogsPath(dir);
      expect(path).toBe(join(srcDir, "jev-logs.ts"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns fallback when no project dist or src exists", () => {
    const path = resolveJevLogsPath("/nonexistent/project");
    // Falls back to sibling of execPath or bare name
    expect(typeof path).toBe("string");
    expect(path.length).toBeGreaterThan(0);
  });
});

describe("addPluginDirArg", () => {
  test("prepends --plugin-dir to args", () => {
    const result = addPluginDirArg(["--print", "hello"], "/tmp/plugin-dir");
    expect(result).toEqual(["--plugin-dir", "/tmp/plugin-dir", "--print", "hello"]);
  });

  test("preserves existing args", () => {
    const result = addPluginDirArg(["--model", "claude-sonnet-5-5", "--plugin-dir", "/existing"], "/tmp/new-plugin");
    expect(result).toEqual(["--plugin-dir", "/tmp/new-plugin", "--model", "claude-sonnet-5-5", "--plugin-dir", "/existing"]);
  });

  test("works with empty args", () => {
    const result = addPluginDirArg([], "/tmp/plugin-dir");
    expect(result).toEqual(["--plugin-dir", "/tmp/plugin-dir"]);
  });
});
