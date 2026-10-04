import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configFromEnv } from "../src/config";
import { AUTO_MODEL, startProxy, summarizeCacheRun } from "../src/proxy";
import { buildRequest, type Route, type RoutingInput } from "../src/router";
import type { CodexBody, Item } from "../src/types";

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
    await send([{ role: "user", content: "# AGENTS.md instructions\n\n<INSTRUCTIONS>Repository rules</INSTRUCTIONS><environment_context>cwd: /repo</environment_context>" }]);
    expect(inputs).toHaveLength(0);
    const first: Item = { role: "user", content: "implement first" };
    const duplicate = await Promise.all([send([first]), send([first])]);
    expect(inputs).toHaveLength(1);
    expect(duplicate.filter(output => output.includes("[Jev]")).length).toBe(1);
    expect(captured[1].body.model).toBe("gpt-6.1-sol");
    expect(captured[0].auth).toBe("Bearer fake-auth");
    await send([first, { type: "function_call_output", call_id: "call", output: "done" }]);
    expect(inputs).toHaveLength(1);
    const second: Item = { role: "user", content: "debug second" };
    await send([first, { role: "assistant", content: "previous answer" }, second]);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].recentContext?.previous_assistant_excerpt).toBe("previous answer");
    expect(inputs[1].cache?.window).toBe("up to 1 hour, stopping at the most recent model switch");
    expect(inputs[1].cache?.observed_responses).toBeGreaterThanOrEqual(0);
    const last = captured.at(-1)!.body;
    expect(last.reasoning?.effort).toBe("low");
    expect((last.input as Item[]).some(item => item.type === "configuration_update" && item.reasoning?.effort === "high")).toBe(true);
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
  const proxy = startProxy(configFromEnv({ CODING_ROUTER_SEND_RECENT_CONTEXT: "false" }), {
    apiBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory, onNotice: notice => notices.push(notice),
    route: async input => { seen = input; return { request: buildRequest(input), response: null, error: "timeout", ms: 3000 }; },
  });
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/v1/responses`, { method: "POST", body: JSON.stringify({ model: AUTO_MODEL, input: [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }, { role: "user", content: "continue" }] }) }).then(res => res.text());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[Jev] tier: strong, model: chatgpt-6.1-sol, effort: medium; decision: JEV/unavailable, confidence: unavailable.");
    expect(seen?.recentContext).toBeUndefined();
    expect(forwarded?.model).toBe("chatgpt-6.1-sol");
    const record = JSON.parse((await readFile(proxy.logPath, "utf8")).trim());
    expect(record.decision.reason).toBe("jev-unavailable/no-change");
    expect(record.jev.error).toBe("timeout");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("custom feedback format with all placeholders verified through proxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-feedback-"));
  const notices: string[] = [];
  let turnCount = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 42, cache_write_tokens: 7 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const format = "[Jev] {tier} · {model} · {effort} · {decision} · {confidence} · prev:{previous_model} · cr:{cache_read} · cw:{cache_write} · jin:{jev_tokens_input} · jout:{jev_tokens_output} · jtotal:{jev_tokens}";
  const config = configFromEnv({ CODING_ROUTER_FEEDBACK_FORMAT: format });
  const route: Route = async input => { turnCount++; return turnCount === 1 ? result(input, "strong", "high") : result(input, "balanced", "low"); };
  const proxy = startProxy(config, { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory, onNotice: notice => notices.push(notice) });
  const send = (input: Item[]) => fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: AUTO_MODEL, input }) }).then(r => r.text());
  try {
    await fetch(`http://127.0.0.1:${proxy.port}/models`).then(r => r.json());
    const first: Item = { role: "user", content: "hello" };
    await send([first]);
    expect(notices).toHaveLength(1);
    // Turn 1: verify ALL placeholders including jev_tokens_input/output (M1+M3)
    expect(notices[0]).toBe("[Jev] strong · gpt-6.1-sol · high · JEV/no-change · 0.90 · prev:gpt-6.1-sol · cr:unavailable · cw:unavailable · jin:1 · jout:1 · jtotal:2");
    // Turn 2: routes to balanced; previous_model should reflect model from turn 1 (M2)
    const second: Item = { role: "user", content: "follow up" };
    await send([first, { role: "assistant", content: "answer" }, second]);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toBe("[Jev] balanced · gpt-6.1-sol · low · JEV · 0.90 · prev:gpt-6.1-sol · cr:42 · cw:7 · jin:1 · jout:1 · jtotal:2");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("malformed JEV usage fields render as unavailable in feedback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-jev-malformed-"));
  const notices: string[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 10 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const config = configFromEnv({ CODING_ROUTER_FEEDBACK_FORMAT: "jin:{jev_tokens_input} jout:{jev_tokens_output} jtotal:{jev_tokens}" });
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
  const proxy = startProxy(configFromEnv({}), { apiBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
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
      { slug: "gpt-6.1-sol", display_name: "Sol", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] },
    ] });
    const body = await req.json() as CodexBody;
    captured.push({ body });
    return new Response(`event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { model: body.model, usage: { input_tokens_details: { cached_tokens: 10 } } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const format = "Router: {model} ({tier}) effort={effort}";
  const route: Route = async input => result(input, "strong", "high");
  const proxy = startProxy(configFromEnv({ CODING_ROUTER_FEEDBACK_FORMAT: format }), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
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
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
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
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
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
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
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
  const proxy = startProxy(configFromEnv({}), { route, apiBaseURL: base, chatgptBaseURL: base, logDirectory: directory });
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
