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

export function isToolResult(message: ClaudeMessage): boolean {
  if (typeof message.content === "string") return false;
  return message.content.some(block => block.type === "tool_result");
}
