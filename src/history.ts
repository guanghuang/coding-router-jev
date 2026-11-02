import { appendFileSync, mkdirSync, chmodSync, readdirSync, lstatSync, unlinkSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SensitivityAnswers } from "./router";
import { hasActiveLogLease, tryLogLock } from "./log-lock";

export const DEFAULT_LOG_DIR = join(tmpdir(), "coding-router-jev");

export const REDACTED = "[redacted: sensitive or unclassified content]";
export const REDACTED_ERROR = "[routing error]";

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
    let release: (() => void) | undefined;
    try {
      const candidate = lstatSync(filePath);
      if (!candidate.isFile() || candidate.mtimeMs >= cutoff) continue;
      release = tryLogLock(filePath);
      if (!release) continue;
      const info = lstatSync(filePath);
      if (!info.isFile()) continue;
      if (info.mtimeMs < cutoff && !hasActiveLogLease(filePath)) unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[Jev] could not remove stale log ${entry}: ${(error as Error).message}`);
    } finally {
      release?.();
    }
  }
}

function isNotSensitive(answer: { type?: string; choice?: string; confidence?: number } | undefined, minConfidence: number): boolean {
  if (!answer) return false;
  return answer.type === "choice"
    && answer.choice === "not_sensitive"
    && typeof answer.confidence === "number"
    && Number.isFinite(answer.confidence)
    && answer.confidence >= minConfidence
    && answer.confidence <= 1;
}

export function sanitizeRecord(
  record: Record<string, any>,
  classification: SensitivityAnswers | undefined,
  minConfidence: number,
): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(record));

  if (!isNotSensitive(classification?.current_message_sensitive, minConfidence)) {
    if (copy.prompt !== undefined) copy.prompt = REDACTED;
    if (copy.jev?.request?.state?.request !== undefined) copy.jev.request.state.request = REDACTED;
  }

  if (copy.jev?.request?.state?.recent_context?.previous_user_request !== undefined) {
    if (!isNotSensitive(classification?.previous_user_message_sensitive, minConfidence)) {
      copy.jev.request.state.recent_context.previous_user_request = REDACTED;
    }
  }

  if (copy.jev?.request?.state?.recent_context?.previous_assistant_excerpt !== undefined) {
    if (!isNotSensitive(classification?.previous_assistant_response_sensitive, minConfidence)) {
      copy.jev.request.state.recent_context.previous_assistant_excerpt = REDACTED;
    }
  }

  if (copy.jev?.error !== undefined) {
    copy.jev.error = REDACTED_ERROR;
  }

  return copy;
}

export function sessionHistory(session: string, directory = DEFAULT_LOG_DIR, agent: AgentPrefix = "codex", enabled = true) {
  if (!SUPPORTED_PREFIXES.has(agent)) {
    throw new Error(`Unsupported agent prefix: ${agent}. Supported: ${[...SUPPORTED_PREFIXES].join(", ")}`);
  }
  if (enabled) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const path = join(directory, `jev-${session.replace(/[^\w-]/g, "")}.jsonl`);
  return {
    path,
    update(id: string, update: (record: Record<string, any>) => Record<string, any>) {
      if (!enabled) return;
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
    append(record: unknown, classification?: SensitivityAnswers, minConfidence?: number) {
      if (!enabled) return;
      try {
        const toWrite = minConfidence !== undefined ? sanitizeRecord(record as Record<string, any>, classification, minConfidence) : record;
        appendFileSync(path, `${JSON.stringify(toWrite)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      } catch { console.error("[Jev] could not write routing history"); }
    },
  };
}
