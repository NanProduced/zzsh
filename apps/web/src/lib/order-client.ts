import type { Money, UnitAmount, PublicQuote, FullPayoutTerms, FullPayoutTermsAcceptance, RentalMode } from "./supply-types";
export type { FullPayoutTerms, FullPayoutTermsAcceptance } from "./supply-types";

export type OrderParty = "renter" | "owner";
export type OrderStatus = "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "COMPLETED";
export type OrderStatusFilter = OrderStatus | "";

export type ChannelPaymentMethod = "ALIPAY_NATIVE" | "WEIXIN_NATIVE";
export type ChannelPaymentDataOrigin = "SYNTHETIC_PROTOCOL" | "LOCAL_CONTROLLED" | "JOINPAY_CANDIDATE" | "JOINPAY_PROVIDER" | "UNKNOWN";
type ChannelPaymentMoney = { cents: string; currency: string };
export type ChannelPaymentView = {
  contractVersion: "order-payment-request.v1";
  dataOrigin: ChannelPaymentDataOrigin;
  capability: { channelEnabled: boolean; methods: ChannelPaymentMethod[]; evidenceProfile: "JOINPAY_AGG_2_6_MD5"; productionPaymentCapability: boolean };
  order: { id: string; displayNo: string; status: string; paidAt: string | null };
  request: { id: string; state: string; method: string; amount: ChannelPaymentMoney | null; updatedAt: string;
    recovery: { mode: "ORIGINAL_NUMBER_QUERY"; nextAttemptAt: null; manualQueryOpen: false } | null } | null;
  projection: { displayState: string; actionBlockedReason: string | null };
  paymentAction: { kind: "QR_URL"; url: string; expiresAt: null; expiryKnown: false } | null;
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
export type PersonalRefundBasis = "POSTING" | "REVIEW_CONFIRMATION";
export type PersonalFirstSubmit = {
  dispatch: "NEVER_DISPATCHED" | "DISPATCHED" | "UNKNOWN";
  blockedReason: "ORIGINAL_ORDER_NO_AMBIGUOUS" | "ABNORMAL_BASIS_REVIEW" | null;
  blockedAt: string | null;
  blockedAuditCount: number | null;
  trust: "LOCAL_AUDIT_AND_ATTEMPT";
};
export type PersonalAbnormalResponsibility = {
  confirmationId: string;
  reasonCode: "DUPLICATE_PAYMENT" | "LATE_PAYMENT" | "UNKNOWN_REASON";
  originalCents: string | null;
  currency: "CNY" | null;
  liabilityRootId: string | null;
  liabilityEventId: string | null;
  intentIds: string[];
  allocatedCents: string | null;
  consumedCents: string | null;
  releasedCents: string | null;
  remainingCents: string | null;
  totalsComplete: boolean;
  state: "NO_INTENT" | "READY" | "PROCESSING" | "UNKNOWN" | "CONSUMED" | "RELEASED" | "REVIEW_REQUIRED" | "CONFLICT";
  firstSubmit: PersonalFirstSubmit | null;
  reasonCodes: string[];
};
export type PersonalResponsibilityTotals = {
  originalCents: string | null;
  allocatedCents: string | null;
  consumedCents: string | null;
  releasedCents: string | null;
  remainingCents: string | null;
  totalsComplete: boolean;
  postingOriginalCents: string | null;
  abnormalOriginalCents: string | null;
  abnormalConfirmationCount: number;
};
export type PersonalRefundIntent = {
  intentId: string;
  refundOrderNo: string | null;
  source: "LOCAL_CONTROLLED" | "JOINPAY_FORMAL" | "UNRECOGNIZED";
  evidenceLevel: string | null;
  basisKind?: PersonalRefundBasis;
  paymentConfirmationId?: string | null;
  firstSubmit?: PersonalFirstSubmit | null;
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
  /** Additive C04B fields. Old C02 responses omit all three and stay readable. */
  abnormalResponsibilities?: PersonalAbnormalResponsibility[];
  responsibilitiesTruncated?: boolean;
  responsibilityTotals?: PersonalResponsibilityTotals;
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
  rentalMode?: RentalMode;
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

export type OrderListingFacts = {
  source: "ORDER_VERSION" | "ACCOUNT_CURRENT";
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
  code: "NONE" | "RENTING" | "INTAKE_PENDING" | "DECISION_PENDING" | "DECISION_WAITING" | "POSTED" | "UNKNOWN";
  label: string | null;
  viewerActionRequired: boolean;
  settlementVersionNo: number | null;
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
  accountDisplayNo?: string | null;
  listingFacts?: OrderListingFacts | null;
  listingFactsUnknownReason?: "ORDER_VERSION_UNREADABLE" | "ACCOUNT_PUBLIC_VERSION_MISSING" | "UNREADABLE" | "ACCOUNT_UNLINKED" | null;
  entitlements?: OrderEntitlement[] | null;
  entitlementsUnknownReason?: "NOT_DISCLOSED" | "NOT_FROZEN" | "UNREADABLE" | null;
  stage?: OrderStage | null;
};

export type LegacyOrder = {
  id: string; displayNo: string; status: OrderStatus | "UNKNOWN"; party: OrderParty; title: string | null; gameId: string;
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

export type PersonalRentalQuote = {
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
const refundFirstSubmit = (value: unknown): PersonalFirstSubmit | null => {
  if (value === null) return null;
  const v = refundRecord(value);
  if (!["NEVER_DISPATCHED", "DISPATCHED", "UNKNOWN"].includes(String(v.dispatch))
    || !(v.blockedReason === null || ["ORIGINAL_ORDER_NO_AMBIGUOUS", "ABNORMAL_BASIS_REVIEW"].includes(String(v.blockedReason)))
    || (v.blockedAuditCount !== null && (!Number.isSafeInteger(v.blockedAuditCount) || (v.blockedAuditCount as number) < 0))
    || v.trust !== "LOCAL_AUDIT_AND_ATTEMPT") throw invalidRefund();
  return {
    dispatch: v.dispatch as PersonalFirstSubmit["dispatch"],
    blockedReason: v.blockedReason as PersonalFirstSubmit["blockedReason"],
    blockedAt: refundTime(v.blockedAt),
    blockedAuditCount: v.blockedAuditCount as number | null,
    trust: "LOCAL_AUDIT_AND_ATTEMPT",
  };
};
const refundAbnormalResponsibility = (value: unknown): PersonalAbnormalResponsibility => {
  const v = refundRecord(value), originalCents = refundCents(v.originalCents);
  if (!["DUPLICATE_PAYMENT", "LATE_PAYMENT", "UNKNOWN_REASON"].includes(String(v.reasonCode))
    || !(v.currency === null || v.currency === "CNY") || (originalCents !== null && v.currency !== "CNY")
    || !["NO_INTENT", "READY", "PROCESSING", "UNKNOWN", "CONSUMED", "RELEASED", "REVIEW_REQUIRED", "CONFLICT"].includes(String(v.state))
    || typeof v.totalsComplete !== "boolean") throw invalidRefund();
  const allocatedCents = refundCents(v.allocatedCents), consumedCents = refundCents(v.consumedCents);
  const releasedCents = refundCents(v.releasedCents), remainingCents = refundCents(v.remainingCents);
  if (v.state === "CONFLICT" && (v.totalsComplete || [allocatedCents, consumedCents, releasedCents, remainingCents].some((amount) => amount !== null))) throw invalidRefund();
  if (v.totalsComplete && (originalCents === null || v.currency !== "CNY"
    || [allocatedCents, consumedCents, releasedCents, remainingCents].some((amount) => amount === null))) throw invalidRefund();
  return {
    confirmationId: refundText(v.confirmationId, 180),
    reasonCode: v.reasonCode as PersonalAbnormalResponsibility["reasonCode"],
    originalCents, currency: v.currency as "CNY" | null,
    liabilityRootId: refundNullableText(v.liabilityRootId, 180), liabilityEventId: refundNullableText(v.liabilityEventId, 180),
    intentIds: refundStrings(v.intentIds),
    allocatedCents, consumedCents, releasedCents, remainingCents, totalsComplete: v.totalsComplete,
    state: v.state as PersonalAbnormalResponsibility["state"],
    firstSubmit: v.firstSubmit === undefined ? null : refundFirstSubmit(v.firstSubmit),
    reasonCodes: refundStrings(v.reasonCodes),
  };
};
const refundResponsibilityTotals = (value: unknown): PersonalResponsibilityTotals => {
  const v = refundRecord(value);
  if (typeof v.totalsComplete !== "boolean" || !Number.isSafeInteger(v.abnormalConfirmationCount) || (v.abnormalConfirmationCount as number) < 0) throw invalidRefund();
  return {
    originalCents: refundCents(v.originalCents), allocatedCents: refundCents(v.allocatedCents),
    consumedCents: refundCents(v.consumedCents), releasedCents: refundCents(v.releasedCents),
    remainingCents: refundCents(v.remainingCents), totalsComplete: v.totalsComplete,
    postingOriginalCents: refundCents(v.postingOriginalCents), abnormalOriginalCents: refundCents(v.abnormalOriginalCents),
    abnormalConfirmationCount: v.abnormalConfirmationCount as number,
  };
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
  if (v.basisKind !== undefined && !["POSTING", "REVIEW_CONFIRMATION"].includes(String(v.basisKind))) throw invalidRefund();
  const basisKind = v.basisKind === undefined ? undefined : v.basisKind as PersonalRefundBasis;
  const paymentConfirmationId = v.paymentConfirmationId === undefined ? undefined : refundNullableText(v.paymentConfirmationId, 180);
  const firstSubmit = v.firstSubmit === undefined ? undefined : refundFirstSubmit(v.firstSubmit);
  return {
    intentId: refundText(v.intentId, 180),
    refundOrderNo: v.refundOrderNo === null ? null : (() => { const text = refundText(v.refundOrderNo, 32); if (!/^RF[0-9a-f]{28}$/.test(text)) throw invalidRefund(); return text; })(),
    source: v.source === "LOCAL_CONTROLLED" || v.source === "JOINPAY_FORMAL" || v.source === "UNRECOGNIZED" ? v.source : (() => { throw invalidRefund(); })(),
    evidenceLevel: refundNullableText(v.evidenceLevel, 64),
    ...(basisKind === undefined ? {} : { basisKind }),
    ...(paymentConfirmationId === undefined ? {} : { paymentConfirmationId }),
    ...(firstSubmit === undefined ? {} : { firstSubmit }),
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
  const intents = Array.isArray(root.intents) ? root.intents.map(refundIntent) : (() => { throw invalidRefund(); })();
  const noResponsibilityTotals = ["allocatedCents", "consumedCents", "releasedCents", "remainingCents"].every((name) => responsibility[name] === null);
  const hasAbnormalFields = ["abnormalResponsibilities", "responsibilitiesTruncated", "responsibilityTotals"].some((name) => root[name] !== undefined);
  const abnormalResponsibilities = hasAbnormalFields
    ? (Array.isArray(root.abnormalResponsibilities) ? root.abnormalResponsibilities.map(refundAbnormalResponsibility) : (() => { throw invalidRefund(); })())
    : undefined;
  if (abnormalResponsibilities && abnormalResponsibilities.length > 50) throw invalidRefund();
  const responsibilitiesTruncated = hasAbnormalFields
    ? (typeof root.responsibilitiesTruncated === "boolean" ? root.responsibilitiesTruncated : (() => { throw invalidRefund(); })())
    : undefined;
  const responsibilityTotals = hasAbnormalFields ? refundResponsibilityTotals(root.responsibilityTotals) : undefined;
  if (responsibilitiesTruncated && responsibilityTotals && (responsibilityTotals.totalsComplete
    || [responsibilityTotals.originalCents, responsibilityTotals.allocatedCents, responsibilityTotals.consumedCents, responsibilityTotals.releasedCents, responsibilityTotals.remainingCents].some((amount) => amount !== null))) throw invalidRefund();
  if (responsibilityTotals && responsibilitiesTruncated !== true && responsibilityTotals.abnormalConfirmationCount !== abnormalResponsibilities!.length) throw invalidRefund();
  if (responsibility.state === "NOT_POSTED" && (responsibility.totalsComplete || responsibility.postingId !== null
    || responsibility.originalCents !== null || !noResponsibilityTotals)) throw invalidRefund();
  if (responsibilityTotals?.totalsComplete && (
    [responsibilityTotals.originalCents, responsibilityTotals.allocatedCents, responsibilityTotals.consumedCents, responsibilityTotals.releasedCents, responsibilityTotals.remainingCents].some((amount) => amount === null)
    || responsibilitiesTruncated || root.intentsTruncated || !coverage.intentsComplete
    || (responsibility.state === "POSTED" && !responsibility.totalsComplete)
    || abnormalResponsibilities!.some((item) => item.state === "CONFLICT" || !item.totalsComplete))) throw invalidRefund();
  const legacyProjection = !hasAbnormalFields;
  if (root.contractVersion !== "personal-native-refunds.v1" || root.subjectId !== expectedUserId || order.orderId !== expectedOrderId
    || !["AVAILABLE", "NOT_APPLICABLE"].includes(String(root.status)) || !refundOutcomes.includes(root.outcome as PersonalRefundOutcome)
    || coverage.scope !== "LOCAL_REGISTERED_ONLY" || coverage.intentLimit !== 50 || typeof coverage.intentsComplete !== "boolean" || coverage.channelRecordsChecked !== false
    || !refundTime(root.asOf) || !["POSTED", "NOT_POSTED"].includes(String(responsibility.state))
    || !["DUE", "NOT_DUE", "UNKNOWN"].includes(String(responsibility.dueState)) || typeof responsibility.totalsComplete !== "boolean"
    || typeof root.returnedIntentCount !== "number" || root.returnedIntentCount !== intents.length || intents.length > 50
    || (legacyProjection && !coverage.intentsComplete && (!noResponsibilityTotals || responsibility.totalsComplete))
    || (root.status === "NOT_APPLICABLE" && responsibility.state !== "NOT_POSTED")
    || typeof root.intentsTruncated !== "boolean"
    || (legacyProjection && root.intentsTruncated && (responsibility.totalsComplete || coverage.intentsComplete || !noResponsibilityTotals
      || funds !== null && (funds.writtenOffCents !== null || funds.releasedCents !== null)))
    || (legacyProjection && root.outcome === "CONFLICT" && (responsibility.totalsComplete || !noResponsibilityTotals
      || funds !== null && (funds.writtenOffCents !== null || funds.releasedCents !== null)))
    || actual.amountCents !== null || actual.channelRefundTrxNo !== null || actual.completedAt !== null || actual.destination !== null || actual.bankArrival !== "UNKNOWN"
    || typeof order.displayNo !== "string" && order.displayNo !== null) throw invalidRefund();
  if (funds && (funds.basis !== "LOCAL_REGISTERED_ACCOUNTING" || funds.bankArrival !== "UNKNOWN")) throw invalidRefund();
  return {
    contractVersion: root.contractVersion, subjectId: expectedUserId,
    order: { orderId: order.orderId, displayNo: order.displayNo as string | null, status: refundText(order.status, 32) },
    status: root.status as PersonalRefundRead["status"], outcome: root.outcome as PersonalRefundOutcome,
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
    ...(hasAbnormalFields ? { abnormalResponsibilities: abnormalResponsibilities!, responsibilitiesTruncated: responsibilitiesTruncated!, responsibilityTotals: responsibilityTotals! } : {}),
    actualChannelRefund: { amountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN", reasonCodes: refundStrings(actual.reasonCodes) },
    localFundsEffect: funds ? { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: refundCents(funds.writtenOffCents), releasedCents: refundCents(funds.releasedCents), bankArrival: "UNKNOWN" } : null,
    reasonCodes: refundStrings(root.reasonCodes), unknowns: refundStrings(root.unknowns),
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

type ReadOptions = { signal?: AbortSignal; expectedUserId?: string };

async function requestJson<T>(path: string, options: ReadOptions = {}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("Order path must be relative");
  }
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: options.signal, ...(options.expectedUserId === undefined ? {} : { headers: { "x-zzsh-expected-user-id": options.expectedUserId } }) });
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

type WriteOptions = { method?: "POST"; body?: unknown; key?: string; signal?: AbortSignal; expectedUserId?: string };

async function requestWrite<T>(path: string, options: WriteOptions): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("Order path must be relative");
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (options.key) headers.set("idempotency-key", options.key);
  if (options.expectedUserId !== undefined) headers.set("x-zzsh-expected-user-id", options.expectedUserId);
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
  personalRefunds: async (userId: string, orderId: string, signal?: AbortSignal) =>
    parsePersonalRefunds(await requestJson<unknown>(`/api/orders/${encodeURIComponent(orderId)}/refunds`, { signal, expectedUserId: userId }), userId, orderId),
  previewRentalPrice: (input: RentalPricePreviewInput, signal?: AbortSignal) =>
    requestJson<RentalPricePreview>(`/api/rental-price-preview?${new URLSearchParams({ accountId: input.accountId, versionId: input.versionId, releaseId: input.releaseId }).toString()}`, { signal }),
  confirmRental: (input: { accountId: string; versionId: string; releaseId: string; fullPayoutTermsAcceptance?: FullPayoutTermsAcceptance }, signal?: AbortSignal) =>
    requestWrite<PersonalRentalQuote>("/api/order-confirmations", { body: input, signal }),
  createOrder: (confirmationToken: string, key: string, fullPayoutTermsAcceptance?: FullPayoutTermsAcceptance, signal?: AbortSignal) =>
    requestWrite<{ order: Order }>("/api/v2/orders", { body: { confirmationToken, ...(fullPayoutTermsAcceptance ? { fullPayoutTermsAcceptance } : {}) }, key, signal }).then(unwrapOrder),
  cancel: (orderId: string, key: string, reason?: string, signal?: AbortSignal) =>
    requestWrite<{ order?: Order } | Order>(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { key, body: reason ? { reason } : {}, signal }),
  pay: (orderId: string, key: string, signal?: AbortSignal) =>
    requestWrite<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>(
      `/api/orders/${encodeURIComponent(orderId)}/payment-requests`, { key, signal }),
  paymentStatus: (orderId: string, signal?: AbortSignal) =>
    requestJson<{ order: { id: string; displayNo?: string | null; status: string; paidAt?: string | null }; payment: { confirmationId: string; disposition: string; reasonCode?: string | null; amountCents: string; currency: string; acceptedAt: string } | null }>(
      `/api/orders/${encodeURIComponent(orderId)}/payment-requests`, { signal }),
  requestChannelPayment: (userId: string, orderId: string, method: ChannelPaymentMethod, key: string, signal?: AbortSignal) =>
    requestWrite<ChannelPaymentCommandReceipt>(`/api/orders/${encodeURIComponent(orderId)}/channel-payment-requests`, { body: { method }, key, signal, expectedUserId: userId }),
  channelPaymentStatus: (userId: string, orderId: string, signal?: AbortSignal) =>
    requestJson<ChannelPaymentView>(`/api/orders/${encodeURIComponent(orderId)}/channel-payment-requests`, { signal, expectedUserId: userId }),
  queryChannelPayment: (userId: string, orderId: string, signal?: AbortSignal) =>
    requestWrite<ChannelPaymentQueryReceipt>(`/api/orders/${encodeURIComponent(orderId)}/channel-payment-requests/query`, { body: {}, signal, expectedUserId: userId }),
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
