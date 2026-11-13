import type { Money, UnitAmount, PublicQuote, FullPayoutTerms, FullPayoutTermsAcceptance, RentalMode } from "./supply-types";
import { orderSubjectUserId, type OrderSubject } from "./order-subject.ts";
import { runGuardedWrite } from "./order-guarded-write.ts";
/** Re-exported so order consumers stay on one client alias and need no extra module stub. */
export { runGuardedWrite, guardedErrorOf } from "./order-guarded-write.ts";
export type { GuardedError, GuardedWriteResult } from "./order-guarded-write.ts";
/** Re-exported so order consumers need no extra module alias and stay on one client contract. */
export { captureOrderSubject, isOrderSubjectCurrent, orderSubjectUserId, registerOrderExpectedUserId } from "./order-subject.ts";
export type { OrderSubject } from "./order-subject.ts";
export type { FullPayoutTerms, FullPayoutTermsAcceptance } from "./supply-types";

export type OrderParty = "renter" | "owner";
export type OrderStatus = "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "COMPLETED";
export type OrderWorkView = "IN_PROGRESS";
export type OrderStatusFilter = OrderStatus | OrderWorkView | "" | "ALL";

export type ChannelPaymentMethod = "ALIPAY_NATIVE" | "WEIXIN_NATIVE";
export type ChannelPaymentDataOrigin = "SYNTHETIC_PROTOCOL" | "LOCAL_CONTROLLED" | "JOINPAY_CANDIDATE" | "JOINPAY_PROVIDER" | "UNKNOWN";
type ChannelPaymentMoney = { cents: string; currency: string };
export type ChannelPaymentView = {
  contractVersion: "order-payment-request.v1";
  dataOrigin: ChannelPaymentDataOrigin;
  capability: { channelEnabled: boolean; methods: ChannelPaymentMethod[]; evidenceProfile: "JOINPAY_AGG_2_6_MD5" | "CONTROLLED_TEST"; productionPaymentCapability: boolean };
  order: { id: string; displayNo: string; status: string; paidAt: string | null };
  request: { id: string; state: string; method: string; amount: ChannelPaymentMoney | null; updatedAt: string;
    recovery: { mode: "ORIGINAL_NUMBER_QUERY"; nextAttemptAt: null; manualQueryOpen: false } | null } | null;
  projection: { displayState: string; actionBlockedReason: string | null };
  paymentAction: { kind: "QR_URL"; url: string; expiresAt: null; expiryKnown: false }
    | { kind: "TEST_CASHIER"; scope: "ECS_TEST_SIMULATED" | "LOCAL_DEMO_SIMULATED" } | null;
  payment: { confirmationId: string; disposition: "APPLIED" | "REVIEW_REQUIRED"; reasonCode: string | null; amount: ChannelPaymentMoney | null; acceptedAt: string } | null;
};
// POST只确认请求已持久化；支付参数和付款事实须从独立的本地GET读取。
export type ChannelPaymentCommandReceipt = {
  contractVersion: "order-payment-request.v1"; replay: boolean; dataOrigin: ChannelPaymentDataOrigin;
  request: { id: string; orderId: string; state: string; method: string; amount: ChannelPaymentMoney; createdAt: string; updatedAt: string };
  paymentAction: null; payment: null;
};
/** Queries the original request and may reconcile verified payment; never returns a payment action. */
export type ChannelPaymentQueryReceipt = {
  contractVersion: "order-payment-request.v1";
  request: { id: string; orderId: string; state: string };
  query: { kind: "OBSERVED"; event: string; result: string } | { kind: "TERMINAL" | "NOT_DISPATCHED" | "THROTTLED" | "PENDING_ACCEPTANCE" | "UNKNOWN_COMMIT" };
};

export type LocalCheckoutAvailability = {
  contractVersion: "local-sandbox-checkout-availability.v1"; scope: "LOCAL_CONTROLLED"; orderId: string;
  checkoutEnabled: boolean; observedAt: string; productionPaymentCapability: false; bankArrival: "UNKNOWN";
};
/** Only the safe page link is consumed here; signed tickets stay on the API checkout page. */
export type LocalCheckout = { id: string; displayNo: string; amount: { cents: string; currency: "CNY" }; expiresAt: string; url: string };

export type DemoCheckoutScope = "ECS_TEST_SIMULATED" | "LOCAL_DEMO_SIMULATED";
export type DemoCheckoutAvailability = {
  contractVersion: "ecs-test-checkout-availability.v1"; scope: DemoCheckoutScope; orderId: string;
  checkoutEnabled: boolean; observedAt: string; productionPaymentCapability: false; bankArrival: "UNKNOWN";
};
export type DemoCheckoutResult = {
  contractVersion: "ecs-test-checkout-result.v1"; scope: DemoCheckoutScope; orderId: string;
  payment: { confirmationId: string; disposition: "APPLIED"; reasonCode: null; replay: boolean }; bankArrival: "UNKNOWN";
};
export type DemoCheckoutReceipt = {
  contractVersion: "ecs-test-checkout-receipt.v1"; scope: DemoCheckoutScope; orderId: string;
  knowledge: "KNOWN" | "UNKNOWN"; receipt: DemoCheckoutResult | null; observedAt: string; writeAssemblyReady: boolean; mayReapply: false;
};
const demoTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const demoScope = (value: unknown): value is DemoCheckoutScope => value === "ECS_TEST_SIMULATED" || value === "LOCAL_DEMO_SIMULATED";
export function parseDemoCheckoutAvailability(value: unknown, orderId: string): DemoCheckoutAvailability {
  const v = value as DemoCheckoutAvailability | null;
  if (!v || v.contractVersion !== "ecs-test-checkout-availability.v1" || !demoScope(v.scope) || v.orderId !== orderId
    || typeof v.checkoutEnabled !== "boolean" || !demoTime(v.observedAt) || v.productionPaymentCapability !== false || v.bankArrival !== "UNKNOWN") throw new OrderRequestError(502, null);
  return v;
}
export function parseDemoCheckoutResult(value: unknown, orderId: string): DemoCheckoutResult {
  const v = value as DemoCheckoutResult | null;
  if (!v || v.contractVersion !== "ecs-test-checkout-result.v1" || !demoScope(v.scope) || v.orderId !== orderId || v.bankArrival !== "UNKNOWN"
    || typeof v.payment?.confirmationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.payment.confirmationId)
    || v.payment.disposition !== "APPLIED" || v.payment.reasonCode !== null || typeof v.payment.replay !== "boolean") throw new OrderRequestError(502, null);
  return v;
}
export function parseDemoCheckoutReceipt(value: unknown, orderId: string): DemoCheckoutReceipt {
  const v = value as DemoCheckoutReceipt | null;
  if (!v || v.contractVersion !== "ecs-test-checkout-receipt.v1" || !demoScope(v.scope) || v.orderId !== orderId
    || !demoTime(v.observedAt) || typeof v.writeAssemblyReady !== "boolean" || v.mayReapply !== false
    || (v.knowledge !== "KNOWN" && v.knowledge !== "UNKNOWN")) throw new OrderRequestError(502, null);
  if (v.knowledge === "KNOWN") {
    const receipt = parseDemoCheckoutResult(v.receipt, orderId);
    if (receipt.scope !== v.scope) throw new OrderRequestError(502, null);
    return { ...v, receipt };
  }
  if (v.receipt !== null) throw new OrderRequestError(502, null);
  return v;
}

export function parseLocalCheckoutAvailability(value: unknown, orderId: string): LocalCheckoutAvailability {
  const v = value as LocalCheckoutAvailability | null;
  if (!v || v.contractVersion !== "local-sandbox-checkout-availability.v1" || v.scope !== "LOCAL_CONTROLLED" || v.orderId !== orderId
    || typeof v.checkoutEnabled !== "boolean" || v.productionPaymentCapability !== false || v.bankArrival !== "UNKNOWN"
    || typeof v.observedAt !== "string" || !Number.isFinite(Date.parse(v.observedAt))) throw new OrderRequestError(502, null);
  return v;
}

export function parseLocalCheckout(value: unknown, expected: { orderId: string; displayNo: string; amountCents: string; key: string; origin: string }): LocalCheckout {
  const v = value as { contractVersion?: unknown; scope?: unknown; dataOrigin?: unknown; orderId?: unknown; productionPaymentCapability?: unknown; checkout?: LocalCheckout } | null;
  const c = v?.checkout;
  if (!v || v.contractVersion !== "local-sandbox-checkout.v1" || v.scope !== "LOCAL_CONTROLLED" || v.dataOrigin !== "LOCAL_CONTROLLED"
    || v.orderId !== expected.orderId || v.productionPaymentCapability !== false || !c || typeof c.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(c.id)
    || c.displayNo !== expected.displayNo || c.amount?.currency !== "CNY" || c.amount.cents !== expected.amountCents
    || !/^(0|[1-9]\d{0,23})$/.test(c.amount.cents) || typeof c.expiresAt !== "string" || !Number.isFinite(Date.parse(c.expiresAt))
    || typeof c.url !== "string" || /[\s\\]/.test(c.url)) throw new OrderRequestError(502, null);
  let here: URL, target: URL;
  try { here = new URL(expected.origin); target = new URL(c.url); } catch { throw new OrderRequestError(502, null); }
  if (here.protocol !== "http:" || here.hostname !== "127.0.0.1" || !here.port || here.username || here.password
    || target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.username || target.password || target.hash
    || target.pathname !== `/api/v1/orders/${encodeURIComponent(expected.orderId)}/local-checkouts/page`
    || target.searchParams.size !== 1 || target.searchParams.getAll("key").length !== 1 || target.searchParams.get("key") !== expected.key) throw new OrderRequestError(502, null);
  return { id: c.id, displayNo: c.displayNo, amount: { cents: c.amount.cents, currency: "CNY" }, expiresAt: c.expiresAt, url: target.href };
}

export type PersonalRefundOutcome =
  | "RESPONSIBILITY_NOT_POSTED" | "ZERO_RESPONSIBILITY" | "NOT_DUE" | "NO_INTENT" | "PARTIALLY_ALLOCATED" | "FULLY_ALLOCATED"
  | "PARTIALLY_CONSUMED" | "FULLY_CONSUMED" | "RELEASED" | "PROCESSING" | "UNKNOWN" | "REVIEW_REQUIRED" | "TRUNCATED" | "CONFLICT";
export type PersonalRefundObservation = {
  source: "JOINPAY" | "CONTROLLED";
  event: string;
  failureReason: string | null;
  evidenceLevel: string | null;
  observedAt: string;
  ageSeconds: number | null;
  trust: "LOCAL_OBSERVATION_NOT_REVALIDATED";
};
export type PersonalRefundBasis = "POSTING";
export type PersonalRefundIntent = {
  intentId: string;
  refundOrderNo: string | null;
  source: "LOCAL_CONTROLLED" | "JOINPAY_FORMAL" | "UNRECOGNIZED";
  evidenceLevel: string | null;
  basisKind?: PersonalRefundBasis;
  paymentConfirmationId?: string | null;
  amount: { cents: string; currency: "CNY" } | null;
  state: "READY" | "SUBMITTING" | "UNKNOWN" | "PROCESSING" | "REVIEW_REQUIRED" | "SUCCEEDED" | "FAILED" | "UNRECOGNIZED";
  budgetDisposition: "ALLOCATED" | "CONSUMED" | "RELEASED" | "UNRECOGNIZED";
  requiresReview: boolean;
  dueAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  latestObservation: PersonalRefundObservation | null;
  latestFailure: PersonalRefundObservation | null;
  savedChannelEvidence: {
    terminal: "SUCCEEDED" | "FAILED_NO_EXECUTION";
    evidenceLevel: string | null;
    providerRefundTrxNo: string | null;
    completedAt: string | null;
    trust: "SAVED_EVIDENCE_NOT_REVALIDATED";
  } | null;
  localAccounting: {
    disposition: "ALLOCATED" | "CONSUMED" | "RELEASED" | "UNRECOGNIZED";
    writeOff: { eventId: string; amountCents: string; postedAt: string | null; trust: "LOCAL_LEDGER" } | null;
    release: { intentUpdatedAt: string | null; ledgerEventId: null; trust: "LOCAL_INTENT_ONLY" } | null;
    reasonCodes: string[];
  };
  channelFacts: { actualAmountCents: null; channelRefundTrxNo: null; completedAt: null; destination: null; bankArrival: "UNKNOWN"; reasonCodes: string[] };
  reasonCodes: string[];
};
export type PersonalRefundRead = {
  contractVersion: "personal-native-refunds.v1";
  subjectId: string;
  order: { orderId: string; displayNo: string | null; status: string };
  status: "AVAILABLE" | "NOT_APPLICABLE";
  outcome: PersonalRefundOutcome;
  prestartRefund?: { state: "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"; amountCents: string | null;
    source: "SIMULATED" | "JOINPAY" | "UNKNOWN"; bankArrival: "UNKNOWN" };
  cancellationRefund?: { state: "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"; amountCents: string | null;
    source: "SIMULATED" | "JOINPAY" | "UNKNOWN"; bankArrival: "UNKNOWN" };
  coverage: { scope: "LOCAL_REGISTERED_ONLY"; intentLimit: number; intentsComplete: boolean; channelRecordsChecked: false };
  asOf: string;
  responsibility: {
    state: "POSTED" | "NOT_POSTED";
    postingId: string | null;
    originalCents: string | null;
    allocatedCents: string | null;
    consumedCents: string | null;
    releasedCents: string | null;
    remainingCents: string | null;
    totalsComplete: boolean;
    dueAt: string | null;
    dueState: "DUE" | "NOT_DUE" | "UNKNOWN";
  };
  intents: PersonalRefundIntent[];
  returnedIntentCount: number;
  intentsTruncated: boolean;
  actualChannelRefund: { amountCents: null; channelRefundTrxNo: null; completedAt: null; destination: null; bankArrival: "UNKNOWN"; reasonCodes: string[] };
  localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING"; writtenOffCents: string | null; releasedCents: string | null; bankArrival: "UNKNOWN" } | null;
  reasonCodes: string[];
  unknowns: string[];
};

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
  schemaVersion?: 1 | 2 | 3 | 4;
  rentalMode?: RentalMode;
  lines?: OrderLine[];
  unitAmountsInformational?: boolean;
  ownerTotal?: Money | null;
  ownerHaffRatio?: string | null;
  /** Present in the server projection; kept optional for older order reads. */
  resourceTotal?: Money | null;
  tenantDeposit?: Money | null;
  tenantPayableTotal?: Money | null;
};

export type OrderAmounts = {
  rental?: Money | null;
  deposit?: Money | null;
  totalDue?: Money | null;
  ownerExpectedIncome?: Money | null;
  ownerRecordedIncome?: Money | null;
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

export type OrderListingFacts = {
  source: "ORDER_VERSION" | "ACCOUNT_CURRENT" | "LEGACY_ACCOUNT_SNAPSHOT";
  sourceUpdatedAt?: string | null;
  versionId: string | null;
  rentalMode: string | null;
  attributeDisplay: { safeBox: string | null; grading: string | null; loginMethod: string | null };
  resourceLines: Array<{ itemId: string; code: string; name: string | null; quantity: string | null; unit: string }>;
  termSeconds: string | null;
};
export type OrderEntitlement = {
  id: string;
  name: string | null;
  nameSource: "ORDER_VERSION" | "CURRENT_CATALOG" | "UNKNOWN";
  expiresAt: string | null;
  expiryKind: "PERMANENT" | "TIMED" | null;
  fullTermGuaranteed: boolean | null;
};
export type OrderStage = {
  code: "NONE" | "OPENING_PENDING" | "RENTING" | "INTAKE_PENDING" | "DECISION_PENDING" | "DECISION_REJECTED" | "DECISION_WAITING" | "POSTED" | "UNKNOWN";
  label: string | null;
  viewerActionRequired: boolean;
  settlementVersionNo: number | null;
};

/** Server-authoritative fulfillment stage from the order IM projection, never derived from `Order.stage`. */
export type OrderImStage = "PENDING_PAYMENT" | "WAITING_STAFF" | "TEAM_PENDING" | "OPENING_CONFIRM" | "RENTING" | "ENDING" | "SETTLED" | "CANCELLED";
export type OrderImOpeningState = "NONE" | "DRAFT" | "PARTIAL" | "CONFIRMED";
export type OrderImEndState = "NONE" | "REQUESTED" | "POSTED";
/** Read-only slice of the order IM projection; the order page has no use for group members or routes. */
export type OrderImProjection = {
  stage: OrderImStage;
  cancelReason?: string | null;
  refundPending?: boolean;
  refundCompletedAt?: string | null;
  rentalStartedAt: string | null;
  dueAt: string | null;
  openingState: OrderImOpeningState;
  openingAcks: { renter: boolean; owner: boolean } | null;
  endState: OrderImEndState;
  orderEndedAt: string | null;
  sendUntil: string | null;
  canSend: boolean;
};
export type Order = {
  viewerParty?: OrderParty;
  earlySettlementDisclosure?: { versionId: string; digest: string; body?: string };
  source?: { origin: "NATIVE" | "LEGACY"; statusLabel?: string };
  readOnly?: boolean;
  legacyAmounts?: LegacyOrder["legacyAmounts"];
  legacyPaymentHistory?: LegacyOrder["legacyPaymentHistory"];
  payment?: LegacyOrder["payment"];
  paymentProvenance?: { source: "SIMULATED" | "JOINPAY" | "UNKNOWN"; channelArrival: "UNKNOWN" } | null;
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
  amountsPerspective?: "OWNER" | "RENTER";
  ownerIncomeSource?: { source: "LEGACY_ORDER_SNAPSHOT"; sourceLabel: string };
  fundsResolution?: { status: "REVIEW_REQUIRED"; code: "HISTORICAL_MANUAL_CLOSE"; sourceLabel: string };
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
  accountDisplayNo?: string | null;
  listingFacts?: OrderListingFacts | null;
  listingFactsUnknownReason?: "ORDER_VERSION_UNREADABLE" | "ACCOUNT_PUBLIC_VERSION_MISSING" | "UNREADABLE" | "ACCOUNT_UNLINKED" | null;
  entitlements?: OrderEntitlement[] | null;
  entitlementsUnknownReason?: "NOT_DISCLOSED" | "NOT_FROZEN" | "UNREADABLE" | null;
  /** Frozen renter membership marker; payableRatio is the aggregate discount, not a per-line rate. */
  membership?: { tier: string; payableRatio?: string | null } | null;
  stage?: OrderStage | null;
};

export type LegacyOrder = {
  listingFacts?: OrderListingFacts | null;
  listingFactsUnknownReason?: Order["listingFactsUnknownReason"];
  stage?: OrderStage | null;
  id: string; displayNo: string; status: OrderStatus | "UNKNOWN"; party: OrderParty; title: string | null; gameId: string;
  source: { origin: "LEGACY"; ruleOrigin: "LEGACY_ORDER"; originalStatus: number; originalPayStatus: number; statusLabel: string };
  createdAt: string | null; paidAt: string | null; cancelledAt: string | null; completedAt: string | null;
  amounts: { rental: Money | null; deposit: Money | null; totalDue: Money | null; currency: "CNY"; ownerExpectedIncome?: Money | null; ownerRecordedIncome?: Money | null };
  amountsPerspective?: "OWNER" | "RENTER";
  ownerIncomeSource?: { source: "LEGACY_ORDER_SNAPSHOT"; sourceLabel: string };
  payment: { state: "RECORDED_PAID" | "RECORDED_UNPAID" | "UNKNOWN"; recordedAt: string | null; recordedAmount: Money | null };
  legacyAmounts: { required: Money | null; paid: Money | null; deposit: Money | null; goods?: Money | null; items?: Money | null; refund: Money | null; refundChannelState: "NOT_RECORDED_BY_SOURCE" | "PENDING" | "UNKNOWN" } | null;
  legacyRefundHistory?: { records: { id: string; amount: Money; status: "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"; recordedAt: string | null }[]; incomplete: boolean; coverage?: "MATCHED_RECORDS_ONLY"; channelArrival: "UNKNOWN" };
  legacyPaymentHistory?: { records: { id: string; amount: Money; status: "RECORDED_PAID" | "RECORDED_UNPAID" | "UNKNOWN"; method: "WECHAT" | "ALIPAY" | "UNKNOWN"; recordedAt: string | null; paidAt: string | null }[]; incomplete: boolean; coverage: "MATCHED_RECORDS_ONLY"; channelArrival: "UNKNOWN" };
  account: { id: string | null; displayNo: string | null; readable: boolean };
  orderFacts?: LegacyOrderFacts;
  readOnly: true; paymentOpen: false; cancelOpen: false; continuationCount: 0; actions: never[];
};
export type LegacyOrderPage = { items: LegacyOrder[]; page: number; pageSize: number; total: number };

export type OrderPage = { items: Order[]; nextCursor: string | null; limit: number; scanIncomplete?: boolean; stageUnknownObserved?: boolean };
export type OrderSearchFilters = { orderNo?: string; createdFrom?: string; createdTo?: string; stage?: string };

export function orderUrl(party: OrderParty, status: OrderStatusFilter, accountId?: string, orderId?: string, source?: "NATIVE" | "LEGACY", filters?: OrderSearchFilters): string {
  const query = new URLSearchParams({ view: party === "renter" ? "rentals" : "leased" });
  if (status && status !== "IN_PROGRESS") query.set("status", status);
  if (accountId) query.set("accountId", accountId);
  if (orderId) query.set("orderId", orderId);
  if (orderId && source === "LEGACY") query.set("source", "legacy");
  for (const key of ["orderNo", "createdFrom", "createdTo", "stage"] as const) if (filters?.[key]) query.set(key, filters[key]!);
  return `/account?${query.toString()}`;
}

export type RentalPricePreviewInput = { accountId: string; versionId: string; releaseId: string };
/** Read-only price view. It is not a transaction confirmation or an order credential. */
export type RentalPricePreview = {
  schema: "rental-price-preview.v1";
  binding: RentalPricePreviewInput & { listingHash: string };
  asOfUtc: string;
  refreshAfterUtc: string;
  quote: PublicQuote & { tenantDeposit: Money; tenantPayableTotal: Money; baseRenterHaffRatioWanPerYuan: string | null };
  baseTenantDeposit: Money;
  customerTier?: "STANDARD" | "VIP" | "SVIP" | "DISCOUNT_USER";
  membershipBenefits?: {schema:"membership-benefits-v1";effectiveTier:"STANDARD"|"SILVER"|"GOLD"|"PLATINUM"|"DIAMOND"|"BLACK_GOLD";policyTier:"STANDARD"|"SILVER"|"GOLD"|"PLATINUM"|"DIAMOND";priceSource:"GROWTH"|"FRIEND"|"PRESTIGE";depositSource:"GROWTH"|"FRIEND"|"PRESTIGE";policyVersion:string};
  compensationDisclosure?: { selected: boolean; disclosureVersion: string; terms?: FullPayoutTerms };
};

export type RentalAgreement = { id: string; title: string; body: string; digest: string; bodyDocument?: import("@zzsh/content/plate").PlateDocumentEnvelope | null };

export type PersonalRentalQuote = {
  agreement?: RentalAgreement;
  agreementAcceptance?: { versionId: string; digest: string };
  quote: OrderQuote & { resourceTotal?: Money | null; tenantDeposit?: Money | null; tenantPayableTotal?: Money | null };
  baseTenantDeposit: Money | null;
  /** Only frozen compatibility quotes carry the former tier enum. */
  customerTier?: string;
  membershipBenefits?: {schema:"membership-benefits-v1";effectiveTier:"STANDARD"|"SILVER"|"GOLD"|"PLATINUM"|"DIAMOND"|"BLACK_GOLD";policyTier:"STANDARD"|"SILVER"|"GOLD"|"PLATINUM"|"DIAMOND";priceSource:"GROWTH"|"FRIEND"|"PRESTIGE";depositSource:"GROWTH"|"FRIEND"|"PRESTIGE";policyVersion:string};
  depositWaived: boolean;
  compensationDisclosure?: { selected: boolean; disclosureVersion: string; terms?: FullPayoutTerms };
  confirmationId: string;
  listingHash: string;
  expiresAt: string;
  confirmationToken: string;
};

export type SettlementLine = { itemId: string; name?: string | null; quantity?: string; unit?: string; pricingKind?: string };
export type SettlementQuantityInput = { itemId: string; remainingQuantity: string } | { itemId: string; consumedQuantity: string };
export type SettlementOpening = {
  id: string;
  versionNo: string;
  status: string;
  /** Authoritative "rental started" time for a confirmed opening; never inferred from payment or the client clock. */
  confirmedAt?: string | null;
  createdAt?: string;
  createdBySource?: "ADMIN" | "SYSTEM" | null;
  autoConfirmDueAt?: string | null;
  autoConfirmWaitMinutes?: number | null;
  lines: SettlementLine[];
  acks?: Array<{ party: string; source?: string; createdAt?: string }>;
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
  inputSnapshot?: { lines?: Array<{ itemId: string; openingQuantity?: string; remainingQuantity?: string; consumedQuantity?: string }>; endReason?: string | null; reason?: string | null; proposedOwnerGross?: string | null; proposedFullPayoutFee?: string | null } | null;
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
  /** `gross` comes from the frozen yuan snapshot; the Cents fields are the exact net/refund columns. */
  owner?: { gross?: Money | string | null; systemNetCents?: string; availableCents?: string } | null;
  /**
   * `includesDeposit` is *not* a boolean in the current server projection: the backend assigns the
   * depositRefund amount object (or null) to it. The deposit to refund is read from
   * `amounts.depositRefund`, never from this field's truthiness.
   */
  refund?: { systemCents?: string; payableCents?: string; includesDeposit?: unknown } | null;
  manualAdjustment?: {
    reason?: string | null;
    proposedOwnerGross?: string | null;
    proposedFullPayoutFee?: string | null;
    systemOwnerNetCents?: string;
    postedOwnerNetCents?: string;
    systemRenterRefundCents?: string;
    postedRenterRefundCents?: string;
  } | null;
};
/** Server-owned stage summary returned by readSettlement(); absent on older projections. */
export type OrderSettlementStage = {
  code: "NONE" | "OPENING_PENDING" | "RENTING" | "INTAKE_PENDING" | "DECISION_PENDING" | "DECISION_WAITING" | "DECISION_REJECTED" | "POSTED" | "UNKNOWN";
  label: string | null;
  viewerActionRequired: boolean;
  settlementVersionNo: number | null;
};
export type EarlySettlementDisclosure = { versionId: string; body: string; digest: string; bodyDocument?: import("@zzsh/content/plate").PlateDocumentEnvelope };

export type OrderSettlement = {
  earlySettlementDisclosure?: EarlySettlementDisclosure;
  earlySettlementDisclosureUnavailable?: boolean;
  orderId: string;
  revision?: string;
  /** Additive settlementStageOf() result. Prefer it over a client-side reconstruction when present. */
  stage?: OrderSettlementStage | null;
  rentalStarted?: boolean;
  consumptionMode?: "REMAINING" | "ACTUAL" | "UNAVAILABLE";
  extraResources?: SettlementLine[];
  openings: SettlementOpening[];
  openingGeneration?: { state: "CREATED" | "REVIEW_REQUIRED"; reason?: string | null; createdAt?: string; updatedAt?: string } | null;
  openingGenerationRecoveryRequired?: boolean;
  intakes: Array<{ id: string; versionNo: string; status: string; initiatorParty?: string; settlementVersionId?: string | null; createdAt?: string; lines?: Array<{ itemId: string; remainingQuantity?: string; consumedQuantity?: string }> }>;
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
  earlySettlementDisclosure?: EarlySettlementDisclosure;
  accepted: false;
  reasons: string[];
  amounts?: Record<string, unknown>;
  versionHash?: string;
  consumed?: { haff?: unknown; items?: Array<{ itemId: string; consumed: string; remaining: string }> } | null;
};

export function formatOrderTime(value: string | null | undefined, options: { timeZoneName?: boolean } = {}): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未记录";
  // 订单时间默认带显式时区偏移；记录行传 timeZoneName:false 收敛逐行 GMT 噪声，时区在页面说明中一次性交代。
  const base = {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Shanghai", hourCycle: "h23",
  } as const;
  return new Intl.DateTimeFormat("zh-CN", options.timeZoneName === false ? base : { ...base, timeZoneName: "longOffset" }).format(date);
}

export function formatOrderMoney(value: { amount?: unknown; currency?: unknown } | null | undefined): string {
  if (!value || value.currency !== "CNY" || typeof value.amount !== "string" || !/^\d+\.\d{2}$/.test(value.amount)) return "未记录";
  const whole = value.amount.slice(0, -3);
  const fraction = value.amount.slice(-2);
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction} 元`;
}

const refundOutcomes: readonly PersonalRefundOutcome[] = ["RESPONSIBILITY_NOT_POSTED", "ZERO_RESPONSIBILITY", "NOT_DUE", "NO_INTENT", "PARTIALLY_ALLOCATED", "FULLY_ALLOCATED", "PARTIALLY_CONSUMED", "FULLY_CONSUMED", "RELEASED", "PROCESSING", "UNKNOWN", "REVIEW_REQUIRED", "TRUNCATED", "CONFLICT"];
const refundIntentStates = ["READY", "SUBMITTING", "UNKNOWN", "PROCESSING", "REVIEW_REQUIRED", "SUCCEEDED", "FAILED", "UNRECOGNIZED"] as const;
const refundDispositions = ["ALLOCATED", "CONSUMED", "RELEASED", "UNRECOGNIZED"] as const;
const invalidRefund = () => new OrderRequestError(502, null);
const refundRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRefund();
  return value as Record<string, unknown>;
};
const refundText = (value: unknown, max = 256): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value)) throw invalidRefund();
  return value;
};
const refundNullableText = (value: unknown, max = 256): string | null => value === null ? null : refundText(value, max);
const refundTime = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalidRefund();
  return value;
};
const refundCents = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,23})$/.test(value)) throw invalidRefund();
  return value;
};
const refundStrings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 100) throw invalidRefund();
  return value.map((item) => refundText(item, 160));
};
const refundObservation = (value: unknown): PersonalRefundObservation | null => {
  if (value === null) return null;
  const v = refundRecord(value);
  if (v.source !== "JOINPAY" && v.source !== "CONTROLLED") throw invalidRefund();
  const event = refundText(v.event, 64), observedAt = refundTime(v.observedAt);
  if (!/^[A-Z][A-Z_]{0,63}$/.test(event) || observedAt === null || (v.ageSeconds !== null && (!Number.isSafeInteger(v.ageSeconds) || (v.ageSeconds as number) < 0))
    || v.trust !== "LOCAL_OBSERVATION_NOT_REVALIDATED") throw invalidRefund();
  return {
    source: v.source, event, failureReason: refundNullableText(v.failureReason, 160),
    evidenceLevel: refundNullableText(v.evidenceLevel, 64), observedAt,
    ageSeconds: v.ageSeconds as number | null, trust: v.trust,
  };
};
const refundIntent = (value: unknown): PersonalRefundIntent => {
  const v = refundRecord(value), amount = v.amount === null ? null : refundRecord(v.amount);
  const accounting = refundRecord(v.localAccounting), channelFacts = refundRecord(v.channelFacts);
  const evidence = v.savedChannelEvidence === null ? null : refundRecord(v.savedChannelEvidence);
  const writeOff = accounting.writeOff === null ? null : refundRecord(accounting.writeOff);
  const release = accounting.release === null ? null : refundRecord(accounting.release);
  if (amount && (amount.currency !== "CNY" || refundCents(amount.cents) === null)) throw invalidRefund();
  if (!refundIntentStates.includes(v.state as typeof refundIntentStates[number]) || !refundDispositions.includes(v.budgetDisposition as typeof refundDispositions[number])
    || typeof v.requiresReview !== "boolean" || !refundDispositions.includes(accounting.disposition as typeof refundDispositions[number])
    || channelFacts.actualAmountCents !== null || channelFacts.channelRefundTrxNo !== null || channelFacts.completedAt !== null || channelFacts.destination !== null || channelFacts.bankArrival !== "UNKNOWN") throw invalidRefund();
  if (evidence && (!["SUCCEEDED", "FAILED_NO_EXECUTION"].includes(String(evidence.terminal)) || evidence.trust !== "SAVED_EVIDENCE_NOT_REVALIDATED")) throw invalidRefund();
  if (writeOff && (writeOff.trust !== "LOCAL_LEDGER" || refundCents(writeOff.amountCents) === null)) throw invalidRefund();
  if (release && (release.ledgerEventId !== null || release.trust !== "LOCAL_INTENT_ONLY")) throw invalidRefund();
  if (v.basisKind !== undefined && v.basisKind !== "POSTING") throw invalidRefund();
  const basisKind = v.basisKind === undefined ? undefined : v.basisKind as PersonalRefundBasis;
  const paymentConfirmationId = v.paymentConfirmationId === undefined ? undefined : refundNullableText(v.paymentConfirmationId, 180);
  return {
    intentId: refundText(v.intentId, 180),
    refundOrderNo: v.refundOrderNo === null ? null : (() => { const text = refundText(v.refundOrderNo, 32); if (!/^RF[0-9a-f]{28}$/.test(text)) throw invalidRefund(); return text; })(),
    source: v.source === "LOCAL_CONTROLLED" || v.source === "JOINPAY_FORMAL" || v.source === "UNRECOGNIZED" ? v.source : (() => { throw invalidRefund(); })(),
    evidenceLevel: refundNullableText(v.evidenceLevel, 64),
    ...(basisKind === undefined ? {} : { basisKind }),
    ...(paymentConfirmationId === undefined ? {} : { paymentConfirmationId }),
    amount: amount ? { cents: amount.cents as string, currency: "CNY" as const } : null,
    state: v.state as PersonalRefundIntent["state"],
    budgetDisposition: v.budgetDisposition as PersonalRefundIntent["budgetDisposition"],
    requiresReview: v.requiresReview,
    dueAt: refundTime(v.dueAt), createdAt: refundTime(v.createdAt), updatedAt: refundTime(v.updatedAt),
    latestObservation: refundObservation(v.latestObservation), latestFailure: refundObservation(v.latestFailure),
    savedChannelEvidence: evidence ? {
      terminal: evidence.terminal as "SUCCEEDED" | "FAILED_NO_EXECUTION", evidenceLevel: refundNullableText(evidence.evidenceLevel, 64),
      providerRefundTrxNo: refundNullableText(evidence.providerRefundTrxNo, 128), completedAt: refundTime(evidence.completedAt),
      trust: "SAVED_EVIDENCE_NOT_REVALIDATED",
    } : null,
    localAccounting: {
      disposition: accounting.disposition as PersonalRefundIntent["localAccounting"]["disposition"],
      writeOff: writeOff ? { eventId: refundText(writeOff.eventId, 180), amountCents: refundCents(writeOff.amountCents)!, postedAt: refundTime(writeOff.postedAt), trust: "LOCAL_LEDGER" } : null,
      release: release ? { intentUpdatedAt: refundTime(release.intentUpdatedAt), ledgerEventId: null, trust: "LOCAL_INTENT_ONLY" } : null,
      reasonCodes: refundStrings(accounting.reasonCodes),
    },
    channelFacts: { actualAmountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN", reasonCodes: refundStrings(channelFacts.reasonCodes) },
    reasonCodes: refundStrings(v.reasonCodes),
  };
};

/** Validates the whole accepted projection so no unverified refund figure reaches the page. */
export function parsePersonalRefunds(value: unknown, expectedUserId: string, expectedOrderId: string): PersonalRefundRead {
  const root = refundRecord(value), order = refundRecord(root.order), coverage = refundRecord(root.coverage);
  const responsibility = refundRecord(root.responsibility), actual = refundRecord(root.actualChannelRefund);
  const funds = root.localFundsEffect === null ? null : refundRecord(root.localFundsEffect);
  const prestart = root.prestartRefund === undefined ? undefined : refundRecord(root.prestartRefund);
  const cancellation = root.cancellationRefund === undefined ? undefined : refundRecord(root.cancellationRefund);
  if (prestart && cancellation) throw invalidRefund();
  for (const summary of [prestart, cancellation]) if (summary && (order.status !== "CANCELLED" || !["PROCESSING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(String(summary.state))
    || !["SIMULATED", "JOINPAY", "UNKNOWN"].includes(String(summary.source)) || summary.bankArrival !== "UNKNOWN"
    || summary.amountCents !== null && (typeof summary.amountCents !== "string" || !/^[1-9][0-9]{0,15}$/.test(summary.amountCents))
    || summary.state !== "UNKNOWN" && (summary.source === "UNKNOWN" || summary.amountCents === null))) throw invalidRefund();
  const intents = Array.isArray(root.intents) ? root.intents.map(refundIntent) : (() => { throw invalidRefund(); })();
  const noResponsibilityTotals = ["allocatedCents", "consumedCents", "releasedCents", "remainingCents"].every((name) => responsibility[name] === null);
  if (responsibility.state === "NOT_POSTED" && (responsibility.totalsComplete || responsibility.postingId !== null
    || responsibility.originalCents !== null || !noResponsibilityTotals)) throw invalidRefund();
  if (root.contractVersion !== "personal-native-refunds.v1" || root.subjectId !== expectedUserId || order.orderId !== expectedOrderId
    || !["AVAILABLE", "NOT_APPLICABLE"].includes(String(root.status)) || !refundOutcomes.includes(root.outcome as PersonalRefundOutcome)
    || coverage.scope !== "LOCAL_REGISTERED_ONLY" || coverage.intentLimit !== 50 || typeof coverage.intentsComplete !== "boolean" || coverage.channelRecordsChecked !== false
    || !refundTime(root.asOf) || !["POSTED", "NOT_POSTED"].includes(String(responsibility.state))
    || !["DUE", "NOT_DUE", "UNKNOWN"].includes(String(responsibility.dueState)) || typeof responsibility.totalsComplete !== "boolean"
    || typeof root.returnedIntentCount !== "number" || root.returnedIntentCount !== intents.length || intents.length > 50
    || (!coverage.intentsComplete && (!noResponsibilityTotals || responsibility.totalsComplete))
    || (root.status === "NOT_APPLICABLE" && responsibility.state !== "NOT_POSTED")
    || typeof root.intentsTruncated !== "boolean"
    || (root.intentsTruncated && (responsibility.totalsComplete || coverage.intentsComplete || !noResponsibilityTotals
      || funds !== null && (funds.writtenOffCents !== null || funds.releasedCents !== null)))
    || (root.outcome === "CONFLICT" && (responsibility.totalsComplete || !noResponsibilityTotals
      || funds !== null && (funds.writtenOffCents !== null || funds.releasedCents !== null)))
    || actual.amountCents !== null || actual.channelRefundTrxNo !== null || actual.completedAt !== null || actual.destination !== null || actual.bankArrival !== "UNKNOWN"
    || typeof order.displayNo !== "string" && order.displayNo !== null) throw invalidRefund();
  if (funds && (funds.basis !== "LOCAL_REGISTERED_ACCOUNTING" || funds.bankArrival !== "UNKNOWN")) throw invalidRefund();
  return {
    contractVersion: root.contractVersion, subjectId: expectedUserId,
    order: { orderId: order.orderId, displayNo: order.displayNo as string | null, status: refundText(order.status, 32) },
    status: root.status as PersonalRefundRead["status"], outcome: root.outcome as PersonalRefundOutcome,
    ...(prestart ? { prestartRefund: { state: prestart.state as NonNullable<PersonalRefundRead["prestartRefund"]>["state"],
      amountCents: refundCents(prestart.amountCents), source: prestart.source as NonNullable<PersonalRefundRead["prestartRefund"]>["source"], bankArrival: "UNKNOWN" as const } } : {}),
    ...(cancellation ? { cancellationRefund: { state: cancellation.state as NonNullable<PersonalRefundRead["cancellationRefund"]>["state"],
      amountCents: refundCents(cancellation.amountCents), source: cancellation.source as NonNullable<PersonalRefundRead["cancellationRefund"]>["source"], bankArrival: "UNKNOWN" as const } } : {}),
    coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: 50, intentsComplete: coverage.intentsComplete, channelRecordsChecked: false },
    asOf: root.asOf as string,
    responsibility: {
      state: responsibility.state as PersonalRefundRead["responsibility"]["state"],
      postingId: refundNullableText(responsibility.postingId, 180),
      originalCents: refundCents(responsibility.originalCents), allocatedCents: refundCents(responsibility.allocatedCents),
      consumedCents: refundCents(responsibility.consumedCents), releasedCents: refundCents(responsibility.releasedCents),
      remainingCents: refundCents(responsibility.remainingCents), totalsComplete: responsibility.totalsComplete,
      dueAt: refundTime(responsibility.dueAt), dueState: responsibility.dueState as PersonalRefundRead["responsibility"]["dueState"],
    },
    intents, returnedIntentCount: intents.length, intentsTruncated: root.intentsTruncated,
    actualChannelRefund: { amountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN", reasonCodes: refundStrings(actual.reasonCodes) },
    localFundsEffect: funds ? { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: refundCents(funds.writtenOffCents), releasedCents: refundCents(funds.releasedCents), bankArrival: "UNKNOWN" } : null,
    reasonCodes: refundStrings(root.reasonCodes), unknowns: refundStrings(root.unknowns),
  };
}

const ORDER_IM_STAGES: readonly OrderImStage[] = ["PENDING_PAYMENT", "WAITING_STAFF", "TEAM_PENDING", "OPENING_CONFIRM", "RENTING", "ENDING", "SETTLED", "CANCELLED"];
const ORDER_IM_OPENING_STATES: readonly OrderImOpeningState[] = ["NONE", "DRAFT", "PARTIAL", "CONFIRMED"];
const ORDER_IM_END_STATES: readonly OrderImEndState[] = ["NONE", "REQUESTED", "POSTED"];
const invalidOrderIm = () => new OrderRequestError(502, null);
const orderImTime = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalidOrderIm();
  return value;
};

/**
 * The stage is the only fact the bar may not invent: a projection without a recognized `stage`
 * is rejected as a whole, so the page shows "阶段未确认" instead of borrowing another status.
 * Missing optional facts stay unknown (null / false), never guessed.
 */
export function parseOrderImProjection(value: unknown): OrderImProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidOrderIm();
  const root = value as Record<string, unknown>;
  if (!ORDER_IM_STAGES.includes(root.stage as OrderImStage)) throw invalidOrderIm();
  const rawAcks = root.openingAcks;
  let openingAcks: OrderImProjection["openingAcks"] = null;
  if (rawAcks !== null && rawAcks !== undefined) {
    if (typeof rawAcks !== "object" || Array.isArray(rawAcks)
      || typeof (rawAcks as Record<string, unknown>).renter !== "boolean"
      || typeof (rawAcks as Record<string, unknown>).owner !== "boolean") throw invalidOrderIm();
    openingAcks = { renter: (rawAcks as { renter: boolean }).renter, owner: (rawAcks as { owner: boolean }).owner };
  }
  const openingState = root.openingState === undefined ? "NONE" : root.openingState;
  const endState = root.endState === undefined ? "NONE" : root.endState;
  if (!ORDER_IM_OPENING_STATES.includes(openingState as OrderImOpeningState)
    || !ORDER_IM_END_STATES.includes(endState as OrderImEndState)) throw invalidOrderIm();
  const canSend = root.canSend === undefined ? false : root.canSend;
  if (typeof canSend !== "boolean") throw invalidOrderIm();
  if (root.cancelReason !== undefined && root.cancelReason !== null && typeof root.cancelReason !== "string") throw invalidOrderIm();
  const refundPending = root.refundPending === undefined ? false : root.refundPending;
  if (typeof refundPending !== "boolean") throw invalidOrderIm();
  return {
    stage: root.stage as OrderImStage,
    ...(typeof root.cancelReason === "string" ? { cancelReason: root.cancelReason } : {}),
    refundPending,
    rentalStartedAt: orderImTime(root.rentalStartedAt),
    dueAt: orderImTime(root.dueAt),
    openingState: openingState as OrderImOpeningState,
    openingAcks,
    endState: endState as OrderImEndState,
    orderEndedAt: orderImTime(root.orderEndedAt),
    sendUntil: orderImTime(root.sendUntil),
    ...(root.refundCompletedAt !== undefined ? { refundCompletedAt: orderImTime(root.refundCompletedAt) } : {}),
    canSend,
  };
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

/** A frozen subject captured when the read/write was created or recovered, never a live global. */
export type OrderSubjectInput = OrderSubject | string;
type ReadOptions = { signal?: AbortSignal; subject?: OrderSubjectInput };

/**
 * Every `/api/orders` request must carry the subject captured at creation/recovery time. There is
 * deliberately no fallback to a mutable "current user" registry: a delayed original intent for A
 * must never be sent with a subject that was registered later for B. The BFF compares the value
 * with the Cookie session captured for the same request; the API still owns object authorization.
 * Non-order endpoints (price preview, confirmation, v2 creation) keep their own contracts.
 *
 * A missing or malformed subject is a 401 so `performGuardedWrite` returns `unauthorized` and
 * **keeps the frozen original key/body** instead of clearing the intent or generating a new key.
 */
function expectedUserFor(path: string, explicit: OrderSubjectInput | undefined): string | undefined {
  if (!path.startsWith("/api/orders")) return undefined;
  const userId = orderSubjectUserId(explicit);
  if (!userId) throw new OrderRequestError(401, { error: { code: "ORDER_SUBJECT_NOT_FROZEN", message: "订单请求缺少创建或恢复时冻结的操作主体；原申请已保留，请刷新页面后按原请求核对。" } });
  return userId;
}

async function requestJson<T>(path: string, options: ReadOptions = {}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("Order path must be relative");
  }
  const expectedUserId = expectedUserFor(path, options.subject);
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: options.signal, ...(expectedUserId === undefined ? {} : { headers: { "x-zzsh-expected-user-id": expectedUserId } }) });
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
  const order = body && typeof body === "object" && "order" in body && body.order ? body.order : body as Order;
  if (order && Object.hasOwn(order, "viewerParty") && order.viewerParty !== "renter" && order.viewerParty !== "owner") throw new OrderRequestError(502, null);
  return order;
}

type WriteOptions = { method?: "POST"; body?: unknown; key?: string; signal?: AbortSignal; subject?: OrderSubjectInput };

async function requestWrite<T>(path: string, options: WriteOptions): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("Order path must be relative");
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (options.key) headers.set("idempotency-key", options.key);
  const expectedUserId = expectedUserFor(path, options.subject);
  if (expectedUserId !== undefined) headers.set("x-zzsh-expected-user-id", expectedUserId);
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

async function requestOpeningConfirmation(subject: OrderSubjectInput, orderId: string, openingId: string, versionNo: number, key: string, signal?: AbortSignal): Promise<OrderSettlement> {
  const result = await requestWrite<unknown>(`/api/orders/${encodeURIComponent(orderId)}/openings/${encodeURIComponent(openingId)}/confirm`, { body: { versionNo }, key, signal, subject });
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new OrderRequestError(502, null);
  const body = result as Record<string, unknown>;
  if (body.orderId !== orderId || !Array.isArray(body.openings) || body.openings.filter(opening =>
    opening && typeof opening === "object" && opening.id === openingId && (opening.versionNo === versionNo || opening.versionNo === String(versionNo))).length !== 1)
    throw new OrderRequestError(502, null);
  return result as OrderSettlement;
}

export function orderIntentKey(): string {
  return "op_" + crypto.randomUUID().replaceAll("-", "");
}

type OrderListInput = { party: OrderParty; status?: OrderStatus | "IN_PROGRESS"; accountId?: string; limit?: number; cursor?: string } & OrderSearchFilters;
function orderListQuery(input: OrderListInput): string {
  const query = new URLSearchParams({ party: input.party, limit: String(input.limit ?? 20) });
  if (input.status === "IN_PROGRESS") query.set("view", "IN_PROGRESS");
  else if (input.status) query.set("status", input.status);
  if (input.accountId) query.set("accountId", input.accountId);
  if (input.orderNo) query.set("orderNo", input.orderNo);
  if (input.createdFrom) query.set("createdFrom", input.createdFrom);
  if (input.createdTo) query.set("createdTo", input.createdTo);
  if (input.stage) query.set("stage", input.stage);
  if (input.cursor) query.set("cursor", input.cursor);
  return query.toString();
}


export type OwnerRefundMinimalSummary = {
  contractVersion: "owner-refund-minimal.v1";
  subjectId: string;
  orderId: string;
  orderStatus: string;
  progress: "NONE" | "PROCESSING" | "NEEDS_REVIEW" | "UNKNOWN" | "DONE" | "NOT_APPLICABLE";
  label: string;
  note: string;
  openIntentCount: number;
  asOf: string;
};

function parseOwnerRefundSummary(value: unknown, userId: string, orderId: string): OwnerRefundMinimalSummary {
  if (!value || typeof value !== "object") throw invalidRefund();
  const v = value as Record<string, unknown>;
  if (v.contractVersion !== "owner-refund-minimal.v1") throw invalidRefund();
  if (v.subjectId !== userId || v.orderId !== orderId) throw invalidRefund();
  if (typeof v.orderStatus !== "string" || typeof v.label !== "string" || typeof v.note !== "string" || typeof v.asOf !== "string") throw invalidRefund();
  if (typeof v.openIntentCount !== "number" || !Number.isInteger(v.openIntentCount) || v.openIntentCount < 0) throw invalidRefund();
  if (!["NONE", "PROCESSING", "NEEDS_REVIEW", "UNKNOWN", "DONE", "NOT_APPLICABLE"].includes(String(v.progress))) throw invalidRefund();
  for (const key of Object.keys(v)) {
    if (["bank", "destination", "accountNo", "card", "payout"].some((part) => key.toLowerCase().includes(part))) throw invalidRefund();
  }
  return {
    contractVersion: "owner-refund-minimal.v1",
    subjectId: userId,
    orderId,
    orderStatus: v.orderStatus,
    progress: v.progress as OwnerRefundMinimalSummary["progress"],
    label: v.label,
    note: v.note,
    openIntentCount: v.openIntentCount,
    asOf: v.asOf,
  };
}

/**
 * Every `/api/orders` method takes the frozen subject as its first argument. The value must be
 * captured when the read/write is created or recovered (the intent owner for guarded writes, the
 * rendered session subject for reads); it is never read from a later, mutable registration.
 */
export const orderApi = {
  listLegacy: (subject: OrderSubjectInput, input: { party: OrderParty; page?: number; pageSize?: number; status?: OrderStatus | "UNKNOWN"; accountId?: string }, signal?: AbortSignal) => {
    const query = new URLSearchParams({ party: input.party, page: String(input.page ?? 1), pageSize: String(input.pageSize ?? 20) });
    if (input.status) query.set("status", input.status);
    if (input.accountId) query.set("accountId", input.accountId);
    return requestJson<LegacyOrderPage>(`/api/orders/legacy?${query.toString()}`, { signal, subject });
  },
  legacyDetail: async (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    (await requestJson<{ order: LegacyOrder }>(`/api/orders/legacy/${encodeURIComponent(orderId)}`, { signal, subject })).order,
  list: (subject: OrderSubjectInput, input: OrderListInput, signal?: AbortSignal) =>
    requestJson<OrderPage>(`/api/orders?${orderListQuery(input)}`, { signal, subject }),
  listUnified: (subject: OrderSubjectInput, input: OrderListInput, signal?: AbortSignal) =>
    requestJson<OrderPage>(`/api/orders/unified?${orderListQuery(input)}`, { signal, subject }),
  detail: (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    requestJson<{ order: Order }>(`/api/orders/${encodeURIComponent(orderId)}`, { signal, subject }).then(unwrapOrder),
  /** Read-only fulfillment projection; same authorization and same-origin read as the order group. */
  orderIm: (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    requestJson<unknown>(`/api/orders/${encodeURIComponent(orderId)}/im?operation=read`, { signal, subject }).then(parseOrderImProjection),
  personalRefunds: async (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    parsePersonalRefunds(await requestJson<unknown>(`/api/orders/${encodeURIComponent(orderId)}/refunds`, { signal, subject }), orderSubjectUserId(subject)!, orderId),
  ownerRefundSummary: async (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    parseOwnerRefundSummary(await requestJson<unknown>(`/api/orders/${encodeURIComponent(orderId)}/refunds`, { signal, subject }), orderSubjectUserId(subject)!, orderId),
  previewRentalPrice: (input: RentalPricePreviewInput, signal?: AbortSignal) =>
    requestJson<RentalPricePreview>(`/api/rental-price-preview?${new URLSearchParams({ accountId: input.accountId, versionId: input.versionId, releaseId: input.releaseId }).toString()}`, { signal }),
  confirmRental: (input: { accountId: string; versionId: string; releaseId: string; fullPayoutTermsAcceptance?: FullPayoutTermsAcceptance }, signal?: AbortSignal) =>
    requestWrite<PersonalRentalQuote>("/api/order-confirmations", { body: input, signal }),
  createOrder: (confirmationToken: string, key: string, fullPayoutTermsAcceptance?: FullPayoutTermsAcceptance, agreementAcceptance?: { versionId: string; digest: string }, signal?: AbortSignal) =>
    requestWrite<{ order: Order }>("/api/v2/orders", { body: { confirmationToken, ...(fullPayoutTermsAcceptance ? { fullPayoutTermsAcceptance } : {}), ...(agreementAcceptance ? { agreementAcceptance } : {}) }, key, signal }).then(unwrapOrder),
  cancel: (subject: OrderSubjectInput, orderId: string, key: string, reason?: string, signal?: AbortSignal) =>
    requestWrite<{ order?: Order } | Order>(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { key, body: reason ? { reason } : {}, signal, subject }),
  pay: (subject: OrderSubjectInput, orderId: string, key: string, signal?: AbortSignal) =>
    requestWrite<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>(
      `/api/orders/${encodeURIComponent(orderId)}/payment-requests`, { key, signal, subject }),
  paymentStatus: (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    requestJson<{ order: { id: string; displayNo?: string | null; status: string; paidAt?: string | null }; payment: { confirmationId: string; disposition: string; reasonCode?: string | null; amountCents: string; currency: string; acceptedAt: string } | null }>(
      `/api/orders/${encodeURIComponent(orderId)}/payment-requests`, { signal, subject }),
  requestChannelPayment: (subject: OrderSubjectInput, orderId: string, method: ChannelPaymentMethod, key: string, signal?: AbortSignal) =>
    requestWrite<ChannelPaymentCommandReceipt>(`/api/orders/${encodeURIComponent(orderId)}/channel-payment-requests`, { body: { method }, key, signal, subject }),
  channelPaymentStatus: (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    requestJson<ChannelPaymentView>(`/api/orders/${encodeURIComponent(orderId)}/channel-payment-requests`, { signal, subject }),
  queryChannelPayment: (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    requestWrite<ChannelPaymentQueryReceipt>(`/api/orders/${encodeURIComponent(orderId)}/channel-payment-requests/query`, { body: {}, signal, subject }),
  localCheckoutAvailability: (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    requestJson<unknown>(`/api/orders/${encodeURIComponent(orderId)}/local-checkouts`, { signal, subject }).then(value => parseLocalCheckoutAvailability(value, orderId)),
  issueLocalCheckout: (subject: OrderSubjectInput, orderId: string, key: string) =>
    requestWrite<unknown>(`/api/orders/${encodeURIComponent(orderId)}/local-checkouts`, { body: {}, key, subject }),
  localCheckoutReceipt: (subject: OrderSubjectInput, orderId: string, key: string, signal?: AbortSignal) =>
    requestJson<{ scope: string; knowledge: string; mayReapply: boolean; receipt: unknown }>(`/api/orders/${encodeURIComponent(orderId)}/local-checkouts/receipt?${new URLSearchParams({ key })}`, { signal, subject }),
  demoCheckoutAvailability: (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    requestJson<unknown>(`/api/orders/${encodeURIComponent(orderId)}/demo-checkout`, { signal, subject }).then(value => parseDemoCheckoutAvailability(value, orderId)),
  confirmDemoCheckout: (subject: OrderSubjectInput, orderId: string, key: string) =>
    requestWrite<unknown>(`/api/orders/${encodeURIComponent(orderId)}/demo-checkout/confirm`, { body: {}, key, subject }).then(value => parseDemoCheckoutResult(value, orderId)),
  demoCheckoutReceipt: (subject: OrderSubjectInput, orderId: string, key: string, signal?: AbortSignal) =>
    requestJson<unknown>(`/api/orders/${encodeURIComponent(orderId)}/demo-checkout/receipt?${new URLSearchParams({ key })}`, { signal, subject }).then(value => parseDemoCheckoutReceipt(value, orderId)),
  settlement: (subject: OrderSubjectInput, orderId: string, signal?: AbortSignal) =>
    requestJson<OrderSettlement>(`/api/orders/${encodeURIComponent(orderId)}/settlement`, { signal, subject }),
  settlementPreview: (subject: OrderSubjectInput, orderId: string, body: { lines: SettlementQuantityInput[]; endReason?: string }, signal?: AbortSignal) =>
    requestWrite<SettlementPreview>(`/api/orders/${encodeURIComponent(orderId)}/settlement-preview`, { body, signal, subject }),
  submitSettlement: (subject: OrderSubjectInput, orderId: string, body: { lines: SettlementQuantityInput[]; acceptedHash: string; endReason?: string; termsAccepted?: boolean }, key: string, signal?: AbortSignal) =>
    requestWrite<OrderSettlement>(`/api/orders/${encodeURIComponent(orderId)}/settlements`, { body, key, signal, subject }),
  decideSettlement: (subject: OrderSubjectInput, orderId: string, versionId: string, body: { action: "CONFIRM" | "REJECT"; versionHash: string; reason?: string; termsAccepted?: boolean }, key: string, signal?: AbortSignal) =>
    requestWrite<OrderSettlement>(`/api/orders/${encodeURIComponent(orderId)}/settlements/${encodeURIComponent(versionId)}/decision`, { body, key, signal, subject }),
  confirmOpening: (subject: OrderSubjectInput, orderId: string, openingId: string, versionNo: number, key: string, signal?: AbortSignal) =>
    requestOpeningConfirmation(subject, orderId, openingId, versionNo, key, signal),
  /**
   * The customer-support order card and the order detail panel share one `opening.confirm`
   * original-request contract. The frozen subject, key, version and opening id are persisted
   * before the write; an unknown result keeps those bytes and the caller is directed to the
   * order detail for explicit recovery. A brand-new key is never minted while an unresolved
   * original request exists. Errors carry stable codes for the shared card's copy.
   */
  confirmOpeningWithOriginalIntent: async (
    subject: OrderSubject,
    orderId: string,
    openingId: string,
    versionNo: number,
    keyFactory: () => string,
    isCurrent?: () => boolean,
  ): Promise<void> => {
    const fail = (code: string, status: number, message: string): never => {
      throw Object.assign(new Error(message), { status, code });
    };
    const result = await runGuardedWrite<OrderSettlement>({
      subject,
      kind: "opening.confirm",
      resourceId: orderId,
      body: { versionNo },
      context: { openingId, orderId },
      keyFactory,
      assertCurrent: isCurrent ? () => isCurrent() : undefined,
      refuseExisting: true,
      pendingCode: "OPENING_CONFIRM_PENDING",
      pendingMessage: "已有一笔结果未确认的开租申请；原申请与原键已保留，请到订单详情按原请求查询/恢复，不要重复提交。",
      request: (key, frozen, frozenContext, frozenSubject) => requestOpeningConfirmation(
        frozenSubject, orderId, String(frozenContext?.openingId ?? openingId), Number(frozen.versionNo ?? versionNo), key,
      ),
    });
    if (result.status === "ok") return;
    if (result.status === "blocked") return fail("ORIGINAL_REQUEST_BLOCKED", 423, result.message);
    if (result.status === "unknown") return fail("OPENING_CONFIRM_UNKNOWN", result.error.status || 503, "开租确认结果未确认；原申请与原键已保留，请到订单详情按原请求查询/恢复，不要重复提交。");
    if (result.status === "unauthorized") return fail(result.error.code, 401, `${result.error.message} 请到订单详情按原请求核对。`);
    if (result.status === "recovery-unresolved") return fail(result.error.code, result.error.status || 409, result.error.message);
    return fail(result.error.code, result.error.status || 400, result.error.message);
  },
};
