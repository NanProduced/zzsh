import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { contributionFromSettlement, type GrowthContribution, type SettledContributionFact } from "./membership-growth";
import { growthContributionSourceDigest, normalizeGrowthInstant } from "./membership-growth-integration";
import { canonicalize } from "../supply/content-hash";
import type { LegacyGrowthCoverageReceipt } from "../order/legacy-growth-consumption";

/**
 * Legacy (la_order) growth backfill writer. Consumes T's closeLegacyGrowthCoverage output unchanged.
 * Writes only admitted, in-scope SETTLED facts; never derives growth from deposit/commission/balance/old tier.
 * Coverage COMPLETE vs BACKFILL_PENDING is reported, never upgraded; SOURCE_CONFLICT writes nothing.
 */
export const LEGACY_GROWTH_SOURCE_PREFIX = "legacy_mysql_restore:la_order:";

export type LegacyCoverageResult = {
  subjectUserId: string;
  state: "COMPLETE" | "BACKFILL_PENDING" | "SOURCE_CONFLICT";
  reason: string | null;
  facts: SettledContributionFact[];
  outOfScopeFacts: SettledContributionFact[];
  missingSourceKeys: string[] | null;
  unknown: { sourceKey: string; reason: string | null }[];
  scope?: { cutoff: string; fromExclusive: string | null } | null;
  expectedSourceKeys?: string[] | null;
};

export type LegacyGrowthBackfillInput = {
  coverage: LegacyCoverageResult;
  /** settlementId (legacy_mysql_restore:la_order:<id> or correction source id) -> gameId from the admitted binding. */
  gameIdBySettlementId: Readonly<Record<string, string>>;
  /** Digest of the approved extraction package; bound into the fingerprint, not into row digests. */
  packageDigest: string;
  /** The original T receipt that coverage was closed against (canonical form is recomputed, never caller-asserted). */
  receipt: LegacyGrowthCoverageReceipt | null;
};

/** Exact persisted coverage evidence for Q H3. Window/approval/clock fields are deliberately absent (stable). */
export type LegacyCoverageRecord = {
  schema: "legacy-growth-coverage-record-v1";
  subjectUserId: string;
  receiptCanonical: string;
  receiptDigest: string;
  cutoff: string;
  fromExclusive: string | null;
  sourceExtractSha256: string;
  sourceSetSha256: string;
  expectedSourceKeys: string[];
  refundReviewEvidenceRefs: string[];
  packageDigest: string;
  coverageState: "COMPLETE" | "BACKFILL_PENDING";
  coverageReason: string | null;
  missingSourceKeys: string[];
  unknownSourceKeys: string[];
  factKeys: { sourceKey: string; revision: number; sourceDigest: string }[];
  factSetDigest: string;
  fingerprint: string;
};

export type PreparedLegacyRow = { id: string; gameId: string; contribution: GrowthContribution; sourceDigest: string };
export type PreparedLegacyBackfill =
  | { ok: true; subjectUserId: string; coverageState: "COMPLETE" | "BACKFILL_PENDING"; coverageReason: string | null; rows: PreparedLegacyRow[]; skippedOutOfScope: number; fingerprint: string; record: LegacyCoverageRecord }
  | { ok: false; subjectUserId: string; code: "SOURCE_CONFLICT" | "INPUT_INVALID"; reason: string };

/** Stable per-source version hash: independent of which receipt admitted it, so re-extraction replays instead of conflicting. */
export function legacyGrowthVersionHash(settlementId: string, settlementVersion: string): string {
  return createHash("sha256").update(canonicalize({ schema: "legacy-growth-version-v1", settlementId, settlementVersion })).digest("hex");
}

function rowId(c: Pick<GrowthContribution, "userId" | "sourceKey" | "revision">): string {
  return `growth_contribution_${createHash("sha256").update(`${c.userId}\u0000${c.sourceKey}\u0000${c.revision}`).digest("hex").slice(0, 48)}`;
}

function isLegacySettlement(id: string): boolean {
  return id.startsWith(LEGACY_GROWTH_SOURCE_PREFIX) && /^[1-9]\d{0,23}$/.test(id.slice(LEGACY_GROWTH_SOURCE_PREFIX.length));
}

export function prepareLegacyGrowthBackfill(input: LegacyGrowthBackfillInput): PreparedLegacyBackfill {
  const cov = input.coverage, subjectUserId = cov.subjectUserId;
  const bad = (code: "SOURCE_CONFLICT" | "INPUT_INVALID", reason: string): PreparedLegacyBackfill => ({ ok: false, subjectUserId, code, reason });
  if (!/^[a-f0-9]{64}$/.test(input.packageDigest)) return bad("INPUT_INVALID", "PACKAGE_DIGEST_INVALID");
  if (cov.state === "SOURCE_CONFLICT") return bad("SOURCE_CONFLICT", cov.reason ?? "SOURCE_COVERAGE_CONFLICT");
  if (cov.state !== "COMPLETE" && cov.state !== "BACKFILL_PENDING") return bad("INPUT_INVALID", "COVERAGE_STATE_INVALID");
  // Without an admitted receipt the facts are not scope-filtered by cutoff; persist nothing.
  if (cov.state === "BACKFILL_PENDING" && cov.reason !== "SOURCE_FACTS_PENDING") return bad("INPUT_INVALID", cov.reason ?? "COVERAGE_NOT_ADMITTED");
  const receipt = input.receipt;
  if (!receipt) return bad("INPUT_INVALID", "RECEIPT_MISSING");
  const receiptCanonical = canonicalize(receipt);
  const receiptDigest = createHash("sha256").update(receiptCanonical).digest("hex");
  const sortedExpected = [...receipt.expectedSourceKeys].sort();
  if (receipt.subjectUserId !== subjectUserId || !cov.scope || cov.scope.cutoff !== receipt.cutoff || cov.scope.fromExclusive !== receipt.fromExclusive
    || !Array.isArray(cov.expectedSourceKeys) || canonicalize([...cov.expectedSourceKeys].sort()) !== canonicalize(sortedExpected)
    || !/^[a-f0-9]{64}$/.test(receipt.sourceExtractSha256) || !/^[a-f0-9]{64}$/.test(receipt.sourceSetSha256) || receipt.refundReviewEvidenceRefs.length === 0) return bad("SOURCE_CONFLICT", "RECEIPT_COVERAGE_MISMATCH");
  if (cov.state === "COMPLETE" && ((cov.missingSourceKeys?.length ?? 0) > 0 || cov.unknown.length > 0)) return bad("SOURCE_CONFLICT", "COMPLETE_WITH_GAPS");
  const rows: PreparedLegacyRow[] = [];
  const seen = new Map<string, string>();
  for (const fact of cov.facts) {
    if (fact.userId !== subjectUserId) return bad("SOURCE_CONFLICT", "FACT_SUBJECT_MISMATCH");
    if (fact.status !== "SETTLED") return bad("INPUT_INVALID", "FACT_NOT_SETTLED");
    const baseSettlement = fact.correctionOf ? fact.correctionOf.slice(fact.correctionOf.indexOf(":") + 1) : fact.settlementId;
    if (!isLegacySettlement(baseSettlement)) return bad("INPUT_INVALID", "FACT_NOT_LEGACY_SOURCE");
    const parsed = contributionFromSettlement(fact);
    if (!parsed.accepted) return bad("INPUT_INVALID", `ADAPTER_REJECTED:${parsed.reason}`);
    const gameId = input.gameIdBySettlementId[baseSettlement];
    if (typeof gameId !== "string" || !gameId) return bad("INPUT_INVALID", "GAME_BINDING_MISSING");
    const c = { ...parsed.contribution, effectiveAt: normalizeGrowthInstant(parsed.contribution.effectiveAt, "effectiveAt"), recordedAt: normalizeGrowthInstant(parsed.contribution.recordedAt, "recordedAt") };
    const sourceDigest = growthContributionSourceDigest(legacyGrowthVersionHash(fact.settlementId, fact.settlementVersion), gameId, c);
    const key = `${c.sourceKey}\u0000${c.revision}`;
    const prior = seen.get(key);
    if (prior !== undefined) { if (prior !== sourceDigest) return bad("SOURCE_CONFLICT", "DUPLICATE_REVISION_DIVERGES"); continue; }
    seen.set(key, sourceDigest);
    rows.push({ id: rowId(c), gameId, contribution: c, sourceDigest });
  }
  rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const factKeys = rows.map((r) => ({ sourceKey: r.contribution.sourceKey, revision: r.contribution.revision, sourceDigest: r.sourceDigest }))
    .sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : a.revision - b.revision));
  const factSetDigest = legacyFactSetDigest(factKeys);
  const fingerprint = createHash("sha256").update(canonicalize({ schema: "legacy-growth-backfill-v2", subjectUserId, packageDigest: input.packageDigest, receiptDigest, coverageState: cov.state, factSetDigest })).digest("hex");
  const record: LegacyCoverageRecord = { schema: "legacy-growth-coverage-record-v1", subjectUserId, receiptCanonical, receiptDigest, cutoff: receipt.cutoff, fromExclusive: receipt.fromExclusive,
    sourceExtractSha256: receipt.sourceExtractSha256, sourceSetSha256: receipt.sourceSetSha256, expectedSourceKeys: sortedExpected, refundReviewEvidenceRefs: [...receipt.refundReviewEvidenceRefs],
    packageDigest: input.packageDigest, coverageState: cov.state, coverageReason: cov.reason, missingSourceKeys: [...(cov.missingSourceKeys ?? [])].sort(), unknownSourceKeys: cov.unknown.map((u) => u.sourceKey).sort(),
    factKeys, factSetDigest, fingerprint };
  return { ok: true, subjectUserId, coverageState: cov.state, coverageReason: cov.reason, rows, skippedOutOfScope: cov.outOfScopeFacts.length, fingerprint, record };
}

export function legacyFactSetDigest(factKeys: readonly { sourceKey: string; revision: number; sourceDigest: string }[]): string {
  const sorted = [...factKeys].map((k) => [k.sourceKey, k.revision, k.sourceDigest] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return createHash("sha256").update(canonicalize({ schema: "legacy-growth-fact-set-v1", facts: sorted })).digest("hex");
}

/** Persistence port for Q H3 (coverage record table). Must run in the same transaction as the contributions. */
export type LegacyCoveragePort = {
  /** INSERT ... ON CONFLICT DO NOTHING on (subjectUserId, receiptDigest, fingerprint); returns the stored record (new or original). */
  persist(client: Pick<PoolClient, "query">, record: LegacyCoverageRecord): Promise<LegacyCoverageRecord>;
  read(client: Pick<PoolClient, "query">, subjectUserId: string, receiptDigest: string): Promise<LegacyCoverageRecord | null>;
};

/**
 * Reader seam: stored legacy rows are trusted only against a persisted, self-consistent coverage record.
 * Native/continuation increments after cutoff stay with the existing native completeness check.
 */
export function assessLegacyCoverageRecord(record: LegacyCoverageRecord | null, storedLegacyRows: readonly { sourceKey: string; revision: number; sourceDigest?: string | null; status: string }[]): { state: "COMPLETE" | "BACKFILL_PENDING" | "SOURCE_CONFLICT"; reasons: string[] } {
  const rows = storedLegacyRows.filter((r) => r.status !== "PENDING");
  if (!record) return { state: rows.length ? "BACKFILL_PENDING" : "BACKFILL_PENDING", reasons: ["LEGACY_COVERAGE_RECEIPT_MISSING"] };
  const digest = createHash("sha256").update(record.receiptCanonical).digest("hex");
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(record.receiptCanonical) as Record<string, unknown>; } catch { parsed = null; }
  if (digest !== record.receiptDigest || !parsed || parsed.subjectUserId !== record.subjectUserId || parsed.cutoff !== record.cutoff || parsed.sourceSetSha256 !== record.sourceSetSha256 || parsed.sourceExtractSha256 !== record.sourceExtractSha256
    || legacyFactSetDigest(record.factKeys) !== record.factSetDigest) return { state: "SOURCE_CONFLICT", reasons: ["LEGACY_COVERAGE_RECORD_INVALID"] };
  if (rows.some((r) => !r.sourceDigest)) return { state: "SOURCE_CONFLICT", reasons: ["LEGACY_ROW_DIGEST_MISSING"] };
  const stored = legacyFactSetDigest(rows.map((r) => ({ sourceKey: r.sourceKey, revision: Number(r.revision), sourceDigest: r.sourceDigest! })));
  if (stored !== record.factSetDigest) {
    const want = new Set(record.factKeys.map((k) => `${k.sourceKey}\u0000${k.revision}\u0000${k.sourceDigest}`));
    const extra = rows.some((r) => !want.has(`${r.sourceKey}\u0000${Number(r.revision)}\u0000${r.sourceDigest}`));
    return extra ? { state: "SOURCE_CONFLICT", reasons: ["LEGACY_FACT_SET_MISMATCH"] } : { state: "BACKFILL_PENDING", reasons: ["LEGACY_FACTS_NOT_INGESTED"] };
  }
  if (record.coverageState !== "COMPLETE") return { state: "BACKFILL_PENDING", reasons: [record.coverageReason ?? "SOURCE_FACTS_PENDING"] };
  return { state: "COMPLETE", reasons: [] };
}

export type LegacyGrowthWriteResult = { inserted: number; replayed: number; coverage: "INSERTED" | "REPLAYED" };
type Prepared = Extract<PreparedLegacyBackfill, { ok: true }>;

/**
 * Runs inside the caller's transaction: contributions, then the coverage record (original receipt) via the Q port.
 * Same key+body replays from the stored record; changed body under the same receipt is a conflict.
 */
export async function writePreparedLegacyGrowth(client: Pick<PoolClient, "query">, prepared: Prepared, port: LegacyCoveragePort): Promise<LegacyGrowthWriteResult> {
  const original = await port.read(client, prepared.subjectUserId, prepared.record.receiptDigest);
  if (original) {
    if (original.fingerprint !== prepared.fingerprint) throw new LegacyGrowthConflictError(`receipt:${prepared.record.receiptDigest}`, -1);
    return { inserted: 0, replayed: prepared.rows.length, coverage: "REPLAYED" }; // original success receipt; business preconditions not re-run
  }
  let inserted = 0, replayed = 0;
  for (const r of prepared.rows) {
    const c = r.contribution;
    const res = await client.query<{ id: string }>(
      `INSERT INTO zzsh_iam.membership_growth_contribution
         (id,user_id,game_id,source_key,source_type,source_id,settlement_version,revision,effective_at,recorded_at,amount_cents,previous_amount_cents,correction_of_source_key,correction_mode,state,eligible,source_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (user_id, source_key, revision) DO NOTHING RETURNING id`,
      [r.id, c.userId, r.gameId, c.sourceKey, c.sourceType, c.sourceId, c.settlementVersion, c.revision, c.effectiveAt, c.recordedAt, c.amountCents, c.previousAmountCents ?? null, c.correctionOf ?? null, c.correctionMode ?? null, c.status, c.eligible, r.sourceDigest],
    );
    if (res.rowCount === 1) { inserted += 1; continue; }
    const existing = (await client.query<{ sourceDigest: string }>(`SELECT source_digest AS "sourceDigest" FROM zzsh_iam.membership_growth_contribution WHERE user_id=$1 AND source_key=$2 AND revision=$3`, [c.userId, c.sourceKey, c.revision])).rows[0];
    if (!existing || existing.sourceDigest !== r.sourceDigest) throw new LegacyGrowthConflictError(c.sourceKey, c.revision);
    replayed += 1;
  }
  const stored = await port.persist(client, prepared.record);
  if (stored.fingerprint !== prepared.fingerprint) throw new LegacyGrowthConflictError(`receipt:${prepared.record.receiptDigest}`, -1);
  return { inserted, replayed, coverage: "INSERTED" };
}

export class LegacyGrowthConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(readonly sourceKey: string, readonly revision: number) { super(`LEGACY_GROWTH_REVISION_CONFLICT:${sourceKey}:${revision}`); }
}

export class LegacyGrowthOutcomeError extends Error {
  constructor(readonly outcome: "NOT_COMMITTED" | "COMMIT_UNKNOWN", readonly fingerprint: string, readonly receiptDigest: string, readonly rollbackAcknowledged: boolean, readonly cause: unknown) { super(`LEGACY_GROWTH_${outcome}`); }
}

/** One subject per transaction (failure isolation). A failed COMMIT is COMMIT_UNKNOWN and is resolved only by recoverLegacyGrowthBackfill. */
export async function runLegacyGrowthBackfill(pool: Pick<Pool, "connect">, prepared: Prepared, port: LegacyCoveragePort): Promise<LegacyGrowthWriteResult & { fingerprint: string; coverageState: string }> {
  const client = await pool.connect();
  let commitSent = false, broken = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await writePreparedLegacyGrowth(client, prepared, port);
    commitSent = true;
    await client.query("COMMIT");
    return { ...result, fingerprint: prepared.fingerprint, coverageState: prepared.coverageState };
  } catch (error) {
    if (commitSent) { broken = true; throw new LegacyGrowthOutcomeError("COMMIT_UNKNOWN", prepared.fingerprint, prepared.record.receiptDigest, false, error); }
    let ack = true;
    await client.query("ROLLBACK").catch(() => { ack = false; broken = true; });
    if (error instanceof LegacyGrowthConflictError) throw error;
    throw new LegacyGrowthOutcomeError("NOT_COMMITTED", prepared.fingerprint, prepared.record.receiptDigest, ack, error);
  } finally {
    client.release(broken ? true : undefined);
  }
}

export type LegacyGrowthRecovery = { status: "FOUND" | "NOT_FOUND" | "FINGERPRINT_MISMATCH"; found: number; missing: number; mismatched: number };

/**
 * Read-only recovery after COMMIT_UNKNOWN. The persisted coverage record is the original receipt: scanning
 * contribution rows alone is never FOUND (pre-existing rows do not prove this attempt committed).
 */
export async function recoverLegacyGrowthBackfill(client: Pick<PoolClient, "query">, prepared: Prepared, port: LegacyCoveragePort): Promise<LegacyGrowthRecovery> {
  const record = await port.read(client, prepared.subjectUserId, prepared.record.receiptDigest);
  let found = 0, missing = 0, mismatched = 0;
  for (const r of prepared.rows) {
    const row = (await client.query<{ sourceDigest: string }>(`SELECT source_digest AS "sourceDigest" FROM zzsh_iam.membership_growth_contribution WHERE user_id=$1 AND source_key=$2 AND revision=$3`, [r.contribution.userId, r.contribution.sourceKey, r.contribution.revision])).rows[0];
    if (!row) missing += 1; else if (row.sourceDigest !== r.sourceDigest) mismatched += 1; else found += 1;
  }
  if (!record) return { status: mismatched > 0 ? "FINGERPRINT_MISMATCH" : "NOT_FOUND", found, missing, mismatched };
  if (record.fingerprint !== prepared.fingerprint || mismatched > 0 || missing > 0) return { status: "FINGERPRINT_MISMATCH", found, missing, mismatched };
  return { status: "FOUND", found, missing, mismatched };
}