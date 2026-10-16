import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { contributionFromSettlement, type GrowthContribution, type SettledContributionFact } from "./membership-growth";
import { growthContributionSourceDigest, normalizeGrowthInstant } from "./membership-growth-integration";
import { canonicalize } from "../supply/content-hash";

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
};

export type LegacyGrowthBackfillInput = {
  coverage: LegacyCoverageResult;
  /** settlementId (legacy_mysql_restore:la_order:<id> or correction source id) -> gameId from the admitted binding. */
  gameIdBySettlementId: Readonly<Record<string, string>>;
  /** Digest of the approved extraction package; bound into the fingerprint, not into row digests. */
  packageDigest: string;
};

export type PreparedLegacyRow = { id: string; gameId: string; contribution: GrowthContribution; sourceDigest: string };
export type PreparedLegacyBackfill =
  | { ok: true; subjectUserId: string; coverageState: "COMPLETE" | "BACKFILL_PENDING"; coverageReason: string | null; rows: PreparedLegacyRow[]; skippedOutOfScope: number; fingerprint: string }
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
  const fingerprint = createHash("sha256").update(canonicalize({ schema: "legacy-growth-backfill-v1", subjectUserId, packageDigest: input.packageDigest, rows: rows.map((r) => [r.id, r.sourceDigest]) })).digest("hex");
  return { ok: true, subjectUserId, coverageState: cov.state, coverageReason: cov.reason, rows, skippedOutOfScope: cov.outOfScopeFacts.length, fingerprint };
}

export type LegacyGrowthWriteResult = { inserted: number; replayed: number };

/** Runs inside the caller's transaction. ON CONFLICT DO NOTHING + digest compare = idempotent original replay; divergence is 409-class. */
export async function writePreparedLegacyGrowth(client: Pick<PoolClient, "query">, prepared: Extract<PreparedLegacyBackfill, { ok: true }>): Promise<LegacyGrowthWriteResult> {
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
  return { inserted, replayed };
}

export class LegacyGrowthConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(readonly sourceKey: string, readonly revision: number) { super(`LEGACY_GROWTH_REVISION_CONFLICT:${sourceKey}:${revision}`); }
}

export class LegacyGrowthOutcomeError extends Error {
  constructor(readonly outcome: "NOT_COMMITTED" | "COMMIT_UNKNOWN", readonly fingerprint: string, readonly rollbackAcknowledged: boolean, readonly cause: unknown) { super(`LEGACY_GROWTH_${outcome}`); }
}

/** One subject per transaction (failure isolation). A failed COMMIT is COMMIT_UNKNOWN and is resolved only by recoverLegacyGrowthBackfill. */
export async function runLegacyGrowthBackfill(pool: Pick<Pool, "connect">, prepared: Extract<PreparedLegacyBackfill, { ok: true }>): Promise<LegacyGrowthWriteResult & { fingerprint: string; coverageState: string }> {
  const client = await pool.connect();
  let commitSent = false, broken = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await writePreparedLegacyGrowth(client, prepared);
    commitSent = true;
    await client.query("COMMIT");
    return { ...result, fingerprint: prepared.fingerprint, coverageState: prepared.coverageState };
  } catch (error) {
    if (error instanceof LegacyGrowthConflictError && !commitSent) { await client.query("ROLLBACK").catch(() => { broken = true; }); throw error; }
    if (commitSent) { broken = true; throw new LegacyGrowthOutcomeError("COMMIT_UNKNOWN", prepared.fingerprint, false, error); }
    let ack = true;
    await client.query("ROLLBACK").catch(() => { ack = false; broken = true; });
    throw new LegacyGrowthOutcomeError("NOT_COMMITTED", prepared.fingerprint, ack, error);
  } finally {
    client.release(broken ? true : undefined);
  }
}

export type LegacyGrowthRecovery = { status: "FOUND" | "NOT_FOUND" | "PARTIAL" | "FINGERPRINT_MISMATCH"; found: number; missing: number; mismatched: number };

/** Read-only recovery after COMMIT_UNKNOWN; never rewrites. All-or-nothing transaction means PARTIAL indicates outside interference. */
export async function recoverLegacyGrowthBackfill(client: Pick<PoolClient, "query">, prepared: Extract<PreparedLegacyBackfill, { ok: true }>): Promise<LegacyGrowthRecovery> {
  let found = 0, missing = 0, mismatched = 0;
  for (const r of prepared.rows) {
    const row = (await client.query<{ sourceDigest: string }>(`SELECT source_digest AS "sourceDigest" FROM zzsh_iam.membership_growth_contribution WHERE user_id=$1 AND source_key=$2 AND revision=$3`, [r.contribution.userId, r.contribution.sourceKey, r.contribution.revision])).rows[0];
    if (!row) missing += 1; else if (row.sourceDigest !== r.sourceDigest) mismatched += 1; else found += 1;
  }
  const status = mismatched > 0 ? "FINGERPRINT_MISMATCH" : missing === 0 ? "FOUND" : found === 0 ? "NOT_FOUND" : "PARTIAL";
  return { status, found, missing, mismatched };
}
