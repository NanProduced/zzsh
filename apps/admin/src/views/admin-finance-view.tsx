import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, Download, RotateCcw, SlidersHorizontal, TriangleAlert, Search } from "lucide-react";
import { AdminApiError, friendlyError, ADMIN_AUTH_FAILURE_EVENT, type SessionSnapshot } from "../api";
import { findPhoneClue, sanitizeFinanceReturn, tabFromLocation, canOpenKind, type WorkspaceTab } from "../workspace/tab-model";
import { FINANCE_ACCESS_FAILURE_EVENT, bucketLabels, bucketNature, businessBucketLabels, kindLabels, stateLabels, reasonLabels, defaultFinanceFilters, financeQuery, financeRead, downloadFinanceCsv, financeMoney, financeTime, financeIsHistorical, financeIsHistoricalBalance, historicalFinanceAmount, financeBusinessLabel, financeRecordNumber, financeRecordState, historicalAssociationPath, historicalFinanceFacts, type HistoricalFinanceDisplay, type FinanceFilters, type FinanceResponse, type FinanceDocument, type FinanceEntry } from "./admin-finance-api";
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DateSelector } from '@/components/reui/date-selector';
import { UserDirectoryBff, EMPTY_FILTERS } from './user-directory/user-directory-data';
import { financeEntryScope, financeEntryEvent } from './admin-finance-api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/admin-list/list-table';
import { ListPagination } from '@/components/admin-list/list-pagination';
import "./admin-finance.css";
import { AdminOrderSettlementEvidence, ORDER_SETTLEMENT_FLAT_KEYS, orderSettlementSummary } from './admin-order-settlement-evidence';
import type { ChannelSearchClue } from "./admin-channel-evidence-panel";
import { sourceFamilyText } from './admin-channel-evidence-model';
import { FinanceOrderPayment, FinanceOrderCosts, financeOrderState } from './finance-order-facts';
import { beijingCalendarDate, beijingRangeStart } from '../workspace/beijing-time';

const quickKinds = [
  { key: 'ALL', label: '全部业务' },
  { key: 'PAYMENT', label: '付款记录' },
  { key: 'SETTLEMENT', label: '结算记录' },
  { key: 'REFUND', label: '用户退款' },
  { key: 'WITHDRAWAL', label: '余额提现' },
  { key: 'GUARANTEE', label: '上架保证金' },
  { key: 'DISTRIBUTION', label: '分销佣金' },
  { key: 'OPENING', label: '历史期初' },
] as const;

function getAvailableStates(kind: string): Record<string, string> {
  if (kind === 'PAYMENT') {
    return {
      ALL: '全部支付状态',
      POSTED: '已入账',
      HISTORICAL_OBSERVED: '历史记录',
    };
  }
  if (kind === 'WITHDRAWAL') {
    return {
      ALL: '全部提现状态',
      SUBMITTING: '提交中',
      PROCESSING: '处理中',
      SUCCEEDED: '本地成功记录',
      FAILED: '出款失败',
      HISTORICAL_OBSERVED: '历史记录',
      UNKNOWN: '结果未知',
    };
  }
  if (kind === 'SETTLEMENT') {
    return {
      ALL: '全部结算状态',
      POSTED: '已完结入账',
      PENDING: '履约中待结算',
      ORDER_RECORDED: '新平台订单记录',
      HISTORICAL_ORDER_RECORDED: '旧平台订单记录',
    };
  }
  if (kind === 'REFUND') {
    return {
      ALL: '全部退款状态',
      REFUND_PAYABLE_RECORDED: '应退责任已记录',
      HISTORICAL_OBSERVED: '历史记录',
      POSTED: '已入账退款',
    };
  }
  if (kind === 'GUARANTEE') {
    return {
      ALL: '全部保证金状态',
      RESERVED: '在押锁定中',
      POSTED: '已入账',
    };
  }
  if (kind === 'DISTRIBUTION') {
    return {
      ALL: '全部分销状态',
      PENDING: '待结算',
      SETTLED: '已结算',
      REVOKED: '已撤销',
      RECOVERY_REQUIRED: '待追回',
    };
  }
  if (kind === 'OPENING') {
    return {
      ALL: '全部期初状态',
      POSTED: '已入账期初',
    };
  }
  return {
    ALL: '全部状态',
    POSTED: '已入账 (成功)',
    PENDING: '待结算',
    PROCESSING: '处理中',
    RESERVED: '已预留 (冻结)',
    SUCCEEDED: '本地受控成功',
    FAILED: '失败',
    RECONCILIATION_REQUIRED: '对账需核对',
    HISTORICAL_OBSERVED: '历史观察',
  };
}

function kindBadge(document: FinanceDocument) {
  const isCancelled = document.kind === 'SETTLEMENT' && document.state === 'CANCELLED';
  const isUnposted = document.kind === 'SETTLEMENT' && document.entryCount === 0;
  if (isCancelled || isUnposted) {
    return <Badge variant="outline" className="text-muted-foreground border-border text-xs font-normal">订单原单</Badge>;
  }
  switch (document.kind) {
    case 'PAYMENT':
      return <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-xs font-normal">订单付款</Badge>;
    case 'SETTLEMENT':
      return <Badge className="bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 text-xs font-normal">完结结算</Badge>;
    case 'WITHDRAWAL':
      return <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 text-xs font-normal">余额提现</Badge>;
    case 'REFUND':
      return <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 text-xs font-normal">退款责任</Badge>;
    case 'GUARANTEE':
      return <Badge className="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 text-xs font-normal">上架保证金</Badge>;
    case 'DISTRIBUTION':
      return <Badge className="bg-pink-500/10 text-pink-600 dark:text-pink-400 border border-pink-500/20 text-xs font-normal">分销佣金</Badge>;
    case 'OPENING':
      return <Badge variant="outline" className="text-muted-foreground border-border text-xs font-normal">迁移期初</Badge>;
    default:
      return <Badge variant="secondary" className="text-xs font-normal">{kindLabels[document.kind] ?? '资金记录'}</Badge>;
  }
}

function statusDot(state: string) {
  if (['POSTED', 'SUCCEEDED', 'PAID', 'COMPLETED', 'SETTLED'].includes(state)) {
    return <span className="size-1.5 rounded-full bg-emerald-500 inline-block mr-1.5" />;
  }
  if (['PROCESSING', 'SUBMITTING', 'RESERVED', 'PENDING'].includes(state)) {
    return <span className="size-1.5 rounded-full bg-blue-500 inline-block mr-1.5" />;
  }
  if (['FAILED', 'RECONCILIATION_REQUIRED', 'RECOVERY_REQUIRED'].includes(state)) {
    return <span className="size-1.5 rounded-full bg-red-500 inline-block mr-1.5" />;
  }
  if (['CANCELLED', 'REVOKED'].includes(state)) {
    return <span className="size-1.5 rounded-full bg-muted-foreground inline-block mr-1.5" />;
  }
  return <span className="size-1.5 rounded-full bg-amber-500 inline-block mr-1.5" />;
}

type Snapshot = Extract<SessionSnapshot, { authenticated: true }>;
type SavedView = { applied: FinanceFilters; draft: FinanceFilters; page: number; pageSize?: number; scroll: number; focus?: string; snapshot?: string };
type Origin = { path: string; parent?: string; channelSearch?: ChannelSearchClue };
const savedViews = new Map<string, SavedView>(), origins = new Map<string, Origin>();
let currentIdentity = "";
export function financeContextIdentity(snapshot: Snapshot): string { return `${snapshot.adminUserId}:${snapshot.session.id}:${snapshot.security.isBoss}:${snapshot.security.status}:${snapshot.security.passwordChangeRequired}:${snapshot.session.locked}:${[...snapshot.permissions].sort().join("|")}`; }
export function clearFinanceContexts(): void { savedViews.clear(); origins.clear(); currentIdentity = ""; }
export function registerFinanceOrigin(path: string, identity?: string, channelSearch?: ChannelSearchClue): string {
  if (identity && identity !== currentIdentity) { clearFinanceContexts(); currentIdentity = identity; }
  const origin = crypto.randomUUID(); origins.set(origin, { path, channelSearch }); return origin;
}
export function financeOriginPath(origin: string | undefined, snapshot: Snapshot, fallback?: string): string | undefined {
  const source = financeContextIdentity(snapshot) === currentIdentity && origin ? origins.get(origin) : undefined;
  if (source) return source.channelSearch ? source.path + (source.path.includes('?') ? '&' : '?') + new URLSearchParams({ evidenceOrigin: origin! }) : source.path;
  const safe = sanitizeFinanceReturn(fallback);
  const target = safe ? new URL(safe,'https://workspace.invalid') : undefined;
  return target && canOpenKind(tabFromLocation(target.pathname,target.search).kind,{permissions:snapshot.permissions,isBoss:snapshot.security.isBoss}) ? safe : undefined;
}
export function financeChannelSearch(origin: string | undefined, snapshot: Snapshot): ChannelSearchClue | undefined {
  return financeContextIdentity(snapshot) === currentIdentity && origin ? origins.get(origin)?.channelSearch : undefined;
}
function FinanceSelect({ label, value, options, onChange }: { label: string; value: string; options: Record<string, string>; onChange: (value: string) => void }) {
  return (
    <Select value={value} onValueChange={next => { if (next) onChange(next); }}>
      <SelectTrigger aria-label={label} className="h-[38px] w-full bg-background text-xs">
        <SelectValue>{options[value] ?? '全部'}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Object.entries(options).map(([key, text]) => (
          <SelectItem key={key} value={key} className="text-xs">
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function FinanceDateRange({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const [open, setOpen] = useState(false);
  const day = (date: Date | undefined) => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';
  return <div className="finance-date-range"><span>发生日期 · 北京时间</span><Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button type="button" variant="outline" aria-label="选择资金发生日期" />}><CalendarDays size={16}/>{from === to ? from : `${from} 至 ${to || '请选择结束日期'}`}</PopoverTrigger><PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-0"><DateSelector value={{period:'day',operator:'between',startDate:from?new Date(`${from}T00:00:00`):undefined,endDate:to?new Date(`${to}T00:00:00`):undefined}} presetMode="between" allowRange showTwoMonths={false} showInput={false} onChange={next=>{onChange(day(next.startDate),day(next.endDate));if(next.startDate&&next.endDate)setOpen(false);}}/></PopoverContent></Popover></div>;
}
function FinanceDisclosure({ title, children, className, defaultOpen = false }: { title: string; children: React.ReactNode; className?: string; defaultOpen?: boolean }) {
  return <Collapsible className={className} defaultOpen={defaultOpen}><CollapsibleTrigger render={<Button variant="ghost" size="sm"/>}>{title}<ChevronDown size={14}/></CollapsibleTrigger><CollapsibleContent>{children}</CollapsibleContent></Collapsible>;
}
function scroller() { const page = document.querySelector<HTMLElement>(".workspace-page"); return page && page.scrollHeight > page.clientHeight ? page : document.scrollingElement; }
export function rangeDays(from: string, to: string): number {
  const dates = [from,to].map(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)?new Date(`${value}T00:00:00Z`):new Date(NaN));
  if (dates.some((date,index)=>!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==[from,to][index])) return NaN;
  return (dates[1]!.getTime()-dates[0]!.getTime())/86400000+1;
}
function has(snapshot: Snapshot, permission: string) { return snapshot.permissions.includes(permission); }
function filtersFromTab(tab: WorkspaceTab, period: boolean): FinanceFilters {
  const result = defaultFinanceFilters(period);
  if (period) result.from = beijingCalendarDate(beijingRangeStart('7d'));
  for (const key of ["scope", "from", "to", "bucket", "kind", "state", "q"] as const) if (tab.query[key]) result[key] = tab.query[key]!;
  if (tab.query.period) result.period = tab.query.period === "1";
  return result;
}
function navigationKey(tab: WorkspaceTab, query = tab.query): string { return JSON.stringify([tab.id, tab.path, ...["scope", "from", "to", "period", "bucket", "kind", "state", "q", "page", "pageSize", "entry", "origin", "financeReturn", "reset"].map(key => query[key] ?? "")]); }
function label(code: string) { return reasonLabels[code] ?? "该项依据尚未取得"; }
function periodReasonCodes(row: NonNullable<FinanceResponse['reconciliation']>[number]): string[] {
  return [...new Set([...(row.reasonCodes??[]),...(row.balanceBasis?.reasonCodes??[])])];
}
function financeDocumentLabel(document: FinanceDocument): string { return document.orderLifecycle ? document.orderLifecycle.origin === 'NATIVE' ? '新平台订单' : '旧平台订单' : document.kind === 'SETTLEMENT' && document.state === 'CANCELLED' ? '订单原单（未结算）' : document.kind === 'SETTLEMENT' && document.entryCount === 0 ? '订单（未过账）' : financeBusinessLabel(document); }
const orderRecordState: Record<string,string> = { CANCELLED: "已取消", PENDING_PAYMENT: "待支付", PAID: "已支付", COMPLETED: "已完成" };
/** 订单原单状态沿用订单词表；未知资金状态仍为未记录。 */
function recordState(record: FinanceDocument | FinanceEntry): string { const lifecycle = 'orderLifecycle' in record ? financeOrderState(record as FinanceDocument) : undefined; const value = lifecycle ?? financeRecordState(record); return value === "状态未记录" ? orderRecordState[record.state] ?? value : value; }
function emptyText(value: string | null | undefined) { return value ?? "未取得"; }
function entryClass(entry: FinanceEntry) { if(entry.classification === "LOCAL_SOURCE_WITHOUT_POSTING")return "业务记录，尚未过账"; if(entry.classification === "HISTORICAL_GUARANTEE")return "保证金来源观察，当前在押未记录";if(entry.classification === "ZERO_FINALIZATION")return "零额终定，无资金分录";if(entry.classification === "ZERO_AMOUNT_FACT")return "零额事实，无资金变动";return entry.classification === "HISTORICAL_COVERED" ? "已含迁移期初" : entry.classification === "HISTORICAL_UNCOVERED" ? "历史记录未纳入期初覆盖" : entry.classification === "OPENING" ? "迁移期初入账" : "当前分录"; }
const accountLabels: Record<string,string> = { OWNER_AVAILABLE:'号主收益入可用', RENTER_REFUND_PAYABLE:'租客退款应付', PLATFORM_HAFF_SPREAD:'平台哈夫币价差', PLATFORM_ITEM_SPREAD:'平台物资价差', PLATFORM_EARLY_MAKEUP:'提前结束补偿（平台收入科目）', PLATFORM_COMPENSATION_FEE:'包赔服务费（平台收入科目）', PLATFORM_MANUAL_NET_ADJUSTMENT:'人工结算调整' };
const technicalEvidenceKeys = new Set(['intentId','paymentConfirmationId','settlementVersionId','originalReference','originalOrderId','ownerSubjectId','renterSubjectId','accountId','legacyAccountId','originalOperationRef']);
const evidenceLabels: Record<string, string> = { originalBankName:"旧收款银行",originalRecipientMask:"旧收款人掩码",originalMobileMask:"旧手机号掩码",originalOperatorSourceId:"旧操作人来源ID",originalDestinationMask:"旧收款目的掩码",originalRatio:"原分销比例",originalLevel:"原分销层级",originalOrderType:"原来源类型",originalPayWay:"支付方式（原记录）", intentId: "原申请", grossCents: "申请金额", netCents: "净额", feeCents: "手续费", policyVersion: "政策版本", fundsDisposition: "资金处置", acceptedAt: "申请时间", channelState: "渠道结果", channelReference: "渠道引用", queryRef: "最近查询引用", queriedAt: "最近查询", paymentConfirmationId: "原支付确认", settlementVersionId: "结算版本", refundPayableCents: "退款应付", refundDueAt: "退款责任到期", postedPlatformContributionCents: "原账平台分项（非净利润）", openingCutoff: "迁移截止", coveredCount: "覆盖笔数", originalReference: "原关联引用", originalNumber: "原编号", originalStatus: "原状态", originalNetCents: "原净额", originalFeeCents: "原手续费", dueAt: "计划转可用时间", postedAt: "业务入账时间", recordedAt: "分录写入时间" };
Object.assign(evidenceLabels, { originalOperationRef: "原本地渠道记录", originalOperationRecordedAt: "记录时间", originalOperationOutcome: "原本地渠道结果", originalOperationReference: "原本地渠道引用" });
Object.assign(evidenceLabels, { originalOrderNumber: "原订单号", originalOrderId: "原订单来源ID", ownerSubjectId: "号主用户ID", renterSubjectId: "租客用户ID", historicalBalanceAfterCents: "历史记录后余额", originalOrderStatus: "原订单状态", originalPaymentStatus: "原付款状态", recordedDueCents: "订单记录应付", recordedPaidCents: "旧记录付款", recordedDepositCents: "记录押金", postingCapturedCents: "原入账基数" });
Object.assign(evidenceLabels, { refundPaidCents: "已退金额", refundPaymentReference: "退款出款引用" });
Object.assign(evidenceLabels, { merchantIdentityId: "商户身份", productFamily: "业务来源", platformOrderNo: "本站平台原号", channelSerial: "已登记渠道流水" });
Object.assign(evidenceLabels,{accountId:'出租账号ID',legacyAccountId:'旧账号来源ID',sourcePaidRecordCents:'历史已付记录合计',sourcePaidRecordCount:'历史已付笔数',accountFieldCents:'原账号金额字段',sourcePaidMark:'原已付标记',sourceReturnMark:'原退还标记',sourcePaidAt:'原支付时点',sourceClass:'来源判断',sourceConflicts:'来源矛盾',currentLiabilityCents:'当前在押责任',channelArrival:'渠道到账'});
const guaranteeClasses:Record<string,string>={ZERO_AMOUNT_RETURN_MARK:'零金额退还标记，原缴退仍未记录',SOURCE_RETURN_MARK_CHANNEL_UNKNOWN:'来源标记退还，渠道结果未记录',ZERO_AMOUNT_PAID_MARK:'零金额已付标记，原责任未记录',SOURCE_PAID_REFUND_UNKNOWN:'有已付记录，退款责任未记录',PAID_RECORD_RESET_REFUND_UNKNOWN:'有已付记录但标记已重设，退款责任未记录',PAID_MARK_WITHOUT_PAY_ORDER_UNKNOWN:'有已付标记，缺支付表佐证',HISTORICAL_TRACE_UNKNOWN:'有历史时间痕迹，原责任未记录',NO_PAYMENT_EVIDENCE_UNKNOWN:'未取得付款证据，原责任未记录'};
const orderStatusText: Record<string,string> = { PENDING_PAYMENT: '待支付', PAID: '已支付', COMPLETED: '已完成', CANCELLED: '已取消' };
const paymentStatusText: Record<string,string> = { PAID: '支付已记录', UNPAID: '原系统记录未付，渠道结果另核', RECORDED_PAID: '支付已记录', RECORDED_UNPAID: '本站尚未确认付款', UNKNOWN: '支付未记录' };
function evidenceValue(key: string, value: string | null, historical?: HistoricalFinanceDisplay) { if(key==='sourceClass')return value?guaranteeClasses[value]??'来源判断未记录':'未记录';if(key==='sourceConflicts')return value?value.split(',').map(v=>v==='MULTIPLE_PAID_ATTEMPTS'?'存在多笔已付记录':v==='CURRENT_AMOUNT_DIFFERS_FROM_PAID_ATTEMPT'?'原账号金额与支付记录不一致':'来源矛盾未记录').join('；'):'未见已知金额矛盾';if(key==='channelArrival'&&value==='UNKNOWN')return'未取得依据';if((key==='originalPayWay'||key==='originalStatus')&&historical?.amountSemantics==='UNVERIFIED')return'来源未核对';if(key==='originalPayWay')return value==='2'?'微信（原记录）':value==='3'?'支付宝（原记录）':value?'未知':'未取得';if(key==='originalStatus')return historical?.originalStatusLabel??(value?'未知':'未取得');if(key==='originalOrderStatus')return value?orderStatusText[value]??value:'未取得';if(key==='originalPaymentStatus')return value?paymentStatusText[value]??value:'未取得';return key.endsWith("Cents") ? financeMoney(value) : /At$|Cutoff$/.test(key) ? financeTime(value) : emptyText(value); }
function decodeReference(value: string) { try { return decodeURIComponent(value); } catch { return "INVALID_REFERENCE"; } }
function historicalRelationDenied(historical: HistoricalFinanceDisplay | undefined, orderRead: boolean, documentRead: boolean) {
  return historical?.association?.state === 'DENIED' || historical?.association?.state === 'MATCHED' && !(historical.association.kind === 'ORDER' ? orderRead : documentRead);
}
function visibleEvidence(evidence: FinanceResponse['evidence'], historical: HistoricalFinanceDisplay | undefined, orderRead: boolean, documentRead: boolean, settlement?: FinanceResponse['orderSettlement']) {
  const denied = historicalRelationDenied(historical, orderRead, documentRead);
  const identityKeys = new Set(['originalReference', 'originalNumber', 'originalOrderNumber', 'originalOrderId', 'ownerSubjectId', 'renterSubjectId', 'intentId', 'paymentConfirmationId', 'settlementVersionId', 'accountId', 'legacyAccountId']);
  const withdrawal = historical && ['WITHDRAWAL_APPLICATION','WITHDRAWAL_DEBIT','WITHDRAWAL_REJECTED_RETURN','TRANSFER_FAILED_RETURN','WECHAT_WITHDRAWAL_FAILED_RETURN'].includes(historical.purposeCode);
  const distribution = historical?.purposeCode === 'DISTRIBUTION_INCOME';
  return Object.entries(evidence ?? {}).filter(([key, value]) => {
    if (!evidenceLabels[key] || settlement && ORDER_SETTLEMENT_FLAT_KEYS.has(key) || settlement?.business && key === 'recordedPaidCents' || denied && identityKeys.has(key)) return false;
    if (!historical || historical.purposeCode === 'UNKNOWN' || value !== null) return true;
    if (['originalRatio','originalLevel'].includes(key)) return distribution;
    if (['originalDestinationMask','originalBankName','originalRecipientMask','originalMobileMask','originalOperatorSourceId','originalNetCents','originalFeeCents'].includes(key)) return withdrawal;
    if (key === 'historicalBalanceAfterCents') return historical.changeType !== null;
    if (key === 'originalPayWay') return historical.purposeCode === 'PAYMENT_RECORD';
    if (['dueAt','policyVersion'].includes(key)) return false;
    return true;
  });
}

const withdrawalStateText: Record<string,string> = { SUCCEEDED: '本地受控成功（非银行到账）', FAILED: '本地失败', PAYOUT_POSTED: '本地出款已记录', RELEASE_POSTED: '本地释放已记录', PROCESSING: '本地处理中', SUBMITTING: '提交中', UNKNOWN: '结果未知' };
const withdrawalDispositionText: Record<string,string> = { RESERVED: '预留中', PAYOUT_POSTED: '本地出款已记录', RELEASE_POSTED: '本地释放已记录', CONSUMED: '预算已用', RELEASED: '预算已释放', ALLOCATED: '预算已分配' };
/** Withdrawal facts use only the existing read DTO; absent target/fee/provider fields stay explicitly unavailable. */
function WithdrawalEvidence({ document, evidence, entries }: { document: FinanceDocument; evidence: Record<string, string | null> | undefined; entries: FinanceEntry[] | undefined }) {
  const gross = evidence?.grossCents ?? document.requestedAmountCents;
  const target = evidence?.originalDestinationMask ?? null;
  const controlled = document.ref.startsWith("WITHDRAWAL:");
  const joinpay = document.ref.startsWith("JOINPAY_WITHDRAWAL:");
  const registeredTarget = evidence?.destinationId ?? evidence?.targetFingerprint ?? null;
  const source = entries?.[0];
  const row = (label: string, value: React.ReactNode) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>;
  return <section data-withdrawal-evidence className="finance-withdrawal-evidence space-y-3">
    <div className="finance-section-heading"><h2>提现申请与出款</h2><Badge variant="warning">{controlled ? "本地受控，不代表银行到账" : joinpay ? "汇聚原生记录，银行到账另核" : "提现来源未记录"}</Badge></div>
    <dl className="finance-fact-list">
      {row('申请扣减额', financeMoney(gross))}
      {row('用户政策费', evidence?.userFeeCents != null ? financeMoney(evidence.userFeeCents) : controlled && evidence?.feeCents != null ? financeMoney(evidence.feeCents) : '未取得')}
      {row('应出款额', evidence?.netCents ? financeMoney(evidence.netCents) : '未取得')}
      {row('渠道费', evidence?.providerFeeCents != null ? financeMoney(evidence.providerFeeCents) : evidence?.channelFeeCents != null ? financeMoney(evidence.channelFeeCents) : '未取得（渠道费用依据未接入）')}
      {row('原出款目标', target ?? (registeredTarget ? '原目标已登记，未取得安全显示资料' : '未取得原目标'))}
      {row('渠道结果', evidence?.channelState ? controlled ? withdrawalStateText[evidence.channelState] ?? '渠道状态未记录' : '已登记状态，可信渠道结果另核' : '未取得')}
      {row('渠道流水', evidence?.channelSerial ?? (controlled ? evidence?.channelReference : null) ?? '未取得')}
      {row('本站处置', evidence?.fundsDisposition ? withdrawalDispositionText[evidence.fundsDisposition] ?? '处置未记录' : '未取得')}
      {evidence?.originalNumber ? row('原商户出款号', evidence.originalNumber) : null}
      {row('申请时间', financeTime(evidence?.acceptedAt ?? null))}
      {row('最近查询', financeTime(evidence?.queriedAt ?? null))}
      {row('来源族', sourceFamilyText(source))}
    </dl>
    <p className="finance-fact-note">{controlled ? '本地受控成功、SUCCEEDED 或出款已记录都不是银行到账；银行到账依据未取得。' : '本站资金处置、渠道结果与银行到账分别核对；银行到账依据未取得。'}原目标、渠道费和外部流水缺少依据时保持未知。</p>
  </section>;
}
export function HistoricalFinanceDetail({ historical, recordKind, orderRead, documentRead, onOpenPath, expanded = false }: { historical?: HistoricalFinanceDisplay; recordKind: string; orderRead: boolean; documentRead: boolean; onOpenPath: (path: string, title?: string) => void; expanded?: boolean }) {
  if (!historical) return null;
  const association = historical.association;
  const relationAllowed = association?.kind === 'ORDER' ? orderRead : documentRead;
  const denied = association?.state === 'DENIED' || association?.state === 'MATCHED' && !relationAllowed;
  const matched = association?.state === 'MATCHED' && !denied;
  const path = historicalAssociationPath(historical, { orderRead, documentRead });
  const relationLabel = matched ? association.kind === 'WITHDRAWAL' && historical.purposeCode === 'WITHDRAWAL_APPLICATION' ? '关联余额扣款流水' : ({ ORDER: '关联订单', WITHDRAWAL: '关联提现单', DISTRIBUTION: '关联分销记录', TASK: '关联任务', UNKNOWN: '关联记录' }[association.kind]) : denied ? '关联信息无权限' : association?.state === 'AMBIGUOUS' ? '存在多条关联候选，未确认' : '关联未记录';
  const sameWithdrawal = matched && association.kind === 'WITHDRAWAL';
  return <div data-historical-finance className="mt-1.5 space-y-1.5 text-xs">
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline" className="text-[11px] py-0 px-1.5 h-5">{historical.amountSemantics === 'UNVERIFIED' ? '旧平台记录' : historical.purposeCode === 'WITHDRAWAL_APPLICATION' ? '提现申请记录' : historical.purposeCode === 'WITHDRAWAL_DEBIT' ? '余额扣款记录' : '旧平台记录'}</Badge>
      {historical.amountSemantics === 'UNVERIFIED' ? <Badge variant="warning" className="text-[11px] py-0 px-1.5 h-5">来源待核</Badge> : null}
      <Badge variant="warning" className="text-[11px] py-0 px-1.5 h-5">渠道未核</Badge>
    </div>
    <div className="flex flex-wrap items-center gap-2 pt-0.5" data-historical-association>
      <span className="text-muted-foreground">{relationLabel}{matched && association.number ? `：${association.number}` : ''}</span>
      {path ? <button type="button" className="finance-link-action" onClick={() => onOpenPath(path, association.number || relationLabel)}>查看关联记录<ArrowUpRight aria-hidden size={12}/></button> : null}
    </div>
    <Collapsible defaultOpen={expanded}>
      <CollapsibleTrigger render={<button type="button" className="finance-ghost-action"/>}>
        历史记录详情<ChevronDown aria-hidden size={12} className="transition-transform duration-200 group-data-[state=open]:rotate-180"/>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-1 pb-2">
        <dl className="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">{historicalFinanceFacts(historical).map(([name, value]) => <div key={name}><dt className="text-muted-foreground">{name}</dt><dd className="mt-0.5 break-all font-medium tabular-nums">{value}</dd></div>)}</dl>
        {historical.refundAttempts?.map(a=><p key={'la_refund_log:'+a.source.id} className="text-muted-foreground">原退款尝试：{a.originalNumber??'原号未记录'} · {financeMoney(a.recordedAmountCents)} · {a.originalStatus==='0'?'旧平台退款中':a.originalStatus==='1'?'旧平台记为退款成功':a.originalStatus==='2'?'旧平台记为退款失败':'旧状态未记录'} · {financeTime(a.occurredAt)}</p>)}{historical.sourceRefundFlags?.length?<p className="text-amber-500/90 dark:text-amber-400">同订单原退款存在多笔记录或金额未记录事项；原记录均保留，不代表再次出款指令。</p>:null}{matched && association.originalStatusLabel ? <p className="text-muted-foreground">关联业务：{association.originalStatusLabel.startsWith('旧平台') ? association.originalStatusLabel : `旧平台状态：${association.originalStatusLabel}`}</p> : null}
        <p className="text-muted-foreground">历史金额不改变当前钱包。{sameWithdrawal ? '已核证的提现申请与余额流水属于同一笔业务，金额不重复汇总。' : ''}</p>
      </CollapsibleContent>
    </Collapsible>
  </div>;
}

export function AdminFinanceView({ tab, snapshot, onOpenPath, onQueryChange, onRefresh, refreshNonce }: {
  tab: WorkspaceTab; snapshot: Snapshot; onOpenPath: (path: string, title?: string) => void; onQueryChange: (query: Record<string, string>) => void; onRefresh: () => Promise<SessionSnapshot>; refreshNonce: number;
}) {
  const identity = financeContextIdentity(snapshot);
  if (identity !== currentIdentity) { clearFinanceContexts(); currentIdentity = identity; }
  const period = tab.path === "/finance/period", documentId = tab.path.startsWith("/finance/documents/") ? decodeReference(tab.path.slice(19)) : null;
  const object = documentId !== null;
  const viewKey = `${identity}:${tab.id}`, saved = savedViews.get(viewKey);
  const incomingNavigation = navigationKey(tab), previousNavigation = useRef(incomingNavigation), ownNavigation = useRef<string | undefined>(undefined);
  const externalNavigationChanged = previousNavigation.current !== incomingNavigation && ownNavigation.current !== incomingNavigation;
  const [applied, setApplied] = useState<FinanceFilters>(() => saved?.applied ?? filtersFromTab(tab, period));
  const [draft, setDraft] = useState<FinanceFilters>(() => saved?.draft ?? filtersFromTab(tab, period));
  const [page, setPage] = useState(saved?.page ?? (Number(tab.query.page) > 0 ? Number(tab.query.page) : 1));
  const [pageSize, setPageSize] = useState(() => {
    const qSize = Number(tab.query.pageSize);
    return Number.isSafeInteger(qSize) && qSize > 0 ? qSize : (saved?.pageSize ?? 20);
  });
  const [read, setRead] = useState<{ identity: string; requestKey: string; body: FinanceResponse }>();
  const [error, setError] = useState<unknown>(), [nonce, setNonce] = useState(0), [advanced, setAdvanced] = useState(false);
  const [summary, setSummary] = useState<string>(), [notice, setNotice] = useState<string>(), [exporting, setExporting] = useState(false), [locatingPhone, setLocatingPhone] = useState(false), [inputError, setInputError] = useState<string>();
  const requestSequence = useRef(0), phoneController = useRef<AbortController | null>(null), exportController = useRef<AbortController | null>(null), snapshotRef = useRef(saved?.snapshot), previousRefresh = useRef(refreshNonce);
  const remembered = useRef<SavedView>(saved ?? { applied, draft, page, pageSize, scroll: 0 });
  const requestKey = JSON.stringify([tab.path, applied, page, pageSize, tab.query.entry ?? ""]);
  const body = !externalNavigationChanged && read?.identity === identity && read.requestKey === requestKey ? read.body : undefined;
  const hasPeriodReconciliation = Array.isArray(body?.reconciliation) && body.reconciliation.length > 0;
  const periodBasisKnown = hasPeriodReconciliation && body!.reconciliation!.every(row => row.balanceBasis?.knowledge === 'KNOWN');
  const periodBalancesKnown = periodBasisKnown && body!.reconciliation!.every(row => row.knowledge === 'KNOWN');
  const unverifiedPeriodRows = body?.reconciliation?.filter(row => row.knowledge !== 'KNOWN' || row.balanceBasis?.knowledge !== 'KNOWN') ?? [];
  const commonPeriodReasons = unverifiedPeriodRows.length > 1 ? periodReasonCodes(unverifiedPeriodRows[0]!).filter(reason => unverifiedPeriodRows.every(row => periodReasonCodes(row).includes(reason))) : [];
  const commonPeriodReasonTexts = [...new Set(commonPeriodReasons.map(label))];
  const settlementEvidence = body?.orderSettlement?.schema === 'admin-order-settlement-evidence.v1' && body.orderSettlement.documentRef === body.document?.ref ? body.orderSettlement : undefined;
  const channelOrders = (body?.related ?? []).filter(link => link.path?.startsWith('/orders/'));
  const channelOrder = channelOrders.length === 1 ? channelOrders[0] : undefined;
  const legacyChannel = channelOrder?.ref.startsWith('LEGACY_ORDER:') || body?.document?.orderLifecycle?.origin === 'LEGACY_MYSQL' || /^(LEGACY_ORDER|HISTORY_PAYMENT|HISTORY_REFUND):/.test(body?.document?.ref??'');
  const channelOrderId = !legacyChannel && channelOrder?.ref.startsWith('ORDER:') ? tabFromLocation(channelOrder.path!).objectId : undefined;
  const documentAllowed = has(snapshot, "finance.document.read");
  const active = snapshot.security.status === 'ACTIVE' && !snapshot.security.passwordChangeRequired && !snapshot.session.locked;
  const allowed = active && (documentId !== null ? documentAllowed : period ? has(snapshot, "finance.read") : has(snapshot, "finance.read") || documentAllowed);
  const needsLookup = !object && !period && !has(snapshot, "finance.read") && !applied.q.trim();
  remembered.current = { ...remembered.current, applied, draft, page, pageSize, snapshot: snapshotRef.current };
  function accessFailure(cause: unknown) {
    setRead(undefined); setSummary(undefined); snapshotRef.current = undefined; exportController.current?.abort(); cancelPhone();
    if (cause instanceof AdminApiError && [401, 403, 423].includes(cause.status)) {
      clearFinanceContexts(); window.dispatchEvent(new CustomEvent(FINANCE_ACCESS_FAILURE_EVENT)); void onRefresh().catch(() => undefined);
    }
  }
  useLayoutEffect(() => {
    if (previousNavigation.current === incomingNavigation) return;
    previousNavigation.current = incomingNavigation;
    if (ownNavigation.current === incomingNavigation) { ownNavigation.current = undefined; return; }
    ownNavigation.current = undefined; requestSequence.current++; snapshotRef.current = undefined; cancelPhone();
    exportController.current?.abort(); exportController.current = null; setExporting(false);
    const filters = filtersFromTab(tab, period), nextPage = /^[1-9]\d{0,5}$/.test(tab.query.page ?? "") ? Number(tab.query.page) : 1;
    const nextSize = /^[1-9]\d{0,3}$/.test(tab.query.pageSize ?? "") ? Number(tab.query.pageSize) : 20;
    remembered.current = { applied: filters, draft: filters, page: nextPage, pageSize: nextSize, scroll: 0 };
    setRead(undefined); setError(undefined); setSummary(undefined); setNotice(undefined);
    setApplied(filters); setDraft(filters); setPage(nextPage); setPageSize(nextSize);
  }, [incomingNavigation, period]);
  useEffect(() => {
    const clear = () => { clearFinanceContexts(); requestSequence.current++; setRead(undefined); setSummary(undefined); setError(undefined); snapshotRef.current = undefined; exportController.current?.abort(); cancelPhone(); };
    window.addEventListener(ADMIN_AUTH_FAILURE_EVENT, clear);
    return () => { window.removeEventListener(ADMIN_AUTH_FAILURE_EVENT, clear); exportController.current?.abort(); phoneController.current?.abort(); };
  }, []);
  useLayoutEffect(() => {
    const rememberScroll = () => { remembered.current.scroll = scroller()?.scrollTop ?? 0; };
    window.addEventListener("scroll", rememberScroll, true);
    return () => { window.removeEventListener("scroll", rememberScroll, true); if (currentIdentity === identity) savedViews.set(viewKey, { ...remembered.current }); };
  }, [identity, viewKey]);
  useEffect(() => {
    cancelPhone();
    const controller = new AbortController(), sequence = ++requestSequence.current;
    if (previousRefresh.current !== refreshNonce) { snapshotRef.current = undefined; previousRefresh.current = refreshNonce; }
    setRead(undefined); setError(undefined); setSummary(undefined); setNotice(undefined); exportController.current?.abort();
    if (!allowed || needsLookup || externalNavigationChanged) return () => controller.abort();
    const route = documentId ? `documents/${encodeURIComponent(documentId)}` : period ? "period" : "lookup";
    async function load() {
      const extras: Record<string, string> = { page: String(page), pageSize: String(pageSize), ...(tab.query.entry ? { entry: tab.query.entry } : {}) };
      if (!snapshotRef.current && page > 1 && !object) { const first = await financeRead(route, applied, controller.signal, { page: "1", pageSize: String(pageSize) }); if(controller.signal.aborted || sequence !== requestSequence.current || identity !== currentIdentity)return; snapshotRef.current = first.snapshot; }
      if (snapshotRef.current) extras.snapshot = snapshotRef.current;
      const value = await financeRead(route, applied, controller.signal, extras);
      if (controller.signal.aborted || sequence !== requestSequence.current || identity !== currentIdentity) return;
      snapshotRef.current = value.snapshot; remembered.current.snapshot = value.snapshot; setRead({ identity, requestKey, body: value });
    }
    void load().catch(cause => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      accessFailure(cause); setError(cause);
    });
    return () => controller.abort();
  }, [identity, applied, page, pageSize, period, documentId, tab.query.entry, refreshNonce, nonce, allowed, needsLookup, externalNavigationChanged]);
  useLayoutEffect(() => {
    if (!body) return;
    const container = scroller(); if (container) container.scrollTop = remembered.current.scroll;
    const focus = remembered.current.focus;
    if (focus) document.querySelector<HTMLElement>(`[data-finance-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }, [body]);
  const changed = JSON.stringify(applied) !== JSON.stringify(draft);
  function cancelPhone() { phoneController.current?.abort(); phoneController.current=null; setLocatingPhone(false); }
  const queryPath = (filters: FinanceFilters, targetPage = page, targetPageSize = pageSize) => `${tab.path}?${financeQuery(filters)}&page=${targetPage}&pageSize=${targetPageSize}${tab.query.origin ? `&origin=${encodeURIComponent(tab.query.origin)}` : ""}${tab.query.entry ? `&entry=${encodeURIComponent(tab.query.entry)}` : ""}`;
  function applyFilters(filters: FinanceFilters) {
    cancelPhone();
    snapshotRef.current = undefined; remembered.current.scroll = 0; remembered.current.focus = "finance-lookup";
    setRead(undefined); setApplied({ ...filters }); setDraft({ ...filters }); setPage(1); setNonce(value => value + 1);
    const nextQuery = { ...Object.fromEntries(financeQuery(filters)), page: "1", pageSize: String(pageSize) }; ownNavigation.current = navigationKey(tab, nextQuery); onQueryChange(nextQuery);
  }
  async function apply() {
    cancelPhone(); setInputError(undefined); setNotice(undefined);
    if (findPhoneClue(draft.scope)) { setInputError('主体需使用稳定用户ID；手机号请从资金查找入口进行授权定位。'); return; }
    const days = rangeDays(draft.from,draft.to);
    if (draft.period && !(days>0 && days<=367)) { setInputError('请选择完整有效的日期区间，单次最多367天。'); return; }
    const match = findPhoneClue(draft.q);
    if (!match) { applyFilters(draft); return; }
    if (!has(snapshot, 'user.directory.read') || !has(snapshot, 'user.phone.lookup') || !has(snapshot, 'finance.read')) {
      setInputError('手机号定位需要用户目录、手机号查找及完整资金读取权限。'); return;
    }
    if (!match.exact) { setInputError('检测到手机号，请仅输入完整手机号进行授权定位，不与其他线索混用。'); return; }
    phoneController.current?.abort();
    const controller = new AbortController(); phoneController.current = controller; setLocatingPhone(true);
    try {
      const navigation = incomingNavigation, sequence = requestSequence.current;
      const result = await new UserDirectoryBff(snapshot).list({ ...EMPTY_FILTERS, q: match.phone }, { page: 1, pageSize: 20 }, controller.signal);
      if (controller.signal.aborted || currentIdentity !== identity || phoneController.current!==controller || previousNavigation.current!==navigation || requestSequence.current!==sequence) return;
      if (result.rows.length !== 1) { setInputError(result.rows.length ? '手机号关联多个用户，请到用户管理核对。' : '没有找到该手机号对应的受权用户。'); return; }
      applyFilters({ ...draft, scope: result.rows[0]!.id, q: '' });
      setNotice('已按授权手机号定位到用户；手机号未进入资金查询地址或标签保存。');
    } catch (cause) { if (!controller.signal.aborted) { if (cause instanceof AdminApiError && [401,403,423].includes(cause.status)) accessFailure(cause); setInputError(friendlyError(cause)); } }
    finally { if (phoneController.current === controller) { phoneController.current = null; setLocatingPhone(false); } }
  }
  function shiftPeriod(direction: -1 | 1) {
    const first = Date.parse(`${applied.from}T00:00:00Z`), last = Date.parse(`${applied.to}T00:00:00Z`), days = rangeDays(applied.from,applied.to);
    if (!Number.isInteger(days) || days < 1 || days > 367) { setInputError('单次最多367天，请先选择有效的日期区间。'); return; }
    const offset = direction * days * 86400000;
    applyFilters({ ...applied, from: new Date(first + offset).toISOString().slice(0, 10), to: new Date(last + offset).toISOString().slice(0, 10) });
  }
  function retry() { snapshotRef.current = undefined; setError(undefined); setNonce(value => value + 1); remembered.current.focus = object ? "finance-title" : "finance-lookup"; }
  function open(path: string, title: string, focus: string) {
    remembered.current.focus = focus; remembered.current.scroll = scroller()?.scrollTop ?? 0; remembered.current.snapshot = snapshotRef.current;
    savedViews.set(viewKey, { ...remembered.current });
    const origin = crypto.randomUUID(); origins.set(origin, { path: queryPath(applied), parent: tab.query.origin });
    const target = new URL(path, window.location.origin), query = financeQuery(applied);
    target.searchParams.forEach((value,key)=>query.set(key,value)); query.set('origin',origin);
    const fallback = sanitizeFinanceReturn(tab.query.financeReturn) ?? sanitizeFinanceReturn(queryPath(applied));
    if (fallback) query.set('financeReturn',fallback);
    onOpenPath(`${target.pathname}?${query}`, title);
  }
  function back() {
    const path = financeOriginPath(tab.query.origin,snapshot,tab.query.financeReturn);
    onOpenPath(path ?? "/finance/records", path ? undefined : "资金记录");
  }
  function openAssociated(path: string, title?: string, focus = 'finance-title') {
    if (path.startsWith('/finance/')) { open(path, title ?? '关联资金记录', focus); return; }
    const origin = registerFinanceOrigin(queryPath(applied), identity);
    const fallback = sanitizeFinanceReturn(tab.query.financeReturn) ?? sanitizeFinanceReturn(queryPath(applied));
    onOpenPath(`${path}${path.includes('?') ? '&' : '?'}financeOrigin=${encodeURIComponent(origin)}${fallback?`&financeReturn=${encodeURIComponent(fallback)}`:''}`, title);
  }
  async function exportCsv() {
    if (!body || exporting) return;
    const controller = new AbortController(); exportController.current = controller; setExporting(true); setNotice(undefined);
    try {
      const receipt = await downloadFinanceCsv(body.applied, body.snapshot, controller.signal);
      if (controller.signal.aborted || identity !== currentIdentity) return;
      const href = URL.createObjectURL(receipt.blob), anchor = document.createElement("a"); anchor.href = href; anchor.download = receipt.fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
      setNotice(`已接收 ${receipt.rowCount ?? "全部"} 条并交浏览器下载。请求编号：${receipt.requestId ?? "未取得"}`);
    } catch (cause) { if (!controller.signal.aborted) { accessFailure(cause); setError(cause); } }
    finally { if (exportController.current === controller) { exportController.current = null; setExporting(false); } }
  }
  function documentPath(document: FinanceDocument, entry?: string) { return `/finance/documents/${encodeURIComponent(document.ref)}${entry ? `?entry=${encodeURIComponent(entry)}` : ""}`; }
  function changePage(next: number) {
    setRead(undefined); remembered.current.scroll = 0; remembered.current.focus = undefined; setPage(next);
    const query = { ...Object.fromEntries(financeQuery(applied)), page: String(next), pageSize: String(pageSize) };
    ownNavigation.current = navigationKey(tab, query); onQueryChange(query);
  }
  function changePageSize(nextSize: number) {
    setRead(undefined); remembered.current.scroll = 0; remembered.current.focus = undefined;
    setPageSize(nextSize); setPage(1);
    const query = { ...Object.fromEntries(financeQuery(applied)), page: "1", pageSize: String(nextSize) };
    ownNavigation.current = navigationKey(tab, query); onQueryChange(query);
  }
  async function copySummary() {
    if (!body?.document) return;
    const historical = body.document.historical;
    const relationVisible = historical?.association?.state === 'MATCHED' && !historicalRelationDenied(historical, has(snapshot, 'order.read'), documentAllowed);
    const text = [financeRecordNumber(body.document, body.document.number), `${financeDocumentLabel(body.document)} · ${recordState(body.document)} · ${financeEntryScope(body.document)}`, `截至：${financeTime(body.asOf)}`,
      ...(body.document.orderLifecycle && !settlementEvidence?.business ? [`${body.document.orderLifecycle.origin === 'NATIVE' ? '本站接纳付款' : '旧记录付款'}：${body.document.orderLifecycle.payment.state === 'REVIEW_REQUIRED' ? '异常收款需复核' : financeMoney(['SITE_ACCEPTED','LEGACY_RECORDED'].includes(body.document.orderLifecycle.payment.state) ? body.document.orderLifecycle.payment.amountCents : null)}`, `确认付款时间：${financeTime(body.document.orderLifecycle.payment.state === 'SITE_ACCEPTED' ? body.document.orderLifecycle.payment.confirmedAt : null)}`] : []),
      ...(body.document.parties ? [`号主：${body.document.parties.owner.name}`, `租客：${body.document.parties.renter.name}`] : []),
      ...(body.entries ?? []).map(entry => `${entry.subjectName} / ${financeIsHistorical(entry) ? historicalFinanceAmount(entry,entry.deltaCents) : `${bucketLabels[entry.bucket]}：${financeMoney(entry.deltaCents)}`}，${entryClass(entry)}，${entry.id}`),
      ...(historical ? ['历史记录不改变当前钱包；渠道未核。', ...historicalFinanceFacts(historical).map(([name, value]) => `${name}：${value}`), ...(relationVisible && historical.association.number ? [`关联业务号：${historical.association.number}`, ...(historical.association.kind==='WITHDRAWAL'?['已核证的提现申请与余额流水属于同一笔业务，金额不重复汇总。']:[])] : [])] : []),
      ...(settlementEvidence ? orderSettlementSummary(settlementEvidence) : []),
      ...visibleEvidence(body.evidence, historical, has(snapshot, 'order.read'), documentAllowed,settlementEvidence).filter(([, value]) => value !== null).map(([key, value]) => `${evidenceLabels[key]}：${evidenceValue(key, value, historical)}`),
      ...(body.reasonCodes ?? []).map(label), `快照：${body.snapshotVersion}`, ...(body.entries ?? []).map(entry => `来源：${entry.sourceType}/${entry.sourceSystem}/${entry.sourceEntity}/${entry.sourceId}${entry.sourceDigest ? ` / ${entry.sourceDigest}` : ""}`)].join("\n");
    setSummary(text); try { await navigator.clipboard.writeText(text); setNotice("摘要已复制"); } catch { setNotice("复制未完成，可从下方摘要选择复制"); }
  }
  const resultLimit = error instanceof AdminApiError && error.details.some(detail=>detail.path.startsWith("finance.matchingLimit")||detail.path.startsWith("finance.exportLimit"));
  const title = body?.document ? financeIsHistorical(body.document) ? financeDocumentLabel(body.document) : body.document.number : object ? "资金详情" : period ? "期间核对" : "资金查找";
  const withdrawal = body?.document?.kind === 'WITHDRAWAL' && !financeIsHistorical(body.document);
  const pagination = body && !object ? (
    <ListPagination
      mode="page"
      page={page}
      pageSize={pageSize}
      total={(period ? body.entryCount : body.documentCount) ?? 0}
      loadedCount={(period ? body.entries?.length : body.documents?.length) ?? 0}
      loading={false}
      pageSizeOptions={[10, 20, 50, 100]}
      itemLabel={period ? '条记录' : '份记录'}
      onPageChange={changePage}
      onPageSizeChange={changePageSize}
      className="mt-6"
    />
  ) : null;
  const historicalDetail = (historical: HistoricalFinanceDisplay | undefined, kind: string, focus: string, expanded = false) => <HistoricalFinanceDetail historical={historical} recordKind={kind} expanded={expanded} orderRead={has(snapshot, 'order.read')} documentRead={documentAllowed} onOpenPath={(path, name) => path.startsWith('/finance/documents/') ? open(path, name || '关联业务', focus) : openAssociated(path, name, focus)}/>;
  const candidates = (documents: FinanceDocument[]) => <div className="finance-candidates"><div className="finance-table">
    <Table className="finance-lookup-table" role="table" aria-label="业务与历史记录"><TableHeader><TableRow><TableHead scope="col">单号 / 业务</TableHead><TableHead scope="col">相关主体</TableHead><TableHead scope="col">业务进度 / 状态</TableHead><TableHead scope="col" className="numeric">金额</TableHead><TableHead scope="col">时间</TableHead><TableHead scope="col" className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>
      {documents.map(document => {
        const isOpening = document.kind === 'OPENING';
        const historical = financeIsHistorical(document);
        const displayLabel = !historical ? financeDocumentLabel(document) : document.historical?.amountSemantics==='UNVERIFIED' ? '历史来源待核' : financeIsHistoricalBalance(document) ? '历史余额变动' : '历史记录';
        const linkTitle = historical ? `${financeDocumentLabel(document)} · ${document.historical?.originalLogNumber || document.number}` : isOpening ? `期初承接凭证 (${document.subjects.map(s => s.name).join(' / ') || '主体'})` : financeRecordNumber(document, document.number);
        return <TableRow key={document.ref} role="row">
          <TableCell>
            <div className="flex items-center gap-2 mb-1">{kindBadge(document)}<span className="text-xs text-muted-foreground">{displayLabel}</span></div>
            <Button variant="link" className="finance-object-link p-0 h-auto font-medium text-sm leading-normal text-left" disabled={!documentAllowed} title={!documentAllowed?"需要单据资金读取能力":undefined} data-finance-focus={document.ref} onClick={() => open(documentPath(document), linkTitle, document.ref)}>{linkTitle}<ArrowUpRight size={13} className="shrink-0 ml-1 text-muted-foreground"/></Button>
            {historical ? <small className="block text-muted-foreground text-xs mt-1">{financeRecordNumber(document, document.number)}</small> : isOpening ? <small className="block font-mono text-[11px] text-muted-foreground/75 mt-0.5 truncate max-w-[280px]" title={document.number}>批次：{document.number}</small> : null}
          </TableCell>
          <TableCell data-label="相关主体"><span className="text-sm font-medium">{document.subjects.map(subject => subject.name).join(" / ")}</span></TableCell>
          <TableCell data-label="业务进度 / 状态"><div className="flex items-center text-sm">{statusDot(document.state)}<span>{recordState(document)}</span></div><small className="block text-muted-foreground text-xs mt-1">{financeEntryScope(document)}</small>{historicalDetail(document.historical, document.kind, document.ref)}</TableCell>
          <TableCell data-label="金额" className="numeric">
            {document.orderLifecycle && ['SITE_ACCEPTED', 'LEGACY_RECORDED'].includes(document.orderLifecycle.payment.state) ? <strong className="block text-sm">{financeMoney(document.orderLifecycle.payment.amountCents)}<small>{document.orderLifecycle.origin === 'NATIVE' ? '本站确认实付' : '旧单付款原记'}</small></strong> : null}
            {document.historical?.amountSemantics==='UNVERIFIED' ? <strong className="block text-sm">{historicalFinanceAmount(document,null)}</strong> : document.requestedAmountCents !== null ? <strong className="block text-sm">{historical ? '原申请 ' : ''}{financeMoney(document.requestedAmountCents)}</strong> : historical ? financeIsHistoricalBalance(document) ? document.amounts.map(amount => <strong key={amount.bucket} className="block text-sm">{historicalFinanceAmount(document,amount.unknownCount ? null : amount.knownNetCents)}</strong>) : document.historical ? <strong className="block text-sm">{historicalFinanceAmount(document,null)}</strong> : null : document.amounts.map(amount=><span key={amount.bucket} className="block text-xs text-muted-foreground">{bucketLabels[amount.bucket]??'科目未记录'} <strong className="text-sm text-foreground tabular-nums ml-1 font-semibold">{amount.unknownCount?'未记录':financeMoney(amount.knownNetCents)}</strong></span>)}
          </TableCell>
          <TableCell data-label="时间"><small className="text-xs text-muted-foreground block whitespace-nowrap">{financeTime(document.occurredAt)}</small></TableCell>
          <TableCell className="text-right"><Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs gap-1 hover:text-primary" disabled={!documentAllowed} title={!documentAllowed?"需要单据资金读取能力":undefined} onClick={() => open(documentPath(document), linkTitle, document.ref)}>查看<ArrowUpRight size={13} /></Button></TableCell>
        </TableRow>;
      })}
    </TableBody></Table>
  </div></div>;
  const entries = (lines: FinanceEntry[]) => <div className="finance-table"><Table className="entries-table"><TableHeader><TableRow><TableHead>用途 / 记录 / 主体</TableHead><TableHead>记录性质</TableHead><TableHead>状态 / 分类</TableHead><TableHead className="numeric">金额</TableHead><TableHead>核对</TableHead></TableRow></TableHeader><TableBody>{lines.map(entry => <TableRow key={entry.id}><TableCell><strong>{financeEntryEvent(entry)}</strong><span>{financeRecordNumber(entry, entry.documentNumber)}</span><span>{entry.subjectName}</span><small>{financeTime(entry.occurredAt)}</small>{historicalDetail(entry.historical, entry.kind, entry.id)}</TableCell><TableCell>{financeIsHistorical(entry) ? entry.historical?.amountSemantics==='UNVERIFIED' ? '历史来源待核' : financeIsHistoricalBalance(entry) ? '历史余额变动' : '历史业务记录' : accountLabels[entry.accountCode??''] ?? bucketLabels[entry.bucket] ?? "类别未记录"}<small>{entry.historical?.amountSemantics==='UNVERIFIED' ? "余额变动依据待核" : financeIsHistorical(entry) && !financeIsHistoricalBalance(entry) ? "不作为余额变动" : entry.classification === "LOCAL_SOURCE_WITHOUT_POSTING" ? "不计账内收支" : entry.direction === "IN" ? "增加" : entry.direction === "OUT" ? "减少" : "方向未记录"}</small>{financeIsHistorical(entry) ? <small>{entry.historical?.purposeCode === 'WITHDRAWAL_APPLICATION' ? '申请记录，不另计扣款' : '不改变当前钱包'}</small> : null}</TableCell><TableCell>{entry.kind === 'DISTRIBUTION' ? financeEntryEvent(entry) : recordState(entry)}{entry.kind === 'DISTRIBUTION' ? <small>当前收益状态：{recordState(entry)}</small> : null}<small>{entryClass(entry)}</small></TableCell><TableCell className="numeric"><strong className="amount">{financeIsHistorical(entry) ? historicalFinanceAmount(entry,entry.deltaCents) : entry.classification === "LOCAL_SOURCE_WITHOUT_POSTING" ? "尚未过账" : financeMoney(entry.deltaCents)}</strong></TableCell><TableCell><Button variant="ghost" size="sm" disabled={!documentAllowed} title={!documentAllowed?"需要单据资金读取能力":undefined} data-finance-focus={entry.id} onClick={() => open(`/finance/documents/${encodeURIComponent(entry.documentRef)}?entry=${encodeURIComponent(entry.id)}`, financeIsHistorical(entry) ? `${financeBusinessLabel(entry)} · ${entry.historical?.originalLogNumber || entry.documentNumber}` : entry.documentNumber, entry.id)}>查看<ArrowUpRight size={14} /></Button></TableCell></TableRow>)}</TableBody></Table></div>;

  const hasFilters = draft.q || draft.kind !== 'ALL' || draft.state !== 'ALL' || draft.bucket !== 'ALL' || draft.period;

  return <section className="finance-page" aria-labelledby="finance-title">
    <div className="finance-page-header"><h1 id="finance-title" tabIndex={-1} data-finance-focus="finance-title">{allowed ? title : "资金读取"}</h1><div className="finance-page-actions">{object ? <><Button variant="outline" onClick={back}>返回来源</Button><Button variant="outline" onClick={() => { snapshotRef.current = undefined; onOpenPath("/finance/records", "资金记录"); }}>重新查找</Button>{body?.document ? <Button variant="outline" className="primary" onClick={() => void copySummary()}><Copy size={15} />复制摘要</Button> : null}</> : null}{period ? <Button variant="outline" className="primary" disabled={!body || exporting || !!error} onClick={() => void exportCsv()}><Download size={15} />{exporting ? "正在生成" : "导出完整明细"}</Button> : null}</div></div>
    {!allowed ? <Alert variant="warning" role="status"><TriangleAlert aria-hidden /><AlertTitle>当前身份没有该项资金读取能力</AlertTitle><AlertDescription>{period ? "期间核对需要完整资金读取能力。" : "单据读取需要对应能力。"}</AlertDescription></Alert> : <>
      {!object ? <form className={period ? "finance-period-filter" : "finance-search-card"} onSubmit={event => { event.preventDefault(); void apply(); }}>
        {period ? <><label>主体<Input aria-label="主体" value={draft.scope === 'ALL' ? '' : draft.scope} onChange={event => setDraft({ ...draft, scope: event.target.value.trim() || 'ALL' })} placeholder="全部用户；或输入用户ID" /></label><FinanceDateRange from={draft.from} to={draft.to} onChange={(from,to)=>setDraft({...draft,from,to})}/></> : <>
          {/* 业务分类快速 Tab 栏 */}
          <div className="finance-kind-tabs" role="group" aria-label="业务分类">
            {quickKinds.map(item => (
              <button
                key={item.key}
                type="button"
                aria-pressed={draft.kind === item.key}
                className={`finance-kind-tab ${draft.kind === item.key ? 'active' : ''}`}
                onClick={() => {
                  const next = { ...draft, kind: item.key, state: 'ALL' };
                  applyFilters(next);
                }}
              >
                {item.label}
                {item.key === 'OPENING' ? <span className="finance-kind-subtag">存量</span> : null}
              </button>
            ))}
          </div>

          <label htmlFor="finance-lookup" className="sr-only">用户或业务单据</label>
          <div className="finance-search-line">
            <div className="finance-input-wrapper">
              <Search size={15} className="absolute left-3 text-muted-foreground pointer-events-none" />
              <Input
                id="finance-lookup"
                autoComplete="off"
                data-finance-focus="finance-lookup"
                value={draft.q}
                onChange={event => {
                  cancelPhone();
                  setDraft({ ...draft, q: event.target.value });
                  setInputError(undefined);
                }}
                placeholder="输入订单号、退款单号、提现单号、用户ID、昵称或授权手机号…"
                className="pl-9 pr-3 h-[38px] text-xs bg-transparent border-0 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button disabled={locatingPhone} type="submit" size="sm" className="h-[38px] px-4 gap-1.5 shrink-0">
              <Search size={14} />
              {locatingPhone ? '正在定位用户' : '查找'}
            </Button>
            <Button
              variant="outline"
              type="button"
              size="sm"
              aria-expanded={advanced}
              onClick={() => setAdvanced(value => !value)}
              className="h-[38px] px-3 gap-1.5 shrink-0"
            >
              <SlidersHorizontal size={14} />
              更多筛选
              <ChevronDown size={14} className={`transition-transform duration-200 ${advanced ? 'rotate-180' : ''}`} />
            </Button>
            {hasFilters ? (
              <Button
                variant="ghost"
                type="button"
                size="sm"
                onClick={() => {
                  const reset = defaultFinanceFilters(period);
                  applyFilters(reset);
                }}
                className="h-[38px] px-2.5 gap-1 text-muted-foreground hover:text-foreground text-xs shrink-0"
                title="重置所有筛选条件"
              >
                <RotateCcw size={13} />
                重置
              </Button>
            ) : null}
          </div>
        </>}
        {advanced ? (
          <div className="finance-advanced-panel">
            <div className="finance-advanced-field">
              <span className="finance-advanced-label">业务状态</span>
              <FinanceSelect label="业务状态" value={draft.state} options={getAvailableStates(draft.kind)} onChange={state => setDraft({ ...draft, state })} />
            </div>
            <div className="finance-advanced-field">
              <span className="finance-advanced-label">资金类别 (专审)</span>
              <FinanceSelect label="资金类别 (专审)" value={draft.bucket} options={{ ALL: '全部资金类别', ...(period ? bucketLabels : businessBucketLabels) }} onChange={bucket => setDraft({ ...draft, bucket })} />
            </div>
            {!period ? (
              <div className="finance-advanced-field">
                <span className="finance-advanced-label">时间范围</span>
                <div className="finance-period-toggle-box">
                  <Checkbox
                    id="finance-period-filter-checkbox"
                    checked={draft.period}
                    onCheckedChange={checked => setDraft({ ...draft, period: checked === true })}
                  />
                  <label htmlFor="finance-period-filter-checkbox">限定发生期间</label>
                </div>
              </div>
            ) : null}
            {!period && draft.period ? (
              <div className="finance-advanced-field sm:col-span-3">
                <span className="finance-advanced-label">发生日期范围（北京时间）</span>
                <FinanceDateRange from={draft.from} to={draft.to} onChange={(from, to) => setDraft({ ...draft, from, to })} />
              </div>
            ) : null}
          </div>
        ) : null}
        {period ? <><Button type="submit" data-finance-focus="finance-lookup">应用</Button><Button variant="outline" type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>更多条件<ChevronDown size={14}/></Button></> : null}{changed ? <p className="finance-draft-note" role="status">新条件尚未应用，结果和导出仍使用已应用范围。</p> : null}
        {(period || draft.period) ? <p className="finance-range-note">单次最多367天，可按段查看；分段结果独立核对，不自动拼接余额。</p> : null}
        {inputError ? <Alert variant="warning"><AlertTitle>查询条件需核对</AlertTitle><AlertDescription>{inputError}</AlertDescription></Alert> : null}
      </form> : null}
      {error ? <Alert variant={resultLimit || (error instanceof AdminApiError && error.status === 409) ? "warning" : "destructive"} role={resultLimit || (error instanceof AdminApiError && error.status === 409) ? "status" : "alert"}><CircleAlert aria-hidden /><AlertTitle>{resultLimit ? "当前匹配结果过多" : error instanceof AdminApiError && error.status === 409 ? "本批数据已变化" : "资金读取暂不可用"}</AlertTitle><AlertDescription>{resultLimit ? "请缩小主体、期间或业务条件后应用。当前结果超过有界读取或文件上限，未返回截断文件。" : error instanceof AdminApiError && error.status === 409 ? "请重新查询，避免拼接两个时点。" : friendlyError(error)}</AlertDescription><AlertAction><Button variant="outline" onClick={retry}>重新查询</Button></AlertAction></Alert> : needsLookup ? <div className="finance-empty"><h2>输入单据编号或用户线索</h2><p>查找后选择要核对的单据。</p></div> : !body ? <div className="finance-loading" role="status" aria-busy="true"><p>正在读取资金依据…</p><Skeleton className="h-10 w-64"/><Skeleton className="h-28 w-full"/><Skeleton className="h-28 w-full"/></div> : <>
        <div className="finance-applied"><strong>{object ? body.document ? financeDocumentLabel(body.document) : "当前对象" : period ? body.applied.scope === "ALL" ? "全平台" : `主体 ${body.applied.scope}` : "已应用线索"}</strong><span>{!object && body.applied.period ? `${body.applied.from} 至 ${body.applied.to} · 北京时间` : !object ? `${body.applied.kind !== 'ALL' ? (quickKinds.find(k => k.key === body.applied.kind)?.label ?? body.applied.kind) + ' · ' : ''}${body.applied.q.replace(/^ORDER_LINK:/,"订单链接 · ") || "最近业务"}${body.applied.state !== 'ALL' ? ` · 状态: ${stateLabels[body.applied.state] ?? body.applied.state}` : ''}` : body.document ? `${recordState(body.document)} · ${body.document.entryCount ?? 0} 条${financeIsHistorical(body.document) ? '历史记录' : '分录'}${body.document.subjects.length ? ` · ${body.document.subjects.map(subject => subject.name).join(" / ")}` : ""}` : `${body.documents?.length ?? 0} 张关联单据`}</span><small>数据截止 {financeTime(body.asOf)}</small></div>
        {!object && !period ? <>{body.subjects?.length ? <section><h2>用户候选</h2><div className="finance-user-candidates">{body.subjects.map(subject => <Button variant="outline" key={subject.id} data-finance-focus={subject.id} onClick={() => open(`/finance/users/${encodeURIComponent(subject.id)}`, subject.name, subject.id)}>{subject.name}<ArrowUpRight size={14} /></Button>)}</div></section> : null}<h2>业务与历史记录</h2>{['ALL','WITHDRAWAL'].includes(body.applied.kind) ? <p className="finance-secondary">旧提现按已核证关联合并为一笔业务；未核证或无关联查看权限的记录独立列出。原流水号仍可查，金额不应重复相加。</p> : null}{body.documents?.length ? candidates(body.documents) : <div className="finance-empty"><h2>没有匹配单据</h2><p>可核对编号或调整查询条件。未入账的渠道申请可在全部业务、全部状态下按精确原号查找。</p></div>}{pagination}</> : null}
        {period ? <><section className="finance-reconciliation">
          <div className="finance-section-heading"><h2>期间账内合计与余额证明</h2><div className="finance-page-actions"><Button variant="outline" size="sm" onClick={()=>shiftPeriod(-1)}>上一期间</Button><Button variant="outline" size="sm" onClick={()=>shiftPeriod(1)}>下一期间</Button></div></div>
          <div className="finance-status-chips flex flex-wrap items-center gap-2 mb-3">
            <span className="finance-chip bg-muted text-muted-foreground border border-border px-2.5 py-1 rounded text-xs font-medium">{hasPeriodReconciliation ? '账内汇总已读取' : '账内汇总未取得'}</span>
            {periodBasisKnown ? (
              <span className="finance-chip bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded text-xs font-medium">期初依据已取得</span>
            ) : (
              <span className="finance-chip bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-2.5 py-1 rounded text-xs font-medium">期初依据未确认</span>
            )}
            <span className="finance-chip bg-muted text-muted-foreground border border-border px-2.5 py-1 rounded text-xs font-medium">外部渠道未对账 —</span>
          </div>
          <Alert variant="warning" role="status"><TriangleAlert aria-hidden /><AlertTitle>{periodBalancesKnown ? '已入账范围的期间核对' : hasPeriodReconciliation ? '部分期间余额依据未确认' : '期间余额依据未取得'}</AlertTitle><AlertDescription><p>已知增加和减少仅反映已入账事实；账内算术一致不等于历史资金或渠道到账均已核清。</p><p>未取得所选时点的期初依据时，期初、期末及核对差额保持未知；历史观察不重复计入余额。</p>{commonPeriodReasonTexts.map(reason=><p key={reason}>未核类别共同原因：{reason}。</p>)}</AlertDescription></Alert>
          <p className="finance-secondary">以下为已入账范围的账内合计；已核余额证明另列。渠道／银行外部差异：未取得对账依据，未计算。</p>
          <div className="finance-table">
            <div className="finance-reconciliation-formula-note text-xs text-muted-foreground mb-2">
              <span>逐行复算公式：<strong>账内期初 + 承接入账 + 日常增加 − 本期减少 = 账内期末</strong>（差额 0.00 元表示该行起止余额与变动算术一致）</span>
            </div>
            <Table className="reconciliation-table"><TableHeader><TableRow><TableHead>资金类别</TableHead><TableHead>账内期初</TableHead><TableHead>承接入账（迁移）</TableHead><TableHead>日常增加</TableHead><TableHead>本期减少</TableHead><TableHead>账内期末</TableHead><TableHead>账内差额</TableHead><TableHead>外部对账</TableHead></TableRow></TableHeader><TableBody>{body.reconciliation?.map(row=>{
            const proved=row.knowledge==='KNOWN' && row.balanceBasis?.knowledge==='KNOWN';
            const rowReasons=periodReasonCodes(row).filter(reason=>!commonPeriodReasons.includes(reason));
            return <TableRow key={row.bucket}><TableCell><strong>{bucketLabels[row.bucket]}</strong><small>{bucketNature[row.bucket]}</small><Badge variant={proved?'secondary':'warning'}>{proved?'余额依据已取得':'余额依据未确认'}</Badge>{!proved && (rowReasons.length || !commonPeriodReasons.length) ? <small className="text-xs text-amber-500/90 dark:text-amber-400/90 block mt-1">{rowReasons.length ? [...new Set(rowReasons.map(label))].join('；') : '余额依据尚未取得完整信息'}</small> : null}<span className="finance-mobile-verdict">账内差额 {financeMoney(row.ledgerDifference)}</span></TableCell><TableCell data-label="账内期初">{financeMoney(row.ledgerOpeningBalance)}<small>已核余额 {financeMoney(proved?row.openingBalance:null)}</small></TableCell><TableCell data-label="承接入账">{financeMoney(row.migrationMovement)}<small>历史迁移入账</small></TableCell><TableCell data-label="日常增加">{financeMoney(row.knownInflows)}<small>本期正常流入</small></TableCell><TableCell data-label="本期减少">{financeMoney(row.knownOutflows)}<small>{row.unknownCount} 条金额未记录</small></TableCell><TableCell data-label="账内期末">{financeMoney(row.ledgerClosingBalance)}<small>已核余额 {financeMoney(proved?row.closingBalance:null)}</small></TableCell><TableCell data-label="账内差额">{financeMoney(row.ledgerDifference)}<small>已核差额 {financeMoney(proved?row.difference:null)}</small></TableCell><TableCell data-label="外部对账"><span className="text-muted-foreground text-xs">未取得渠道账单</span><small>未对账</small></TableCell></TableRow>;
          })}</TableBody></Table></div>
          <FinanceDisclosure title="账内算术、余额依据与缺项" className="finance-period-basis"><ul>{body.gaps?.map(reason=><li key={reason}>{label(reason)}</li>)}</ul>{body.reconciliation?.map(row=><div key={row.bucket} className="finance-basis-row"><h3>{bucketLabels[row.bucket]}</h3><p>账内起始 {financeMoney(row.ledgerOpeningBalance)} · 账内期末 {financeMoney(row.ledgerClosingBalance)} · 账内差额 {financeMoney(row.ledgerDifference)}</p><p>余额依据：{row.balanceBasis?.knowledge==='KNOWN'?'已取得':'未记录'} · 历史来源截止 {financeTime(row.balanceBasis?.sourceCutoff)} · 新账承接入账 {financeTime(row.balanceBasis?.openingPostedAt)}</p><p>历史已覆盖 {row.coveredHistoricalCount} 条，未覆盖 {row.uncoveredHistoricalCount} 条，事实时间未定 {row.unknownTimeCount} 条。覆盖笔数不代替期初余额证明。</p>{[...new Set([...(row.reasonCodes??[]),...(row.balanceBasis?.reasonCodes??[])])].map(reason=><p key={reason}>{label(reason)}</p>)}</div>)}</FinanceDisclosure>
        </section><h2>资金明细</h2>{body.entries?.length?entries(body.entries):<div className="finance-empty">该生效范围没有资金分录。</div>}{pagination}</> : null}
        {body.document ? <>
          <div className="finance-detail-layout"><div>
            {body.document.historical?.amountSemantics==='UNVERIFIED' ? <h2 className="finance-document-result">记录金额待核实</h2> : !withdrawal && !settlementEvidence?.business && body.document.requestedAmountCents !== null ? <h2 className="finance-document-result">{financeIsHistorical(body.document) ? '原申请 ' : '申请 '}{financeMoney(body.document.requestedAmountCents)}</h2> : null}
            {historicalDetail(body.document.historical, body.document.kind, body.document.ref, true)}
            {!settlementEvidence?.business ? <FinanceOrderPayment document={body.document}/> : null}
            {settlementEvidence ? <AdminOrderSettlementEvidence evidence={settlementEvidence} onOpenDocument={(ref,title)=>open('/finance/documents/'+encodeURIComponent(ref),title??'责任资金依据',ref)}/> : null}
            <FinanceOrderCosts body={body}/>
            {withdrawal ? <WithdrawalEvidence document={body.document} evidence={body.evidence} entries={body.entries}/> : body.document.historical ? <Collapsible><CollapsibleTrigger render={<Button variant="ghost" size="sm"/>}>原始来源字段<ChevronDown aria-hidden size={12}/></CollapsibleTrigger><CollapsibleContent><dl className="finance-fact-list">{visibleEvidence(body.evidence, body.document.historical, has(snapshot, 'order.read'), documentAllowed,settlementEvidence).map(([key, value]) => <div key={key}><dt>{evidenceLabels[key]}</dt><dd>{evidenceValue(key, value, body.document?.historical)}</dd></div>)}</dl></CollapsibleContent></Collapsible> : <dl className="finance-fact-list">{visibleEvidence(body.evidence, undefined, has(snapshot, 'order.read'), documentAllowed,settlementEvidence).filter(([key])=>!technicalEvidenceKeys.has(key)).map(([key, value]) => <div key={key}><dt>{evidenceLabels[key]}</dt><dd>{evidenceValue(key, value)}</dd></div>)}</dl>}
            {!body.document.historical?<FinanceDisclosure title="技术引用与原始字段"><dl className="finance-fact-list">{visibleEvidence(body.evidence,undefined,has(snapshot,'order.read'),documentAllowed,settlementEvidence).filter(([key])=>technicalEvidenceKeys.has(key)&&(!withdrawal||!['settlementVersionId','paymentConfirmationId','originalOrderId','ownerSubjectId','renterSubjectId','accountId','legacyAccountId'].includes(key))).map(([key,value])=><div key={key}><dt>{evidenceLabels[key]}</dt><dd>{evidenceValue(key,value)}</dd></div>)}</dl></FinanceDisclosure>:null}
            {body.document.kind==='DISTRIBUTION'?<section className="finance-frozen-basis"><h2>冻结计佣依据</h2>{body.distributionCalculation?.knowledge==='KNOWN'?<dl className="finance-fact-list"><div><dt>政策版本</dt><dd>{body.distributionCalculation.policyVersion??'未取得'}</dd></div><div><dt>冻结等级</dt><dd>{body.distributionCalculation.levelCode??'未取得'}</dd></div><div><dt>冻结比例</dt><dd>{body.distributionCalculation.percent===null?'未取得':`${body.distributionCalculation.percent}%`}</dd></div><div><dt>计佣基数</dt><dd>{financeMoney(body.distributionCalculation.baseCents)}</dd></div><div><dt>基数与算式</dt><dd>{body.distributionCalculation.formula==='FINAL_PLATFORM_CONTRIBUTION_MINUS_COMPENSATION_FEE'?'原结算平台分项 − 包赔费用（不是净利润）':body.distributionCalculation.formula??'未取得'}</dd></div></dl>:<Alert variant="warning" role="status"><TriangleAlert aria-hidden /><AlertTitle>冻结计佣依据未记录</AlertTitle><AlertDescription>原版本、等级、比例或基数未取得完整证据；不使用当前政策反推历史。{body.distributionCalculation?.reasonCodes.map(reason=><p key={reason}>{label(reason)}</p>)}</AlertDescription></Alert>}</section>:null}
            {body.reasonCodes?.map(reason => <p key={reason}>{label(reason)}</p>)}
            <FinanceDisclosure className="finance-help" title="资金来源与版本">{body.entries?.map(entry => <p key={entry.id}>{entry.id} · {sourceFamilyText(entry)} · {entry.sourceId}<br />{entryClass(entry)} · 采集 {financeTime(entry.importedAt)}<br />{entry.sourceDigest}</p>)}</FinanceDisclosure>
          </div><aside className="finance-related"><h2>关联</h2>
            {body.document.subjects.filter(subject => subject.id !== "PLATFORM" && subject.id !== "SYSTEM" && has(snapshot, "finance.read")).map(subject => <Button variant="outline" key={subject.id} data-finance-focus={`user:${subject.id}`} onClick={() => open(`/finance/users/${encodeURIComponent(subject.id)}`, subject.name, `user:${subject.id}`)}>{subject.name}<ArrowUpRight size={14} /></Button>)}
            {body.related?.filter(link => !settlementEvidence?.dutyRefs.some(duty=>duty.documentRef===link.ref) && (!body.document?.historical || body.document.historical.association?.state === 'MATCHED' && !historicalRelationDenied(body.document.historical, has(snapshot, 'order.read'), documentAllowed)) && (!link.path || (link.path.startsWith("/orders/") ? has(snapshot, "order.read") : link.path.startsWith('/finance/documents/') ? documentAllowed : has(snapshot, "supply.rental_account.read")))).map(link => <Button variant="outline" key={link.ref+(link.path??"")} data-finance-focus={link.ref} onClick={() => link.path ? link.path.startsWith('/finance/documents/') ? open(link.path,link.label,link.ref) : openAssociated(link.path,link.label,link.ref) : open("/finance/documents/"+encodeURIComponent(link.ref),link.label,link.ref)}>{link.label}<ArrowUpRight size={14} /></Button>)}
            {channelOrderId && (snapshot.security.isBoss || has(snapshot, 'order.read')) && has(snapshot, 'finance.read') ? <Button variant="outline" onClick={() => open('/finance/channels?' + new URLSearchParams({fromOrderId:channelOrderId}), '汇聚对账', 'finance-title')}>在汇聚对账查看本单<ArrowUpRight aria-hidden size={14}/></Button> : null}
            {legacyChannel ? <p className="finance-secondary">旧渠道依据尚未接入，渠道情况需另行核对。</p> : null}
          </aside></div><FinanceDisclosure key={'entries:'+(tab.query.entry??'')} title={financeIsHistorical(body.document) ? '相关历史记录' : `凭证分录${body.entries ? `（${body.entries.length} 条）` : ''}`} defaultOpen={Boolean(tab.query.entry)}>{body.entries ? entries(body.entries) : <p>本次未取得分录，不能按零处理。</p>}</FinanceDisclosure>
        </> : null}
        {summary && body.document ? <Textarea className="finance-copy-box" aria-label="核对摘要" readOnly value={summary} rows={10} /> : null}
      </>}
      {notice ? <p role="status" className="finance-notice">{notice}</p> : null}
    </>}
  </section>;
}
