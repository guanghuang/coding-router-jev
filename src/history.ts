import { appendFileSync, mkdirSync, chmodSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SESSION_LOG_PATTERN = /^codex-.+\.jsonl$/;

export function cleanupStaleLogs(directory: string, retentionDays: number): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const entry of entries) {
    if (!SESSION_LOG_PATTERN.test(entry)) continue;
    const filePath = join(directory, entry);
    try {
      const info = statSync(filePath);
      if (!info.isFile()) continue;
      if (info.mtimeMs < cutoff) unlinkSync(filePath);
    } catch {
      console.error(`[Jev] could not remove stale log: ${entry}`);
    }
  }
}

export function sessionHistory(session: string, directory = join(tmpdir(), "coding-router-jev")) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `codex-${session.replace(/[^\w-]/g, "")}.jsonl`);
  return {
    path,
    append(record: unknown) {
      try {
        appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      } catch { console.error("[Jev] could not write routing history"); }
    },
  };
}
