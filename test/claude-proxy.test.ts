import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configFromEnv } from "../src/config";
import { CLAUDE_SENTINEL, startClaudeProxy, claudeArgs, claudeCandidatesFor } from "../src/claude-proxy";
import { buildRequest, type Route, type RoutingInput } from "../src/router";
import { textOfMessage, textOfBlock, isToolResult } from "../src/claude-types";
import type { ClaudeBody, ClaudeMessage } from "../src/claude-types";

function result(input: RoutingInput, tier: string) {
  return {
    request: buildRequest(input), ms: 1,
    response: {
      model: "fake-jev", usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        model: { type: "choice" as const, choice: tier, confidence: 0.9, probabilities: {} },
        reasoning_effort: { type: "choice" as const, choice: "medium", confidence: 0.9, probabilities: {} },
      },
    },
  };
}

function anthropicStream(model: string, text: string, cacheRead?: number): string {
  const usage: Record<string, number> = { input_tokens: 10, output_tokens: 5 };
  if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_" + Math.random().toString(36).slice(2), type: "message", role: "assistant", model, usage } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: text.length } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ].join("\n\n") + "\n\n";
}

function send(proxyPort: number, messages: ClaudeMessage[], model = CLAUDE_SENTINEL, stream = true) {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "fake-key", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, messages, max_tokens: 1024, stream } as ClaudeBody),
  });
}

test("routes once per new user intent, keeps tool continuations, and logs JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-proxy-"));
  const captured: { body: ClaudeBody; apiKey: string | null }[] = [];
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    captured.push({ body, apiKey: req.headers.get("x-api-key") });
    return new Response(anthropicStream(body.model, "Hello"), { headers: { "content-type": "text/event-stream" } });
  } });
  const base = `http://127.0.0.1:${upstream.port}`;
  const route: Route = async input => { inputs.push(input); return result(input, inputs.length === 1 ? "balanced" : "strong"); };
  const proxy = startClaudeProxy(configFromEnv({}), { route, upstreamBaseURL: base, logDirectory: directory });

  try {
    await (await send(proxy.port, [{ role: "user", content: "implement first" }])).text();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].agent).toBe("claude");
    expect(captured[0].body.model).toBe(configFromEnv({}).claudeModels.balanced);
    expect(captured[0].apiKey).toBe("fake-key");

    await (await send(proxy.port, [{ role: "user", content: "implement first" }])).text();
    expect(inputs).toHaveLength(1);

    await (await send(proxy.port, [
      { role: "user", content: "implement first" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }] },
    ])).text();
    expect(inputs).toHaveLength(1);

    await (await send(proxy.port, [
      { role: "user", content: "implement first" },
      { role: "assistant", content: "done" },
      { role: "user", content: "debug second" },
    ])).text();
    expect(inputs).toHaveLength(2);
    expect(inputs[1].recentContext?.previous_user_request).toBe("implement first");

    const records = (await readFile(proxy.logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].jev.request.questions.reasoning_required.type).toBe("score");
    expect(records[1].decision.tier).toBe("strong");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent duplicate requests route exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-concurrent-"));
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const route: Route = async input => { inputs.push(input); await Bun.sleep(5); return result(input, "balanced"); };
  const proxy = startClaudeProxy(configFromEnv({}), { route, upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory });
  try {
    const msg: ClaudeMessage = { role: "user", content: "implement concurrent" };
    await Promise.all([send(proxy.port, [msg]), send(proxy.port, [msg])]);
    expect(inputs).toHaveLength(1);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("physical model bypass preserves the explicit model without routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-bypass-"));
  const captured: ClaudeBody[] = [];
  let routeCalls = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    captured.push(await req.json() as ClaudeBody);
    return new Response(anthropicStream(captured.at(-1)!.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => { routeCalls++; return result(input, "fast"); },
  });
  try {
    await (await send(proxy.port, [{ role: "user", content: "hello" }], "claude-opus-4-20250514")).text();
    expect(routeCalls).toBe(0);
    expect(captured[0].model).toBe("claude-opus-4-20250514");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("separate sessions route independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-sessions-"));
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const route: Route = async input => { inputs.push(input); return result(input, "fast"); };
  const proxy = startClaudeProxy(configFromEnv({}), { route, upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory });
  try {
    const sendWithSystem = (system: string, content: string) =>
      fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "fake-key", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: CLAUDE_SENTINEL, messages: [{ role: "user", content }], system, max_tokens: 1024, stream: true }),
      }).then(r => r.text());

    await sendWithSystem("Session A context", "implement something");
    await sendWithSystem("Session B context", "implement something");
    expect(inputs).toHaveLength(2);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("streaming SSE format is preserved unchanged to client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-stream-"));
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "streamed text", 42), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await send(proxy.port, [{ role: "user", content: "hello" }]);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("message_start");
    expect(text).toContain("content_block_delta");
    expect(text).toContain("streamed text");
    expect(text).toContain("message_stop");
    expect(text).not.toContain("[Jev]");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("non-streaming JSON response passes through and extracts usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-json-"));
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return Response.json({
      id: "msg_test", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: "response" }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25 },
    });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await send(proxy.port, [{ role: "user", content: "hello" }], CLAUDE_SENTINEL, false);
    const data = await response.json();
    expect(data.content[0].text).toBe("response");
    expect(data.usage.cache_read_input_tokens).toBe(25);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("HEAD probe returns 200", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-head-"));
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: "http://127.0.0.1:1", logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: "HEAD" });
    expect(response.status).toBe(200);
  } finally { proxy.close(); await rm(directory, { recursive: true, force: true }); }
});

test("malformed JSON returns Anthropic-compatible error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-malformed-"));
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: "http://127.0.0.1:1", logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.type).toBe("error");
    expect(data.error.type).toBe("invalid_request_error");
  } finally { proxy.close(); await rm(directory, { recursive: true, force: true }); }
});

test("missing messages field returns 400", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-nomsg-"));
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: "http://127.0.0.1:1", logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: CLAUDE_SENTINEL, max_tokens: 1024 }),
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.message).toContain("messages");
  } finally { proxy.close(); await rm(directory, { recursive: true, force: true }); }
});

test("missing model field returns 400", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-nomodel-"));
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: "http://127.0.0.1:1", logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 1024 }),
    });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.message).toContain("model");
  } finally { proxy.close(); await rm(directory, { recursive: true, force: true }); }
});

test("empty messages array does not trigger routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-empty-"));
  let routeCalls = 0;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => { routeCalls++; return result(input, "fast"); },
  });
  try {
    await (await send(proxy.port, [])).text();
    expect(routeCalls).toBe(0);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("failed JEV call keeps current model and logs the error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-fallback-"));
  const notices: string[] = [];
  const captured: ClaudeBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    captured.push(body);
    return new Response(anthropicStream(body.model, "response"), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    onNotice: n => notices.push(n),
    route: async () => ({ request: buildRequest({ prompt: "x", currentTier: "fast", currentModel: "m", contextTokens: 0, candidates: [] }), response: null, error: "timeout", ms: 3000 }),
  });
  try {
    await (await send(proxy.port, [{ role: "user", content: "hello" }])).text();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("JEV/unavailable");
    expect(captured[0].model).toBe(configFromEnv({}).claudeModels.fast);
    const record = JSON.parse((await readFile(proxy.logPath, "utf8")).trim());
    expect(record.jev.error).toBe("timeout");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("onNotice callback fires once per turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-notice-"));
  const notices: string[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    onNotice: n => notices.push(n),
    route: async input => result(input, "balanced"),
  });
  try {
    await (await send(proxy.port, [{ role: "user", content: "first" }])).text();
    await (await send(proxy.port, [{ role: "user", content: "first" }])).text();
    expect(notices).toHaveLength(1);
    await (await send(proxy.port, [{ role: "user", content: "first" }, { role: "assistant", content: "r" }, { role: "user", content: "second" }])).text();
    expect(notices).toHaveLength(2);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("Bedrock transport is detected and rejected", () => {
  expect(() => startClaudeProxy(configFromEnv({}), { upstreamBaseURL: "https://bedrock-runtime.us-east-1.amazonaws.com" })).toThrow(/Bedrock/);
});

test("Vertex transport is detected and rejected", () => {
  expect(() => startClaudeProxy(configFromEnv({}), { upstreamBaseURL: "https://us-central1-aiplatform.googleapis.com" })).toThrow(/Vertex/);
});

test("claudeArgs builds correct arguments as string array", () => {
  const built = claudeArgs(["--print", "hello"], {});
  expect(built).toContain("--model");
  expect(built).toContain(CLAUDE_SENTINEL);
  expect(built).toContain("--print");

  const withModel = claudeArgs(["--model", "claude-opus-4-20250514"], {});
  expect(withModel.filter(a => a === CLAUDE_SENTINEL)).toHaveLength(0);
  expect(withModel).toContain("claude-opus-4-20250514");

  const withEnv = claudeArgs(["--print", "hi"], { ANTHROPIC_MODEL: "claude-opus-4-20250514" });
  expect(withEnv.filter(a => a === CLAUDE_SENTINEL)).toHaveLength(0);
});

test("claudeCandidatesFor uses config claudeModels", () => {
  const config = configFromEnv({});
  const candidates = claudeCandidatesFor(config);
  expect(candidates.length).toBeGreaterThanOrEqual(3);
  expect(candidates.every(c => c.id === config.claudeModels[c.tier])).toBe(true);
});

test("claudeCandidatesFor with longModelEnabled includes long tier", () => {
  const config = configFromEnv({ CODING_ROUTER_LONG_MODEL_ENABLE: "true" });
  const candidates = claudeCandidatesFor(config);
  expect(candidates.some(c => c.tier === "long")).toBe(true);
  expect(candidates).toHaveLength(4);
});

test("upstream prefix is preserved in forwarded requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-prefix-"));
  let requestPath = "";
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    requestPath = new URL(req.url).pathname;
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    await (await send(proxy.port, [{ role: "user", content: "test" }])).text();
    expect(requestPath).toBe("/v1/messages");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("disabled recent context omits recentContext from routing input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-no-ctx-"));
  let seen: RoutingInput | undefined;
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({ CODING_ROUTER_SEND_RECENT_CONTEXT: "false" }), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => { seen = input; return result(input, "fast"); },
  });
  try {
    await (await send(proxy.port, [
      { role: "user", content: "old" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "new" },
    ])).text();
    expect(seen?.recentContext).toBeUndefined();
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

// claude-types.ts helper unit tests
test("textOfBlock extracts text from text blocks and returns empty for others", () => {
  expect(textOfBlock({ type: "text", text: "hello" })).toBe("hello");
  expect(textOfBlock({ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } })).toBe("");
  expect(textOfBlock({ type: "tool_use", id: "t1", name: "fn", input: {} })).toBe("");
  expect(textOfBlock({ type: "tool_result", tool_use_id: "t1", content: "result" })).toBe("");
});

test("textOfMessage handles string and block array content", () => {
  expect(textOfMessage({ role: "user", content: "simple text" })).toBe("simple text");
  expect(textOfMessage({ role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] })).toBe("hello\nworld");
  expect(textOfMessage({ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }] })).toBe("");
  expect(textOfMessage({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fn", input: {} }, { type: "text", text: "explanation" }] })).toBe("explanation");
});

test("isToolResult detects tool_result blocks in user messages", () => {
  expect(isToolResult({ role: "user", content: "plain text" })).toBe(false);
  expect(isToolResult({ role: "user", content: [{ type: "text", text: "hi" }] })).toBe(false);
  expect(isToolResult({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] })).toBe(true);
  expect(isToolResult({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "nested" }] }] })).toBe(true);
});

// Claude model config overrides
test("Claude model overrides from environment", () => {
  const config = configFromEnv({
    CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-20250514",
    CODING_ROUTER_STRONG_MODEL_CLAUDE: "claude-opus-4-20250514",
  });
  expect(config.claudeModels.fast).toBe("claude-haiku-4-20250514");
  expect(config.claudeModels.balanced).toBe("claude-sonnet-4-20250514");
  expect(config.claudeModels.strong).toBe("claude-opus-4-20250514");
  expect(config.claudeModels.long).toBe("claude-sonnet-4-20250514");
});

test("Claude and Codex models are independent", () => {
  const config = configFromEnv({
    CODING_ROUTER_FAST_MODEL_CODEX: "codex-custom",
    CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-custom",
  });
  expect(config.codexModels.fast).toBe("codex-custom");
  expect(config.claudeModels.fast).toBe("claude-custom");
});

test("proxy error type is proxy_error, distinct from upstream api_error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-proxyerr-"));
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: "http://127.0.0.1:1", logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await send(proxy.port, [{ role: "user", content: "hello" }]);
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error.type).toBe("proxy_error");
  } finally { proxy.close(); await rm(directory, { recursive: true, force: true }); }
});

test("large context excludes small-capacity candidates from routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-eligibility-"));
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const config = configFromEnv({
    CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
    CODING_ROUTER_BALANCED_MODEL_CLAUDE: "claude-sonnet-5-5",
    CODING_ROUTER_STRONG_MODEL_CLAUDE: "claude-opus-5-5",
  });
  const route: Route = async input => { inputs.push(input); return result(input, "balanced"); };
  const proxy = startClaudeProxy(config, { route, upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory });
  try {
    // Large payload: ~300K chars → ~75K tokens estimate. Haiku (200K context - 8192 output = 191808 usable) should still be included.
    // But a truly oversized payload should exclude Haiku.
    const bigContent = "x".repeat(800_000); // ~200K tokens estimated
    await (await send(proxy.port, [{ role: "user", content: bigContent }])).text();
    expect(inputs).toHaveLength(1);
    // Haiku should be excluded from eligible candidates
    expect(inputs[0].candidates.every(c => c.id !== "claude-haiku-4-5-20251001")).toBe(true);
    // Sonnet 5.5 and Opus 5.5 (1M context) should still be available
    expect(inputs[0].candidates.some(c => c.id === "claude-sonnet-5-5")).toBe(true);
    expect(inputs[0].candidates.some(c => c.id === "claude-opus-5-5")).toBe(true);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("all candidates over capacity returns 400 with actionable error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-no-eligible-"));
  const config = configFromEnv({
    CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
    CODING_ROUTER_BALANCED_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
    CODING_ROUTER_STRONG_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
  });
  const proxy = startClaudeProxy(config, {
    upstreamBaseURL: "http://127.0.0.1:1", logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const bigContent = "x".repeat(800_000); // ~200K tokens > Haiku 200K capacity
    const response = await send(proxy.port, [{ role: "user", content: bigContent }]);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.message).toContain("No Claude model can fit");
    expect(data.error.message).toContain("Compact");
  } finally { proxy.close(); await rm(directory, { recursive: true, force: true }); }
});

test("effort normalization applies correct output_config on upstream body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-effort-"));
  const captured: ClaudeBody[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    captured.push(await req.json() as ClaudeBody);
    return new Response(anthropicStream(captured.at(-1)!.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const config = configFromEnv({
    CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-sonnet-5-5",
  });
  const route: Route = async input => ({
    request: buildRequest(input), ms: 1,
    response: {
      model: "fake-jev", usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        model: { type: "choice" as const, choice: "fast", confidence: 0.9, probabilities: {} },
        reasoning_effort: { type: "choice" as const, choice: "high", confidence: 0.9, probabilities: {} },
      },
    },
  });
  const proxy = startClaudeProxy(config, { route, upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory });
  try {
    await (await send(proxy.port, [{ role: "user", content: "hello" }])).text();
    expect(captured).toHaveLength(1);
    const body = captured[0] as Record<string, unknown>;
    expect((body.output_config as Record<string, unknown>)?.effort).toBe("high");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("physical model bypass preserves client-supplied effort for adaptive models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-bypass-effort-"));
  const captured: Record<string, unknown>[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    captured.push(await req.json() as Record<string, unknown>);
    return new Response(anthropicStream("claude-sonnet-5-5", "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fake-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hello" }], max_tokens: 1024, stream: true, output_config: { effort: "low" } }),
    });
    await response.text();
    // Client-supplied effort should be preserved, not overwritten to default
    expect((captured[0].output_config as Record<string, unknown>)?.effort).toBe("low");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("Haiku bypass strips incompatible effort from output_config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-haiku-strip-"));
  const captured: Record<string, unknown>[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    captured.push(await req.json() as Record<string, unknown>);
    return new Response(anthropicStream("claude-haiku-4-5-20251001", "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const proxy = startClaudeProxy(configFromEnv({}), {
    upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory,
    route: async input => result(input, "fast"),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fake-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hello" }], max_tokens: 1024, stream: true, output_config: { effort: "high" } }),
    });
    await response.text();
    // Haiku is budgeted: incompatible effort field should be stripped
    const oc = captured[0].output_config as Record<string, unknown> | undefined;
    expect(oc?.effort).toBeUndefined();
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("Claude override alias 'use sonnet' triggers override decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-alias-"));
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const config = configFromEnv({
    CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-haiku-4-5-20251001",
    CODING_ROUTER_BALANCED_MODEL_CLAUDE: "claude-sonnet-5-5",
    CODING_ROUTER_STRONG_MODEL_CLAUDE: "claude-opus-5-5",
  });
  const captured: ClaudeBody[] = [];
  const route: Route = async input => { inputs.push(input); return result(input, "fast"); };
  const proxy = startClaudeProxy(config, { route, upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fake-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CLAUDE_SENTINEL, messages: [{ role: "user", content: "use sonnet to fix this" }], max_tokens: 1024, stream: true } as ClaudeBody),
    });
    await response.text();
    expect(inputs).toHaveLength(1);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});

test("currentEffort propagates previous turn's effective effort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-jev-effort-prop-"));
  const inputs: RoutingInput[] = [];
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json() as ClaudeBody;
    return new Response(anthropicStream(body.model, "ok"), { headers: { "content-type": "text/event-stream" } });
  } });
  const config = configFromEnv({
    CODING_ROUTER_FAST_MODEL_CLAUDE: "claude-sonnet-5-5",
  });
  const route: Route = async input => {
    inputs.push(input);
    return {
      request: buildRequest(input), ms: 1,
      response: {
        model: "fake-jev", usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          model: { type: "choice" as const, choice: "fast", confidence: 0.9, probabilities: {} },
          reasoning_effort: { type: "choice" as const, choice: "high", confidence: 0.9, probabilities: {} },
        },
      },
    };
  };
  const proxy = startClaudeProxy(config, { route, upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, logDirectory: directory });
  try {
    await (await send(proxy.port, [{ role: "user", content: "first turn" }])).text();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].currentEffort).toBeUndefined();

    await (await send(proxy.port, [
      { role: "user", content: "first turn" },
      { role: "assistant", content: "done" },
      { role: "user", content: "second turn" },
    ])).text();
    expect(inputs).toHaveLength(2);
    expect(inputs[1].currentEffort).toBe("high");
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});
