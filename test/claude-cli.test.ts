import { expect, test } from "bun:test";
import { claudeArgs, CLAUDE_SENTINEL } from "../src/claude-proxy";

test("launch args include sentinel model when no explicit model", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["--print", "hello world"]);
  expect(built).toEqual(["--model", CLAUDE_SENTINEL, "--print", "hello world"]);
});

test("launch args omit sentinel when --model is provided", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["--model", "claude-opus-4-20250514", "--print", "hi"]);
  expect(built).toEqual(["--model", "claude-opus-4-20250514", "--print", "hi"]);
  expect(built.filter(a => a === CLAUDE_SENTINEL)).toHaveLength(0);
});

test("launch args omit sentinel when -m is provided", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["-m", "claude-opus-4-20250514"]);
  expect(built).toEqual(["-m", "claude-opus-4-20250514"]);
});

test("launch args omit sentinel when --model= is used", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["--model=claude-opus-4-20250514"]);
  expect(built).toEqual(["--model=claude-opus-4-20250514"]);
});

test("launch args omit sentinel for -mmodel shorthand", () => {
  const built = claudeArgs("http://127.0.0.1:9000", ["-mclaude-opus-4-20250514"]);
  expect(built).toEqual(["-mclaude-opus-4-20250514"]);
});

test("arguments are passed verbatim without shell interpolation", () => {
  const tricky = ["--print", "echo $HOME && rm -rf /", "--verbose"];
  const built = claudeArgs("http://127.0.0.1:9000", tricky);
  expect(built.slice(2)).toEqual(tricky);
});

test("empty args produces only sentinel model", () => {
  const built = claudeArgs("http://127.0.0.1:9000", []);
  expect(built).toEqual(["--model", CLAUDE_SENTINEL]);
});
