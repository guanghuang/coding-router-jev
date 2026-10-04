import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configFromEnv } from "../src/config";
import { AUTO_MODEL, startProxy } from "../src/proxy";
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
    expect(inputs[1].cache?.last_response_model).toBe("gpt-6.1-sol");
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
