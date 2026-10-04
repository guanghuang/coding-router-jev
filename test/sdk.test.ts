import { expect, test } from "bun:test";
import { configFromEnv } from "../src/config";
import { candidatesFor } from "../src/proxy";
import { createRouter } from "../src/router";

test("TypeSafe SDK reads its native env variables and the logged request includes its resolved model", async () => {
  let body: Record<string, unknown> | undefined;
  let authorization: string | null = null;
  const server = Bun.serve({ port: 0, async fetch(request) {
    body = await request.json() as Record<string, unknown>;
    authorization = request.headers.get("authorization");
    return Response.json({ model: "test-jev", answers: { model: { type: "choice", choice: "fast", confidence: 0.8, probabilities: { fast: 0.8, balanced: 0.1, strong: 0.1 } }, reasoning_effort: { type: "choice", choice: "low", confidence: 0.9, probabilities: { low: 0.9, keep: 0.1 } } }, usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const keys = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL"] as const;
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.TYPESAFE_API_KEY = "test-only-key";
    process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.TYPESAFE_DEFAULT_MODEL = "test-jev";
    const result = await createRouter()({ prompt: "hi", currentTier: "strong", currentModel: "gpt-6.1-sol", contextTokens: 10, candidates: candidatesFor(configFromEnv({}), new Map()) });
    expect(result.response?.answers.model.type).toBe("choice");
    expect(result.request.model).toBe("test-jev");
    expect(body?.model).toBe("test-jev");
    expect(String(authorization)).toBe("Bearer test-only-key");
  } finally {
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    server.stop(true);
  }
});
