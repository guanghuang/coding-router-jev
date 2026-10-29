import { randomUUID } from "node:crypto";
import { DEFAULT_FEEDBACK_FORMAT } from "./feedback";

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

/** Remove only a matching prefix from upstream assistant commentary items. */
export function filterFeedbackEcho(source: ReadableStream<Uint8Array>, format?: string): ReadableStream<Uint8Array> {
  const template = format ?? DEFAULT_FEEDBACK_FORMAT;
  const parts = template.split(/(\{[a-z_]+\})/g);
  const literal = parts.filter(p => !/^\{[a-z_]+\}$/.test(p)).join("");
  // A template without a distinctive literal cannot safely identify an echo.
  if (literal.trim().length < 4 || !parts[0]) return source;
  const pattern = new RegExp("^" + parts.map(p => /^\{[a-z_]+\}$/.test(p) ? "[^\r\n]+?" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "(?=\r?\n|$)");
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let itemId: string | undefined;
  let frames: { raw: string; event: any }[] = [];
  let size = 0;
  const removed = new Map<string, string>();
  const frame = (event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  function strip(text: string, prefix: string): string { return text.startsWith(prefix) ? text.slice(prefix.length).replace(/^\r?\n/, "") : text; }
  function cleanItem(item: any, prefix: string) {
    if (!Array.isArray(item?.content)) return;
    for (const part of item.content) if (typeof part.text === "string") { part.text = strip(part.text, prefix); break; }
  }
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const chunks = pending.split(/\r?\n\r?\n/); pending = chunks.pop() ?? "";
      for (const raw of chunks) {
        let event: any;
        try { event = JSON.parse(raw.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")); }
        catch { controller.enqueue(encoder.encode(raw + "\n\n")); continue; }
        if (!itemId && event.type === "response.output_item.added" && event.item?.type === "message" && event.item.role === "assistant" && event.item.phase === "commentary" && typeof event.item.id === "string" && !event.item.id.startsWith("jev-")) itemId = event.item.id;
        if (itemId) {
          frames.push({ raw, event }); size += raw.length;
          if (size > 1024 * 1024) { for (const f of frames) controller.enqueue(encoder.encode(f.raw + "\n\n")); frames = []; size = 0; itemId = undefined; continue; }
          const currentText = frames.filter(f => f.event.type === "response.output_text.delta" && f.event.item_id === itemId).map(f => f.event.delta ?? "").join("");
          if (currentText && !parts[0].startsWith(currentText) && !currentText.startsWith(parts[0])) {
            for (const f of frames) controller.enqueue(encoder.encode(f.raw + "\n\n"));
            frames = []; size = 0; itemId = undefined; continue;
          }
          if (event.type !== "response.output_item.done" || event.item?.id !== itemId) continue;
          const text = frames.filter(f => f.event.type === "response.output_text.delta" && f.event.item_id === itemId).map(f => f.event.delta ?? "").join("");
          const match = pattern.exec(text);
          if (!match) { for (const f of frames) controller.enqueue(encoder.encode(f.raw + "\n\n")); }
          else {
            const prefix = match[0] + (text.slice(match[0].length).startsWith("\r\n") ? "\r\n" : text.slice(match[0].length).startsWith("\n") ? "\n" : "");
            let remaining = prefix.length;
            removed.set(itemId, prefix);
            const empty = text.slice(prefix.length).length === 0;
            for (const f of frames) {
              const e = f.event;
              if (empty && (e.item_id === itemId || e.item?.id === itemId)) continue;
              if (e.type === "response.output_text.delta" && e.item_id === itemId && typeof e.delta === "string") { const n = Math.min(remaining, e.delta.length); e.delta = e.delta.slice(n); remaining -= n; if (!e.delta) continue; }
              if (e.item_id === itemId && typeof e.text === "string") e.text = strip(e.text, prefix);
              if (e.item_id === itemId && typeof e.part?.text === "string") e.part.text = strip(e.part.text, prefix);
              if (e.item?.id === itemId) cleanItem(e.item, prefix);
              controller.enqueue(encoder.encode(frame(e)));
            }
          }
          frames = []; size = 0; itemId = undefined; continue;
        }
        if (event.type === "response.completed" && Array.isArray(event.response?.output)) {
          event.response.output = event.response.output.filter((item: any) => {
            const prefix = removed.get(item.id); if (!prefix) return true;
            cleanItem(item, prefix); return item.content?.some((part: any) => part.text !== "") ?? true;
          });
          controller.enqueue(encoder.encode(frame(event)));
        } else controller.enqueue(encoder.encode(raw + "\n\n"));
      }
    },
    flush(controller) { for (const f of frames) controller.enqueue(encoder.encode(f.raw + "\n\n")); if (pending) controller.enqueue(encoder.encode(pending)); },
  }));
}
