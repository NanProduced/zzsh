import { ADMIN_AUTH_FAILURE_EVENT, API_ROOT, AdminApiError, adminRequest } from "../api";
import { beijingCalendarDate } from "../workspace/beijing-time";
import { findPhoneClue } from "../workspace/tab-model";

export const FINANCE_ACCESS_FAILURE_EVENT = "zzsh-admin-finance-access-failure";
export const bucketLabels: Record<string, string> = { AVAILABLE: "用户可用", RESERVED: "提现预留", GUARANTEE_HELD: "号主上架保证金", REFUND_PAYABLE: "退款应付", PENDING_EARNINGS: "待结算收益", PLATFORM: "平台权益", CLEARING: "未核对款项", OPENING_BASIS: "旧平台余额结转" };
export const bucketNature: Record<string, string> = { AVAILABLE: "用户负债", RESERVED: "用户负债", GUARANTEE_HELD: "保证金责任", REFUND_PAYABLE: "退款责任", PENDING_EARNINGS: "收益责任", PLATFORM: "平台权益", CLEARING: "未核对款项", OPENING_BASIS: "余额来源" };
/** 旧平台余额结转只在对账口径里出现，不进入资金查找的业务类别下拉。 */
export const businessBucketLabels: Record<string, string> = Object.fromEntries(Object.entries(bucketLabels).filter(([bucket]) => bucket !== "OPENING_BASIS"));
export const kindLabels: Record<string, string> = { OPENING: "迁移期初", SETTLEMENT: "订单结算", PAYMENT: "付款记录", WITHDRAWAL: "提现", EARNINGS: "历史流水", DISTRIBUTION: "分销", GUARANTEE: "上架保证金" };
kindLabels.REFUND = "退款责任";
export const stateLabels: Record<string, string> = { POSTED: "已入账", RESERVED: "已预留", SUBMITTING: "提交中", PROCESSING: "处理中", UNKNOWN: "结果未知", SUCCEEDED: "本地成功记录", FAILED: "失败", RECONCILIATION_REQUIRED: "结果冲突，需核对", HISTORICAL_OBSERVED: "历史观察" };
Object.assign(stateLabels, { ORDER_RECORDED: "订单记录", HISTORICAL_ORDER_RECORDED: "历史订单记录" });
Object.assign(stateLabels,{PENDING:'待结算',SETTLED:'已结算',REVOKED:'已撤销',RECOVERY_REQUIRED:'待追回'});
stateLabels.REFUND_PAYABLE_RECORDED = "应退责任已记录";
export const reasonLabels: Record<string, string> = {
  ALL_SUBJECTS_PERIOD_BALANCE_NOT_PROVABLE: '全平台集合未提供各主体完整的期间余额依据，请按具体用户核对',
  FILTERED_PERIOD_BALANCE_NOT_PROVABLE: '业务或状态筛选仅覆盖部分分录，不能据此核定完整期间余额',
  HISTORICAL_PERIOD_BALANCE_NOT_PROVABLE: '所选期间早于新账承接入账时刻，历史余额未记录',
  POSTED_LEDGER_ONLY: '仅证明已准入的新账分录，不代表完整历史或渠道余额',
  WALLET_ORIGIN_NOT_VERIFIED: '钱包期初来源未通过核定',
  OPENING_ORIGIN_BINDING_NOT_VERIFIED: '期初、主体与原入账关联未通过核定',
  OPENING_ORIGIN_SOURCE_NOT_VERIFIED: '原始期初来源未通过核定',
  OPENING_ORIGIN_TIME_NOT_VERIFIED: '期初来源截止与新账入账时刻未通过核定',
  AMBIGUOUS_OPENING_ORIGIN: '期初依据存在多个候选，余额未记录',
  ORIGINAL_BASIS_UNAVAILABLE: '未取得原计佣依据',
  AMBIGUOUS_ORIGINAL_BASIS: '原计佣依据存在多个候选',
  FROZEN_CALCULATION_NOT_VERIFIED: '冻结计佣依据未通过完整校验',
  PERIOD_BALANCE_PROOF_NOT_AVAILABLE: "所选期间起止余额尚无完整依据",
  POSTED_EVENT_AMOUNT_OR_TIME_UNAVAILABLE: '部分已入账记录的金额或时间尚未取得完整依据',
  CURRENT_LEDGER_EXCLUDES_UNADMITTED_LEGACY:'当前勾稽仅覆盖已入账分录，待承接的历史责任另行核对',
  ZERO_FACT_NO_LEDGER_OR_CHANNEL_PAYMENT:'这是有依据的零额事实，没有资金分录或渠道支付',
  CHANNEL_ARRIVAL_NOT_PROVED:'账内记录不证明渠道到账',
  GLOBAL_RESERVED_AND_WITHDRAWABLE_NOT_ADMITTED: "完整预留和可提现范围尚未记录",
  SOURCE_COVERAGE_UNKNOWN: "资金来源覆盖未记录", SOURCE_COVERAGE_NOT_ADMITTED: "资金来源覆盖未准入",
  WITHDRAWAL_POLICY_NOT_ACTIVE: "可提现政策未启用", WITHDRAWAL_SOURCE_NOT_AVAILABLE: "提现读取来源尚未就绪",
  WITHDRAWAL_SOURCE_UNAVAILABLE: "原提现申请未取得", NATIVE_DISTRIBUTION_NOT_AVAILABLE: "当前收益政策和结算来源尚未接入",
  CHANNEL_COST_NOT_AVAILABLE: "渠道费用未取得", HISTORICAL_NOT_ADMITTED: "历史事实未纳入期初覆盖，未改变当前余额",
  HISTORICAL_STATUS_NOT_CHANNEL_RESULT: "旧状态不代表渠道到账", AMOUNT_OR_DIRECTION_UNKNOWN: "金额或方向未记录",
  HISTORICAL_GUARANTEE_NOT_CURRENT_HELD:'历史缴付观察不等于当前在押，当前责任未记录',
  INVALID_EXACT_AMOUNT: "金额格式未记录", LOCAL_CONTROLLED_NOT_BANK_RECEIPT: "本地受控结果，不代表银行到账",
  LOCAL_OPERATION_NOT_APPLIED: "原本地渠道记录与申请结果尚未一致，资金处置仍按已入账分录核对",
  ORIGINAL_ORDER_REFERENCE_UNRESOLVED: "原订单尚未按来源引用解析", ORIGINAL_ORDER_REFERENCE_AMBIGUOUS: "原订单有多个来源候选，需逐一核对",
  ORDER_RECORD_NOT_CHANNEL_RESULT: "订单及付款记录不代表渠道到账", ORDER_NO_CURRENT_POSTING: "该单据没有当前入账分录",
  REFUND_PAYMENT_SOURCE_NOT_AVAILABLE: "退款出款依据尚未取得，应退责任按账内分录核对",
  DISTRIBUTION_AND_CHANNEL_COST_NOT_ADMITTED: "分销扣除和渠道成本尚未记录，未计算净利润",
};
export type FinanceFilters = { scope: string; from: string; to: string; period: boolean; bucket: string; kind: string; state: string; q: string };
export function defaultFinanceFilters(period: boolean): FinanceFilters { const today = beijingCalendarDate(); return { scope: "ALL", from: today, to: today, period, bucket: "ALL", kind: "ALL", state: "ALL", q: "" }; }
export function financeQuery(filters: FinanceFilters): URLSearchParams {
  if (findPhoneClue(filters.q) || findPhoneClue(filters.scope)) throw new Error("手机号须通过授权用户查找定位，不能进入资金查询地址");
  return new URLSearchParams({ ...filters, period: filters.period ? "1" : "0" });
}
export function financeMoney(cents: string | null | undefined): string {
  if (cents === null || cents === undefined || !/^-?\d+$/.test(cents)) return "未记录";
  const value = BigInt(cents), abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${(abs / 100n).toLocaleString("zh-CN")}.${(abs % 100n).toString().padStart(2, "0")} 元`;
}
export function financeTime(value: string | null | undefined): string { return !value || !Number.isFinite(Date.parse(value)) ? "时间未记录" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
export type HistoricalFinancePurpose = 'SETTLEMENT_INCOME' | 'OWNER_RENTAL_INCOME' | 'DISTRIBUTION_INCOME' | 'WITHDRAWAL_APPLICATION' | 'WITHDRAWAL_DEBIT' | 'WITHDRAWAL_REJECTED_RETURN' | 'TRANSFER_FAILED_RETURN' | 'WECHAT_WITHDRAWAL_FAILED_RETURN' | 'PAYMENT_RECORD' | 'REFUND_RECORD' | 'PLATFORM_CREDIT' | 'PLATFORM_DEBIT' | 'DEPOSIT_COMPENSATION' | 'TASK_SETTLEMENT' | 'UNKNOWN';
export type HistoricalFinanceDisplay = {refundAttempts?:{source:{type:'LEGACY_MYSQL';entity:'la_refund_log';id:string};originalNumber:string|null;originalStatus:string|null;recordedAmountCents:string|null;occurredAt:string|null;updatedAt:string|null;channelArrival:'UNKNOWN';reasonCodes:string[]}[];sourceRefundFlags?:string[];
  amountSemantics?: 'BALANCE_RECORD' | 'BUSINESS_RECORD' | 'UNVERIFIED';
  changeType: string | null; purposeCode: HistoricalFinancePurpose; purposeLabel: string; originalLogNumber: string | null;
  recordedAmountCents: string | null; balanceAfterCents: string | null; feeCents: string | null; netCents: string | null;
  originalStatus: string | null; originalStatusLabel: string | null; payWay: string | null; payWayLabel: string | null; channelState: 'UNVERIFIED';
  association: { state: 'MATCHED' | 'UNRESOLVED' | 'AMBIGUOUS' | 'DENIED'; kind: 'ORDER' | 'WITHDRAWAL' | 'DISTRIBUTION' | 'TASK' | 'UNKNOWN'; documentRef: string | null; number: string | null; path: string | null; role: 'OWNER' | 'RENTER' | 'BENEFICIARY' | 'WITHDRAWER' | null; originalStatus: string | null; originalStatusLabel: string | null };
};
type FinanceRecord = { kind: string; state: string; ref?: string; documentRef?: string; sourceEntity?: string; historical?: HistoricalFinanceDisplay };
const sourceFamily = (record: FinanceRecord) => (record.ref ?? record.documentRef ?? "").split(":")[0] ?? "";
export function financeIsHistorical(record: FinanceRecord): boolean { return !!record.historical || record.state?.startsWith('HISTORICAL_') === true; }
/** Old clients may lack the new field; only the typed original earnings source establishes a balance record. */
export function financeIsHistoricalBalance(record: FinanceRecord): boolean {
  return financeIsHistorical(record) && (sourceFamily(record)==='HISTORY_EARNINGS'||record.sourceEntity==='la_log_earnings') && (!record.historical?.amountSemantics || record.historical.amountSemantics==='BALANCE_RECORD');
}
export function historicalFinanceAmount(record: FinanceRecord, balanceCents: string | null | undefined): string {
  if(record.historical?.amountSemantics==='UNVERIFIED')return '记录金额待核实';
  return financeIsHistoricalBalance(record) ? `历史变动 ${financeMoney(balanceCents)}` : `记录金额 ${financeMoney(record.historical?.recordedAmountCents)}`;
}
export function financeBusinessLabel(record: FinanceRecord): string { const family=sourceFamily(record); return record.historical?.amountSemantics==='UNVERIFIED'?'旧平台记录（来源待核）':record.historical?.purposeLabel?.trim() || (family==='PAYMENT_REQUEST'?'付款请求':family==='REFUND_INTENT'?'退款申请':kindLabels[record.kind]) || '资金记录'; }
export function financeRecordNumber(record: FinanceRecord, fallback: string): string {
  return record.historical?.originalLogNumber ? `原流水号 ${record.historical.originalLogNumber}` : financeIsHistorical(record) ? `记录编号 ${fallback}` : fallback;
}
export function financeRecordState(record: FinanceRecord): string {
  if (!financeIsHistorical(record) && record.state === "SUCCEEDED") return sourceFamily(record) === "WITHDRAWAL" || record.sourceEntity === "withdrawal_intent" ? "本地受控成功" : "本地成功记录，渠道另核";
  if (record.historical?.amountSemantics === 'UNVERIFIED') return '来源待核';
  const original = record.historical?.originalStatusLabel;
  return financeIsHistorical(record) ? original ? original.startsWith('旧平台') ? original : `旧平台状态：${original}` : '旧平台记录' : stateLabels[record.state] ?? '状态未记录';
}
export function historicalAssociationPath(historical: HistoricalFinanceDisplay | undefined, access: { orderRead: boolean; documentRead: boolean }): string | null {
  const association = historical?.association;
  if (!association || association.state !== 'MATCHED' || association.kind === 'UNKNOWN' || association.kind === 'ORDER' && !access.orderRead) return null;
  if (association.path) {
    if (association.kind === 'ORDER' && association.path.startsWith('/orders/') && access.orderRead || association.path.startsWith('/finance/documents/') && access.documentRead) return association.path;
    return null;
  }
  return association.documentRef && access.documentRead ? `/finance/documents/${encodeURIComponent(association.documentRef)}` : null;
}
export function historicalFinanceFacts(historical: HistoricalFinanceDisplay): [string, string][] {
  const earnings = historical.purposeCode === 'UNKNOWN' || historical.changeType !== null || historical.originalLogNumber !== null;
  const withdrawal = historical.purposeCode === 'UNKNOWN' || ['WITHDRAWAL_APPLICATION','WITHDRAWAL_DEBIT','WITHDRAWAL_REJECTED_RETURN','TRANSFER_FAILED_RETURN','WECHAT_WITHDRAWAL_FAILED_RETURN'].includes(historical.purposeCode);
  const statusApplies = ['PAYMENT_RECORD','REFUND_RECORD','WITHDRAWAL_APPLICATION'].includes(historical.purposeCode);
  return [...(earnings ? [['原流水号', historical.originalLogNumber || '未取得'] as [string, string]] : []), [historical.amountSemantics==='UNVERIFIED'?'原金额（待核）':'原金额', financeMoney(historical.recordedAmountCents)],
    ...(earnings || historical.balanceAfterCents !== null ? [[historical.amountSemantics==='UNVERIFIED'?'原记录后余额（待核）':'变动后余额（旧）', financeMoney(historical.balanceAfterCents)] as [string, string]] : []),
    ...(withdrawal || historical.feeCents !== null ? [[historical.amountSemantics==='UNVERIFIED'?'手续费（待核）':'手续费', financeMoney(historical.feeCents)] as [string, string]] : []),
    ...(withdrawal || historical.netCents !== null ? [[historical.amountSemantics==='UNVERIFIED'?'净额（待核）':'净额', financeMoney(historical.netCents)] as [string, string]] : []),
    ...(historical.changeType !== null ? [['原用途码', historical.changeType] as [string, string]] : []),
    ...(historical.purposeCode === 'PAYMENT_RECORD' ? [['支付方式（原记录）', historical.amountSemantics === 'UNVERIFIED' ? '来源未核对' : historical.payWayLabel ?? (historical.payWay ? '未知' : '未记录')] as [string, string]] : []),
    ...(statusApplies || historical.originalStatus !== null ? [[historical.amountSemantics==='UNVERIFIED'?'原状态（待核）':'原状态', historical.originalStatusLabel ?? (historical.originalStatus !== null ? '未知' : '状态未记录')] as [string, string]] : [])];
}
export type FinanceEntry = { id: string; documentRef: string; documentNumber: string; subjectId: string; subjectName: string; bucket: string; direction: string; deltaCents: string | null; knowledge: string; kind: string; state: string; classification: string; affectsCurrentWallet: boolean; affectsCurrentLedger: boolean; occurredAt: string | null; importedAt: string; sourceType: string; sourceEntity: string; sourceSystem: string; sourceId: string; sourceDigest: string | null; basisId: string | null; reasonCodes: string[]; accountCode: string | null; evidence: Record<string, string | null>; historical?: HistoricalFinanceDisplay };
export type FinanceOrderLifecycle = { origin: 'NATIVE' | 'LEGACY_MYSQL'; orderStatus: string; payment: { state: 'SITE_ACCEPTED' | 'REVIEW_REQUIRED' | 'NO_ACCEPTED_PAYMENT' | 'LEGACY_RECORDED' | 'UNAVAILABLE'; amountCents: string | null; confirmedAt: string | null; source?: string | null; hasReviewPayment: boolean | null }; postingState: 'POSTED' | 'NOT_POSTED' | 'LEGACY_OBSERVATION' | 'UNAVAILABLE' };
export type FinanceDocument = { ref: string; number: string; kind: string; state: string; occurredAt: string | null; requestedAmountCents: string | null; subjects: { id: string; name: string }[]; entryCount: number; ledgerEntryCount?: number; summaryScope?: 'DOCUMENT' | 'SUBJECT'; subjectEntryCount?: number; documentEntryCount?: number | null; amounts: { bucket: string; knownNetCents: string; unknownCount: number }[]; historical?: HistoricalFinanceDisplay; orderLifecycle?: FinanceOrderLifecycle; parties?: { owner: { id: string; name: string }; renter: { id: string; name: string } } };
export function financeEntryScope(document: FinanceDocument): string {
  if (["PAYMENT_REQUEST","REFUND_INTENT"].includes(sourceFamily(document)) || sourceFamily(document)==="JOINPAY_WITHDRAWAL" && document.ledgerEntryCount===0) return "业务记录 · 不计账内收支";
  if (sourceFamily(document)==="JOINPAY_WITHDRAWAL" && document.ledgerEntryCount===undefined) return `${document.entryCount} 条记录 · 过账依据未记录`;
  return document.summaryScope === 'SUBJECT' ? `本人相关 ${document.subjectEntryCount ?? document.entryCount} 条${document.documentEntryCount == null ? ' · 全单条数未读取' : ` / 全单 ${document.documentEntryCount} 条`}` : `${document.entryCount} 条${financeIsHistorical(document) ? '历史记录' : '分录'}`;
}
export function financeEntryEvent(entry: FinanceEntry): string {
  if (financeIsHistorical(entry)) return financeBusinessLabel(entry);
  if (entry.kind !== 'DISTRIBUTION') return financeBusinessLabel(entry);
  const evidence = entry.evidence ?? {};
  if (Object.hasOwn(evidence,'eventAction')) return ({ACCRUE:'分销计提',SETTLE:'分销转可用',REVOKE:'分销撤销',RECOVER:'分销追偿'} as Record<string,string>)[evidence.eventAction??'']??'分销事件未记录';
  // Old APIs have no action field; EARNING_REVOKED cannot distinguish revoke from recover.
  return ({EARNING_PENDING:'分销计提',EARNING_SETTLED:'分销转可用'} as Record<string,string>)[evidence.eventKind??'']??'分销事件未记录';
}
export type OrderSettlementMoney = { knowledge: 'KNOWN' | 'UNKNOWN'; cents: string | null; reasonCodes: string[] };
export type FinancePlatformComponent = { code: string; cents: string; payer: 'OWNER' | 'RENTER' | 'NONE' | null; feeBase: string | null; feeRate: string | null };
export type OrderFinanceTransaction = {
  documentRef: string; number: string; kind: 'PAYMENT' | 'REFUND'; source: 'NATIVE' | 'LEGACY_MYSQL';
  state: string; amountCents: string | null; occurredAt: string | null; channelArrival: 'UNKNOWN';
  payWay: string | null; payWayLabel: string | null;
  refundAttempts?: HistoricalFinanceDisplay['refundAttempts']; sourceRefundFlags?: string[];
};
export type OrderFinanceBusiness = {
  payment: { state: 'SITE_ACCEPTED' | 'LEGACY_RECORDED_PAID' | 'UNPAID' | 'REVIEW_REQUIRED' | 'UNKNOWN'; amount: OrderSettlementMoney; occurredAt: string | null };
  settlementState: 'POSTED' | 'FINALIZED_ZERO' | 'NOT_SETTLED' | 'LEGACY_RECORDED_COMPLETE' | 'UNKNOWN';
  legacyCompletedAmounts: { ownerEarnings: OrderSettlementMoney; refundAmount: OrderSettlementMoney } | null;
  paymentAttempts: OrderFinanceTransaction[]; refundOrders: OrderFinanceTransaction[]; reasonCodes: string[];
};
export type OrderSettlementEvidence = {
  business?: OrderFinanceBusiness;
  schema: 'admin-order-settlement-evidence.v1'; documentRef: string; readiness: 'READY' | 'UNAVAILABLE';
  posting: { state: 'POSTED' | 'FINALIZED_ZERO' | 'NOT_POSTED' | 'UNKNOWN'; ref: string | null; postedAt: string | null };
  captured: OrderSettlementMoney; ownerNet: OrderSettlementMoney; refundPayable: OrderSettlementMoney;
  platformContribution?: OrderSettlementMoney; platformComponents?: FinancePlatformComponent[];
  refunded: OrderSettlementMoney; historicalRefund: OrderSettlementMoney; refundDueAt: string | null;
  channel: { state: 'UNKNOWN'; reference: null };
  dutyRefs: { documentRef: string | null; kind: string; state: string; amount: OrderSettlementMoney }[];
  reasonCodes: string[];
};
export type FinanceResponse = {
  contractVersion: string; applied: FinanceFilters; snapshot: string; asOf: string; contextKey: string; snapshotVersion: string;
  documents?: FinanceDocument[]; document?: FinanceDocument; subjects?: { id: string; name: string }[]; subject?: { id: string; name: string };
  entries?: FinanceEntry[]; evidence?: Record<string, string | null>; related?: { ref: string; label: string; path?: string }[];
  wallet?: { buckets: Record<string, { amountCents: string | null; knowledge: string; scope?: string }>; withdrawable: { amountCents: string | null; reasonCodes: string[] }; coverage: { knowledge: string; origin?: string; cutoff?: string; coverageVersion?: string; reason?: string }; snapshotVersion: string };
  distributionCalculation?: { knowledge: 'KNOWN' | 'UNKNOWN'; policyVersion: string | null; levelCode: string | null; percent: string | null; baseCents: string | null; formula: string | null; reasonCodes: string[] };
  orderSettlement?: OrderSettlementEvidence;
  legacyOrderObservations?: { documentRef: string; number: string; kind: string; amountCents: string | null; occurredAt: string | null;
    originalStatus: string | null; originalStatusLabel: string | null; payWay: string | null; payWayLabel: string | null;
    refundAttempts?: HistoricalFinanceDisplay['refundAttempts']; sourceRefundFlags?: string[]; channelArrival: 'UNKNOWN' }[];
  platform?: { postedComponents: { accountCode: string | null; deltaCents: string | null; payer: string | null; feeBase: string | null; feeRate: string | null }[]; beforeDistributionCents: string | null; distributionExpenseCents: string | null; retainedCents: string | null; channelCostCents: string | null; netProfitCents: string | null; reasonCodes: string[] };
  documentCount?: number; subjectCount?: number; entryCount?: number; page?: number; pageSize?: number; hasMore?: boolean; reasonCodes?: string[]; gaps?: string[];
  reconciliation?: { bucket: string; openingBalance: string | null; knownInflows: string; knownOutflows: string; migrationMovement: string; closingBalance: string | null; difference: string | null; ledgerOpeningBalance?: string | null; ledgerClosingBalance?: string | null; ledgerDifference?: string | null; balanceBasis?: { knowledge: 'KNOWN' | 'UNKNOWN'; origin: string | null; sourceCutoff: string | null; openingPostedAt: string | null; reasonCodes: string[] }; knowledge: string; reasonCodes: string[]; unknownCount: number; unknownTimeCount: number; coveredHistoricalCount: number; uncoveredHistoricalCount: number }[];
};
export function financeRead(route: string, filters: FinanceFilters, signal: AbortSignal, extras: Record<string, string> = {}) {
  const query = financeQuery(filters); for (const [key, value] of Object.entries(extras)) if (value) query.set(key, value);
  return adminRequest<FinanceResponse>(`/finance/${route}?${query}`, undefined, "GET", {}, signal);
}
export type FinanceOverview = {
  version: 'admin.finance-overview.v1'; asOf: string; period: { range: 'today' | '7d' | '30d'; from: string; to: string; timeZone: string };
  confirmedPayments: { count: string; amountCents: string; controlledAmountCents: string; channelAmountCents: string; source: string; timeBasis: string; scope: string; reasonCodes: string[] };
  settlements: { count: string; capturedCents: string; ownerNetCents: string; refundPayableCents: string; platformContributionCents: string; timeBasis: string; reasonCodes: string[] };
  legacyOrderPayments?: { state: 'RECORDED' | 'UNAVAILABLE'; count: string | null; knownAmountCents: string | null; missingAmountCount: string | null; sourceUndatedCount: string | null; timeBasis: 'source_paid_at' };
  ledgerBalances: { bucket: string; balanceCents: string; state: string; source: string }[];
  coverage: { registeredSubjects: string; totalCurrentSubjects: string; globalProof: string; reasonCodes: string[] };
  recentSettlements: { id: string; number: string; owner: { id: string; name: string }; renter: { id: string; name: string }; capturedCents: string; ownerNetCents: string; refundPayableCents: string; platformContributionCents: string; postedAt: string; documentRef: string | null }[];
  costs: { netContributionCents: string | null; channelCostState: string; reasonCodes: string[] };
  channels: { state: string };
};
export async function downloadFinanceCsv(filters: FinanceFilters, snapshot: string, signal: AbortSignal) {
  const query = financeQuery(filters); query.set("snapshot", snapshot);
  const path = `${API_ROOT}/finance/export?${query}`;
  let response: Response;
  try { response = await fetch(path, { credentials: "include", signal }); } catch (error) { if (signal.aborted) throw error; throw new AdminApiError(0, "NETWORK_ERROR", undefined, path); }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: { code?: string; requestId?: string; details?:{path:string;code:string}[] } } | null;
    if ([401, 423].includes(response.status)) window.dispatchEvent(new CustomEvent(ADMIN_AUTH_FAILURE_EVENT, { detail: { status: response.status, path } }));
    throw new AdminApiError(response.status, error?.error?.code ?? "INTERNAL_ERROR", error?.error?.requestId ?? requestId, path, error?.error?.details??[]);
  }
  if (!response.headers.get("content-type")?.startsWith("text/csv") || response.headers.get("x-finance-export-phase") !== "PREPARED") throw new AdminApiError(503, "EVIDENCE_UNAVAILABLE", requestId, path);
  const blob = await response.blob(), expected = response.headers.get("x-finance-file-digest");
  const bytes = await blob.arrayBuffer(), actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
  if (!expected || actual !== expected || signal.aborted) throw new AdminApiError(409, "CONFLICT", requestId, path);
  return { blob, fileName: `admin-finance-${filters.from}-${filters.to}.csv`, rowCount: response.headers.get("x-finance-row-count"), fileDigest: actual, requestId, phase: "RECEIVED" as const };
}
