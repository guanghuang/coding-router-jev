import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const PLUGIN_NAME = "claude-jev";
const SKILL_NAME = "jev-logs";
const MANAGED_HEADER = "<!-- managed by coding-router-jev -->";

export type ClaudePluginOptions = {
  /** Path to the jev-logs executable or bun script */
  jevLogsPath: string;
  /** Active session log path (JEV_SESSION_LOG) */
  sessionLogPath: string;
  /** Environment variables for opt-out checks */
  env?: Record<string, string | undefined>;
  /** Parent directory for temporary plugin files (default: os tmpdir) */
  tmpBase?: string;
};

export type ClaudePluginResult = {
  /** Path to the generated plugin directory */
  pluginDir: string;
  /** Cleanup function to remove temporary files */
  cleanup: () => void;
  /** Whether generation was skipped (opt-out) */
  skipped: boolean;
  /** Reason for skip if applicable */
  reason?: string;
};

/**
 * Shell-quote a path for use in skill SKILL.md shell commands.
 * Wraps in single quotes with proper escaping for Unix shells.
 */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Generate the Claude plugin SKILL.md content for jev-logs.
 * Uses the jev-logs binary/script path and session log path.
 */
export function generateSkillContent(jevLogsPath: string, sessionLogPath: string): string {
  const quotedBin = shellQuote(jevLogsPath);
  const quotedLog = shellQuote(sessionLogPath);

  return `${MANAGED_HEADER}
---
name: ${SKILL_NAME}
description: >-
  Query active Claude JEV routing session logs. Shows routing decisions,
  model/tier selections, effort levels, and cache observations for the
  current Claude session.
---

# jev-logs

Query the active Claude JEV routing session's routing log. Responds to
questions like "show the last log", "show the last 3 decisions", and
"what model was used for the last turn".

## When to use

Use this skill when the user asks about:
- Recent routing decisions or logs
- Which model or tier was selected
- Reasoning effort levels
- Cache hit/miss observations
- Routing confidence or decision reasons

## How it works

The launcher sets the session log path at startup. Run the query helper
to search only the current session's routing decisions.

## Commands

### Show the last log entry
\`\`\`sh
${quotedBin} ${quotedLog} --last 1
\`\`\`

### Show the last N log entries
\`\`\`sh
${quotedBin} ${quotedLog} --last N
\`\`\`

### Filter by tier
\`\`\`sh
${quotedBin} ${quotedLog} --last 10 --filter-tier fast
\`\`\`

### Filter by model
\`\`\`sh
${quotedBin} ${quotedLog} --last 10 --filter-model claude-sonnet
\`\`\`

### Filter by decision reason
\`\`\`sh
${quotedBin} ${quotedLog} --last 10 --filter-decision jev
\`\`\`

### Filter by keyword in prompt
\`\`\`sh
${quotedBin} ${quotedLog} --last 10 --filter-keyword "debug"
\`\`\`

### Filter by date
\`\`\`sh
${quotedBin} ${quotedLog} --last 10 --filter-date 2026-10-04
\`\`\`

### Show full details (including full prompt)
\`\`\`sh
${quotedBin} ${quotedLog} --last 1 --detail
\`\`\`

## Output format

Default output is a concise human-readable summary with:
- Timestamp
- Prompt preview (truncated to 120 characters)
- Tier, model, effort, decision reason, confidence
- JEV usage tokens (when available)
- Cache observations (when available)

Use \`--detail\` to include the full prompt text and JEV latency.

## Native invocation

This skill is delivered as the \`${PLUGIN_NAME}\` plugin.
Use \`/${PLUGIN_NAME}:${SKILL_NAME}\` to invoke it explicitly.

## Privacy

- Only the active session log is searched; other sessions are never accessed.
- Full prompt text is shown only with \`--detail\`.
- API keys and authorization headers are never present in logs.

## Troubleshooting

- "No active session log found": The router has not started or the
  session was not launched through claude-jev.
- "The session log is empty": No routing decisions yet in this session.
- Empty filter results: Try broader filters or check available tiers/models.
`;
}

/**
 * Generate the plugin.json manifest for Claude's --plugin-dir mechanism.
 */
export function generatePluginManifest(): string {
  return JSON.stringify(
    {
      name: PLUGIN_NAME,
      skills: [`skills/${SKILL_NAME}`],
    },
    null,
    2,
  ) + "\n";
}

/**
 * Generate a session-local Claude plugin directory with jev-logs skill.
 * The plugin is delivered via Claude's --plugin-dir mechanism and is not
 * installed globally.
 *
 * Returns the plugin directory path and a cleanup function.
 */
export function generateClaudePlugin(options: ClaudePluginOptions): ClaudePluginResult {
  const env = options.env ?? process.env;

  const optOut = env.CODING_ROUTER_JEV_LOGS_SKILL_INSTALL?.trim()?.toLowerCase();
  if (optOut === "false" || optOut === "0" || optOut === "no") {
    return {
      pluginDir: "",
      cleanup: () => {},
      skipped: true,
      reason: "opt-out",
    };
  }

  const tmpBase = options.tmpBase ?? tmpdir();
  const pluginDir = join(tmpBase, `claude-jev-plugin-${process.pid}-${randomUUID().slice(0, 8)}`);

  const pluginMetaDir = join(pluginDir, ".claude-plugin");
  const skillDir = join(pluginDir, "skills", SKILL_NAME);

  mkdirSync(pluginMetaDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });

  writeFileSync(
    join(pluginMetaDir, "plugin.json"),
    generatePluginManifest(),
    { mode: 0o644 },
  );

  writeFileSync(
    join(skillDir, "SKILL.md"),
    generateSkillContent(options.jevLogsPath, options.sessionLogPath),
    { mode: 0o644 },
  );

  const cleanup = () => {
    try {
      rmSync(pluginDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  };

  return { pluginDir, cleanup, skipped: false };
}

/**
 * Resolve the jev-logs executable path.
 * Prefers the compiled binary at dist/jev-logs, falls back to bun src/jev-logs.ts.
 */
export function resolveJevLogsPath(projectRoot?: string): string {
  if (projectRoot) {
    const compiled = join(projectRoot, "dist", "jev-logs");
    if (existsSync(compiled)) return compiled;
    const src = join(projectRoot, "src", "jev-logs.ts");
    if (existsSync(src)) return src;
  }

  // Check if running as a compiled binary
  const selfDir = dirname(process.execPath);
  const siblingBin = join(selfDir, "jev-logs");
  if (existsSync(siblingBin)) return siblingBin;

  return "jev-logs";
}

/**
 * Add --plugin-dir to Claude CLI args, preserving any existing --plugin-dir flags.
 */
export function addPluginDirArg(args: string[], pluginDir: string): string[] {
  return ["--plugin-dir", pluginDir, ...args];
}
