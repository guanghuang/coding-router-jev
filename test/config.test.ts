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
      piModels: {
        fast: "openai-codex/gpt-6-luna",
        balanced: "openai-codex/gpt-6.1-sol",
        strong: "openai-codex/gpt-6.1-sol",
        long: "openai-codex/gpt-6-astra",
      },
      claudeModels: {
        fast: "claude-sonnet-4-20250514",
        balanced: "claude-sonnet-4-20250514",
        strong: "claude-sonnet-4-20250514",
        long: "claude-sonnet-4-20250514",
      },
      startTier: "fast",
      longModelEnabled: false,
      minConfidence: 0.3,
      sendRecentContext: true,
      feedbackFormat: undefined,
      logRetentionDays: undefined,
      claudeContextWindow: undefined,
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

  test("parses feedback format and normalizes empty/whitespace to undefined", () => {
    expect(configFromEnv({ CODING_ROUTER_FEEDBACK_FORMAT: "[Jev] {tier}" }).feedbackFormat).toBe("[Jev] {tier}");
    expect(configFromEnv({ CODING_ROUTER_FEEDBACK_FORMAT: "  " }).feedbackFormat).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_FEEDBACK_FORMAT: "" }).feedbackFormat).toBeUndefined();
    expect(configFromEnv({}).feedbackFormat).toBeUndefined();
  });

  test("uses valid confidence override and falls back for invalid values", () => {
    expect(configFromEnv({ CODING_ROUTER_MIN_CONFIDENCE: "0.42" }).minConfidence).toBe(0.42);
    expect(configFromEnv({ CODING_ROUTER_MIN_CONFIDENCE: "2" }).minConfidence).toBe(0.3);
  });

  test("parses positive log retention days", () => {
    expect(configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "30" }).logRetentionDays).toBe(30);
    expect(configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "7" }).logRetentionDays).toBe(7);
  });

  test("returns undefined for non-positive, invalid, or missing retention days", () => {
    expect(configFromEnv({}).logRetentionDays).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "" }).logRetentionDays).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "  " }).logRetentionDays).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "0" }).logRetentionDays).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "-5" }).logRetentionDays).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "abc" }).logRetentionDays).toBeUndefined();
    expect(configFromEnv({ CODING_ROUTER_LOG_RETENTION_DAYS: "Infinity" }).logRetentionDays).toBeUndefined();
  });

  test("startup tier defaults to fast when unset or blank", () => {
    expect(configFromEnv({}).startTier).toBe("fast");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "" }).startTier).toBe("fast");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "  " }).startTier).toBe("fast");
  });

  test("startup tier falls back to fast for invalid values", () => {
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "turbo" }).startTier).toBe("fast");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "medium" }).startTier).toBe("fast");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "123" }).startTier).toBe("fast");
  });

  test("startup tier trims whitespace and normalizes case", () => {
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "  FAST  " }).startTier).toBe("fast");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "Strong" }).startTier).toBe("strong");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "BALANCED" }).startTier).toBe("balanced");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: " Long " }).startTier).toBe("fast");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: " Long ", CODING_ROUTER_LONG_MODEL_ENABLE: "true" }).startTier).toBe("long");
  });

  test("startup tier accepts each supported tier", () => {
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "fast" }).startTier).toBe("fast");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "balanced" }).startTier).toBe("balanced");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "strong" }).startTier).toBe("strong");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "long", CODING_ROUTER_LONG_MODEL_ENABLE: "true" }).startTier).toBe("long");
  });

  test("startup tier long falls back to fast when Long is disabled", () => {
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "long" }).startTier).toBe("fast");
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "long", CODING_ROUTER_LONG_MODEL_ENABLE: "false" }).startTier).toBe("fast");
  });

  test("startup tier long is accepted when Long is enabled", () => {
    expect(configFromEnv({ CODING_ROUTER_START_TIER: "long", CODING_ROUTER_LONG_MODEL_ENABLE: "true" }).startTier).toBe("long");
  });

  test("shell environment overrides file START_TIER value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coding-router-jev-start-tier-"));
    const file = join(dir, "settings.env");
    const environment: Record<string, string | undefined> = {
      CODING_ROUTER_START_TIER: "strong",
    };
    try {
      await writeFile(file, "CODING_ROUTER_START_TIER=balanced\n");
      await loadEnv(file, environment);
      expect(environment.CODING_ROUTER_START_TIER).toBe("strong");
      expect(configFromEnv(environment).startTier).toBe("strong");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("file-provided START_TIER is loaded when shell env is unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coding-router-jev-start-tier-file-"));
    const file = join(dir, "settings.env");
    const environment: Record<string, string | undefined> = {};
    try {
      await writeFile(file, "CODING_ROUTER_START_TIER=balanced\n");
      await loadEnv(file, environment);
      expect(environment.CODING_ROUTER_START_TIER).toBe("balanced");
      expect(configFromEnv(environment).startTier).toBe("balanced");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Pi model defaults are provider-qualified", () => {
    const config = configFromEnv({});
    expect(config.piModels.fast).toBe("openai-codex/gpt-6-luna");
    expect(config.piModels.balanced).toBe("openai-codex/gpt-6.1-sol");
    expect(config.piModels.strong).toBe("openai-codex/gpt-6.1-sol");
    expect(config.piModels.long).toBe("openai-codex/gpt-6-astra");
  });

  test("Pi model overrides from environment", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_PI: "custom-provider/custom-model",
      CODING_ROUTER_STRONG_MODEL_PI: "other/model/with/slashes",
    });
    expect(config.piModels.fast).toBe("custom-provider/custom-model");
    expect(config.piModels.balanced).toBe("openai-codex/gpt-6.1-sol");
    expect(config.piModels.strong).toBe("other/model/with/slashes");
    expect(config.piModels.long).toBe("openai-codex/gpt-6-astra");
  });

  test("Pi model IDs with embedded slashes are preserved without splitting", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_PI: "provider/org/model-v2/latest",
    });
    expect(config.piModels.fast).toBe("provider/org/model-v2/latest");
  });

  test("Pi and Codex models are independent", () => {
    const config = configFromEnv({
      CODING_ROUTER_FAST_MODEL_CODEX: "codex-custom",
      CODING_ROUTER_FAST_MODEL_PI: "pi-custom",
    });
    expect(config.codexModels.fast).toBe("codex-custom");
    expect(config.piModels.fast).toBe("pi-custom");
  });

  test("loadEnv with missing file does not throw (ENOENT handled)", async () => {
    const environment: Record<string, string | undefined> = {};
    await loadEnv("/nonexistent/path/to/file.env", environment);
    expect(Object.keys(environment)).toHaveLength(0);
  });

  test("loadEnv with non-ENOENT error is rethrown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coding-router-jev-err-"));
    try {
      await expect(loadEnv(dir, {})).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Pi models load from env file when shell env unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coding-router-jev-pi-file-"));
    const file = join(dir, "settings.env");
    const environment: Record<string, string | undefined> = {};
    try {
      await writeFile(file, "CODING_ROUTER_FAST_MODEL_PI=file-pi-model\n");
      await loadEnv(file, environment);
      expect(environment.CODING_ROUTER_FAST_MODEL_PI).toBe("file-pi-model");
      expect(configFromEnv(environment).piModels.fast).toBe("file-pi-model");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
