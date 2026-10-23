import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { readAdminGameScope, scopeAllowsGame } from "./admin-scope";

import {
  contributionFromSettlement,
  entitlementStateAt,
  entitlementPricingSummary,
  GROWTH_THRESHOLDS,
  NORMAL_GROWTH_TIERS,
  isTotalDiscountContract,
  isUnifiedTotalDiscountContract,
  quoteToGrowthOfferPlan,
  parseDepositAllowanceCents,
  tenantDepositAfterBenefit,
  replayGrowthProjection,
  projectGrowthConsumptionSources,
  sealedEnabledRentalModes,
  validateBenefitPolicy,
  type ExistingEntitlement,
  type GrowthContribution,
  type GrowthBenefitPolicy,
  type GrowthOfferPlan,
  type HaffPricingParameter,
  type MaterialPricingParameter,
  type ModePricingContract,
  type NormalGrowthTier,
  type NotPricedParameter,
  type OfferBinding,
  type GrowthPricingContract,
  type GrowthProjection,
  type RentalMode,
  type EntitlementPricingSummary,
  type SettledContributionFact,
  GrowthRuleError,
  growthWindowStartAt,
} from "./membership-growth";
import { computeDeltaQuote, type InternalQuote, type PricingLineInput, type QuoteInput } from "../supply/pricing";
import { applyTotalDiscountToQuote } from "./membership-total-discount";
import { canonicalize, normalizeTime } from "../supply/content-hash";
import { decimalToBigInt, formatScaledInteger, parseNonNegativeDecimal } from "../supply/decimal";
import { type MembershipGrowthConfirmationReader } from "../order/personal-confirmation";
import { recordAudit, SecurityApiError, withTransaction } from "./security-core";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "./admin-authorization";

export const MEMBERSHIP_GROWTH_FEATURE_ENV = "ZZSH_MEMBERSHIP_GROWTH_ENABLED";
export function membershipGrowthEnabled(): boolean {
  return process.env[MEMBERSHIP_GROWTH_FEATURE_ENV] === "true";
}

export type GrowthKnowledge = "KNOWN" | "UNKNOWN";
export type GrowthSourceState = "COMPLETE" | "BACKFILL_PENDING" | "READ_FAILED" | "SOURCE_CONFLICT" | "NO_POLICY";
export type GrowthBenefitsState = "CONFIGURED" | "NOT_CONFIGURED";

export type GrowthContributionSourceRef = {
  sourceKey: string;
  sourceId: string;
  revision: number;
  correctionOf?: string;
  correctionMode?: "REPLACE" | "INCREMENT";
};

export type AcceptedSettlementSnapshot = {
  orderId: string;
  settlementVersionId: string;
  settlementVersionNo: number;
  versionHash: string;
  supersededAt: string | null;
  postingId: string | null;
  gameId: string;
  renterUserId: string;
  effectiveAtUtc: string;
  recordedAtUtc: string;
  inputSnapshot: {
    schema: "settlement-version-v2";
    renterUserId: string;
    ownerUserId: string;
    listingVersionId: string;
    listingHash: string;
    endReason?: "NORMAL" | "TENANT_VOLUNTARY_EARLY" | "OWNER_OR_ACCOUNT_EARLY";
    early?: boolean;
    amounts?: {
      haffConsumedBuyer?: string;
      itemConsumedBuyer?: string;
      earlyMakeup?: string;
    };
  };
  computation?: { ok?: boolean; early?: boolean; consumed?: { items?: Array<{ itemId: string; consumed: string; remaining: string }> }; amounts?: { earlyMakeup?: string } };
  sourceRefs?: { haff?: GrowthContributionSourceRef; items?: GrowthContributionSourceRef };
};

export type ContributionMapping = {
  facts: Array<SettledContributionFact & { gameId: string }>;
  unmapped: Array<{ code: "MINIMUM_BILLING_SOURCE_MISSING" | "REFUND_CORRECTION_SOURCE_MISSING" | "SNAPSHOT_INVALID"; detail: string }>;
};

export type GrowthSourceCompleteness = {
  state: "COMPLETE" | "BACKFILL_PENDING" | "SOURCE_CONFLICT";
  expectedSourceKeys: string[];
  presentSourceKeys: string[];
  missingSourceKeys: string[];
  reasons?: string[];
};

type CompletenessContribution = Pick<GrowthContribution, "sourceKey" | "status" | "eligible" | "userId" | "settlementVersion" | "sourceType" | "sourceId" | "amountCents" | "revision" | "effectiveAt" | "recordedAt" | "previousAmountCents" | "correctionOf" | "correctionMode"> & { gameId: string; sourceDigest?: string | null };

export function growthContributionSourceDigest(versionHash: string, gameId: string, contribution: Pick<GrowthContribution, "userId" | "sourceKey" | "sourceType" | "sourceId" | "settlementVersion" | "amountCents" | "status" | "eligible" | "revision" | "effectiveAt" | "recordedAt" | "previousAmountCents" | "correctionOf" | "correctionMode">): string {
  const stableContribution = {
    userId: contribution.userId,
    sourceKey: contribution.sourceKey,
    sourceType: contribution.sourceType,
    sourceId: contribution.sourceId,
    settlementVersion: contribution.settlementVersion,
    amountCents: contribution.amountCents,
    status: contribution.status,
    eligible: contribution.eligible,
    revision: contribution.revision,
    effectiveAt: normalizeGrowthInstant(contribution.effectiveAt, "effectiveAt"),
    recordedAt: normalizeGrowthInstant(contribution.recordedAt, "recordedAt"),
    ...(contribution.previousAmountCents === undefined || contribution.previousAmountCents === null ? {} : { previousAmountCents: contribution.previousAmountCents }),
    ...(contribution.correctionOf === undefined || contribution.correctionOf === null ? {} : { correctionOf: contribution.correctionOf }),
    ...(contribution.correctionMode === undefined || contribution.correctionMode === null ? {} : { correctionMode: contribution.correctionMode }),
  };
  return createHash("sha256").update(canonicalize({ schema: "membership-growth-contribution-v1", versionHash, gameId, contribution: stableContribution })).digest("hex");
}

export function assessGrowthSourceCompleteness(expectedSourceKeys: readonly string[], contributions: readonly Pick<GrowthContribution, "sourceKey" | "status">[], sourceProof: "FORMAL_SETTLEMENTS" | "REGISTRATION_ZERO" | "UNKNOWN"): GrowthSourceCompleteness {
  const expected = [...new Set(expectedSourceKeys)].sort();
  const present = [...new Set(contributions.filter((row) => row.status !== "PENDING").map((row) => row.sourceKey))].sort();
  const missing = expected.filter((sourceKey) => !present.includes(sourceKey));
  if (sourceProof === "UNKNOWN") return { state: "BACKFILL_PENDING", expectedSourceKeys: expected, presentSourceKeys: present, missingSourceKeys: missing, reasons: ["FORMAL_SOURCE_PROOF_MISSING"] };
  if (missing.length > 0) return { state: "BACKFILL_PENDING", expectedSourceKeys: expected, presentSourceKeys: present, missingSourceKeys: missing, reasons: ["CONTRIBUTION_NOT_INGESTED"] };
  if (sourceProof === "REGISTRATION_ZERO" && present.length > 0) return { state: "SOURCE_CONFLICT", expectedSourceKeys: expected, presentSourceKeys: present, missingSourceKeys: missing, reasons: ["REGISTRATION_ZERO_HAS_CONTRIBUTIONS"] };
  return { state: "COMPLETE", expectedSourceKeys: expected, presentSourceKeys: present, missingSourceKeys: missing, reasons: [] };
}

function centsFromYuan(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  const parsed = parseNonNegativeDecimal(value, 2, label);
  return decimalToBigInt(parsed, 2).toString();
}

function sourceRefFor(snapshot: AcceptedSettlementSnapshot, kind: "haff" | "items", fallback: GrowthContributionSourceRef): GrowthContributionSourceRef {
  return snapshot.sourceRefs?.[kind] ?? fallback;
}

function appendFact(facts: ContributionMapping["facts"], unmapped: ContributionMapping["unmapped"], fact: SettledContributionFact & { gameId: string }): void {
  const result = contributionFromSettlement(fact);
  if (result.accepted) facts.push(fact);
  else unmapped.push({ code: "SNAPSHOT_INVALID", detail: `source adapter rejected ${result.reason}` });
}

function legalMinimumBillingCents(snapshot: AcceptedSettlementSnapshot): string | null {
  const input = snapshot.inputSnapshot;
  const isTenantEarly = input.early === true && input.endReason === "TENANT_VOLUNTARY_EARLY" && snapshot.computation?.ok === true;
  if (!isTenantEarly) return null;
  return centsFromYuan(input.amounts?.earlyMakeup ?? snapshot.computation?.amounts?.earlyMakeup, "earlyMakeup");
}

export function mapAcceptedSettlementToGrowthFacts(snapshot: AcceptedSettlementSnapshot): ContributionMapping {
  const unmapped: ContributionMapping["unmapped"] = [];
  if (snapshot.supersededAt !== null || snapshot.postingId === null || snapshot.inputSnapshot.schema !== "settlement-version-v2"
    || snapshot.inputSnapshot.renterUserId !== snapshot.renterUserId) {
    return { facts: [], unmapped: [{ code: "SNAPSHOT_INVALID", detail: "settlement version is not the accepted current posted snapshot" }] };
  }
  const facts: ContributionMapping["facts"] = [];
  const haffCents = centsFromYuan(snapshot.inputSnapshot.amounts?.haffConsumedBuyer, "haffConsumedBuyer");
  const itemCents = centsFromYuan(snapshot.inputSnapshot.amounts?.itemConsumedBuyer, "itemConsumedBuyer");
  const base = { userId: snapshot.renterUserId, settlementVersion: String(snapshot.settlementVersionNo), status: "SETTLED" as const };
  const effectiveAt = snapshot.effectiveAtUtc;
  if (!effectiveAt) return { facts: [], unmapped: [{ code: "SNAPSHOT_INVALID", detail: "authoritative business effectiveAtUtc is missing; do not use posting time" }] };
  const recordedAt = snapshot.recordedAtUtc || effectiveAt;
  if (haffCents !== null && haffCents !== "0") {
    const ref = sourceRefFor(snapshot, "haff", { sourceKey: `RENTAL_SETTLEMENT:${snapshot.settlementVersionId}:haff`, sourceId: `${snapshot.settlementVersionId}:haff`, revision: 0 });
    appendFact(facts, unmapped, { ...base, gameId: snapshot.gameId, settlementId: ref.sourceKey.replace(/^[^:]+:/, ""), effectiveAt, recordedAt, amountCents: haffCents, component: ref.correctionOf ? "REFUND_CORRECTION" : "RENTAL_SETTLEMENT", revision: ref.revision, ...(ref.correctionOf === undefined ? {} : { correctionOf: ref.correctionOf }), ...(ref.correctionMode === undefined ? {} : { correctionMode: ref.correctionMode }) });
  }
  if (itemCents !== null && itemCents !== "0") {
    const ref = sourceRefFor(snapshot, "items", { sourceKey: `MATERIAL_CONSUMPTION:${snapshot.settlementVersionId}:items`, sourceId: `${snapshot.settlementVersionId}:items`, revision: 0 });
    appendFact(facts, unmapped, { ...base, gameId: snapshot.gameId, settlementId: ref.sourceKey.replace(/^[^:]+:/, ""), effectiveAt, recordedAt, amountCents: itemCents, component: ref.correctionOf ? "REFUND_CORRECTION" : "MATERIAL_CONSUMPTION", revision: ref.revision, ...(ref.correctionOf === undefined ? {} : { correctionOf: ref.correctionOf }), ...(ref.correctionMode === undefined ? {} : { correctionMode: ref.correctionMode }) });
  }
  if (!snapshot.inputSnapshot.amounts?.haffConsumedBuyer && !snapshot.inputSnapshot.amounts?.itemConsumedBuyer) {
    unmapped.push({ code: "SNAPSHOT_INVALID", detail: "accepted settlement has no buyer consumption amount" });
  }
  const minimumBillingCents = legalMinimumBillingCents(snapshot);
  if (minimumBillingCents !== null && minimumBillingCents !== "0") {
    appendFact(facts, unmapped, { ...base, gameId: snapshot.gameId, settlementId: `${snapshot.settlementVersionId}:earlyMakeup`, effectiveAt, recordedAt, amountCents: minimumBillingCents, component: "MINIMUM_BILLING", revision: 0 });
  } else {
    unmapped.push({ code: "MINIMUM_BILLING_SOURCE_MISSING", detail: snapshot.inputSnapshot.endReason === "TENANT_VOLUNTARY_EARLY" ? "tenant-early final settlement has no proven legal minimum-billing component" : "current settlement contract has no distinct legal minimum-billing component" });
  }
  unmapped.push({ code: "REFUND_CORRECTION_SOURCE_MISSING", detail: "refund payable/payment facts do not prove a consumption correction" });
  return { facts, unmapped };
}

type StoredSettlementSource = { settlementVersionId: string; versionNo: number; versionHash: string; userId: string; gameId: string; inputSnapshot: Record<string, unknown> };
type ExpectedSettlementSource = { sourceKey: string; sourceType: GrowthContribution["sourceType"]; sourceId: string; settlementVersion: string; versionHash: string; userId: string; gameId: string; amountCents: string };

function amountState(value: unknown): { state: "MISSING" | "INVALID" | "ZERO" | "POSITIVE"; cents?: string } {
  if (value === undefined || value === null) return { state: "MISSING" };
  if (typeof value !== "string") return { state: "INVALID" };
  try {
    const cents = decimalToBigInt(parseNonNegativeDecimal(value, 2, "settlement amount"), 2).toString();
    return cents === "0" ? { state: "ZERO", cents } : { state: "POSITIVE", cents };
  } catch {
    return { state: "INVALID" };
  }
}

function expectedSourcesFromSettlement(row: StoredSettlementSource): { sources: ExpectedSettlementSource[]; valid: boolean } {
  const amounts = isObject(row.inputSnapshot.amounts) ? row.inputSnapshot.amounts : null;
  if (!amounts) return { sources: [], valid: false };
  const haff = amountState(amounts.haffConsumedBuyer);
  const items = amountState(amounts.itemConsumedBuyer);
  if (haff.state === "MISSING" || haff.state === "INVALID" || items.state === "MISSING" || items.state === "INVALID") return { sources: [], valid: false };
  const base = { settlementVersion: String(row.versionNo), versionHash: row.versionHash, userId: row.userId, gameId: row.gameId };
  const sources: ExpectedSettlementSource[] = [];
  if (haff.state === "POSITIVE") sources.push({ ...base, sourceKey: `RENTAL_SETTLEMENT:${row.settlementVersionId}:haff`, sourceType: "RENTAL_SETTLEMENT", sourceId: `${row.settlementVersionId}:haff`, amountCents: haff.cents! });
  if (items.state === "POSITIVE") sources.push({ ...base, sourceKey: `MATERIAL_CONSUMPTION:${row.settlementVersionId}:items`, sourceType: "MATERIAL_CONSUMPTION", sourceId: `${row.settlementVersionId}:items`, amountCents: items.cents! });
  const legalEarly = row.inputSnapshot.early === true && row.inputSnapshot.endReason === "TENANT_VOLUNTARY_EARLY";
  if (legalEarly) {
    const makeup = amountState(amounts.earlyMakeup);
    if (makeup.state === "MISSING" || makeup.state === "INVALID") return { sources: [], valid: false };
    if (makeup.state === "POSITIVE") sources.push({ ...base, sourceKey: `MINIMUM_BILLING:${row.settlementVersionId}:earlyMakeup`, sourceType: "MINIMUM_BILLING", sourceId: `${row.settlementVersionId}:earlyMakeup`, amountCents: makeup.cents! });
  }
  return { sources, valid: true };
}

/** Result of membership-growth-legacy.assessLegacyCoverageRecord for this subject (Q wires the H3 record read). */
export type LegacyCoverageAssessment = { state: "COMPLETE" | "BACKFILL_PENDING" | "SOURCE_CONFLICT"; reasons: string[] };

export async function readGrowthSourceCompleteness(client: PoolClient, userId: string, contributions: readonly CompletenessContribution[], registrationSourceRef: string | null, legacyCoverage?: LegacyCoverageAssessment, asOfUtc?: string, readFacts?: { sourceRows: StoredSettlementSource[]; migrated: boolean }): Promise<GrowthSourceCompleteness> {
  const sourceRows = readFacts?.sourceRows ?? (await client.query<StoredSettlementSource>(
    `SELECT v.id AS "settlementVersionId", v.version_no AS "versionNo", v.version_hash AS "versionHash", o.renter_user_id AS "userId", o.game_id AS "gameId", v.input_snapshot AS "inputSnapshot"
       FROM zzsh_order.rental_order o
       JOIN zzsh_order.settlement_posting p ON p.order_id=o.id
       JOIN zzsh_order.settlement_version v ON v.id=p.settlement_version_id AND v.order_id=o.id
      WHERE o.renter_user_id=$1 AND v.superseded_at IS NULL
      ORDER BY v.id`, [userId],
  )).rows;
  const expectedDetails = sourceRows.map(expectedSourcesFromSettlement);
  if (expectedDetails.some((entry) => !entry.valid)) return { state: "SOURCE_CONFLICT", expectedSourceKeys: [], presentSourceKeys: [...new Set(contributions.filter((row) => row.status !== "PENDING").map((row) => row.sourceKey))].sort(), missingSourceKeys: [], reasons: ["FORMAL_SOURCE_SNAPSHOT_INVALID"] };
  const expectedSources = expectedDetails.flatMap((entry) => entry.sources);
  const expected = expectedSources.map((source) => source.sourceKey);
  const provenance = readFacts ? { migrated: readFacts.migrated } : (await client.query<{ migrated: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='user.legacy_owner.migrated' AND outcome='SUCCESS') AS migrated`, [userId],
  )).rows[0];
  if (typeof provenance?.migrated !== "boolean") throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Growth source proof is unavailable");
  const proof = sourceRows.length > 0 ? "FORMAL_SETTLEMENTS" : !provenance.migrated && registrationSourceRef === "registration:v1" ? "REGISTRATION_ZERO" : "UNKNOWN";
  const assessed = assessGrowthSourceCompleteness(expected, contributions, proof);
  const rowsByKey = new Map<string, CompletenessContribution[]>();
  for (const row of contributions) {
    const list = rowsByKey.get(row.sourceKey) ?? [];
    list.push(row as typeof list[number]);
    rowsByKey.set(row.sourceKey, list);
  }
  const conflicts: string[] = [];
  for (const source of expectedSources) {
    const rows = rowsByKey.get(source.sourceKey)?.filter((row) => row.status !== "PENDING") ?? [];
    const base = rows.find((row) => row.revision === 0 && !row.correctionOf);
    if (!base || base.userId !== source.userId || base.gameId !== source.gameId || base.settlementVersion !== source.settlementVersion || base.sourceType !== source.sourceType || base.sourceId !== source.sourceId || base.amountCents !== source.amountCents || !base.sourceDigest) conflicts.push(source.sourceKey);
    if (base && base.sourceDigest && base.userId === source.userId && base.gameId === source.gameId && base.settlementVersion === source.settlementVersion && base.sourceType === source.sourceType && base.sourceId === source.sourceId && base.amountCents === source.amountCents) {
      const expectedDigest = growthContributionSourceDigest(source.versionHash, source.gameId, base);
      if (base.sourceDigest !== expectedDigest) conflicts.push(`${source.sourceKey}:SOURCE_DIGEST`);
    }
    for (const row of rows) {
      if (!row.sourceDigest || (row.correctionOf && row.correctionOf !== source.sourceKey)) conflicts.push(row.sourceKey);
      if (row.sourceDigest && row.settlementVersion === source.settlementVersion) {
        const expectedDigest = growthContributionSourceDigest(source.versionHash, source.gameId, row);
        if (row.sourceDigest !== expectedDigest) conflicts.push(`${row.sourceKey}:SOURCE_DIGEST`);
      }
    }
  }
  const expectedSet = new Set(expected);
  // Legacy la_order rows are written only by membership-growth-legacy with their own digest; they are not native expected sources.
  const isLegacyRow = (row: CompletenessContribution) => /^legacy_mysql_restore:la_order:[1-9]\d{0,23}$/.test(row.correctionOf ? row.correctionOf.slice(row.correctionOf.indexOf(":") + 1) : row.sourceId);
  const legacyPresent = contributions.some((row) => row.status !== "PENDING" && isLegacyRow(row));
  for (const row of contributions) if (row.status !== "PENDING" && isLegacyRow(row) && !row.sourceDigest) conflicts.push(row.sourceKey);
  for (const row of contributions) if (row.status !== "PENDING" && !isLegacyRow(row) && !expectedSet.has(row.sourceKey) && !(row.correctionOf && expectedSet.has(row.correctionOf))) conflicts.push(row.sourceKey);
  if (conflicts.length > 0) return { ...assessed, state: "SOURCE_CONFLICT", reasons: [...(assessed.reasons ?? []), ...[...new Set(conflicts)].map((sourceKey) => `CONTRIBUTION_BINDING_INVALID:${sourceKey}`)] };
  // Native settlements cannot prove the migrated subject's earlier growth history.
  // Admitted legacy rows are partial history until a persisted coverage receipt exists (/root migration); never upgrade to COMPLETE here.
  if (legacyPresent && !provenance.migrated) return { ...assessed, state: "SOURCE_CONFLICT", reasons: [...(assessed.reasons ?? []), "LEGACY_ROWS_ON_NON_MIGRATED_SUBJECT"] };
  if (!provenance.migrated) return assessed;
  if (legacyCoverage === undefined) {
    // The legacy writer reuses this module's digest helpers; load its store only after initialization.
    const { readLegacyGrowthCoverageAssessment } = await import("./membership-growth-legacy-store");
    legacyCoverage = await readLegacyGrowthCoverageAssessment(client, userId, contributions, asOfUtc);
  }
  if (legacyCoverage?.state === "SOURCE_CONFLICT") return { ...assessed, state: "SOURCE_CONFLICT", reasons: [...(assessed.reasons ?? []), ...legacyCoverage.reasons] };
  // Native increments (after cutoff) keep their own completeness; legacy history is COMPLETE only via a valid persisted record.
  if (legacyCoverage?.state === "COMPLETE" && (assessed.state === "COMPLETE" || (sourceRows.length === 0 && assessed.reasons?.length === 1 && assessed.reasons[0] === "FORMAL_SOURCE_PROOF_MISSING"))) return { ...assessed, state: "COMPLETE", reasons: [] };
  return { ...assessed, state: "BACKFILL_PENDING", reasons: [...(assessed.reasons ?? []), "MIGRATED_SOURCE_NOT_PROVED", ...(legacyCoverage ? legacyCoverage.reasons : legacyPresent ? ["LEGACY_COVERAGE_RECEIPT_NOT_PERSISTED"] : [])] };
}

export type GrowthContributionWriteResult = {
  inserted: number;
  replayed: number;
  unmapped: ContributionMapping["unmapped"];
};

export async function recordAcceptedSettlementGrowthFacts(client: PoolClient, snapshot: AcceptedSettlementSnapshot): Promise<GrowthContributionWriteResult> {
  const mapped = mapAcceptedSettlementToGrowthFacts(snapshot);
  let inserted = 0;
  let replayed = 0;
  for (const fact of mapped.facts) {
    const parsed = contributionFromSettlement(fact);
    if (!parsed.accepted) continue;
    const contribution = parsed.contribution;
    const sourceDigest = growthContributionSourceDigest(snapshot.versionHash, fact.gameId, contribution);
    const id = `growth_contribution_${createHash("sha256").update(`${contribution.userId}\u0000${contribution.sourceKey}\u0000${contribution.revision}`).digest("hex").slice(0, 48)}`;
    const result = await client.query<{ id: string }>(
      `INSERT INTO zzsh_iam.membership_growth_contribution
         (id,user_id,game_id,source_key,source_type,source_id,settlement_version,revision,effective_at,recorded_at,amount_cents,previous_amount_cents,correction_of_source_key,correction_mode,state,eligible,source_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (user_id, source_key, revision) DO NOTHING RETURNING id`,
      [id, contribution.userId, fact.gameId, contribution.sourceKey, contribution.sourceType, contribution.sourceId, contribution.settlementVersion, contribution.revision, contribution.effectiveAt, contribution.recordedAt, contribution.amountCents, contribution.previousAmountCents ?? null, contribution.correctionOf ?? null, contribution.correctionMode ?? null, contribution.status, contribution.eligible, sourceDigest],
    );
    if (result.rowCount === 1) {
      inserted += 1;
      continue;
    }
    // UNIQUE + INSERT ON CONFLICT serializes competing inserts; the original row is runtime-immutable.
    const existing = (await client.query<{ sourceDigest: string }>(`SELECT source_digest AS "sourceDigest" FROM zzsh_iam.membership_growth_contribution WHERE user_id=$1 AND source_key=$2 AND revision=$3`, [contribution.userId, contribution.sourceKey, contribution.revision])).rows[0];
    if (!existing || existing.sourceDigest !== sourceDigest) throw new SecurityApiError(409, "CONFLICT", `Contribution revision conflict for ${contribution.sourceKey}:${contribution.revision}`);
    replayed += 1;
  }
  return { inserted, replayed, unmapped: mapped.unmapped };
}

export type GrowthBackfillActor = { source: "SETTLEMENT_POST_COMMIT" | "ADMIN_MAINTENANCE"; realm: "user" | "admin"; userId: string; sessionId: string };
export type GrowthBackfillResult = { status: "APPLIED" | "REPLAYED" | "PENDING" | "FAILED"; settlementVersionId?: string; inserted?: number; replayed?: number; reason?: string; unmapped?: ContributionMapping["unmapped"] };

export function settlementBackfillActorAllowed(actor: Pick<GrowthBackfillActor, "source" | "realm" | "userId">, order: { renterUserId: string; ownerUserId: string }): boolean {
  if (actor.source !== "SETTLEMENT_POST_COMMIT") return false;
  return actor.realm === "admin" || actor.userId === order.renterUserId || actor.userId === order.ownerUserId;
}

export function normalizeGrowthInstant(value: unknown, field = "timestamp"): string {
  const raw = value instanceof Date ? value.toISOString() : typeof value === "string" ? value.trim() : "";
  const withT = raw.includes(" ") && !raw.includes("T") ? raw.replace(" ", "T") : raw;
  const withOffset = /[+-]\d{2}$/.test(withT) ? `${withT}:00` : withT;
  try {
    const normalized = normalizeTime(withOffset);
    if (!normalized) throw new Error("empty normalized timestamp");
    return normalized;
  } catch {
    throw new SecurityApiError(409, "CONFLICT", `${field} is not a valid timestamp`);
  }
}

export function resolveGrowthEffectiveTime(inputSnapshot: Record<string, unknown>, postedAtUtc: string): { effectiveAtUtc: string; source: "AUTHORITATIVE_SNAPSHOT" | "POSTING_CONFIRMED_AT_V1" } {
  const explicit = inputSnapshot.effectiveAtUtc;
  if (explicit !== undefined) {
    return { effectiveAtUtc: normalizeGrowthInstant(explicit, "effectiveAtUtc"), source: "AUTHORITATIVE_SNAPSHOT" };
  }
  return { effectiveAtUtc: normalizeGrowthInstant(postedAtUtc, "postedAt"), source: "POSTING_CONFIRMED_AT_V1" };
}

async function auditGrowthBackfill(pool: Pool, actor: GrowthBackfillActor, requestId: string, objectId: string, outcome: "SUCCESS" | "FAILURE", reason: string, details: Record<string, unknown>): Promise<void> {
  try {
    await withTransaction(pool, async (client) => recordAudit(client, { actorType: actor.realm, actorId: actor.userId, sessionId: actor.sessionId, action: "membership.growth.backfill", objectType: "settlement_version", objectId, outcome, requestId, reason, details }));
  } catch {
    // Backfill observability must not turn a committed financial posting into a failed request.
  }
}

/**
 * Replays one committed posting in an independent transaction. The settlement
 * transaction is already complete when this is called; absent authoritative
 * Current settlement-v2 has no separate consumption-end field. Until that
 * formal source exists, the accepted posting timestamp is the explicit
 * settlement-confirmed business event time (not this callback's runtime).
 */
export async function backfillAcceptedSettlementAfterPosting(pool: Pool, orderId: string, actor: GrowthBackfillActor, requestId: string): Promise<GrowthBackfillResult> {
  try {
    const result = await withTransaction(pool, async (client) => {
      const row = (await client.query<{ orderId: string; renterUserId: string; ownerUserId: string; gameId: string; postingId: string; settlementVersionId: string; settlementVersionNo: number; versionHash: string; supersededAt: string | null; postedAt: string; inputSnapshot: Record<string, unknown>; computation: Record<string, unknown> }>(
        `SELECT o.id AS "orderId", o.renter_user_id AS "renterUserId", o.owner_user_id AS "ownerUserId", o.game_id AS "gameId", p.id AS "postingId", v.id AS "settlementVersionId", v.version_no AS "settlementVersionNo", v.version_hash AS "versionHash", v.superseded_at AS "supersededAt", p.posted_at::text AS "postedAt", v.input_snapshot AS "inputSnapshot", v.computation AS "computation"
           FROM zzsh_order.settlement_posting p
           JOIN zzsh_order.rental_order o ON o.id=p.order_id
           JOIN zzsh_order.settlement_version v ON v.id=p.settlement_version_id
          WHERE p.order_id=$1`, [orderId],
      )).rows[0];
      if (!row) return { status: "PENDING" as const, reason: "POSTING_NOT_FOUND" };
      if (actor.source === "SETTLEMENT_POST_COMMIT" && !settlementBackfillActorAllowed(actor, row)) throw new SecurityApiError(403, "FORBIDDEN", "Backfill actor is not a settlement participant");
      if (actor.source === "ADMIN_MAINTENANCE") {
        const access = await loadEffectiveAdminAccess(client, actor.userId);
        if (!access || (!access.isBoss && !hasPermission(access, ADMIN_PERMISSION.membershipGrowthBackfill))) throw new SecurityApiError(403, "FORBIDDEN", "Membership backfill permission is required");
        if (!access.isBoss && !scopeAllowsGame(await readAdminGameScope(client, actor.userId), false, row.gameId)) throw new SecurityApiError(403, "FORBIDDEN", "Membership backfill is outside the administrator game scope");
      }
      const effectiveTime = resolveGrowthEffectiveTime(row.inputSnapshot, row.postedAt);
      const effectiveAtUtc = effectiveTime.effectiveAtUtc;
      const recordedAtUtc = row.inputSnapshot.recordedAtUtc === undefined || row.inputSnapshot.recordedAtUtc === null ? normalizeGrowthInstant(row.postedAt, "postedAt") : normalizeGrowthInstant(row.inputSnapshot.recordedAtUtc, "recordedAtUtc");
      const snapshot: AcceptedSettlementSnapshot = {
        orderId: row.orderId,
        settlementVersionId: row.settlementVersionId,
        settlementVersionNo: row.settlementVersionNo,
        versionHash: row.versionHash,
        supersededAt: row.supersededAt,
        postingId: row.postingId,
        gameId: row.gameId,
        renterUserId: row.renterUserId,
        effectiveAtUtc,
        recordedAtUtc,
        inputSnapshot: row.inputSnapshot as AcceptedSettlementSnapshot["inputSnapshot"],
        computation: row.computation as AcceptedSettlementSnapshot["computation"],
      };
      const written = await recordAcceptedSettlementGrowthFacts(client, snapshot);
      return { status: "SUCCESS" as const, settlementVersionId: row.settlementVersionId, effectiveTimeSource: effectiveTime.source, inserted: written.inserted, replayed: written.replayed, unmapped: written.unmapped };
    });
    if (result.status === "PENDING") {
      await auditGrowthBackfill(pool, actor, requestId, orderId, "FAILURE", "backfill_pending", { status: result.status, reason: result.reason });
      return result;
    }
    const status: GrowthBackfillResult["status"] = result.inserted > 0 ? "APPLIED" : result.replayed > 0 ? "REPLAYED" : "APPLIED";
    await auditGrowthBackfill(pool, actor, requestId, result.settlementVersionId, "SUCCESS", "backfill_completed", { status, effectiveTimeSource: result.effectiveTimeSource, inserted: result.inserted, replayed: result.replayed, unmapped: result.unmapped });
    return { status, settlementVersionId: result.settlementVersionId, inserted: result.inserted, replayed: result.replayed, unmapped: result.unmapped };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    await auditGrowthBackfill(pool, actor, requestId, orderId, "FAILURE", "backfill_failed", { error: reason });
    return { status: "FAILED", reason };
  }
}

export function membershipGrowthPostCommitCallback(pool: Pool, orderId: string, actor: Omit<GrowthBackfillActor, "source">, requestId: string): (() => Promise<void>) | undefined {
  const internalActor: GrowthBackfillActor = { source: "SETTLEMENT_POST_COMMIT", ...actor };
  return membershipGrowthEnabled() ? async () => { await backfillAcceptedSettlementAfterPosting(pool, orderId, internalActor, requestId); } : undefined;
}

export type GrowthProjectionDto = {
  schema: "membership-growth-v1";
  knowledge: GrowthKnowledge;
  sourceState: GrowthSourceState;
  benefitsState: GrowthBenefitsState;
  asOfUtc: string;
  windowStartUtc: string;
  rollingPoints: string | null;
  lifetimePoints: string | null;
  normalTier: GrowthProjection["normalTier"] | null;
  effectiveTier: GrowthProjection["effectiveTier"] | null;
  blackGold: GrowthProjection["blackGold"] | null;
  grace: GrowthProjection["grace"] | null;
  nextExpiryAtUtc: string | null;
  nextTier: { tier: GrowthProjection["normalTier"]; threshold: string; remaining: string } | null;
  benefits: GrowthBenefitSummary[];
  comparison: GrowthComparison[];
  contributions: GrowthContributionSummary[];
  pendingCount: number;
  pending: GrowthProjection["pending"];
  excluded: GrowthProjection["excluded"];
};

export type GrowthBenefitSummary = { label: string; value: string; sourceVersion?: string };
export type GrowthComparison = { tier: string; deposit: string; pricing: string };
export type GrowthContributionSummary = { label: string; effectiveAt: string; amountCents: string; exitsAt: string; kind: "CONSUMPTION" | "CORRECTION" };

export type GrowthEntitlementSummary = {
  id: string;
  kind: "FRIEND" | "PRESTIGE";
  scopeKey: string;
  gameId?: string | null;
  gameName?: string | null;
  startsAtUtc: string;
  endsAtUtc: string;
  status: ExistingEntitlement["status"];
  label: string;
  depositWaived: boolean;
  depositAllowanceCents?: string;
  pricingSummary?: EntitlementPricingSummary;
};

export type GrowthReaderResponse = {
  subjectId: string;
  growth: GrowthProjectionDto;
  entitlements: GrowthEntitlementSummary[];
  sourceSummary: { contributionCount: number; pendingCount: number; excludedCount: number };
};

type StoredContribution = GrowthContribution & { gameId: string; sourceDigest?: string | null };
type StoredEntitlement = { id: string; kind: "FRIEND" | "PRESTIGE"; scopeKey: string; gameId?: string | null; gameName?: string | null; startsAt: string; endsAt: string; status: ExistingEntitlement["status"]; depositWaived: boolean; depositAllowanceCents?: string | null; pricingPayload?: unknown };
type StoredQuoteEntitlement = StoredEntitlement & { pricingPayload: unknown };
type StoredGrowthState = { normalTier: string; effectiveTier: string; blackGoldState: string; lastTierDropAt: string | null };
type StoredGrowthPolicy = { id: string; version: string; policyPayload: Record<string, unknown>; haffRule: unknown };

function normalizeStoredEntitlement<T extends StoredEntitlement>(row: T): T {
  return { ...row, startsAt: normalizeGrowthInstant(row.startsAt, "startsAt"), endsAt: normalizeGrowthInstant(row.endsAt, "endsAt") };
}
function normalizeStoredContribution(row: StoredContribution): StoredContribution {
  return { ...row, revision: Number(row.revision), effectiveAt: normalizeGrowthInstant(row.effectiveAt, "effectiveAt"), recordedAt: normalizeGrowthInstant(row.recordedAt, "recordedAt") };
}

function configuredPricing(value: unknown): value is GrowthPricingContract {
  return isObject(value) && value.status !== "NOT_PRICED" && typeof value.mode === "string" && typeof value.priceVersionId === "string" && isObject(value.haff) && value.haff.status === "CONFIGURED" && isObject(value.materials);
}

/** A mode slot is spendable when it carries either a configured total discount or a configured legacy contract. */
function configuredModeContract(value: unknown): value is Exclude<ModePricingContract, NotPricedParameter> {
  if (isTotalDiscountContract(value)) return typeof value.payableRatio === "string" && value.payableRatio !== "" && typeof value.priceVersionId === "string";
  return configuredPricing(value);
}

function configuredHaff(value: unknown): value is Exclude<HaffPricingParameter, { status: "NOT_PRICED" }> {
  return isObject(value) && value.status === "CONFIGURED" && value.kind === "HAFF_RATIO" && typeof value.priceVersionId === "string" && typeof value.costBasisRef === "string" && isObject(value.baseBySafeBox);
}

function configuredMaterial(value: unknown): value is Exclude<MaterialPricingParameter, { status: "NOT_PRICED" }> {
  return isObject(value) && value.status === "CONFIGURED" && value.kind === "FIXED_UNIT" && typeof value.itemId === "string" && typeof value.unit === "string" && typeof value.unitQuantity === "string" && typeof value.buyerUnitAmount === "string" && typeof value.ownerUnitAmount === "string";
}

function quoteInputForGrowth(base: QuoteInput, contract: GrowthPricingContract): QuoteInput | null {
  const rentalMode = base.conditions.rentalPricing?.rentalMode ?? "ordinary";
  if (contract.mode !== rentalMode || contract.priceVersionId !== base.priceVersionId) return null;
  if (!configuredHaff(contract.haff)) return null;
  const haff = contract.haff;
  if (base.mode === "SPREAD" && typeof haff.spreadDelta !== "string") return null;
  if (!base.haffRule && base.lines.some((line) => line.pricingKind === "HAFF_RATIO")) return null;
  const lines: PricingLineInput[] = [];
  for (const line of base.lines) {
    if (line.pricingKind === "HAFF_RATIO") {
      lines.push({ ...line, customerTier: "STANDARD" });
      continue;
    }
    const material = contract.materials[line.itemId];
    if (!configuredMaterial(material) || (line.unit !== undefined && material.unit !== line.unit)) return null;
    const fixed = { ...line, customerTier: "STANDARD" as const, unit: material.unit, unitQuantity: material.unitQuantity, buyerUnitAmount: material.buyerUnitAmount };
    lines.push(base.mode === "SPREAD" ? { ...fixed, ownerUnitAmount: material.ownerUnitAmount } : fixed);
  }
  if (base.haffRule && !Object.hasOwn(haff.baseBySafeBox, base.conditions.safeBoxCode ?? "")) return null;
  let haffRule = base.haffRule;
  if (base.haffRule?.schema === "haff-ratio-v2") {
    if (base.mode !== "SPREAD" || typeof haff.spreadDelta !== "string" || !base.haffRule.compatibility) return null;
    const zeroDiscounts = { STANDARD: "0", VIP: "0", SVIP: "0", DISCOUNT_USER: "0" };
    haffRule = {
      ...base.haffRule,
      baseBySafeBox: haff.baseBySafeBox,
      compatibility: {
        ...base.haffRule.compatibility,
        ordinary: { ...base.haffRule.compatibility.ordinary, spreadDelta: haff.spreadDelta, discounts: zeroDiscounts },
        fast: { ...base.haffRule.compatibility.fast, spreadDelta: haff.spreadDelta, discounts: zeroDiscounts },
      },
    };
  } else if (base.haffRule) {
    haffRule = { ...base.haffRule, baseBySafeBox: haff.baseBySafeBox, ...(base.mode === "SPREAD" ? { spreadDelta: haff.spreadDelta } : {}) };
  }
  return { ...base, customerTier: "STANDARD", lines, haffRule };
}

function quoteCandidate(base: QuoteInput, contract: Exclude<ModePricingContract, NotPricedParameter>, source: GrowthOfferPlan["source"], benefitVersion: string, binding: OfferBinding, depositWaived: boolean, entitlementId?: string, validUntil?: string, allowanceCents?: string): { plan: GrowthOfferPlan; quote: InternalQuote } | null {
  const depositCents = tenantDepositAfterBenefit(base.deposits?.tenantDepositCents ?? null, depositWaived, allowanceCents);
  base = { ...base, deposits: { ...base.deposits, ...(depositCents === null ? {} : { tenantDepositCents: depositCents }) } };
  const planInput = { source, benefitVersion, binding, ...(entitlementId ? { entitlementId } : {}), ...(validUntil ? { validUntil } : {}) };
  if (isTotalDiscountContract(contract)) {
    const rentalMode = base.conditions.rentalPricing?.rentalMode ?? "ordinary";
    if ((!isUnifiedTotalDiscountContract(contract) && contract.mode !== rentalMode) || contract.priceVersionId !== base.priceVersionId) return null;
    const result = computeDeltaQuote(base);
    if (!result.quotable) return null;
    const discounted = applyTotalDiscountToQuote(result.quote, contract.payableRatio);
    if (!discounted) return null;
    return { quote: discounted.quote, plan: quoteToGrowthOfferPlan(discounted.quote, planInput) };
  }
  const input = quoteInputForGrowth(base, contract);
  if (!input) return null;
  const result = computeDeltaQuote(input);
  if (!result.quotable) return null;
  return { quote: result.quote, plan: quoteToGrowthOfferPlan(result.quote, planInput) };
}

function tierLabel(tier: GrowthProjection["normalTier"]): string {
  return { STANDARD: "普通会员", SILVER: "银卡会员", GOLD: "金卡会员", PLATINUM: "铂金会员", DIAMOND: "钻石会员" }[tier];
}

function nextTierFor(projection: GrowthProjection): GrowthProjectionDto["nextTier"] {
  const index = NORMAL_GROWTH_TIERS.indexOf(projection.normalTier);
  const next = NORMAL_GROWTH_TIERS[index + 1];
  if (!next) return null;
  const threshold = GROWTH_THRESHOLDS[next];
  const remaining = threshold - BigInt(projection.rollingPoints);
  return { tier: next, threshold: threshold.toString(), remaining: (remaining > 0n ? remaining : 0n).toString() };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function modeContractConfigured(config: Record<string, unknown> | undefined, mode: string): boolean {
  const pricing = isObject(config?.pricing) ? config.pricing : null;
  const contract = pricing ? pricing[mode] : undefined;
  if (!isObject(contract) || contract.status === "NOT_PRICED") return false;
  if (contract.kind === "TOTAL_DISCOUNT") return typeof contract.payableRatio === "string" && contract.payableRatio !== "";
  const haff = contract.haff;
  return isObject(haff) && haff.status !== "NOT_PRICED";
}

/**
 * R1-05: readiness follows the SEALED release's authoritative enabled modes, never a fixed three-mode
 * count. Disabled modes are inert; an enabled mode without a price, or an unreadable release, is not ready.
 */
function policyModesReady(config: Record<string, unknown> | undefined, enabledModes: readonly RentalMode[] | null): boolean {
  if (enabledModes === null || enabledModes.length === 0) return false;
  return enabledModes.every((mode) => modeContractConfigured(config, mode));
}

function policySummaries(policyPayload: Record<string, unknown> | null, policyVersion: string | null, tier: GrowthProjection["normalTier"] | null, benefitsState: GrowthBenefitsState, enabledModes: readonly RentalMode[] | null): { benefits: GrowthBenefitSummary[]; comparison: GrowthComparison[] } {
  if (!policyPayload || benefitsState !== "CONFIGURED") return { benefits: [{ label: "成长权益", value: "尚未发布" }], comparison: [] };
  const tiers = isObject(policyPayload.tiers) ? policyPayload.tiers : {};
  const current = tier && isObject(tiers[tier]) ? tiers[tier] : undefined;
  const depositLabel = (config: Record<string, unknown> | undefined) => {
    if (!config) return "押金权益待核";
    try {
      const allowance = parseDepositAllowanceCents(config.depositAllowanceCents, config.tenantDeposit === "WAIVED");
      return config.tenantDeposit === "WAIVED" ? "免租客押金" : allowance === "0" ? "租客押金按账号条件缴纳" : `租客押金最高减免 ${formatScaledInteger(BigInt(allowance), 2)} 元`;
    } catch { return "押金权益待核"; }
  };
  const deposit = depositLabel(current);
  const modesReady = policyModesReady(current, enabledModes);
  const benefits = [
    { label: "租客押金", value: deposit, ...(policyVersion ? { sourceVersion: policyVersion } : {}) },
    { label: "租赁价格", value: modesReady ? "按完整报价择优" : "价格方案暂不可用", ...(policyVersion ? { sourceVersion: policyVersion } : {}) },
  ];
  const comparison = NORMAL_GROWTH_TIERS.map((candidate) => {
    const item = isObject(tiers[candidate]) ? tiers[candidate] : undefined;
    return { tier: tierLabel(candidate), deposit: depositLabel(item), pricing: policyModesReady(item, enabledModes) ? "完整方案可比价" : "价格方案未就绪" };
  });
  return { benefits, comparison };
}

function contributionSummaries(projection: GrowthProjection, rows: readonly StoredContribution[]): GrowthContributionSummary[] {
  const latest = new Map<string, StoredContribution>();
  const asOf = normalizeGrowthInstant(projection.asOf, "projection.asOf");
  for (const row of rows) if (normalizeGrowthInstant(row.recordedAt, "recordedAt") <= asOf && (!latest.has(row.sourceKey) || latest.get(row.sourceKey)!.revision < row.revision)) latest.set(row.sourceKey, row);
  return projection.active.map((item) => {
    const row = latest.get(item.sourceKey)!;
    const correction = row.sourceType === "REFUND_CORRECTION" || row.correctionMode != null;
    return { label: correction ? "消费更正" : row.sourceType === "MATERIAL_CONSUMPTION" ? "物资消费" : "租赁结算消费", effectiveAt: item.effectiveAt, amountCents: item.amountCents, exitsAt: item.expiresAt, kind: correction ? "CORRECTION" : "CONSUMPTION" };
  });
}

export function policyTierForGrowthProjection(projection: Pick<GrowthProjection, "effectiveTier" | "normalTier" | "grace">): NormalGrowthTier | null {
  if (projection.effectiveTier === "BLACK_GOLD") return "DIAMOND";
  if (projection.grace.state === "ACTIVE" && projection.grace.fromTier) return projection.grace.fromTier;
  return projection.effectiveTier !== "UNKNOWN" ? projection.effectiveTier : null;
}

function dtoFromProjection(projection: GrowthProjection | null, asOfUtc: string, benefitsState: GrowthBenefitsState, sourceState: GrowthSourceState, known: boolean, policyPayload: Record<string, unknown> | null, policyVersion: string | null, rows: readonly StoredContribution[], enabledModes: readonly RentalMode[] | null): GrowthProjectionDto {
  if (!projection || !known) {
    const windowStartUtc = growthWindowStartAt(asOfUtc);
    return { schema: "membership-growth-v1", knowledge: "UNKNOWN", sourceState, benefitsState, asOfUtc, windowStartUtc, rollingPoints: null, lifetimePoints: null, normalTier: null, effectiveTier: null, blackGold: null, grace: null, nextExpiryAtUtc: null, nextTier: null, benefits: [], comparison: [], contributions: [], pendingCount: projection?.pending.length ?? 0, pending: projection?.pending ?? [], excluded: projection?.excluded ?? [] };
  }
  const summaries = policySummaries(policyPayload, policyVersion, policyTierForGrowthProjection(projection), benefitsState, enabledModes);
  return { schema: "membership-growth-v1", knowledge: "KNOWN", sourceState, benefitsState, asOfUtc: projection.asOf, windowStartUtc: projection.windowStart, rollingPoints: projection.rollingPoints, lifetimePoints: projection.lifetimePoints, normalTier: projection.normalTier, effectiveTier: projection.effectiveTier, blackGold: projection.blackGold, grace: projection.grace, nextExpiryAtUtc: projection.nextExpiryAt, nextTier: nextTierFor(projection), benefits: summaries.benefits, comparison: summaries.comparison, contributions: contributionSummaries(projection, rows), pendingCount: projection.pending.length, pending: projection.pending, excluded: projection.excluded };
}

function projectMembershipGrowth(userId: string, rows: StoredContribution[], storedState: StoredGrowthState | null, completeness: GrowthSourceCompleteness | null, policy: StoredGrowthPolicy | undefined, entitlements: StoredEntitlement[], asOfUtc: string): GrowthReaderResponse {
  const previousTier = storedState && (NORMAL_GROWTH_TIERS as readonly string[]).includes(storedState.normalTier) ? storedState.normalTier as GrowthProjection["normalTier"] : undefined;
  const projection = replayGrowthProjection({
    userId, asOf: asOfUtc, contributions: rows,
    ...(previousTier ? { previousTier } : {}),
    ...(storedState?.lastTierDropAt ? { lastTierDropAt: normalizeGrowthInstant(storedState.lastTierDropAt, "lastTierDropAt") } : {}),
    ...(storedState && (storedState.effectiveTier === "BLACK_GOLD" || storedState.blackGoldState === "QUALIFIED" || storedState.blackGoldState === "REVIEW_REQUIRED") ? { existingBlackGold: true } : {}),
  });
  return {
    subjectId: userId,
    growth: dtoFromProjection(projection, asOfUtc, policy ? "CONFIGURED" : "NOT_CONFIGURED", completeness?.state ?? "READ_FAILED", completeness?.state === "COMPLETE" && projection.effectiveTier !== "UNKNOWN", policy?.policyPayload ?? null, policy?.version ?? null, rows, policy ? sealedEnabledRentalModes(policy.haffRule) : null),
    entitlements: entitlements.map(normalizeStoredEntitlement).map((item) => ({ id: item.id, kind: item.kind, scopeKey: item.scopeKey, gameId: item.gameId ?? null, gameName: item.gameName ?? null, startsAtUtc: item.startsAt, endsAtUtc: item.endsAt, status: entitlementStateAt(item, asOfUtc), label: item.kind === "FRIEND" ? "挚友礼遇" : "尊享礼遇", depositWaived: item.depositWaived, depositAllowanceCents: parseDepositAllowanceCents(item.depositAllowanceCents ?? undefined, item.depositWaived), pricingSummary: entitlementPricingSummary(item.pricingPayload) })),
    sourceSummary: { contributionCount: rows.length, pendingCount: projection.pending.length, excludedCount: projection.excluded.length },
  };
}

async function readMembershipGrowthModel(client: PoolClient, userId: string, asOfUtc: string): Promise<{ response: GrowthReaderResponse; rows: StoredContribution[]; policy: StoredGrowthPolicy | undefined } | null> {
  const user = (await client.query<{ id: string }>(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1`, [userId])).rows[0];
  if (!user) return null;
  const rows = (await client.query<StoredContribution>(
    `SELECT user_id AS "userId", game_id AS "gameId", source_key AS "sourceKey", source_type AS "sourceType", source_id AS "sourceId",
            settlement_version AS "settlementVersion", effective_at::text AS "effectiveAt", recorded_at::text AS "recordedAt", amount_cents::text AS "amountCents",
            state AS status, eligible, revision, previous_amount_cents::text AS "previousAmountCents",
            correction_of_source_key AS "correctionOf", correction_mode AS "correctionMode", source_digest AS "sourceDigest"
       FROM zzsh_iam.membership_growth_contribution WHERE user_id=$1 ORDER BY effective_at, source_key, revision`, [userId],
  )).rows.map(normalizeStoredContribution);
  const oldMembership = (await client.query<{ sourceRef: string | null }>(`SELECT source_ref AS "sourceRef" FROM zzsh_iam.user_rental_membership WHERE user_id=$1`, [userId])).rows[0];
  let storedState: StoredGrowthState | null = null;
  try {
    storedState = (await client.query<StoredGrowthState>(`SELECT normal_tier AS "normalTier", effective_tier AS "effectiveTier", black_gold_state AS "blackGoldState", last_tier_drop_at::text AS "lastTierDropAt" FROM zzsh_iam.membership_growth_state WHERE user_id=$1`, [userId])).rows[0] ?? null;
  } catch {
    storedState = null;
  }
  let completeness: GrowthSourceCompleteness | null = null;
  try {
    completeness = await readGrowthSourceCompleteness(client, userId, rows, oldMembership?.sourceRef ?? null, undefined, asOfUtc);
  } catch {
    completeness = null;
  }
  const policy = (await client.query<StoredGrowthPolicy>(
    `SELECT pol.id, pol.version::text AS version, pol.policy_payload AS "policyPayload", p.haff_rule AS "haffRule"
       FROM zzsh_iam.membership_growth_policy pol
       LEFT JOIN zzsh_supply.rule_release r ON r.id=pol.rule_release_id
       LEFT JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
      WHERE pol.status='APPROVED' AND pol.effective_at <= $1 ORDER BY pol.version DESC LIMIT 1`, [asOfUtc],
  )).rows[0];
  const entitlements = (await client.query<StoredEntitlement>(
    `SELECT e.id,e.kind,e.scope_key AS "scopeKey",e.game_id AS "gameId",g.name AS "gameName",e.starts_at::text AS "startsAt",e.ends_at::text AS "endsAt",e.status,e.deposit_waived AS "depositWaived",e.deposit_allowance_cents::text AS "depositAllowanceCents",e.pricing_payload AS "pricingPayload"
       FROM zzsh_iam.membership_entitlement e LEFT JOIN zzsh_supply.game g ON g.id=e.game_id WHERE e.user_id=$1 ORDER BY e.starts_at DESC,e.id DESC LIMIT 100`, [userId],
  )).rows;
  return { rows, policy, response: projectMembershipGrowth(userId, rows, storedState, completeness, policy, entitlements, asOfUtc) };
}

export async function readMembershipGrowth(client: PoolClient, userId: string, asOfUtc = new Date().toISOString()): Promise<GrowthReaderResponse | null> {
  return (await readMembershipGrowthModel(client, userId, asOfUtc))?.response ?? null;
}

function groupGrowthRows<T extends { userId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.userId) ?? [];
    group.push(row); grouped.set(row.userId, group);
  }
  return grouped;
}

/** Directory pages share the single-subject projection without one SQL round trip per user. */
export async function readMembershipGrowthBatch(client: PoolClient, userIds: readonly string[], asOfUtc = new Date().toISOString()): Promise<Map<string, GrowthReaderResponse>> {
  const ids = [...new Set(userIds)], results = new Map<string, GrowthReaderResponse>();
  if (ids.length === 0) return results;
  const asOf = normalizeGrowthInstant(asOfUtc);
  const subjects = (await client.query<StoredGrowthState & { userId: string; sourceRef: string | null; migrated: boolean }>(
    `SELECT /* directory-growth-subjects */ u.id AS "userId", m.source_ref AS "sourceRef",
       s.normal_tier AS "normalTier", s.effective_tier AS "effectiveTier", s.black_gold_state AS "blackGoldState", s.last_tier_drop_at::text AS "lastTierDropAt",
       COALESCE(p.migrated,false) AS migrated
     FROM zzsh_auth_user."user" u LEFT JOIN zzsh_iam.user_rental_membership m ON m.user_id=u.id
     LEFT JOIN zzsh_iam.membership_growth_state s ON s.user_id=u.id
     LEFT JOIN (SELECT DISTINCT e.object_id, true AS migrated FROM zzsh_iam.audit_event e
         WHERE e.action='user.legacy_owner.migrated' AND e.outcome='SUCCESS' AND e.object_id=ANY($1::text[])) p ON p.object_id=u.id
     WHERE u.id=ANY($1::text[])`, [ids],
  )).rows;
  const contributions = groupGrowthRows((await client.query<StoredContribution>(
    `SELECT /* directory-growth-contributions */ user_id AS "userId", game_id AS "gameId", source_key AS "sourceKey", source_type AS "sourceType", source_id AS "sourceId",
       settlement_version AS "settlementVersion", effective_at::text AS "effectiveAt", recorded_at::text AS "recordedAt", amount_cents::text AS "amountCents",
       state AS status, eligible, revision, previous_amount_cents::text AS "previousAmountCents", correction_of_source_key AS "correctionOf", correction_mode AS "correctionMode", source_digest AS "sourceDigest"
     FROM zzsh_iam.membership_growth_contribution WHERE user_id=ANY($1::text[]) ORDER BY effective_at,source_key,revision`, [ids],
  )).rows.map(normalizeStoredContribution));
  const sources = groupGrowthRows((await client.query<StoredSettlementSource>(
    `SELECT /* directory-growth-sources */ v.id AS "settlementVersionId", v.version_no AS "versionNo", v.version_hash AS "versionHash", o.renter_user_id AS "userId", o.game_id AS "gameId", v.input_snapshot AS "inputSnapshot"
     FROM zzsh_order.rental_order o JOIN zzsh_order.settlement_posting p ON p.order_id=o.id
     JOIN zzsh_order.settlement_version v ON v.id=p.settlement_version_id AND v.order_id=o.id
     WHERE o.renter_user_id=ANY($1::text[]) AND v.superseded_at IS NULL ORDER BY v.id`, [ids],
  )).rows);
  const policy = (await client.query<StoredGrowthPolicy>(
    `SELECT /* directory-growth-policy */ pol.id,pol.version::text AS version,pol.policy_payload AS "policyPayload",p.haff_rule AS "haffRule"
     FROM zzsh_iam.membership_growth_policy pol LEFT JOIN zzsh_supply.rule_release r ON r.id=pol.rule_release_id
     LEFT JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
     WHERE pol.status='APPROVED' AND pol.effective_at<=$1 ORDER BY pol.version DESC LIMIT 1`, [asOf],
  )).rows[0];
  const entitlements = groupGrowthRows((await client.query<StoredEntitlement & { userId: string }>(
    `SELECT /* directory-growth-entitlements */ ranked.user_id AS "userId",ranked.id,ranked.kind,ranked.scope_key AS "scopeKey",ranked.game_id AS "gameId",g.name AS "gameName",ranked.starts_at::text AS "startsAt",ranked.ends_at::text AS "endsAt",ranked.status,ranked.deposit_waived AS "depositWaived",ranked.deposit_allowance_cents::text AS "depositAllowanceCents",ranked.pricing_payload AS "pricingPayload"
     FROM (SELECT e.*,row_number() OVER(PARTITION BY user_id ORDER BY starts_at DESC,id DESC) AS row_no
       FROM zzsh_iam.membership_entitlement e WHERE user_id=ANY($1::text[])) ranked
     LEFT JOIN zzsh_supply.game g ON g.id=ranked.game_id
     WHERE ranked.row_no<=100 ORDER BY ranked.user_id,ranked.starts_at DESC,ranked.id DESC`, [ids],
  )).rows);
  const migrated = subjects.filter(subject => subject.migrated);
  const { readLegacyGrowthCoverageAssessments } = await import("./membership-growth-legacy-store");
  const legacy = await readLegacyGrowthCoverageAssessments(client, new Map(migrated.map(subject => [subject.userId, contributions.get(subject.userId) ?? []])), asOf);
  for (const subject of subjects) {
    const rows = contributions.get(subject.userId) ?? [];
    if (typeof subject.migrated !== "boolean" || subject.migrated && !legacy.has(subject.userId)) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Growth source proof is unavailable");
    const completeness = await readGrowthSourceCompleteness(client, subject.userId, rows, subject.sourceRef, legacy.get(subject.userId), asOf, { sourceRows: sources.get(subject.userId) ?? [], migrated: subject.migrated });
    results.set(subject.userId, projectMembershipGrowth(subject.userId, rows, subject.normalTier ? subject : null, completeness, policy, entitlements.get(subject.userId) ?? [], asOf));
  }
  return results;
}

export type GrowthConsumptionQuery = { scope: "LIFETIME" | "ROLLING"; limit: number; cursor?: string };
export type GrowthConsumptionPage = {
  contractVersion: "membership-growth.consumption.v1"; subjectId: string; scope: GrowthConsumptionQuery["scope"];
  asOfUtc: string; windowStartUtc: string; snapshotVersion: string; knowledge: GrowthKnowledge; sourceState: GrowthSourceState;
  amountCents: string | null; points: string | null; total: number | null; nextCursor: string | null;
  sourceSummary: GrowthReaderResponse["sourceSummary"];
  items: Array<{ id: string; label: string; amountCents: string; effectiveAt: string; recordedAt: string; expiresAt: string; withinWindow: boolean; corrected: boolean; revision: number }>;
};

export function parseGrowthConsumptionQuery(query: URLSearchParams): GrowthConsumptionQuery {
  if ([...query.keys()].some((key) => !["scope", "limit", "cursor"].includes(key) || query.getAll(key).length !== 1)) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Growth detail query is invalid");
  const scope = query.get("scope") ?? "LIFETIME", limit = query.get("limit") ?? "20", cursor = query.get("cursor");
  if (!["LIFETIME", "ROLLING"].includes(scope) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50 || cursor !== null && (cursor.length === 0 || cursor.length > 4096)) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Growth detail query is invalid");
  return { scope: scope as GrowthConsumptionQuery["scope"], limit: Number(limit), ...(cursor === null ? {} : { cursor }) };
}

export async function readMembershipGrowthConsumption(client: PoolClient, userId: string, input: GrowthConsumptionQuery, nowUtc = new Date().toISOString()): Promise<GrowthConsumptionPage | null> {
  const normalized = parseGrowthConsumptionQuery(new URLSearchParams({ scope: input.scope, limit: String(input.limit), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }));
  const subject = createHash("sha256").update(userId).digest("hex");
  let cursor: { v: number; subject: string; scope: string; at: string; snapshot: string; after: string } | null = null;
  let asOfUtc = normalizeGrowthInstant(nowUtc, "nowUtc");
  if (normalized.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(normalized.cursor)) throw Error("cursor encoding");
      cursor = JSON.parse(Buffer.from(normalized.cursor, "base64url").toString("utf8"));
      if (!cursor || Object.keys(cursor).sort().join(",") !== "after,at,scope,snapshot,subject,v" || cursor.v !== 1 || cursor.subject !== subject || cursor.scope !== normalized.scope || !/^[a-f0-9]{64}$/.test(cursor.snapshot) || !/^growth_source_[a-f0-9]{48}$/.test(cursor.after)) throw Error("cursor");
      const at = normalizeGrowthInstant(cursor.at, "cursor.at");
      if (at !== cursor.at || at > asOfUtc) throw Error("cursor time");
      asOfUtc = at;
    } catch { throw new SecurityApiError(400, "INVALID_ARGUMENT", "Growth detail cursor is invalid"); }
  }
  const model = await readMembershipGrowthModel(client, userId, asOfUtc);
  if (!model) return null;
  const { response, rows } = model;
  const snapshotVersion = createHash("sha256").update(canonicalize({ schema: "growth-consumption-page-v1", subject, scope: normalized.scope, asOfUtc, sourceState: response.growth.sourceState, rows: rows.map((row) => ({ sourceKey: row.sourceKey, gameId: row.gameId, amountCents: row.amountCents, revision: row.revision, status: row.status, eligible: row.eligible, effectiveAt: row.effectiveAt, recordedAt: row.recordedAt, sourceDigest: row.sourceDigest ?? null, previousAmountCents: row.previousAmountCents ?? null, correctionOf: row.correctionOf ?? null, correctionMode: row.correctionMode ?? null })) })).digest("hex");
  if (cursor && cursor.snapshot !== snapshotVersion) throw new SecurityApiError(409, "CONFLICT", "Growth consumption source changed; reload the first page");
  const base = { contractVersion: "membership-growth.consumption.v1" as const, subjectId: userId, scope: normalized.scope, asOfUtc, windowStartUtc: response.growth.windowStartUtc, snapshotVersion, knowledge: response.growth.knowledge, sourceState: response.growth.sourceState, sourceSummary: response.sourceSummary };
  if (response.growth.knowledge !== "KNOWN") return { ...base, amountCents: null, points: null, total: null, nextCursor: null, items: [] };
  const sources = projectGrowthConsumptionSources({ userId, asOf: asOfUtc, contributions: rows }).filter((row) => normalized.scope === "LIFETIME" || row.withinWindow);
  const items = sources.map((row) => ({ id: "growth_source_" + createHash("sha256").update(userId + "\0" + row.sourceKey).digest("hex").slice(0, 48), label: row.corrected ? "消费更正后金额" : row.sourceType === "MATERIAL_CONSUMPTION" ? "物资消费" : row.sourceType === "MINIMUM_BILLING" ? "最低计费补足" : "租赁结算消费", amountCents: row.amountCents, effectiveAt: normalizeGrowthInstant(row.effectiveAt, "effectiveAt"), recordedAt: normalizeGrowthInstant(row.recordedAt, "recordedAt"), expiresAt: normalizeGrowthInstant(row.expiresAt, "expiresAt"), withinWindow: row.withinWindow, corrected: row.corrected, revision: row.revision })).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || a.id.localeCompare(b.id));
  const after = cursor ? items.findIndex((item) => item.id === cursor!.after) : -1;
  if (cursor && after < 0) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Growth detail cursor item is invalid");
  const page = items.slice(after + 1, after + 1 + normalized.limit), hasNext = after + 1 + page.length < items.length;
  const nextCursor = hasNext ? Buffer.from(JSON.stringify({ v: 1, subject, scope: normalized.scope, at: asOfUtc, snapshot: snapshotVersion, after: page.at(-1)!.id })).toString("base64url") : null;
  return { ...base, amountCents: sources.reduce((sum, row) => sum + BigInt(row.amountCents), 0n).toString(), points: normalized.scope === "LIFETIME" ? response.growth.lifetimePoints : response.growth.rollingPoints, total: items.length, nextCursor, items: page };
}

/** Canonical UTC instant with exactly six fractional digits (PG timestamptz microsecond precision). */
const CANONICAL_MICRO_INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

/**
 * Entitlement state at microsecond precision. Stored instants are normalized to the same fixed-width
 * canonical form, so lexicographic order equals time order. Mirrors entitlementStateAt without Date.parse truncation.
 */
export function entitlementStateAtMicro(entitlement: Pick<StoredEntitlement, "startsAt" | "endsAt" | "status">, asOfUtc: string): StoredEntitlement["status"] {
  // E-R3-02: the core entitlementStateAt now compares epoch microseconds; keep one implementation.
  return entitlementStateAt(entitlement, asOfUtc);
}

export type MembershipGrowthQuoteCandidatesInput = Parameters<MembershipGrowthConfirmationReader>[1] & { asOfUtc?: string };
export type MembershipGrowthQuoteCandidatesResult =
  | { knowledge: "KNOWN"; policyVersion: string; candidates: Array<{ plan: GrowthOfferPlan; quote: InternalQuote }>; entitlementIds: string[]; effectiveTier: Exclude<NonNullable<GrowthProjectionDto["effectiveTier"]>, "UNKNOWN">; policyTier: NonNullable<ReturnType<typeof policyTierForGrowthProjection>>; asOfUtc: string }
  | { knowledge: "UNKNOWN"; reason: string; asOfUtc?: string; entitlementId?: string };

/**
 * T personal-quote-v4 seam (membership-growth-consumption.md fdceac11…): one authoritative asOf for growth, grace,
 * entitlements and policy. Supported precision: asOf is microsecond (canonical 6 digits); entitlement/policy are evaluated
 * exactly at that microsecond, and (E-R3-02) so are growth facts, corrections, the 90-day window, grace and the shared
 * chooseCompleteOffer validity. Stored instants come from PG ::text at full microsecond precision; an input with more
 * than six fractional digits is AS_OF_INVALID / INVALID_INSTANT rather than truncated.
 * An applicable ACTIVE entitlement whose pricing is unusable is UNKNOWN, never silently dropped.
 */
export async function readMembershipGrowthQuoteCandidatesAt(client: PoolClient, input: MembershipGrowthQuoteCandidatesInput): Promise<MembershipGrowthQuoteCandidatesResult> {
  let asOfUtc: string;
  if (input.asOfUtc === undefined) asOfUtc = `${new Date().toISOString().slice(0, 23)}000Z`;
  else if (typeof input.asOfUtc !== "string" || !CANONICAL_MICRO_INSTANT.test(input.asOfUtc) || !Number.isFinite(Date.parse(input.asOfUtc))) return { knowledge: "UNKNOWN", reason: "AS_OF_INVALID" };
  else asOfUtc = input.asOfUtc;
  let model: Awaited<ReturnType<typeof readMembershipGrowthModel>>;
  try { model = await readMembershipGrowthModel(client, input.userId, asOfUtc); }
  catch (error) { if (error instanceof GrowthRuleError) return { knowledge: "UNKNOWN", reason: "GROWTH_UNKNOWN", asOfUtc }; throw error; }
  const growth = model?.response ?? null;
  if (!growth || growth.growth.knowledge !== "KNOWN" || !growth.growth.normalTier || !growth.growth.effectiveTier || !growth.growth.grace) return { knowledge: "UNKNOWN", reason: "GROWTH_UNKNOWN", asOfUtc };
  const rentalMode = input.quoteInput.conditions.rentalPricing?.rentalMode ?? "ordinary";
  // The sealed release decides which modes are spendable; a disabled mode is an explicit refusal, not a missing price.
  const enabledModes = sealedEnabledRentalModes(input.quoteInput.haffRule);
  if (enabledModes === null || !enabledModes.includes(rentalMode)) return { knowledge: "UNKNOWN", reason: "RENTAL_MODE_DISABLED", asOfUtc };
  // Same transaction, same asOf: the policy row the projection just read is the quote authority.
  const policyRow = model!.policy;
  if (!policyRow) return { knowledge: "UNKNOWN", reason: "POLICY_UNAVAILABLE", asOfUtc };
  const policy = policyRow.policyPayload as GrowthBenefitPolicy;
  const policyValidation = validateBenefitPolicy(policy, { enabledModes });
  if (!policyValidation.valid || !policyValidation.publishable) return { knowledge: "UNKNOWN", reason: "POLICY_NOT_PUBLISHABLE", asOfUtc };
  const effectiveTier = growth.growth.effectiveTier;
  const policyTier = policyTierForGrowthProjection({ normalTier: growth.growth.normalTier, effectiveTier, grace: growth.growth.grace });
  if (!policyTier || effectiveTier === "UNKNOWN") return { knowledge: "UNKNOWN", reason: "EFFECTIVE_TIER_UNKNOWN", asOfUtc };
  const tier = policy.tiers[policyTier];
  const growthContract = tier?.pricing?.[rentalMode];
  if (!configuredModeContract(growthContract)) return { knowledge: "UNKNOWN", reason: "GROWTH_PRICE_UNAVAILABLE", asOfUtc };
  const binding: OfferBinding = { userId: input.userId, accountId: input.accountId, ownerUserId: input.ownerUserId, listingVersionId: input.listingVersionId, ruleReleaseId: input.ruleReleaseId, quantityDigest: input.quantityDigest };
  const growthCandidate = quoteCandidate(input.quoteInput, growthContract, "GROWTH", policyRow.version, binding, tier.tenantDeposit === "WAIVED", undefined, undefined, tier.depositAllowanceCents);
  if (!growthCandidate) return { knowledge: "UNKNOWN", reason: "GROWTH_QUOTE_UNAVAILABLE", asOfUtc };
  let rows: StoredQuoteEntitlement[];
  try {
    rows = (await client.query<StoredQuoteEntitlement>(`SELECT id, kind, scope_key AS "scopeKey", starts_at::text AS "startsAt", ends_at::text AS "endsAt", status, deposit_waived AS "depositWaived", deposit_allowance_cents::text AS "depositAllowanceCents", pricing_payload AS "pricingPayload" FROM zzsh_iam.membership_entitlement WHERE user_id=$1 AND game_id=$2 ORDER BY starts_at, id`, [input.userId, input.gameId])).rows.map(normalizeStoredEntitlement);
  } catch {
    return { knowledge: "UNKNOWN", reason: "ENTITLEMENT_READ_FAILED", asOfUtc };
  }
  const candidates: Array<{ plan: GrowthOfferPlan; quote: InternalQuote }> = [growthCandidate];
  const entitlementIds: string[] = [];
  for (const entitlement of rows) {
    const state = entitlementStateAtMicro(entitlement, asOfUtc);
    if (state !== "ACTIVE") continue; // proven expired / revoked / replaced / pending / not started: excluded normally
    if (entitlement.kind !== "FRIEND" && entitlement.kind !== "PRESTIGE") return { knowledge: "UNKNOWN", reason: "ENTITLEMENT_KIND_UNKNOWN", asOfUtc, entitlementId: entitlement.id };
    if (!configuredModeContract(entitlement.pricingPayload)) return { knowledge: "UNKNOWN", reason: "ENTITLEMENT_PRICE_UNAVAILABLE", asOfUtc, entitlementId: entitlement.id };
    const candidate = quoteCandidate(input.quoteInput, entitlement.pricingPayload, entitlement.kind, policyRow.version, binding, entitlement.depositWaived, entitlement.id, entitlement.endsAt, entitlement.depositAllowanceCents ?? undefined);
    if (!candidate) return { knowledge: "UNKNOWN", reason: "ENTITLEMENT_QUOTE_UNAVAILABLE", asOfUtc, entitlementId: entitlement.id };
    candidates.push(candidate);
    entitlementIds.push(entitlement.id);
  }
  return { knowledge: "KNOWN", policyVersion: policyRow.version, candidates, entitlementIds, effectiveTier, policyTier, asOfUtc };
}

export const readMembershipGrowthQuoteCandidates: MembershipGrowthConfirmationReader = readMembershipGrowthQuoteCandidatesAt;

export function projectScopeDetail(rows: readonly StoredContribution[], gameIds: readonly string[]): { gameId: string; sourceKey: string; amountCents: string; effectiveAt: string }[] {
  const allowed = new Set(gameIds);
  return rows.filter((row) => allowed.has(row.gameId)).map((row) => ({ gameId: row.gameId, sourceKey: row.sourceKey, amountCents: row.amountCents, effectiveAt: row.effectiveAt }));
}

export async function readMembershipGrowthScopeDetail(client: PoolClient, userId: string, gameIds: readonly string[]): Promise<{
  subjectId: string;
  authorizationState: "DETAIL_ONLY";
  scopeDetails: ReturnType<typeof projectScopeDetail>;
}> {
  const rows = (await client.query<StoredContribution>(
    `SELECT user_id AS "userId", game_id AS "gameId", source_key AS "sourceKey", source_type AS "sourceType", source_id AS "sourceId",
            settlement_version AS "settlementVersion", effective_at::text AS "effectiveAt", recorded_at::text AS "recordedAt", amount_cents::text AS "amountCents",
            state AS status, eligible, revision, previous_amount_cents::text AS "previousAmountCents",
            correction_of_source_key AS "correctionOf", correction_mode AS "correctionMode", source_digest AS "sourceDigest"
       FROM zzsh_iam.membership_growth_contribution
      WHERE user_id=$1 AND game_id = ANY($2::text[])
      ORDER BY effective_at, source_key, revision`, [userId, [...gameIds]],
  )).rows.map(normalizeStoredContribution);
  return { subjectId: userId, authorizationState: "DETAIL_ONLY", scopeDetails: projectScopeDetail(rows, gameIds) };
}



