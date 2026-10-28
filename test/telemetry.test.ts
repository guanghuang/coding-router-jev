import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelemetry, extractUsage } from "../src/telemetry";
import { observeStream } from "../src/stream";
import { startProxy, AUTO_MODEL } from "../src/proxy";
import { configFromEnv } from "../src/config";
import { buildRequest } from "../src/router";

const frame = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
const response = { status: "completed", model: "reported-model", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 110 } };

test("terminal snapshots are not summed and conflicting observations are withheld", async () => {
  const event = { type: "response.completed", response };
  const observed: unknown[] = [];
  const stream = new Response(frame(event) + frame(event)).body!;
  await new Response(observeStream(stream, "model", undefined, () => {}, (status, usage) => observed.push({ status, usage }))).text();
  expect(observed).toEqual([{ status: "completed", usage: extractUsage(response) }]);
  const conflict: unknown[] = [];
  const next = { type: "response.completed", response: { ...response, usage: { input_tokens: 999 } } };
  await new Response(observeStream(new Response(frame(event) + frame(next)).body!, "model", undefined, () => {}, (status, usage) => conflict.push({ status, usage }))).text();
  expect(conflict).toEqual([{ status: "conflicting_terminal_events", usage: null }]);
});

test("disabled telemetry never writes a file", async () => {
  const telemetry = createTelemetry();
  expect(telemetry.enabled).toBe(false);
  const id = telemetry.start("model", "low");
  telemetry.finish(id, "completed", extractUsage(response));
});

test("missing and failed terminals remain distinct from zero usage", async () => {
  const observed: unknown[] = [];
  await new Response(observeStream(new Response(frame({ type: "response.created" })).body!, "model", undefined, () => {}, (status, usage) => observed.push({ status, usage }))).text();
  await new Response(observeStream(new Response(frame({ type: "response.failed", response: { status: "failed" } })).body!, "model", undefined, () => {}, (status, usage) => observed.push({ status, usage }))).text();
  expect(observed).toEqual([{ status: "incomplete", usage: null }, { status: "failed", usage: null }]);
});

test("terminal usage survives downstream cancellation and later conflicts are flagged", async () => {
  const encoder = new TextEncoder();
  const event = { type: "response.completed", response };
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(frame(event))); } });
  const observed: string[] = [];
  const reader = observeStream(stream, "model", undefined, () => {}, status => observed.push(status)).getReader();
  await reader.read();
  await reader.cancel();
  expect(observed).toEqual(["completed"]);
  let conflicts = 0;
  const twoFrames = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(frame(event))); controller.enqueue(encoder.encode(frame({ type: "response.completed", response: { ...response, usage: { input_tokens: 999 } } }))); controller.close(); } });
  await new Response(observeStream(twoFrames, "model", undefined, () => {}, () => {}, () => conflicts++)).text();
  expect(conflicts).toBe(1);
});

test("cancellation before terminal leaves usage unobserved", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(frame({ type: "response.created" }))); } });
  const observed: string[] = [];
  const reader = observeStream(stream, "model", undefined, () => {}, status => observed.push(status)).getReader();
  await reader.read();
  await reader.cancel();
  expect(observed).toEqual([]);
});

test("proxy writes only metadata for concurrent requests, retries, continuations and failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-telemetry-"));
  const telemetryPath = join(directory, "telemetry.jsonl");
  const upstream = Bun.serve({ port: 0, fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ models: [] });
    if (req.headers.has("x-fail")) return new Response("private failure body", { status: 500 });
    return new Response(frame({ type: "response.completed", response }), { headers: { "content-type": "text/event-stream" } });
  } });
  const config = configFromEnv({ CODING_ROUTER_FAST_MODEL_CODEX: "model-a", CODING_ROUTER_BALANCED_MODEL_CODEX: "model-b", CODING_ROUTER_STRONG_MODEL_CODEX: "model-c" });
  const proxy = startProxy(config, { telemetryPath, logDirectory: directory, apiBaseURL: `http://127.0.0.1:${upstream.port}`, route: async input => ({ request: buildRequest(input), ms: 1, response: { model: "fake", usage: { input_tokens: 3, output_tokens: 2 }, answers: { model: { type: "choice", choice: "fast", confidence: 0.9, probabilities: {} } } } }) });
  const send = (input: object[], model = AUTO_MODEL, fail = false) => fetch(`http://127.0.0.1:${proxy.port}/responses`, { method: "POST", headers: { authorization: "Bearer private-token", ...(fail ? { "x-fail": "1" } : {}) }, body: JSON.stringify({ model, prompt_cache_key: "private-session", input }) }).then(r => r.text());
  try {
    const prompt = { role: "user", content: "private prompt" };
    await Promise.all([send([prompt]), send([prompt])]);
    await send([prompt, { type: "function_call_output", output: "private tool output" }]);
    await send([prompt], "model-b");
    await send([prompt], AUTO_MODEL, true);
    await send([prompt]);
    const text = await readFile(telemetryPath, "utf8");
    expect(text).not.toContain("private");
    const records = text.trim().split("\n").map(line => JSON.parse(line));
    const starts = records.filter(record => record.kind === "request_start");
    const ends = records.filter(record => record.kind === "request_end");
    expect(starts).toHaveLength(6);
    expect(ends).toHaveLength(6);
    expect(new Set(starts.map(record => record.request_id)).size).toBe(6);
    expect(starts.some(record => record.request_kind === "tool_continuation")).toBe(true);
    expect(starts.some(record => record.model === "model-b")).toBe(true);
    expect(starts.filter(record => record.model === "model-b")[0].routing_mode).toBe("explicit_model");
    expect(starts.filter(record => record.model === "model-a").every(record => record.routing_mode === "automatic")).toBe(true);
    expect(ends.filter(record => record.status === "http_failure")).toHaveLength(1);
    expect(ends.filter(record => record.status === "completed")[0].usage.cached_input_tokens).toBe(20);
    expect(ends.filter(record => record.status === "completed")[0].reported_model).toBe("reported-model");
    expect(records.some(record => record.kind === "routing_decision" && record.classifier_usage.input_tokens === 3)).toBe(true);
  } finally { proxy.close(); upstream.stop(true); await rm(directory, { recursive: true, force: true }); }
});
