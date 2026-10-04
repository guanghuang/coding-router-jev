import { createHash } from "node:crypto";
import type { CodexBody, Item, RecentContext } from "./types";

const JEV_ID_RE = /^jev-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJevNotice = (item: Item): boolean =>
  item.role === "assistant" && typeof item.id === "string" && JEV_ID_RE.test(item.id);

export const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
export function textOf(item: Item): string {
  const text = typeof item.content === "string" ? item.content :
    item.content?.filter(part => ["text", "input_text", "output_text"].includes(part.type ?? "")).map(part => part.text ?? "").join("\n") ?? "";
  return text.replace(/^\s*# AGENTS\.md instructions[^\n]*\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/i, "")
    .replace(/<(system[-_]reminder|environment_context|current_datetime)>[\s\S]*?<\/\1>/gi, "")
    .split("\n").filter(line => !line.trim().startsWith("[Jev]")).join("\n").trim();
}
export const auxiliary = (text: string) => /^Generate a concise, single-line task title\b/i.test(text) || /^Write a brief catch-up for a user returning to this task\b/i.test(text);
export function userAnchors(input: Item[]): Map<number, string> {
  const users: string[] = [];
  const anchors = new Map<number, string>();
  input.forEach((item, index) => {
    if (item.role === "user" && textOf(item)) {
      users.push(textOf(item));
      anchors.set(index, hash(JSON.stringify(users)));
    }
  });
  return anchors;
}
export function newTurn(body: CodexBody): { prompt: string; anchor: string } | undefined {
  if (typeof body.input === "string") {
    const prompt = textOf({ role: "user", content: body.input });
    return !prompt || auxiliary(prompt) ? undefined : { prompt, anchor: hash(prompt) };
  }
  if (!Array.isArray(body.input)) return;
  const anchors = userAnchors(body.input);
  for (let i = body.input.length - 1; i >= 0; i--) {
    const item = body.input[i];
    if (["function_call_output", "custom_tool_call_output", "function_call", "custom_tool_call"].includes(item.type ?? "")) return;
    if (item.role === "assistant" && textOf(item)) return;
    if (item.role !== "user") continue;
    const prompt = textOf(item);
    if (prompt && !auxiliary(prompt)) return { prompt, anchor: anchors.get(i)! };
  }
}
export function recentContext(body: CodexBody): RecentContext | undefined {
  if (!Array.isArray(body.input)) return;
  const messages = body.input.filter(item => ["user", "assistant"].includes(item.role ?? "") && textOf(item) && !auxiliary(textOf(item)));
  const current = messages.findLastIndex(item => item.role === "user");
  const previous = messages.slice(0, current).findLastIndex(item => item.role === "user");
  if (previous < 0) return;
  const assistant = messages.slice(previous + 1, current).findLast(item => item.role === "assistant");
  return { previous_user_request: textOf(messages[previous]).slice(0, 1000), ...(assistant ? { previous_assistant_excerpt: textOf(assistant).slice(0, 1000) } : {}) };
}
export function conversationKey(body: CodexBody, headers: Headers): string {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(String(body.client_metadata?.["x-codex-turn-metadata"] ?? "{}")); } catch {}
  const id = body.prompt_cache_key ?? headers.get("session_id") ?? headers.get("x-codex-session-id") ?? metadata.thread_id ?? metadata.conversation_id;
  const firstUser = Array.isArray(body.input) ? textOf(body.input.find(item => item.role === "user") ?? {}) : body.input;
  return hash(String(id ?? `${body.instructions ?? ""}|${firstUser ?? ""}`));
}
