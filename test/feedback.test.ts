import { describe, expect, test } from "bun:test";
import { DEFAULT_FEEDBACK_FORMAT, formatFeedback, type FeedbackValues } from "../src/feedback";

const base: FeedbackValues = {
  tier: "balanced",
  model: "gpt-6.1-sol",
  effort: "low",
  decision: "JEV",
  confidence: 0.9,
  previous_model: "chatgpt-6.1-sol",
  cache_read: 100,
  cache_write: 50,
  jev_tokens_input: 10,
  jev_tokens_output: 5,
};

describe("formatFeedback", () => {
  test("default feedback format produces detailed notice", () => {
    expect(formatFeedback(undefined, base)).toBe(
      "[Jev] tier: balanced, model: gpt-6.1-sol, effort: low; decision: JEV, confidence: 0.90.",
    );
  });

  test("custom format with all placeholders", () => {
    const format =
      "[Jev] {tier} · {model} · effort:{effort} · {decision} · confidence:{confidence} · prev:{previous_model} · cr:{cache_read} · cw:{cache_write} · jin:{jev_tokens_input} · jout:{jev_tokens_output} · jtotal:{jev_tokens}";
    expect(formatFeedback(format, base)).toBe(
      "[Jev] balanced · gpt-6.1-sol · effort:low · JEV · confidence:0.90 · prev:chatgpt-6.1-sol · cr:100 · cw:50 · jin:10 · jout:5 · jtotal:15",
    );
  });

  test("missing effort renders as 'default'", () => {
    const values = { ...base, effort: undefined };
    expect(formatFeedback("{model} · {effort}", values)).toBe("gpt-6.1-sol · default");
  });

  test("null confidence renders as 'unavailable'", () => {
    const values = { ...base, confidence: null };
    expect(formatFeedback("{confidence}", values)).toBe("unavailable");
  });

  test("null cache values render as 'unavailable'", () => {
    const values = { ...base, cache_read: null, cache_write: null };
    const result = formatFeedback("{cache_read} {cache_write}", values);
    expect(result).toBe("unavailable unavailable");
  });

  test("undefined jev_tokens_input/output render as 'unavailable'", () => {
    const values = { ...base, jev_tokens_input: undefined, jev_tokens_output: undefined };
    const result = formatFeedback("{jev_tokens_input} {jev_tokens_output} {jev_tokens}", values);
    expect(result).toBe("unavailable unavailable unavailable");
  });

  test("jev_tokens total is unavailable when only one field present", () => {
    const values = { ...base, jev_tokens_output: undefined };
    expect(formatFeedback("{jev_tokens}", values)).toBe("unavailable");
  });

  test("jev_tokens total computed when both fields present", () => {
    expect(formatFeedback("{jev_tokens}", base)).toBe("15");
  });

  test("unknown placeholders are left as-is", () => {
    expect(formatFeedback("{unknown} {also_unknown}", base)).toBe("{unknown} {also_unknown}");
  });

  test("format with no placeholders returns literal text", () => {
    expect(formatFeedback("[Jev] static notice", base)).toBe("[Jev] static notice");
  });

  test("zero values are rendered, not treated as missing", () => {
    const values = { ...base, confidence: 0, cache_read: 0, cache_write: 0, jev_tokens_input: 0, jev_tokens_output: 0 };
    const result = formatFeedback("{confidence} {cache_read} {cache_write} {jev_tokens_input} {jev_tokens_output} {jev_tokens}", values);
    expect(result).toBe("0.00 0 0 0 0 0");
  });

  test("repeated placeholders are all substituted", () => {
    expect(formatFeedback("{tier}-{tier}", base)).toBe("balanced-balanced");
  });

  test("jev_tokens unavailable when only jev_tokens_input is missing", () => {
    const values = { ...base, jev_tokens_input: undefined };
    expect(formatFeedback("{jev_tokens}", values)).toBe("unavailable");
  });

  test("DEFAULT_FEEDBACK_FORMAT constant matches the legacy format", () => {
    expect(DEFAULT_FEEDBACK_FORMAT).toBe("[Jev] tier: {tier}, model: {model}, effort: {effort}; decision: {decision}, confidence: {confidence}.");
  });
});


test("formatStatus uses its independent model/effort format", async () => {
  const { formatStatus } = await import("../src/feedback");
  expect(formatStatus("gpt-6-luna", "low")).toBe("[Jev] gpt-6-luna · low");
  expect(formatStatus("gpt-6-luna", "low", "{model} . {effort}")).toBe("gpt-6-luna . low");
});
