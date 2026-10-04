import { randomUUID } from "node:crypto";

export type Usage = { model: string; read: number | null; created: number | null; responseId?: string };
function usageOf(response: Record<string, unknown>, fallback: string): Usage {
  const usage = response.usage as { input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } } | undefined;
  const details = usage?.input_tokens_details;
  return { model: typeof response.model === "string" ? response.model : fallback, read: typeof details?.cached_tokens === "number" ? details.cached_tokens : null, created: typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : null, ...(typeof response.id === "string" ? { responseId: response.id } : {}) };
}
function noticeEvents(text: string): string {
  const id = `jev-${randomUUID()}`;
  const item = { type: "message", role: "assistant", id, phase: "commentary", content: [{ type: "output_text", text }] };
  return [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
export function observeStream(source: ReadableStream<Uint8Array>, model: string, notice: (() => string | undefined) | undefined, onUsage: (usage: Usage) => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let overflow = false;
  let completed: Usage | undefined;
  let notified = false;
  let prefix = Buffer.alloc(0);
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!notified) {
        prefix = Buffer.concat([prefix, chunk]);
        let end = prefix.indexOf("\n\n");
        let separator = 2;
        if (end < 0) { end = prefix.indexOf("\r\n\r\n"); separator = 4; }
        if (end >= 0) {
          controller.enqueue(prefix.subarray(0, end + separator));
          const first = prefix.subarray(0, end + separator).toString();
          const text = /^(?:event|data):/m.test(first) ? notice?.() : undefined;
          if (text) controller.enqueue(new TextEncoder().encode(noticeEvents(text)));
          controller.enqueue(prefix.subarray(end + separator));
          prefix = Buffer.alloc(0);
          notified = true;
        } else if (prefix.length > 65536) {
          controller.enqueue(prefix); prefix = Buffer.alloc(0); notified = true;
        }
      } else controller.enqueue(chunk);
      if (overflow) return;
      pending += decoder.decode(chunk, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      if (pending.length > 1024 * 1024) { overflow = true; pending = ""; }
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        try {
          const event = JSON.parse(data);
          if (event.type === "response.completed" && event.response?.status !== "failed") completed = usageOf(event.response, model);
        } catch {}
      }
    },
    flush(controller) { if (prefix.length) controller.enqueue(prefix); onUsage(completed ?? { model, read: null, created: null }); },
  }));
}
