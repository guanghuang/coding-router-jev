import { expect, test } from "bun:test";
import { claudeArgs } from "../src/claude-proxy";
import { CLAUDE_SENTINEL } from "../src/claude-proxy";

test("launch args include sentinel model and ANTHROPIC_BASE_URL when no explicit model", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["--print", "hello world"]);
  expect(built.args).toEqual(["--model", CLAUDE_SENTINEL, "--print", "hello world"]);
  expect(built.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9000");
});

test("launch args omit sentinel when --model is provided", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["--model", "claude-opus-4-20250514", "--print", "hi"]);
  expect(built.args).toEqual(["--model", "claude-opus-4-20250514", "--print", "hi"]);
  expect(built.args.filter(a => a === CLAUDE_SENTINEL)).toHaveLength(0);
});

test("launch args omit sentinel when -m is provided", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["-m", "claude-opus-4-20250514"]);
  expect(built.args).toEqual(["-m", "claude-opus-4-20250514"]);
});

test("launch args omit sentinel when --model= is used", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["--model=claude-opus-4-20250514"]);
  expect(built.args).toEqual(["--model=claude-opus-4-20250514"]);
});

test("launch args omit sentinel for -mmodel shorthand", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["-mclaude-opus-4-20250514"]);
  expect(built.args).toEqual(["-mclaude-opus-4-20250514"]);
});

test("arguments are passed verbatim without shell interpolation", () => {
  const tricky = ["--print", "echo $HOME && rm -rf /", "--verbose"];
  const built = claudeArgs("http://127.0.0.1:9000", tricky);
  // Sentinel prepended + original args untouched
  expect(built.args.slice(2)).toEqual(tricky);
  expect(built.args[2]).toBe("--print");
  expect(built.args[3]).toBe("echo $HOME && rm -rf /");
});

test("empty args produces only sentinel model", () => {
  const built = claudeArgs("http://127.0.0.1:9000", []);
  expect(built.args).toEqual(["--model", CLAUDE_SENTINEL]);
});
