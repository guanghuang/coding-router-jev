import { appendFileSync, mkdirSync, chmodSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const DEFAULT_LOG_DIR = join(tmpdir(), "coding-router-jev");
const SESSION_LOG_PATTERN = /^codex-.+\.jsonl$/;

export function cleanupStaleLogs(directory: string, retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
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
    if (!SESSION_LOG_PATTERN.test(entry)) continue;
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

export function sessionHistory(session: string, directory = DEFAULT_LOG_DIR) {
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
