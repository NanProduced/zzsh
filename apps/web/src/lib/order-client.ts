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

export type LegacyOrderResource = { code: string; quantity: string; unit: "DAY" | null };
export type LegacyOrderFacts = { resources: LegacyOrderResource[]; rentalDeadlineAt: string | null };

export type FulfillmentAssignment = {
  state?: string | null;
  waitingReason?: string | null;
  assignedAt?: string | null;
  teamReady?: boolean;
  teamState?: string | null;
};

export type Order = {
  source?: { origin: "NATIVE" | "LEGACY"; statusLabel?: string };
  readOnly?: boolean;
  legacyAmounts?: LegacyOrder["legacyAmounts"];
  payment?: LegacyOrder["payment"];
  id: string;
  displayNo?: string | null;
  status: string;
  accountId?: string | null;
  versionId?: string | null;
  title?: string | null;
  account?: LegacyOrder["account"];
  orderFacts?: LegacyOrderFacts;
  termSeconds?: string | null;
  amounts?: OrderAmounts | null;
  createdAt?: string | null;
  holdUntil?: string | null;
  expiredAwaitingCancel?: boolean;
  /** Server-observed eligibility for the payment/cancel entries; never a substitute for server authorization. */
  paymentOpen?: boolean;
  cancelOpen?: boolean;
  paidAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  fulfillmentAssignment?: FulfillmentAssignment | null;
  quote?: OrderQuote | null;
  renterName?: string | null;
};

export type LegacyOrder = {
  id: string; displayNo: string; status: OrderStatus | "UNKNOWN"; party: OrderParty; title: string; gameId: string;
  source: { origin: "LEGACY"; ruleOrigin: "LEGACY_ORDER"; originalStatus: number; originalPayStatus: number; statusLabel: string };
  createdAt: string | null; paidAt: string | null; cancelledAt: string | null; completedAt: string | null;
  amounts: { rental: Money | null; deposit: Money | null; totalDue: Money | null; currency: "CNY" };
  payment: { state: "RECORDED_PAID" | "RECORDED_UNPAID" | "UNKNOWN"; recordedAt: string | null; recordedAmount: Money | null };
  legacyAmounts: { required: Money | null; paid: Money | null; deposit: Money | null; refund: Money | null; refundChannelState: "UNKNOWN" };
  account: { id: string | null; displayNo: string | null; readable: boolean };
  orderFacts?: LegacyOrderFacts;
  readOnly: true; paymentOpen: false; cancelOpen: false; continuationCount: 0; actions: never[];
};
export type LegacyOrderPage = { items: LegacyOrder[]; page: number; pageSize: number; total: number };

export type OrderPage = { items: Order[]; nextCursor: string | null; limit: number };

export type PersonalRentalQuote = {
  quote: OrderQuote & { resourceTotal?: Money | null; tenantDeposit?: Money | null; tenantPayableTotal?: Money | null };
  baseTenantDeposit: Money | null;
  /** Only frozen compatibility quotes carry the former tier enum. */
  customerTier?: string;
  membershipBenefits?: {schema:"membership-benefits-v1";effectiveTier:"STANDARD"|"SILVER"|"GOLD"|"PLATINUM"|"DIAMOND"|"BLACK_GOLD";policyTier:"STANDARD"|"SILVER"|"GOLD"|"PLATINUM"|"DIAMOND";priceSource:"GROWTH"|"FRIEND"|"PRESTIGE";depositSource:"GROWTH"|"FRIEND"|"PRESTIGE";policyVersion:string};
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
  /** Authoritative "rental started" time for a confirmed opening; never inferred from payment or the client clock. */
  confirmedAt?: string | null;
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
  /** Set once a newer version replaced this one; the user projection does not return a version creation time. */
  supersededAt?: string | null;
  systemOwnerNet?: string | null;
  systemRenterRefund?: string | null;
  proposedOwnerNet?: string | null;
  proposedRenterRefund?: string | null;
  inputSnapshot?: { lines?: Array<{ itemId: string; openingQuantity?: string; remainingQuantity?: string }>; endReason?: string | null; reason?: string | null } | null;
  computation?: { ok?: boolean; reasons?: string[]; early?: boolean; consumed?: { haff?: unknown; items?: Array<{ itemId: string; consumed: string; remaining: string }> }; amounts?: Record<string, unknown> } | null;
  decisions?: Array<{ party: string; action: string; reason?: string | null; createdAt?: string }>;
};
export type SettlementPosting = {
  id: string;
  settlementVersionId?: string;
  early?: boolean;
  postedAt?: string;
  refundDueAt?: string | null;
  /** Cash actually captured on this order; the reconciliation figure behind “原订单已付”. */
  capturedCents?: string | null;
  compensationFeeCents?: string | null;
  amounts?: Record<string, unknown> | null;
  /** `gross` is the yuan Money object from the posted snapshot; the Cents fields are the exact net/refund columns. */
  owner?: { gross?: Money | null; systemNetCents?: string; availableCents?: string } | null;
  /**
   * `includesDeposit` is *not* a boolean in the current server projection: the backend assigns the
   * depositRefund amount object (or null) to it. The deposit to refund is read from
   * `amounts.depositRefund`, never from this field's truthiness.
   */
  refund?: { systemCents?: string; payableCents?: string; includesDeposit?: unknown } | null;
  manualAdjustment?: {
    reason?: string | null;
    systemOwnerNetCents?: string;
    postedOwnerNetCents?: string;
    systemRenterRefundCents?: string;
    postedRenterRefundCents?: string;
  } | null;
};
export type OrderSettlement = {
  orderId: string;
  revision?: string;
  rentalStarted?: boolean;
  openings: SettlementOpening[];
  intakes: Array<{ id: string; versionNo: string; status: string; initiatorParty?: string; settlementVersionId?: string | null; createdAt?: string; lines?: Array<{ itemId: string; remainingQuantity: string }> }>;
  versions: SettlementVersion[];
  /** `status` is only present for an INTAKE request; a settlement-version request omits it entirely. */
  currentRequest?: { kind: string; id: string; versionNo: string; status?: string } | null;
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

export function formatOrderTime(value: string | null | undefined, options: { timeZoneName?: boolean } = {}): string {
  if (!value) return "待确认";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "待确认";
  // 订单时间默认带显式时区偏移；记录行传 timeZoneName:false 收敛逐行 GMT 噪声，时区在页面说明中一次性交代。
  const base = {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Shanghai", hourCycle: "h23",
  } as const;
  return new Intl.DateTimeFormat("zh-CN", options.timeZoneName === false ? base : { ...base, timeZoneName: "longOffset" }).format(date);
}

export function formatOrderMoney(value: { amount?: unknown; currency?: unknown } | null | undefined): string {
  if (!value || value.currency !== "CNY" || typeof value.amount !== "string" || !/^\d+\.\d{2}$/.test(value.amount)) return "待确认";
  const whole = value.amount.slice(0, -3);
  const fraction = value.amount.slice(-2);
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction} 元`;
}

export function orderItemKey(order: Order): string { return JSON.stringify([order.source?.origin ?? "NATIVE", order.id]); }

export function mergeOrderItems(previous: Order[], incoming: Order[]): Order[] {
  const merged = new Map(previous.map((item) => [orderItemKey(item), item]));
  for (const item of incoming) merged.set(orderItemKey(item), item);
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

export { requestJson as requestOrderJson, requestWrite as requestOrderWrite };

export function orderIntentKey(): string {
  return "op_" + crypto.randomUUID().replaceAll("-", "");
}

type OrderListInput = { party: OrderParty; status?: OrderStatus; accountId?: string; limit?: number; cursor?: string };
function orderListQuery(input: OrderListInput): string {
  const query = new URLSearchParams({ party: input.party, limit: String(input.limit ?? 20) });
  if (input.status) query.set("status", input.status);
  if (input.accountId) query.set("accountId", input.accountId);
  if (input.cursor) query.set("cursor", input.cursor);
  return query.toString();
}

export const orderApi = {
  listLegacy: (input: { party: OrderParty; page?: number; pageSize?: number; status?: OrderStatus | "UNKNOWN"; accountId?: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ party: input.party, page: String(input.page ?? 1), pageSize: String(input.pageSize ?? 20) });
    if (input.status) query.set("status", input.status);
    if (input.accountId) query.set("accountId", input.accountId);
    return requestJson<LegacyOrderPage>(`/api/orders/legacy?${query.toString()}`, { signal });
  },
  legacyDetail: async (orderId: string, signal?: AbortSignal) =>
    (await requestJson<{ order: LegacyOrder }>(`/api/orders/legacy/${encodeURIComponent(orderId)}`, { signal })).order,
  list: (input: OrderListInput, signal?: AbortSignal) =>
    requestJson<OrderPage>(`/api/orders?${orderListQuery(input)}`, { signal }),
  listUnified: (input: OrderListInput, signal?: AbortSignal) =>
    requestJson<OrderPage>(`/api/orders/unified?${orderListQuery(input)}`, { signal }),
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
