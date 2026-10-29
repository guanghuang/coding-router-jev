import { expect, test } from "bun:test";
import { filterFeedbackEcho } from "../src/stream";

const encode = (value: unknown) => `event: ${(value as any).type}\ndata: ${JSON.stringify(value)}\n\n`;
async function run(text: string, format?: string) {
  const id = "msg_upstream";
  const item = { id, type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text }] };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text.slice(0, 12) },
    { type: "response.output_text.delta", item_id: id, delta: text.slice(12) },
    { type: "response.output_text.done", item_id: id, text },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { output: [item] } },
  ].map(encode).join("");
  const bytes = new TextEncoder().encode(events);
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } });
  return new Response(filterFeedbackEcho(stream, format)).text();
}

test("removes split configured feedback prefix while keeping commentary and completion consistent", async () => {
  const output = await run("[Route] model=sol confidence=0.45\nUseful text", "[Route] model={model} confidence={confidence}");
  expect(output).not.toContain("confidence=0.45");
  expect(output).toContain("Useful text");
});

test("preserves nonmatching commentary and removes echo-only messages", async () => {
  expect(await run("Normal commentary")).toContain("Normal commentary");
  const echo = "[Jev] tier: balanced, model: gpt-6.1-terra, effort: low; decision: JEV/no-change, confidence: 0.45.";
  const output = await run(echo);
  expect(output).not.toContain("confidence: 0.45");
  expect(output).toContain('"output":[]');
});
