export const DEFAULT_FEEDBACK_FORMAT =
  "[Jev] tier: {tier}, model: {model}, effort: {effort}; decision: {decision}, confidence: {confidence}.";

export type FeedbackValues = {
  tier: string;
  model: string;
  effort: string | undefined;
  decision: string;
  confidence: number | null;
  previous_model: string;
  cache_read: number | null;
  cache_write: number | null;
  jev_tokens_input: number | undefined;
  jev_tokens_output: number | undefined;
};

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

function renderValue(key: string, values: FeedbackValues): string {
  switch (key) {
    case "tier": return values.tier;
    case "model": return values.model;
    case "effort": return values.effort ?? "default";
    case "decision": return values.decision;
    case "confidence":
      return values.confidence === null ? "unavailable" : values.confidence.toFixed(2);
    case "previous_model": return values.previous_model;
    case "cache_read":
      return values.cache_read === null ? "unavailable" : String(values.cache_read);
    case "cache_write":
      return values.cache_write === null ? "unavailable" : String(values.cache_write);
    case "jev_tokens_input":
      return values.jev_tokens_input === undefined ? "unavailable" : String(values.jev_tokens_input);
    case "jev_tokens_output":
      return values.jev_tokens_output === undefined ? "unavailable" : String(values.jev_tokens_output);
    case "jev_tokens": {
      const input = values.jev_tokens_input;
      const output = values.jev_tokens_output;
      return input !== undefined && output !== undefined ? String(input + output) : "unavailable";
    }
    default: return `{${key}}`;
  }
}

export function formatFeedback(format: string | undefined, values: FeedbackValues): string {
  const template = format ?? DEFAULT_FEEDBACK_FORMAT;
  return template.replace(PLACEHOLDER_RE, (_, key: string) => renderValue(key, values));
}
