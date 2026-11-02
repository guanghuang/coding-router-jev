import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { conversationHistory } from "../src/conversation-history";
import { cleanupStaleLogs, sessionHistory } from "../src/history";
import { configFromEnv } from "../src/config";
import { queryLogs } from "../src/jev-logs";
import { AUTO_MODEL, startProxy } from "../src/proxy";
import { buildRequest } from "../src/router";
import { tryLogLock } from "../src/log-lock";

const a = "a".repeat(24), b = "b".repeat(24), c = "c".repeat(24);
const old = new Date(Date.now() - 10 * 86_400_000);

test("standalone proxy isolates parallel chats, resumes files, and skips all writes when disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-server-"));
  const config = configFromEnv({ CODING_ROUTER_FAST_MODEL_CODEX: "luna", CODING_ROUTER_BALANCED_MODEL_CODEX: "terra", CODING_ROUTER_STRONG_MODEL_CODEX: "sol" });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
  const options = {
    apiBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: dir, conversationLogs: true,
    route: async (input: Parameters<typeof buildRequest>[0]) => ({ request: buildRequest(input), response: null, ms: 1 }),
  };
  let proxy = startProxy(config, options);
  const send = (conversation: string, text: string) => fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: AUTO_MODEL, prompt_cache_key: conversation, input: [{ role: "user", content: text }] }),
  }).then(response => response.text());
  try {
    await Promise.all([send("first-chat", "hi"), send("second-chat", "hello")]);
    const paths = readdirSync(dir);
    expect(paths).toHaveLength(2);
    expect(paths.every(path => /^jev-codex-[a-f0-9]{24}\.jsonl$/.test(path))).toBe(true);
    expect(paths.every(path => JSON.parse(readFileSync(join(dir, path), "utf8")).prompt === "[redacted: sensitive or unclassified content]")).toBe(true);
    proxy.close(); proxy = startProxy(config, options);
    await send("first-chat", "hi again");
    expect(readdirSync(dir).sort()).toEqual(paths.sort());
    expect(paths.map(path => readFileSync(join(dir, path), "utf8").trim().split("\n").length).sort()).toEqual([1, 2]);
    const before = paths.map(path => readFileSync(join(dir, path), "utf8"));
    proxy.close(); proxy = startProxy({ ...config, logEnabled: false }, options);
    await send("first-chat", "not logged"); await send("new-chat", "also not logged");
    expect(readdirSync(dir).sort()).toEqual(paths.sort());
    expect(paths.map(path => readFileSync(join(dir, path), "utf8"))).toEqual(before);
    proxy.close();
    const invalidDirectory = join(dir, "not-a-directory");
    writeFileSync(invalidDirectory, "occupied");
    proxy = startProxy(config, { ...options, logDirectory: invalidDirectory });
    expect(await send("still-routes", "hi")).toBe('{"ok":true}');
  } finally { proxy.close(); upstream.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("conversations use separate persistent files and existing log queries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-conversations-"));
  try {
    const history = conversationHistory(dir);
    const first = await history.open(a), second = await history.open(b);
    try {
      await Promise.all([first.append({ id: "a1", decision: { model: "luna" } }), second.append({ id: "b1", decision: { model: "sol" } })]);
    } finally { first.close(); second.close(); }
    const resumed = await conversationHistory(dir).open(a);
    try { await resumed.append({ id: "a2", decision: { model: "terra" } }); }
    finally { resumed.close(); }
    expect(readdirSync(dir).sort()).toEqual([`jev-codex-${a}.jsonl`, `jev-codex-${b}.jsonl`]);
    expect(readFileSync(first.path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(queryLogs(first.path, { last: 1 })).toContain("terra");
    expect(queryLogs(second.path, { last: 1 })).toContain("sol");
    await expect(history.open("../unsafe")).rejects.toThrow("Invalid conversation");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("new conversations clean old logs, skip active routing leases, and honor disabled retention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-retention-"));
  const history = conversationHistory(dir, 1);
  try {
    const active = await history.open(a);
    try {
      await active.append({ id: "active" });
      utimesSync(active.path, old, old);
      const stale = join(dir, `jev-codex-${b}.jsonl`);
      writeFileSync(stale, "{}\n"); utimesSync(stale, old, old);
      cleanupStaleLogs(dir, 0);
      expect(existsSync(stale)).toBe(true);
      const next = await history.open(c); next.close();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(active.path)).toBe(true);
    } finally { active.close(); }
    cleanupStaleLogs(dir, 1);
    expect(existsSync(history.pathFor(a))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("logging disabled creates no directory or JSONL and does not mutate existing logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-disabled-"));
  try {
    expect(configFromEnv({}).logEnabled).toBe(true);
    expect(configFromEnv({ CODING_ROUTER_LOG_ENABLED: "false" }).logEnabled).toBe(false);
    const destination = join(dir, "absent");
    const history = sessionHistory("disabled", destination, "codex", false);
    history.append({ id: "hidden" }); history.update("hidden", value => value);
    expect(existsSync(destination)).toBe(false);
    const existing = sessionHistory("existing", dir);
    existing.append({ id: "old" });
    const disabled = sessionHistory("existing", dir, "codex", false);
    disabled.append({ id: "new" }); disabled.update("old", () => ({}));
    expect(readFileSync(existing.path, "utf8")).toBe('{"id":"old"}\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cleanup skips another writer's exclusive lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-locked-"));
  try {
    const path = conversationHistory(dir).pathFor(a);
    writeFileSync(path, "{}\n"); utimesSync(path, old, old);
    const release = tryLogLock(path)!;
    try {
      expect(tryLogLock(path)).toBeUndefined();
      cleanupStaleLogs(dir, 1);
      expect(existsSync(path)).toBe(true);
    } finally { release(); }
    cleanupStaleLogs(dir, 1);
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multiple processes append complete records to one conversation file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-processes-"));
  const module = new URL("../src/conversation-history.ts", import.meta.url).href;
  const children = Array.from({ length: 4 }, (_, worker) => Bun.spawn([process.execPath, "-e", `
    import { conversationHistory } from ${JSON.stringify(module)};
    const log = await conversationHistory(${JSON.stringify(dir)}).open(${JSON.stringify(a)});
    try { for (let i = 0; i < 25; i++) await log.append({ id: ${worker} + ':' + i, payload: 'x'.repeat(32000) }); }
    finally { log.close(); }
  `], { stdout: "ignore", stderr: "pipe" }));
  try {
    const exits = await Promise.all(children.map(child => child.exited));
    expect(exits).toEqual([0, 0, 0, 0]);
    const records = readFileSync(conversationHistory(dir).pathFor(a), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(100);
    expect(new Set(records.map(record => record.id)).size).toBe(100);
    expect(records.every(record => record.payload.length === 32000)).toBe(true);
    expect(readdirSync(dir)).toEqual([`jev-codex-${a}.jsonl`]);
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
