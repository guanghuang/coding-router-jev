import { closeSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Shared by conversation writers and retention cleanup on the same host. */
export function tryLogLock(path: string): (() => void) | undefined {
  const lock = `${path}.lock`;
  try {
    const fd = openSync(lock, "wx", 0o600);
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
    return () => { unlinkSync(lock); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Fail closed: reclaiming a stale lock could unlink a new writer's lock.
    return undefined;
  }
}

export function hasActiveLogLease(path: string): boolean {
  const directory = dirname(path);
  const prefix = `${basename(path)}.active-`;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number(entry.slice(prefix.length).split("-")[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid)) return true;
    try { unlinkSync(join(directory, entry)); } catch { /* Already removed. */ }
  }
  return false;
}
