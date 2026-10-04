import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { conversationKey, hash, newTurn, recentContext } from "./context";
import { applyEffort, type EffortState } from "./effort";
import { formatFeedback, type FeedbackValues } from "./feedback";
import { cleanupStaleLogs, sessionHistory } from "./history";
import { decide, decisionLabel } from "./policy";
import { buildRequest, createRouter, type Route, type RoutingResult } from "./router";
import { observeStream, type Usage } from "./stream";
import { TIERS, type Candidate, type CodexBody, type Tier } from "./types";

export const AUTO_MODEL = "coding-router-jev";
type CatalogModel = { slug: string; display_name?: string; description?: string; context_window?: number; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string }[]; [key: string]: unknown };
type State = { tier: Tier; model: string; effort: EffortState; lastTurn?: string; notice?: string; noticeKey?: string; usage: (Usage & { at: number; turn?: string })[]; last?: Usage & { at: number } };
export function candidatesFor(config: Config, catalog: Map<string, CatalogModel>): Candidate[] {
  return TIERS.filter(tier => tier !== "long" || config.longModelEnabled).map(tier => {
    const configured = config.codexModels[tier];
    const canonical = configured.replace(/^chatgpt-6/, "gpt-6");
    const id = catalog.has(configured) ? configured : catalog.has(canonical) ? canonical : configured;
    const model = catalog.get(id);
    const efforts = model?.supported_reasoning_levels?.map(level => level.effort) ?? (/^(?:gpt|chatgpt)-6/.test(id) ? ["low", "medium", "high"] : []);
    return { tier, id, description: [model?.display_name ?? id, model?.description, model?.context_window && `${model.context_window} context tokens`].filter(Boolean).join("; "), efforts, defaultEffort: model?.default_reasoning_level ?? (efforts.includes("medium") ? "medium" : efforts[0]) };
  });
}
export const codexArgs = (baseURL: string, args: string[]) => [
  ...(args.some(arg => ["--model", "-m"].includes(arg) || arg.startsWith("--model=") || /^-m.+/.test(arg)) ? [] : ["--model", AUTO_MODEL]),
  "--config", 'model_provider="coding_router_jev"',
  "--config", 'model_providers.coding_router_jev.name="Coding Router Jev"',
  "--config", `model_providers.coding_router_jev.base_url="${baseURL}"`,
  "--config", 'model_providers.coding_router_jev.wire_api="responses"',
  "--config", "model_providers.coding_router_jev.requires_openai_auth=true",
  "--config", "model_providers.coding_router_jev.supports_websockets=false",
  // A shared Codex daemon may reuse another launcher's provider configuration.
  ...(args.includes("--no-daemon") ? [] : ["--no-daemon"]),
  ...args,
];

export function startProxy(config: Config, options: { route?: Route; apiBaseURL?: string; chatgptBaseURL?: string; logDirectory?: string; session?: string; onNotice?: (notice: string) => void } = {}) {
  const route = options.route ?? createRouter();
  const logDir = options.logDirectory ?? join(tmpdir(), "coding-router-jev");
  if (config.logRetentionDays !== undefined) cleanupStaleLogs(logDir, config.logRetentionDays);
  const history = sessionHistory(options.session ?? `${process.pid}-${randomUUID()}`, logDir);
  const catalog = new Map<string, CatalogModel>();
  const states = new Map<string, State>();
  const locks = new Map<string, Promise<unknown>>();
  const announced = new Set<string>();
  const responseKeys = new Map<string, string>();
  async function prepare(body: CodexBody, headers: Headers, compact: boolean) {
    const key = (body.previous_response_id ? responseKeys.get(body.previous_response_id) : undefined) ?? conversationKey(body, headers);
    const previous = locks.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const candidates = candidatesFor(config, catalog);
      let state = states.get(key);
      if (!state) {
        state = { tier: "strong", model: candidates.find(candidate => candidate.tier === "strong")!.id, effort: { updates: [] }, usage: [] };
        states.set(key, state);
        // One wrapper normally has one main conversation; bound auxiliary-session storage.
        if (states.size > 100) states.delete(states.keys().next().value!);
      }
      if (body.model !== AUTO_MODEL) {
        const match = candidates.find(candidate => candidate.id === body.model);
        state.model = body.model;
        state.tier = match?.tier ?? state.tier;
        state.effort = { base: body.reasoning?.effort, effort: body.reasoning?.effort, updates: [] };
        return { key, state, notice: undefined as string | undefined, noticeKey: undefined as string | undefined };
      }
      const turn = compact ? undefined : newTurn(body);
      const turnKey = turn && (body.previous_response_id ? hash(`${body.previous_response_id}|${turn.anchor}`) : turn.anchor);
      let notice: string | undefined;
      let noticeKey: string | undefined;
      if (turn && turnKey !== state.lastTurn) {
        const started = Date.now();
        const currentModel = state.model;
        const currentTier = state.tier;
        const sameSamples = state.usage.filter(sample => sample.model === currentModel && started - sample.at < 120000).slice(-20);
        const average = (field: "read" | "created") => {
          const values = sameSamples.map(sample => sample[field]).filter((value): value is number => value !== null);
          return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        };
        const last = state.last;
        const cache = {
          scope: "This conversation and exact model. Historical observations do not guarantee a future cache hit; missing counts are unknown, not zero.",
          model: currentModel, last_response_model: last?.model ?? null,
          last_observed_at: last ? new Date(last.at).toISOString() : null,
          last_observed_seconds_ago: last ? Math.round((started - last.at) / 1000) : null,
          last_turn: last?.model === currentModel ? { cache_read_tokens: last.read, cache_created_tokens: last.created } : null,
          recent_same_model: { window_seconds: 120, turns: sameSamples.length, cache_read_tokens_avg: average("read"), cache_created_tokens_avg: average("created") },
        };
        const routingInput = { prompt: turn.prompt, currentTier, currentModel, currentEffort: state.effort.effort ?? body.reasoning?.effort, contextTokens: Math.round(JSON.stringify(body.input ?? "").length / 4), candidates, ...(config.sendRecentContext ? { recentContext: recentContext(body) } : {}), cache };
        let result: RoutingResult;
        try { result = await route(routingInput); }
        catch (error) { result = { request: buildRequest(routingInput), response: null, error: error instanceof Error ? error.message : "JEV routing failed", ms: Date.now() - started }; }
        const modelAnswer = result.response?.answers?.model;
        const confidence = modelAnswer?.type === "choice" && Number.isFinite(modelAnswer.confidence) && modelAnswer.confidence >= 0 && modelAnswer.confidence <= 1 ? modelAnswer.confidence : null;
        const decision = decide(turn.prompt, modelAnswer?.type === "choice" ? modelAnswer.choice : undefined, confidence ?? undefined, currentTier, candidates, config.minConfidence);
        const selected = candidates.find(candidate => candidate.tier === decision.tier)!;
        const effortAnswer = result.response?.answers?.reasoning_effort;
        const desired = effortAnswer?.type === "choice" && Number.isFinite(effortAnswer.confidence) && effortAnswer.confidence >= config.minConfidence && effortAnswer.confidence <= 1 && selected.efforts.includes(effortAnswer.choice) ? effortAnswer.choice : undefined;
        const previousEffort = state.effort.effort ?? body.reasoning?.effort;
        const effort = selected.efforts.length ? desired ?? (previousEffort && selected.efforts.includes(previousEffort) ? previousEffort : selected.defaultEffort) : body.reasoning?.effort;
        if (state.model !== selected.id) state.effort = { updates: [] };
        state.model = selected.id;
        state.tier = decision.tier;
        const preserved = applyEffort(body, state.effort, selected.id, effort, turn.anchor);
        state.lastTurn = turnKey;
        const id = randomUUID();
        noticeKey = `${key}:${turnKey}`;
        const jevUsage = result.response?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const feedbackValues: FeedbackValues = {
          tier: selected.tier, model: selected.id, effort, decision: decisionLabel(decision.reason), confidence,
          previous_model: currentModel, cache_read: last?.read ?? null, cache_write: last?.created ?? null,
          jev_tokens_input: typeof jevUsage?.input_tokens === "number" && Number.isFinite(jevUsage.input_tokens) ? jevUsage.input_tokens : undefined,
          jev_tokens_output: typeof jevUsage?.output_tokens === "number" && Number.isFinite(jevUsage.output_tokens) ? jevUsage.output_tokens : undefined,
        };
        notice = formatFeedback(config.feedbackFormat, feedbackValues);
        options.onNotice?.(notice);
        state.notice = notice;
        state.noticeKey = noticeKey;
        history.append({ id, at: new Date().toISOString(), conversation: key, turn: turnKey, prompt: turn.prompt, jev: result, previous: { tier: currentTier, model: currentModel, effort: previousEffort ?? null }, decision: { ...decision, model: selected.id, effort: effort ?? null, effort_update_preserves_prefix: preserved }, cache });
      } else if (!compact) {
        applyEffort(body, state.effort, state.model, state.effort.effort, turn?.anchor);
        if (turn) { notice = state.notice; noticeKey = state.noticeKey; }
      }
      body.model = state.model;
      return { key, state, notice, noticeKey };
    });
    locks.set(key, job);
    try { return await job; } finally { if (locks.get(key) === job) locks.delete(key); }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      try {
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/v1(?=\/)/, "");
        const base = /\/models$/.test(path) || request.headers.has("chatgpt-account-id") ? options.chatgptBaseURL ?? "https://chatgpt.com/backend-api/codex" : options.apiBaseURL ?? "https://api.openai.com/v1";
        const headers = new Headers(request.headers);
        for (const name of ["host", "content-length", "transfer-encoding", "connection", "accept-encoding"]) headers.delete(name);
        let payload = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
        let body: CodexBody | undefined;
        if (request.method === "POST" && /\/responses(?:\/compact)?$/.test(path)) {
          try { body = JSON.parse(new TextDecoder().decode(payload)); } catch { return Response.json({ error: { message: "Invalid JSON request" } }, { status: 400 }); }
          if (body && typeof body.model === "string") {
            prepared = await prepare(body, headers, path.endsWith("/compact"));
            payload = new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer;
          }
        }
        const response = await fetch(`${base.replace(/\/$/, "")}${path}${url.search}`, { method: request.method, headers, body: payload, signal: request.signal, redirect: "manual" });
        const responseHeaders = new Headers(response.headers);
        for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"]) responseHeaders.delete(name);
        if (/\/models$/.test(path) && response.ok) {
          const data = await response.json() as { models?: CatalogModel[] };
          if (Array.isArray(data.models)) {
            for (const model of data.models) catalog.set(model.slug, model);
            if (!data.models.some(model => model.slug === AUTO_MODEL) && data.models[0]) data.models.unshift({ ...data.models[0], slug: AUTO_MODEL, display_name: "Coding Router Jev", description: "JEV selects the model tier and reasoning effort for each turn.", visibility: "list", supported_in_api: true, priority: 0, upgrade: null });
          }
          return Response.json(data, { status: response.status, headers: responseHeaders });
        }
        if (!prepared || !response.ok || !response.body || path.endsWith("/compact")) return new Response(response.body, { status: response.status, headers: responseHeaders });
        const { state, notice, noticeKey } = prepared;
        const turnId = state.lastTurn;
        const usage = (value: Usage) => {
          if (value.responseId) {
            responseKeys.set(value.responseId, prepared.key);
            if (responseKeys.size > 1000) responseKeys.delete(responseKeys.keys().next().value!);
          }
          const sample = { ...value, at: Date.now(), turn: turnId };
          state.last = sample;
          state.usage = state.usage.filter(previous => previous.turn !== sample.turn || previous.model !== sample.model).filter(previous => sample.at - previous.at < 120000);
          if (sample.read !== null || sample.created !== null) state.usage.push(sample);
          state.usage = state.usage.slice(-80);
        };
        usage({ model: body!.model, read: null, created: null });
        const contentType = response.headers.get("content-type");
        if (!contentType || contentType.includes("text/event-stream") || contentType.includes("application/octet-stream")) {
          const getNotice = !options.onNotice && notice && noticeKey ? () => {
            if (announced.has(noticeKey)) return;
            announced.add(noticeKey);
            if (announced.size > 1000) announced.delete(announced.values().next().value!);
            return notice;
          } : undefined;
          return new Response(observeStream(response.body, body!.model, getNotice, usage), { status: response.status, headers: responseHeaders });
        }
        if (response.headers.get("content-type")?.includes("application/json")) {
          const data = await response.arrayBuffer();
          try {
            const parsed = JSON.parse(new TextDecoder().decode(data));
            const details = parsed.usage?.input_tokens_details;
            usage({ model: parsed.model ?? body!.model, read: details?.cached_tokens ?? null, created: details?.cache_write_tokens ?? null, responseId: parsed.id });
          } catch {}
          return new Response(data, { status: response.status, headers: responseHeaders });
        }
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      } catch (error) {
        return Response.json({ error: { type: "proxy_error", message: error instanceof Error ? error.message : "Upstream request failed" } }, { status: 502 });
      }
    },
  });
  return { port: server.port!, logPath: history.path, close: () => server.stop(true) };
}
