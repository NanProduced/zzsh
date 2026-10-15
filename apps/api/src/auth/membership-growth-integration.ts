import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { readAdminGameScope, scopeAllowsGame } from "./admin-scope";

import {
  contributionFromSettlement,
  entitlementStateAt,
  GROWTH_THRESHOLDS,
  NORMAL_GROWTH_TIERS,
  quoteToGrowthOfferPlan,
  replayGrowthProjection,
  validateBenefitPolicy,
  type ExistingEntitlement,
  type GrowthContribution,
  type GrowthBenefitPolicy,
  type GrowthOfferPlan,
  type HaffPricingParameter,
  type MaterialPricingParameter,
  type NormalGrowthTier,
  type OfferBinding,
  type GrowthPricingContract,
  type GrowthProjection,
  type SettledContributionFact,
} from "./membership-growth";
import { computeDeltaQuote, type InternalQuote, type PricingLineInput, type QuoteInput } from "../supply/pricing";
import { canonicalize, normalizeTime } from "../supply/content-hash";
import { decimalToBigInt, parseNonNegativeDecimal } from "../supply/decimal";
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

export async function readGrowthSourceCompleteness(client: PoolClient, userId: string, contributions: readonly CompletenessContribution[], registrationSourceRef: string | null): Promise<GrowthSourceCompleteness> {
  const sourceRows = (await client.query<StoredSettlementSource>(
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
  const provenance = (await client.query<{ migrated: boolean }>(
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
  for (const row of contributions) if (row.status !== "PENDING" && !expectedSet.has(row.sourceKey) && !(row.correctionOf && expectedSet.has(row.correctionOf))) conflicts.push(row.sourceKey);
  if (conflicts.length > 0) return { ...assessed, state: "SOURCE_CONFLICT", reasons: [...(assessed.reasons ?? []), ...[...new Set(conflicts)].map((sourceKey) => `CONTRIBUTION_BINDING_INVALID:${sourceKey}`)] };
  // Native settlements cannot prove the migrated subject's earlier growth history.
  return provenance.migrated ? { ...assessed, state: "BACKFILL_PENDING", reasons: [...(assessed.reasons ?? []), "MIGRATED_SOURCE_NOT_PROVED"] } : assessed;
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
  startsAtUtc: string;
  endsAtUtc: string;
  status: ExistingEntitlement["status"];
  label: string;
  depositWaived: boolean;
};

export type GrowthReaderResponse = {
  subjectId: string;
  growth: GrowthProjectionDto;
  entitlements: GrowthEntitlementSummary[];
  sourceSummary: { contributionCount: number; pendingCount: number; excludedCount: number };
};

type StoredContribution = GrowthContribution & { gameId: string; sourceDigest?: string | null };
type StoredEntitlement = { id: string; kind: "FRIEND" | "PRESTIGE"; scopeKey: string; startsAt: string; endsAt: string; status: ExistingEntitlement["status"]; depositWaived: boolean };
type StoredQuoteEntitlement = StoredEntitlement & { pricingPayload: unknown };
type StoredGrowthState = { normalTier: string; effectiveTier: string; blackGoldState: string; lastTierDropAt: string | null };

function normalizeStoredEntitlement<T extends StoredEntitlement>(row: T): T {
  return { ...row, startsAt: normalizeGrowthInstant(row.startsAt, "startsAt"), endsAt: normalizeGrowthInstant(row.endsAt, "endsAt") };
}
function normalizeStoredContribution(row: StoredContribution): StoredContribution {
  return { ...row, revision: Number(row.revision), effectiveAt: normalizeGrowthInstant(row.effectiveAt, "effectiveAt"), recordedAt: normalizeGrowthInstant(row.recordedAt, "recordedAt") };
}

function configuredPricing(value: unknown): value is GrowthPricingContract {
  return isObject(value) && value.status !== "NOT_PRICED" && typeof value.mode === "string" && typeof value.priceVersionId === "string" && isObject(value.haff) && value.haff.status === "CONFIGURED" && isObject(value.materials);
}

function configuredHaff(value: unknown): value is Exclude<HaffPricingParameter, { status: "NOT_PRICED" }> {
  return isObject(value) && value.status === "CONFIGURED" && value.kind === "HAFF_RATIO" && typeof value.priceVersionId === "string" && typeof value.costBasisRef === "string" && isObject(value.baseBySafeBox);
}

function configuredMaterial(value: unknown): value is Exclude<MaterialPricingParameter, { status: "NOT_PRICED" }> {
  return isObject(value) && value.status === "CONFIGURED" && value.kind === "FIXED_UNIT" && typeof value.itemId === "string" && typeof value.unit === "string" && typeof value.unitQuantity === "string" && typeof value.buyerUnitAmount === "string" && typeof value.ownerUnitAmount === "string";
}

function quoteInputForGrowth(base: QuoteInput, contract: GrowthPricingContract, depositWaived: boolean): QuoteInput | null {
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
  return { ...base, customerTier: "STANDARD", lines, haffRule, deposits: { ...base.deposits, ...(depositWaived ? { tenantDepositCents: "0" } : {}) } };
}

function quoteCandidate(base: QuoteInput, contract: GrowthPricingContract, source: GrowthOfferPlan["source"], benefitVersion: string, binding: OfferBinding, depositWaived: boolean, entitlementId?: string, validUntil?: string): { plan: GrowthOfferPlan; quote: InternalQuote } | null {
  const input = quoteInputForGrowth(base, contract, depositWaived);
  if (!input) return null;
  const result = computeDeltaQuote(input);
  if (!result.quotable) return null;
  return { quote: result.quote, plan: quoteToGrowthOfferPlan(result.quote, { source, benefitVersion, binding, ...(entitlementId ? { entitlementId } : {}), ...(validUntil ? { validUntil } : {}) }) };
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

function configuredModes(config: Record<string, unknown> | undefined): number {
  const pricing = isObject(config?.pricing) ? config.pricing : null;
  if (!pricing) return 0;
  return ["ordinary", "custom", "fast"].filter((mode) => {
    const contract = pricing[mode];
    if (!isObject(contract) || contract.status === "NOT_PRICED") return false;
    const haff = contract.haff;
    return isObject(haff) && haff.status !== "NOT_PRICED";
  }).length;
}

function policySummaries(policyPayload: Record<string, unknown> | null, policyVersion: string | null, tier: GrowthProjection["normalTier"] | null, benefitsState: GrowthBenefitsState): { benefits: GrowthBenefitSummary[]; comparison: GrowthComparison[] } {
  if (!policyPayload || benefitsState !== "CONFIGURED") return { benefits: [{ label: "成长权益", value: "尚未发布" }], comparison: [] };
  const tiers = isObject(policyPayload.tiers) ? policyPayload.tiers : {};
  const current = tier && isObject(tiers[tier]) ? tiers[tier] : undefined;
  const deposit = current?.tenantDeposit === "WAIVED" ? "免租客押金" : "租客押金按账号条件缴纳";
  const modeCount = configuredModes(current);
  const benefits = [
    { label: "租客押金", value: deposit, ...(policyVersion ? { sourceVersion: policyVersion } : {}) },
    { label: "租赁价格", value: modeCount === 3 ? "按完整报价择优" : "价格方案暂不可用", ...(policyVersion ? { sourceVersion: policyVersion } : {}) },
  ];
  const comparison = NORMAL_GROWTH_TIERS.map((candidate) => {
    const item = isObject(tiers[candidate]) ? tiers[candidate] : undefined;
    const modes = configuredModes(item);
    return { tier: tierLabel(candidate), deposit: item?.tenantDeposit === "WAIVED" ? "免租客押金" : "租客押金按账号条件缴纳", pricing: modes === 3 ? "完整方案可比价" : "价格方案未就绪" };
  });
  return { benefits, comparison };
}

function contributionSummaries(projection: GrowthProjection, rows: readonly StoredContribution[]): GrowthContributionSummary[] {
  const active = new Map(projection.active.map((item) => [item.sourceKey, item]));
  return rows.filter((row) => active.has(row.sourceKey)).map((row) => {
    const item = active.get(row.sourceKey)!;
    const correction = row.sourceType === "REFUND_CORRECTION";
    return { label: correction ? "消费更正" : row.sourceType === "MATERIAL_CONSUMPTION" ? "物资消费" : "租赁结算消费", effectiveAt: row.effectiveAt, amountCents: row.amountCents, exitsAt: item.expiresAt, kind: correction ? "CORRECTION" : "CONSUMPTION" };
  });
}

export function policyTierForGrowthProjection(projection: Pick<GrowthProjection, "effectiveTier" | "normalTier" | "grace">): NormalGrowthTier | null {
  if (projection.effectiveTier === "BLACK_GOLD") return "DIAMOND";
  if (projection.grace.state === "ACTIVE" && projection.grace.fromTier) return projection.grace.fromTier;
  return projection.effectiveTier !== "UNKNOWN" ? projection.effectiveTier : null;
}

function dtoFromProjection(projection: GrowthProjection | null, asOfUtc: string, benefitsState: GrowthBenefitsState, sourceState: GrowthSourceState, known: boolean, policyPayload: Record<string, unknown> | null, policyVersion: string | null, rows: readonly StoredContribution[]): GrowthProjectionDto {
  if (!projection || !known) {
    const windowStartUtc = new Date(Date.parse(asOfUtc) - 90 * 24 * 60 * 60 * 1000).toISOString();
    return { schema: "membership-growth-v1", knowledge: "UNKNOWN", sourceState, benefitsState, asOfUtc, windowStartUtc, rollingPoints: null, lifetimePoints: null, normalTier: null, effectiveTier: null, blackGold: null, grace: null, nextExpiryAtUtc: null, nextTier: null, benefits: [], comparison: [], contributions: [], pendingCount: projection?.pending.length ?? 0, pending: projection?.pending ?? [], excluded: projection?.excluded ?? [] };
  }
  const summaries = policySummaries(policyPayload, policyVersion, policyTierForGrowthProjection(projection), benefitsState);
  return { schema: "membership-growth-v1", knowledge: "KNOWN", sourceState, benefitsState, asOfUtc: projection.asOf, windowStartUtc: projection.windowStart, rollingPoints: projection.rollingPoints, lifetimePoints: projection.lifetimePoints, normalTier: projection.normalTier, effectiveTier: projection.effectiveTier, blackGold: projection.blackGold, grace: projection.grace, nextExpiryAtUtc: projection.nextExpiryAt, nextTier: nextTierFor(projection), benefits: summaries.benefits, comparison: summaries.comparison, contributions: contributionSummaries(projection, rows), pendingCount: projection.pending.length, pending: projection.pending, excluded: projection.excluded };
}

export async function readMembershipGrowth(client: PoolClient, userId: string, asOfUtc = new Date().toISOString()): Promise<GrowthReaderResponse | null> {
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
    storedState = (await client.query<StoredGrowthState>(`SELECT normal_tier AS "normalTier", effective_tier AS "effectiveTier", black_gold_state AS "blackGoldState", last_tier_drop_at AS "lastTierDropAt" FROM zzsh_iam.membership_growth_state WHERE user_id=$1`, [userId])).rows[0] ?? null;
  } catch {
    storedState = null;
  }
  const previousTier = storedState && (NORMAL_GROWTH_TIERS as readonly string[]).includes(storedState.normalTier) ? storedState.normalTier as GrowthProjection["normalTier"] : undefined;
  const projection = replayGrowthProjection({
    userId,
    asOf: asOfUtc,
    contributions: rows,
    ...(previousTier ? { previousTier } : {}),
    ...(storedState?.lastTierDropAt ? { lastTierDropAt: storedState.lastTierDropAt } : {}),
    ...(storedState && (storedState.effectiveTier === "BLACK_GOLD" || storedState.blackGoldState === "QUALIFIED" || storedState.blackGoldState === "REVIEW_REQUIRED") ? { existingBlackGold: true } : {}),
  });
  let completeness: GrowthSourceCompleteness | null = null;
  try {
    completeness = await readGrowthSourceCompleteness(client, userId, rows, oldMembership?.sourceRef ?? null);
  } catch {
    completeness = null;
  }
  const projectionKnown = completeness?.state === "COMPLETE" && projection.effectiveTier !== "UNKNOWN";
  const sourceState: GrowthSourceState = completeness === null ? "READ_FAILED" : completeness.state;
  const policy = (await client.query<{ id: string; version: string; policyPayload: Record<string, unknown> }>(`SELECT id, version::text AS version, policy_payload AS "policyPayload" FROM zzsh_iam.membership_growth_policy WHERE status='APPROVED' AND effective_at <= $1 ORDER BY version DESC LIMIT 1`, [asOfUtc])).rows[0];
  const entitlements = (await client.query<StoredEntitlement>(
    `SELECT id, kind, scope_key AS "scopeKey", starts_at::text AS "startsAt", ends_at::text AS "endsAt", status, deposit_waived AS "depositWaived"
       FROM zzsh_iam.membership_entitlement WHERE user_id=$1 ORDER BY starts_at DESC, id DESC LIMIT 100`, [userId],
  )).rows.map(normalizeStoredEntitlement).map((item) => ({ id: item.id, kind: item.kind, scopeKey: item.scopeKey, startsAtUtc: item.startsAt, endsAtUtc: item.endsAt, status: entitlementStateAt(item, asOfUtc), label: item.kind === "FRIEND" ? "挚友礼遇" : "尊享礼遇", depositWaived: item.depositWaived }));
  return { subjectId: userId, growth: dtoFromProjection(projection, asOfUtc, policy ? "CONFIGURED" : "NOT_CONFIGURED", sourceState, projectionKnown, policy?.policyPayload ?? null, policy?.version ?? null, rows), entitlements, sourceSummary: { contributionCount: rows.length, pendingCount: projection.pending.length, excludedCount: projection.excluded.length } };
}

export const readMembershipGrowthQuoteCandidates: MembershipGrowthConfirmationReader = async (client, input) => {
  const asOfUtc = new Date().toISOString();
  const growth = await readMembershipGrowth(client, input.userId, asOfUtc);
  if (!growth || growth.growth.knowledge !== "KNOWN" || !growth.growth.normalTier) return { knowledge: "UNKNOWN", reason: "GROWTH_UNKNOWN" };
  const policyRow = (await client.query<{ version: string; policyPayload: GrowthBenefitPolicy }>(`SELECT version::text AS version, policy_payload AS "policyPayload" FROM zzsh_iam.membership_growth_policy WHERE status='APPROVED' AND effective_at <= $1 ORDER BY version DESC LIMIT 1`, [asOfUtc])).rows[0];
  if (!policyRow) return { knowledge: "UNKNOWN", reason: "POLICY_UNAVAILABLE" };
  const policy = policyRow.policyPayload;
  const policyValidation = validateBenefitPolicy(policy);
  if (!policyValidation.valid || !policyValidation.publishable) return { knowledge: "UNKNOWN", reason: "POLICY_NOT_PUBLISHABLE" };
  const policyTier = policyTierForGrowthProjection({ normalTier: growth.growth.normalTier!, effectiveTier: growth.growth.effectiveTier!, grace: growth.growth.grace! });
  if (!policyTier) return { knowledge: "UNKNOWN", reason: "EFFECTIVE_TIER_UNKNOWN" };
  const tier = policy.tiers[policyTier];
  const rentalMode = input.quoteInput.conditions.rentalPricing?.rentalMode ?? "ordinary";
  const growthContract = tier?.pricing?.[rentalMode];
  if (!configuredPricing(growthContract)) return { knowledge: "UNKNOWN", reason: "GROWTH_PRICE_UNAVAILABLE" };
  const binding: OfferBinding = {
    userId: input.userId,
    accountId: input.accountId,
    ownerUserId: input.ownerUserId,
    listingVersionId: input.listingVersionId,
    ruleReleaseId: input.ruleReleaseId,
    quantityDigest: input.quantityDigest,
  };
  const growthCandidate = quoteCandidate(input.quoteInput, growthContract, "GROWTH", policyRow.version, binding, tier.tenantDeposit === "WAIVED");
  if (!growthCandidate) return { knowledge: "UNKNOWN", reason: "GROWTH_QUOTE_UNAVAILABLE" };
  const rows = (await client.query<StoredQuoteEntitlement>(`SELECT id, kind, scope_key AS "scopeKey", starts_at::text AS "startsAt", ends_at::text AS "endsAt", status, deposit_waived AS "depositWaived", pricing_payload AS "pricingPayload" FROM zzsh_iam.membership_entitlement WHERE user_id=$1 AND game_id=$2 ORDER BY starts_at, id`, [input.userId, input.gameId])).rows.map(normalizeStoredEntitlement);
  const candidates: Array<{ plan: GrowthOfferPlan; quote: InternalQuote }> = [growthCandidate];
  const entitlementIds: string[] = [];
  for (const entitlement of rows) {
    if (entitlementStateAt(entitlement, asOfUtc) !== "ACTIVE" || (entitlement.kind !== "FRIEND" && entitlement.kind !== "PRESTIGE") || !configuredPricing(entitlement.pricingPayload)) continue;
    const candidate = quoteCandidate(input.quoteInput, entitlement.pricingPayload, entitlement.kind, policyRow.version, binding, entitlement.depositWaived, entitlement.id, entitlement.endsAt);
    if (candidate) {
      candidates.push(candidate);
      entitlementIds.push(entitlement.id);
    }
  }
  return { knowledge: "KNOWN", policyVersion: policyRow.version, candidates, entitlementIds };
};

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



