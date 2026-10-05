import { appendFileSync, mkdirSync, chmodSync, readdirSync, lstatSync, unlinkSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const DEFAULT_LOG_DIR = join(tmpdir(), "coding-router-jev");

export type AgentPrefix = "codex" | "pi" | "claude";
const SUPPORTED_PREFIXES: ReadonlySet<AgentPrefix> = new Set<AgentPrefix>(["codex", "pi", "claude"]);

const AGENT_LOG_PATTERNS: Record<AgentPrefix, RegExp> = {
  codex: /^codex-.+\.jsonl$/,
  pi: /^pi-.+\.jsonl$/,
  claude: /^claude-.+\.jsonl$/,
};

export function cleanupStaleLogs(directory: string, retentionDays: number, agent: AgentPrefix = "codex"): void {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
  if (!SUPPORTED_PREFIXES.has(agent)) {
    console.error(`[Jev] unsupported agent prefix for cleanup: ${agent}`);
    return;
  }
  const pattern = AGENT_LOG_PATTERNS[agent];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[Jev] could not read log directory for cleanup: ${(error as Error).message}`);
    }
    return;
  }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const entry of entries) {
    if (!/^jev-.+\.jsonl$/.test(entry) && !pattern.test(entry)) continue;
    const filePath = join(directory, entry);
    try {
      const info = lstatSync(filePath);
      if (!info.isFile()) continue;
      if (info.mtimeMs < cutoff) unlinkSync(filePath);
    } catch (error) {
      console.error(`[Jev] could not remove stale log ${entry}: ${(error as Error).message}`);
    }
  }
}

export function sessionHistory(session: string, directory = DEFAULT_LOG_DIR, agent: AgentPrefix = "codex") {
  if (!SUPPORTED_PREFIXES.has(agent)) {
    throw new Error(`Unsupported agent prefix: ${agent}. Supported: ${[...SUPPORTED_PREFIXES].join(", ")}`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `jev-${session.replace(/[^\w-]/g, "")}.jsonl`);
  return {
    path,
    update(id: string, update: (record: Record<string, any>) => Record<string, any>) {
      const temporary = `${path}.tmp`;
      try {
        // ponytail: rewrite this session's log; use an indexed store if session logs become large.
        const lines = readFileSync(path, "utf-8").trimEnd().split("\n");
        let found = false;
        const output = lines.map(line => {
          const record = JSON.parse(line);
          if (record.id !== id) return line;
          found = true;
          return JSON.stringify(update(record));
        });
        if (!found) return;
        writeFileSync(temporary, `${output.join("\n")}\n`, { mode: 0o600 });
        renameSync(temporary, path);
      } catch {
        try { unlinkSync(temporary); } catch {}
        console.error("[Jev] could not update routing history");
      }
    },
    append(record: unknown) {
      try {
        appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      } catch { console.error("[Jev] could not write routing history"); }
    },
  };
}
