export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: string; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | ClaudeContentBlock[] }
  | { type: string; [key: string]: unknown };

export type ClaudeMessage = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

export type ClaudeBody = {
  model: string;
  messages: ClaudeMessage[];
  max_tokens?: number;
  stream?: boolean;
  system?: string | { type: string; text: string }[];
  metadata?: Record<string, unknown>;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  [key: string]: unknown;
};

export type ClaudeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export function textOfBlock(block: ClaudeContentBlock): string {
  if (block.type === "text") return (block as { type: "text"; text: string }).text;
  return "";
}

export function textOfMessage(message: ClaudeMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(textOfBlock).filter(Boolean).join("\n");
}

/** Remove leading Claude Code annotations from routing text, not the provider request. */
export function routingTextOfMessage(message: ClaudeMessage): string {
  let text = textOfMessage(message).trim();
  if (message.role !== "user") return text;
  const annotation = /^<(system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>[\s\S]*?<\/\1>\s*/;
  while (annotation.test(text)) text = text.replace(annotation, "");
  return text.trim();
}

export function isToolResult(message: ClaudeMessage): boolean {
  if (typeof message.content === "string") return false;
  return message.content.some(block => block.type === "tool_result");
}
