import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const SKILL_NAME = "jev-logs";
const MANAGED_HEADER = "<!-- managed by coding-router-jev -->";

export function skillContent(): string {
  const bundledPath = resolve(join(dirname(import.meta.dir ?? __dirname), "skills", SKILL_NAME, "SKILL.md"));
  try {
    return readFileSync(bundledPath, "utf-8");
  } catch {
    return EMBEDDED_SKILL;
  }
}

export function skillTargetDir(env: Record<string, string | undefined> = process.env): string {
  const codexHome = env.CODEX_HOME?.trim();
  const base = codexHome || join(homedir(), ".codex");
  return join(base, "skills", SKILL_NAME);
}

export function installSkill(options: {
  env?: Record<string, string | undefined>;
  content?: string;
  silent?: boolean;
} = {}): { installed: boolean; skipped: boolean; path: string; reason: string } {
  const env = options.env ?? process.env;

  const optOut = env.CODING_ROUTER_JEV_LOGS_SKILL_INSTALL?.trim()?.toLowerCase();
  if (optOut === "false" || optOut === "0" || optOut === "no") {
    return { installed: false, skipped: true, path: "", reason: "opt-out" };
  }

  const content = options.content ?? skillContent();
  const targetDir = skillTargetDir(env);
  const targetPath = join(targetDir, "SKILL.md");

  try {
    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath, "utf-8");
      if (!existing.includes(MANAGED_HEADER)) {
        return { installed: false, skipped: true, path: targetPath, reason: "user-modified" };
      }
      if (existing === content) {
        return { installed: false, skipped: false, path: targetPath, reason: "up-to-date" };
      }
    }

    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetPath, content, { mode: 0o644 });
    if (!options.silent) {
      console.error(`[Jev] installed skill '${SKILL_NAME}' at ${targetPath}`);
    }
    return { installed: true, skipped: false, path: targetPath, reason: "installed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (!options.silent) {
      console.error(`[Jev] could not install skill '${SKILL_NAME}': ${message}`);
    }
    return { installed: false, skipped: false, path: targetPath, reason: `error: ${message}` };
  }
}

const EMBEDDED_SKILL = [
  MANAGED_HEADER,
  "---",
  "name: jev-logs",
  "description: >-",
  "  Query active Coding Router Jev session logs. Shows routing decisions,",
  "  model/tier selections, effort levels, and cache observations for the",
  "  current codex-jev session.",
  "---",
  "",
  "# jev-logs",
  "",
  "Query the active Coding Router Jev session's routing log. Responds to",
  'questions like "show the last log", "show the last 3 decisions", and',
  '"what model was used for the last turn".',
  "",
  "## When to use",
  "",
  "Use this skill when the user asks about:",
  "- Recent routing decisions or logs",
  "- Which model or tier was selected",
  "- Reasoning effort levels",
  "- Cache hit/miss observations",
  "- Routing confidence or decision reasons",
  "",
  "## How it works",
  "",
  "The launcher sets `JEV_SESSION_LOG` to the active session's JSONL path.",
  "Run the query helper with that path to search only the current session.",
  "",
  "## Commands",
  "",
  "### Show the last log entry",
  "```sh",
  'jev-logs "$JEV_SESSION_LOG" --last 1',
  "```",
  "",
  "### Show the last N log entries",
  "```sh",
  'jev-logs "$JEV_SESSION_LOG" --last N',
  "```",
  "",
  "### Filter by tier",
  "```sh",
  'jev-logs "$JEV_SESSION_LOG" --last 10 --filter-tier fast',
  "```",
  "",
  "### Filter by model",
  "```sh",
  'jev-logs "$JEV_SESSION_LOG" --last 10 --filter-model gpt-6-luna',
  "```",
  "",
  "### Filter by decision reason",
  "```sh",
  'jev-logs "$JEV_SESSION_LOG" --last 10 --filter-decision jev',
  "```",
  "",
  "### Filter by keyword in prompt",
  "```sh",
  'jev-logs "$JEV_SESSION_LOG" --last 10 --filter-keyword "debug"',
  "```",
  "",
  "### Filter by date",
  "```sh",
  'jev-logs "$JEV_SESSION_LOG" --last 10 --filter-date 2026-10-04',
  "```",
  "",
  "### Show full details (including full prompt)",
  "```sh",
  'jev-logs "$JEV_SESSION_LOG" --last 1 --detail',
  "```",
  "",
  "## Output format",
  "",
  "Default output is a concise human-readable summary with:",
  "- Timestamp",
  "- Prompt preview (truncated to 120 characters)",
  "- Tier, model, effort, decision reason, confidence",
  "- JEV usage tokens (when available)",
  "- Cache observations (when available)",
  "",
  "Use `--detail` to include the full prompt text and JEV latency.",
  "",
  "## Privacy",
  "",
  "- Only the active session log is searched; other sessions are never accessed.",
  "- Full prompt text is shown only with `--detail`.",
  "- API keys and authorization headers are never present in logs.",
  "",
  "## Troubleshooting",
  "",
  '- "No active session log found": The router has not started or',
  "  `JEV_SESSION_LOG` is not set.",
  '- "The session log is empty": No routing decisions yet in this session.',
  "- Empty filter results: Try broader filters or check available tiers/models.",
  "",
].join("\n");
