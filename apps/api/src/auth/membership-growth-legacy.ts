import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { contributionFromSettlement, type GrowthContribution, type SettledContributionFact } from "./membership-growth";
import { growthContributionSourceDigest, normalizeGrowthInstant } from "./membership-growth-integration";
import { canonicalize } from "../supply/content-hash";
import {
  closeLegacyGrowthCoverage, projectLegacyGrowthConsumption, projectLegacyGrowthCorrection,
  type LegacyGrowthConsumptionInput, type LegacyGrowthCoverageReceipt, type LegacyGrowthProjection,
} from "../order/legacy-growth-consumption";

/**
 * Legacy (la_order) growth backfill. B-GROWTH-01: the facts to write are NEVER taken from a caller's coverage JSON.
 * prepare re-runs T's projectLegacyGrowthConsumption / projectLegacyGrowthCorrection / closeLegacyGrowthCoverage over
 * the admitted frozen source inputs, so deleted/foreign/out-of-range facts or a changed correction amount cannot be
 * re-hashed into a COMPLETE record. B-GROWTH-02: the source receipt identity is separate from the execution identity;
 * each verified closure is an immutable version keyed by its fingerprint, and several versions may share one receipt.
 */
export const LEGACY_GROWTH_SOURCE_PREFIX = "legacy_mysql_restore:la_order:";

type Proof = { canonical: string; digest: string };
export type LegacyCorrectionSource = { baseSourceKey: string; proof: Proof };
/** The approved business package: original T inputs plus the admitted digest sets that T itself consumes. */
export type LegacyGrowthSourcePackage = {
  receipt: LegacyGrowthCoverageReceipt;
  inputs: LegacyGrowthConsumptionInput[];
  corrections: LegacyCorrectionSource[];
  admitted: { receiptDigests: string[]; componentDigests: string[]; correctionDigests: string[] };
  gameIdBySettlementId: Readonly<Record<string, string>>;
  /** sha256 of the approved package bytes (Q binds it to the window approval); not a proof of the facts. */
  packageDigest: string;
};

export type LegacyFactKey = { sourceKey: string; revision: number; sourceDigest: string };
/** One immutable verified closure version (Q H3 row). Window/approval/clock fields are deliberately absent. */
export type LegacyCoverageRecord = {
  schema: "legacy-growth-coverage-record-v2";
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
  sourceInputsDigest: string;
  correctionProofDigests: string[];
  coverageState: "COMPLETE" | "BACKFILL_PENDING";
  coverageReason: string | null;
  presentSourceKeys: string[];
  missingSourceKeys: string[];
  unknownSourceKeys: string[];
  factKeys: LegacyFactKey[];
  factSetDigest: string;
  closureDigest: string;
  fingerprint: string;
  /** Execution identity (outer idempotency key) of the first successful write; not part of the fingerprint. */
  executionKey: string | null;
};

export type PreparedLegacyRow = { id: string; gameId: string; contribution: GrowthContribution; sourceDigest: string };
export type PreparedLegacyBackfill =
  | { ok: true; subjectUserId: string; coverageState: "COMPLETE" | "BACKFILL_PENDING"; coverageReason: string | null; rows: PreparedLegacyRow[]; fingerprint: string; record: LegacyCoverageRecord }
  | { ok: false; subjectUserId: string | null; code: "SOURCE_CONFLICT" | "INPUT_INVALID"; reason: string };
type Prepared = Extract<PreparedLegacyBackfill, { ok: true }>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const HEX = /^[a-f0-9]{64}$/;

/** Stable per-source version hash: independent of which receipt admitted it, so re-extraction replays instead of conflicting. */
export function legacyGrowthVersionHash(settlementId: string, settlementVersion: string): string {
  return sha(canonicalize({ schema: "legacy-growth-version-v1", settlementId, settlementVersion }));
}
function rowId(c: Pick<GrowthContribution, "userId" | "sourceKey" | "revision">): string {
  return `growth_contribution_${sha(`${c.userId}\u0000${c.sourceKey}\u0000${c.revision}`).slice(0, 48)}`;
}
/** Historical maintenance and formal CONFIRM increments keep the same immutable economic identity. */
export function prepareLegacyGrowthRow(fact: SettledContributionFact, gameId: string): PreparedLegacyRow | null {
  const parsed = contributionFromSettlement(fact);
  if (!parsed.accepted || !gameId) return null;
  const contribution = { ...parsed.contribution, effectiveAt: normalizeGrowthInstant(parsed.contribution.effectiveAt, "effectiveAt"), recordedAt: normalizeGrowthInstant(parsed.contribution.recordedAt, "recordedAt") };
  return { id: rowId(contribution), gameId, contribution, sourceDigest: growthContributionSourceDigest(legacyGrowthVersionHash(fact.settlementId, fact.settlementVersion), gameId, contribution) };
}
function baseSettlementOf(f: Pick<SettledContributionFact, "settlementId" | "correctionOf">): string {
  return f.correctionOf ? f.correctionOf.slice(f.correctionOf.indexOf(":") + 1) : f.settlementId;
}
const micros = (t: string) => { const n = normalizeGrowthInstant(t, "instant"); return BigInt(Date.parse(n.slice(0, 19) + "Z")) * 1000000n + BigInt(n.slice(20, 26)); };
const sortKeys = (keys: LegacyFactKey[]) => [...keys].sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : a.revision - b.revision));

export function legacyFactSetDigest(factKeys: readonly LegacyFactKey[]): string {
  return sha(canonicalize({ schema: "legacy-growth-fact-set-v1", facts: sortKeys([...factKeys]).map((k) => [k.sourceKey, k.revision, k.sourceDigest]) }));
}
function closureDigestOf(r: Pick<LegacyCoverageRecord, "coverageState" | "coverageReason" | "presentSourceKeys" | "missingSourceKeys" | "unknownSourceKeys" | "factSetDigest">): string {
  return sha(canonicalize({ schema: "legacy-growth-closure-v1", state: r.coverageState, reason: r.coverageReason, present: r.presentSourceKeys, missing: r.missingSourceKeys, unknown: r.unknownSourceKeys, factSetDigest: r.factSetDigest }));
}
function fingerprintOf(r: Pick<LegacyCoverageRecord, "subjectUserId" | "packageDigest" | "receiptDigest" | "sourceInputsDigest" | "closureDigest">): string {
  return sha(canonicalize({ schema: "legacy-growth-backfill-v3", subjectUserId: r.subjectUserId, packageDigest: r.packageDigest, receiptDigest: r.receiptDigest, sourceInputsDigest: r.sourceInputsDigest, closureDigest: r.closureDigest }));
}

export function prepareLegacyGrowthBackfill(pkg: LegacyGrowthSourcePackage): PreparedLegacyBackfill {
  const receipt = pkg.receipt, subjectUserId = receipt?.subjectUserId ?? null;
  const bad = (code: "SOURCE_CONFLICT" | "INPUT_INVALID", reason: string): PreparedLegacyBackfill => ({ ok: false, subjectUserId, code, reason });
  if (!receipt || typeof receipt.subjectUserId !== "string") return bad("INPUT_INVALID", "RECEIPT_MISSING");
  if (!HEX.test(pkg.packageDigest)) return bad("INPUT_INVALID", "PACKAGE_DIGEST_INVALID");
  if (!Array.isArray(pkg.inputs) || !Array.isArray(pkg.corrections) || !pkg.admitted) return bad("INPUT_INVALID", "SOURCE_INPUTS_MISSING");
  if (!HEX.test(receipt.sourceExtractSha256) || !HEX.test(receipt.sourceSetSha256) || !Array.isArray(receipt.refundReviewEvidenceRefs) || receipt.refundReviewEvidenceRefs.length === 0) return bad("SOURCE_CONFLICT", "RECEIPT_EVIDENCE_INCOMPLETE");
  const receiptCanonical = canonicalize(receipt), receiptDigest = sha(receiptCanonical);
  if (!pkg.admitted.receiptDigests.includes(receiptDigest)) return bad("INPUT_INVALID", "SOURCE_COVERAGE_NOT_ADMITTED");
  // 1. Re-project every admitted original source with T (no caller facts are used).
  const projections: LegacyGrowthProjection[] = [];
  const seen = new Set<string>();
  for (const input of pkg.inputs) {
    if (input?.subjectUserId !== subjectUserId) return bad("SOURCE_CONFLICT", "FACT_SUBJECT_MISMATCH");
    const p = projectLegacyGrowthConsumption(input, new Set(pkg.admitted.componentDigests), receipt);
    if (seen.has(p.sourceKey)) return bad("SOURCE_CONFLICT", "DUPLICATE_SOURCE_INPUT");
    seen.add(p.sourceKey);
    projections.push({ ...p, facts: [...p.facts] });
  }
  // 2. Corrections: admitted, listed in the receipt's refund review lineage, bound to a re-projected base fact, and recorded
  //    inside the old snapshot. A retroactive effectiveAt alone does not make a later correction part of the old source.
  const correctionProofDigests: string[] = [];
  const cutoffUs = micros(receipt.cutoff);
  // B-GROWTH-03: corrections are chained per economic source key in explicit revision order; each step is checked by T
  // against the previously verified amount/revision (original component, settlementId and effectiveAt are kept). Revision
  // gaps are allowed (T accepts a first correction at revision 3); contradictory previous amounts, same-revision forks and a
  // missing prior step reject before close/write.
  const admittedCorrections = new Set(pkg.admitted.correctionDigests);
  const chains = new Map<string, { c: LegacyCorrectionSource; revision: number }[]>();
  for (const c of pkg.corrections) {
    const listed = receipt.refundReviewEvidenceRefs.some((ref) => ref === c.proof?.digest || ref.endsWith(`:${c.proof?.digest}`));
    if (!listed) return bad("SOURCE_CONFLICT", "CORRECTION_NOT_IN_RECEIPT_LINEAGE");
    let revision: unknown;
    try { revision = (JSON.parse(c.proof.canonical) as { revision?: unknown }).revision; } catch { return bad("SOURCE_CONFLICT", "CORRECTION_EVIDENCE_INVALID"); }
    if (!Number.isSafeInteger(revision)) return bad("SOURCE_CONFLICT", "CORRECTION_BINDING_CONFLICT");
    const list = chains.get(c.baseSourceKey) ?? [];
    if (list.some((x) => x.revision === revision)) return bad("SOURCE_CONFLICT", "CORRECTION_REVISION_FORK");
    list.push({ c, revision: revision as number }); chains.set(c.baseSourceKey, list);
  }
  for (const [baseSourceKey, list] of chains) {
    const owner = projections.find((p) => p.facts.some((f) => `${f.component}:${f.settlementId}` === baseSourceKey && !f.correctionOf));
    const base = owner?.facts.find((f) => `${f.component}:${f.settlementId}` === baseSourceKey && !f.correctionOf);
    if (!owner || !base) return bad("SOURCE_CONFLICT", "CORRECTION_BASE_NOT_IN_SOURCE");
    let prior: SettledContributionFact = base;
    for (const { c } of [...list].sort((a, b) => a.revision - b.revision)) {
      let previous: unknown;
      try { previous = (JSON.parse(c.proof.canonical) as { previousAmountCents?: unknown }).previousAmountCents; } catch { return bad("SOURCE_CONFLICT", "CORRECTION_EVIDENCE_INVALID"); }
      if (previous !== prior.amountCents) return bad("SOURCE_CONFLICT", "CORRECTION_PREVIOUS_MISMATCH");
      let fact: SettledContributionFact;
      // chain base = original fact identity with the previously verified amount/revision
      try { fact = projectLegacyGrowthCorrection({ ...base, amountCents: prior.amountCents, revision: prior.revision }, c.proof, admittedCorrections); } catch (e) { return bad("SOURCE_CONFLICT", e instanceof Error && /^[A-Z_]{3,80}$/.test(e.message) ? e.message : "CORRECTION_EVIDENCE_INVALID"); }
      if (micros(fact.recordedAt) > cutoffUs) return bad("SOURCE_CONFLICT", "CORRECTION_AFTER_SOURCE_CUTOFF");
      owner.facts.push(fact);
      correctionProofDigests.push(c.proof.digest);
      prior = fact;
    }
  }
  // 3. T closure over the re-projected rows.
  const closed = closeLegacyGrowthCoverage(subjectUserId!, projections, receipt, new Set(pkg.admitted.receiptDigests));
  if (closed.state === "SOURCE_CONFLICT") return bad("SOURCE_CONFLICT", closed.reason ?? "SOURCE_COVERAGE_CONFLICT");
  if (closed.state === "BACKFILL_PENDING" && closed.reason !== "SOURCE_FACTS_PENDING") return bad("INPUT_INVALID", closed.reason ?? "COVERAGE_NOT_ADMITTED");
  if (closed.outOfScopeFacts.length > 0) return bad("SOURCE_CONFLICT", "FACT_OUTSIDE_SOURCE_RANGE");
  // 4. Map T facts to contribution rows.
  const rows: PreparedLegacyRow[] = [];
  const byKey = new Map<string, string>();
  for (const fact of closed.facts) {
    if (fact.userId !== subjectUserId) return bad("SOURCE_CONFLICT", "FACT_SUBJECT_MISMATCH");
    const base = baseSettlementOf(fact);
    if (!base.startsWith(LEGACY_GROWTH_SOURCE_PREFIX)) return bad("INPUT_INVALID", "FACT_NOT_LEGACY_SOURCE");
    const parsed = contributionFromSettlement(fact);
    if (!parsed.accepted) return bad("INPUT_INVALID", `ADAPTER_REJECTED:${parsed.reason}`);
    const gameId = pkg.gameIdBySettlementId[base];
    if (typeof gameId !== "string" || !gameId) return bad("INPUT_INVALID", "GAME_BINDING_MISSING");
    const prepared = prepareLegacyGrowthRow(fact, gameId)!;
    const { contribution: c, sourceDigest } = prepared;
    const k = `${c.sourceKey}\u0000${c.revision}`;
    if (byKey.has(k)) { if (byKey.get(k) !== sourceDigest) return bad("SOURCE_CONFLICT", "DUPLICATE_REVISION_DIVERGES"); continue; }
    byKey.set(k, sourceDigest);
    rows.push(prepared);
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const factKeys = sortKeys(rows.map((r) => ({ sourceKey: r.contribution.sourceKey, revision: r.contribution.revision, sourceDigest: r.sourceDigest })));
  const sourceInputsDigest = sha(canonicalize({ schema: "legacy-growth-source-inputs-v1", inputs: [...pkg.inputs].sort((a, b) => (a.binding.legacyId < b.binding.legacyId ? -1 : 1)), corrections: [...pkg.corrections].sort((a, b) => (a.proof.digest < b.proof.digest ? -1 : 1)), admitted: { receiptDigests: [...pkg.admitted.receiptDigests].sort(), componentDigests: [...pkg.admitted.componentDigests].sort(), correctionDigests: [...pkg.admitted.correctionDigests].sort() } }));
  const partial = {
    coverageState: closed.state, coverageReason: closed.reason,
    presentSourceKeys: [...closed.presentSourceKeys].sort(), missingSourceKeys: [...(closed.missingSourceKeys ?? [])].sort(), unknownSourceKeys: closed.unknown.map((u) => u.sourceKey).sort(),
    factSetDigest: legacyFactSetDigest(factKeys),
  } as const;
  const closureDigest = closureDigestOf(partial);
  const fingerprint = fingerprintOf({ subjectUserId: subjectUserId!, packageDigest: pkg.packageDigest, receiptDigest, sourceInputsDigest, closureDigest });
  const record: LegacyCoverageRecord = {
    schema: "legacy-growth-coverage-record-v2", subjectUserId: subjectUserId!, receiptCanonical, receiptDigest, cutoff: receipt.cutoff, fromExclusive: receipt.fromExclusive,
    sourceExtractSha256: receipt.sourceExtractSha256, sourceSetSha256: receipt.sourceSetSha256, expectedSourceKeys: [...receipt.expectedSourceKeys].sort(), refundReviewEvidenceRefs: [...receipt.refundReviewEvidenceRefs],
    packageDigest: pkg.packageDigest, sourceInputsDigest, correctionProofDigests: correctionProofDigests.sort(), ...partial, factKeys, closureDigest, fingerprint, executionKey: null,
  };
  return { ok: true, subjectUserId: subjectUserId!, coverageState: closed.state, coverageReason: closed.reason, rows, fingerprint, record };
}

/**
 * Persistence port for Q H3. One row per verified closure version:
 *   UNIQUE (subject_user_id, fingerprint)    -- version / success-receipt identity (read/recover exact)
 *   UNIQUE (subject_user_id, execution_key)  -- execution identity (same key + different body => 409)
 * receipt_digest is an indexed, NON-unique column: several versions (partial -> complete) may share one source receipt.
 * Must run on the same client/transaction as contributions, audit and the idempotency success receipt.
 */
export type LegacyCoveragePort = {
  /** INSERT ... ON CONFLICT DO NOTHING; returns the stored row (new or original). */
  persist(client: Pick<PoolClient, "query">, record: LegacyCoverageRecord): Promise<LegacyCoverageRecord>;
  readByFingerprint(client: Pick<PoolClient, "query">, subjectUserId: string, fingerprint: string): Promise<LegacyCoverageRecord | null>;
  readByExecutionKey(client: Pick<PoolClient, "query">, subjectUserId: string, executionKey: string): Promise<LegacyCoverageRecord | null>;
};

export type LegacyGrowthWriteResult = { inserted: number; replayed: number; coverage: "INSERTED" | "REPLAYED"; fingerprint: string; executionKey: string };

export class LegacyGrowthConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(readonly sourceKey: string, readonly revision: number) { super(`LEGACY_GROWTH_REVISION_CONFLICT:${sourceKey}:${revision}`); }
}
export class LegacyGrowthOutcomeError extends Error {
  constructor(readonly outcome: "NOT_COMMITTED" | "COMMIT_UNKNOWN", readonly fingerprint: string, readonly executionKey: string, readonly receiptDigest: string, readonly rollbackAcknowledged: boolean, readonly cause: unknown) { super(`LEGACY_GROWTH_${outcome}`); }
}

const EXEC_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** Runs inside the caller's (Q H4) transaction, on the same client as authorize/audit/idempotency. */
export async function writePreparedLegacyGrowth(client: Pick<PoolClient, "query">, prepared: Prepared, port: LegacyCoveragePort, executionKey: string): Promise<LegacyGrowthWriteResult> {
  if (!EXEC_KEY.test(executionKey)) throw new LegacyGrowthConflictError("execution-key-invalid", -1);
  const byKey = await port.readByExecutionKey(client, prepared.subjectUserId, executionKey);
  if (byKey) {
    if (byKey.fingerprint !== prepared.fingerprint) throw new LegacyGrowthConflictError(`execution:${executionKey}`, -1); // same key, changed body
    return { inserted: 0, replayed: prepared.rows.length, coverage: "REPLAYED", fingerprint: byKey.fingerprint, executionKey };
  }
  const byFp = await port.readByFingerprint(client, prepared.subjectUserId, prepared.fingerprint);
  if (byFp) return { inserted: 0, replayed: prepared.rows.length, coverage: "REPLAYED", fingerprint: byFp.fingerprint, executionKey: byFp.executionKey ?? executionKey };
  const { inserted, replayed } = await writeLegacyGrowthContributionRows(client, prepared.rows);
  const stored = await port.persist(client, { ...prepared.record, executionKey });
  if (stored.fingerprint !== prepared.fingerprint) throw new LegacyGrowthConflictError(`version:${prepared.fingerprint}`, -1);
  return { inserted, replayed, coverage: "INSERTED", fingerprint: prepared.fingerprint, executionKey };
}

/** Caller owns transaction and source authorization; this never writes owner-only historical coverage. */
export async function writeLegacyGrowthContributionRows(client: Pick<PoolClient, "query">, rows: readonly PreparedLegacyRow[]): Promise<{ inserted: number; replayed: number }> {
  let inserted = 0, replayed = 0;
  for (const r of rows) {
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
    replayed += 1; // earlier version's rows (e.g. S1 partial) are replayed, not rewritten
  }
  return { inserted, replayed };
}

/**
 * Standalone helper (tests/offline only). Q H4 must NOT nest this inside another transaction: it opens its own client.
 * Production H4 calls writePreparedLegacyGrowth on the same client as authorize/audit/withIdempotency.
 */
export async function runLegacyGrowthBackfill(pool: Pick<Pool, "connect">, prepared: Prepared, port: LegacyCoveragePort, executionKey: string): Promise<LegacyGrowthWriteResult & { coverageState: string }> {
  const client = await pool.connect();
  let commitSent = false, broken = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await writePreparedLegacyGrowth(client, prepared, port, executionKey);
    commitSent = true;
    await client.query("COMMIT");
    return { ...result, coverageState: prepared.coverageState };
  } catch (error) {
    if (commitSent) { broken = true; throw new LegacyGrowthOutcomeError("COMMIT_UNKNOWN", prepared.fingerprint, executionKey, prepared.record.receiptDigest, false, error); }
    let ack = true;
    await client.query("ROLLBACK").catch(() => { ack = false; broken = true; });
    if (error instanceof LegacyGrowthConflictError) throw error;
    throw new LegacyGrowthOutcomeError("NOT_COMMITTED", prepared.fingerprint, executionKey, prepared.record.receiptDigest, ack, error);
  } finally {
    client.release(broken ? true : undefined);
  }
}

export type LegacyGrowthRecovery = { status: "FOUND" | "NOT_FOUND" | "FINGERPRINT_MISMATCH"; found: number; missing: number; mismatched: number };

/** Read-only recovery after COMMIT_UNKNOWN, by the exact execution key and fingerprint; contribution rows alone are never FOUND. */
export async function recoverLegacyGrowthBackfill(client: Pick<PoolClient, "query">, prepared: Prepared, port: LegacyCoveragePort, executionKey: string): Promise<LegacyGrowthRecovery> {
  const byKey = await port.readByExecutionKey(client, prepared.subjectUserId, executionKey);
  let found = 0, missing = 0, mismatched = 0;
  for (const r of prepared.rows) {
    const row = (await client.query<{ sourceDigest: string }>(`SELECT source_digest AS "sourceDigest" FROM zzsh_iam.membership_growth_contribution WHERE user_id=$1 AND source_key=$2 AND revision=$3`, [r.contribution.userId, r.contribution.sourceKey, r.contribution.revision])).rows[0];
    if (!row) missing += 1; else if (row.sourceDigest !== r.sourceDigest) mismatched += 1; else found += 1;
  }
  if (!byKey) return { status: mismatched > 0 ? "FINGERPRINT_MISMATCH" : "NOT_FOUND", found, missing, mismatched };
  if (byKey.fingerprint !== prepared.fingerprint || mismatched > 0 || missing > 0) return { status: "FINGERPRINT_MISMATCH", found, missing, mismatched };
  return { status: "FOUND", found, missing, mismatched };
}

export type StoredLegacyRow = { sourceKey: string; revision: number; sourceDigest?: string | null; status: string };

/** Self-consistency of a stored record (re-derives closure and fingerprint; rejects a tampered row). */
export function verifyLegacyCoverageRecord(record: LegacyCoverageRecord): boolean {
  if (sha(record.receiptCanonical) !== record.receiptDigest) return false;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(record.receiptCanonical) as Record<string, unknown>; } catch { return false; }
  if (parsed.subjectUserId !== record.subjectUserId || parsed.cutoff !== record.cutoff || (parsed.fromExclusive ?? null) !== record.fromExclusive || parsed.sourceSetSha256 !== record.sourceSetSha256 || parsed.sourceExtractSha256 !== record.sourceExtractSha256) return false;
  if (legacyFactSetDigest(record.factKeys) !== record.factSetDigest || closureDigestOf(record) !== record.closureDigest) return false;
  if (record.coverageState === "COMPLETE" && (record.missingSourceKeys.length || record.unknownSourceKeys.length)) return false;
  return fingerprintOf(record) === record.fingerprint;
}

/**
 * Reader seam. The record proves ONLY its own factKeys within its source range. Every other stored legacy row (later
 * legacy continuation, a later correction with a retroactive effectiveAt, or anything not in factKeys) is an increment
 * that must be verified separately; unverified increments keep BACKFILL_PENDING, never COMPLETE, and are never filtered
 * away and trusted.
 */
export function assessLegacyCoverageRecord(record: LegacyCoverageRecord | null, storedLegacyRows: readonly StoredLegacyRow[], increments: "VERIFIED" | "UNVERIFIED" = "UNVERIFIED"): { state: "COMPLETE" | "BACKFILL_PENDING" | "SOURCE_CONFLICT"; reasons: string[]; incrementRows: StoredLegacyRow[] } {
  const rows = storedLegacyRows.filter((r) => r.status !== "PENDING");
  if (!record) return { state: "BACKFILL_PENDING", reasons: ["LEGACY_COVERAGE_RECEIPT_MISSING"], incrementRows: rows };
  if (!verifyLegacyCoverageRecord(record)) return { state: "SOURCE_CONFLICT", reasons: ["LEGACY_COVERAGE_RECORD_INVALID"], incrementRows: [] };
  if (rows.some((r) => !r.sourceDigest)) return { state: "SOURCE_CONFLICT", reasons: ["LEGACY_ROW_DIGEST_MISSING"], incrementRows: [] };
  const want = new Map(record.factKeys.map((k) => [`${k.sourceKey}\u0000${k.revision}`, k.sourceDigest]));
  const seenOld = new Set<string>(); const incrementRows: StoredLegacyRow[] = [];
  for (const r of rows) {
    const k = `${r.sourceKey}\u0000${Number(r.revision)}`;
    const d = want.get(k);
    if (d === undefined) { incrementRows.push(r); continue; }
    if (d !== r.sourceDigest) return { state: "SOURCE_CONFLICT", reasons: ["LEGACY_FACT_DIGEST_MISMATCH"], incrementRows: [] };
    seenOld.add(k);
  }
  if (seenOld.size !== want.size) return { state: "BACKFILL_PENDING", reasons: ["LEGACY_FACTS_NOT_INGESTED"], incrementRows };
  if (record.coverageState !== "COMPLETE") return { state: "BACKFILL_PENDING", reasons: [record.coverageReason ?? "SOURCE_FACTS_PENDING"], incrementRows };
  if (incrementRows.length > 0 && increments !== "VERIFIED") return { state: "BACKFILL_PENDING", reasons: ["LEGACY_INCREMENTS_UNVERIFIED"], incrementRows };
  return { state: "COMPLETE", reasons: [], incrementRows };
}
