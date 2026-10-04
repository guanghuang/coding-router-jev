import { appendFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
