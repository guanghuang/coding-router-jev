import { mkdirSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupStaleLogs, sessionHistory } from "./history";
import { tryLogLock } from "./log-lock";

export function conversationHistory(directory: string, retentionDays?: number, onLog?: (key: string, path: string) => void) {
  const seen = new Set<string>();
  function pathFor(key: string) {
    if (!/^[a-f0-9]{24}$/.test(key)) throw new Error("Invalid conversation log key");
    return join(directory, `jev-codex-${key}.jsonl`);
  }
  async function locked<T>(path: string, action: () => T): Promise<T> {
    const deadline = Date.now() + 5_000;
    while (true) {
      const release = tryLogLock(path);
      if (release) { try { return action(); } finally { release(); } }
      if (Date.now() >= deadline) throw new Error("Conversation log is busy");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return {
    pathFor,
    async open(key: string) {
      const path = pathFor(key);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const lease = `${path}.active-${process.pid}-${randomUUID()}`;
      await locked(path, () => writeFileSync(lease, "", { mode: 0o600, flag: "wx" }));
      try {
        if (!seen.has(key)) {
          cleanupStaleLogs(directory, retentionDays ?? 0);
          onLog?.(key, path);
          seen.add(key);
          // Bound discovery bookkeeping in long-running shared proxies.
          if (seen.size > 1_000) seen.delete(seen.values().next().value!);
        }
        const history = sessionHistory(`codex-${key}`, directory);
        return {
          path,
          append: (...args: Parameters<typeof history.append>) => locked(path, () => history.append(...args)),
          close() { try { unlinkSync(lease); } catch { /* Already removed. */ } },
        };
      } catch (error) {
        try { unlinkSync(lease); } catch { /* Already removed. */ }
        throw error;
      }
    },
  };
}
