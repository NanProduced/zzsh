import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION, loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { lockActor } from "../auth/admin-directory";
import { hashApprovalPayload } from "../auth/approval-audit";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { recordAudit, SecurityApiError, type AuditOutcome } from "../auth/security-core";
import { assertActiveInTransaction, assertUserContextInTransaction } from "../auth/user-identity";
import { readOrderTeamAccess } from "../im/order-team-access";
import { lockDispatchGate } from "../im/support-dispatch";
import { conflict, forbidden, invalid, notFound } from "../supply/supply-util";
import { centsToYuan, lockOrderPartiesInOrder, yuanToCents } from "./order";
import {
  computeSettlement,
  settlementConfirmationReady,
  SETTLEMENT_ROUNDING_POLICY,
  type ComputeSettlementInput,
  type ConfirmationParty,
  type SettlementComputation,
  type SettlementEndReason,
  type SettlementInventoryLine,
} from "./settlement";

export const SETTLEMENT_FEE_POLICY_VERSION = "trade-baseline-20260921";
export const SETTLEMENT_ADJUST_OPERATION = "order.settlement.adjust";
export const SETTLEMENT_ADJUST_TRIGGER = "manual-net";
const EARLY_REASONS = ["TENANT_VOLUNTARY_EARLY", "OWNER_OR_ACCOUNT_EARLY"] as const;
type EarlyReason = (typeof EARLY_REASONS)[number];
type Actor = { realm: "user" | "admin"; userId: string; sessionId: string };
type LineQty = { itemId: string; quantity: string };
type Command = { status: number; body: Record<string, unknown> };
type LockedOrder = {
  id: string;
  renterUserId: string;
  ownerUserId: string;
  accountId: string;
  gameId: string;
  status: string;
  depositCents: string;
  contentHash: string;
  quote: Record<string, unknown>;
  appId: string | null;
  revision: string;
};

export function settlementSurfaceOpen(flag: boolean | undefined): boolean {
  return flag === true && process.env.ZZSH_SETTLEMENT_RECORDING === "controlled" && process.env.NODE_ENV !== "production";
}

/** Labeled policy probe. HTTP order loading never calls this and never treats it as a paid order. */
export function computeSyntheticFullPayout(label: string, input: ComputeSettlementInput): SettlementComputation {
  if (label !== "SYNTHETIC_FULL_PAYOUT") throw new Error("synthetic full payout must be labeled SYNTHETIC_FULL_PAYOUT");
  return computeSettlement(input);
}

function blocked(reasons: string[]): Command {
  return {
    status: 409,
    body: {
      error: { code: "CONFLICT", message: reasons[0] ?? "Settlement blocked" },
      reasons,
      postingAuthorized: false,
      feeDeducted: false,
    },
  };
}

function done(body: Record<string, unknown>, orderStatus: string, posted = false, feeDeducted = false): Command {
  return { status: 200, body: { ...body, postingAuthorized: posted, feeDeducted, orderStatus } };
}

async function assertSettlementDatabase(client: PoolClient): Promise<void> {
  const row = (await client.query<{ db: string; actor: string }>(`SELECT current_database() AS db, current_user AS actor`)).rows[0];
  if (!row || !/^zzsh_test_order_[a-z][a-z0-9_]{0,40}$/.test(row.db) || !/^zzsh_order_[a-z][a-z0-9_]{0,40}_r$/.test(row.actor)) throw notFound();
}

/** Idempotency advisory is already held by the caller when this runs inside a keyed write.
 * Dispatch gate, then the acting admin, then party users, then game, account and order.
 * Admin before users matches restoreDeactivatedUserAccount, which locks the actor and then the user. */
async function lockSettlement(client: PoolClient, orderId: string, actor: Actor, write: boolean, allowCompletedReplay = false): Promise<LockedOrder> {
  await assertSettlementDatabase(client);
  const located = (await client.query<{ renterUserId: string; ownerUserId: string; accountId: string; gameId: string; appId: string | null }>(
    `SELECT o.renter_user_id AS "renterUserId", o.owner_user_id AS "ownerUserId", o.account_id AS "accountId",
            o.game_id AS "gameId", g.app_id AS "appId"
       FROM zzsh_order.rental_order o
       LEFT JOIN zzsh_order.im_order_group g ON g.order_id = o.id
      WHERE o.id = $1`,
    [orderId],
  )).rows[0];
  if (!located) throw notFound();
  if (located.appId) {
    await lockDispatchGate(client, located.appId);
    // The dispatch gate uses a short timeout for its own workers. Settlement confirms wait on the order row.
    await client.query(`SET LOCAL lock_timeout = '5s'`);
  }
  const adminAccess = actor.realm === "admin" ? await lockActor(client, actor.userId) : null;
  if (adminAccess) await assertAdminContextInTransaction(client, actor);
  await lockOrderPartiesInOrder(client, located.renterUserId, located.ownerUserId);
  await assertActiveInTransaction(client, located.renterUserId);
  await assertActiveInTransaction(client, located.ownerUserId);
  if (actor.realm === "user") await assertUserContextInTransaction(client, actor);
  await client.query(`SELECT id FROM zzsh_supply.game WHERE id = $1 FOR SHARE`, [located.gameId]);
  await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`, [located.accountId]);
  const row = (await client.query<{
    id: string; renterUserId: string; ownerUserId: string; accountId: string; gameId: string; status: string;
    depositCents: string; contentHash: string; quote: Record<string, unknown>; appId: string | null; revision: string;
  }>(
    `SELECT o.id, o.renter_user_id AS "renterUserId", o.owner_user_id AS "ownerUserId", o.account_id AS "accountId",
            o.game_id AS "gameId", o.status, o.deposit_amount_cents::text AS "depositCents", o.content_hash AS "contentHash",
            o.quote_snapshot AS quote, o.revision::text AS revision, g.app_id AS "appId"
       FROM zzsh_order.rental_order o
       LEFT JOIN zzsh_order.im_order_group g ON g.order_id = o.id
      WHERE o.id = $1
      FOR UPDATE OF o`,
    [orderId],
  )).rows[0];
  if (!row || row.accountId !== located.accountId || row.gameId !== located.gameId || row.renterUserId !== located.renterUserId || row.ownerUserId !== located.ownerUserId) {
    throw conflict("Supply state changed; reload and retry");
  }
  if (row.appId) await client.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id = $1 FOR UPDATE`, [orderId]);
  if (actor.realm === "user") {
    if (actor.userId !== row.renterUserId && actor.userId !== row.ownerUserId) throw notFound();
  } else {
    const team = await readOrderTeamAccess(client, { ...actor, realm: "admin" }, orderId, "read");
    if (team.teamState !== "READY" || team.canRead !== true) throw forbidden();
    if (!adminAccess) throw forbidden();
    if (write) requirePermission(adminAccess, ADMIN_PERMISSION.orderSettlementWrite);
    else if (!adminAccess.permissions.has(ADMIN_PERMISSION.orderSettlementWrite) && !adminAccess.permissions.has(ADMIN_PERMISSION.orderRead)) throw forbidden();
  }
  if (write && row.status !== "PAID" && !(allowCompletedReplay && row.status === "COMPLETED")) throw conflict("ORDER_NOT_SETTLEABLE");
  return row;
}

function partyOf(order: LockedOrder, userId: string): "RENTER" | "OWNER" {
  if (userId === order.renterUserId) return "RENTER";
  if (userId === order.ownerUserId) return "OWNER";
  throw notFound();
}

function amountText(value: unknown, scale: 2 | 8): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { currency?: unknown; unit?: unknown; amount?: unknown; scale?: unknown };
  if (row.currency !== "CNY" || row.unit !== "yuan" || row.scale !== scale || typeof row.amount !== "string") return null;
  return row.amount;
}

type Basis = {
  lines: SettlementInventoryLine[];
  haff: SettlementInventoryLine;
  items: SettlementInventoryLine[];
  captured: string;
  deposit: string;
  quoteDigest: string;
  paymentDigest: string;
  paymentConfirmationId: string;
  fundingSourceRef: string;
  fundingPolicyRef: string;
  fullPayout: "NOT_SELECTED";
};

function basisOrReasons(order: LockedOrder, payment: { id: string; amountCents: string; currency: string }, openingLines: LineQty[]): { basis: Basis } | { reasons: string[] } {
  const personal = order.quote.personal as { funding?: Record<string, unknown> } | undefined;
  const funding = personal?.funding;
  if (!funding || typeof funding.fullPayoutSelected !== "boolean" || typeof funding.fullPayoutPolicyRef !== "string" || !funding.fullPayoutPolicyRef.trim()
    || typeof funding.sourceRef !== "string" || !funding.sourceRef.trim() || typeof funding.fullPayoutFeeCents !== "string") {
    return { reasons: ["FULL_PAYOUT_UNKNOWN"] };
  }
  if (funding.fullPayoutSelected || funding.fullPayoutFeeCents !== "0") return { reasons: ["FULL_PAYOUT_FORMAL_PATH_CLOSED"] };
  const quoteLines = order.quote.lines;
  const ratios = (order.quote.pricingInputs as { exactRatios?: Array<Record<string, string>> } | undefined)?.exactRatios;
  if (!Array.isArray(quoteLines) || !Array.isArray(ratios)) return { reasons: ["QUOTE_BASIS_INVALID"] };
  const wanted = new Map(openingLines.map((line) => [line.itemId, line.quantity]));
  if (wanted.size !== openingLines.length || wanted.size !== quoteLines.length) return { reasons: ["OPENING_QUANTITY_MISMATCH"] };
  const mapped: SettlementInventoryLine[] = [];
  for (const raw of quoteLines) {
    if (!raw || typeof raw !== "object") return { reasons: ["QUOTE_BASIS_INVALID"] };
    const line = raw as Record<string, unknown>;
    if (typeof line.itemId !== "string" || typeof line.quantity !== "string" || typeof line.unit !== "string" || typeof line.pricingKind !== "string" || typeof line.unitQuantity !== "string") {
      return { reasons: ["QUOTE_BASIS_INVALID"] };
    }
    if (wanted.get(line.itemId) !== line.quantity) return { reasons: ["OPENING_QUANTITY_MISMATCH"] };
    wanted.delete(line.itemId);
    const buyer = amountText(line.buyerAmount, 2);
    const owner = amountText(line.ownerAmount, 2);
    const buyerUnit = amountText(line.buyerUnitAmount, 8);
    const ownerUnit = amountText(line.ownerUnitAmount, 8);
    if (!buyer || !owner || !buyerUnit || !ownerUnit) return { reasons: ["QUOTE_BASIS_INVALID"] };
    const ratio = line.pricingKind === "HAFF_RATIO" ? ratios.find((item) => item.itemId === line.itemId) : undefined;
    mapped.push({
      itemId: line.itemId,
      unit: line.unit as SettlementInventoryLine["unit"],
      pricingKind: line.pricingKind as SettlementInventoryLine["pricingKind"],
      openingQuantity: line.quantity,
      remainingQuantity: null,
      unitQuantity: line.unitQuantity,
      buyerUnitAmount: buyerUnit,
      ownerUnitAmount: ownerUnit,
      prepaidBuyerAmount: buyer,
      prepaidOwnerAmount: owner,
      ...(ratio ? { exactRatio: { buyerNumerator: ratio.buyerNumerator!, buyerDenominator: ratio.buyerDenominator!, ownerNumerator: ratio.ownerNumerator!, ownerDenominator: ratio.ownerDenominator! } } : {}),
    });
  }
  if (wanted.size !== 0) return { reasons: ["OPENING_QUANTITY_MISMATCH"] };
  const haff = mapped.filter((line) => line.pricingKind === "HAFF_RATIO");
  if (haff.length !== 1) return { reasons: ["QUOTE_BASIS_INVALID"] };
  const digestLines = mapped.map((line) => ({
    itemId: line.itemId, quantity: line.openingQuantity, unit: line.unit, pricingKind: line.pricingKind,
    buyer: line.prepaidBuyerAmount, owner: line.prepaidOwnerAmount, buyerUnit: line.buyerUnitAmount, ownerUnit: line.ownerUnitAmount,
    ...(line.exactRatio ?? {}),
  }));
  let quoteDigest: string;
  let paymentDigest: string;
  try {
    quoteDigest = hashApprovalPayload({ contentHash: order.contentHash, priceVersionId: String(order.quote.priceVersionId ?? ""), lines: digestLines }).hash;
    paymentDigest = hashApprovalPayload({ confirmationId: payment.id, amountCents: payment.amountCents, currency: payment.currency, disposition: "APPLIED" }).hash;
  } catch {
    return { reasons: ["QUOTE_BASIS_INVALID"] };
  }
  return {
    basis: {
      lines: mapped,
      haff: haff[0]!,
      items: mapped.filter((line) => line !== haff[0]),
      captured: centsToYuan(payment.amountCents).amount,
      deposit: centsToYuan(order.depositCents).amount,
      quoteDigest,
      paymentDigest,
      paymentConfirmationId: payment.id,
      fundingSourceRef: funding.sourceRef,
      fundingPolicyRef: funding.fullPayoutPolicyRef,
      fullPayout: "NOT_SELECTED",
    },
  };
}

async function appliedPayment(client: PoolClient, orderId: string): Promise<{ id: string; amountCents: string; currency: string } | null> {
  return (await client.query<{ id: string; amountCents: string; currency: string }>(
    `SELECT id, amount_cents::text AS "amountCents", currency FROM zzsh_order.payment_confirmation
      WHERE order_id = $1 AND disposition = 'APPLIED'`,
    [orderId],
  )).rows[0] ?? null;
}

async function confirmedOpening(client: PoolClient, orderId: string): Promise<{ id: string; versionNo: number; quoteDigest: string; paymentDigest: string; lines: LineQty[] } | null> {
  const row = (await client.query<{ id: string; versionNo: number; quoteDigest: string; paymentDigest: string; lines: LineQty[] }>(
    `SELECT id, version_no AS "versionNo", quote_digest AS "quoteDigest", payment_digest AS "paymentDigest", lines
       FROM zzsh_order.rental_opening WHERE order_id = $1 AND status = 'CONFIRMED' FOR UPDATE`,
    [orderId],
  )).rows[0];
  return row ?? null;
}

function withRemaining(basis: Basis, remaining: LineQty[]): { lines: SettlementInventoryLine[] } | { reasons: string[] } {
  const wanted = new Map(remaining.map((line) => [line.itemId, line.quantity]));
  if (wanted.size !== remaining.length || wanted.size !== basis.lines.length) return { reasons: ["SETTLEMENT_QUANTITY_MISMATCH"] };
  const lines = basis.lines.map((line) => {
    const value = wanted.get(line.itemId);
    wanted.delete(line.itemId);
    return { ...line, remainingQuantity: value ?? null };
  });
  if (wanted.size !== 0 || lines.some((line) => line.remainingQuantity === null)) return { reasons: ["SETTLEMENT_QUANTITY_MISMATCH"] };
  return { lines };
}

type IntakeAcceptanceBase = {
  id: string;
  versionNo: number;
  status: "OPEN" | "CLASSIFIED" | "SUPERSEDED";
  settlementVersionId: string | null;
};
type AcceptanceBase = { versionId: string | null; versionNo: number; decisionDigest: string; intake: IntakeAcceptanceBase | null };

async function acceptanceBase(client: PoolClient, orderId: string): Promise<AcceptanceBase> {
  const current = (await client.query<{ id: string; versionNo: number; approvalStatus: string | null }>(
    `SELECT v.id, v.version_no AS "versionNo",
            CASE WHEN r.status IN ('PENDING','APPROVED') AND r.expires_at <= clock_timestamp()
                 THEN 'EXPIRED' ELSE r.status END AS "approvalStatus"
       FROM zzsh_order.settlement_version v
       LEFT JOIN zzsh_iam.approval_request r ON r.id = v.approval_request_id
      WHERE v.order_id = $1 AND v.superseded_at IS NULL
      FOR UPDATE OF v`,
      [orderId],
  )).rows[0];
  const latestIntake = (await client.query<IntakeAcceptanceBase>(
    `SELECT id, version_no AS "versionNo", status, settlement_version_id AS "settlementVersionId"
       FROM zzsh_order.settlement_intake WHERE order_id = $1
      ORDER BY version_no DESC LIMIT 1 FOR UPDATE`,
    [orderId],
  )).rows[0];
  const decisions = current ? (await client.query(
    `SELECT party, action, version_hash AS "versionHash" FROM zzsh_order.settlement_decision
      WHERE settlement_version_id = $1 ORDER BY party, action, id`,
    [current.id],
  )).rows : [];
  return {
    versionId: current?.id ?? null,
    versionNo: current?.versionNo ?? 0,
    decisionDigest: hashApprovalPayload({ versionId: current?.id ?? null, decisions, approvalStatus: current?.approvalStatus ?? null }).hash,
    intake: latestIntake ?? null,
  };
}

function payloadFor(input: {
  order: LockedOrder;
  openingId: string;
  openingVersion: number;
  basis: Basis;
  lines: SettlementInventoryLine[];
  kind: "SYSTEM" | "MANUAL_ADJUSTMENT";
  endReason: SettlementEndReason;
  early: boolean;
  result: SettlementComputation;
  proposedOwnerNet: string | null;
  proposedRenterRefund: string | null;
  reason: string | null;
  base: AcceptanceBase;
}): Record<string, unknown> {
  const amounts = input.result.amounts;
  return {
    schema: "settlement-version-v2",
    baseVersionId: input.base.versionId,
    baseVersionNo: input.base.versionNo,
    decisionDigest: input.base.decisionDigest,
    baseIntake: input.base.intake,
    orderId: input.order.id,
    renterUserId: input.order.renterUserId,
    ownerUserId: input.order.ownerUserId,
    openingId: input.openingId,
    openingVersion: String(input.openingVersion),
    quoteDigest: input.basis.quoteDigest,
    paymentDigest: input.basis.paymentDigest,
    paymentConfirmationId: input.basis.paymentConfirmationId,
    capturedAmount: input.basis.captured,
    depositAmount: input.basis.deposit,
    fundingSourceRef: input.basis.fundingSourceRef,
    fundingPolicyRef: input.basis.fundingPolicyRef,
    fullPayout: input.basis.fullPayout,
    feePolicyVersion: SETTLEMENT_FEE_POLICY_VERSION,
    lines: input.lines.map((line) => ({ itemId: line.itemId, openingQuantity: line.openingQuantity, remainingQuantity: line.remainingQuantity })),
    kind: input.kind,
    endReason: input.endReason,
    early: input.early,
    proposedOwnerNet: input.proposedOwnerNet,
    proposedRenterRefund: input.proposedRenterRefund,
    reason: input.reason,
    amounts: amounts ? {
      haffConsumedBuyer: amounts.haffConsumedBuyer.amount,
      haffConsumedOwner: amounts.haffConsumedOwner.amount,
      haffSpread: amounts.haffSpread.amount,
      itemConsumedBuyer: amounts.itemConsumedBuyer.amount,
      itemConsumedOwner: amounts.itemConsumedOwner.amount,
      itemSpread: amounts.itemSpread.amount,
      unusedItemRefund: amounts.unusedItemRefund.amount,
      unusedHaffRefund: amounts.unusedHaffRefund.amount,
      earlyMakeup: amounts.earlyMakeup.amount,
      feeBase: amounts.feeBase.amount,
      feeRate: amounts.feeRate,
      feeAmount: amounts.feeAmount.amount,
      feePayer: amounts.feePayer,
      ownerGross: amounts.ownerGross.amount,
      ownerNet: amounts.ownerNet.amount,
      renterCharge: amounts.renterCharge.amount,
      renterRefund: amounts.renterRefund.amount,
      depositRefund: amounts.depositRefund.amount,
      platformContribution: amounts.platformContribution.amount,
    } : null,
    feeDeducted: false,
  };
}

function stableRemaining(lines: LineQty[]): Array<{ itemId: string; remainingQuantity: string }> {
  return [...lines].sort((left, right) => left.itemId.localeCompare(right.itemId)).map((line) => ({ itemId: line.itemId, remainingQuantity: line.quantity }));
}

function intakePayload(order: LockedOrder, opening: { id: string; versionNo: number }, basis: Basis, remaining: LineQty[], base: AcceptanceBase): Record<string, unknown> {
  return {
    schema: "settlement-intake-v2",
    orderId: order.id,
    openingId: opening.id,
    openingVersion: opening.versionNo,
    quoteDigest: basis.quoteDigest,
    paymentDigest: basis.paymentDigest,
    lines: stableRemaining(remaining),
    baseVersionId: base.versionId,
    baseVersionNo: base.versionNo,
    decisionDigest: base.decisionDigest,
    baseIntake: base.intake,
  };
}

function probe(order: LockedOrder, openingId: string, basis: Basis, lines: SettlementInventoryLine[], endReason: SettlementEndReason, versionId: string): SettlementComputation {
  const input: ComputeSettlementInput = {
    orderId: order.id,
    settlementVersionId: versionId,
    openingVersionId: openingId,
    quoteDigest: basis.quoteDigest,
    paymentDigest: basis.paymentDigest,
    roundingPolicy: SETTLEMENT_ROUNDING_POLICY,
    feePolicyVersion: SETTLEMENT_FEE_POLICY_VERSION,
    renterUserId: order.renterUserId,
    ownerUserId: order.ownerUserId,
    rentalStarted: true,
    endReason,
    depositAmount: basis.deposit,
    capturedAmount: basis.captured,
    fullPayout: basis.fullPayout,
    fullPayoutPolicyRef: null,
    haff: lines.find((line) => line.pricingKind === "HAFF_RATIO") ?? basis.haff,
    items: lines.filter((line) => line.pricingKind !== "HAFF_RATIO"),
  };
  try {
    return computeSettlement(input);
  } catch {
    return { ok: false, reasons: ["QUOTE_BASIS_INVALID"], early: null, amounts: null, consumed: null };
  }
}

function needsEarlyReason(result: SettlementComputation): boolean {
  const other = result.reasons.filter((reason) => reason !== "END_REASON_INCONSISTENT");
  return result.early === true && result.reasons.includes("END_REASON_INCONSISTENT") && other.length === 0;
}

/** Approval expiry applies even before an IAM action persists the EXPIRED status. */
async function readSettlementApproval(client: PoolClient, requestId: string, asOf?: string) {
  return (await client.query<{ status: string; requestedBy: string; decidedBy: string | null; payloadHash: string; expiresAt: string }>(
    `SELECT CASE WHEN status IN ('PENDING','APPROVED') AND expires_at <= COALESCE($2::timestamptz, clock_timestamp()) THEN 'EXPIRED'
                 ELSE status END AS status,
            requested_by AS "requestedBy", decided_by AS "decidedBy", operation_payload_hash AS "payloadHash",
            expires_at::text AS "expiresAt"
       FROM zzsh_iam.approval_request WHERE id = $1`,
    [requestId, asOf ?? null],
  )).rows[0];
}

async function readyFacts(client: PoolClient, version: {
  id: string; versionHash: string; kind: "SYSTEM" | "MANUAL_ADJUSTMENT"; early: boolean; initiatorParty: ConfirmationParty; approvalRequestId: string | null;
}, asOf?: string): Promise<{ ready: boolean; reasons: string[] }> {
  const decisions = (await client.query<{ party: string; action: string }>(
    `SELECT party, action FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1`,
    [version.id],
  )).rows;
  const hit = (party: string, action: string) => decisions.some((row) => row.party === party && row.action === action);
  let opsApproval: { status: "APPROVED" | "PENDING" | "REJECTED"; requesterId: string; approverId: string; payloadHash: string } | null = null;
  if (version.approvalRequestId) {
    const approval = await readSettlementApproval(client, version.approvalRequestId, asOf);
    if (approval?.status === "EXPIRED") return { ready: false, reasons: ["OPS_APPROVAL_EXPIRED"] };
    if (approval && (approval.status === "APPROVED" || approval.status === "PENDING" || approval.status === "REJECTED")) {
      opsApproval = { status: approval.status, requesterId: approval.requestedBy, approverId: approval.decidedBy ?? "", payloadHash: approval.payloadHash };
    }
  }
  return settlementConfirmationReady({
    settlementVersionId: version.id,
    currentVersionHash: version.versionHash,
    kind: version.kind,
    early: version.early,
    initiatorParty: version.initiatorParty,
    renterConfirmedVersionId: hit("RENTER", "CONFIRM") ? version.id : null,
    ownerConfirmedVersionId: hit("OWNER", "CONFIRM") ? version.id : null,
    renterRejectedVersionId: hit("RENTER", "REJECT") ? version.id : null,
    ownerRejectedVersionId: hit("OWNER", "REJECT") ? version.id : null,
    supportReviewedVersionId: hit("SUPPORT", "REVIEW") ? version.id : null,
    opsApproval,
  });
}

async function settlementPostingView(client: PoolClient, orderId: string): Promise<Record<string, unknown> | null> {
  const posting = (await client.query<{
    id: string; settlementVersionId: string; paymentConfirmationId: string; versionHash: string; early: boolean;
    capturedCents: string; systemOwnerNetCents: string; ownerNetCents: string; systemRenterRefundCents: string;
    renterRefundCents: string; platformContributionCents: string; compensationFeeCents: string;
    manualReason: string | null; approvalRequestId: string | null; approvalRequestedBy: string | null;
    approvalApprovedBy: string | null; approvalExpiresAt: string | null; approvalPayloadHash: string | null;
    postedAt: string; refundDueAt: string; inputSnapshot: Record<string, unknown>;
  }>(
    `SELECT p.id, p.settlement_version_id AS "settlementVersionId", p.payment_confirmation_id AS "paymentConfirmationId",
            p.version_hash AS "versionHash", p.early, p.captured_cents::text AS "capturedCents",
            p.system_owner_net_cents::text AS "systemOwnerNetCents", p.owner_net_cents::text AS "ownerNetCents",
            p.system_renter_refund_cents::text AS "systemRenterRefundCents", p.renter_refund_cents::text AS "renterRefundCents",
            p.platform_contribution_cents::text AS "platformContributionCents", p.compensation_fee_cents::text AS "compensationFeeCents",
            p.manual_reason AS "manualReason", p.approval_request_id AS "approvalRequestId",
            p.approval_requested_by AS "approvalRequestedBy", p.approval_approved_by AS "approvalApprovedBy",
            p.approval_expires_at::text AS "approvalExpiresAt", p.approval_payload_hash AS "approvalPayloadHash",
            p.posted_at::text AS "postedAt", p.refund_due_at::text AS "refundDueAt", v.input_snapshot AS "inputSnapshot"
       FROM zzsh_order.settlement_posting p
       JOIN zzsh_order.settlement_version v ON v.id = p.settlement_version_id
      WHERE p.order_id = $1`,
    [orderId],
  )).rows[0];
  if (!posting) return null;
  const entries = (await client.query<{
    id: string; lineNo: number; accountCode: string; debitCents: string; creditCents: string;
    counterpartyUserId: string | null; sourcePaymentConfirmationId: string | null; details: Record<string, unknown>;
  }>(
    `SELECT id, line_no AS "lineNo", account_code AS "accountCode", debit_cents::text AS "debitCents",
            credit_cents::text AS "creditCents", counterparty_user_id AS "counterpartyUserId",
            source_payment_confirmation_id AS "sourcePaymentConfirmationId", details
       FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1 ORDER BY line_no`,
    [posting.id],
  )).rows;
  const snapshot = posting.inputSnapshot;
  return {
    id: posting.id,
    settlementVersionId: posting.settlementVersionId,
    versionHash: posting.versionHash,
    paymentConfirmationId: posting.paymentConfirmationId,
    early: posting.early,
    currency: "CNY",
    postedAt: posting.postedAt,
    refundDueAt: posting.refundDueAt,
    capturedCents: posting.capturedCents,
    owner: {
      gross: (snapshot.amounts as Record<string, unknown> | undefined)?.ownerGross ?? null,
      systemNetCents: posting.systemOwnerNetCents,
      availableCents: posting.ownerNetCents,
    },
    refund: {
      systemCents: posting.systemRenterRefundCents,
      payableCents: posting.renterRefundCents,
      includesDeposit: (snapshot.amounts as Record<string, unknown> | undefined)?.depositRefund ?? null,
    },
    platformContributionCents: posting.platformContributionCents,
    compensationFeeCents: posting.compensationFeeCents,
    amounts: snapshot.amounts ?? null,
    manualAdjustment: posting.manualReason === null ? null : {
      reason: posting.manualReason,
      systemOwnerNetCents: posting.systemOwnerNetCents,
      postedOwnerNetCents: posting.ownerNetCents,
      systemRenterRefundCents: posting.systemRenterRefundCents,
      postedRenterRefundCents: posting.renterRefundCents,
      approval: {
        requestId: posting.approvalRequestId,
        requestedBy: posting.approvalRequestedBy,
        approvedBy: posting.approvalApprovedBy,
        expiresAt: posting.approvalExpiresAt,
        payloadHash: posting.approvalPayloadHash,
      },
    },
    ledgerEntries: entries,
  };
}

function frozenLineFacts(order: LockedOrder): Map<string, { unit: string; pricingKind: string }> {
  const facts = new Map<string, { unit: string; pricingKind: string }>();
  const lines = order.quote.lines;
  if (!Array.isArray(lines)) return facts;
  for (const raw of lines) {
    if (!raw || typeof raw !== "object") continue;
    const line = raw as { itemId?: unknown; unit?: unknown; pricingKind?: unknown };
    if (typeof line.itemId === "string") facts.set(line.itemId, { unit: typeof line.unit === "string" ? line.unit : "", pricingKind: typeof line.pricingKind === "string" ? line.pricingKind : "" });
  }
  return facts;
}

async function view(client: PoolClient, order: LockedOrder): Promise<Command> {
  const facts = frozenLineFacts(order);
  const openingRows = (await client.query<{
    id: string; versionNo: number; status: string; confirmedAt: string | null; createdAt: string;
    lines: Array<{ itemId: string; quantity: string }>; quoteDigest: string; paymentDigest: string;
  }>(
    `SELECT id, version_no AS "versionNo", status, confirmed_at AS "confirmedAt", created_at AS "createdAt",
            lines, quote_digest AS "quoteDigest", payment_digest AS "paymentDigest"
       FROM zzsh_order.rental_opening WHERE order_id = $1 ORDER BY version_no`,
    [order.id],
  )).rows;
  const ackRows = openingRows.length === 0 ? [] : (await client.query<{ openingId: string; party: string; userId: string; createdAt: string }>(
    `SELECT opening_id AS "openingId", party, user_id AS "userId", created_at AS "createdAt"
       FROM zzsh_order.rental_opening_ack WHERE opening_id = ANY($1::text[]) ORDER BY created_at, party`,
    [openingRows.map((row) => row.id)],
  )).rows;
  const openings = openingRows.map((row) => ({
    ...row,
    lines: row.lines.map((line) => ({ ...line, ...(facts.get(line.itemId) ?? { unit: "", pricingKind: "" }) })),
    acks: ackRows.filter((ack) => ack.openingId === row.id).map(({ party, userId, createdAt }) => ({ party, userId, createdAt })),
  }));
  const versions = (await client.query<{
    id: string; versionNo: number; kind: "SYSTEM" | "MANUAL_ADJUSTMENT"; endReason: string; early: boolean;
    initiatorParty: ConfirmationParty; versionHash: string; inputSnapshot: unknown; computation: unknown;
    approvalRequestId: string | null; systemOwnerNet: string; systemRenterRefund: string;
    proposedOwnerNet: string | null; proposedRenterRefund: string | null; supersededAt: string | null;
  }>(
    `SELECT id, version_no AS "versionNo", kind, end_reason AS "endReason", early, initiator_party AS "initiatorParty",
            version_hash AS "versionHash", input_snapshot AS "inputSnapshot", computation,
            approval_request_id AS "approvalRequestId", system_owner_net_cents::text AS "systemOwnerNet",
            system_renter_refund_cents::text AS "systemRenterRefund", proposed_owner_net_cents::text AS "proposedOwnerNet",
            proposed_renter_refund_cents::text AS "proposedRenterRefund", superseded_at::text AS "supersededAt"
       FROM zzsh_order.settlement_version WHERE order_id = $1 ORDER BY version_no`,
    [order.id],
  )).rows;
  const decisionRows = versions.length === 0 ? [] : (await client.query<{ settlementVersionId: string; id: string; party: string; action: string; subjectId: string; reason: string | null; versionHash: string; createdAt: string }>(
    `SELECT settlement_version_id AS "settlementVersionId", id, party, action, subject_id AS "subjectId", reason,
            version_hash AS "versionHash", created_at AS "createdAt"
       FROM zzsh_order.settlement_decision WHERE settlement_version_id = ANY($1::text[]) ORDER BY created_at, id`,
    [versions.map((row) => row.id)],
  )).rows;
  const withDecisions = versions.map((row) => ({
    ...row,
    decisions: decisionRows.filter((decision) => decision.settlementVersionId === row.id).map(({ settlementVersionId: _version, ...decision }) => decision),
  }));
  const current = withDecisions.find((row) => row.supersededAt === null);
  const intakes = (await client.query<{
    id: string; versionNo: number; initiatorParty: string; initiatorSubjectId: string;
    lines: Array<{ itemId: string; remainingQuantity: string }>; status: "OPEN" | "CLASSIFIED" | "SUPERSEDED";
    basisHash: string; settlementVersionId: string | null; createdAt: string;
  }>(
    `SELECT id, version_no AS "versionNo", initiator_party AS "initiatorParty", initiator_subject_id AS "initiatorSubjectId",
            lines, status, basis_hash AS "basisHash", settlement_version_id AS "settlementVersionId", created_at AS "createdAt"
       FROM zzsh_order.settlement_intake WHERE order_id = $1 ORDER BY version_no`,
    [order.id],
  )).rows;
  const pendingIntake = intakes.at(-1)?.status === "OPEN" ? intakes.at(-1)! : null;
  const posting = await settlementPostingView(client, order.id);
  const readiness = posting
    ? { ready: true, reasons: [] as string[] }
    : pendingIntake
    ? { ready: false, reasons: ["SETTLEMENT_INTAKE_PENDING"] }
    : current ? await readyFacts(client, current) : { ready: false, reasons: ["SETTLEMENT_VERSION_MISSING"] };
  return done({
    orderId: order.id,
    revision: order.revision,
    rentalStarted: openings.some((row) => row.status === "CONFIRMED"),
    openings,
    intakes,
    versions: withDecisions,
    currentRequest: pendingIntake
      ? { kind: "INTAKE", id: pendingIntake.id, versionNo: pendingIntake.versionNo, status: pendingIntake.status }
      : current ? { kind: "SETTLEMENT_VERSION", id: current.id, versionNo: current.versionNo } : null,
    settlement: pendingIntake ? null : current ?? null,
    posting,
    ready: readiness.ready,
    reasons: readiness.reasons,
  }, order.status, posting !== null,
  posting !== null && BigInt(String((posting as { compensationFeeCents: string }).compensationFeeCents)) > 0n);
}

const CONFIRMATION_AMOUNT_FIELDS = [
  "haffConsumedBuyer", "haffConsumedOwner", "itemConsumedBuyer", "itemConsumedOwner", "unusedItemRefund", "unusedHaffRefund",
  "earlyMakeup", "feeBase", "feeRate", "feeAmount", "feePayer", "ownerGross", "ownerNet", "renterCharge", "renterRefund", "depositRefund",
] as const;

function pickFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(source, field)).map((field) => [field, source[field]]));
}

function projectAmounts(value: unknown): Record<string, unknown> {
  const amounts = pickFields(value, CONFIRMATION_AMOUNT_FIELDS);
  for (const field of CONFIRMATION_AMOUNT_FIELDS) {
    const amount = amounts[field];
    if (amount && typeof amount === "object") amounts[field] = pickFields(amount, ["currency", "unit", "scale", "amount"]);
  }
  return amounts;
}

function projectComputation(value: unknown): Record<string, unknown> {
  const computation = pickFields(value, ["ok", "reasons", "early", "consumed", "amounts"]);
  if (computation.amounts !== undefined) computation.amounts = projectAmounts(computation.amounts);
  if (computation.consumed && typeof computation.consumed === "object") {
    const consumed = pickFields(computation.consumed, ["haff", "items"]);
    if (Array.isArray(consumed.items)) consumed.items = consumed.items.map((line) => pickFields(line, ["itemId", "consumed", "remaining"]));
    computation.consumed = consumed;
  }
  return computation;
}

function projectInputSnapshot(value: unknown): Record<string, unknown> {
  const snapshot = pickFields(value, [
    "schema", "openingId", "openingVersion", "capturedAmount", "depositAmount", "lines", "kind", "endReason", "early",
    "proposedOwnerNet", "proposedRenterRefund", "reason", "feePolicyVersion", "amounts",
  ]);
  if (Array.isArray(snapshot.lines)) snapshot.lines = snapshot.lines.map((line) => pickFields(line, ["itemId", "openingQuantity", "remainingQuantity"]));
  if (snapshot.amounts !== undefined) snapshot.amounts = projectAmounts(snapshot.amounts);
  return snapshot;
}

function projectDecision(value: unknown): Record<string, unknown> {
  return pickFields(value, ["party", "action", "reason", "versionHash", "createdAt"]);
}

function projectVersion(value: unknown): Record<string, unknown> {
  const version = pickFields(value, [
    "id", "versionNo", "kind", "endReason", "early", "initiatorParty", "versionHash", "supersededAt",
    "systemOwnerNet", "systemRenterRefund", "proposedOwnerNet", "proposedRenterRefund", "inputSnapshot", "computation", "decisions",
  ]);
  if (version.inputSnapshot !== undefined) version.inputSnapshot = projectInputSnapshot(version.inputSnapshot);
  if (version.computation !== undefined) version.computation = projectComputation(version.computation);
  if (Array.isArray(version.decisions)) version.decisions = version.decisions.map(projectDecision);
  return version;
}

function projectPosting(value: unknown): Record<string, unknown> {
  const posting = pickFields(value, [
    "id", "settlementVersionId", "versionHash", "early", "currency", "postedAt", "refundDueAt", "capturedCents",
    "owner", "refund", "compensationFeeCents", "amounts", "manualAdjustment",
  ]);
  if (posting.owner !== undefined) posting.owner = pickFields(posting.owner, ["gross", "systemNetCents", "availableCents"]);
  if (posting.refund !== undefined) posting.refund = pickFields(posting.refund, ["systemCents", "payableCents", "includesDeposit"]);
  if (posting.amounts !== undefined) posting.amounts = projectAmounts(posting.amounts);
  if (posting.manualAdjustment && typeof posting.manualAdjustment === "object") {
    posting.manualAdjustment = pickFields(posting.manualAdjustment, [
      "reason", "systemOwnerNetCents", "postedOwnerNetCents", "systemRenterRefundCents", "postedRenterRefundCents",
    ]);
  }
  return posting;
}

function projectSettlementBody(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const body = pickFields(value, [
    "error", "orderId", "revision", "rentalStarted", "openings", "intakes", "versions", "currentRequest", "settlement", "posting",
    "ready", "reasons", "postingAuthorized", "feeDeducted", "orderStatus", "accepted", "early", "amounts", "versionHash",
    "baseVersionId", "consumed", "systemOwnerNet", "systemRenterRefund", "proposedOwnerNet", "proposedRenterRefund", "reason",
  ]);
  if (Array.isArray(body.openings)) body.openings = body.openings.map((opening) => {
    const projected = pickFields(opening, ["id", "versionNo", "status", "confirmedAt", "createdAt", "quoteDigest", "paymentDigest", "lines", "acks"]);
    if (Array.isArray(projected.lines)) projected.lines = projected.lines.map((line) => pickFields(line, ["itemId", "quantity", "unit", "pricingKind"]));
    if (Array.isArray(projected.acks)) projected.acks = projected.acks.map((ack) => pickFields(ack, ["party", "createdAt"]));
    return projected;
  });
  if (Array.isArray(body.intakes)) body.intakes = body.intakes.map((intake) => {
    const projected = pickFields(intake, ["id", "versionNo", "initiatorParty", "lines", "status", "settlementVersionId", "createdAt"]);
    if (Array.isArray(projected.lines)) projected.lines = projected.lines.map((line) => pickFields(line, ["itemId", "remainingQuantity"]));
    return projected;
  });
  if (Array.isArray(body.versions)) body.versions = body.versions.map(projectVersion);
  if (body.currentRequest !== undefined) body.currentRequest = pickFields(body.currentRequest, ["kind", "id", "versionNo", "status"]);
  if (body.settlement !== undefined && body.settlement !== null) body.settlement = projectVersion(body.settlement);
  if (body.posting !== undefined && body.posting !== null) body.posting = projectPosting(body.posting);
  if (body.amounts !== undefined) body.amounts = projectAmounts(body.amounts);
  if (body.consumed && typeof body.consumed === "object") {
    const consumed = pickFields(body.consumed, ["haff", "items"]);
    if (Array.isArray(consumed.items)) consumed.items = consumed.items.map((line) => pickFields(line, ["itemId", "consumed", "remaining"]));
    body.consumed = consumed;
  }
  return body;
}

/** One actor-aware projection for reads, previews and both fresh/cached write receipts. */
export async function projectSettlementResponse(
  client: PoolClient,
  actor: Actor,
  result: { status: number; body: unknown },
): Promise<{ status: number; body: unknown }> {
  if (actor.realm === "admin") {
    const access = await loadEffectiveAdminAccess(client, actor.userId);
    if (access?.permissions.has(ADMIN_PERMISSION.supplyQuoteInternalRead)) return result;
  }
  return { ...result, body: projectSettlementBody(result.body) };
}

async function audit(client: PoolClient, actor: Actor, action: string, orderId: string, requestId: string, details: Record<string, unknown>, outcome: AuditOutcome = "SUCCESS"): Promise<void> {
  await recordAudit(client, {
    actorType: actor.realm, actorId: actor.userId, sessionId: actor.sessionId, action, objectType: "rental_order",
    objectId: orderId, outcome, requestId, details,
  });
}

export async function readSettlement(client: PoolClient, orderId: string, actor: Actor): Promise<Command> {
  return view(client, await lockSettlement(client, orderId, actor, false));
}

export async function recheckSettlement(client: PoolClient, orderId: string, actor: Actor, allowCompletedReplay = false): Promise<void> {
  await lockSettlement(client, orderId, actor, true, allowCompletedReplay);
}

export async function recordOpening(client: PoolClient, orderId: string, actor: Actor, lines: LineQty[], requestId: string): Promise<Command> {
  if (actor.realm !== "admin") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  if (order.status !== "PAID") return blocked(["ORDER_NOT_PAID"]);
  const payment = await appliedPayment(client, orderId);
  if (!payment || payment.currency !== "CNY") return blocked(["PAYMENT_BASIS_MISSING"]);
  const built = basisOrReasons(order, payment, lines);
  if ("reasons" in built) return blocked(built.reasons);
  if ((await client.query(`SELECT 1 FROM zzsh_order.rental_opening WHERE order_id = $1 AND status = 'CONFIRMED'`, [orderId])).rowCount) return blocked(["OPENING_IMMUTABLE"]);
  const versionNo = Number((await client.query<{ n: number }>(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM zzsh_order.rental_opening WHERE order_id = $1`, [orderId])).rows[0]!.n);
  const id = `opening_${randomUUID().replaceAll("-", "")}`;
  const stored = built.basis.lines.map((line) => ({ itemId: line.itemId, quantity: line.openingQuantity }));
  await client.query(
    `INSERT INTO zzsh_order.rental_opening (id, order_id, version_no, quote_digest, payment_digest, lines, status, created_by_admin_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'DRAFT', $7)`,
    [id, orderId, versionNo, built.basis.quoteDigest, built.basis.paymentDigest, JSON.stringify(stored), actor.userId],
  );
  await audit(client, actor, "order.opening.recorded", orderId, requestId, { openingId: id, versionNo });
  return view(client, order);
}

export async function confirmOpening(client: PoolClient, orderId: string, openingId: string, versionNo: number, actor: Actor, requestId: string): Promise<Command> {
  if (actor.realm !== "user") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  const opening = (await client.query<{ id: string; versionNo: number; status: string }>(
    `SELECT id, version_no AS "versionNo", status FROM zzsh_order.rental_opening WHERE id = $1 AND order_id = $2 FOR UPDATE`,
    [openingId, orderId],
  )).rows[0];
  const latest = (await client.query<{ versionNo: number }>(`SELECT MAX(version_no) AS "versionNo" FROM zzsh_order.rental_opening WHERE order_id = $1`, [orderId])).rows[0];
  if (!opening || opening.versionNo !== versionNo || opening.versionNo !== Number(latest?.versionNo)) return blocked(["STALE_OPENING"]);
  if (opening.status === "CONFIRMED") return view(client, order);
  const party = partyOf(order, actor.userId);
  await client.query(
    `INSERT INTO zzsh_order.rental_opening_ack (opening_id, party, user_id, version_no) VALUES ($1, $2, $3, $4)
     ON CONFLICT (opening_id, party) DO NOTHING`,
    [opening.id, party, actor.userId, opening.versionNo],
  );
  const acks = (await client.query<{ party: string }>(`SELECT party FROM zzsh_order.rental_opening_ack WHERE opening_id = $1`, [opening.id])).rows.map((row) => row.party);
  if (acks.includes("RENTER") && acks.includes("OWNER")) {
    const confirmed = await client.query(
      `UPDATE zzsh_order.rental_opening SET status = 'CONFIRMED', confirmed_at = clock_timestamp()
        WHERE id = $1 AND status = 'DRAFT' AND version_no = $2`,
      [opening.id, opening.versionNo],
    );
    if (confirmed.rowCount !== 1) return blocked(["STALE_OPENING"]);
  }
  await audit(client, actor, "order.opening.confirmed", orderId, requestId, { openingId: opening.id, party });
  return view(client, order);
}

async function loadBill(client: PoolClient, order: LockedOrder, remaining: LineQty[]): Promise<{ opening: { id: string; versionNo: number }; basis: Basis; lines: SettlementInventoryLine[] } | Command> {
  if (order.status !== "PAID") return blocked(["ORDER_NOT_PAID"]);
  const payment = await appliedPayment(client, order.id);
  const opening = await confirmedOpening(client, order.id);
  if (!payment || !opening) return blocked([payment ? "OPENING_REQUIRED" : "PAYMENT_BASIS_MISSING"]);
  const built = basisOrReasons(order, payment, opening.lines);
  if ("reasons" in built) return blocked(built.reasons);
  if (built.basis.quoteDigest !== opening.quoteDigest || built.basis.paymentDigest !== opening.paymentDigest) return blocked(["BASIS_CHANGED"]);
  const filled = withRemaining(built.basis, remaining);
  if ("reasons" in filled) return blocked(filled.reasons);
  return { opening, basis: built.basis, lines: filled.lines };
}

async function insertVersion(client: PoolClient, input: {
  order: LockedOrder; actor: Actor; openingId: string; kind: "SYSTEM" | "MANUAL_ADJUSTMENT"; endReason: SettlementEndReason;
  lines: SettlementInventoryLine[]; basis: Basis; proposedOwnerNet: string | null; proposedRenterRefund: string | null; reason: string | null;
  approvalRequestId: string | null; requestId: string; confirmInitiator: boolean; base: AcceptanceBase;
}): Promise<Command> {
  const versionId = `settle_${randomUUID().replaceAll("-", "")}`;
  const probed = probe(input.order, input.openingId, input.basis, input.lines, input.endReason, versionId);
  if (!probed.ok || probed.early === null || !probed.amounts || probed.early !== (input.endReason !== "NORMAL")) {
    throw conflict(probed.reasons[0] ?? "Settlement blocked");
  }
  const payload = payloadFor({
    order: input.order, openingId: input.openingId, openingVersion: (await confirmedOpening(client, input.order.id))!.versionNo,
    basis: input.basis, lines: input.lines, kind: input.kind, endReason: input.endReason, early: probed.early, result: probed,
    proposedOwnerNet: input.proposedOwnerNet, proposedRenterRefund: input.proposedRenterRefund, reason: input.reason, base: input.base,
  });
  const hashed = hashApprovalPayload(payload);
  if (input.approvalRequestId) {
    const approval = (await client.query<{ hash: string }>(`SELECT operation_payload_hash AS hash FROM zzsh_iam.approval_request WHERE id = $1`, [input.approvalRequestId])).rows[0];
    if (!approval || approval.hash !== hashed.hash) return blocked(["OPS_PAYLOAD_STALE"]);
  }
  await client.query(`UPDATE zzsh_order.settlement_version SET superseded_at = clock_timestamp() WHERE order_id = $1 AND superseded_at IS NULL`, [input.order.id]);
  const versionNo = Number((await client.query<{ n: number }>(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM zzsh_order.settlement_version WHERE order_id = $1`, [input.order.id])).rows[0]!.n);
  const ownerNet = yuanToCents(probed.amounts.ownerNet, "owner net");
  const renterRefund = yuanToCents(probed.amounts.renterRefund, "renter refund");
  const initiator: ConfirmationParty = input.actor.realm === "admin" ? "SUPPORT" : partyOf(input.order, input.actor.userId);
  await client.query(
    `INSERT INTO zzsh_order.settlement_version (
       id, order_id, opening_id, version_no, kind, end_reason, early, initiator_party, initiator_subject_id,
       basis_hash, version_hash, input_snapshot, computation, system_owner_net_cents, system_renter_refund_cents,
       proposed_owner_net_cents, proposed_renter_refund_cents, approval_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17)`,
    [versionId, input.order.id, input.openingId, versionNo, input.kind, input.endReason, probed.early, initiator, input.actor.userId,
      hashed.hash, JSON.stringify(hashed.value), JSON.stringify({ ...probed, feeDeducted: false }), ownerNet.toString(), renterRefund.toString(),
      input.proposedOwnerNet === null ? null : yuanToCents({ currency: "CNY", unit: "yuan", amount: input.proposedOwnerNet, scale: 2 }, "proposed owner net").toString(),
      input.proposedRenterRefund === null ? null : yuanToCents({ currency: "CNY", unit: "yuan", amount: input.proposedRenterRefund, scale: 2 }, "proposed renter refund").toString(),
      input.approvalRequestId],
  );
  if (input.confirmInitiator) {
    await client.query(
      `INSERT INTO zzsh_order.settlement_decision (id, settlement_version_id, version_hash, basis_hash, party, action, subject_id)
       VALUES ($1, $2, $3, $3, $4, 'CONFIRM', $5)`,
      [`sdec_${randomUUID().replaceAll("-", "")}`, versionId, hashed.hash, initiator, input.actor.userId],
    );
  }
  const linkedIntake = await linkIntake(client, input.order.id, versionId, input.base, input.lines);
  await audit(client, input.actor, input.kind === "MANUAL_ADJUSTMENT" ? "order.settlement.adjusted" : "order.settlement.submitted", input.order.id, input.requestId, {
    settlementVersionId: versionId,
    versionHash: hashed.hash,
    ...(linkedIntake ? {
      intakeId: linkedIntake.id,
      intakeVersionNo: linkedIntake.versionNo,
      intakeSourceLines: linkedIntake.sourceLines,
      classifiedLines: linkedIntake.classifiedLines,
      intakeQuantityModified: linkedIntake.modified,
    } : {}),
  });
  return view(client, input.order);
}

async function recordIntake(client: PoolClient, order: LockedOrder, actor: Actor, opening: { id: string; versionNo: number }, basis: Basis, remaining: LineQty[], base: AcceptanceBase, requestId: string): Promise<Command> {
  const lines = stableRemaining(remaining);
  const basisHash = hashApprovalPayload({ openingId: opening.id, openingVersion: opening.versionNo, quoteDigest: basis.quoteDigest, paymentDigest: basis.paymentDigest }).hash;
  let superseded: { id: string; versionNo: number; lines: Array<{ itemId: string; remainingQuantity: string }> } | null = null;
  if (base.intake?.status === "OPEN") {
    const prior = (await client.query<{ lines: Array<{ itemId: string; remainingQuantity: string }> }>(
      `UPDATE zzsh_order.settlement_intake SET status = 'SUPERSEDED', superseded_at = clock_timestamp()
        WHERE id = $1 AND order_id = $2 AND version_no = $3 AND status = $4
        RETURNING lines`,
      [base.intake.id, order.id, base.intake.versionNo, base.intake.status],
    )).rows[0];
    if (!prior) return blocked(["SETTLEMENT_HASH_MISMATCH"]);
    superseded = { id: base.intake.id, versionNo: base.intake.versionNo, lines: prior.lines };
  }
  const versionNo = Number((await client.query<{ n: number }>(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM zzsh_order.settlement_intake WHERE order_id = $1`, [order.id])).rows[0]!.n);
  const id = `intake_${randomUUID().replaceAll("-", "")}`;
  const party = partyOf(order, actor.userId);
  await client.query(
    `INSERT INTO zzsh_order.settlement_intake (
       id, order_id, opening_id, version_no, initiator_party, initiator_subject_id, lines, basis_hash, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'OPEN')`,
    [id, order.id, opening.id, versionNo, party, actor.userId, JSON.stringify(lines), basisHash],
  );
  await audit(client, actor, "order.settlement.intake_recorded", order.id, requestId, {
    intakeId: id, versionNo, party, lines,
    ...(superseded ? { supersededIntake: superseded, replacementLines: lines } : {}),
  });
  return view(client, order);
}

async function linkIntake(client: PoolClient, orderId: string, versionId: string, base: AcceptanceBase, lines: SettlementInventoryLine[]): Promise<{
  id: string; versionNo: number; sourceLines: Array<{ itemId: string; remainingQuantity: string }>;
  classifiedLines: Array<{ itemId: string; remainingQuantity: string }>; modified: boolean;
} | null> {
  const expected = base.intake;
  if (expected?.status !== "OPEN") return null;
  const classifiedLines = stableRemaining(lines.map((line) => ({ itemId: line.itemId, quantity: line.remainingQuantity! })));
  const linked = (await client.query<{ lines: Array<{ itemId: string; remainingQuantity: string }> }>(
    `UPDATE zzsh_order.settlement_intake
        SET status = 'CLASSIFIED', classified_at = clock_timestamp(), settlement_version_id = $2
      WHERE id = $1 AND order_id = $3 AND version_no = $4 AND status = $5 AND settlement_version_id IS NULL
      RETURNING lines`,
    [expected.id, versionId, orderId, expected.versionNo, expected.status],
  )).rows[0];
  if (!linked) throw conflict("Settlement intake changed; reload preview");
  return {
    id: expected.id,
    versionNo: expected.versionNo,
    sourceLines: linked.lines,
    classifiedLines,
    modified: hashApprovalPayload({ lines: linked.lines }).hash !== hashApprovalPayload({ lines: classifiedLines }).hash,
  };
}

export async function previewSettlement(client: PoolClient, orderId: string, actor: Actor, remaining: LineQty[]): Promise<Command> {
  if (actor.realm !== "user") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  const bill = await loadBill(client, order, remaining);
  if ("status" in bill) return bill;
  const base = await acceptanceBase(client, order.id);
  const result = probe(order, bill.opening.id, bill.basis, bill.lines, "NORMAL", "preview");
  if (needsEarlyReason(result)) {
    const credential = hashApprovalPayload(intakePayload(order, bill.opening, bill.basis, remaining, base)).hash;
    return done({ accepted: false, early: true, reasons: ["EARLY_REASON_REQUIRED"], amounts: null, versionHash: credential, baseVersionId: base.versionId }, order.status);
  }
  if (!result.ok || result.early !== false || !result.amounts) return blocked(result.reasons);
  const payload = payloadFor({
    order, openingId: bill.opening.id, openingVersion: bill.opening.versionNo, basis: bill.basis, lines: bill.lines,
    kind: "SYSTEM", endReason: "NORMAL", early: false, result, proposedOwnerNet: null, proposedRenterRefund: null, reason: null, base,
  });
  return done({ accepted: false, early: false, reasons: [], amounts: payload.amounts, versionHash: hashApprovalPayload(payload).hash, baseVersionId: base.versionId, consumed: result.consumed }, order.status);
}

export async function submitSettlement(client: PoolClient, orderId: string, actor: Actor, remaining: LineQty[], acceptedHash: string, requestId: string): Promise<Command> {
  if (actor.realm !== "user") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  const bill = await loadBill(client, order, remaining);
  if ("status" in bill) return bill;
  const base = await acceptanceBase(client, order.id);
  const result = probe(order, bill.opening.id, bill.basis, bill.lines, "NORMAL", "preview");
  if (needsEarlyReason(result)) {
    if (hashApprovalPayload(intakePayload(order, bill.opening, bill.basis, remaining, base)).hash !== acceptedHash) return blocked(["SETTLEMENT_HASH_MISMATCH"]);
    return recordIntake(client, order, actor, bill.opening, bill.basis, remaining, base, requestId);
  }
  if (!result.ok || result.early !== false || !result.amounts) return blocked(result.reasons);
  const payload = payloadFor({
    order, openingId: bill.opening.id, openingVersion: bill.opening.versionNo, basis: bill.basis, lines: bill.lines,
    kind: "SYSTEM", endReason: "NORMAL", early: false, result, proposedOwnerNet: null, proposedRenterRefund: null, reason: null, base,
  });
  if (hashApprovalPayload(payload).hash !== acceptedHash) return blocked(["SETTLEMENT_HASH_MISMATCH"]);
  return insertVersion(client, {
    order, actor, openingId: bill.opening.id, kind: "SYSTEM", endReason: "NORMAL", lines: bill.lines, basis: bill.basis,
    proposedOwnerNet: null, proposedRenterRefund: null, reason: null, approvalRequestId: null, requestId, confirmInitiator: true, base,
  });
}

export async function previewStaffSettlement(client: PoolClient, orderId: string, actor: Actor, input: {
  remaining: LineQty[]; endReason: EarlyReason | null; proposedOwnerNet?: string; proposedRenterRefund?: string; reason?: string;
}): Promise<Command> {
  if (actor.realm !== "admin") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  const bill = await loadBill(client, order, input.remaining);
  if ("status" in bill) return bill;
  const base = await acceptanceBase(client, order.id);
  const normal = probe(order, bill.opening.id, bill.basis, bill.lines, "NORMAL", "preview");
  const early = needsEarlyReason(normal);
  if (input.proposedOwnerNet !== undefined || input.proposedRenterRefund !== undefined) {
    if (early && !input.endReason) return blocked(["EARLY_REASON_REQUIRED"]);
    if (!early && input.endReason) return blocked(["END_REASON_INCONSISTENT"]);
    const endReason: SettlementEndReason = early ? input.endReason! : "NORMAL";
    const result = early ? probe(order, bill.opening.id, bill.basis, bill.lines, endReason, "preview") : normal;
    if (!result.ok || !result.amounts || result.early !== early) return blocked(result.reasons.length ? result.reasons : ["SETTLEMENT_NOT_COMPUTABLE"]);
    const proposedOwnerNet = yuanField(input.proposedOwnerNet ?? "");
    const proposedRenterRefund = yuanField(input.proposedRenterRefund ?? "");
    const payload = payloadFor({
      order, openingId: bill.opening.id, openingVersion: bill.opening.versionNo, basis: bill.basis, lines: bill.lines,
      kind: "MANUAL_ADJUSTMENT", endReason, early, result, proposedOwnerNet, proposedRenterRefund, reason: input.reason ?? null, base,
    });
    return done({ accepted: false, early, amounts: payload.amounts, versionHash: hashApprovalPayload(payload).hash, baseVersionId: base.versionId, systemOwnerNet: result.amounts.ownerNet.amount, systemRenterRefund: result.amounts.renterRefund.amount }, order.status);
  }
  if (!input.endReason) return blocked(early ? ["EARLY_REASON_REQUIRED"] : ["END_REASON_INCONSISTENT"]);
  if (!early) return blocked(normal.ok ? ["END_REASON_INCONSISTENT"] : normal.reasons);
  const result = probe(order, bill.opening.id, bill.basis, bill.lines, input.endReason, "preview");
  if (!result.ok || result.early !== true || !result.amounts) return blocked(result.reasons);
  const payload = payloadFor({
    order, openingId: bill.opening.id, openingVersion: bill.opening.versionNo, basis: bill.basis, lines: bill.lines,
    kind: "SYSTEM", endReason: input.endReason, early: true, result, proposedOwnerNet: null, proposedRenterRefund: null, reason: null, base,
  });
  return done({ accepted: false, early: true, amounts: payload.amounts, versionHash: hashApprovalPayload(payload).hash, baseVersionId: base.versionId }, order.status);
}

export async function classifySettlement(client: PoolClient, orderId: string, actor: Actor, remaining: LineQty[], endReason: EarlyReason, acceptedHash: string, requestId: string): Promise<Command> {
  if (actor.realm !== "admin") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  const bill = await loadBill(client, order, remaining);
  if ("status" in bill) return bill;
  const base = await acceptanceBase(client, order.id);
  const normal = probe(order, bill.opening.id, bill.basis, bill.lines, "NORMAL", "preview");
  if (!needsEarlyReason(normal)) return blocked(normal.ok ? ["END_REASON_INCONSISTENT"] : normal.reasons);
  const result = probe(order, bill.opening.id, bill.basis, bill.lines, endReason, "preview");
  if (!result.ok || result.early !== true || !result.amounts) return blocked(result.reasons);
  const payload = payloadFor({
    order, openingId: bill.opening.id, openingVersion: bill.opening.versionNo, basis: bill.basis, lines: bill.lines,
    kind: "SYSTEM", endReason, early: true, result, proposedOwnerNet: null, proposedRenterRefund: null, reason: null, base,
  });
  if (hashApprovalPayload(payload).hash !== acceptedHash) return blocked(["SETTLEMENT_HASH_MISMATCH"]);
  return insertVersion(client, {
    order, actor, openingId: bill.opening.id, kind: "SYSTEM", endReason, lines: bill.lines, basis: bill.basis,
    proposedOwnerNet: null, proposedRenterRefund: null, reason: null, approvalRequestId: null, requestId, confirmInitiator: false, base,
  });
}

function yuanField(value: string): string {
  if (!/^(0|[1-9]\d{0,18})\.\d{2}$/.test(value)) throw invalid("Amount is invalid");
  return value;
}

export async function adjustSettlement(client: PoolClient, orderId: string, actor: Actor, input: {
  remaining: LineQty[]; endReason: EarlyReason | null; proposedOwnerNet: string; proposedRenterRefund: string; reason: string; acceptedHash: string; requestId: string;
}): Promise<Command> {
  if (actor.realm !== "admin") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  const access = await lockActor(client, actor.userId);
  requirePermission(access, ADMIN_PERMISSION.approvalRequestCreate);
  const bill = await loadBill(client, order, input.remaining);
  if ("status" in bill) return bill;
  const base = await acceptanceBase(client, order.id);
  const normal = probe(order, bill.opening.id, bill.basis, bill.lines, "NORMAL", "preview");
  const early = needsEarlyReason(normal);
  if (early && !input.endReason) return blocked(["EARLY_REASON_REQUIRED"]);
  if (!early && input.endReason) return blocked(["END_REASON_INCONSISTENT"]);
  const endReason: SettlementEndReason = early ? input.endReason! : "NORMAL";
  const result = early ? probe(order, bill.opening.id, bill.basis, bill.lines, endReason, "preview") : normal;
  if (!result.ok || !result.amounts || result.early !== early) return blocked(result.reasons.length ? result.reasons : ["SETTLEMENT_NOT_COMPUTABLE"]);
  const proposedOwner = yuanField(input.proposedOwnerNet);
  const proposedRefund = yuanField(input.proposedRenterRefund);
  const captured = yuanToCents({ currency: "CNY", unit: "yuan", amount: bill.basis.captured, scale: 2 }, "captured");
  const proposedSum = yuanToCents({ currency: "CNY", unit: "yuan", amount: proposedOwner, scale: 2 }, "proposed owner net")
    + yuanToCents({ currency: "CNY", unit: "yuan", amount: proposedRefund, scale: 2 }, "proposed renter refund");
  if (proposedSum > captured) return blocked(["FUNDING_SOURCE_REQUIRED"]);
  const payload = payloadFor({
    order, openingId: bill.opening.id, openingVersion: bill.opening.versionNo, basis: bill.basis, lines: bill.lines,
    kind: "MANUAL_ADJUSTMENT", endReason, early, result, proposedOwnerNet: proposedOwner, proposedRenterRefund: proposedRefund, reason: input.reason, base,
  });
  const hashed = hashApprovalPayload(payload);
  if (hashed.hash !== input.acceptedHash) return blocked(["SETTLEMENT_HASH_MISMATCH"]);
  const template = (await client.query<{ id: string; version: number }>(
    `SELECT id, version FROM zzsh_iam.approval_template WHERE operation_code = $1 AND trigger_condition = $2 FOR UPDATE`,
    [SETTLEMENT_ADJUST_OPERATION, SETTLEMENT_ADJUST_TRIGGER],
  )).rows[0];
  if (!template) throw new SecurityApiError(404, "NOT_FOUND", "Approval template not found");
  const candidates = (await client.query<{ adminUserId: string }>(
    `SELECT admin_user_id AS "adminUserId" FROM zzsh_iam.approval_template_candidate WHERE template_id = $1 ORDER BY admin_user_id`,
    [template.id],
  )).rows;
  if (candidates.length < 1) return blocked(["OPS_APPROVAL_MISSING"]);
  const approvalId = `approval_req_${randomUUID().replaceAll("-", "")}`;
  const summary = input.reason.trim().slice(0, 240);
  await client.query(
    `INSERT INTO zzsh_iam.approval_request (
       id, template_id, template_version, operation_code, trigger_condition, payload_version, operation_payload,
       operation_payload_hash, summary, requested_by, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6::jsonb, $7, $8, $9, 'PENDING', clock_timestamp() + interval '24 hours')`,
    [approvalId, template.id, template.version, SETTLEMENT_ADJUST_OPERATION, SETTLEMENT_ADJUST_TRIGGER, hashed.raw, hashed.hash, summary, actor.userId],
  );
  for (const candidate of candidates) {
    await client.query(
      `INSERT INTO zzsh_iam.approval_request_candidate (request_id, admin_user_id, source, template_version) VALUES ($1, $2, 'TEMPLATE', $3)`,
      [approvalId, candidate.adminUserId, template.version],
    );
  }
  await recordAudit(client, {
    actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, action: "approval.request.created",
    objectType: "approval_request", objectId: approvalId, outcome: "SUCCESS", requestId: input.requestId,
    details: { operationCode: SETTLEMENT_ADJUST_OPERATION, operationPayloadHash: hashed.hash },
  });
  return insertVersion(client, {
    order, actor, openingId: bill.opening.id, kind: "MANUAL_ADJUSTMENT", endReason, lines: bill.lines, basis: bill.basis,
    proposedOwnerNet: proposedOwner, proposedRenterRefund: proposedRefund, reason: input.reason, approvalRequestId: approvalId,
    requestId: input.requestId, confirmInitiator: false, base,
  });
}

type CurrentSettlementVersion = {
  id: string; versionNo: number; openingId: string; versionHash: string; basisHash: string;
  kind: "SYSTEM" | "MANUAL_ADJUSTMENT"; early: boolean; initiatorParty: ConfirmationParty;
  approvalRequestId: string | null; supersededAt: string | null; inputSnapshot: Record<string, unknown>;
  computation: SettlementComputation; systemOwnerNet: string; systemRenterRefund: string;
  proposedOwnerNet: string | null; proposedRenterRefund: string | null;
};

async function currentVersion(client: PoolClient, orderId: string, versionId: string): Promise<CurrentSettlementVersion | undefined> {
  return (await client.query<CurrentSettlementVersion>(
    `SELECT id, version_no AS "versionNo", opening_id AS "openingId", version_hash AS "versionHash", basis_hash AS "basisHash",
            kind, early, initiator_party AS "initiatorParty", approval_request_id AS "approvalRequestId",
            superseded_at::text AS "supersededAt", input_snapshot AS "inputSnapshot", computation,
            system_owner_net_cents::text AS "systemOwnerNet", system_renter_refund_cents::text AS "systemRenterRefund",
            proposed_owner_net_cents::text AS "proposedOwnerNet", proposed_renter_refund_cents::text AS "proposedRenterRefund"
       FROM zzsh_order.settlement_version WHERE id = $1 AND order_id = $2 FOR UPDATE`,
    [versionId, orderId],
  )).rows[0];
}

async function manualGap(client: PoolClient, version: { kind: "SYSTEM" | "MANUAL_ADJUSTMENT"; versionHash: string; approvalRequestId: string | null }): Promise<string | null> {
  if (version.kind !== "MANUAL_ADJUSTMENT") return null;
  if (!version.approvalRequestId) return "OPS_APPROVAL_MISSING";
  const approval = await readSettlementApproval(client, version.approvalRequestId);
  if (approval?.status === "EXPIRED") return "OPS_APPROVAL_EXPIRED";
  if (!approval || approval.status !== "APPROVED" || !approval.decidedBy) return "OPS_APPROVAL_MISSING";
  if (approval.decidedBy === approval.requestedBy) return "OPS_SELF_APPROVE";
  if (approval.payloadHash !== version.versionHash) return "OPS_PAYLOAD_STALE";
  return null;
}

function exactCents(value: unknown, label: string): bigint {
  if (typeof value !== "string") throw conflict(`${label}_INVALID`);
  const match = /^(-?)(0|[1-9]\d*)\.(\d{2})$/.exec(value);
  if (!match) throw conflict(`${label}_INVALID`);
  const magnitude = BigInt(match[2]!) * 100n + BigInt(match[3]!);
  if (match[1] === "-" && magnitude === 0n) throw conflict(`${label}_INVALID`);
  return match[1] === "-" ? -magnitude : magnitude;
}

function moneyString(cents: bigint): string {
  return centsToYuan(cents).amount;
}

function amountObject(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { currency?: unknown; unit?: unknown; scale?: unknown; amount?: unknown };
  return row.currency === "CNY" && row.unit === "yuan" && row.scale === 2 && typeof row.amount === "string" ? row.amount : null;
}

function addPostingEntry(entries: Array<Record<string, unknown>>, accountCode: string, value: bigint, details: Record<string, unknown>, extra: {
  counterpartyUserId?: string; sourcePaymentConfirmationId?: string;
} = {}): void {
  if (value === 0n) return;
  entries.push({
    id: `sledger_${randomUUID().replaceAll("-", "")}`,
    accountCode,
    debitCents: value < 0n ? (-value).toString() : "0",
    creditCents: value > 0n ? value.toString() : "0",
    details,
    ...extra,
  });
}

/** Posts only the immutable, currently accepted version; caller owns the order transaction and lock sequence. */
async function postReadySettlement(
  client: PoolClient,
  order: LockedOrder,
  versionId: string,
  actor: Actor,
  requestId: string,
  requireReady: boolean,
): Promise<void> {
  if (order.status !== "PAID") throw conflict("ORDER_NOT_SETTLEABLE");
  if ((await client.query(`SELECT 1 FROM zzsh_order.settlement_posting WHERE order_id = $1`, [order.id])).rowCount) {
    throw conflict("SETTLEMENT_ALREADY_POSTED");
  }
  const version = await currentVersion(client, order.id, versionId);
  if (!version || version.supersededAt || version.basisHash !== version.versionHash) throw conflict("STALE_VERSION");
  const snapshot = version.inputSnapshot;
  if (hashApprovalPayload(snapshot).hash !== version.versionHash) throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  if (snapshot.orderId !== order.id || snapshot.renterUserId !== order.renterUserId || snapshot.ownerUserId !== order.ownerUserId
      || snapshot.openingId !== version.openingId || snapshot.kind !== version.kind || snapshot.early !== version.early
      || snapshot.feePolicyVersion !== SETTLEMENT_FEE_POLICY_VERSION || snapshot.fullPayout !== "NOT_SELECTED") {
    throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  }

  const latestIntake = (await client.query<IntakeAcceptanceBase>(
    `SELECT id, version_no AS "versionNo", status, settlement_version_id AS "settlementVersionId"
       FROM zzsh_order.settlement_intake WHERE order_id = $1 ORDER BY version_no DESC LIMIT 1 FOR UPDATE`,
    [order.id],
  )).rows[0] ?? null;
  if (latestIntake?.status === "OPEN") throw conflict("SETTLEMENT_INTAKE_PENDING");
  const baseIntake = snapshot.baseIntake as IntakeAcceptanceBase | null;
  if (baseIntake === null) {
    if (latestIntake !== null) throw conflict("SETTLEMENT_INTAKE_STALE");
  } else if (!latestIntake || latestIntake.id !== baseIntake.id || latestIntake.versionNo !== baseIntake.versionNo
      || (baseIntake.status === "OPEN"
        ? latestIntake.status !== "CLASSIFIED" || latestIntake.settlementVersionId !== version.id
        : latestIntake.status !== baseIntake.status || latestIntake.settlementVersionId !== baseIntake.settlementVersionId)) {
    throw conflict("SETTLEMENT_INTAKE_STALE");
  }

  if (!Array.isArray(snapshot.lines) || snapshot.lines.length < 1) throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  const remaining: LineQty[] = [];
  for (const raw of snapshot.lines) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
    const line = raw as { itemId?: unknown; remainingQuantity?: unknown };
    if (typeof line.itemId !== "string" || typeof line.remainingQuantity !== "string") throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
    remaining.push({ itemId: line.itemId, quantity: line.remainingQuantity });
  }
  const bill = await loadBill(client, order, remaining);
  if ("status" in bill) throw conflict(String((bill.body.reasons as string[] | undefined)?.[0] ?? "SETTLEMENT_BASIS_INVALID"));
  const sameLines = hashApprovalPayload({ lines: snapshot.lines }).hash === hashApprovalPayload({
    lines: bill.lines.map((line) => ({ itemId: line.itemId, openingQuantity: line.openingQuantity, remainingQuantity: line.remainingQuantity })),
  }).hash;
  if (!sameLines || snapshot.openingVersion !== String(bill.opening.versionNo)
      || snapshot.quoteDigest !== bill.basis.quoteDigest || snapshot.paymentDigest !== bill.basis.paymentDigest
      || snapshot.paymentConfirmationId !== bill.basis.paymentConfirmationId || snapshot.capturedAmount !== bill.basis.captured
      || snapshot.depositAmount !== bill.basis.deposit || snapshot.fundingSourceRef !== bill.basis.fundingSourceRef
      || snapshot.fundingPolicyRef !== bill.basis.fundingPolicyRef) {
    throw conflict("SETTLEMENT_BASIS_STALE");
  }

  const computation = version.computation;
  if (!computation?.ok || computation.early !== version.early || !computation.amounts) throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  const amounts = snapshot.amounts as Record<string, unknown> | undefined;
  if (!amounts) throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  const computed = computation.amounts;
  const computedFields = [
    "haffSpread", "itemSpread", "unusedItemRefund", "unusedHaffRefund", "earlyMakeup", "feeBase", "feeAmount",
    "ownerGross", "ownerNet", "renterCharge", "renterRefund", "depositRefund", "platformContribution",
  ] as const;
  for (const field of computedFields) {
    if (amountObject(computed[field]) !== amounts[field]) throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  }
  if (computed.feeRate !== amounts.feeRate || computed.feePayer !== amounts.feePayer) throw conflict("SETTLEMENT_SNAPSHOT_INVALID");

  const captured = exactCents(snapshot.capturedAmount, "CAPTURED_AMOUNT");
  const systemOwner = exactCents(amounts.ownerNet, "OWNER_NET");
  const systemRefund = exactCents(amounts.renterRefund, "RENTER_REFUND");
  const systemPlatform = ["haffSpread", "itemSpread", "earlyMakeup", "feeAmount"]
    .map((field) => exactCents(amounts[field], field.toUpperCase()))
    .reduce((sum, value) => sum + value, 0n);
  if (systemPlatform !== exactCents(amounts.platformContribution, "PLATFORM_CONTRIBUTION")
      || systemOwner !== BigInt(version.systemOwnerNet) || systemRefund !== BigInt(version.systemRenterRefund)) {
    throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  }

  const manualReason = version.kind === "MANUAL_ADJUSTMENT" ? snapshot.reason : null;
  if (version.kind === "MANUAL_ADJUSTMENT" && (typeof manualReason !== "string" || manualReason.trim().length < 3
      || version.proposedOwnerNet === null || version.proposedRenterRefund === null)) {
    throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  }
  const ownerNet = version.kind === "MANUAL_ADJUSTMENT" ? BigInt(version.proposedOwnerNet!) : systemOwner;
  const renterRefund = version.kind === "MANUAL_ADJUSTMENT" ? BigInt(version.proposedRenterRefund!) : systemRefund;
  if (version.kind === "MANUAL_ADJUSTMENT"
      && (exactCents(snapshot.proposedOwnerNet, "OWNER_NET") !== ownerNet
        || exactCents(snapshot.proposedRenterRefund, "RENTER_REFUND") !== renterRefund)) {
    throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  }
  const adjustment = systemOwner + systemRefund - ownerNet - renterRefund;
  const platformContribution = systemPlatform + adjustment;
  if (captured < 0n || ownerNet < 0n || renterRefund < 0n || platformContribution < 0n
      || ownerNet + renterRefund + platformContribution !== captured) {
    throw conflict("FUNDING_SOURCE_REQUIRED");
  }
  const fee = exactCents(amounts.feeAmount, "COMPENSATION_FEE");
  if (fee < 0n || exactCents(amounts.feeBase, "COMPENSATION_FEE_BASE") < 0n
      || !["OWNER", "RENTER", "NONE"].includes(String(amounts.feePayer))) {
    throw conflict("SETTLEMENT_SNAPSHOT_INVALID");
  }

  let approval: { requestedBy: string; decidedBy: string; expiresAt: string; payloadHash: string } | null = null;
  if (version.kind === "MANUAL_ADJUSTMENT") {
    const row = (await client.query<{ status: string; requestedBy: string; decidedBy: string | null; expiresAt: string; payloadHash: string }>(
      `SELECT status, requested_by AS "requestedBy", decided_by AS "decidedBy", expires_at::text AS "expiresAt",
              operation_payload_hash AS "payloadHash"
         FROM zzsh_iam.approval_request WHERE id = $1 FOR SHARE`,
      [version.approvalRequestId],
    )).rows[0];
    if (!row || row.status !== "APPROVED" || !row.decidedBy || row.decidedBy === row.requestedBy || row.payloadHash !== version.versionHash) {
      throw conflict("OPS_APPROVAL_MISSING");
    }
    approval = { requestedBy: row.requestedBy, decidedBy: row.decidedBy, expiresAt: row.expiresAt, payloadHash: row.payloadHash };
  }
  const postedAt = (await client.query<{ postedAt: string }>(`SELECT clock_timestamp()::text AS "postedAt"`)).rows[0]!.postedAt;
  const readiness = await readyFacts(client, version, postedAt);
  if (!readiness.ready) {
    const waitReasons = new Set(["RENTER_CONFIRMATION_MISSING", "OWNER_CONFIRMATION_MISSING", "SUPPORT_REVIEW_MISSING", "PARTY_REJECTED"]);
    if (!requireReady && readiness.reasons.length > 0 && readiness.reasons.every((reason) => waitReasons.has(reason))) return;
    throw conflict(readiness.reasons[0] ?? "SETTLEMENT_NOT_READY");
  }
  if (approval && Date.parse(approval.expiresAt) <= Date.parse(postedAt)) throw conflict("OPS_APPROVAL_EXPIRED");

  const postingId = `spost_${randomUUID().replaceAll("-", "")}`;
  const header = (await client.query<{ postedAt: string; refundDueAt: string }>(
    `INSERT INTO zzsh_order.settlement_posting (
       id, order_id, settlement_version_id, payment_confirmation_id, version_hash, early,
       captured_cents, system_owner_net_cents, owner_net_cents, system_renter_refund_cents,
       renter_refund_cents, platform_contribution_cents, compensation_fee_cents, manual_reason,
       approval_request_id, approval_requested_by, approval_approved_by, approval_expires_at, approval_payload_hash,
       posted_at, refund_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::timestamptz,NULL)
     RETURNING posted_at::text AS "postedAt", refund_due_at::text AS "refundDueAt"`,
    [postingId, order.id, version.id, bill.basis.paymentConfirmationId, version.versionHash, version.early,
      captured.toString(), systemOwner.toString(), ownerNet.toString(), systemRefund.toString(), renterRefund.toString(),
      platformContribution.toString(), fee.toString(), manualReason, version.approvalRequestId,
      approval?.requestedBy ?? null, approval?.decidedBy ?? null, approval?.expiresAt ?? null, approval?.payloadHash ?? null, postedAt],
  )).rows[0]!;

  const entries: Array<Record<string, unknown>> = [];
  addPostingEntry(entries, "CAPTURED_PAYMENT_SOURCE", -captured, {
    paymentConfirmationId: bill.basis.paymentConfirmationId, disposition: "APPLIED", fundingSourceRef: bill.basis.fundingSourceRef,
  }, { sourcePaymentConfirmationId: bill.basis.paymentConfirmationId });
  addPostingEntry(entries, "OWNER_AVAILABLE", ownerNet, {
    settlementVersionId: version.id, versionHash: version.versionHash,
    systemGross: computed.ownerGross, systemNet: moneyString(systemOwner), postedNet: moneyString(ownerNet),
    feePayer: amounts.feePayer, compensationFee: computed.feeAmount,
  }, { counterpartyUserId: order.ownerUserId });
  addPostingEntry(entries, "RENTER_REFUND_PAYABLE", renterRefund, {
    settlementVersionId: version.id, versionHash: version.versionHash, dueAt: header.refundDueAt,
    systemRefund: moneyString(systemRefund), depositRefund: computed.depositRefund,
    unusedItemRefund: computed.unusedItemRefund, unusedHaffRefund: computed.unusedHaffRefund,
  }, { counterpartyUserId: order.renterUserId });
  addPostingEntry(entries, "PLATFORM_HAFF_SPREAD", exactCents(amounts.haffSpread, "HAFF_SPREAD"), { amount: computed.haffSpread });
  addPostingEntry(entries, "PLATFORM_ITEM_SPREAD", exactCents(amounts.itemSpread, "ITEM_SPREAD"), { amount: computed.itemSpread });
  addPostingEntry(entries, "PLATFORM_EARLY_MAKEUP", exactCents(amounts.earlyMakeup, "EARLY_MAKEUP"), {
    amount: computed.earlyMakeup, endReason: snapshot.endReason,
  });
  addPostingEntry(entries, "PLATFORM_COMPENSATION_FEE", fee, {
    base: computed.feeBase, rate: amounts.feeRate, payer: amounts.feePayer, policyVersion: SETTLEMENT_FEE_POLICY_VERSION,
  });
  addPostingEntry(entries, "PLATFORM_MANUAL_NET_ADJUSTMENT", adjustment, {
    reason: manualReason, systemOwnerNet: moneyString(systemOwner), postedOwnerNet: moneyString(ownerNet),
    systemRenterRefund: moneyString(systemRefund), postedRenterRefund: moneyString(renterRefund),
    deltaOwnerNet: moneyString(ownerNet - systemOwner), deltaRenterRefund: moneyString(renterRefund - systemRefund),
    approvalRequestId: version.approvalRequestId,
  });
  for (const [index, entry] of entries.entries()) {
    await client.query(
      `INSERT INTO zzsh_order.settlement_ledger_entry
         (id, posting_id, line_no, account_code, debit_cents, credit_cents, counterparty_user_id, source_payment_confirmation_id, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [entry.id, postingId, index + 1, entry.accountCode, entry.debitCents, entry.creditCents,
        entry.counterpartyUserId ?? null, entry.sourcePaymentConfirmationId ?? null, JSON.stringify(entry.details)],
    );
  }
  const completed = await client.query(
    `UPDATE zzsh_order.rental_order SET status = 'COMPLETED', updated_at = clock_timestamp(), revision = revision + 1
      WHERE id = $1 AND status = 'PAID'`,
    [order.id],
  );
  if (completed.rowCount !== 1) throw conflict("ORDER_NOT_SETTLEABLE");
  order.status = "COMPLETED";
  order.revision = (BigInt(order.revision) + 1n).toString();
  await audit(client, actor, "order.settlement.posted", order.id, requestId, {
    postingId, settlementVersionId: version.id, versionHash: version.versionHash,
    paymentConfirmationId: bill.basis.paymentConfirmationId, postedAt: header.postedAt, refundDueAt: header.refundDueAt,
    capturedCents: captured.toString(), ownerNetCents: ownerNet.toString(), renterRefundCents: renterRefund.toString(),
    platformContributionCents: platformContribution.toString(), compensationFeeCents: fee.toString(),
  });
}

export async function decideSettlement(client: PoolClient, orderId: string, versionId: string, actor: Actor, action: "CONFIRM" | "REJECT", versionHash: string, reason: string | null, requestId: string): Promise<Command> {
  if (actor.realm !== "user") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  const version = await currentVersion(client, orderId, versionId);
  if (!version || version.supersededAt || version.versionHash !== versionHash) return blocked(["STALE_VERSION"]);
  const party = partyOf(order, actor.userId);
  if (action === "REJECT" && !reason) throw invalid("A rejection reason is required");
  if (action === "CONFIRM") {
    if ((await client.query(`SELECT 1 FROM zzsh_order.settlement_intake WHERE order_id = $1 AND status = 'OPEN' LIMIT 1`, [orderId])).rowCount) {
      return blocked(["SETTLEMENT_INTAKE_PENDING"]);
    }
    const gap = await manualGap(client, version);
    if (gap) return blocked([gap]);
  }
  const existing = (await client.query<{ action: string }>(
    `SELECT action FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND party = $2 AND action IN ('CONFIRM','REJECT')`,
    [version.id, party],
  )).rows[0];
  if (existing && existing.action !== action) return blocked(["PARTY_ALREADY_DECIDED"]);
  if (!existing) {
    await client.query(
      `INSERT INTO zzsh_order.settlement_decision (id, settlement_version_id, version_hash, basis_hash, party, action, subject_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [`sdec_${randomUUID().replaceAll("-", "")}`, version.id, version.versionHash, version.basisHash, party, action, actor.userId, reason],
    );
  }
  await audit(client, actor, "order.settlement.decided", orderId, requestId, { settlementVersionId: version.id, party, action });
  if (action === "CONFIRM") await postReadySettlement(client, order, version.id, actor, requestId, false);
  return view(client, order);
}

export async function reviewSettlement(client: PoolClient, orderId: string, versionId: string, actor: Actor, versionHash: string, requestId: string): Promise<Command> {
  if (actor.realm !== "admin") throw forbidden();
  const order = await lockSettlement(client, orderId, actor, true);
  const version = await currentVersion(client, orderId, versionId);
  if (!version || version.supersededAt || version.versionHash !== versionHash) return blocked(["STALE_VERSION"]);
  if (!version.early) return blocked(["SUPPORT_REVIEW_NOT_REQUIRED"]);
  if ((await client.query(`SELECT 1 FROM zzsh_order.settlement_intake WHERE order_id = $1 AND status = 'OPEN' LIMIT 1`, [orderId])).rowCount) {
    return blocked(["SETTLEMENT_INTAKE_PENDING"]);
  }
  const decisions = (await client.query<{ party: string; action: string }>(
    `SELECT party, action FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND party IN ('RENTER','OWNER')`,
    [version.id],
  )).rows;
  if (decisions.some((row) => row.action === "REJECT")) return blocked(["PARTY_REJECTED"]);
  if (!decisions.some((row) => row.party === "RENTER" && row.action === "CONFIRM") || !decisions.some((row) => row.party === "OWNER" && row.action === "CONFIRM")) {
    return blocked(["PARTY_CONFIRMATION_MISSING"]);
  }
  const gap = await manualGap(client, version);
  if (gap) return blocked([gap]);
  const existing = await client.query(`SELECT 1 FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND party = 'SUPPORT' AND action = 'REVIEW'`, [version.id]);
  if (!existing.rowCount) {
    await client.query(
      `INSERT INTO zzsh_order.settlement_decision (id, settlement_version_id, version_hash, basis_hash, party, action, subject_id)
       VALUES ($1, $2, $3, $4, 'SUPPORT', 'REVIEW', $5)`,
      [`sdec_${randomUUID().replaceAll("-", "")}`, version.id, version.versionHash, version.basisHash, actor.userId],
    );
  }
  await audit(client, actor, "order.settlement.reviewed", orderId, requestId, { settlementVersionId: version.id, versionHash });
  await postReadySettlement(client, order, version.id, actor, requestId, true);
  return view(client, order);
}
