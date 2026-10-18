import { canonicalize } from "../supply/content-hash";
import { sha256Hex } from "../supply/supply-util";

/**
 * Old platform four holding columns -> current skin ids, per account.
 *
 * The old platform stored holdings as comma separated display strings. The new
 * catalog models a skin as (owner type, owner, base name) plus an independent,
 * data-defined quality (skin_rarity). A column only hints the owner TYPE; it
 * never decides quality, and a column name such as gold_skin is a source label,
 * not a rarity.
 */
export const LEGACY_SKIN_FIELDS = ["knife_skin", "agent_skin", "weapon_skin", "gold_skin"] as const;
export type LegacySkinField = (typeof LEGACY_SKIN_FIELDS)[number];
export type SkinOwnerTypeHint = "MELEE_TYPE" | "AGENT" | "FIREARM";
export const LEGACY_SKIN_FIELD_TYPE_HINT: Readonly<Record<LegacySkinField, SkinOwnerTypeHint>> = {
  knife_skin: "MELEE_TYPE",
  agent_skin: "AGENT",
  weapon_skin: "FIREARM",
  gold_skin: "AGENT",
};

export type LegacySkinCatalogEntry = {
  skinId: string;
  gameId: string;
  sourceField: string | null;
  sourceToken: string | null;
  namingState: "LEGACY" | "PENDING" | "VERIFIED";
  enabled: boolean;
  formVisible: boolean;
};
/** One old dictionary row a held token can come from. Kept verbatim; never inferred from a column or dict type. */
export type LegacySkinSourceRef = {
  dictField: string;
  dictTypeId: number | null;
  dictDataId: number;
  state: "HISTORICAL_SOFT_DELETED" | "CURRENT";
};
/** Explicit, reviewed decisions for held tokens that are not a catalog source tuple. */
export type LegacySkinTokenRule =
  | { field: LegacySkinField; token: string; decision: "ALIAS_OF"; targetField: LegacySkinField; targetToken: string }
  | { field: LegacySkinField; token: string; decision: "INVALID" | "HISTORICAL" | "PENDING_DECISION" }
  /**
   * Several old dictionary rows share this exact token, so a held token cannot
   * say which one the account had. This is a source fact, separate from catalog
   * naming: it may sit on the same key as a catalog source tuple and it stays
   * unresolved even after that catalog entry is VERIFIED, until a reviewed source
   * fact replaces the rule.
   */
  | { field: LegacySkinField; token: string; decision: "SOURCE_AMBIGUOUS"; sources: readonly LegacySkinSourceRef[] };
export type LegacySkinUnresolvedReason =
  | "NOT_IN_CATALOG" | "INVALID_TOKEN" | "HISTORICAL_ONLY" | "PENDING_DECISION" | "SOURCE_AMBIGUOUS" | "CROSS_GAME" | "AMBIGUOUS_SEPARATOR";
export type LegacySkinHoldingInput = {
  accountKey: string;
  gameId: string;
  /** Every column must be observed: null or "" is an observed empty column; a missing key or undefined is not. */
  columns: Record<LegacySkinField, string | null>;
};
export type LegacySkinHolding = {
  accountKey: string;
  gameId: string;
  catalogRevision: string;
  /** Columns the extract did not deliver. Any entry keeps the holding incomplete. */
  unobservedColumns: LegacySkinField[];
  tokens: Array<{ field: LegacySkinField; token: string }>;
  mappedSkinIds: string[];
  pending: Array<{ field: LegacySkinField; token: string; skinId: string; namingState: string }>;
  unresolved: Array<{ field: LegacySkinField; token: string; reason: LegacySkinUnresolvedReason }>;
  /** True only when all four columns were observed and every held token resolved to a public skin. Never true for a guess. */
  complete: boolean;
  digest: string;
};

const key = (field: string, token: string) => `${field}\u0000${token}`;

export function splitLegacySkinColumn(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string") throw new TypeError("Legacy skin column must be text");
  return [...new Set(value.split(",").map((part) => part.trim()).filter((part) => part.length > 0))];
}

export function buildLegacySkinIndex(catalog: readonly LegacySkinCatalogEntry[], rules: readonly LegacySkinTokenRule[] = []) {
  const bySource = new Map<string, LegacySkinCatalogEntry>();
  for (const entry of catalog) {
    if (!entry.sourceField || entry.sourceToken === null) continue;
    const k = key(entry.sourceField, entry.sourceToken);
    if (bySource.has(k)) throw new Error(`Duplicate catalog source tuple: ${entry.sourceField}`);
    bySource.set(k, entry);
  }
  const byRule = new Map<string, LegacySkinTokenRule>();
  for (const rule of rules) {
    const k = key(rule.field, rule.token);
    // Only a source ambiguity may share a key with a catalog tuple; any other rule there is a conflict, not a silent override.
    if (byRule.has(k) || (bySource.has(k) && rule.decision !== "SOURCE_AMBIGUOUS")) throw new Error(`Conflicting legacy token rule: ${rule.field}`);
    if (rule.decision === "ALIAS_OF" && !bySource.has(key(rule.targetField, rule.targetToken))) throw new Error(`Alias target missing: ${rule.targetField}`);
    if (rule.decision === "SOURCE_AMBIGUOUS") {
      const refs = new Set((rule.sources ?? []).map((s) => `${s.dictField}:${s.dictTypeId ?? ""}:${s.dictDataId}`));
      if (refs.size < 2 || refs.size !== rule.sources.length) throw new Error(`Source ambiguity needs two or more distinct sources: ${rule.field}`);
    }
    byRule.set(k, rule);
  }
  return { bySource, byRule };
}

export function mapLegacySkinHolding(
  input: LegacySkinHoldingInput,
  index: ReturnType<typeof buildLegacySkinIndex>,
  catalogRevision: string,
): LegacySkinHolding {
  if (!input.columns || typeof input.columns !== "object") throw new TypeError("Legacy skin columns are required");
  const extra = Object.keys(input.columns).filter((field) => !(LEGACY_SKIN_FIELDS as readonly string[]).includes(field));
  if (extra.length) throw new Error("Unexpected legacy skin column");
  const columns = input.columns as Partial<Record<LegacySkinField, string | null>>;
  const unobservedColumns = LEGACY_SKIN_FIELDS.filter((field) => !Object.hasOwn(columns, field) || columns[field] === undefined);
  const tokens: LegacySkinHolding["tokens"] = [];
  const mapped = new Set<string>();
  const pending: LegacySkinHolding["pending"] = [];
  const unresolved: LegacySkinHolding["unresolved"] = [];
  for (const field of LEGACY_SKIN_FIELDS) {
    if (unobservedColumns.includes(field)) continue;
    for (const token of splitLegacySkinColumn(columns[field])) {
      tokens.push({ field, token });
      if (token.includes("，")) { unresolved.push({ field, token, reason: "AMBIGUOUS_SEPARATOR" }); continue; }
      const rule = index.byRule.get(key(field, token));
      // Checked before the catalog on purpose: catalog naming state never settles which old row a token came from.
      if (rule?.decision === "SOURCE_AMBIGUOUS") { unresolved.push({ field, token, reason: "SOURCE_AMBIGUOUS" }); continue; }
      let entry = index.bySource.get(key(field, token));
      if (!entry && rule) {
        if (rule.decision !== "ALIAS_OF") {
          unresolved.push({ field, token, reason: rule.decision === "INVALID" ? "INVALID_TOKEN" : rule.decision === "HISTORICAL" ? "HISTORICAL_ONLY" : "PENDING_DECISION" });
          continue;
        }
        entry = index.bySource.get(key(rule.targetField, rule.targetToken));
      }
      if (!entry) { unresolved.push({ field, token, reason: "NOT_IN_CATALOG" }); continue; }
      if (entry.gameId !== input.gameId) { unresolved.push({ field, token, reason: "CROSS_GAME" }); continue; }
      if (entry.namingState === "VERIFIED" && entry.enabled && entry.formVisible) mapped.add(entry.skinId);
      else pending.push({ field, token, skinId: entry.skinId, namingState: entry.namingState });
    }
  }
  const body = {
    accountKey: input.accountKey,
    gameId: input.gameId,
    catalogRevision,
    unobservedColumns,
    tokens,
    mappedSkinIds: [...mapped].sort(),
    pending,
    unresolved,
    complete: unobservedColumns.length === 0 && pending.length === 0 && unresolved.length === 0,
  };
  return { ...body, digest: sha256Hex(canonicalize(body)) };
}

/** Skin ids that may be written as a complete declaration; null while any column is unobserved or anything is unresolved. */
export function declarableLegacySkinIds(holding: LegacySkinHolding): string[] | null {
  return holding.complete ? [...holding.mappedSkinIds] : null;
}