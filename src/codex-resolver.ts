/**
 * Resolution of Codex `family:latest` aliases (issue #59; default since #61).
 *
 * An alias such as `luna:latest` is router configuration only: it must never
 * be sent upstream. This module deterministically picks one exact catalog ID
 * for a family, or throws instead of guessing.
 *
 * Selection rule (verified against synthetic fixtures only; no real provider
 * catalog was available when this was written, so no unverified provider
 * field is claimed as fact):
 * 1. Prefer explicit authoritative metadata on an entry: a family field that
 *    names the family, and/or a flag advertising the entry as the current
 *    latest model for that family.
 * 2. Otherwise recognize only strict documented ID patterns
 *    `(gpt|chatgpt)-<dotted numeric version>-<luna|terra|sol|astra>` and compare
 *    numeric version tuples (6.10 > 6.9), never lexicographic order or
 *    response order.
 * 3. Exclude preview/beta/rc-style variants unless explicitly advertised as
 *    current, exclude entries superseded by a catalog entry that is present,
 *    deduplicate IDs, and never use the virtual router model as a candidate.
 * Capabilities are never inferred from display names; the caller reads
 * effort/context metadata from the resolved entry itself.
 */

export const CODEX_LATEST_FAMILIES = ["luna", "terra", "sol", "astra"] as const;
export type CodexLatestFamily = (typeof CODEX_LATEST_FAMILIES)[number];

/** Virtual router model ID; it is never a discovery candidate. `proxy.ts` re-exports it as `AUTO_MODEL`. */
export const VIRTUAL_MODEL_ID = "coding-router-jev";

export type CatalogEntryLike = {
  slug?: unknown;
  id?: unknown;
  [key: string]: unknown;
};

export type CodexLatestResolutionErrorKind = "missing" | "ambiguous" | "discovery";

export class CodexLatestResolutionError extends Error {
  readonly family: CodexLatestFamily;
  readonly kind: CodexLatestResolutionErrorKind;

  constructor(family: CodexLatestFamily, kind: CodexLatestResolutionErrorKind, message: string) {
    super(message);
    this.name = "CodexLatestResolutionError";
    this.family = family;
    this.kind = kind;
  }
}

/** Parse `luna:latest` / `terra:latest` / `sol:latest` / `astra:latest` (case/space tolerant). */
export function parseLatestAlias(value: unknown): CodexLatestFamily | null {
  if (typeof value !== "string") return null;
  const match = /^(luna|terra|sol|astra):latest$/.exec(value.trim().toLowerCase());
  return match ? (match[1] as CodexLatestFamily) : null;
}

export function isLatestAlias(value: unknown): boolean {
  return parseLatestAlias(value) !== null;
}

/** Exact upstream ID of a catalog entry (`slug` for Codex, `id` for list APIs). */
export function modelIdOf(entry: CatalogEntryLike): string | undefined {
  for (const candidate of [entry.slug, entry.id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

export function parseVersionTuple(value: unknown): number[] | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return [value];
  if (typeof value === "string") {
    const text = value.trim().replace(/^v/i, "");
    if (!/^\d+(?:\.\d+)*$/.test(text)) return undefined;
    return text.split(".").map(part => Number(part));
  }
  if (Array.isArray(value) && value.length > 0) {
    const tuple: number[] = [];
    for (const part of value) {
      const parsed = typeof part === "number" ? part : typeof part === "string" && /^\d+$/.test(part.trim()) ? Number(part.trim()) : NaN;
      if (!Number.isFinite(parsed) || parsed < 0) return undefined;
      tuple.push(parsed);
    }
    return tuple;
  }
  return undefined;
}

export function compareVersionTuples(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const ID_PATTERN = /^(?:gpt|chatgpt)-(\d+(?:\.\d+)*)-(luna|terra|sol|astra)$/i;
const PREVIEW_ID = /(?:^|-)(?:preview|beta|alpha|rc|pre|dev|experimental)(?:-|$)/i;

function stringField(entry: CatalogEntryLike, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return undefined;
}

function booleanField(entry: CatalogEntryLike, keys: string[]): boolean {
  return keys.some(key => entry[key] === true);
}

function successorIdOf(entry: CatalogEntryLike): string | undefined {
  for (const key of ["successor", "superseded_by", "replaced_by", "replacement", "upgrade"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const record = value as CatalogEntryLike;
      const nested = modelIdOf(record) ?? (typeof record.model === "string" ? record.model.trim() : undefined);
      if (nested) return nested;
    }
  }
  return undefined;
}

type AnalyzedEntry = {
  id: string;
  version?: number[];
  explicitCurrent: boolean;
  explicitStable: boolean;
  preview: boolean;
  superseded: boolean;
  explicitFamily?: CodexLatestFamily;
  familyFromId?: CodexLatestFamily;
};

function analyzeEntry(entry: CatalogEntryLike, id: string, presentIds: Set<string>): AnalyzedEntry {
  const idMatch = ID_PATTERN.exec(id);
  const explicitFamilyRaw = stringField(entry, ["family", "model_family", "family_name"]);
  const explicitFamily = explicitFamilyRaw && (CODEX_LATEST_FAMILIES as readonly string[]).includes(explicitFamilyRaw)
    ? (explicitFamilyRaw as CodexLatestFamily)
    : undefined;
  const familyFromId = idMatch ? (idMatch[2].toLowerCase() as CodexLatestFamily) : undefined;
  const explicitCurrent = booleanField(entry, ["is_latest", "latest", "is_current", "current", "is_current_stable", "is_latest_stable"])
    || ["latest", "current"].includes(stringField(entry, ["status", "state"]) ?? "");
  const explicitStable = booleanField(entry, ["is_stable", "stable", "is_current_stable", "is_latest_stable"])
    || stringField(entry, ["stability", "status", "state"]) === "stable";
  const preview = PREVIEW_ID.test(id)
    || booleanField(entry, ["is_preview", "preview"])
    || ["preview", "beta", "alpha"].includes(stringField(entry, ["stability", "status", "state"]) ?? "");
  const successor = successorIdOf(entry);
  const superseded = booleanField(entry, ["superseded", "is_superseded"])
    || (successor !== undefined && successor !== id && presentIds.has(successor));
  return {
    id,
    version: parseVersionTuple(entry.version ?? entry.model_version ?? entry.version_tuple)
      ?? (idMatch ? parseVersionTuple(idMatch[1]) : undefined),
    explicitCurrent,
    explicitStable,
    preview,
    superseded,
    ...(explicitFamily ? { explicitFamily } : {}),
    ...(familyFromId ? { familyFromId } : {}),
  };
}

/**
 * Resolve one family to an exact catalog ID.
 * Throws {@link CodexLatestResolutionError} on missing/ambiguous discovery.
 */
export function resolveLatestFamily(family: CodexLatestFamily, entries: readonly CatalogEntryLike[]): string {
  const byId = new Map<string, CatalogEntryLike>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const id = modelIdOf(entry);
    if (!id || id === VIRTUAL_MODEL_ID || byId.has(id)) continue;
    byId.set(id, entry);
  }
  const presentIds = new Set(byId.keys());
  const eligible: AnalyzedEntry[] = [];
  for (const [id, entry] of byId) {
    const analyzed = analyzeEntry(entry, id, presentIds);
    const entryFamily = analyzed.explicitFamily ?? analyzed.familyFromId;
    if (entryFamily !== family) continue;
    if (analyzed.superseded) continue;
    if (analyzed.preview && !analyzed.explicitCurrent) continue;
    eligible.push(analyzed);
  }
  if (eligible.length === 0) {
    throw new CodexLatestResolutionError(family, "missing", `No eligible catalog model found for Codex family '${family}'`);
  }
  const current = eligible.filter(entry => entry.explicitCurrent);
  if (current.length === 1) return current[0].id;
  if (current.length > 1) {
    throw new CodexLatestResolutionError(family, "ambiguous", `Multiple catalog models are advertised as current for Codex family '${family}': ${current.map(entry => entry.id).sort().join(", ")}`);
  }
  if (eligible.length === 1) return eligible[0].id;
  if (eligible.some(entry => entry.version === undefined)) {
    throw new CodexLatestResolutionError(family, "ambiguous", `Catalog models for Codex family '${family}' cannot be ordered by version: ${eligible.map(entry => entry.id).sort().join(", ")}`);
  }
  let best = eligible[0].version!;
  for (const entry of eligible) if (compareVersionTuples(entry.version!, best) > 0) best = entry.version!;
  const tied = eligible.filter(entry => compareVersionTuples(entry.version!, best) === 0);
  if (tied.length === 1) return tied[0].id;
  const stable = tied.filter(entry => entry.explicitStable);
  if (stable.length === 1) return stable[0].id;
  throw new CodexLatestResolutionError(family, "ambiguous", `Multiple catalog models tie as the latest for Codex family '${family}': ${tied.map(entry => entry.id).sort().join(", ")}`);
}

/** Extract raw catalog entries from `{ models: [] }`, `{ data: [] }`, or an array payload. */
export function extractCatalogEntries(payload: unknown): CatalogEntryLike[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? (payload as { models?: unknown }).models ?? (payload as { data?: unknown }).data ?? (payload as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is CatalogEntryLike => Boolean(entry) && typeof entry === "object");
}
