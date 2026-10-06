import type { Money, UnitAmount } from "./supply-types";

export type OrderParty = "renter" | "owner";
export type OrderStatus = "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "COMPLETED";
export type OrderStatusFilter = OrderStatus | "";

export type OrderLine = {
  itemId?: string;
  name?: string;
  quantity?: string;
  unit?: string;
  unitQuantity?: string;
  buyerUnitAmount?: UnitAmount | null;
  buyerAmount?: Money | null;
  ownerUnitAmount?: UnitAmount | null;
  ownerAmount?: Money | null;
};

export type OrderQuote = {
  lines?: OrderLine[];
  unitAmountsInformational?: boolean;
  ownerTotal?: Money | null;
};

export type OrderAmounts = {
  rental?: Money | null;
  deposit?: Money | null;
  totalDue?: Money | null;
  currency?: string;
};

export type FulfillmentAssignment = {
  state?: string | null;
  waitingReason?: string | null;
  assignedAt?: string | null;
  teamReady?: boolean;
  teamState?: string | null;
};

export type Order = {
  id: string;
  displayNo?: string | null;
  status: string;
  accountId?: string | null;
  versionId?: string | null;
  title?: string | null;
  termSeconds?: string | null;
  amounts?: OrderAmounts | null;
  createdAt?: string | null;
  holdUntil?: string | null;
  expiredAwaitingCancel?: boolean;
  paidAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  fulfillmentAssignment?: FulfillmentAssignment | null;
  quote?: OrderQuote | null;
  renterName?: string | null;
};

export type OrderPage = { items: Order[]; nextCursor: string | null; limit: number };

export type PersonalRentalQuote = {
  quote: OrderQuote & { resourceTotal?: Money | null; tenantDeposit?: Money | null; tenantPayableTotal?: Money | null };
  baseTenantDeposit: Money | null;
  customerTier: string;
  depositWaived: boolean;
  compensationDisclosure?: { selected: boolean; disclosureVersion: string };
  confirmationId: string;
  listingHash: string;
  expiresAt: string;
  confirmationToken: string;
};

export type SettlementLine = { itemId: string; quantity?: string; unit?: string; pricingKind?: string };
export type SettlementOpening = {
  id: string;
  versionNo: string;
  status: string;
  createdAt?: string;
  lines: SettlementLine[];
  acks?: Array<{ party: string; createdAt?: string }>;
};
export type SettlementVersion = {
  id: string;
  versionNo: string;
  kind?: string | null;
  endReason?: string | null;
  early?: boolean;
  initiatorParty?: string | null;
  versionHash: string;
  createdAt?: string | null;
  systemOwnerNet?: string | null;
  systemRenterRefund?: string | null;
  proposedOwnerNet?: string | null;
  proposedRenterRefund?: string | null;
  inputSnapshot?: { lines?: Array<{ itemId: string; openingQuantity?: string; remainingQuantity?: string }>; endReason?: string | null } | null;
  computation?: { ok?: boolean; reasons?: string[]; early?: boolean; consumed?: { haff?: unknown; items?: Array<{ itemId: string; consumed: string; remaining: string }> }; amounts?: Record<string, unknown> } | null;
  decisions?: Array<{ party: string; action: string; reason?: string | null; createdAt?: string }>;
};
export type SettlementPosting = {
  id: string;
  postedAt?: string;
  refundDueAt?: string | null;
  compensationFeeCents?: string | null;
  amounts?: Record<string, unknown> | null;
  owner?: { gross?: unknown; systemNetCents?: string; availableCents?: string } | null;
  refund?: { systemCents?: string; payableCents?: string; includesDeposit?: boolean } | null;
};
export type OrderSettlement = {
  orderId: string;
  revision?: string;
  rentalStarted?: boolean;
  openings: SettlementOpening[];
  intakes: Array<{ id: string; versionNo: string; status: string; initiatorParty?: string; lines?: Array<{ itemId: string; remainingQuantity: string }> }>;
  versions: SettlementVersion[];
  currentRequest?: { kind: string; id: string; versionNo: string; status: string } | null;
  settlement?: SettlementVersion | null;
  posting?: SettlementPosting | null;
  ready?: boolean;
  reasons?: string[];
  postingAuthorized?: boolean;
  feeDeducted?: boolean;
  orderStatus?: string;
  accepted?: boolean;
  early?: boolean;
  amounts?: Record<string, unknown>;
  versionHash?: string;
  systemOwnerNet?: string | null;
  systemRenterRefund?: string | null;
  consumed?: { haff?: unknown; items?: Array<{ itemId: string; consumed: string; remaining: string }> } | null;
};
export type SettlementPreview = {
  accepted: false;
  reasons: string[];
  amounts?: Record<string, unknown>;
  versionHash?: string;
  consumed?: { haff?: unknown; items?: Array<{ itemId: string; consumed: string; remaining: string }> } | null;
};

export function formatOrderTime(value: string | null | undefined): string {
  if (!value) return "时间暂不可用";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间暂不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Shanghai", timeZoneName: "longOffset", hourCycle: "h23",
  }).format(date);
}

export function formatOrderMoney(value: { amount?: unknown; currency?: unknown } | null | undefined): string {
  if (!value || value.currency !== "CNY" || typeof value.amount !== "string" || !/^\d+\.\d{2}$/.test(value.amount)) return "待确认";
  return `${value.amount} 元`;
}

export function mergeOrderItems(previous: Order[], incoming: Order[]): Order[] {
  const merged = new Map(previous.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

type OrderErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
  };
};

export class OrderRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, body: unknown) {
    const payload = body && typeof body === "object" && !Array.isArray(body)
      ? (body as OrderErrorBody).error
      : undefined;
    super(typeof payload?.message === "string" ? payload.message : "订单请求未完成，请稍后重试");
    this.name = "OrderRequestError";
    this.status = status;
    this.code = typeof payload?.code === "string"
      ? payload.code
      : status === 0
        ? "NETWORK_ERROR"
        : "INTERNAL_ERROR";
    this.requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
  }
}

type ReadOptions = { signal?: AbortSignal };

async function requestJson<T>(path: string, options: ReadOptions = {}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("Order path must be relative");
  }
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new OrderRequestError(0, null);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    throw new OrderRequestError(body === null ? (response.ok ? 502 : response.status) : response.status, body);
  }
  return body as T;
}

function unwrapOrder(body: { order?: Order } | Order): Order {
  return body && typeof body === "object" && "order" in body && body.order ? body.order : body as Order;
}

type WriteOptions = { method?: "POST"; body?: unknown; key?: string; signal?: AbortSignal };

async function requestWrite<T>(path: string, options: WriteOptions): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("Order path must be relative");
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (options.key) headers.set("idempotency-key", options.key);
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: JSON.stringify(options.body ?? {}),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new OrderRequestError(0, null);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    throw new OrderRequestError(body === null ? (response.ok ? 502 : response.status) : response.status, body);
  }
  return body as T;
}

export function orderIntentKey(): string {
  return "op_" + crypto.randomUUID().replaceAll("-", "");
}

export const orderApi = {
  list: (input: { party: OrderParty; status?: OrderStatus; accountId?: string; limit?: number; cursor?: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ party: input.party, limit: String(input.limit ?? 20) });
    if (input.status) query.set("status", input.status);
    if (input.accountId) query.set("accountId", input.accountId);
    if (input.cursor) query.set("cursor", input.cursor);
    return requestJson<OrderPage>(`/api/orders?${query.toString()}`, { signal });
  },
  detail: (orderId: string, signal?: AbortSignal) =>
    requestJson<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}`, { signal }).then(unwrapOrder),
  confirmRental: (input: { accountId: string; versionId: string; releaseId: string }, signal?: AbortSignal) =>
    requestWrite<PersonalRentalQuote>("/api/order-confirmations", { body: input, signal }),
  createOrder: (confirmationToken: string, key: string, signal?: AbortSignal) =>
    requestWrite<{ order: Order }>("/api/v2/orders", { body: { confirmationToken }, key, signal }).then(unwrapOrder),
  cancel: (orderId: string, key: string, reason?: string, signal?: AbortSignal) =>
    requestWrite<{ order?: Order } | Order>(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { key, body: reason ? { reason } : {}, signal }),
  pay: (orderId: string, key: string, signal?: AbortSignal) =>
    requestWrite<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>(
      `/api/orders/${encodeURIComponent(orderId)}/payment-requests`, { key, signal }),
  paymentStatus: (orderId: string, signal?: AbortSignal) =>
    requestJson<{ order: { id: string; displayNo?: string | null; status: string; paidAt?: string | null }; payment: { confirmationId: string; disposition: string; reasonCode?: string | null; amountCents: string; currency: string; acceptedAt: string } | null }>(
      `/api/orders/${encodeURIComponent(orderId)}/payment-requests`, { signal }),
  settlement: (orderId: string, signal?: AbortSignal) =>
    requestJson<OrderSettlement>(`/api/orders/${encodeURIComponent(orderId)}/settlement`, { signal }),
  settlementPreview: (orderId: string, body: { lines: Array<{ itemId: string; remainingQuantity: string }>; endReason?: string }, signal?: AbortSignal) =>
    requestWrite<SettlementPreview>(`/api/orders/${encodeURIComponent(orderId)}/settlement-preview`, { body, signal }),
  submitSettlement: (orderId: string, body: { lines: Array<{ itemId: string; remainingQuantity: string }>; acceptedHash: string; endReason?: string }, key: string, signal?: AbortSignal) =>
    requestWrite<OrderSettlement>(`/api/orders/${encodeURIComponent(orderId)}/settlements`, { body, key, signal }),
  decideSettlement: (orderId: string, versionId: string, body: { action: "CONFIRM" | "REJECT"; versionHash: string; reason?: string }, key: string, signal?: AbortSignal) =>
    requestWrite<OrderSettlement>(`/api/orders/${encodeURIComponent(orderId)}/settlements/${encodeURIComponent(versionId)}/decision`, { body, key, signal }),
  confirmOpening: (orderId: string, openingId: string, versionNo: number, key: string, signal?: AbortSignal) =>
    requestWrite<OrderSettlement>(`/api/orders/${encodeURIComponent(orderId)}/openings/${encodeURIComponent(openingId)}/confirm`, { body: { versionNo }, key, signal }),
};
