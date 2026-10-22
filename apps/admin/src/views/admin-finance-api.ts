import { ADMIN_AUTH_FAILURE_EVENT, API_ROOT, AdminApiError, adminRequest } from "../api";
import { beijingCalendarDate } from "../workspace/beijing-time";

export const FINANCE_ACCESS_FAILURE_EVENT = "zzsh-admin-finance-access-failure";
export const bucketLabels: Record<string, string> = { AVAILABLE: "用户可用", RESERVED: "提现预留", GUARANTEE_HELD: "号主上架保证金", REFUND_PAYABLE: "退款应付", PENDING_EARNINGS: "待结算收益", PLATFORM: "平台分项", CLEARING: "对照科目" };
export const kindLabels: Record<string, string> = { OPENING: "迁移期初", SETTLEMENT: "订单结算", WITHDRAWAL: "提现", EARNINGS: "历史流水", DISTRIBUTION: "分销", GUARANTEE: "上架保证金" };
kindLabels.REFUND = "退款责任";
export const stateLabels: Record<string, string> = { POSTED: "已入账", RESERVED: "已预留", SUBMITTING: "提交中", PROCESSING: "处理中", UNKNOWN: "结果未知", SUCCEEDED: "本地受控成功", FAILED: "失败", RECONCILIATION_REQUIRED: "结果冲突待核", HISTORICAL_OBSERVED: "历史观察" };
Object.assign(stateLabels, { ORDER_RECORDED: "订单记录", HISTORICAL_ORDER_RECORDED: "历史订单记录" });
Object.assign(stateLabels,{PENDING:'待结算',SETTLED:'已结算',REVOKED:'已撤销',RECOVERY_REQUIRED:'待追回'});
stateLabels.REFUND_PAYABLE_RECORDED = "应退责任已记录";
export const reasonLabels: Record<string, string> = {
  PERIOD_BALANCE_PROOF_NOT_AVAILABLE: "所选期间起止余额尚无完整依据",
  CURRENT_LEDGER_EXCLUDES_UNADMITTED_LEGACY:'当前勾稽仅覆盖已入账分录，待承接的历史责任另行核对',
  ZERO_FACT_NO_LEDGER_OR_CHANNEL_PAYMENT:'这是有依据的零额事实，没有资金分录或渠道支付',
  CHANNEL_ARRIVAL_NOT_PROVED:'账内记录不证明渠道到账',
  GLOBAL_RESERVED_AND_WITHDRAWABLE_NOT_ADMITTED: "完整预留和可提现范围尚未核定",
  SOURCE_COVERAGE_UNKNOWN: "资金来源覆盖未核定", SOURCE_COVERAGE_NOT_ADMITTED: "资金来源覆盖未准入",
  WITHDRAWAL_POLICY_NOT_ACTIVE: "可提现政策未启用", WITHDRAWAL_SOURCE_NOT_AVAILABLE: "提现读取来源尚未就绪",
  WITHDRAWAL_SOURCE_UNAVAILABLE: "原提现申请未取得", NATIVE_DISTRIBUTION_NOT_AVAILABLE: "当前收益政策和结算来源尚未接入",
  CHANNEL_COST_NOT_AVAILABLE: "渠道费用未取得", HISTORICAL_NOT_ADMITTED: "历史事实未纳入期初覆盖，未改变当前余额",
  HISTORICAL_STATUS_NOT_CHANNEL_RESULT: "旧状态不代表渠道到账", AMOUNT_OR_DIRECTION_UNKNOWN: "金额或方向未核定",
  HISTORICAL_GUARANTEE_NOT_CURRENT_HELD:'历史缴付观察不等于当前在押，当前责任待核定',
  INVALID_EXACT_AMOUNT: "金额格式待核", LOCAL_CONTROLLED_NOT_BANK_RECEIPT: "本地受控结果，不代表银行到账",
  LOCAL_OPERATION_NOT_APPLIED: "原本地渠道记录与申请结果尚未一致，资金处置仍按已入账分录核对",
  ORIGINAL_ORDER_REFERENCE_UNRESOLVED: "原订单尚未按来源引用解析", ORIGINAL_ORDER_REFERENCE_AMBIGUOUS: "原订单有多个来源候选，需逐一核对",
  ORDER_RECORD_NOT_CHANNEL_RESULT: "订单及付款记录不代表渠道到账", ORDER_NO_CURRENT_POSTING: "该单据没有当前入账分录",
  REFUND_PAYMENT_SOURCE_NOT_AVAILABLE: "退款出款依据尚未取得，应退责任按账内分录核对",
  DISTRIBUTION_AND_CHANNEL_COST_NOT_ADMITTED: "分销扣除和渠道成本尚未核定，未计算净利润",
};
export type FinanceFilters = { scope: string; from: string; to: string; period: boolean; bucket: string; kind: string; state: string; q: string };
export function defaultFinanceFilters(period: boolean): FinanceFilters { const today = beijingCalendarDate(); return { scope: "ALL", from: today, to: today, period, bucket: "ALL", kind: "ALL", state: "ALL", q: "" }; }
export function financeQuery(filters: FinanceFilters): URLSearchParams { return new URLSearchParams({ ...filters, period: filters.period ? "1" : "0" }); }
export function financeMoney(cents: string | null | undefined): string {
  if (cents === null || cents === undefined || !/^-?\d+$/.test(cents)) return "未核定";
  const value = BigInt(cents), abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${(abs / 100n).toLocaleString("zh-CN")}.${(abs % 100n).toString().padStart(2, "0")} 元`;
}
export function financeTime(value: string | null | undefined): string { return !value || !Number.isFinite(Date.parse(value)) ? "时间未核定" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
export type HistoricalFinancePurpose = 'SETTLEMENT_INCOME' | 'OWNER_RENTAL_INCOME' | 'DISTRIBUTION_INCOME' | 'WITHDRAWAL_APPLICATION' | 'WITHDRAWAL_DEBIT' | 'WITHDRAWAL_REJECTED_RETURN' | 'TRANSFER_FAILED_RETURN' | 'WECHAT_WITHDRAWAL_FAILED_RETURN' | 'PLATFORM_CREDIT' | 'PLATFORM_DEBIT' | 'DEPOSIT_COMPENSATION' | 'TASK_SETTLEMENT' | 'UNKNOWN';
export type HistoricalFinanceDisplay = {
  changeType: string | null; purposeCode: HistoricalFinancePurpose; purposeLabel: string; originalLogNumber: string | null;
  recordedAmountCents: string | null; balanceAfterCents: string | null; feeCents: string | null; netCents: string | null;
  originalStatus: string | null; originalStatusLabel: string | null; channelState: 'UNVERIFIED';
  association: { state: 'MATCHED' | 'UNRESOLVED' | 'AMBIGUOUS' | 'DENIED'; kind: 'ORDER' | 'WITHDRAWAL' | 'DISTRIBUTION' | 'TASK' | 'UNKNOWN'; documentRef: string | null; number: string | null; path: string | null; role: 'OWNER' | 'BENEFICIARY' | 'WITHDRAWER' | null; originalStatus: string | null; originalStatusLabel: string | null };
};
type FinanceRecord = { kind: string; state: string; historical?: HistoricalFinanceDisplay };
export function financeIsHistorical(record: FinanceRecord): boolean { return !!record.historical || record.state.startsWith('HISTORICAL_'); }
export function financeBusinessLabel(record: FinanceRecord): string { return record.historical?.purposeLabel?.trim() || kindLabels[record.kind] || '资金记录'; }
export function financeRecordNumber(record: FinanceRecord, fallback: string): string {
  return record.historical?.originalLogNumber ? `原流水号 ${record.historical.originalLogNumber}` : financeIsHistorical(record) ? `记录编号 ${fallback}` : fallback;
}
export function financeRecordState(record: FinanceRecord): string {
  const original = record.historical?.originalStatusLabel;
  return financeIsHistorical(record) ? original ? original.startsWith('旧平台') ? original : `旧平台状态：${original}` : '旧平台记录' : stateLabels[record.state] ?? '状态待核';
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
  return [['原流水号', historical.originalLogNumber || '未取得'], ['原金额', financeMoney(historical.recordedAmountCents)], ['变动后余额（旧）', financeMoney(historical.balanceAfterCents)],
    ['手续费', financeMoney(historical.feeCents)], ['净额', financeMoney(historical.netCents)], ['原用途码', historical.changeType ?? '未取得'], ['原状态码', historical.originalStatus ?? '未取得']];
}
export type FinanceEntry = { id: string; documentRef: string; documentNumber: string; subjectId: string; subjectName: string; bucket: string; direction: string; deltaCents: string | null; knowledge: string; kind: string; state: string; classification: string; affectsCurrentWallet: boolean; affectsCurrentLedger: boolean; occurredAt: string | null; importedAt: string; sourceType: string; sourceEntity: string; sourceSystem: string; sourceId: string; sourceDigest: string | null; basisId: string | null; reasonCodes: string[]; accountCode: string | null; evidence: Record<string, string | null>; historical?: HistoricalFinanceDisplay };
export type FinanceDocument = { ref: string; number: string; kind: string; state: string; occurredAt: string | null; requestedAmountCents: string | null; subjects: { id: string; name: string }[]; entryCount: number; amounts: { bucket: string; knownNetCents: string; unknownCount: number }[]; historical?: HistoricalFinanceDisplay };
export type FinanceResponse = {
  contractVersion: string; applied: FinanceFilters; snapshot: string; asOf: string; contextKey: string; snapshotVersion: string;
  documents?: FinanceDocument[]; document?: FinanceDocument; subjects?: { id: string; name: string }[]; subject?: { id: string; name: string };
  entries?: FinanceEntry[]; evidence?: Record<string, string | null>; related?: { ref: string; label: string; path?: string }[];
  wallet?: { buckets: Record<string, { amountCents: string | null; knowledge: string }>; withdrawable: { amountCents: string | null; reasonCodes: string[] }; coverage: { knowledge: string; cutoff?: string; coverageVersion?: string; reason?: string }; snapshotVersion: string };
  documentCount?: number; subjectCount?: number; entryCount?: number; page?: number; pageSize?: number; hasMore?: boolean; reasonCodes?: string[]; gaps?: string[];
  reconciliation?: { bucket: string; openingBalance: string | null; knownInflows: string; knownOutflows: string; migrationMovement: string; closingBalance: string | null; difference: string | null; knowledge: string; reasonCodes: string[]; unknownCount: number; unknownTimeCount: number; coveredHistoricalCount: number; uncoveredHistoricalCount: number }[];
};
export function financeRead(route: string, filters: FinanceFilters, signal: AbortSignal, extras: Record<string, string> = {}) {
  const query = financeQuery(filters); for (const [key, value] of Object.entries(extras)) if (value) query.set(key, value);
  return adminRequest<FinanceResponse>(`/finance/${route}?${query}`, undefined, "GET", {}, signal);
}
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
