import { AdminApiError, adminRequest } from "../api";

/**
 * Admin-side adapter for the existing order settlement commands. The shared
 * order-team panel never calls these endpoints itself; the admin view injects
 * this adapter through a narrow slot. Amounts are always consumed from the
 * server projection; this module never computes money.
 *
 * Every write is sent as a frozen intent: order + action + body + idempotency
 * key stay stable so an unknown result can only be reconciled or replayed with
 * the SAME key, never replaced by a new request.
 */

export type FulfillmentLine = { itemId: string; quantity: string };
export type RemainingLine = { itemId: string; remainingQuantity: string } | { itemId: string; consumedQuantity: string };
export type EarlyEndReason = "TENANT_VOLUNTARY_EARLY" | "OWNER_OR_ACCOUNT_EARLY";
export type SettlementEndReason = "NORMAL" | EarlyEndReason;

export type SettlementAmount = { currency?: string; unit?: string; scale?: number; amount?: string };
export type FrozenInventoryLine = { itemId: string; quantity: string; unit: string; pricingKind: string; name: string | null };

export type SettlementVersionView = {
  id?: string;
  versionNo?: number;
  kind?: string;
  endReason?: string;
  early?: boolean;
  versionHash?: string;
  supersededAt?: string | null;
  proposedOwnerNet?: string | null;
  proposedRenterRefund?: string | null;
  inputSnapshot?: { proposedOwnerGross?: string | null; proposedFullPayoutFee?: string | null; proposedPlatformServiceFee?: string | null; lines?: Array<{ itemId?: string; openingQuantity?: string; remainingQuantity?: string; consumedQuantity?: string }> } | null;
  computation?: { ok?: boolean; reasons?: string[]; early?: boolean; amounts?: Record<string, SettlementAmount>; consumed?: { haff?: unknown; items?: Array<{ itemId?: string; consumed?: unknown; remaining?: unknown }> } } | null;
  decisions?: Array<{ party?: string; action?: string; reason?: string | null; versionHash?: string; createdAt?: string }>;
};

export type SettlementReadView = {
  orderId?: string;
  revision?: string;
  rentalStarted?: boolean;
  consumptionMode?: "REMAINING" | "ACTUAL" | "UNAVAILABLE";
  extraResources?: Array<{itemId:string;name:string|null;unit:string;pricingKind:string}>;
  intakes?: Array<{status:string;versionNo?:number;initiatorParty?:string;createdAt?:string;lines?:Array<{itemId:string;remainingQuantity?:string;consumedQuantity?:string}>}>;
  ready?: boolean;
  reasons?: string[];
  currentRequest?: { kind?: string; id?: string; versionNo?: number; status?: string } | null;
  settlement?: SettlementVersionView | null;
  openings?: Array<{ id?: string; versionNo?: number; status?: string; confirmedAt?: string | null; confirmSource?:string|null; createdBySource?:string|null; autoConfirmDueAt?:string|null; autoConfirmWaitMinutes?:number|null; createdAt?: string; lines?: Array<{ itemId?: string; quantity?: string; unit?: string; pricingKind?: string }>; acks?: Array<{ party?: string; source?: string; createdAt?: string }> }>;
  openingGeneration?: { state?: "CREATED" | "REVIEW_REQUIRED"; reason?: string | null; paymentConfirmationId?: string; createdAt?: string; updatedAt?: string } | null;
  openingGenerationRecoveryRequired?: boolean;
  posting?: { id?: string; settlementVersionId?: string; versionHash?: string; early?: boolean; postedAt?: string; refundDueAt?: string | null; amounts?: Record<string, SettlementAmount>;
    owner?:{availableCents?:string};refund?:{payableCents?:string};manualAdjustment?:{proposedOwnerGross?:string|null;proposedFullPayoutFee?:string|null;proposedPlatformServiceFee?:string|null}|null } | null;
  versions?: SettlementVersionView[];
  amounts?: Record<string, SettlementAmount>;
  consumed?: { haff?: unknown; items?: Array<{ itemId?: string; consumed?: unknown; remaining?: unknown }> };
  versionHash?: string;
  baseVersionId?: string;
  accepted?: boolean;
  early?: boolean;
  systemOwnerNet?: string;
  systemRenterRefund?: string;
  proposedOwnerGross?: string;
  proposedFullPayoutFee?: string;
  proposedPlatformServiceFee?: string;
  proposedMembershipDiscount?: string;
  proposedOwnerNet?: string;
  proposedRenterRefund?: string;
};

export type FulfillmentCommand =
  | { kind: "record-opening"; lines: FulfillmentLine[] }
  | { kind: "confirm-opening"; openingId: string; versionNo: number; party: "RENTER" | "OWNER"; reason: string }
  | { kind: "preview"; lines: RemainingLine[]; endReason?: EarlyEndReason; proposedOwnerGross?: string; proposedOwnerNet?: string; proposedRenterRefund?: string; reason?: string }
  | { kind: "classify"; lines: RemainingLine[]; endReason: SettlementEndReason; acceptedHash: string }
  | { kind: "review"; versionId: string; versionHash: string }
  | { kind: "finalize"; versionId: string; versionHash: string; reason: string }
  | { kind: "adjust"; lines: RemainingLine[]; endReason?: EarlyEndReason; proposedOwnerGross?: string; proposedOwnerNet?: string; proposedRenterRefund: string; reason: string; acceptedHash: string };

export type FulfillmentIntent = {
  id: string;
  kind: FulfillmentCommand["kind"];
  orderId: string;
  path: string;
  key: string;
  body: Record<string, unknown>;
  createdAt: string;
};

export type ManualCloseResult = {
  orderId: string; status: "CANCELLED"; cancelReason: "MANUAL_CLOSE"; cancelledAt: string;
  localFundsEffect: "NONE"; financeHandling: "OFFLINE_REQUIRED"; alreadyClosed?: boolean;
};

export type SupportCancelReason =
  | "ORDER_COMPLETED" | "ORDER_NOT_PAID" | "PAYMENT_BASIS_UNAVAILABLE" | "SETTLEMENT_ALREADY_POSTED"
  | "SETTLEMENT_DRAFT_EXISTS" | "MANUAL_ADJUSTMENT_REVIEW" | "DISTRIBUTION_RECONCILIATION_REQUIRED"
  | "REFUND_PENDING" | "TERMINATION_PENDING" | "ALREADY_CANCELLED" | "ORDER_CHANGED";

export type SupportCancelRefund = {
  integration?: "INTEGRATED" | "NOT_INTEGRATED" | "UNAVAILABLE" | string;
  intents?: Array<{
    intentId?: string | null; refundOrderNo?: string | null; state?: string; budgetDisposition?: string | null;
    requiresReview?: boolean; amountCents?: string | null; firstSubmit?: string;
  }> | null;
  totals?: { originalCents?: string; allocatedCents?: string; consumedCents?: string; releasedCents?: string;
    remainingCents?: string; totalsComplete?: boolean } | null;
  completedLocallyAt?: string | null;
  bankArrival?: "UNKNOWN" | string;
  reason?: string | null;
};

export type SupportCancelRow = {
  terminationId: string; state: string; reason: string; reviewReason: string | null; approvedAt: string | null;
  requestedByAdminUserId: string | null; refundCents: string | null; currency: "CNY";
  liabilityRecognized: boolean;
};

export type SupportCancelView = {
  contractVersion: "admin-support-cancel.v1";
  orderId: string; orderRevision: string; orderStatus: string; cancelReason: string | null; cancelledAt: string | null;
  simulationScope?: "LOCAL_DEMO_SIMULATED" | "ECS_TEST_SIMULATED";
  eligibility: { allowed: boolean; reason: SupportCancelReason | null; refundCents: string | null; openingConfirmed?: boolean };
  openingConfirmed: boolean;
  supportCancellation: SupportCancelRow | null;
  poststartEligibility?: { allowed: boolean; reason: SupportCancelReason | null; refundCents: string | null; openingConfirmed: boolean; fullPayoutSelected?: boolean | null; fixedFeeRate?: string };
  poststartCancellation?: { caseId: string; refundCents: string; ownerCents: string; platformContributionCents: string;
    ownerGrossCents?: string | null; fullPayoutFeeCents?: string | null; fullPayoutSelected?: boolean | null;
    fixedFeeRate?: string; platformServiceFeeCents?: string;
    commissionCents: string; reason: string; refundState?: string };
  refund: SupportCancelRefund | null;
  existing: boolean;
  channel: { result: string; bankArrival: "UNKNOWN" } | null;
};

export type SupportCancelOutcome =
  | { kind: "accepted"; view: SupportCancelView }
  | { kind: "blocked"; status: number; reasons: readonly string[]; message: string }
  | { kind: "auth"; status: number }
  | { kind: "unknown"; error?: unknown };

/** The support-cancel preview is a read-only projection; nothing is reserved or submitted. */
export async function readSupportCancel(orderId: string): Promise<SupportCancelView> {
  const view = await adminRequest<SupportCancelView>(`${orderBase(orderId)}/support-cancel`);
  if (!view || view.contractVersion !== "admin-support-cancel.v1" || view.orderId !== orderId
    || view.simulationScope !== undefined && !["LOCAL_DEMO_SIMULATED", "ECS_TEST_SIMULATED"].includes(view.simulationScope))
    throw new AdminApiError(502, "SUPPORT_CANCEL_CONTRACT_INVALID");
  return view;
}

/** Send or replay one frozen support cancellation. The caller must reuse `key` after an unknown result. */
export async function sendSupportCancel(orderId: string, expectedOrderRevision: string, reason: string, key: string,
  allocation?: { refundCents: string; ownerCents: string; expectedAdminId: string; ownerAmountBasis?: "GROSS_BEFORE_FEE_V1" }): Promise<SupportCancelOutcome> {
  try {
    const raw = await adminRequest<Record<string, unknown>>(`${orderBase(orderId)}/support-cancel`,
      { expectedOrderRevision, reason, ...allocation }, "POST", { "idempotency-key": key });
    if (raw.outcome === "UNKNOWN" || raw.originalKeyRequired === true) return { kind: "unknown" };
    if (raw.contractVersion !== "admin-support-cancel.v1" || raw.orderId !== orderId || typeof raw.orderRevision !== "string"
      || typeof raw.eligibility !== "object" || raw.eligibility === null
      || allocation && (raw.orderStatus !== 'CANCELLED' || raw.cancelReason !== 'SUPPORT_AFTER_START_CANCELLED'
        || !raw.poststartCancellation || typeof raw.poststartCancellation !== 'object'
        || (raw.poststartCancellation as {refundCents?:unknown}).refundCents !== allocation.refundCents
        || (allocation.ownerAmountBasis === "GROSS_BEFORE_FEE_V1"
          ? (raw.poststartCancellation as {ownerGrossCents?:unknown}).ownerGrossCents !== allocation.ownerCents
          : (raw.poststartCancellation as {ownerCents?:unknown}).ownerCents !== allocation.ownerCents)
        || (raw.poststartCancellation as {commissionCents?:unknown}).commissionCents !== '0')
      || raw.simulationScope !== undefined && (typeof raw.simulationScope !== 'string'||!['LOCAL_DEMO_SIMULATED','ECS_TEST_SIMULATED'].includes(raw.simulationScope)
        || !raw.channel || typeof raw.channel !== 'object' || (raw.channel as {result?:unknown}).result !== 'NOT_SUBMITTED'
        || (raw.channel as {bankArrival?:unknown}).bankArrival !== 'UNKNOWN')) return { kind: "unknown" };
    return { kind: "accepted", view: raw as unknown as SupportCancelView };
  } catch (error) {
    if (error instanceof AdminApiError) {
      if (error.status === 401 || error.status === 423) return { kind: "auth", status: error.status };
      if (error.status === 0 || error.status === 429 || error.status >= 500) return { kind: "unknown", error };
      return { kind: "blocked", status: error.status, reasons: error.reasons, message: error.code };
    }
    return { kind: "unknown", error };
  }
}

export type SupportUnpaidCancelView = {
  contractVersion: "admin-support-unpaid-cancel.v1"; orderId: string; orderRevision: string; orderStatus: string;
  cancelReason: string | null; eligibility: { allowed: boolean; reason: string | null };
};
export async function readSupportUnpaidCancel(orderId: string): Promise<SupportUnpaidCancelView> {
  return adminRequest<SupportUnpaidCancelView>(`${orderBase(orderId)}/support-unpaid-cancel`);
}
export async function sendSupportUnpaidCancel(orderId: string, expectedOrderRevision: string, reason: string, key: string): Promise<
  { kind: "accepted" } | { kind: "blocked"; reason: string | null } | { kind: "unknown" }
> {
  try {
    const raw = await adminRequest<Record<string, unknown>>(`${orderBase(orderId)}/support-unpaid-cancel`,
      { expectedOrderRevision, reason }, "POST", { "idempotency-key": key });
    if (!/^[1-9]\d{0,18}$/.test(expectedOrderRevision) || raw.orderRevision !== (BigInt(expectedOrderRevision) + 1n).toString()
      || raw.contractVersion !== "admin-support-unpaid-cancel.v1" || raw.orderId !== orderId || raw.outcome !== "CANCELLED"
      || raw.orderStatus !== "CANCELLED" || raw.cancelReason !== "SUPPORT_UNPAID" || raw.channelClosed !== false) return { kind: "unknown" };
    return { kind: "accepted" };
  } catch (error) {
    if (error instanceof AdminApiError && error.status >= 400 && error.status < 500 && error.status !== 429)
      return { kind: "blocked", reason: error.reasons[0] ?? null };
    return { kind: "unknown" };
  }
}

export type FulfillmentOutcome =
  | { kind: "accepted"; status: number; body: SettlementReadView }
  | { kind: "blocked"; status: number; reasons: readonly string[]; message: string }
  | { kind: "auth"; status: number }
  | { kind: "unknown"; error: unknown }
  | { kind: "unresolved"; status: number; reasons: readonly string[]; message: string };

function orderBase(orderId: string): string {
  return `/orders/${encodeURIComponent(orderId)}`;
}

function commandPath(orderId: string, command: FulfillmentCommand): string {
  const base = orderBase(orderId);
  switch (command.kind) {
    case "record-opening": return `${base}/openings`;
    case "confirm-opening": return `${base}/openings/${encodeURIComponent(command.openingId)}/confirm`;
    case "preview": return `${base}/settlement-preview`;
    case "classify": return `${base}/settlements/classify`;
    case "review": return `${base}/settlements/${encodeURIComponent(command.versionId)}/review`;
    case "finalize": return `${base}/settlements/${encodeURIComponent(command.versionId)}/finalize`;
    case "adjust": return `${base}/settlements/adjustments`;
  }
}

function commandBody(command: FulfillmentCommand): Record<string, unknown> {
  switch (command.kind) {
    case "record-opening":
      return { lines: command.lines };
    case "confirm-opening":
      return { party: command.party, versionNo: command.versionNo, reason: command.reason };
    case "preview":
      return {
        lines: command.lines,
        ...(command.endReason === undefined ? {} : { endReason: command.endReason }),
        ...(command.proposedOwnerNet === undefined ? {} : { proposedOwnerNet: command.proposedOwnerNet }),
        ...(command.proposedOwnerGross === undefined ? {} : { proposedOwnerGross: command.proposedOwnerGross }),
        ...(command.proposedRenterRefund === undefined ? {} : { proposedRenterRefund: command.proposedRenterRefund }),
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      };
    case "classify":
      return { lines: command.lines, endReason: command.endReason, acceptedHash: command.acceptedHash };
    case "review":
      return { versionHash: command.versionHash };
    case "finalize":
      return { versionHash: command.versionHash, reason: command.reason };
    case "adjust":
      return {
        lines: command.lines,
        ...(command.endReason === undefined ? {} : { endReason: command.endReason }),
        ...(command.proposedOwnerGross === undefined ? {proposedOwnerNet:command.proposedOwnerNet} : {proposedOwnerGross:command.proposedOwnerGross}),
        proposedRenterRefund: command.proposedRenterRefund,
        reason: command.reason,
        acceptedHash: command.acceptedHash,
      };
  }
}

function newKey(orderId: string, kind: FulfillmentCommand["kind"]): string {
  const nonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `im_ful_${kind}_${orderId}_${nonce.replaceAll("-", "")}`.slice(0, 180);
}

/** Freeze the operator intent (order + action + path + body + stable key). */
export function buildFulfillmentIntent(orderId: string, command: FulfillmentCommand): FulfillmentIntent {
  const key = newKey(orderId, command.kind);
  return { id: key, kind: command.kind, orderId, path: commandPath(orderId, command), key, body: commandBody(command), createdAt: new Date().toISOString() };
}

/**
 * A settlement read has three honest failure meanings: 404 = the recording
 * surface is off in this environment (or the object is not readable at all),
 * 403 = this account lacks permission, everything else stays unknown. The
 * caller must not collapse them into one "no permission" message.
 */
export type SettlementReadOutcome =
  | { kind: "ok"; view: SettlementReadView }
  | { kind: "unavailable"; status: 404 }
  | { kind: "forbidden"; status: 403 }
  | { kind: "auth"; status: 401 | 423 }
  | { kind: "unknown"; error: unknown };

export async function readOrderSettlement(orderId: string): Promise<SettlementReadOutcome> {
  try {
    const view = await adminRequest<SettlementReadView>(`${orderBase(orderId)}/settlement`);
    return { kind: "ok", view };
  } catch (error) {
    if (error instanceof AdminApiError) {
      if (error.status === 404) return { kind: "unavailable", status: 404 };
      if (error.status === 403) return { kind: "forbidden", status: 403 };
      if (error.status === 401 || error.status === 423) return { kind: "auth", status: error.status };
    }
    return { kind: "unknown", error };
  }
}

/**
 * Send (or replay) one frozen intent. Never mints a second intent for a retry.
 *
 * On a replay only the original key's recorded receipt resolves the unknown
 * responsibility: a 200 (recorded success) or a 409 that carries the recorded
 * business reasons. A current precondition rejection (403/404, or a 409
 * CONFLICT raised by the replay's own recheck before the record is read) does
 * NOT prove the original request never executed, so it stays unresolved.
 */
export async function sendFulfillmentIntent(intent: FulfillmentIntent, replay = false): Promise<FulfillmentOutcome> {
  try {
    const body = await adminRequest<SettlementReadView>(intent.path, intent.body, "POST", { "idempotency-key": intent.key });
    return { kind: "accepted", status: 200, body };
  } catch (error) {
    if (error instanceof AdminApiError) {
      if (error.status === 401 || error.status === 423) return { kind: "auth", status: error.status };
      if (error.status === 0 || error.status === 429 || error.status >= 500) return { kind: "unknown", error };
      const reasons = error.reasons.length > 0 ? error.reasons : [error.code];
      const recordedReceipt = error.status === 409 && error.reasons.length > 0;
      if (replay && !recordedReceipt) return { kind: "unresolved", status: error.status, reasons, message: error.code };
      return { kind: "blocked", status: error.status, reasons, message: error.code };
    }
    return { kind: "unknown", error };
  }
}

/** Legacy receipts remain recoverable; current PAID orders return the formal resolution in a 409. */
export async function sendManualClose(orderId: string, remark: string, key: string): Promise<ManualCloseResult> {
  return adminRequest<ManualCloseResult>(`${orderBase(orderId)}/manual-close`, { remark }, "POST", { "idempotency-key": key });
}

export type AutomaticOpeningRetry =
  | { kind: "accepted"; state: "CREATED" | "EXISTS" | "REVIEW_REQUIRED"; openingId?: string; reason?: string }
  | { kind: "blocked"; reason: string }
  | { kind: "auth"; status: 401 | 423 }
  | { kind: "unknown"; error: unknown };

export async function retryAutomaticOpening(orderId: string, key: string): Promise<AutomaticOpeningRetry> {
  try {
    const body = await adminRequest<{ state: "CREATED" | "EXISTS" | "REVIEW_REQUIRED"; openingId?: string; reason?: string }>(
      `${orderBase(orderId)}/opening-generation/retry`, {}, "POST", { "idempotency-key": key });
    return { kind: "accepted", state: body.state, ...(body.openingId ? { openingId: body.openingId } : {}), ...(body.reason ? { reason: body.reason } : {}) };
  } catch (error) {
    if (error instanceof AdminApiError) {
      if (error.status === 401 || error.status === 423) return { kind: "auth", status: error.status };
      if (error.status >= 400 && error.status < 500) return { kind: "blocked", reason: error.reasons[0] ?? error.code };
      return { kind: "unknown", error };
    }
    return { kind: "unknown", error };
  }
}

export type ProgressReminderReceipt = {
  reminderId: string; orderId: string; stage: string; targets: string[];
  state: "PENDING" | "SENT" | "FAILED"; messageClientId: string;
};
export type ProgressReminderOutcome =
  | { kind: "accepted"; receipt: ProgressReminderReceipt }
  | { kind: "blocked"; reason: string }
  | { kind: "auth"; status: 401 | 423 }
  | { kind: "unknown"; error: unknown };

/** One click = one request key. A retry with the same key never mints a second reminder. */
export async function sendProgressReminder(orderId: string, key: string): Promise<ProgressReminderOutcome> {
  try {
    const receipt = await adminRequest<ProgressReminderReceipt>(`${orderBase(orderId)}/progress-reminders`, {}, "POST", { "idempotency-key": key });
    return { kind: "accepted", receipt };
  } catch (error) {
    if (error instanceof AdminApiError) {
      if (error.status === 401 || error.status === 423) return { kind: "auth", status: error.status };
      if (error.status === 409) return { kind: "blocked", reason: error.reasons[0] ?? error.code };
      if (error.status === 0 || error.status === 429 || error.status >= 500) return { kind: "unknown", error };
      return { kind: "blocked", reason: error.code };
    }
    return { kind: "unknown", error };
  }
}
