import { randomUUID } from "node:crypto";
import { CodexLatestResolutionError, extractCatalogEntries, modelIdOf, parseLatestAlias, resolveLatestFamily, VIRTUAL_MODEL_ID, type CatalogEntryLike, type CodexLatestFamily, type CodexLatestResolutionErrorKind } from "./codex-resolver";
import { CODEX_MODEL_ENV_KEYS, type Config } from "./config";
import { conversationKey, hash, isJevNotice, newTurn, recentContext } from "./context";
import { applyEffort, type EffortState } from "./effort";
import { DEFAULT_STATUS_FORMAT, formatFeedback, type FeedbackValues } from "./feedback";
import { cleanupStaleLogs, DEFAULT_LOG_DIR, sessionHistory } from "./history";
import { decide, decisionLabel } from "./policy";
import { buildRequest, createRouter, type Route, type RoutingResult, type SensitivityAnswers } from "./router";
import { observeStream, type Usage } from "./stream";
import { createTelemetry, extractUsage } from "./telemetry";
import { TIERS, type Candidate, type CodexBody, type Tier } from "./types";

export const AUTO_MODEL = VIRTUAL_MODEL_ID;
type CatalogModel = { slug?: string; id?: string; display_name?: string; description?: string; context_window?: number; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string }[]; [key: string]: unknown };
type ResponseObservation = { model: string; read: number | null; created: number | null; at: number };
type CacheRunSummary = { window: string; observed_responses: number; newest_seconds_ago?: number; oldest_seconds_ago?: number; cache_read_tokens_avg: number | null; cache_created_tokens_avg: number | null };
export function summarizeCacheRun(observations: ResponseObservation[], currentModel: string, now: number): CacheRunSummary {
  const matched: ResponseObservation[] = [];
  const sorted = [...observations].sort((a, b) => b.at - a.at);
  for (const obs of sorted) {
    if (obs.model !== currentModel) break;
    if (now - obs.at > 3_600_000) break;
    matched.push(obs);
  }
  const readValues = matched.map(o => o.read).filter((v): v is number => v !== null);
  const createdValues = matched.map(o => o.created).filter((v): v is number => v !== null);
  const result: CacheRunSummary = {
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
type State = { tier: Tier; model: string; effort: EffortState; lastTurn?: string; decisionId?: string; notice?: string; noticeKey?: string; observations: ResponseObservation[]; last?: Usage & { at: number } };
export function candidatesFor(config: Config, catalog: Map<string, CatalogModel>, resolvedAliases?: ReadonlyMap<CodexLatestFamily, string>): Candidate[] {
  return TIERS.filter(tier => tier !== "long" || config.longModelEnabled).map(tier => {
    const configured = config.codexModels[tier];
    const aliasFamily = parseLatestAlias(configured);
    let id = configured;
    if (aliasFamily) {
      // Pinned session resolutions win; otherwise resolve synchronously from
      // the catalog at hand. An unresolved alias stays as-is here — prepare()
      // is responsible for discovery and for failing before it can leak.
      let resolved = resolvedAliases?.get(aliasFamily);
      if (!resolved) {
        try { resolved = resolveLatestFamily(aliasFamily, [...catalog.values()]); } catch { resolved = undefined; }
      }
      id = resolved ?? configured;
    } else {
      const canonical = configured.replace(/^chatgpt-6/, "gpt-6");
      id = catalog.has(configured) ? configured : catalog.has(canonical) ? canonical : configured;
    }
    const model = catalog.get(id) ?? [...catalog.values()].find(entry => modelIdOf(entry) === id);
    const efforts = model?.supported_reasoning_levels?.map(level => level.effort) ?? (/^(?:gpt|chatgpt)-6/.test(id) ? ["low", "medium", "high"] : []);
    const capacity = model?.context_window ? { contextWindow: model.context_window } : undefined;
    return { tier, id, description: [model?.display_name ?? id, model?.description, model?.context_window && `${model.context_window} context tokens`].filter(Boolean).join("; "), efforts, defaultEffort: model?.default_reasoning_level ?? (efforts.includes("medium") ? "medium" : efforts[0]), capacity };
  });
}
export function codexStatusModelName(format?: string): string {
  return (format ?? DEFAULT_STATUS_FORMAT)
    .replaceAll("{model}", "Coding Router Jev")
    .replace(/\s*\{effort\}\s*$/, "")
    .trimEnd();
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

export function startProxy(config: Config, options: { route?: Route; apiBaseURL?: string; chatgptBaseURL?: string; logDirectory?: string; session?: string; onNotice?: (notice: string) => void; telemetryPath?: string } = {}) {
  const route = options.route ?? createRouter();
  const logDir = options.logDirectory ?? DEFAULT_LOG_DIR;
  if (config.logRetentionDays !== undefined) cleanupStaleLogs(logDir, config.logRetentionDays);
  const history = sessionHistory(options.session ?? `${process.pid}-${randomUUID()}`, logDir);
  const telemetry = createTelemetry(options.telemetryPath ?? process.env.JEV_TELEMETRY_FILE);
  const catalog = new Map<string, CatalogModel>();
  const states = new Map<string, State>();
  const locks = new Map<string, Promise<unknown>>();
  const announced = new Set<string>();
  const responseKeys = new Map<string, string>();
  // Session-pinned `family:latest` resolutions: once a family resolves to an
  // exact ID it never changes for this proxy's lifetime, even if a later
  // catalog refresh advertises a newer version.
  const resolvedAliases = new Map<CodexLatestFamily, string>();
  // True when the last proxied catalog page advertised further pages: its
  // entries are stored but must not pin a resolution until discovery has
  // fetched the complete catalog.
  let catalogIncomplete = false;
  let discoveryPromise: Promise<void> | undefined;
  function aliasNeeds(): { tier: Tier; family: CodexLatestFamily }[] {
    return TIERS
      .filter(tier => tier !== "long" || config.longModelEnabled)
      .flatMap(tier => {
        const family = parseLatestAlias(config.codexModels[tier]);
        return family ? [{ tier, family }] : [];
      });
  }
  function pinFromCatalog(): void {
    for (const { family } of aliasNeeds()) {
      if (resolvedAliases.has(family)) continue;
      try { resolvedAliases.set(family, resolveLatestFamily(family, [...catalog.values()])); } catch { /* not resolvable yet */ }
    }
  }
  function ingestCatalog(entries: readonly CatalogEntryLike[], pin = true, incomplete = false): void {
    // Capture the raw upstream catalog before AUTO_MODEL is injected anywhere.
    let stored = 0;
    for (const entry of entries) {
      const id = modelIdOf(entry);
      if (!id || id === AUTO_MODEL) continue;
      catalog.set(id, entry as CatalogModel);
      stored++;
    }
    // Pinning is blocked not only by this response being an incomplete page,
    // but also while the assembled catalog is known to be incomplete or a
    // paginated discovery is still in flight — otherwise a proxied /models
    // response (even an empty one after a failed discovery) could pin a
    // session resolution from partial data.
    const pinBlocked = incomplete || catalogIncomplete || discoveryPromise !== undefined;
    // An empty response is not a catalog opportunity: it must not suppress
    // lazy discovery on the first routing request.
    if (stored > 0) catalogIncomplete = incomplete;
    // Paginated discovery ingests page by page, and a proxied page that
    // advertises further pages is incomplete; pinning must wait until the
    // full catalog is assembled so an early page cannot lock in an older ID.
    if (pin && !pinBlocked) pinFromCatalog();
  }
  function hasPaginationContinuation(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const record = payload as Record<string, unknown>;
    const pagination = record.pagination && typeof record.pagination === "object" ? record.pagination as Record<string, unknown> : {};
    if (record.has_more === true || pagination.has_more === true) return true;
    return [record.next, record.next_url, record.next_cursor, record.cursor, pagination.next, pagination.next_url, pagination.next_cursor, pagination.cursor]
      .some(value => (typeof value === "string" && value.length > 0) || typeof value === "number");
  }
  function actionableResolutionError(families: CodexLatestFamily[], detail: string, kind: CodexLatestResolutionErrorKind = "discovery"): CodexLatestResolutionError {
    const family = families[0] ?? "luna";
    const envKeys = [...new Set(aliasNeeds().filter(need => families.includes(need.family)).map(need => CODEX_MODEL_ENV_KEYS[need.tier]))];
    const configure = envKeys.length > 0 ? envKeys.join(" or ") : CODEX_MODEL_ENV_KEYS.fast;
    return new CodexLatestResolutionError(family, kind,
      `Unable to resolve '${family}:latest' for the Codex provider: ${detail}. Configure an exact Codex model ID instead of '${family}:latest' (for example ${configure}=<exact catalog model ID>), or check that the Codex upstream is authenticated and advertises a ${family} model.`);
  }
  function catalogBaseURL(): string {
    return (options.chatgptBaseURL ?? options.apiBaseURL ?? "https://chatgpt.com/backend-api/codex").replace(/\/$/, "");
  }
  function nextCatalogURL(payload: unknown, response: Response, currentURL: string, entries: CatalogEntryLike[], families: CodexLatestFamily[]): string | undefined {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const pagination = record.pagination && typeof record.pagination === "object" ? record.pagination as Record<string, unknown> : {};
    const link = response.headers.get("link")?.match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1];
    const explicit = link ?? [record.next, record.next_url, pagination.next, pagination.next_url].find((value): value is string => typeof value === "string" && value.length > 0);
    if (explicit) {
      let next: URL;
      try { next = new URL(explicit, currentURL); }
      catch { throw actionableResolutionError(families, "catalog pagination target was not a valid URL"); }
      // Never send upstream credentials to a different host.
      if (next.origin !== new URL(currentURL).origin) throw actionableResolutionError(families, "catalog pagination target on a different origin was refused");
      return next.toString();
    }
    const cursor = [record.next_cursor, record.cursor, pagination.next_cursor, pagination.cursor]
      .find((value): value is string | number => (typeof value === "string" && value.length > 0) || typeof value === "number");
    if (cursor !== undefined) {
      const next = new URL(`${catalogBaseURL()}/models`);
      next.searchParams.set("cursor", String(cursor));
      return next.toString();
    }
    if (record.has_more === true || pagination.has_more === true) {
      const lastId = entries.length > 0 ? modelIdOf(entries[entries.length - 1]) : undefined;
      if (!lastId) throw actionableResolutionError(families, "catalog advertised more pages without a usable continuation");
      const next = new URL(`${catalogBaseURL()}/models`);
      next.searchParams.set("after", lastId);
      return next.toString();
    }
    return undefined;
  }
  async function fetchCatalog(headers: Headers, signal: AbortSignal | undefined, families: CodexLatestFamily[]): Promise<void> {
    const visited = new Set<string>();
    let url: string | undefined = `${catalogBaseURL()}/models`;
    let totalEntries = 0;
    let cycle = false;
    for (let page = 0; url && page < 10; page++) {
      if (visited.has(url)) { cycle = true; break; }
      visited.add(url);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
      const onAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      let response: Response;
      let payload: unknown;
      try {
        response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
        if (!response.ok) throw actionableResolutionError(families, `catalog request failed (HTTP ${response.status})`);
        try { payload = await response.json(); } catch { throw actionableResolutionError(families, "catalog response was malformed"); }
      } catch (error) {
        if (error instanceof CodexLatestResolutionError) throw error;
        if (timedOut) throw actionableResolutionError(families, "catalog request timed out");
        if (signal?.aborted) throw actionableResolutionError(families, "catalog request was cancelled");
        throw actionableResolutionError(families, `catalog request failed (${error instanceof Error ? error.name : "unknown error"})`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      const entries = extractCatalogEntries(payload);
      totalEntries += entries.length;
      // The catalog stays marked incomplete until every page has arrived, so
      // a concurrent or post-failure request can never pin from partial data.
      ingestCatalog(entries, false, true);
      url = nextCatalogURL(payload, response, url, entries, families);
    }
    // Fail closed rather than resolving from a truncated catalog.
    if (cycle) throw actionableResolutionError(families, "catalog pagination cycle detected");
    if (url) throw actionableResolutionError(families, "catalog pagination did not complete within the page limit");
    if (totalEntries === 0) throw actionableResolutionError(families, "catalog response was empty");
    catalogIncomplete = false;
    pinFromCatalog();
  }
  async function ensureAliasesResolved(families: CodexLatestFamily[], headers: Headers, signal: AbortSignal | undefined): Promise<void> {
    const wanted = [...new Set(families)];
    if (wanted.length === 0 || wanted.every(family => resolvedAliases.has(family))) return;
    // A catalog learned from a complete proxied /models response can pin
    // immediately. An incomplete one (it advertised further pages, or a
    // discovery is still paginating / previously failed mid-pagination)
    // must not: never pin from partial data.
    if (!discoveryPromise && !catalogIncomplete) {
      pinFromCatalog();
      if (wanted.every(family => resolvedAliases.has(family))) return;
    }
    // Otherwise make an authenticated discovery attempt with this request's
    // headers, even if an earlier (empty, incomplete, or family-missing)
    // catalog was seen. Concurrent requests share and await the one
    // in-flight discovery, so they use the first request's headers until
    // it settles rather than pinning from its partial pages.
    if (!discoveryPromise) {
      discoveryPromise = fetchCatalog(headers, signal, wanted).finally(() => { discoveryPromise = undefined; });
    }
    await discoveryPromise;
    for (const family of wanted) {
      if (resolvedAliases.has(family)) continue;
      try { resolvedAliases.set(family, resolveLatestFamily(family, [...catalog.values()])); }
      catch (error) {
        const kind = error instanceof CodexLatestResolutionError ? error.kind : "discovery";
        throw actionableResolutionError([family], error instanceof Error ? error.message : "catalog discovery failed", kind);
      }
    }
  }
  async function prepare(body: CodexBody, headers: Headers, compact: boolean, signal?: AbortSignal) {
    const key = (body.previous_response_id ? responseKeys.get(body.previous_response_id) : undefined) ?? conversationKey(body, headers);
    const previous = locks.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const explicitAliasFamily = body.model !== AUTO_MODEL ? parseLatestAlias(body.model) : null;
      if (body.model === AUTO_MODEL) {
        const families = aliasNeeds().map(need => need.family);
        if (families.length > 0) await ensureAliasesResolved(families, headers, signal);
      } else if (explicitAliasFamily) {
        await ensureAliasesResolved([explicitAliasFamily], headers, signal);
      }
      const candidates = candidatesFor(config, catalog, resolvedAliases);
      if (body.model === AUTO_MODEL) {
        // Defense in depth: an unresolved alias must never reach routing,
        // feedback, JSONL, or the upstream payload via a candidate ID.
        const unresolved = candidates.map(candidate => parseLatestAlias(candidate.id)).find((family): family is CodexLatestFamily => family !== null);
        if (unresolved) throw actionableResolutionError([unresolved], `'${unresolved}:latest' remained unresolved after catalog discovery`);
      }
      let state = states.get(key);
      if (!state) {
        const startCandidate = candidates.find(candidate => candidate.tier === config.startTier) ?? candidates.find(candidate => candidate.tier === "fast")!;
        state = { tier: startCandidate.tier, model: startCandidate.id, effort: { updates: [] }, observations: [] };
        states.set(key, state);
        // One wrapper normally has one main conversation; bound auxiliary-session storage.
        if (states.size > 100) states.delete(states.keys().next().value!);
      }
      if (body.model !== AUTO_MODEL) {
        let requestedModel = body.model;
        if (explicitAliasFamily) {
          const resolved = resolvedAliases.get(explicitAliasFamily);
          if (!resolved) throw actionableResolutionError([explicitAliasFamily], `no resolved catalog model is available for '${explicitAliasFamily}:latest'`);
          requestedModel = resolved;
        }
        const match = candidates.find(candidate => candidate.id === requestedModel);
        body.model = requestedModel;
        state.model = requestedModel;
        state.tier = match?.tier ?? state.tier;
        state.effort = { base: body.reasoning?.effort, effort: body.reasoning?.effort, updates: [] };
        if (Array.isArray(body.input)) body.input = body.input.filter(item => !isJevNotice(item));
        return { key, state, decisionId: undefined as string | undefined, notice: undefined as string | undefined, noticeKey: undefined as string | undefined };
      }
      const turn = compact ? undefined : newTurn(body);
      const turnKey = turn && (body.previous_response_id ? hash(`${body.previous_response_id}|${turn.anchor}`) : turn.anchor);
      let notice: string | undefined;
      let noticeKey: string | undefined;
      if (turn && turnKey !== state.lastTurn) {
        const started = Date.now();
        const currentModel = state.model;
        const currentTier = state.tier;
        const last = state.last;
        const cache = summarizeCacheRun(state.observations, currentModel, started);
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
        state.decisionId = id;
        noticeKey = `${key}:${turnKey}`;
        const jevUsage = result.response?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        telemetry.decision(id, jevUsage?.input_tokens, jevUsage?.output_tokens);
        const feedbackValues: FeedbackValues = {
          tier: selected.tier, model: selected.id, effort, decision: decisionLabel(decision.reason), confidence,
          previous_model: currentModel, cache_read: last?.read ?? null, cache_write: last?.created ?? null,
          jev_tokens_input: typeof jevUsage?.input_tokens === "number" && Number.isFinite(jevUsage.input_tokens) ? jevUsage.input_tokens : undefined,
          jev_tokens_output: typeof jevUsage?.output_tokens === "number" && Number.isFinite(jevUsage.output_tokens) ? jevUsage.output_tokens : undefined,
        };
        notice = config.showFeedback ? formatFeedback(config.feedbackFormat, feedbackValues) : undefined;
        if (notice !== undefined) options.onNotice?.(notice);
        state.notice = notice;
        state.noticeKey = noticeKey;
        history.append({ id, at: new Date().toISOString(), conversation: key, turn: turnKey, prompt: turn.prompt, jev: result, previous: { tier: currentTier, model: currentModel, effort: previousEffort ?? null }, decision: { ...decision, model: selected.id, effort: effort ?? null, effort_update_preserves_prefix: preserved }, cache },
          result.response?.answers as SensitivityAnswers | undefined, config.minConfidence);
      } else if (!compact) {
        applyEffort(body, state.effort, state.model, state.effort.effort, turn?.anchor);
        if (turn) { notice = state.notice; noticeKey = state.noticeKey; }
      }
      body.model = state.model;
      if (Array.isArray(body.input)) body.input = body.input.filter(item => !isJevNotice(item));
      return { key, state, decisionId: state.decisionId, notice, noticeKey };
    });
    locks.set(key, job);
    try { return await job; } finally { if (locks.get(key) === job) locks.delete(key); }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      let telemetryRequest: string | undefined;
      let telemetryFinished = false;
      const finishTelemetry = (status: string, usage: ReturnType<typeof extractUsage> = null, reportedModel?: unknown) => {
        if (telemetryRequest && !telemetryFinished) { telemetryFinished = true; telemetry.finish(telemetryRequest, status, usage, reportedModel); }
      };
      try {
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/v1(?=\/)/, "");
        const base = /\/models$/.test(path) || request.headers.has("chatgpt-account-id") ? options.chatgptBaseURL ?? "https://chatgpt.com/backend-api/codex" : options.apiBaseURL ?? "https://api.openai.com/v1";
        const headers = new Headers(request.headers);
        for (const name of ["host", "content-length", "transfer-encoding", "connection", "accept-encoding"]) headers.delete(name);
        let payload = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
        let body: CodexBody | undefined;
        let routingMode = "unknown";
        if (request.method === "POST" && /\/responses(?:\/compact)?$/.test(path)) {
          try { body = JSON.parse(new TextDecoder().decode(payload)); } catch { return Response.json({ error: { message: "Invalid JSON request" } }, { status: 400 }); }
          if (body && typeof body.model === "string") {
            routingMode = body.model === AUTO_MODEL ? "automatic" : "explicit_model";
            prepared = await prepare(body, headers, path.endsWith("/compact"), request.signal);
            payload = new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer;
          }
        }
        if (prepared && telemetry.enabled) {
          const lastInput = Array.isArray(body?.input) ? body.input.at(-1) : undefined;
          const requestKind = path.endsWith("/compact") ? "compact" : lastInput && ["function_call_output", "custom_tool_call_output"].includes(lastInput.type ?? "") ? "tool_continuation" : "other";
          telemetryRequest = telemetry.start(body?.model, body?.reasoning?.effort, prepared.decisionId, requestKind, routingMode);
        }
        const response = await fetch(`${base.replace(/\/$/, "")}${path}${url.search}`, { method: request.method, headers, body: payload, signal: request.signal, redirect: "manual" });
        const responseHeaders = new Headers(response.headers);
        for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"]) responseHeaders.delete(name);
        if (/\/models$/.test(path) && response.ok) {
          const data = await response.json() as { models?: CatalogModel[] };
          const incomplete = hasPaginationContinuation(data) || /rel\s*=\s*"?next"?/i.test(response.headers.get("link") ?? "");
          if (Array.isArray(data.models)) {
            // Capture the raw upstream catalog before injecting AUTO_MODEL.
            ingestCatalog(data.models, true, incomplete);
            const autoModel = data.models.find(model => model.slug === AUTO_MODEL);
            if (autoModel) autoModel.display_name = codexStatusModelName(config.statusFormat);
            else if (data.models[0]) data.models.unshift({ ...data.models[0], slug: AUTO_MODEL, display_name: codexStatusModelName(config.statusFormat), description: "JEV selects the model tier and reasoning effort for each turn.", visibility: "list", supported_in_api: true, priority: 0, upgrade: null });
          } else {
            const entries = extractCatalogEntries(data);
            if (entries.length > 0) ingestCatalog(entries, true, incomplete);
          }
          return Response.json(data, { status: response.status, headers: responseHeaders });
        }
        if (!prepared || !response.ok || !response.body || path.endsWith("/compact")) {
          finishTelemetry(!response.ok ? "http_failure" : "unobserved");
          return new Response(response.body, { status: response.status, headers: responseHeaders });
        }
        const { state, notice, noticeKey } = prepared;
        const turnId = state.lastTurn;
        const usage = (value: Usage) => {
          if (value.responseId) {
            responseKeys.set(value.responseId, prepared.key);
            if (responseKeys.size > 1000) responseKeys.delete(responseKeys.keys().next().value!);
          }
          const now = Date.now();
          const isCompletion = value.read !== null || value.created !== null || value.responseId != null;
          state.last = { ...value, at: now };
          if (isCompletion || value.model !== body!.model) {
            const obs: ResponseObservation = { model: value.model, read: value.read, created: value.created, at: now };
            state.observations = state.observations.filter(prev => prev.at !== now || prev.model !== obs.model);
            state.observations.push(obs);
            state.observations = state.observations.filter(prev => now - prev.at <= 3_600_000).slice(-200);
          }
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
          return new Response(observeStream(response.body, body!.model, getNotice, usage, finishTelemetry, () => { if (telemetryRequest) telemetry.conflict(telemetryRequest); }), { status: response.status, headers: responseHeaders });
        }
        if (response.headers.get("content-type")?.includes("application/json")) {
          const data = await response.arrayBuffer();
          try {
            const parsed = JSON.parse(new TextDecoder().decode(data));
            const details = parsed.usage?.input_tokens_details;
            usage({ model: parsed.model ?? body!.model, read: details?.cached_tokens ?? null, created: details?.cache_write_tokens ?? null, responseId: parsed.id });
            finishTelemetry(parsed.status === "completed" ? "completed" : parsed.status === "failed" ? "failed" : "unobserved", extractUsage(parsed), parsed.model);
          } catch { finishTelemetry("unobserved"); }
          return new Response(data, { status: response.status, headers: responseHeaders });
        }
        finishTelemetry("unobserved");
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      } catch (error) {
        finishTelemetry("request_failed");
        return Response.json({ error: { type: "proxy_error", message: error instanceof Error ? error.message : "Upstream request failed" } }, { status: 502 });
      }
    },
  });
  return { port: server.port!, logPath: history.path, close: () => server.stop(true) };
}
