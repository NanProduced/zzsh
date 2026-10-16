/**
 * Page data state for user/admin credit, membership and directory reads. Separates a legal empty result from
 * read failure, missing authorization and source still pending. Unknown never becomes 0: values stay null.
 */
export type PageDataState = "READY" | "LEGAL_EMPTY" | "PENDING_SOURCE" | "UNAUTHORIZED" | "FAILED";
export type PageData<T> = { state: PageDataState; reason: string | null; value: T | null };

export function pageError(status: number, code?: string): PageData<never> {
  if (status === 401 || status === 403) return { state: "UNAUTHORIZED", reason: code ?? `HTTP_${status}`, value: null };
  // 404 on a known subject route is not "empty": the object/feature is not exposed.
  return { state: "FAILED", reason: code ?? `HTTP_${status}`, value: null };
}

/** Credit: absent profile is PENDING_SOURCE (awaiting formal initialization), never a synthetic 100. */
export function creditPageData<T extends { score: number }>(input: { creditState: "INITIALIZED" | "NOT_INITIALIZED"; credit: T | null }): PageData<T> {
  if (input.creditState === "INITIALIZED") {
    if (!input.credit || !Number.isInteger(input.credit.score)) return { state: "FAILED", reason: "INITIALIZED_WITHOUT_SNAPSHOT", value: null };
    return { state: "READY", reason: null, value: input.credit };
  }
  if (input.credit !== null) return { state: "FAILED", reason: "SNAPSHOT_STATE_CONFLICT", value: null };
  return { state: "PENDING_SOURCE", reason: "CREDIT_NOT_INITIALIZED", value: null };
}

/** Membership growth: only COMPLETE source + KNOWN projection is READY; BACKFILL_PENDING keeps the projection but flags it partial. */
export function growthPageData<T extends { growth: { sourceState?: string; knowledge?: string } }>(input: T | null): PageData<T> {
  if (input === null) return { state: "PENDING_SOURCE", reason: "GROWTH_NOT_AVAILABLE", value: null };
  const s = input.growth?.sourceState;
  // Source COMPLETE does not imply a known projection (e.g. negative net consumption): READY needs both.
  if (s === "COMPLETE") return input.growth.knowledge === "KNOWN" ? { state: "READY", reason: null, value: input } : { state: "PENDING_SOURCE", reason: "PROJECTION_UNKNOWN", value: input };
  if (s === "BACKFILL_PENDING") return { state: "PENDING_SOURCE", reason: "BACKFILL_PENDING", value: input };
  if (s === "READ_FAILED" || s === "SOURCE_CONFLICT") return { state: "FAILED", reason: s, value: null };
  if (s === "NO_POLICY") return { state: "PENDING_SOURCE", reason: "NO_POLICY", value: input };
  return { state: "FAILED", reason: "SOURCE_STATE_UNKNOWN", value: null };
}

/** Lists: an empty page is LEGAL_EMPTY only when the source is proved complete for that scope. */
export function listPageData<T>(items: readonly T[] | null, coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN"): PageData<readonly T[]> {
  if (items === null) return { state: "FAILED", reason: "LIST_UNAVAILABLE", value: null };
  if (coverage !== "COMPLETE") return { state: "PENDING_SOURCE", reason: `COVERAGE_${coverage}`, value: items };
  return items.length === 0 ? { state: "LEGAL_EMPTY", reason: null, value: items } : { state: "READY", reason: null, value: items };
}

/** Money/count display: unknown stays null; only proven values are strings. */
export function knownCents(value: string | null | undefined): string | null {
  return typeof value === "string" && /^-?(0|[1-9]\d{0,23})$/.test(value) ? value : null;
}
