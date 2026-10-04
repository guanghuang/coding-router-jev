import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { formatFeedback, type FeedbackValues } from "./feedback";

/**
 * Build a concise status-line string for Claude's native statusLine display.
 * Uses the shared feedback template renderer.
 */
export function buildStatusLine(values: FeedbackValues, format?: string): string {
  return formatFeedback(format, values);
}

/**
 * Write a Claude settings JSON file that sets the statusLine.
 * Returns the path written. If `preserveExisting` is set and the user
 * already has a `user_status_line`, writes still succeed but no replacement
 * occurs — the existing value is kept.
 *
 * The file is written to `dir/settings.json` as a launch-local temporary
 * config (not the user's global ~/.claude/settings.json).
 */
export function writeStatusFile(
  statusLine: string,
  dir: string,
  options: { preserveExisting?: boolean } = {},
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settingsPath = join(dir, "settings.json");

  if (options.preserveExisting && existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (existing.user_status_line) return settingsPath;
    } catch { /* proceed to write */ }
  }

  const settings = { status_line: statusLine };
  const tmp = settingsPath + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, settingsPath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  }
  return settingsPath;
}

/**
 * Update the status line in an existing settings file.
 * Returns true if updated, false if file doesn't exist or has user_status_line.
 */
export function updateStatusLine(statusLine: string, settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  try {
    const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (existing.user_status_line) return false;
    existing.status_line = statusLine;
    const tmp = settingsPath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, settingsPath);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a status file if it exists. For cleanup on launcher exit.
 */
export function removeStatusFile(settingsPath: string): void {
  try { unlinkSync(settingsPath); } catch { /* already gone */ }
}
