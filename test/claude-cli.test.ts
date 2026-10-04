import { expect, test } from "bun:test";
import { claudeArgs, CLAUDE_SENTINEL } from "../src/claude-proxy";

test("launch args include sentinel model when no explicit model or ANTHROPIC_MODEL", () => {
  const built = claudeArgs(["--print", "hello world"], {});
  expect(built).toEqual(["--model", CLAUDE_SENTINEL, "--print", "hello world"]);
});

test("launch args omit sentinel when --model is provided", () => {
  const built = claudeArgs(["--model", "claude-opus-4-20250514", "--print", "hi"], {});
  expect(built).toEqual(["--model", "claude-opus-4-20250514", "--print", "hi"]);
  expect(built.filter(a => a === CLAUDE_SENTINEL)).toHaveLength(0);
});

test("launch args omit sentinel when -m is provided", () => {
  const built = claudeArgs(["-m", "claude-opus-4-20250514"], {});
  expect(built).toEqual(["-m", "claude-opus-4-20250514"]);
});

test("launch args omit sentinel when --model= is used", () => {
  const built = claudeArgs(["--model=claude-opus-4-20250514"], {});
  expect(built).toEqual(["--model=claude-opus-4-20250514"]);
});

test("launch args omit sentinel for -mmodel shorthand", () => {
  const built = claudeArgs(["-mclaude-opus-4-20250514"], {});
  expect(built).toEqual(["-mclaude-opus-4-20250514"]);
});

test("launch args omit sentinel when ANTHROPIC_MODEL env is set", () => {
  const built = claudeArgs(["--print", "hi"], { ANTHROPIC_MODEL: "claude-opus-4-20250514" });
  expect(built).toEqual(["--print", "hi"]);
});

test("launch args include sentinel when ANTHROPIC_MODEL is empty or whitespace", () => {
  expect(claudeArgs([], { ANTHROPIC_MODEL: "" })).toEqual(["--model", CLAUDE_SENTINEL]);
  expect(claudeArgs([], { ANTHROPIC_MODEL: "  " })).toEqual(["--model", CLAUDE_SENTINEL]);
});

test("arguments are passed verbatim without shell interpolation", () => {
  const tricky = ["--print", "echo $HOME && rm -rf /", "--verbose"];
  const built = claudeArgs(tricky, {});
  expect(built.slice(2)).toEqual(tricky);
});

test("empty args produces only sentinel model", () => {
  const built = claudeArgs([], {});
  expect(built).toEqual(["--model", CLAUDE_SENTINEL]);
});
