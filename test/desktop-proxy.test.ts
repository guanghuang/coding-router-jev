import { expect, test } from "bun:test";
import { prependDesktopNotice } from "../src/stream";

test("proxy accepts a custom host and port", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop();
  const child = Bun.spawn([process.execPath, "run", "src/desktop-poc.ts", "--host", "0.0.0.0", "--port", String(port)], { env: { ...process.env, TYPESAFE_API_KEY: "test" }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const output = new TextDecoder().decode((await reader.read()).value);
    expect(output).toContain(`http://0.0.0.0:${port}`);
    reader.releaseLock();
  } finally { child.kill(); await child.exited; }
});

test("desktop feedback precedes the final answer and updates completed output", async () => {
  const events = [
    { type: "response.output_item.added", item: { id: "msg_1", type: "message", role: "assistant", phase: "final_answer", content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
    { type: "response.output_text.done", item_id: "msg_1", text: "Hello" },
    { type: "response.completed", response: { output: [{ id: "msg_1", content: [{ type: "output_text", text: "Hello" }] }] } },
  ];
  const input = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const source = new Response(input).body!;
  const result = await new Response(prependDesktopNotice(source, "[Jev] decision")).text();
  const frames = result.trim().split("\n\n").map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
  expect(frames[1].delta).toBe("[Jev] decision\n\nHello");
  expect(frames[2].text).toBe("[Jev] decision\n\nHello");
  expect(frames[3].response.output[0].content[0].text).toBe("[Jev] decision\n\nHello");
});
