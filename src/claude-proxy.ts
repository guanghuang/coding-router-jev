import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Config } from "./config";
import { decide, decisionLabel } from "./policy";
import { buildRequest, createRouter, type Route, type RoutingResult } from "./router";
import { formatFeedback, type FeedbackValues } from "./feedback";
import { cleanupStaleLogs, DEFAULT_LOG_DIR, sessionHistory } from "./history";
import { TIERS, type Candidate, type Tier } from "./types";
import { textOfMessage, isToolResult, type ClaudeBody, type ClaudeMessage } from "./claude-types";

export const CLAUDE_SENTINEL = "coding-router-jev";

type ClaudeUsageObs = { model: string; read: number | null; created: number | null; at: number };
type ClaudeCacheRun = { window: string; observed_responses: number; newest_seconds_ago?: number; oldest_seconds_ago?: number; cache_read_tokens_avg: number | null; cache_created_tokens_avg: number | null };

function summarizeClaudeCacheRun(observations: ClaudeUsageObs[], currentModel: string, now: number): ClaudeCacheRun {
  const matched: ClaudeUsageObs[] = [];
  const sorted = [...observations].sort((a, b) => b.at - a.at);
  for (const obs of sorted) {
    if (obs.model !== currentModel) break;
    if (now - obs.at > 3_600_000) break;
    matched.push(obs);
  }
  const readValues = matched.map(o => o.read).filter((v): v is number => v !== null);
  const createdValues = matched.map(o => o.created).filter((v): v is number => v !== null);
  const result: ClaudeCacheRun = {
    window: "up to 1 hour, stopping at the most recent model switch",
    observed_responses: matched.length,
    cache_read_tokens_avg: readValues.length ? readValues.reduce((s, v) => s + v, 0) / readValues.length : null,
    cache_created_tokens_avg: createdValues.length ? createdValues.reduce((s, v) => s + v, 0) / createdValues.length : null,
  };
  if (matched.length > 0) {
    result.newest_seconds_ago = Math.round((now - matched[0].at) / 1000);
    result.oldest_seconds_ago = Math.round((now - matched[matched.length - 1].at) / 1000);
  }
  return result;
}

const hashStr = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);

function claudeConversationKey(body: ClaudeBody): string {
  const metadata = body.metadata as Record<string, unknown> | undefined;
  const id = metadata?.session_id ?? metadata?.conversation_id;
  const firstUser = body.messages.find(m => m.role === "user");
  const systemText = typeof body.system === "string" ? body.system : Array.isArray(body.system) ? body.system.map(b => b.text).join("") : "";
  return hashStr(String(id ?? `${systemText}|${firstUser ? textOfMessage(firstUser) : ""}`));
}

function claudeNewTurn(body: ClaudeBody): { prompt: string; anchor: string } | undefined {
  const messages = body.messages;
  if (!messages.length) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") return;
    if (msg.role === "user") {
      if (isToolResult(msg)) return;
      const text = textOfMessage(msg).trim();
      if (!text) continue;
      // Build anchor from all user texts up to and including this one
      const userTexts: string[] = [];
      for (let j = 0; j <= i; j++) {
        if (messages[j].role === "user") userTexts.push(textOfMessage(messages[j]));
      }
      return { prompt: text, anchor: hashStr(JSON.stringify(userTexts)) };
    }
  }
}

function claudeRecentContext(body: ClaudeBody): { previous_user_request: string; previous_assistant_excerpt?: string } | undefined {
  const msgs = body.messages.filter(m => !isToolResult(m) && textOfMessage(m).trim());
  const currentIdx = msgs.findLastIndex(m => m.role === "user");
  const prevIdx = msgs.slice(0, currentIdx).findLastIndex(m => m.role === "user");
  if (prevIdx < 0) return;
  const assistant = msgs.slice(prevIdx + 1, currentIdx).findLast(m => m.role === "assistant");
  return {
    previous_user_request: textOfMessage(msgs[prevIdx]).slice(0, 1000),
    ...(assistant ? { previous_assistant_excerpt: textOfMessage(assistant).slice(0, 1000) } : {}),
  };
}

type ClaudeState = {
  tier: Tier;
  model: string;
  lastTurn?: string;
  notice?: string;
  noticeKey?: string;
  observations: ClaudeUsageObs[];
  lastUsage?: { read: number | null; created: number | null; at: number };
};

export function claudeCandidatesFor(config: Config): Candidate[] {
  return TIERS.filter(tier => tier !== "long" || config.longModelEnabled).map(tier => {
    const id = config.claudeModels[tier];
    // Claude models don't have traditional reasoning levels in the same way
    const efforts: string[] = [];
    return {
      tier,
      id,
      description: id,
      efforts,
      defaultEffort: undefined,
    };
  });
}

const BEDROCK_RE = /\.amazonaws\.com/i;
const VERTEX_RE = /aiplatform\.googleapis\.com/i;

export function claudeArgs(baseURL: string, args: string[]): { args: string[]; env: Record<string, string> } {
  const hasModel = args.some(arg => ["--model", "-m"].includes(arg) || arg.startsWith("--model=") || /^-m.+/.test(arg));
  const childArgs = [...(hasModel ? [] : ["--model", CLAUDE_SENTINEL]), ...args];
  return { args: childArgs, env: { ANTHROPIC_BASE_URL: baseURL } };
}

export function startClaudeProxy(config: Config, options: { route?: Route; upstreamBaseURL?: string; logDirectory?: string; session?: string; onNotice?: (notice: string) => void } = {}) {
  const route = options.route ?? createRouter();
  const logDir = options.logDirectory ?? DEFAULT_LOG_DIR;
  if (config.logRetentionDays !== undefined) cleanupStaleLogs(logDir, config.logRetentionDays, "claude");
  const history = sessionHistory(options.session ?? `${process.pid}-${randomUUID()}`, logDir, "claude");

  const upstreamBase = options.upstreamBaseURL ?? process.env.ANTHROPIC_UPSTREAM_URL ?? "https://api.anthropic.com";

  // Detect unsupported providers
  if (BEDROCK_RE.test(upstreamBase)) throw new Error("Bedrock transport is not supported by claude-jev. Use the native Claude CLI with Bedrock directly, or set ANTHROPIC_BASE_URL to the Anthropic API.");
  if (VERTEX_RE.test(upstreamBase)) throw new Error("Vertex AI transport is not supported by claude-jev. Use the native Claude CLI with Vertex directly, or set ANTHROPIC_BASE_URL to the Anthropic API.");

  const states = new Map<string, ClaudeState>();
  const locks = new Map<string, Promise<unknown>>();

  async function prepare(body: ClaudeBody) {
    const key = claudeConversationKey(body);
    const previous = locks.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const candidates = claudeCandidatesFor(config);
      let state = states.get(key);
      if (!state) {
        const startCandidate = candidates.find(c => c.tier === config.startTier) ?? candidates.find(c => c.tier === "fast")!;
        state = { tier: startCandidate.tier, model: startCandidate.id, observations: [] };
        states.set(key, state);
        if (states.size > 100) states.delete(states.keys().next().value!);
      }

      // Physical model bypass: if caller specified a non-sentinel model, pass through
      if (body.model !== CLAUDE_SENTINEL) {
        const match = candidates.find(c => c.id === body.model);
        state.model = body.model;
        state.tier = match?.tier ?? state.tier;
        return { key, state, notice: undefined as string | undefined, noticeKey: undefined as string | undefined };
      }

      const turn = claudeNewTurn(body);
      const turnKey = turn?.anchor;
      let notice: string | undefined;
      let noticeKey: string | undefined;

      if (turn && turnKey !== state.lastTurn) {
        const started = Date.now();
        const currentModel = state.model;
        const currentTier = state.tier;
        const lastUsage = state.lastUsage;
        const cache = summarizeClaudeCacheRun(state.observations, currentModel, started);

        const routingInput = {
          prompt: turn.prompt,
          currentTier,
          currentModel,
          currentEffort: undefined,
          contextTokens: Math.round(JSON.stringify(body.messages).length / 4),
          candidates,
          ...(config.sendRecentContext ? { recentContext: claudeRecentContext(body) } : {}),
          cache,
          agent: "claude" as const,
        };

        let result: RoutingResult;
        try { result = await route(routingInput); }
        catch (error) { result = { request: buildRequest(routingInput), response: null, error: error instanceof Error ? error.message : "JEV routing failed", ms: Date.now() - started }; }

        const modelAnswer = result.response?.answers?.model;
        const confidence = modelAnswer?.type === "choice" && Number.isFinite(modelAnswer.confidence) && modelAnswer.confidence >= 0 && modelAnswer.confidence <= 1 ? modelAnswer.confidence : null;
        const decision = decide(turn.prompt, modelAnswer?.type === "choice" ? modelAnswer.choice : undefined, confidence ?? undefined, currentTier, candidates, config.minConfidence);
        const selected = candidates.find(c => c.tier === decision.tier)!;

        state.model = selected.id;
        state.tier = decision.tier;
        state.lastTurn = turnKey;

        const id = randomUUID();
        noticeKey = `${key}:${turnKey}`;

        const jevUsage = result.response?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const feedbackValues: FeedbackValues = {
          tier: selected.tier, model: selected.id, effort: undefined, decision: decisionLabel(decision.reason), confidence,
          previous_model: currentModel, cache_read: lastUsage?.read ?? null, cache_write: lastUsage?.created ?? null,
          jev_tokens_input: typeof jevUsage?.input_tokens === "number" && Number.isFinite(jevUsage.input_tokens) ? jevUsage.input_tokens : undefined,
          jev_tokens_output: typeof jevUsage?.output_tokens === "number" && Number.isFinite(jevUsage.output_tokens) ? jevUsage.output_tokens : undefined,
        };
        notice = formatFeedback(config.feedbackFormat, feedbackValues);
        options.onNotice?.(notice);
        state.notice = notice;
        state.noticeKey = noticeKey;

        history.append({ id, at: new Date().toISOString(), conversation: key, turn: turnKey, prompt: turn.prompt, jev: result, previous: { tier: currentTier, model: currentModel }, decision: { ...decision, model: selected.id }, cache });
      } else if (turn) {
        notice = state.notice;
        noticeKey = state.noticeKey;
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
        const path = url.pathname;

        if (request.method === "HEAD") {
          return new Response(null, { status: 200 });
        }

        // Forward non-messages endpoints unchanged
        if (request.method !== "POST" || !path.endsWith("/messages")) {
          const headers = new Headers(request.headers);
          for (const name of ["host", "content-length", "transfer-encoding", "connection", "accept-encoding"]) headers.delete(name);
          const payload = request.method === "GET" ? undefined : await request.arrayBuffer();
          const response = await fetch(`${upstreamBase.replace(/\/$/, "")}${path}${url.search}`, { method: request.method, headers, body: payload, signal: request.signal, redirect: "manual" });
          const responseHeaders = new Headers(response.headers);
          for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"]) responseHeaders.delete(name);
          return new Response(response.body, { status: response.status, headers: responseHeaders });
        }

        // POST /v1/messages
        let body: ClaudeBody;
        try { body = JSON.parse(await request.text()); }
        catch { return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON request" } }, { status: 400 }); }

        if (body.model === CLAUDE_SENTINEL && !claudeCandidatesFor(config).length) {
          return Response.json({ type: "error", error: { type: "invalid_request_error", message: "No Claude model candidates configured" } }, { status: 400 });
        }

        const prepared = await prepare(body);

        const headers = new Headers(request.headers);
        for (const name of ["host", "content-length", "transfer-encoding", "connection", "accept-encoding"]) headers.delete(name);
        const upstreamPath = path.startsWith("/v1") ? path : `/v1${path}`;
        const response = await fetch(`${upstreamBase.replace(/\/$/, "")}${upstreamPath}${url.search}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
          redirect: "manual",
        });

        const responseHeaders = new Headers(response.headers);
        for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"]) responseHeaders.delete(name);

        if (!response.ok || !response.body) {
          return new Response(response.body, { status: response.status, headers: responseHeaders });
        }

        // Observe streaming for usage data
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("text/event-stream") && response.body) {
          return new Response(observeClaudeStream(response.body, prepared.state, body.model), { status: response.status, headers: responseHeaders });
        }

        // Non-streaming JSON response — extract usage
        if (contentType?.includes("application/json")) {
          const data = await response.arrayBuffer();
          try {
            const parsed = JSON.parse(new TextDecoder().decode(data));
            if (parsed.usage) {
              const now = Date.now();
              const obs: ClaudeUsageObs = {
                model: parsed.model ?? body.model,
                read: typeof parsed.usage.cache_read_input_tokens === "number" ? parsed.usage.cache_read_input_tokens : null,
                created: typeof parsed.usage.cache_creation_input_tokens === "number" ? parsed.usage.cache_creation_input_tokens : null,
                at: now,
              };
              prepared.state.lastUsage = { read: obs.read, created: obs.created, at: now };
              prepared.state.observations.push(obs);
              prepared.state.observations = prepared.state.observations.filter(o => now - o.at <= 3_600_000).slice(-200);
            }
          } catch {}
          return new Response(data, { status: response.status, headers: responseHeaders });
        }

        return new Response(response.body, { status: response.status, headers: responseHeaders });
      } catch (error) {
        return Response.json({ type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : "Upstream request failed" } }, { status: 502 });
      }
    },
  });

  return { port: server.port!, logPath: history.path, close: () => server.stop(true) };
}

function observeClaudeStream(source: ReadableStream<Uint8Array>, state: ClaudeState, requestModel: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let overflow = false;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (overflow) return;
      pending += decoder.decode(chunk, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      if (pending.length > 1024 * 1024) { overflow = true; pending = ""; }
      for (const frame of frames) {
        const dataLines = frame.split(/\r?\n/).filter(line => line.startsWith("data:"));
        const data = dataLines.map(line => line.slice(5).trimStart()).join("\n");
        try {
          const event = JSON.parse(data);
          if (event.type === "message_start" && event.message?.usage) {
            const usage = event.message.usage;
            const now = Date.now();
            const obs: ClaudeUsageObs = {
              model: event.message.model ?? requestModel,
              read: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : null,
              created: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : null,
              at: now,
            };
            state.lastUsage = { read: obs.read, created: obs.created, at: now };
            state.observations.push(obs);
            state.observations = state.observations.filter(o => now - o.at <= 3_600_000).slice(-200);
          }
          if (event.type === "message_delta" && event.usage) {
            const now = Date.now();
            const usage = event.usage;
            if (typeof usage.cache_read_input_tokens === "number" || typeof usage.cache_creation_input_tokens === "number") {
              state.lastUsage = {
                read: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : state.lastUsage?.read ?? null,
                created: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : state.lastUsage?.created ?? null,
                at: now,
              };
            }
          }
        } catch {}
      }
    },
  }));
}
