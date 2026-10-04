import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, loadEnv, parseEnvFile } from "../src/config.ts";

describe("configuration", () => {
  test("uses documented defaults", () => {
    expect(configFromEnv({})).toEqual({
      codexModels: {
        fast: "chatgpt-6-luna",
        balanced: "chatgpt-6.1-sol",
        strong: "chatgpt-6.1-sol",
        long: "chatgpt-6-astra",
      },
      longModelEnabled: false,
      minConfidence: 0.3,
      sendRecentContext: true,
      feedbackFormat: undefined,
    });
  });

  test("parses env lines and strips quotes/comments", () => {
    expect(parseEnvFile("A=one\nB='two words'\nC=value # comment\n# ignored")).toEqual({
      A: "one",
      B: "two words",
      C: "value",
    });
  });

  test("shell environment overrides file values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coding-router-jev-test-"));
    const file = join(dir, "settings.env");
    const environment: Record<string, string | undefined> = {
      CODING_ROUTER_FAST_MODEL_CODEX: "shell-model",
    };
    try {
      await writeFile(file, "CODING_ROUTER_FAST_MODEL_CODEX=file-model\nTYPESAFE_API_KEY=test-key\n");
      await loadEnv(file, environment);
      expect(environment.CODING_ROUTER_FAST_MODEL_CODEX).toBe("shell-model");
      expect(environment.TYPESAFE_API_KEY).toBe("test-key");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses valid confidence override and falls back for invalid values", () => {
    expect(configFromEnv({ CODING_ROUTER_MIN_CONFIDENCE: "0.42" }).minConfidence).toBe(0.42);
    expect(configFromEnv({ CODING_ROUTER_MIN_CONFIDENCE: "2" }).minConfidence).toBe(0.3);
  });
});
