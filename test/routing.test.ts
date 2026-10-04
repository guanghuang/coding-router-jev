import { expect, test } from "bun:test";
import { configFromEnv } from "../src/config";
import { isJevNotice, newTurn, recentContext, userAnchors } from "../src/context";
import { applyEffort, type EffortState } from "../src/effort";
import { checkEligibility, decide, decisionLabel } from "../src/policy";
import { buildRequest } from "../src/router";
import { candidatesFor, codexArgs, AUTO_MODEL } from "../src/proxy";
import { observeStream, type Usage } from "../src/stream";
import type { Candidate, CodexBody, Item } from "../src/types";

const candidates = candidatesFor(configFromEnv({}), new Map());
test("confidence policy preserves tiers even when models are shared, with no cache guard", () => {
  expect(candidates.map(candidate => candidate.tier)).toEqual(["fast", "balanced", "strong"]);
  expect(candidates[1].id).toBe(candidates[2].id);
  expect(decide("debug", "strong", 0.1, "fast", candidates, 0.3)).toEqual({ tier: "balanced", reason: "low-confidence-capped" });
  expect(decide("hi", "fast", 0.1, "strong", candidates, 0.3).tier).toBe("strong");
  expect(decide("hi", "fast", 0.8, "strong", candidates, 0.3).tier).toBe("fast");
  expect(decide("use long", "long", 1, "fast", candidates, 0.3).tier).toBe("fast");
  expect(decide("use Luna", "strong", 1, "strong", candidates, 0.3).tier).toBe("fast");
  expect(decide("What does 'use Sol' mean?", "fast", 0.9, "fast", candidates, 0.3).tier).toBe("fast");
});

test("decision feedback labels cover every user-facing policy outcome", () => {
  const outcomes: Record<string, string> = {
    jev: "JEV",
    "jev/no-change": "JEV/no-change",
    "low-confidence-no-downgrade/no-change": "low-confidence/no-change",
    "low-confidence-capped": "low-confidence/capped",
    "low-confidence-capped/no-change": "low-confidence/capped",
    "low-confidence-capped+unavailable/no-change": "low-confidence/unavailable",
    "jev-unavailable/no-change": "JEV/unavailable",
    override: "override",
    "override/no-change": "override/no-change",
    "override+unavailable/no-change": "override/unavailable",
  };
  for (const [reason, label] of Object.entries(outcomes)) expect(decisionLabel(reason)).toBe(label);
});

test("recent context is bounded text and tool continuations do not start a new turn", () => {
  const body: CodexBody = { model: AUTO_MODEL, input: [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "output_text", text: `[Jev] notice\n${"x".repeat(1200)}` }, { type: "tool_result", text: "secret" }] },
    { role: "user", content: "continue" },
  ] };
  expect(recentContext(body)).toEqual({ previous_user_request: "first", previous_assistant_excerpt: "x".repeat(1000) });
  expect(newTurn(body)?.prompt).toBe("continue");
  (body.input as Item[]).push({ type: "function_call_output", output: "result" });
  expect(newTurn(body)).toBeUndefined();
});

test("JEV request explains tier, effort, task scope, and cache semantics", () => {
  const request = buildRequest({ prompt: "debug", currentTier: "fast", currentModel: candidates[0].id, contextTokens: 50000, candidates });
  expect(request.questions.reasoning_required.type).toBe("score");
  expect(request.questions.reasoning_effort.type).toBe("choice");
  expect(request.questions.model.type).toBe("choice");
  expect(JSON.stringify(request)).not.toContain('"long":');
  expect(request.questions.task_complexity.instructions).toContain("actual request");
  expect(JSON.stringify(request)).toContain("Balanced and Strong can use the same model");
  expect(JSON.stringify(request)).toContain("Missing values mean unknown");
  expect(JSON.stringify(request)).toContain("Light reasoning for simple explanations");
});

test("effort updates are replayed at original positions with a stable top-level effort", () => {
  const state: EffortState = { updates: [] };
  const first: Item = { role: "user", content: "first" };
  const second: Item = { role: "user", content: "second" };
  const third: Item = { role: "user", content: "third" };
  const body = (input: Item[]): CodexBody => ({ model: "gpt-6.1-sol", reasoning: { effort: "medium" }, input });
  const a = body([first]);
  applyEffort(a, state, a.model, "low", userAnchors([first]).get(0));
  const b = body([first, second]);
  applyEffort(b, state, b.model, "high", userAnchors([first, second]).get(1));
  expect(b.reasoning?.effort).toBe("low");
  expect((b.input as Item[])[1]).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
  const c = body([first, second, third]);
  applyEffort(c, state, c.model, "medium", userAnchors([first, second, third]).get(2));
  expect(c.reasoning?.effort).toBe("low");
  expect((c.input as Item[]).map(item => item.type ?? item.content)).toEqual(["first", "configuration_update", "second", "configuration_update", "third"]);
  const incompatible = { ...body([first, second, third]), context_management: [{ type: "compaction" }] };
  expect(applyEffort(incompatible, state, incompatible.model, "high")).toBe(false);
  expect((incompatible.input as Item[]).some(item => item.type === "configuration_update")).toBe(false);
  expect(incompatible.reasoning?.effort).toBe("high");
});

test("fragmented SSE is preserved and the notice is injected only at a frame boundary", async () => {
  const text = 'event: response.created\ndata: {"type":"response.created"}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-luna","usage":{"input_tokens_details":{"cached_tokens":123,"cache_write_tokens":45}}}}\n\n';
  const bytes = new TextEncoder().encode(text);
  let observed: Usage | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } });
  const output = await new Response(observeStream(stream, "fallback", () => "[Jev] test", value => { observed = value; })).text();
  const providerFrames = output.split("\n\n").filter(frame => !frame.includes("jev-")).filter(Boolean).join("\n\n") + "\n\n";
  expect(providerFrames).toBe(text);
  expect(output.indexOf("jev-")).toBeGreaterThan(output.indexOf('"response.created"'));
  expect(observed).toEqual({ model: "gpt-6-luna", read: 123, created: 45 });
});

test("launcher selects a separate provider and isolates the Codex daemon", () => {
  const args = codexArgs("http://127.0.0.1:1234", ["resume", "--last"]);
  expect(args).toContain(AUTO_MODEL);
  expect(args).toContain("--no-daemon");
  expect(codexArgs("http://127.0.0.1:1234", ["-m", "manual"]).filter(arg => arg === AUTO_MODEL)).toHaveLength(0);
});


test("Codex startup instructions are excluded from routing and recent context", () => {
  const startup = { role: "user", content: "# AGENTS.md instructions\n\n<INSTRUCTIONS>Repository rules</INSTRUCTIONS><environment_context>cwd: /repo</environment_context>" };
  expect(newTurn({ model: AUTO_MODEL, input: [startup] })).toBeUndefined();
  expect(newTurn({ model: AUTO_MODEL, input: startup.content })).toBeUndefined();
  const first = { role: "user", content: "fix the bug" };
  expect(newTurn({ model: AUTO_MODEL, input: [startup, first] })?.prompt).toBe("fix the bug");
  expect(recentContext({ model: AUTO_MODEL, input: [startup, first] })).toBeUndefined();
  expect(newTurn({ model: AUTO_MODEL, input: [startup, first] })?.anchor).toBe(newTurn({ model: AUTO_MODEL, input: [first] })?.anchor);
});

test("isJevNotice identifies proxy-injected notices by provenance and rejects everything else", () => {
  expect(isJevNotice({ role: "assistant", id: "jev-39f3a1a0-0045-495e-a502-8afd3b9544f9" })).toBe(true);
  expect(isJevNotice({ role: "assistant", id: "jev-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })).toBe(true);
  expect(isJevNotice({ role: "assistant", id: "msg_09a50707f436a8b9016ac1e9a9833487" })).toBe(false);
  expect(isJevNotice({ role: "user", id: "jev-39f3a1a0-0045-495e-a502-8afd3b9544f9" })).toBe(false);
  expect(isJevNotice({ role: "assistant", content: "[Jev] tier: fast" })).toBe(false);
  expect(isJevNotice({ role: "assistant" })).toBe(false);
  expect(isJevNotice({ role: "assistant", id: "jev-short" })).toBe(false);
  expect(isJevNotice({ role: "assistant", id: "jev-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" })).toBe(false);
});

test("buildRequest defaults to Codex agent purpose", () => {
  const request = buildRequest({ prompt: "debug", currentTier: "fast", currentModel: "gpt-6-luna", contextTokens: 1000, candidates });
  expect(JSON.stringify(request.state)).toContain("Route the next user turn in Codex");
  expect(JSON.stringify(request.state)).not.toContain("Route the next user turn in Pi");
});

test("buildRequest with agent=pi produces Pi-specific purpose", () => {
  const request = buildRequest({ prompt: "debug", currentTier: "fast", currentModel: "gpt-6-luna", contextTokens: 1000, candidates, agent: "pi" });
  expect(JSON.stringify(request.state)).toContain("Route the next user turn in Pi");
  expect(JSON.stringify(request.state)).not.toContain("Route the next user turn in Codex");
});

test("buildRequest with agent=codex explicitly also uses Codex purpose", () => {
  const request = buildRequest({ prompt: "hi", currentTier: "fast", currentModel: "gpt-6-luna", contextTokens: 1000, candidates, agent: "codex" });
  expect(JSON.stringify(request.state)).toContain("Route the next user turn in Codex");
});

test("buildRequest without agent field uses Codex purpose (backward compatible)", () => {
  const request = buildRequest({ prompt: "hi", currentTier: "fast", currentModel: "gpt-6-luna", contextTokens: 1000, candidates });
  expect(JSON.stringify(request.state)).toContain("Route the next user turn in Codex");
});

test("supported-effort union from candidates is shared across agents", () => {
  const piCandidates: Candidate[] = [
    { tier: "fast", id: "openai-codex/gpt-6-luna", description: "Luna", efforts: ["off", "low", "medium"] },
    { tier: "strong", id: "openai-codex/gpt-6.1-sol", description: "Sol", efforts: ["low", "medium", "high", "xhigh"] },
  ];
  const request = buildRequest({ prompt: "test", currentTier: "fast", currentModel: piCandidates[0].id, contextTokens: 1000, candidates: piCandidates, agent: "pi" });
  const effortQuestion = request.questions.reasoning_effort;
  expect(effortQuestion.type).toBe("choice");
  const effortKeys = Object.keys((effortQuestion as { criteria: Record<string, unknown> }).criteria);
  expect(effortKeys).toContain("keep");
  expect(effortKeys).toContain("off");
  expect(effortKeys).toContain("low");
  expect(effortKeys).toContain("medium");
  expect(effortKeys).toContain("high");
  expect(effortKeys).toContain("xhigh");
});

test("eligibility: 300K request excludes 200K candidate but permits 1M candidate", () => {
  const small: Candidate = { tier: "fast", id: "small", description: "Small", efforts: ["low"], capacity: { contextWindow: 200_000 } };
  const large: Candidate = { tier: "strong", id: "large", description: "Large", efforts: ["high"], capacity: { contextWindow: 1_000_000 } };
  const result = checkEligibility([small, large], 300_000, 16_000);
  expect(result.eligible.map(c => c.id)).toEqual(["large"]);
  expect(result.rejected.map(r => r.candidate.id)).toEqual(["small"]);
  expect(result.rejected[0].reason).toContain("300000");
  expect(result.unknown).toHaveLength(0);
});

test("eligibility: candidate with output budget uses it over default reserve", () => {
  const candidate: Candidate = { tier: "fast", id: "with-budget", description: "Test", efforts: ["low"], capacity: { contextWindow: 100_000, outputBudget: 20_000 } };
  const result = checkEligibility([candidate], 79_999, 10_000);
  expect(result.eligible.map(c => c.id)).toEqual(["with-budget"]);
  const tight = checkEligibility([candidate], 80_001, 10_000);
  expect(tight.rejected.map(r => r.candidate.id)).toEqual(["with-budget"]);
});

test("eligibility: unknown capacity is classified as unknown, not rejected", () => {
  const noCapacity: Candidate = { tier: "fast", id: "unknown", description: "Unknown", efforts: ["low"] };
  const partial: Candidate = { tier: "balanced", id: "partial", description: "Partial", efforts: ["medium"], capacity: {} };
  const result = checkEligibility([noCapacity, partial], 100_000, 16_000);
  expect(result.unknown.map(c => c.id)).toEqual(["unknown", "partial"]);
  expect(result.eligible).toHaveLength(0);
  expect(result.rejected).toHaveLength(0);
});

test("eligibility: no eligible candidate when all known capacities are too small", () => {
  const a: Candidate = { tier: "fast", id: "a", description: "A", efforts: ["low"], capacity: { contextWindow: 50_000 } };
  const b: Candidate = { tier: "balanced", id: "b", description: "B", efforts: ["medium"], capacity: { contextWindow: 100_000 } };
  const result = checkEligibility([a, b], 200_000, 16_000);
  expect(result.eligible).toHaveLength(0);
  expect(result.rejected).toHaveLength(2);
});

test("eligibility: equal-window Codex candidates are all eligible", () => {
  const equal: Candidate[] = [
    { tier: "fast", id: "gpt-6-luna", description: "Luna", efforts: ["low", "medium", "high"], capacity: { contextWindow: 200_000 } },
    { tier: "balanced", id: "gpt-6.1-sol", description: "Sol", efforts: ["low", "medium", "high"], capacity: { contextWindow: 200_000 } },
    { tier: "strong", id: "gpt-6.1-sol", description: "Sol", efforts: ["low", "medium", "high"], capacity: { contextWindow: 200_000 } },
  ];
  const result = checkEligibility(equal, 100_000, 16_000);
  expect(result.eligible).toHaveLength(3);
  expect(result.rejected).toHaveLength(0);
});

test("candidatesFor populates capacity from catalog context_window", () => {
  const catalog = new Map([
    ["gpt-6-luna", { slug: "gpt-6-luna", display_name: "Luna", context_window: 200_000, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] }],
    ["gpt-6.1-sol", { slug: "gpt-6.1-sol", display_name: "Sol", context_window: 1_000_000, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }] }],
  ]);
  const result = candidatesFor(configFromEnv({}), catalog as any);
  const luna = result.find(c => c.tier === "fast")!;
  const sol = result.find(c => c.tier === "balanced")!;
  expect(luna.capacity).toEqual({ contextWindow: 200_000 });
  expect(sol.capacity).toEqual({ contextWindow: 1_000_000 });
});

test("candidatesFor without catalog context_window has undefined capacity", () => {
  const result = candidatesFor(configFromEnv({}), new Map());
  expect(result[0].capacity).toBeUndefined();
});
