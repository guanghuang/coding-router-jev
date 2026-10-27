import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configFromEnv } from "../src/config";
import { AUTO_MODEL, startProxy, summarizeCacheRun } from "../src/proxy";
import { buildRequest, type Route, type RoutingInput } from "../src/router";
import { REDACTED, REDACTED_ERROR } from "../src/history";
import type { CodexBody, Item } from "../src/types";

/** Legacy fixture IDs: tests that predate latest-by-default pin every Codex tier so no discovery is triggered. */
function pinnedCodexConfig(extra: Record<string, string> = {}) {
  return configFromEnv({
    CODING_ROUTER_FAST_MODEL_CODEX: "chatgpt-6-luna",
    CODING_ROUTER_BALANCED_MODEL_CODEX: "chatgpt-6.1-sol",
    CODING_ROUTER_STRONG_MODEL_CODEX: "chatgpt-6.1-sol",
    CODING_ROUTER_LONG_MODEL_CODEX: "chatgpt-6-astra",
    ...extra,
  });
}

/** Only Fast uses `luna:latest`; the other tiers are pinned so discovery stays single-family. */
function latestFastConfig() {
  return pinnedCodexConfig({ CODING_ROUTER_FAST_MODEL_CODEX: "luna:latest" });
}
function result(input: RoutingInput, tier: string, effort: string) {
  return { request: buildRequest(input), ms: 1, response: {
    model: "fake-jev", usage: { input_tokens: 1, output_tokens: 1 },
    answers: { model: { type: "choice" as const, choice: tier, confidence: 0.9, probabilities: {} }, reasoning_effort: { type: "choice" as const, choice: effort, confidence: 0.9, probabilities: {} } },
  } };
}
test("proxy routes once per turn, keeps tool continuations, streams notices once, and logs JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-proxy-"));
  const captured: { body: CodexBody; auth: string | null }[] = [];
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body, auth: req.headers.get("authorization") });
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 100 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); await Bun.sleep(5); return result(input, inputs.length === 1 ? "balanced" : "strong", inputs.length === 1 ? "low" : "high"); };
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  const send = (input: Item[], model = AUTO_MODEL) => fetch(`${local}/responses`, { method: "POST", headers: { authorization: "Bearer fake-auth", "content-type": "application/json" }, body: JSON.stringify({ model, prompt_cache_key: "conversation-a", reasoning: { effort: "medium" }, input }) }).then(response => response.text());
  try {
    const catalog = await fetch(`${local}/models`).then(res => res.json());
    expect(catalog.models[0].slug).toBe(AUTO_MODEL);
    // Status is hidden by default, but the shared catalog label must remain visible in Codex.
    expect(catalog.models[0].display_name).toBe("[Jev] Coding Router Jev ·");
    await send([{ role: "user", content: "# AGENTS.md instructions\n\n<INSTRUCTIONS>Repository rules</INSTRUCTIONS><environment_context>cwd: /repo</environment_context>" }]);
    expect(inputs).toHaveLength(0);
    const first: Item = { role: "user", content: "implement first" };
    const duplicate = await Promise.all([send([first]), send([first])]);
    expect(inputs).toHaveLength(1);
    expect(duplicate.filter(output => output.includes("[Jev]")).length).toBe(1);
    expect(captured[1].body.model).toBe("gpt-6.1-terra");
    expect(captured[0].auth).toBe("Bearer fake-auth");
    await send([first, { type: "function_call_output", call_id: "call", output: "done" }]);
    expect(inputs).toHaveLength(1);
    const second: Item = { role: "user", content: "debug second" };
    await send([first, { role: "assistant", content: "previous answer" }, second]);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].recentContext?.previous_assistant_excerpt).toBe("previous answer");
    expect(inputs[1].cache?.window).toBe("up to 1 hour, stopping at the most recent model switch");
    expect(typeof inputs[1].cache?.observed_responses).toBe("number");
    expect(inputs[1].cache).not.toHaveProperty("model");
    expect(inputs[1].cache).not.toHaveProperty("last_response_model");
    const last = captured.at(-1)!.body;
    expect(last.reasoning?.effort).toBe("high");
    expect((last.input as Item[]).some(item => item.type === "configuration_update" && item.reasoning?.effort === "high")).toBe(false);
    await send([first, second, { role: "user", content: "manual request" }], "manual-model");
    expect(inputs).toHaveLength(2);
    expect(captured.at(-1)!.body.model).toBe("manual-model");
    const records = (await readFile(proxy.logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].jev.request.questions.reasoning_required.type).toBe("score");
    expect(records[1].decision.tier).toBe("strong");
    expect((await stat(proxy.logPath)).mode & 0o777).toBe(0o600);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("disabled recent context is omitted and a failed JEV call keeps the current model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-fallback-"));
  const notices: string[] = [];
  let seen: RoutingInput | undefined;
  let forwarded: CodexBody | undefined;
  const upstream = Bun.serve({ port: 0, async fetch(req) { forwarded = await req.json() as CodexBody; return Response.json({ model: forwarded.model, usage: { input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }); } });
  const proxy = startProxy(pinnedCodexConfig({ CODING_ROUTER_SEND_RECENT_CONTEXT: "false" }), {
    apiBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory, onNotice: notice => notices.push(notice),
    route: async input => { seen = input; return { request: buildRequest(input), response: null, error: "timeout", ms: 3000 }; },
  });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: "POST", body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }, { role: "user", content: "continue" }] }) }).then(res => res.text());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[Jev] tier: fast, model: chatgpt-6-luna, effort: medium; decision: JEV/unavailable, confidence: unavailable.");
    expect(seen?.recentContext).toBeUndefined();
    expect(forwarded?.model).toBe("chatgpt-6-luna");
    const record = JSON.parse((await readFile(proxy.logPath, "utf8")).trim());
    expect(record.decision.reason).toBe("jev-unavailable/no-change");
    expect(record.jev.error).toBe("[routing error]");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("custom feedback format with all placeholders verified through proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-feedback-"));
  const notices: string[] = [];
  let turnCount = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 42, cache_write_tokens: 7 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const format = "[Jev] {tier} · {model} · {effort} · {decision} · {confidence} · prev:{previous_model} · cr:{cache_read} · cw:{cache_write} · jin:{jev_tokens_input} · jout:{jev_tokens_output} · jtotal:{jev_tokens}";
  const config = pinnedCodexConfig({ CODING_ROUTER_FEEDBACK_FORMAT: format });
  const route: Route = async input => { turnCount++; return turnCount === 1 ? result(input, "strong", "high") : result(input, "balanced", "low"); };
  const proxy = startProxy(config, { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory, onNotice: notice => notices.push(notice) });
  const send = (input: Item[]) => fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input }) }).then(r => r.text());
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    const first: Item = { role: "user", content: "hello" };
    await send([first]);
    expect(notices).toHaveLength(1);
    // Turn 1: verify ALL placeholders including jev_tokens_input/output (M1+M3)
    expect(notices[0]).toBe("[Jev] strong · gpt-6.1-sol · high · JEV/upgrade · 0.90 · prev:chatgpt-6-luna · cr:unavailable · cw:unavailable · jin:1 · jout:1 · jtotal:2");
    // Turn 2: routes to balanced; previous_model should reflect model from turn 1 (M2)
    const second: Item = { role: "user", content: "follow up" };
    await send([first, { role: "assistant", content: "answer" }, second]);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toBe("[Jev] balanced · gpt-6.1-sol · low · JEV/downgrade · 0.90 · prev:gpt-6.1-sol · cr:42 · cw:7 · jin:1 · jout:1 · jtotal:2");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("malformed JEV usage fields render as unavailable in feedback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-malformed-"));
  const notices: string[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 10 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const config = pinnedCodexConfig({ CODING_ROUTER_FEEDBACK_FORMAT: "jin:{jev_tokens_input} jout:{jev_tokens_output} jtotal:{jev_tokens}" });
  // Route returns malformed usage: NaN and Infinity should be rejected by isFinite checks (M4)
  const route: Route = async input => ({
    request: buildRequest(input), ms: 1, response: {
      model: "fake-jev", usage: { input_tokens: NaN, output_tokens: Infinity },
      answers: { model: { type: "choice" as const, choice: "strong", confidence: 0.9, probabilities: {} }, reasoning_effort: { type: "choice" as const, choice: "high", confidence: 0.9, probabilities: {} } },
    },
  });
  const proxy = startProxy(config, { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory, onNotice: notice => notices.push(notice) });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "test" }] }) }).then(r => r.text());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe("jin:unavailable jout:unavailable jtotal:unavailable");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test.each([true, false])("a provider retry reuses the JEV decision and displays one notice (SSE header: %s)", async (hasSSEHeader) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-retry-"));
  let upstreamCalls = 0;
  let jevCalls = 0;
  const upstream = Bun.serve({ port: 0, fetch() {
    upstreamCalls++;
    if (upstreamCalls === 1) return Response.json({ error: "retry" }, { status: 503 });
    return new Response(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"model":"chatgpt-6-luna"}}\n\n'), { headers: hasSSEHeader ? { "content-type": "text/event-stream" } : {} });
  } });
  const proxy = startProxy(pinnedCodexConfig(), { apiBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => { jevCalls++; return result(input, "fast", "low"); },
  });
  try {
    const request = () => fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hi" }] }) });
    expect((await request()).status).toBe(503);
    expect(await (await request()).text()).toContain("[Jev]");
    expect(await (await request()).text()).not.toContain("[Jev]");
    expect(jevCalls).toBe(1);
    expect((await readFile(proxy.logPath, "utf8")).trim().split("\n")).toHaveLength(1);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("startup cleanup removes stale logs and preserves recent ones when retention is set", async () => {
  const { writeFile: writeFileSync, utimesSync } = await import("node:fs");
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-cleanup-proxy-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(directory, { recursive: true });
  const DAY_MS = 86_400_000;
  const staleFile = join(directory, "codex-stale-session.jsonl");
  const recentFile = join(directory, "codex-recent-session.jsonl");
  const unrelatedFile = join(directory, "notes.txt");
  await writeFile(staleFile, "old\n");
  await writeFile(recentFile, "recent\n");
  await writeFile(unrelatedFile, "keep\n");
  const past = new Date(Date.now() - 20 * DAY_MS);
  utimesSync(staleFile, past, past);

  const config = configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "10" });
  expect(config.logRetentionDays).toBe(10);

  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ models: [] }) });
  const proxy = startProxy(config, { apiBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => result(input, "fast", "low"),
  });
  try {
    const remaining = await readdir(directory);
    expect(remaining).not.toContain("codex-stale-session.jsonl");
    expect(remaining).toContain("codex-recent-session.jsonl");
    expect(remaining).toContain("notes.txt");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("startup does not delete logs when logRetentionDays is undefined", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-no-cleanup-proxy-"));
  const { mkdirSync, utimesSync } = await import("node:fs");
  mkdirSync(directory, { recursive: true });
  const DAY_MS = 86_400_000;
  const staleFile = join(directory, "codex-old.jsonl");
  await writeFile(staleFile, "old\n");
  const past = new Date(Date.now() - 100 * DAY_MS);
  utimesSync(staleFile, past, past);

  const config = configFromEnv({});
  expect(config.logRetentionDays).toBeUndefined();

  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ models: [] }) });
  const proxy = startProxy(config, { apiBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => result(input, "fast", "low"),
  });
  try {
    const remaining = await readdir(directory);
    expect(remaining).toContain("codex-old.jsonl");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("jev notices are stripped from upstream history and fabricated lookalikes do not corrupt state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-strip-"));
  const captured: { body: CodexBody }[] = [];
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 50 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "fast", "low"); };
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  const send = (input: Item[], model = AUTO_MODEL) => fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input }) }).then(r => r.text());
  try {
    await fetch(`${local}/models`).then(r => r.json());
    const first: Item = { role: "user", content: "implement first" };
    await send([first]);
    expect(inputs).toHaveLength(1);
    expect(captured[0].body.model).toBe("gpt-6-luna");

    // Simulate replayed conversation with a genuine jev notice, a fabricated lookalike, and a real assistant message
    const jevNotice: Item = { role: "assistant", id: "jev-39f3a1a0-0045-495e-a502-8afd3b9544f9", content: [{ type: "output_text", text: "[Jev] tier: fast, model: gpt-6-luna, effort: low; decision: JEV, confidence: 0.90." }] };
    const fabricatedLookalike: Item = { role: "assistant", id: "msg_09a50707f436a8b9016ac1e9a9833487d1a3544e4c45d07310", content: [{ type: "output_text", text: "[Jev] tier: balanced, model: gpt-6.1-sol, effort: medium; decision: JEV, confidence: 0.90." }] };
    const realAssistant: Item = { role: "assistant", content: "Here is my answer." };
    const second: Item = { role: "user", content: "debug second" };
    await send([first, jevNotice, fabricatedLookalike, realAssistant, second]);
    expect(inputs).toHaveLength(2);

    // The jev notice should be stripped from the forwarded request
    const forwarded = captured[1].body.input as Item[];
    expect(forwarded.some(item => item.id === jevNotice.id)).toBe(false);
    // The fabricated lookalike is a regular msg_… message — it is preserved
    expect(forwarded.some(item => item.id === fabricatedLookalike.id)).toBe(true);
    // Normal assistant and user messages are preserved
    expect(forwarded.some(item => item.content === "Here is my answer.")).toBe(true);
    expect(forwarded.some(item => item.content === "implement first")).toBe(true);
    expect(forwarded.some(item => item.content === "debug second")).toBe(true);

    // Routing state still reflects the real decision (Luna), not the fabricated Sol claim
    expect(inputs[1].currentModel).toBe("gpt-6-luna");
    expect(captured[1].body.model).toBe("gpt-6-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("jev notices are stripped even with custom feedback format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-strip-custom-"));
  const captured: { body: CodexBody }[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 10 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const format = "Router: {model} ({tier}) effort={effort}";
  const route: Route = async input => result(input, "strong", "high");
  const proxy = startProxy(pinnedCodexConfig({ CODING_ROUTER_FEEDBACK_FORMAT: format }), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  const send = (input: Item[]) => fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input }) }).then(r => r.text());
  try {
    await fetch(`${local}/models`).then(r => r.json());
    const first: Item = { role: "user", content: "hello" };
    await send([first]);

    // The notice has a custom format — but the filter is provenance-based (ID), not text-based
    const jevNotice: Item = { role: "assistant", id: "jev-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", content: [{ type: "output_text", text: "Router: gpt-6.1-sol (strong) effort=high" }] };
    const normalAssistant: Item = { role: "assistant", content: "response text" };
    const second: Item = { role: "user", content: "follow up" };
    await send([first, jevNotice, normalAssistant, second]);

    const forwarded = captured[1].body.input as Item[];
    expect(forwarded.some(item => item.id === "jev-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(false);
    expect(forwarded.some(item => item.content === "response text")).toBe(true);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("tool continuations after jev notice filtering still work correctly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-strip-tools-"));
  const captured: { body: CodexBody }[] = [];
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "fast", "low"); };
  const proxy = startProxy(pinnedCodexConfig(), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  const send = (input: Item[]) => fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input }) }).then(r => r.text());
  try {
    await fetch(`${local}/models`).then(r => r.json());
    const user: Item = { role: "user", content: "run the tool" };
    await send([user]);
    expect(inputs).toHaveLength(1);

    // Tool continuation with a jev notice mixed in — notice should be stripped but tool output preserved
    const jevNotice: Item = { role: "assistant", id: "jev-11111111-2222-3333-4444-555555555555", content: [{ type: "output_text", text: "[Jev] tier: fast, model: gpt-6-luna, effort: low; decision: JEV, confidence: 0.90." }] };
    const toolOutput: Item = { type: "function_call_output", call_id: "call_abc", output: "tool result" };
    await send([user, jevNotice, toolOutput]);
    // Tool continuation should not trigger a new routing decision
    expect(inputs).toHaveLength(1);

    const forwarded = captured[1].body.input as Item[];
    expect(forwarded.some(item => typeof item.id === "string" && item.id.startsWith("jev-"))).toBe(false);
    expect(forwarded.some(item => item.type === "function_call_output")).toBe(true);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("multiple jev notices in same history are all stripped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-strip-multi-"));
  const captured: { body: CodexBody }[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 10 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => result(input, "fast", "low");
  const proxy = startProxy(pinnedCodexConfig(), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  const send = (input: Item[]) => fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input }) }).then(r => r.text());
  try {
    await fetch(`${local}/models`).then(r => r.json());
    const first: Item = { role: "user", content: "first" };
    await send([first]);

    // Two genuine jev notices from separate turns + one regular assistant message
    const jevNotice1: Item = { role: "assistant", id: "jev-11111111-1111-1111-1111-111111111111", content: [{ type: "output_text", text: "[Jev] turn 1 notice" }] };
    const assistant1: Item = { role: "assistant", content: "answer to first" };
    const second: Item = { role: "user", content: "second" };
    const jevNotice2: Item = { role: "assistant", id: "jev-22222222-2222-2222-2222-222222222222", content: [{ type: "output_text", text: "[Jev] turn 2 notice" }] };
    const assistant2: Item = { role: "assistant", content: "answer to second" };
    const third: Item = { role: "user", content: "third" };
    await send([first, jevNotice1, assistant1, second, jevNotice2, assistant2, third]);

    const forwarded = captured[1].body.input as Item[];
    const jevItems = forwarded.filter(item => typeof item.id === "string" && item.id.startsWith("jev-"));
    expect(jevItems).toHaveLength(0);
    expect(forwarded.filter(item => item.role === "assistant").map(item => item.content)).toEqual(["answer to first", "answer to second"]);
    expect(forwarded.filter(item => item.role === "user").map(item => item.content)).toEqual(["first", "second", "third"]);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("compact requests also strip jev notices from history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-strip-compact-"));
  const captured: { body: CodexBody }[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => result(input, "fast", "low");
  const proxy = startProxy(pinnedCodexConfig(), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  try {
    await fetch(`${local}/models`).then(r => r.json());
    // First turn via normal endpoint to establish state
    const first: Item = { role: "user", content: "hello" };
    await fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [first] }) }).then(r => r.text());

    // Compact request with a jev notice in history
    const jevNotice: Item = { role: "assistant", id: "jev-cccccccc-cccc-cccc-cccc-cccccccccccc", content: [{ type: "output_text", text: "[Jev] compact notice" }] };
    const assistant: Item = { role: "assistant", content: "answer" };
    const second: Item = { role: "user", content: "follow up" };
    await fetch(`${local}/responses/compact`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [first, jevNotice, assistant, second] }) }).then(r => r.text());

    const forwarded = captured[1].body.input as Item[];
    expect(forwarded.some(item => typeof item.id === "string" && item.id.startsWith("jev-"))).toBe(false);
    expect(forwarded.some(item => item.content === "answer")).toBe(true);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("previous_response_id continuation still works after notice filtering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-strip-previd-"));
  const captured: { body: CodexBody }[] = [];
  const inputs: RoutingInput[] = [];
  let responseCount = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    responseCount++;
    const responseId = `resp_${responseCount}`;
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: responseId, model: body.model, usage: { input_tokens_details: { cached_tokens: 10 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "fast", "low"); };
  const proxy = startProxy(pinnedCodexConfig(), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  const send = (body: Record<string, unknown>) => fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.text());
  try {
    await fetch(`${local}/models`).then(r => r.json());
    // First turn
    await send({ model: AUTO_MODEL, input: [{ role: "user", content: "first request" }] });
    expect(inputs).toHaveLength(1);

    // Second turn using previous_response_id, with a jev notice in history
    const jevNotice: Item = { role: "assistant", id: "jev-dddddddd-dddd-dddd-dddd-dddddddddddd", content: [{ type: "output_text", text: "[Jev] previous notice" }] };
    await send({ model: AUTO_MODEL, previous_response_id: "resp_1", input: [{ role: "user", content: "first request" }, jevNotice, { role: "assistant", content: "answer" }, { role: "user", content: "continue with prev id" }] });
    expect(inputs).toHaveLength(2);

    // Notice stripped from forwarded request
    const forwarded = captured[1].body.input as Item[];
    expect(forwarded.some(item => typeof item.id === "string" && item.id.startsWith("jev-"))).toBe(false);
    expect(forwarded.some(item => item.content === "answer")).toBe(true);
    expect(forwarded.some(item => item.content === "continue with prev id")).toBe(true);
    // Routing still works — previous_response_id maps to correct conversation
    expect(inputs[1].currentModel).toBe("gpt-6-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("explicit model requests also strip jev notices from upstream history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-strip-explicit-"));
  const captured: { body: CodexBody }[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => result(input, "fast", "low");
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  try {
    await fetch(`${local}/models`).then(r => r.json());
    // Explicit model request with a jev notice in history
    const jevNotice: Item = { role: "assistant", id: "jev-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", content: [{ type: "output_text", text: "[Jev] notice" }] };
    await fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "hello" }, jevNotice, { role: "assistant", content: "real answer" }, { role: "user", content: "continue" }] }) }).then(r => r.text());

    const forwarded = captured[0].body.input as Item[];
    expect(forwarded.some(item => typeof item.id === "string" && item.id.startsWith("jev-"))).toBe(false);
    expect(forwarded.some(item => item.content === "real answer")).toBe(true);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("summarizeCacheRun: 30-minute-old observation is included", () => {
  const now = Date.now();
  const observations = [{ model: "gpt-6-luna", read: 5000, created: 1000, at: now - 1_800_000 }];
  const result = summarizeCacheRun(observations, "gpt-6-luna", now);
  expect(result.observed_responses).toBe(1);
  expect(result.newest_seconds_ago).toBe(1800);
  expect(result.oldest_seconds_ago).toBe(1800);
  expect(result.cache_read_tokens_avg).toBe(5000);
  expect(result.cache_created_tokens_avg).toBe(1000);
});

test("summarizeCacheRun: 61-minute-old observation is excluded", () => {
  const now = Date.now();
  const observations = [{ model: "gpt-6-luna", read: 5000, created: 1000, at: now - 3_660_000 }];
  const result = summarizeCacheRun(observations, "gpt-6-luna", now);
  expect(result.observed_responses).toBe(0);
  expect(result.newest_seconds_ago).toBeUndefined();
  expect(result.oldest_seconds_ago).toBeUndefined();
  expect(result.cache_read_tokens_avg).toBeNull();
  expect(result.cache_created_tokens_avg).toBeNull();
});

test("summarizeCacheRun: model switch stops scan even with older matching entries", () => {
  const now = Date.now();
  const observations = [
    { model: "gpt-6-luna", read: 1000, created: null, at: now - 600_000 },
    { model: "gpt-6.1-sol", read: 2000, created: 500, at: now - 300_000 },
    { model: "gpt-6-luna", read: 3000, created: 700, at: now - 60_000 },
  ];
  const result = summarizeCacheRun(observations, "gpt-6-luna", now);
  expect(result.observed_responses).toBe(1);
  expect(result.newest_seconds_ago).toBe(60);
  expect(result.oldest_seconds_ago).toBe(60);
  expect(result.cache_read_tokens_avg).toBe(3000);
  expect(result.cache_created_tokens_avg).toBe(700);
});

test("summarizeCacheRun: averages ignore null values independently per metric", () => {
  const now = Date.now();
  const observations = [
    { model: "gpt-6-luna", read: null, created: 200, at: now - 120_000 },
    { model: "gpt-6-luna", read: 4000, created: null, at: now - 60_000 },
    { model: "gpt-6-luna", read: 6000, created: 800, at: now - 30_000 },
  ];
  const result = summarizeCacheRun(observations, "gpt-6-luna", now);
  expect(result.observed_responses).toBe(3);
  expect(result.cache_read_tokens_avg).toBe(5000);
  expect(result.cache_created_tokens_avg).toBe(500);
});

test("summarizeCacheRun: unknown-count responses still count and mark model switches", () => {
  const now = Date.now();
  const observations = [
    { model: "gpt-6-luna", read: 1000, created: null, at: now - 300_000 },
    { model: "gpt-6.1-sol", read: null, created: null, at: now - 180_000 },
    { model: "gpt-6-luna", read: 5000, created: 200, at: now - 60_000 },
  ];
  const result = summarizeCacheRun(observations, "gpt-6-luna", now);
  expect(result.observed_responses).toBe(1);
  expect(result.cache_read_tokens_avg).toBe(5000);
  expect(result.cache_created_tokens_avg).toBe(200);
});

test("summarizeCacheRun: unknown-count same-model observations still increase observed_responses", () => {
  const now = Date.now();
  const observations = [
    { model: "gpt-6-luna", read: null, created: null, at: now - 120_000 },
    { model: "gpt-6-luna", read: null, created: null, at: now - 60_000 },
    { model: "gpt-6-luna", read: 3000, created: 100, at: now - 30_000 },
  ];
  const result = summarizeCacheRun(observations, "gpt-6-luna", now);
  expect(result.observed_responses).toBe(3);
  expect(result.cache_read_tokens_avg).toBe(3000);
  expect(result.cache_created_tokens_avg).toBe(100);
});

test("summarizeCacheRun: newest observation is different model yields zero count", () => {
  const now = Date.now();
  const observations = [
    { model: "gpt-6-luna", read: 1000, created: 500, at: now - 120_000 },
    { model: "gpt-6.1-sol", read: 2000, created: 200, at: now - 60_000 },
  ];
  const result = summarizeCacheRun(observations, "gpt-6-luna", now);
  expect(result.observed_responses).toBe(0);
  expect(result.newest_seconds_ago).toBeUndefined();
  expect(result.oldest_seconds_ago).toBeUndefined();
  expect(result.cache_read_tokens_avg).toBeNull();
  expect(result.cache_created_tokens_avg).toBeNull();
});

test("summarizeCacheRun: exact 1-hour boundary is included", () => {
  const now = Date.now();
  const observations = [{ model: "gpt-6-luna", read: 1000, created: 200, at: now - 3_600_000 }];
  const result = summarizeCacheRun(observations, "gpt-6-luna", now);
  expect(result.observed_responses).toBe(1);
  expect(result.newest_seconds_ago).toBe(3600);
});

test("summarizeCacheRun: empty history yields zero count, null averages, no ages", () => {
  const now = Date.now();
  const result = summarizeCacheRun([], "gpt-6-luna", now);
  expect(result.observed_responses).toBe(0);
  expect(result.newest_seconds_ago).toBeUndefined();
  expect(result.oldest_seconds_ago).toBeUndefined();
  expect(result.cache_read_tokens_avg).toBeNull();
  expect(result.cache_created_tokens_avg).toBeNull();
  expect(result.window).toBe("up to 1 hour, stopping at the most recent model switch");
});

test("existing session fields remain in the built JEV request", () => {
  const input: RoutingInput = {
    prompt: "test prompt",
    currentTier: "fast",
    currentModel: "gpt-6-luna",
    currentEffort: "medium",
    contextTokens: 42000,
    candidates: [{ tier: "fast" as const, id: "gpt-6-luna", description: "Luna", efforts: ["low", "medium", "high"] }],
    cache: summarizeCacheRun([], "gpt-6-luna", Date.now()),
  };
  const request = buildRequest(input);
  const state = request.state as Record<string, unknown>;
  const session = state.session as Record<string, unknown>;
  expect(session.current_tier).toBe("fast");
  expect(session.current_model).toBe("gpt-6-luna");
  expect(session.current_reasoning_effort).toBe("medium");
  expect(session.context_tokens).toBe(42000);
  const cache = session.cache as Record<string, unknown>;
  expect(cache.window).toBe("up to 1 hour, stopping at the most recent model switch");
  expect(cache.observed_responses).toBe(0);
  expect(cache).not.toHaveProperty("model");
  expect(cache).not.toHaveProperty("last_response_model");
});

test("default startup tier is fast and first JEV input reflects configured fast model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-startup-default-"));
  const inputs: RoutingInput[] = [];
  let forwarded: CodexBody | undefined;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    forwarded = await req.json() as CodexBody;
    return Response.json({ model: forwarded.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "fast", "low"); };
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(inputs).toHaveLength(1);
    expect(inputs[0].currentTier).toBe("fast");
    expect(inputs[0].currentModel).toBe("gpt-6-luna");
    expect(forwarded?.model).toBe("gpt-6-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("custom startup tier strong is honored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-startup-strong-"));
  const inputs: RoutingInput[] = [];
  let forwarded: CodexBody | undefined;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    forwarded = await req.json() as CodexBody;
    return Response.json({ model: forwarded.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "strong", "high"); };
  const proxy = startProxy(configFromEnv({ CODING_ROUTER_START_TIER: "strong" }), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "diagnose" }] }) }).then(r => r.text());
    expect(inputs).toHaveLength(1);
    expect(inputs[0].currentTier).toBe("strong");
    expect(inputs[0].currentModel).toBe("gpt-6.1-sol");
    expect(forwarded?.model).toBe("gpt-6.1-sol");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("JEV failure falls back to configured startup tier rather than strong", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-startup-fallback-"));
  const notices: string[] = [];
  let forwarded: CodexBody | undefined;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    forwarded = await req.json() as CodexBody;
    return Response.json({ model: forwarded.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const config = configFromEnv({ CODING_ROUTER_START_TIER: "balanced" });
  const proxy = startProxy(config, { apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory, onNotice: n => notices.push(n),
    route: async input => ({ request: buildRequest(input), response: null, error: "timeout", ms: 3000 }),
  });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "test" }] }) }).then(r => r.text());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tier: balanced");
    expect(notices[0]).toContain("model: gpt-6.1-terra");
    expect(forwarded?.model).toBe("gpt-6.1-terra");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("restart resets to configured startup tier, not previous session final tier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-startup-restart-"));
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const config = configFromEnv({});
  const cacheKey = "restart-conversation";
  try {
    const inputs1: RoutingInput[] = [];
    const route1: Route = async input => { inputs1.push(input); return result(input, "strong", "high"); };
    const proxy1 = startProxy(config, { route: route1, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
    try {
      await fetch(`http://127.0.0.1:${proxy1.port}/models`).then(r => r.json());
      await fetch(`http://127.0.0.1:${proxy1.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, prompt_cache_key: cacheKey, input: [{ role: "user", content: "hard problem" }] }) }).then(r => r.text());
      expect(inputs1[0].currentTier).toBe("fast");
    } finally { proxy1.close(); }

    const inputs2: RoutingInput[] = [];
    const route2: Route = async input => { inputs2.push(input); return result(input, "fast", "low"); };
    const proxy2 = startProxy(config, { route: route2, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
    try {
      await fetch(`http://127.0.0.1:${proxy2.port}/models`).then(r => r.json());
      await fetch(`http://127.0.0.1:${proxy2.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, prompt_cache_key: cacheKey, input: [{ role: "user", content: "simple task" }] }) }).then(r => r.text());
      expect(inputs2[0].currentTier).toBe("fast");
      expect(inputs2[0].currentModel).toBe("gpt-6-luna");
    } finally { proxy2.close(); }
  } finally { upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("startup model uses catalog alias resolution with custom fast model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-startup-alias-"));
  const inputs: RoutingInput[] = [];
  let forwarded: CodexBody | undefined;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna-v2", display_name: "Luna v2", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    forwarded = await req.json() as CodexBody;
    return Response.json({ model: forwarded.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "fast", "low"); };
  const config = pinnedCodexConfig({ CODING_ROUTER_FAST_MODEL_CODEX: "chatgpt-6-luna-v2" });
  const proxy = startProxy(config, { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(inputs).toHaveLength(1);
    expect(inputs[0].currentTier).toBe("fast");
    expect(inputs[0].currentModel).toBe("gpt-6-luna-v2");
    expect(forwarded?.model).toBe("gpt-6-luna-v2");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("startup model resolves chatgpt-6 alias to catalog gpt-6 slug", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-startup-canonical-"));
  const inputs: RoutingInput[] = [];
  let forwarded: CodexBody | undefined;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    forwarded = await req.json() as CodexBody;
    return Response.json({ model: forwarded.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "balanced", "medium"); };
  const proxy = startProxy(pinnedCodexConfig({ CODING_ROUTER_START_TIER: "balanced" }), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(inputs).toHaveLength(1);
    expect(inputs[0].currentTier).toBe("balanced");
    expect(inputs[0].currentModel).toBe("gpt-6.1-sol");
    expect(forwarded?.model).toBe("gpt-6.1-sol");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("explicit model requests remain untouched with startup tier configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-startup-explicit-"));
  const captured: { body: CodexBody }[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-terra", display_name: "Terra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async () => { throw new Error("should not route"); };
  const proxy = startProxy(configFromEnv({ CODING_ROUTER_START_TIER: "balanced" }), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(captured[0].body.model).toBe("gpt-6-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("sensitivity questions are in JEV request and sensitive content is redacted in JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-redact-"));
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => {
    inputs.push(input);
    return {
      request: buildRequest(input), ms: 1, response: {
        model: "fake-jev", usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          model: { type: "choice" as const, choice: "fast", confidence: 0.9, probabilities: {} },
          reasoning_effort: { type: "choice" as const, choice: "low", confidence: 0.9, probabilities: {} },
          current_message_sensitive: { type: "choice" as const, choice: "sensitive", confidence: 0.95, probabilities: {} },
          previous_user_message_sensitive: { type: "choice" as const, choice: "not_sensitive", confidence: 0.85, probabilities: {} },
          previous_assistant_response_sensitive: { type: "choice" as const, choice: "sensitive", confidence: 0.90, probabilities: {} },
        },
      },
    };
  };
  const proxy = startProxy(pinnedCodexConfig(), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const local = `http://127.0.0.1:${proxy.port}`;
  try {
    await fetch(`${local}/models`).then(r => r.json());
    await fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "old request" }, { role: "assistant", content: "old response" }, { role: "user", content: "my password is hunter2" }] }) }).then(r => r.text());

    expect(inputs).toHaveLength(1);
    expect(inputs[0].prompt).toBe("my password is hunter2");

    const request = buildRequest(inputs[0]);
    expect(request.questions).toHaveProperty("current_message_sensitive");
    expect(request.questions).toHaveProperty("previous_user_message_sensitive");
    expect(request.questions).toHaveProperty("previous_assistant_response_sensitive");

    const records = (await readFile(proxy.logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].prompt).toBe(REDACTED);
    expect(records[0].jev.request.state.request).toBe(REDACTED);
    expect(records[0].jev.request.state.recent_context.previous_user_request).toBe("old request");
    expect(records[0].jev.request.state.recent_context.previous_assistant_excerpt).toBe(REDACTED);

    expect(records[0].decision.tier).toBe("fast");
    expect(records[0].decision.model).toBe("gpt-6-luna");
    expect(records[0].jev.ms).toBe(1);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("JEV error in JSONL is replaced with safe category", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-error-redact-"));
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6-luna", display_name: "Luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => ({
    request: buildRequest(input), response: null, error: "Error processing: my password is hunter2", ms: 100,
  });
  const proxy = startProxy(pinnedCodexConfig(), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "test" }] }) }).then(r => r.text());

    const records = (await readFile(proxy.logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].jev.error).toBe(REDACTED_ERROR);
    expect(records[0].jev.error).not.toContain("hunter2");
    expect(records[0].prompt).toBe(REDACTED);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

const aliasModel = (slug: string) => ({ slug, display_name: slug, context_window: 200_000, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] });

test("latest aliases resolve from a prior /models catalog, stay pinned across refresh, and appear in feedback/JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-pin-"));
  let catalogModels = [aliasModel("gpt-6.9-luna"), aliasModel("gpt-6.10-sol"), aliasModel("gpt-6.1-terra")];
  const captured: CodexBody[] = [];
  const inputs: RoutingInput[] = [];
  const notices: string[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: catalogModels });
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const config = configFromEnv({});
  const route: Route = async input => { inputs.push(input); return result(input, "balanced", "low"); };
  const proxy = startProxy(config, { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory, onNotice: notice => notices.push(notice) });
  const local = `http://127.0.0.1:${proxy.port}`;
  const send = (content: string, prior: Item[] = []) => fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [...prior, { role: "user", content }] }) }).then(r => r.text());
  try {
    await fetch(`${local}/models`).then(r => r.json());
    await send("hello");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].candidates.map(c => c.id)).toEqual(["gpt-6.9-luna", "gpt-6.1-terra", "gpt-6.10-sol"]);
    expect(captured[0].model).toBe("gpt-6.1-terra");
    expect(JSON.stringify(captured)).not.toContain(":latest");
    expect(notices[0]).toContain("model: gpt-6.1-terra");
    // A catalog refresh advertising newer versions must not switch the session.
    catalogModels = [aliasModel("gpt-6.10-luna"), aliasModel("gpt-6.11-sol"), aliasModel("gpt-6.2-terra")];
    await fetch(`${local}/models`).then(r => r.json());
    const first: Item = { role: "user", content: "hello" };
    await send("again", [first, { role: "assistant", content: "answer" }]);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].candidates.map(c => c.id)).toEqual(["gpt-6.9-luna", "gpt-6.1-terra", "gpt-6.10-sol"]);
    expect(captured.at(-1)!.model).toBe("gpt-6.1-terra");
    const records = (await readFile(proxy.logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.decision.model)).toEqual(["gpt-6.1-terra", "gpt-6.1-terra"]);
    expect(JSON.stringify(records)).not.toContain(":latest");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("unset Codex defaults resolve latest families once, stay pinned, and appear in feedback/JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-defaults-"));
  let modelsHits = 0;
  let catalogModels = [aliasModel("gpt-6.9-luna"), aliasModel("gpt-6.10-sol"), aliasModel("gpt-6.1-terra")];
  const captured: CodexBody[] = [];
  const inputs: RoutingInput[] = [];
  const notices: string[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) { modelsHits++; return Response.json({ models: catalogModels }); }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "balanced", "low"); };
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory, onNotice: notice => notices.push(notice) });
  const local = `http://127.0.0.1:${proxy.port}`;
  const send = (content: string, prior: Item[] = []) => fetch(`${local}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [...prior, { role: "user", content }] }) }).then(r => r.text());
  try {
    await send("hello");
    expect(modelsHits).toBe(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].candidates.map(c => c.id)).toEqual(["gpt-6.9-luna", "gpt-6.1-terra", "gpt-6.10-sol"]);
    expect(captured[0].model).toBe("gpt-6.1-terra");
    expect(notices[0]).toContain("model: gpt-6.1-terra");
    // A newer catalog must not switch the session: no second discovery, same exact IDs.
    catalogModels = [aliasModel("gpt-6.10-luna"), aliasModel("gpt-6.11-sol"), aliasModel("gpt-6.2-terra")];
    const first: Item = { role: "user", content: "hello" };
    await send("again", [first, { role: "assistant", content: "answer" }]);
    expect(modelsHits).toBe(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].candidates.map(c => c.id)).toEqual(["gpt-6.9-luna", "gpt-6.1-terra", "gpt-6.10-sol"]);
    expect(captured.at(-1)!.model).toBe("gpt-6.1-terra");
    expect(JSON.stringify(captured)).not.toContain(":latest");
    const records = (await readFile(proxy.logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.decision.model)).toEqual(["gpt-6.1-terra", "gpt-6.1-terra"]);
    expect(JSON.stringify(records)).not.toContain(":latest");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("one exact Codex ID stays pinned among default latest aliases through the proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-mixed-pin-"));
  let modelsHits = 0;
  const captured: CodexBody[] = [];
  const inputs: RoutingInput[] = [];
  const notices: string[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) { modelsHits++; return Response.json({ models: [aliasModel("gpt-6.9-luna"), aliasModel("gpt-6.1-sol"), aliasModel("gpt-6.10-sol")] }); }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "balanced", "low"); };
  const proxy = startProxy(configFromEnv({ CODING_ROUTER_BALANCED_MODEL_CODEX: "chatgpt-6.1-sol" }), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory, onNotice: notice => notices.push(notice) });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(modelsHits).toBe(1);
    // Balanced keeps its pinned exact ID (canonical catalog slug); it is not upgraded to the newer sol.
    expect(inputs[0].candidates.map(c => c.id)).toEqual(["gpt-6.9-luna", "gpt-6.1-sol", "gpt-6.10-sol"]);
    expect(captured[0].model).toBe("gpt-6.1-sol");
    expect(notices[0]).toContain("model: gpt-6.1-sol");
    expect(JSON.stringify(captured)).not.toContain(":latest");
    const records = (await readFile(proxy.logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.map(record => record.decision.model)).toEqual(["gpt-6.1-sol"]);
    expect(JSON.stringify(records)).not.toContain(":latest");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("discovery failure under default latest config is actionable and forwards nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-default-fail-"));
  let routeCalls = 0;
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.10-sol")] });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(configFromEnv({}), { route: async input => { routeCalls++; return result(input, "fast", "low"); }, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain("luna:latest");
    expect(text).toContain("CODING_ROUTER_FAST_MODEL_CODEX");
    expect(routeCalls).toBe(0);
    expect(responsesHits).toBe(0);
    const logText = await readFile(proxy.logPath, "utf8").catch(() => "");
    expect(logText).not.toContain(":latest");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("first routing request without a prior /models lazily discovers with the request auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-lazy-"));
  let modelsHits = 0;
  let modelsAuth = "";
  const captured: CodexBody[] = [];
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) { modelsHits++; modelsAuth = req.headers.get("authorization") ?? ""; return Response.json({ models: [aliasModel("gpt-6.9-luna"), aliasModel("gpt-6.10-luna")] }); }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, "fast", "low"); };
  const proxy = startProxy(latestFastConfig(), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { authorization: "Bearer fake-auth", "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(modelsHits).toBe(1);
    expect(modelsAuth).toBe("Bearer fake-auth");
    expect(inputs).toHaveLength(1);
    expect(captured[0].model).toBe("gpt-6.10-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("lazy discovery follows catalog pagination before resolving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-page-"));
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      if (url.searchParams.get("cursor") === "page2") return Response.json({ models: [aliasModel("gpt-6.10-luna")] });
      return Response.json({ models: [aliasModel("gpt-6.9-luna")], next_cursor: "page2" });
    }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(captured[0].model).toBe("gpt-6.10-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("missing family returns an actionable error and never forwards the alias upstream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-missing-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.10-sol")] });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain("luna:latest");
    expect(text).toContain("CODING_ROUTER_FAST_MODEL_CODEX");
    expect(text).toContain("exact");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("ambiguous catalog returns an actionable error and never forwards the alias upstream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-ambiguous-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.10-luna"), aliasModel("chatgpt-6.10-luna")] });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("luna");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("discovery auth failure is actionable and does not leak credentials or the upstream body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-auth-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ error: "upstream-secret-detail" }, { status: 401 });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { authorization: "Bearer super-secret-token", "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain("luna:latest");
    expect(text).toContain("401");
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("upstream-secret-detail");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("empty catalog discovery is actionable and never forwards the alias upstream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-empty-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({});
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("luna:latest");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("disabled Long alias does not trigger discovery or errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-long-off-"));
  let modelsHits = 0;
  let forwarded: CodexBody | undefined;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) { modelsHits++; return Response.json({ models: [] }); }
    forwarded = await req.json() as CodexBody;
    return Response.json({ model: forwarded.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(pinnedCodexConfig({ CODING_ROUTER_LONG_MODEL_CODEX: "astra:latest" }), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(modelsHits).toBe(0);
    expect(forwarded?.model).toBe("chatgpt-6-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("exact IDs work without any discovery request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-exact-no-discovery-"));
  let modelsHits = 0;
  let forwarded: CodexBody | undefined;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) { modelsHits++; return Response.json({ error: "no catalog" }, { status: 500 }); }
    forwarded = await req.json() as CodexBody;
    return Response.json({ model: forwarded.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(pinnedCodexConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(modelsHits).toBe(0);
    expect(forwarded?.model).toBe("chatgpt-6-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("an explicit latest alias request is resolved and never forwarded as an alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-explicit-"));
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.10-luna")] });
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(configFromEnv({}), { route: async () => { throw new Error("should not route"); }, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "luna:latest", input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(captured[0].model).toBe("gpt-6.10-luna");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("discovery failure skips the classifier and writes no alias to JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-noroute-"));
  let routeCalls = 0;
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.10-sol")] });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => { routeCalls++; return result(input, "fast", "low"); }, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(routeCalls).toBe(0);
    expect(responsesHits).toBe(0);
    const logText = await readFile(proxy.logPath, "utf8").catch(() => "");
    expect(logText).toBe("");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("an explicit latest alias that cannot resolve fails without forwarding or routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-explicit-fail-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.10-sol")] });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(configFromEnv({}), { route: async () => { throw new Error("should not route"); }, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "luna:latest", input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("luna:latest");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("network-level catalog failure is actionable and forwards nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-network-"));
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({}) });
  const deadBase = `http://127.0.0.1:${dead.port}`;
  dead.stop(true);
  let routeCalls = 0;
  const proxy = startProxy(latestFastConfig(), { route: async input => { routeCalls++; return result(input, "fast", "low"); }, apiBaseURL: deadBase, chatgptBaseURL: deadBase, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).toContain("luna:latest");
    expect(text).toContain("catalog request failed");
    expect(routeCalls).toBe(0);
  } finally { proxy.close(); await rm(directory, { recursive: true, force: true }); }
});

test("malformed catalog JSON is actionable and forwards nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-malformed-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return new Response("{not json", { headers: { "content-type": "application/json" } });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("malformed");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("an empty proxied /models response does not suppress lazy discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-empty-seen-"));
  let modelsHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) { modelsHits++; return Response.json({ models: [] }); }
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.text());
    expect(modelsHits).toBe(1);
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    // The routing request made its own authenticated discovery attempt.
    expect(modelsHits).toBe(2);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("a paginated proxied /models page does not pin an older version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-page-pin-"));
  let modelsHits = 0;
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      modelsHits++;
      if (url.searchParams.get("cursor") === "page2") return Response.json({ models: [aliasModel("gpt-6.10-luna")] });
      return Response.json({ models: [aliasModel("gpt-6.9-luna")], next_cursor: "page2" });
    }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.text());
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(captured[0].model).toBe("gpt-6.10-luna");
    expect(modelsHits).toBe(3);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("catalog pagination beyond the page limit fails closed instead of pinning a partial catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-page-limit-"));
  let modelsHits = 0;
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) { modelsHits++; return Response.json({ models: [aliasModel("gpt-6.9-luna")], next_cursor: `page-${modelsHits + 1}` }); }
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("pagination did not complete");
    expect(modelsHits).toBe(10);
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("lazy discovery follows has_more pagination using the last model as the cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-hasmore-"));
  let modelsHits = 0;
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      modelsHits++;
      if (url.searchParams.get("after") === "gpt-6.9-luna") return Response.json({ models: [aliasModel("gpt-6.10-luna")] });
      return Response.json({ models: [aliasModel("gpt-6.9-luna")], has_more: true });
    }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(captured[0].model).toBe("gpt-6.10-luna");
    expect(modelsHits).toBe(2);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("an enabled Long latest alias resolves and can be selected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-long-on-"));
  const captured: CodexBody[] = [];
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.10-luna"), aliasModel("gpt-6.10-sol"), aliasModel("gpt-6.1-terra"), aliasModel("gpt-6.10-astra")] });
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const config = configFromEnv({ CODING_ROUTER_LONG_MODEL_ENABLE: "true" });
  const proxy = startProxy(config, { route: async input => { inputs.push(input); return result(input, "long", "low"); }, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(inputs[0].candidates.map(c => c.id)).toContain("gpt-6.10-astra");
    expect(captured[0].model).toBe("gpt-6.10-astra");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("lazy discovery follows Link rel=next pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-link-"));
  let modelsHits = 0;
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      modelsHits++;
      if (url.searchParams.get("cursor") === "page2") return Response.json({ models: [aliasModel("gpt-6.10-luna")] });
      return Response.json({ models: [aliasModel("gpt-6.9-luna")] }, { headers: { link: `<${url.origin}/models?cursor=page2>; rel="next"` } });
    }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
    expect(captured[0].model).toBe("gpt-6.10-luna");
    expect(modelsHits).toBe(2);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("cross-origin catalog pagination is refused and forwards nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-xorigin-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.9-luna")], next: "https://example.com/models" });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { authorization: "Bearer fake-auth", "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("different origin");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent routing requests share one in-flight discovery and resolve identically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-concurrent-"));
  let modelsHits = 0;
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      modelsHits++;
      await Bun.sleep(30);
      if (url.searchParams.get("cursor") === "page2") return Response.json({ models: [aliasModel("gpt-6.10-luna")] });
      return Response.json({ models: [aliasModel("gpt-6.9-luna")], next_cursor: "page2" });
    }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const send = () => fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) }).then(r => r.text());
  try {
    await Promise.all([send(), send()]);
    expect(modelsHits).toBe(2);
    expect(captured.map(body => body.model)).toEqual(["gpt-6.10-luna", "gpt-6.10-luna"]);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("a failed paginated discovery is retried on the next request instead of pinning partial data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-retry-"));
  let failPage2 = true;
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      if (url.searchParams.get("cursor") === "page2") {
        if (failPage2) return Response.json({ error: "boom" }, { status: 500 });
        return Response.json({ models: [aliasModel("gpt-6.10-luna")] });
      }
      return Response.json({ models: [aliasModel("gpt-6.9-luna")], next_cursor: "page2" });
    }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const send = () => fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
  try {
    expect((await send()).status).toBe(502);
    expect(captured).toHaveLength(0);
    failPage2 = false;
    const second = await send();
    expect(second.status).toBe(200);
    await second.text();
    expect(captured.map(body => body.model)).toEqual(["gpt-6.10-luna"]);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("has_more without a usable continuation fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-hasmore-empty-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [], has_more: true });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("without a usable continuation");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("metadata-only catalog entries without versions fail actionably through the proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-meta-ambig-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [{ slug: "provider-luna-a", family: "luna" }, { slug: "provider-luna-b", family: "luna" }] });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("cannot be ordered by version");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("an empty proxied /models after a failed discovery does not pin partial catalog data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-empty-after-fail-"));
  let failPage2 = true;
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      if (req.headers.get("x-test-empty")) return Response.json({ models: [] });
      if (url.searchParams.get("cursor") === "page2") {
        if (failPage2) return Response.json({ error: "boom" }, { status: 500 });
        return Response.json({ models: [aliasModel("gpt-6.10-luna")] });
      }
      return Response.json({ models: [aliasModel("gpt-6.9-luna")], next_cursor: "page2" });
    }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  const send = () => fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
  try {
    expect((await send()).status).toBe(502);
    await fetch(`http://127.0.0.1:${proxy.port}/models`, { headers: { "x-test-empty": "1" } }).then(r => r.text());
    failPage2 = false;
    const second = await send();
    expect(second.status).toBe(200);
    await second.text();
    expect(captured.map(body => body.model)).toEqual(["gpt-6.10-luna"]);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("a proxied /models during in-flight discovery does not pin before pagination completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-models-race-"));
  const captured: CodexBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      if (req.headers.get("x-test-complete")) return Response.json({ models: [aliasModel("gpt-6.9-luna")] });
      if (url.searchParams.get("cursor") === "page2") { await Bun.sleep(150); return Response.json({ models: [aliasModel("gpt-6.10-luna")] }); }
      return Response.json({ models: [aliasModel("gpt-6.9-luna")], next_cursor: "page2" });
    }
    const body = await req.json() as CodexBody;
    captured.push(body);
    return Response.json({ model: body.model, usage: { input_tokens_details: { cached_tokens: 0 } } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const pending = fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    await Bun.sleep(30);
    await fetch(`http://127.0.0.1:${proxy.port}/models`, { headers: { "x-test-complete": "1" } }).then(r => r.text());
    const response = await pending;
    expect(response.status).toBe(200);
    await response.text();
    expect(captured.map(body => body.model)).toEqual(["gpt-6.10-luna"]);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("catalog pagination cycles fail closed with a distinct message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-latest-cycle-"));
  let responsesHits = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [aliasModel("gpt-6.9-luna")], next_cursor: "loop" });
    responsesHits++;
    return Response.json({ model: "should-not-run" });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const proxy = startProxy(latestFastConfig(), { route: async input => result(input, "fast", "low"), apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("pagination cycle detected");
    expect(responsesHits).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});
