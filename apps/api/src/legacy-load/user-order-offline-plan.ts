/** Offline PLAN_ONLY prep for legacy users, accounts, and order reads. No target SQL. */

import { createHash } from "node:crypto";
import { legacyEpochTimestamp, legacyMoneyCents, normalizeLegacyOrderReadInput, type LegacyOrderReadInput } from "../order/legacy-order-read";
import { GAME_SERVICE } from "../supply/game-services";
import { parseLegacyReadSnapshot, type LegacyReadSnapshot } from "../supply/legacy-listing-read";
import { normalizeLegacyObservationInput, type LegacyObservationInput } from "../supply/legacy-observation";
import { legacyOwnerEvidenceDigest, legacyOwnerUserId, normalizeLegacyOwnerInput, type LegacyOwnerEvidence, type LegacyOwnerMigrationInput } from "../supply/legacy-user-migration";
import { legacyAccountId, type LegacyAccountCreationInput } from "./legacy-account-seam";

export const USER_ORDER_PLAN_MODE = "PLAN_ONLY" as const;
const DIGEST = /^[a-f0-9]{64}$/;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Source flags are only 0 or 1. Anything else is not silently treated as active. */
export function binaryFlag(value: unknown, name: string): boolean {
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  throw new Error(`FLAG_NOT_BINARY:${name}`);
}

export type ProjectedIdentity = {
  accountStatus: "CANCELLED" | "DEACTIVATED" | "ACTIVE";
  identityStatus: "VERIFIED" | "UNVERIFIED";
  ageStatus: "ADULT" | "MINOR" | "UNKNOWN";
  phoneNumberVerified: false;
  loginProven: false;
  tradingProven: false;
  identityMeaning: "inherited-source-fact";
};

/** Mirrors derivedStatusValues. Deleted wins. This does not prove a login or a trade. */
export function projectIdentityStatus(status: { deleted: boolean; disabled: boolean; realNameBound: boolean; ageAdult: boolean | null }): ProjectedIdentity {
  return {
    accountStatus: status.deleted ? "CANCELLED" : status.disabled ? "DEACTIVATED" : "ACTIVE",
    identityStatus: status.realNameBound ? "VERIFIED" : "UNVERIFIED",
    ageStatus: status.ageAdult === true ? "ADULT" : status.ageAdult === false ? "MINOR" : "UNKNOWN",
    phoneNumberVerified: false,
    loginProven: false,
    tradingProven: false,
    identityMeaning: "inherited-source-fact",
  };
}

export type UserSourceRow = {
  id: string;
  mobile: string;
  nickname: string;
  is_delete: unknown;
  is_disable: unknown;
  is_bind_id: unknown;
  is_high_risk?: unknown;
  ageAdult: boolean | null;
  createTime?: unknown;
  updateTime?: unknown;
  sourceDigest: string;
  evidenceRef: string;
  legacyPassword?: LegacyOwnerEvidence["legacyPassword"];
};

/** 0 and empty epoch become null. Digit strings use legacyEpochTimestamp. Any other string is left for normalizeTimestamp. */
function sourceTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === 0 || value === "0") return null;
  if (value === "") throw new Error("TIME_INVALID");
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("TIME_INVALID");
    return legacyEpochTimestamp(String(value));
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return legacyEpochTimestamp(value);
  if (typeof value !== "string") throw new Error("TIME_INVALID");
  return value;
}

export function planLegacyUser(row: UserSourceRow, seenMobiles: ReadonlySet<string>) {
  let flags;
  try {
    flags = {
      deleted: binaryFlag(row.is_delete, "is_delete"),
      disabled: binaryFlag(row.is_disable, "is_disable"),
      realNameBound: binaryFlag(row.is_bind_id, "is_bind_id"),
      // Absent key = column not in the frozen extract. It is not read as 0.
      highRisk: Object.prototype.hasOwnProperty.call(row, "is_high_risk") ? binaryFlag(row.is_high_risk, "is_high_risk") : null,
    };
  } catch (error) {
    return { parameterReady: false as const, disposition: "ISOLATED" as const, reason: error instanceof Error ? error.message : "FLAG_NOT_BINARY", writeAllowed: false as const, writes: 0 };
  }
  let evidence: LegacyOwnerEvidence;
  try {
    evidence = {
    sourceSystem: "legacy_mysql_restore",
    sourceEntity: "la_user",
    legacyId: row.id,
    sourceDigest: row.sourceDigest,
    evidenceRef: row.evidenceRef,
    nickname: row.nickname,
    mobile: row.mobile,
    sourceCreatedAt: sourceTimestamp(row.createTime),
    sourceUpdatedAt: sourceTimestamp(row.updateTime),
    status: { realNameBound: flags.realNameBound, ageAdult: row.ageAdult, disabled: flags.disabled, deleted: flags.deleted },
    legacyPassword: row.legacyPassword ?? null,
    };
  } catch (error) {
    return { parameterReady: false as const, disposition: "ISOLATED" as const, reason: error instanceof Error ? error.message : "TIME_INVALID", writeAllowed: false as const, writes: 0 };
  }
  try {
    const evidenceDigest = legacyOwnerEvidenceDigest(evidence);
    const writerInput: LegacyOwnerMigrationInput = { evidence, evidenceDigest };
    const normalized = normalizeLegacyOwnerInput(writerInput);
    const canonicalMobile = normalized.evidence.mobile;
    if (seenMobiles.has(canonicalMobile)) return { parameterReady: false, disposition: "ISOLATED" as const, reason: "MOBILE_DUPLICATE", writeAllowed: false as const, writes: 0 };
    // Not writer-ready, but the row still holds its phone so the winner stays the smallest source id.
    if (flags.highRisk === null) return { parameterReady: false, disposition: "ISOLATED" as const, reason: "FIELD_NOT_EXTRACTED:is_high_risk", claimedMobile: canonicalMobile, writeAllowed: false as const, writes: 0 };
    const projected = projectIdentityStatus(normalized.evidence.status);
    const blockers = ["TRADING_ADMISSION_NOT_DECIDED", ...(flags.highRisk ? ["HIGH_RISK_RETAINED"] : [])];
    return {
      parameterReady: true,
      disposition: "PARAMETER_READY" as const,
      mode: USER_ORDER_PLAN_MODE,
      writeAllowed: false as const,
      writes: 0,
      blockers,
      userId: legacyOwnerUserId(evidence.sourceSystem, evidence.sourceEntity, evidence.legacyId),
      writerInput: normalized,
      projected,
      passwordInvented: false,
      legacyPasswordPresent: normalized.evidence.legacyPassword !== null,
      risk: { retained: true, source: "la_user.is_high_risk", value: flags.highRisk, tradingRestriction: "PENDING_DECISION" as const, creditScoreDelta: null },
    };
  } catch (error) {
    return { parameterReady: false as const, disposition: "ISOLATED" as const, reason: error instanceof Error ? error.message : "INVALID", writeAllowed: false as const, writes: 0 };
  }
}

function sourceKey(id: string) {
  if (!/^(0|[1-9]\d*)$/.test(id)) throw new Error("SOURCE_KEY_INVALID");
  return BigInt(id);
}

/** seenMobiles is a read-only committed index. planned exists only for this call and is not written back. */
export function planLegacyUserBatch(rows: readonly UserSourceRow[], seenMobiles: ReadonlySet<string> = new Set()) {
  const planned = new Set(seenMobiles);
  const ordered = [...rows].sort((left, right) => {
    const a = sourceKey(left.id);
    const b = sourceKey(right.id);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const results = ordered.map(row => {
    const item = planLegacyUser(row, planned);
    if (item.disposition === "PARAMETER_READY") planned.add(item.writerInput.evidence.mobile);
    else if ("claimedMobile" in item && typeof item.claimedMobile === "string") planned.add(item.claimedMobile);
    return item;
  });
  return { mode: USER_ORDER_PLAN_MODE, writes: 0, parameterReady: results.filter(item => item.parameterReady).length, isolated: results.filter(item => item.disposition === "ISOLATED").length, results };
}

export function publicUserPlan(planned: ReturnType<typeof planLegacyUser>) {
  if (planned.disposition !== "PARAMETER_READY") return { parameterReady: false, disposition: planned.disposition, reason: "reason" in planned ? planned.reason : null, writeAllowed: false as const, writes: 0 };
  return {
    parameterReady: true,
    disposition: planned.disposition,
    writeAllowed: false as const,
    writes: 0,
    userId: planned.userId,
    evidenceRef: planned.writerInput.evidence.evidenceRef,
    evidenceDigest: planned.writerInput.evidenceDigest,
    legacyPasswordPresent: planned.legacyPasswordPresent,
    blockers: planned.blockers,
  };
}

export type OrderDependency = { ownerUserId?: string; renterUserId?: string; accountId?: string; gameId?: string };
export function planLegacyOrder(input: LegacyOrderReadInput | null, dependency: OrderDependency) {
  const keys = ["ownerUserId", "renterUserId", "accountId", "gameId"] as const;
  const missing = keys.filter(key => !dependency[key]);
  if (!input || missing.length > 0) return { parameterReady: false, disposition: "PENDING_DEPENDENCY" as const, missing, existence: "NOT_CHECKED" as const, writeAllowed: false as const, writes: 0, snapshot: false };
  let normalized;
  try { normalized = normalizeLegacyOrderReadInput(input); } catch {
    return { parameterReady: false, disposition: "ISOLATED" as const, reason: "SOURCE_REJECTED" as const, existence: "NOT_CHECKED" as const, writeAllowed: false as const, writes: 0, snapshot: false };
  }
  const expected = { ownerUserId: input.owner.userId, renterUserId: input.renter.userId, accountId: input.account.accountId, gameId: input.account.gameId };
  const conflicts = keys.filter(key => dependency[key] !== expected[key]);
  if (conflicts.length > 0) return { parameterReady: false, disposition: "ISOLATED" as const, reason: "DEPENDENCY_CONFLICT" as const, conflicts, existence: "NOT_CHECKED" as const, writeAllowed: false as const, writes: 0, snapshot: false };
  const sourceStatus = input.source.row.order_status ?? "";
  const paid = input.source.row.pay_is === "1";
  return {
    parameterReady: true,
    disposition: "PARAMETER_READY" as const,
    mode: USER_ORDER_PLAN_MODE,
    writeAllowed: false as const,
    writes: 0,
    existence: "NOT_CHECKED" as const,
    tradingAdmission: "NOT_DECIDED" as const,
    snapshot: true,
    writerInput: input,
    dependencyDigests: { owner: input.owner.sourceDigest, renter: input.renter.sourceDigest, account: input.account.sourceDigest },
    orderId: normalized.id,
    originalOrderNo: input.source.row.order_sn,
    dueCents: normalized.dueCents,
    paidCents: normalized.paidCents,
    depositCents: normalized.depositCents,
    refundCents: legacyMoneyCents(input.source.row.return_order_money),
    refundChannelState: "UNKNOWN" as const,
    continuationEligible: false,
    readImportTarget: true,
    sourceStatus,
    inflightReadOnly: sourceStatus === "3" || sourceStatus === "8" || sourceStatus === "9",
    cancelledWithPaymentRecord: sourceStatus === "5" && paid,
  };
}

export function planBatchDigest(frozenBatchId: string, tuples: readonly (readonly [string, string])[]) {
  if (!DIGEST.test(frozenBatchId)) throw new Error("FROZEN_BATCH_REQUIRED");
  return sha256(JSON.stringify([frozenBatchId, tuples]));
}

const ACCOUNT_COLUMNS = ["id", "user_id", "game_id", "status", "is_delete", "no", "price_tenant", "extra_goods_total_price_tenant", "deposit_amount", "rental_days", "default_consume_type", "update_time"] as const;
const ACCOUNT_COLUMNS_WITH_PAYOUT = [...ACCOUNT_COLUMNS, "is_full_payout"] as const;
const YUAN = /^(0|[1-9]\d{0,13})\.\d{2}$/;
const DAY = /^[1-9]\d{0,17}$/;
const ACCOUNT_IF_ABSENT = { "zzsh_supply.rental_account:insert": 1, "zzsh_iam.audit_event": 1, "zzsh_supply.idempotency_record": 1 };
const OBSERVATION_IF_ABSENT = { "zzsh_supply.listing_version": 1, "zzsh_supply.legacy_supply_map": 1, "zzsh_supply.rental_account:update": 1, "zzsh_iam.audit_event": 1, "zzsh_supply.idempotency_record": 1 };
const SNAPSHOT_IF_ABSENT = { "zzsh_supply.legacy_listing_read_snapshot": 1, "zzsh_iam.audit_event": 1 };
const ORDER_IF_ABSENT = { "zzsh_order.legacy_order_read_snapshot": 1, "zzsh_iam.audit_event": 1, "zzsh_supply.idempotency_record": 1 };

function addWrites(sets: readonly Record<string, number>[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const set of sets) for (const [key, count] of Object.entries(set)) totals[key] = (totals[key] ?? 0) + count;
  return totals;
}

export type SourceChainGame = { sourceGameId: string; targetGameId: string | null; serviceCode: typeof GAME_SERVICE.ACCOUNT_RENTAL };
export type SourceChainOrder = {
  source: LegacyOrderReadInput["source"];
  account: { accountId?: string; gameId?: string; legacyId: string; businessNo: string | null; sourceDigest: string };
  owner: LegacyOrderReadInput["owner"];
  renter: LegacyOrderReadInput["renter"];
};
export type SourceChainInput = {
  owner: LegacyOwnerEvidence;
  renter: LegacyOwnerEvidence;
  account: { sourceDigest: string; evidenceRef: string; row: Record<string, string | null> };
  game: SourceChainGame;
  order: SourceChainOrder | null;
};

type ChainStep = {
  step: string;
  parameterReady: boolean;
  disposition: "PARAMETER_READY" | "PENDING_DEPENDENCY" | "ISOLATED";
  reason: string | null;
  writeAllowed: false;
  writes: 0;
  existence: "NOT_CHECKED";
  writer?: string;
  writerInput?: unknown;
  snapshotReady?: boolean;
  sourceStatus?: number;
  sourceStatusPublicCandidate?: boolean;
  userId?: string;
  legacyId?: string;
  sourceDigest?: string;
  accountId?: string;
  orderId?: string;
};

function chainStep(step: string, disposition: ChainStep["disposition"], reason: string | null, extra: Record<string, unknown> = {}): ChainStep {
  return { step, parameterReady: disposition === "PARAMETER_READY", disposition, reason, writeAllowed: false, writes: 0, existence: "NOT_CHECKED", ...extra };
}

function exactEvidence(value: LegacyOwnerEvidence): LegacyOwnerEvidence {
  return {
    sourceSystem: value.sourceSystem, sourceEntity: value.sourceEntity, legacyId: value.legacyId, sourceDigest: value.sourceDigest, evidenceRef: value.evidenceRef,
    nickname: value.nickname, mobile: value.mobile, sourceCreatedAt: value.sourceCreatedAt, sourceUpdatedAt: value.sourceUpdatedAt,
    status: { realNameBound: value.status.realNameBound, ageAdult: value.status.ageAdult, disabled: value.status.disabled, deleted: value.status.deleted },
    legacyPassword: value.legacyPassword ?? null,
  };
}

function readyOwner(role: string, value: LegacyOwnerEvidence): ChainStep & { userId?: string; legacyId?: string; sourceDigest?: string; evidenceDigest?: string } {
  try {
    const evidence = exactEvidence(value);
    if (evidence.sourceSystem !== "legacy_mysql_restore" || evidence.sourceEntity !== "la_user") return chainStep(role, "ISOLATED", "SOURCE_NOT_VERIFIED");
    const evidenceDigest = legacyOwnerEvidenceDigest(evidence);
    const writerInput = normalizeLegacyOwnerInput({ evidence, evidenceDigest });
    return chainStep(role, "PARAMETER_READY", null, {
      writer: "migrateLegacyOwner", userId: legacyOwnerUserId(evidence.sourceSystem, evidence.sourceEntity, evidence.legacyId),
      legacyId: evidence.legacyId, sourceDigest: evidence.sourceDigest, evidenceDigest, writerInput, phoneNumberVerified: false,
    });
  } catch (error) {
    return chainStep(role, "ISOLATED", error instanceof Error ? error.message : "INVALID");
  }
}

export function accountColumns(row: Record<string, string | null>): string | null {
  const keys = Object.keys(row).sort().join(",");
  const hasPayout = Object.hasOwn(row, "is_full_payout");
  if (keys !== [...(hasPayout ? ACCOUNT_COLUMNS_WITH_PAYOUT : ACCOUNT_COLUMNS)].sort().join(",")) return "ACCOUNT_ROW_UNSUPPORTED";
  if (ACCOUNT_COLUMNS.some(column => typeof row[column] !== "string")) return "ACCOUNT_COLUMN_MISSING";
  // Historical display keeps the old shape; formal takeover separately rejects missing or unverified payout facts.
  if (hasPayout && row.is_full_payout !== null && typeof row.is_full_payout !== "string") return "ACCOUNT_COLUMN_MISSING";
  return null;
}

export function listingSnapshot(row: Record<string, string | null>): { snapshot: LegacyReadSnapshot | null; sourceUpdatedAt: string | null; missing: string[] } {
  const missing: string[] = [];
  const take = (column: string, pattern: RegExp) => {
    const value = row[column];
    if (typeof value !== "string" || !pattern.test(value)) { missing.push(column); return null; }
    return value;
  };
  const resourceNo = take("no", /^[A-Za-z0-9_-]{1,64}$/);
  const haffRentYuan = take("price_tenant", YUAN);
  const goodsYuan = take("extra_goods_total_price_tenant", YUAN);
  const depositYuan = take("deposit_amount", YUAN);
  const termDays = take("rental_days", DAY);
  const consumeType = take("default_consume_type", /^[1-5]$/);
  const sourceUpdatedAt = legacyEpochTimestamp(row.update_time);
  if (!sourceUpdatedAt || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(sourceUpdatedAt)) missing.push("update_time");
  if (missing.length || !resourceNo || !haffRentYuan || !goodsYuan || !depositYuan || !termDays || !consumeType || !sourceUpdatedAt) return { snapshot: null, sourceUpdatedAt: null, missing };
  const snapshot = parseLegacyReadSnapshot({ schema: "legacy-listing-read-v1", resourceNo, haffRentYuan, goodsYuan, depositYuan, termDays, dailyHaffBase: (10n * BigInt(consumeType) * 1000000n).toString() });
  return { snapshot, sourceUpdatedAt, missing };
}

/** Parameter plan only. A supplied target id is not proof the row exists or matches. */
export function planSourceChain(input: SourceChainInput) {
  const owner = readyOwner("owner", input.owner);
  const renter = readyOwner("renter", input.renter);
  const samePerson = owner.disposition === "PARAMETER_READY" && renter.disposition === "PARAMETER_READY" && owner.userId === renter.userId;
  const renterStep = samePerson ? chainStep("renter", "ISOLATED", "OWNER_RENTER_NOT_DISTINCT") : renter;
  const usersReady = owner.disposition === "PARAMETER_READY" && renterStep.disposition === "PARAMETER_READY";
  const serviceOk = input.game.serviceCode === GAME_SERVICE.ACCOUNT_RENTAL;
  const targetGameId = input.game.targetGameId;
  const gameReady = serviceOk && typeof targetGameId === "string" && targetGameId.length > 0;
  const game = chainStep("game", !serviceOk ? "ISOLATED" : gameReady ? "PARAMETER_READY" : "PENDING_DEPENDENCY", !serviceOk ? "GAME_SERVICE_MISMATCH" : gameReady ? null : "TARGET_GAME_UNBOUND", {
    sourceGameId: input.game.sourceGameId, targetGameId: gameReady ? targetGameId : null, serviceCode: GAME_SERVICE.ACCOUNT_RENTAL, match: "NOT_CHECKED", sameSourceIdIsNotVerification: true,
  });
  const row = input.account.row;
  const columnError = accountColumns(row);
  let account = chainStep("account", "PENDING_DEPENDENCY", usersReady && gameReady ? null : "UPSTREAM_NOT_READY", { writer: "createLegacyOwnerRentalAccount" });
  let observation = chainStep("observation", "PENDING_DEPENDENCY", "UPSTREAM_NOT_READY", { writer: "recordLegacyObservation" });
  let map = chainStep("map", "PENDING_DEPENDENCY", "UPSTREAM_NOT_READY", { writer: "recordLegacyObservation", versionId: null });
  let readSnapshot = chainStep("readSnapshot", "PENDING_DEPENDENCY", "UPSTREAM_NOT_READY", { writer: "recordLegacyReadSnapshot", snapshotReady: false });
  let order = chainStep("order", "PENDING_DEPENDENCY", "UPSTREAM_NOT_READY", { writer: "importLegacyOrderRead" });
  const relations = { accountOwner: false, accountGame: false, orderAccount: false, orderOwner: false, orderRenter: false, orderDigests: false };
  if (columnError) account = chainStep("account", "ISOLATED", columnError, { writer: "createLegacyOwnerRentalAccount" });
  else if (row.is_delete !== "0" || !["0", "3", "4", "5"].includes(row.status ?? "")) account = chainStep("account", "ISOLATED", "ACCOUNT_STATUS_NOT_PUBLIC", { writer: "createLegacyOwnerRentalAccount" });
  else if (!DIGEST.test(input.account.sourceDigest) || !input.account.evidenceRef || input.account.evidenceRef.length > 512) account = chainStep("account", "ISOLATED", "ACCOUNT_DIGEST_REQUIRED", { writer: "createLegacyOwnerRentalAccount" });
  else if (usersReady && owner.legacyId !== row.user_id) account = chainStep("account", "ISOLATED", "ACCOUNT_OWNER_MISMATCH", { writer: "createLegacyOwnerRentalAccount" });
  else if (row.game_id !== input.game.sourceGameId) account = chainStep("account", "ISOLATED", "ACCOUNT_GAME_MISMATCH", { writer: "createLegacyOwnerRentalAccount" });
  else if (usersReady && gameReady && targetGameId) {
    relations.accountOwner = true;
    relations.accountGame = true;
    const accountId = legacyAccountId("legacy_mysql_restore", "la_rental_accounts", String(row.id));
    const writerInput: LegacyAccountCreationInput = {
      sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: String(row.id), sourceDigest: input.account.sourceDigest,
      evidenceRef: input.account.evidenceRef, owner: { legacyId: String(owner.legacyId), sourceDigest: String(owner.sourceDigest) }, gameId: targetGameId,
    };
    account = chainStep("account", "PARAMETER_READY", null, { writer: "createLegacyOwnerRentalAccount", accountId, legacyId: row.id, sourceDigest: input.account.sourceDigest, writerInput, sameSourceIdIsNotVerification: true });
    const observationInput: LegacyObservationInput = {
      sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: String(row.id), evidenceRef: input.account.evidenceRef, sourceDigest: input.account.sourceDigest, inventory: [],
    };
    const normalizedObservation = normalizeLegacyObservationInput(observationInput);
    observation = chainStep("observation", "PARAMETER_READY", null, {
      writer: "recordLegacyObservation", reviewState: "IMPORTED_UNVERIFIED", legacyHold: "UNRESOLVED", publication: false, rentable: false, skins: "PENDING_UNASSIGNED", declaration: false, writerInput: normalizedObservation,
    });
    map = chainStep("map", "PARAMETER_READY", null, {
      writer: "recordLegacyObservation", versionId: null, sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: row.id, accountId, sourceDigest: input.account.sourceDigest,
    });
    const built = listingSnapshot(row);
    if (!built.snapshot || !built.sourceUpdatedAt) {
      readSnapshot = chainStep("readSnapshot", "ISOLATED", "SNAPSHOT_INCOMPLETE", { writer: "recordLegacyReadSnapshot", snapshotReady: false, missing: built.missing });
    } else {
      readSnapshot = chainStep("readSnapshot", "PENDING_DEPENDENCY", "OBSERVATION_VERSION_ASSIGNED_AT_WRITE", {
        writer: "recordLegacyReadSnapshot", snapshotReady: true, observationVersionId: null, sourceStatus: Number(row.status), sourceDeleted: false, sourceStatusPublicCandidate: row.status === "3", reviewState: "IMPORTED_UNVERIFIED",
        writerInput: { observationVersionId: null, sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: row.id, sourceDigest: input.account.sourceDigest, sourceStatus: Number(row.status), sourceDeleted: false, sourceUpdatedAt: built.sourceUpdatedAt, evidenceRef: input.account.evidenceRef, snapshot: built.snapshot },
      });
    }
    const sourceOrder = input.order;
    if (!sourceOrder) order = chainStep("order", "PENDING_DEPENDENCY", "ORDER_MISSING", { writer: "importLegacyOrderRead" });
    else if (!built.snapshot) order = chainStep("order", "PENDING_DEPENDENCY", "SNAPSHOT_NOT_READY", { writer: "importLegacyOrderRead" });
    else {
      const digestMatch = sourceOrder.account.sourceDigest === input.account.sourceDigest && sourceOrder.owner.sourceDigest === owner.sourceDigest && sourceOrder.renter.sourceDigest === renterStep.sourceDigest;
      relations.orderAccount = sourceOrder.account.legacyId === row.id && sourceOrder.source.row.accounts_id === row.id;
      relations.orderOwner = sourceOrder.owner.legacyId === owner.legacyId && sourceOrder.owner.userId === owner.userId && sourceOrder.source.row.sale_user_id === owner.legacyId;
      relations.orderRenter = sourceOrder.renter.legacyId === renterStep.legacyId && sourceOrder.renter.userId === renterStep.userId && sourceOrder.source.row.user_id === renterStep.legacyId;
      relations.orderDigests = digestMatch;
      const reason = !relations.orderAccount ? "ORDER_ACCOUNT_MISMATCH" : !relations.orderOwner ? "ORDER_OWNER_MISMATCH" : !relations.orderRenter ? "ORDER_RENTER_MISMATCH" : !digestMatch ? "ORDER_DIGEST_MISMATCH" : sourceOrder.account.accountId && sourceOrder.account.accountId !== accountId ? "ORDER_TARGET_MISMATCH" : sourceOrder.account.gameId && sourceOrder.account.gameId !== targetGameId ? "ORDER_TARGET_MISMATCH" : null;
      if (reason) order = chainStep("order", "ISOLATED", reason, { writer: "importLegacyOrderRead" });
      else {
        const bound: LegacyOrderReadInput = { ...sourceOrder, account: { ...sourceOrder.account, accountId, gameId: targetGameId } };
        const planned = planLegacyOrder(bound, { ownerUserId: owner.userId, renterUserId: renterStep.userId, accountId, gameId: targetGameId });
        order = planned.disposition === "PARAMETER_READY"
          ? chainStep("order", "PARAMETER_READY", null, { writer: "importLegacyOrderRead", orderId: planned.orderId, sourceDigest: bound.source.digest, writerInput: planned.writerInput, dependencyDigests: planned.dependencyDigests })
          : chainStep("order", planned.disposition, ("reason" in planned ? planned.reason : null) ?? "SOURCE_REJECTED", { writer: "importLegacyOrderRead" });
      }
    }
  }
  const targetSupplied = game.disposition === "PARAMETER_READY";
  return {
    mode: USER_ORDER_PLAN_MODE, writes: 0 as const, writeAllowed: false as const, existence: "NOT_CHECKED" as const, window: "NOT_OPEN" as const,
    reviewState: observation.disposition === "PARAMETER_READY" ? "IMPORTED_UNVERIFIED" as const : null, publication: false as const, rentable: false as const, legacyHold: observation.disposition === "PARAMETER_READY" ? "UNRESOLVED" as const : null,
    actor: "UNBOUND" as const, resourceOid: "UNBOUND" as const, phoneNumberVerified: false as const, payment: false as const, posting: false as const, imGroup: false as const, skins: "PENDING_UNASSIGNED" as const,
    steps: [owner, renterStep, game, account, observation, map, readSnapshot, order], relations,
    ids: { ownerUserId: owner.userId ?? null, renterUserId: renterStep.userId ?? null, accountId: "accountId" in account ? account.accountId ?? null : null, orderId: "orderId" in order ? order.orderId ?? null : null, sourceGameId: input.game.sourceGameId, targetGameId: targetSupplied ? targetGameId : null, serviceCode: GAME_SERVICE.ACCOUNT_RENTAL },
    digests: { owner: owner.sourceDigest ?? null, renter: renterStep.sourceDigest ?? null, account: DIGEST.test(input.account.sourceDigest) ? input.account.sourceDigest : null, order: input.order?.source.digest ?? null },
    branches: {
      targetExistsUnverified: { selected: targetSupplied, match: "NOT_CHECKED" as const, ifAbsent: addWrites([ACCOUNT_IF_ABSENT, OBSERVATION_IF_ABSENT, SNAPSHOT_IF_ABSENT, ORDER_IF_ABSENT]), ifReplayBusinessInserts: 0 },
      targetCreateRequired: { selected: !targetSupplied, actor: "UNBOUND" as const, writes: { "zzsh_supply.game": 1, "zzsh_supply.game_service_operation": 2 }, accountPlan: "NOT_EMITTED" as const },
    },
  };
}

export function publicSourceChain(plan: ReturnType<typeof planSourceChain>) {
  return {
    mode: plan.mode, writes: plan.writes, writeAllowed: plan.writeAllowed, existence: plan.existence, window: plan.window, actor: plan.actor, resourceOid: plan.resourceOid,
    phoneNumberVerified: plan.phoneNumberVerified, payment: plan.payment, posting: plan.posting, imGroup: plan.imGroup, skins: plan.skins,
    reviewState: plan.reviewState, publication: plan.publication, rentable: plan.rentable, legacyHold: plan.legacyHold, ids: plan.ids, digests: plan.digests, relations: plan.relations, branches: plan.branches,
    steps: plan.steps.map(item => ({ step: item.step, parameterReady: item.parameterReady, disposition: item.disposition, reason: item.reason, writeAllowed: item.writeAllowed, existence: item.existence, snapshotReady: item.snapshotReady ?? null })),
  };
}
