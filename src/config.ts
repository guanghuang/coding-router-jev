import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const ENV_FILE = join(homedir(), ".coding-router-jev.env");

export type Config = {
  codexModels: {
    fast: string;
    balanced: string;
    strong: string;
    long: string;
  };
  longModelEnabled: boolean;
  minConfidence: number;
  sendRecentContext: boolean;
  feedbackFormat: string | undefined;
};

export function parseEnvFile(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

export async function loadEnv(
  envFile = ENV_FILE,
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(await Bun.file(envFile).text());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  for (const [key, value] of Object.entries(fileValues)) {
    if (environment[key] === undefined) environment[key] = value;
  }
}

export function configFromEnv(environment: Record<string, string | undefined> = process.env): Config {
  const value = (key: string, fallback: string) => environment[key]?.trim() || fallback;
  const confidence = Number(value("CODING_ROUTER_MIN_CONFIDENCE", "0.30").trim() || "0.30");
  return {
    codexModels: {
      fast: value("CODING_ROUTER_FAST_MODEL_CODEX", "chatgpt-6-luna"),
      balanced: value("CODING_ROUTER_BALANCED_MODEL_CODEX", "chatgpt-6.1-sol"),
      strong: value("CODING_ROUTER_STRONG_MODEL_CODEX", "chatgpt-6.1-sol"),
      long: value("CODING_ROUTER_LONG_MODEL_CODEX", "chatgpt-6-astra"),
    },
    longModelEnabled: value("CODING_ROUTER_LONG_MODEL_ENABLE", "false") === "true",
    minConfidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 0.30,
    sendRecentContext: value("CODING_ROUTER_SEND_RECENT_CONTEXT", "true") === "true",
    feedbackFormat: value("CODING_ROUTER_FEEDBACK_FORMAT", "") || undefined,
  };
}
