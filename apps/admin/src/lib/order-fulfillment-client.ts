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
export type RemainingLine = { itemId: string; remainingQuantity: string };
export type EarlyEndReason = "TENANT_VOLUNTARY_EARLY" | "OWNER_OR_ACCOUNT_EARLY";

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
  inputSnapshot?: { lines?: Array<{ itemId?: string; openingQuantity?: string; remainingQuantity?: string }> } | null;
  computation?: { ok?: boolean; reasons?: string[]; early?: boolean; amounts?: Record<string, SettlementAmount>; consumed?: { haff?: unknown; items?: Array<{ itemId?: string; consumed?: unknown; remaining?: unknown }> } } | null;
  decisions?: Array<{ party?: string; action?: string; reason?: string | null; versionHash?: string; createdAt?: string }>;
};

export type SettlementReadView = {
  orderId?: string;
  revision?: string;
  rentalStarted?: boolean;
  ready?: boolean;
  reasons?: string[];
  currentRequest?: { kind?: string; id?: string; versionNo?: number; status?: string } | null;
  settlement?: SettlementVersionView | null;
  openings?: Array<{ id?: string; versionNo?: number; status?: string; confirmedAt?: string | null; createdAt?: string; lines?: Array<{ itemId?: string; quantity?: string; unit?: string; pricingKind?: string }>; acks?: Array<{ party?: string; createdAt?: string }> }>;
  posting?: { id?: string; versionHash?: string; early?: boolean; postedAt?: string; refundDueAt?: string | null; amounts?: Record<string, SettlementAmount> } | null;
  amounts?: Record<string, SettlementAmount>;
  consumed?: { haff?: unknown; items?: Array<{ itemId?: string; consumed?: unknown; remaining?: unknown }> };
  versionHash?: string;
  baseVersionId?: string;
  accepted?: boolean;
  early?: boolean;
  systemOwnerNet?: string;
  systemRenterRefund?: string;
};

export type FulfillmentCommand =
  | { kind: "record-opening"; lines: FulfillmentLine[] }
  | { kind: "preview"; lines: RemainingLine[]; endReason?: EarlyEndReason; proposedOwnerNet?: string; proposedRenterRefund?: string; reason?: string }
  | { kind: "classify"; lines: RemainingLine[]; endReason: EarlyEndReason; acceptedHash: string }
  | { kind: "review"; versionId: string; versionHash: string }
  | { kind: "adjust"; lines: RemainingLine[]; endReason?: EarlyEndReason; proposedOwnerNet: string; proposedRenterRefund: string; reason: string; acceptedHash: string };

export type FulfillmentIntent = {
  id: string;
  kind: FulfillmentCommand["kind"];
  orderId: string;
  path: string;
  key: string;
  body: Record<string, unknown>;
  createdAt: string;
};

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
    case "preview": return `${base}/settlement-preview`;
    case "classify": return `${base}/settlements/classify`;
    case "review": return `${base}/settlements/${encodeURIComponent(command.versionId)}/review`;
    case "adjust": return `${base}/settlements/adjustments`;
  }
}

function commandBody(command: FulfillmentCommand): Record<string, unknown> {
  switch (command.kind) {
    case "record-opening":
      return { lines: command.lines };
    case "preview":
      return {
        lines: command.lines,
        ...(command.endReason === undefined ? {} : { endReason: command.endReason }),
        ...(command.proposedOwnerNet === undefined ? {} : { proposedOwnerNet: command.proposedOwnerNet }),
        ...(command.proposedRenterRefund === undefined ? {} : { proposedRenterRefund: command.proposedRenterRefund }),
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      };
    case "classify":
      return { lines: command.lines, endReason: command.endReason, acceptedHash: command.acceptedHash };
    case "review":
      return { versionHash: command.versionHash };
    case "adjust":
      return {
        lines: command.lines,
        ...(command.endReason === undefined ? {} : { endReason: command.endReason }),
        proposedOwnerNet: command.proposedOwnerNet,
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

export function readOrderSettlement(orderId: string): Promise<SettlementReadView> {
  return adminRequest<SettlementReadView>(`${orderBase(orderId)}/settlement`);
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
