import type { PoolClient } from "pg";
import type { GrowthContribution } from "./membership-growth";
import { growthContributionSourceDigest, normalizeGrowthInstant } from "./membership-growth-integration";
import { assessLegacyCoverageRecord, legacyGrowthVersionHash, verifyLegacyCoverageRecord, type LegacyCoveragePort, type LegacyCoverageRecord } from "./membership-growth-legacy";
import { canonicalize } from "../supply/content-hash";
import { sha256Hex } from "../supply/supply-util";
import { SecurityApiError } from "./security-core";

const TABLE = "zzsh_iam.membership_growth_legacy_coverage";
type Client = Pick<PoolClient, "query">;
type StoredRecord = { canonical: string; digest: string };
export type LegacyGrowthStoredContribution = GrowthContribution & { gameId: string; sourceDigest?: string | null };
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Legacy growth coverage evidence is unavailable");

function decode(row: StoredRecord | undefined): LegacyCoverageRecord | null {
  if (!row) return null;
  try {
    const record = JSON.parse(row.canonical) as LegacyCoverageRecord;
    if (sha256Hex(row.canonical) !== row.digest || canonicalize(record) !== row.canonical || !record.executionKey || !verifyLegacyCoverageRecord(record)) throw unavailable();
    const receipt = JSON.parse(record.receiptCanonical) as { expectedSourceKeys: string[]; refundReviewEvidenceRefs: string[] };
    if (!Array.isArray(receipt.expectedSourceKeys) || !Array.isArray(receipt.refundReviewEvidenceRefs)
      || canonicalize([...receipt.expectedSourceKeys].sort()) !== canonicalize([...record.expectedSourceKeys].sort())
      || canonicalize(receipt.refundReviewEvidenceRefs) !== canonicalize(record.refundReviewEvidenceRefs)
      || sha256Hex(canonicalize({ subjectUserId: record.subjectUserId, cutoff: record.cutoff, fromExclusive: record.fromExclusive, expectedSourceKeys: [...record.expectedSourceKeys].sort() })) !== record.sourceSetSha256
      || record.correctionProofDigests.some(d => !record.refundReviewEvidenceRefs.some(ref => ref === d || ref.endsWith(`:${d}`)))) throw unavailable();
    return record;
  } catch { throw unavailable(); }
}

/** Owner INSERT and runtime SELECT share the same immutable version shape; no pool or hidden transaction. */
export function createLegacyGrowthCoveragePort(): LegacyCoveragePort {
  const read = async (client: Client, subject: string, column: "fingerprint" | "execution_key", value: string) => {
    const row = (await client.query<StoredRecord>(`SELECT record_canonical AS canonical,record_digest AS digest FROM ${TABLE} WHERE subject_user_id=$1 AND ${column}=$2`, [subject, value])).rows[0];
    const record = decode(row);
    if (record && (record.subjectUserId !== subject || (column === "fingerprint" ? record.fingerprint : record.executionKey) !== value)) throw unavailable();
    return record;
  };
  const port: LegacyCoveragePort = {
    readByFingerprint: (client, subject, fingerprint) => read(client, subject, "fingerprint", fingerprint),
    readByExecutionKey: (client, subject, executionKey) => read(client, subject, "execution_key", executionKey),
    async persist(client, record) {
      if (!record.executionKey) throw unavailable();
      const canonical = canonicalize(record);
      decode({ canonical, digest: sha256Hex(canonical) });
      const inserted = (await client.query<StoredRecord>(`INSERT INTO ${TABLE}
        (id,subject_user_id,fingerprint,execution_key,receipt_digest,cutoff,from_exclusive,coverage_state,record,record_canonical,record_digest)
        VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9::jsonb,$9,$10)
        ON CONFLICT DO NOTHING RETURNING record_canonical AS canonical,record_digest AS digest`,
      ["growth_coverage_" + sha256Hex(canonicalize([record.subjectUserId, record.fingerprint])).slice(0, 48), record.subjectUserId, record.fingerprint, record.executionKey, record.receiptDigest, record.cutoff, record.fromExclusive, record.coverageState, canonical, sha256Hex(canonical)])).rows[0];
      if (inserted) return decode(inserted)!;
      // A raced execution-key conflict takes precedence over a different key's identical fingerprint.
      const existing = await port.readByExecutionKey(client, record.subjectUserId, record.executionKey)
        ?? await port.readByFingerprint(client, record.subjectUserId, record.fingerprint);
      if (!existing) throw unavailable();
      return existing;
    },
  };
  return port;
}

function isLegacy(row: LegacyGrowthStoredContribution): boolean {
  const source = row.correctionOf ? row.correctionOf.slice(row.correctionOf.indexOf(":") + 1) : row.sourceId;
  return /^legacy_mysql_restore:la_order:[1-9]\d{0,23}$/.test(source);
}

/** A complete historical base is distinct from native increments and from an unproved newer legacy window. */
export async function readLegacyGrowthCoverageAssessment(client: Client, subject: string, contributions: readonly LegacyGrowthStoredContribution[], asOfUtc = new Date().toISOString()): Promise<ReturnType<typeof assessLegacyCoverageRecord>> {
  const pending = (reason: string): ReturnType<typeof assessLegacyCoverageRecord> => ({ state: "BACKFILL_PENDING", reasons: [reason], incrementRows: [] });
  const conflict = (reason: string): ReturnType<typeof assessLegacyCoverageRecord> => ({ state: "SOURCE_CONFLICT", reasons: [reason], incrementRows: [] });
  const asOf = normalizeGrowthInstant(asOfUtc);
  const installed = (await client.query<{ coverage: boolean; sources: boolean }>(`SELECT /* legacy-growth-schema */
    to_regclass('${TABLE}') IS NOT NULL AS coverage,
    to_regclass('zzsh_order.legacy_order_read_snapshot') IS NOT NULL AND to_regclass('zzsh_order.legacy_continuation_version') IS NOT NULL AS sources`)).rows[0];
  if (!installed || typeof installed.coverage !== "boolean" || typeof installed.sources !== "boolean") throw unavailable();
  if (!installed.coverage) return pending("LEGACY_COVERAGE_SCHEMA_NOT_INSTALLED");
  if (!installed.sources) return pending("LEGACY_GROWTH_SOURCES_NOT_INSTALLED");
  const versions = (await client.query<StoredRecord>(`SELECT /* legacy-growth-versions */ record_canonical AS canonical,record_digest AS digest
    FROM ${TABLE} WHERE subject_user_id=$1 AND cutoff<=$2::timestamptz
    ORDER BY cutoff DESC,created_at DESC,id COLLATE "C" DESC`, [subject, asOf])).rows.map(row => decode(row)!);
  if (versions.some(record => record.subjectUserId !== subject)) throw unavailable();
  const base = versions.find(record => record.fromExclusive === null && record.coverageState === "COMPLETE");
  if (!base) return pending("LEGACY_COVERAGE_RECEIPT_MISSING");
  const keys = new Set(base.expectedSourceKeys), refunds = new Set(base.refundReviewEvidenceRefs), proofDigests = new Set(base.correctionProofDigests);
  if (versions.some(v => v.expectedSourceKeys.some(k => !keys.has(k)) || v.refundReviewEvidenceRefs.some(k => !refunds.has(k)) || v.correctionProofDigests.some(k => !proofDigests.has(k)))) return pending("LEGACY_SOURCE_WINDOW_UNVERIFIED");
  const legacyRows = contributions.filter(row => isLegacy(row) && row.status !== "PENDING");
  for (const row of legacyRows) {
    if (row.userId !== subject || !row.sourceDigest || growthContributionSourceDigest(legacyGrowthVersionHash(row.sourceId, row.settlementVersion), row.gameId, row) !== row.sourceDigest) return conflict("LEGACY_FACT_DIGEST_MISMATCH");
  }
  const ownFacts = new Set(base.factKeys.map(k => `${k.sourceKey}\u0000${k.revision}\u0000${k.sourceDigest}`));
  // A source can exist before its contribution. Read all CONFIRMs, including those superseded by HOLD/RELEASE.
  const sources = (await client.query<{ sourceKey: string; commandId: string | null; revision: string | null }>(`SELECT /* legacy-growth-live-sources */
    'legacy_mysql_restore:la_order:'||o.legacy_id AS "sourceKey",v.id AS "commandId",v.revision::text AS revision
    FROM zzsh_order.legacy_order_read_snapshot o LEFT JOIN zzsh_order.legacy_continuation_version v
      ON v.order_id=o.id AND v.command='CONFIRM' AND v.created_at<=$2::timestamptz
    WHERE o.renter_user_id=$1 AND o.source_system='legacy_mysql_restore' AND o.source_entity='la_order' AND o.source_pay_status=1
      AND ((o.source_order_status=4 AND (o.source_completed_at IS NULL OR o.source_completed_at<=$2::timestamptz)) OR v.id IS NOT NULL)
    ORDER BY o.id,v.revision`, [subject, asOf])).rows;
  for (const source of sources) {
    if (!keys.has(source.sourceKey)) return pending("LEGACY_SOURCE_WINDOW_UNVERIFIED");
    if (source.commandId !== null) {
      const revision = Number(source.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) return conflict("LEGACY_CONFIRM_SOURCE_INVALID");
      for (const component of ["RENTAL_SETTLEMENT", "MATERIAL_CONSUMPTION"]) {
        const row = legacyRows.find(r => r.sourceKey === `${component}:${source.sourceKey}` && r.sourceId === source.sourceKey && r.settlementVersion === source.commandId && r.revision === revision && !r.correctionOf);
        if (!row?.sourceDigest || !ownFacts.has(`${row.sourceKey}\u0000${row.revision}\u0000${row.sourceDigest}`)) return pending("LEGACY_CONFIRM_FACTS_NOT_INGESTED");
      }
    }
  }
  // Future rows are not increments at this asOf; the base's own immutable factKeys are still checked in full.
  const atThisTime = legacyRows.filter(r => ownFacts.has(`${r.sourceKey}\u0000${r.revision}\u0000${r.sourceDigest}`) || normalizeGrowthInstant(r.recordedAt) <= asOf);
  return assessLegacyCoverageRecord(base, atThisTime);
}
