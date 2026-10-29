import { readOrderPaymentSummary, type ChannelPaymentReadOptions } from "./channel-payment-read";
import { readAdminOrderRefundSummary } from '../finance/channel-finance-read';
import type { PoolClient } from "pg";
import { gameScopeSql } from "../auth/admin-scope";
import { projectOrder, orderHasPaidState, centsToYuan, yuanToCents, type OrderRow } from "./order";
import { orderAccountTitleFact } from "../supply/publishing";
import { projectPublicAttributeDisplay } from "../supply/listing-query";
import { frozenResourceLines } from "./frozen-listing-read";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { escapeLike } from "../supply/catalog";
import { legacyContinuationReady, legacyMoneyCents, legacyOrderReadState, LEGACY_ORDER_STATUS_SQL } from "./legacy-order-read";
import { formatDecimalExact, parseNonNegativeDecimal } from "../supply/decimal";
import { settlementConfirmationReady, type SettlementConfirmationFacts } from "./settlement";
import { readDirectoryUserSummaries, type DirectoryUserSummary } from "../auth/user-directory-summary";
import { legacyUserOrderResources } from "./legacy-user-order-read";

export type OrderReadViewer = { adminId: string; isBoss: boolean; internalQuote: boolean; authorizationKey: string; financeReadable?: boolean; permissions?: ReadonlySet<string> };
export type OrderReadFilters = { page: number; pageSize: number; status?: string; origin?: "NATIVE" | "LEGACY"; displayNo?: string; accountId?: string; renterUserId?: string; ownerUserId?: string; createdFrom?: string; createdTo?: string; qKind?: "order" | "account" | "party" | "renter" | "owner"; qValue?: string; restoreKey?: string; view?: "list" };
/** Strict source filter: omitted means both; repeated or unknown values are rejected, never coerced. */
export function parseOrderOrigin(query: URLSearchParams): "NATIVE" | "LEGACY" | undefined {
 const values = query.getAll("origin");
 if (values.length > 1) throw invalid("Origin is repeated", "origin");
 if (!values.length) return undefined;
 if (values[0] !== "NATIVE" && values[0] !== "LEGACY") throw invalid("Origin is invalid", "origin");
 return values[0];
}
const utc=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CONTINUATION_JOIN = `LEFT JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.superseded_at IS NULL`;
/** Pre-0074 shape: same output columns, no continuation source (see api-change-request.md). */
const ABSENT_CONTINUATION_JOIN = `LEFT JOIN (SELECT NULL::text AS order_id,NULL::int AS stage) h ON h.order_id=l.id`;
const CONTINUATION_COMPLETED_AT = `COALESCE((SELECT created_at FROM zzsh_order.legacy_continuation_version WHERE order_id=l.id AND command='CONFIRM' ORDER BY revision DESC LIMIT 1),l.source_completed_at)`;

// Both sources are filtered and sorted together, before counting or pagination.
/** The relation's shapes share these column fragments: the head (identity,
 *  ordering and filter keys), the filter columns (names, usernames and old
 *  numbers) and the record (the JSON projection the admin list returns). */
const NATIVE_HEAD = `o.id,o.created_at,o.game_id,o.owner_user_id,o.renter_user_id,o.account_id,o.display_no,o.status`;
const LEGACY_HEAD = `l.id,l.source_created_at,l.game_id,l.owner_user_id,l.renter_user_id,l.account_id,l.original_order_no`;
const NATIVE_FILTER = `a.display_no AS account_no,NULL::text AS renter_no,NULL::text AS owner_no,ou.name AS owner_name,ru.name AS renter_name,ou.username AS owner_username,ru.username AS renter_username,'NATIVE'::text AS origin,NULL::text AS legacy_account_no`;
// 旧单迁入后账号即新平台账号：账号检索列用 ZZ 编号，旧编号单列仅供检索
const LEGACY_FILTER = `a.display_no,l.legacy_renter_no,l.legacy_owner_no,ou.name,ru.name,ou.username,ru.username,'LEGACY'::text,l.legacy_account_no`;
const NATIVE_RECORD = `to_jsonb(o)||jsonb_build_object('rental_amount_cents',o.rental_amount_cents::text,'deposit_amount_cents',o.deposit_amount_cents::text,
    'term_seconds',o.term_seconds::text,'revision',o.revision::text,'created_at',${utc('o.created_at')},'hold_until',${utc('o.hold_until')},'paid_at',${utc('o.paid_at')},'cancelled_at',${utc('o.cancelled_at')},
    'native_payment_record',(SELECT jsonb_build_object('id',p.id,'order_id',p.order_id,'source',p.source,'disposition',p.disposition,
      'amount_cents',p.amount_cents::text,'currency',p.currency) FROM zzsh_order.payment_confirmation p
      WHERE p.id=o.paid_confirmation_id AND p.order_id=o.id AND p.disposition='APPLIED'),
    'owner_name',ou.name,'renter_name',ru.name,'account_no',a.display_no,'expired',o.status='PENDING_PAYMENT' AND o.hold_until<=clock_timestamp(),
    'dispatch_state',g.provision_state,'wait_reason',g.wait_reason,'assigned_at',${utc('g.assigned_at')},'team_state',g.team_state,
    'first_response_at',to_jsonb(g)->>'first_response_at','remind_due_at',to_jsonb(g)->>'remind_due_at',
    'add_round',COALESCE((to_jsonb(g)->>'add_round')::int,0),'escalation_state',COALESCE(to_jsonb(g)->>'escalation_state','NOT_STARTED'))`;
const LEGACY_RECORD = (continuationReady: boolean) => `to_jsonb(l)||jsonb_build_object('due_amount_cents',l.due_amount_cents::text,'recorded_paid_amount_cents',l.recorded_paid_amount_cents::text,'deposit_amount_cents',l.deposit_amount_cents::text,
    'source_created_at',${utc('l.source_created_at')},'source_paid_at',${utc('l.source_paid_at')},'source_cancelled_at',${utc('l.source_cancelled_at')},'source_completed_at',${utc(continuationReady ? CONTINUATION_COMPLETED_AT : "l.source_completed_at")},
    'continuation_stage',h.stage,
    'owner_name',ou.name,'renter_name',ru.name,'account_no',a.display_no)`;

/** Restricts one source branch to its own ids; the values are the caller's
 *  parameter placeholders, so the same relation serves the page read and the
 *  single-order read. */
export type OrderReadRestriction = { nativeIds?: string; legacyIds?: string; participantUserId?: string };

function orderReadSql(continuationReady: boolean, nativeColumns: string, legacyColumns: string, restrict?: OrderReadRestriction): string {
 const where = (alias: string, ids?: string) => {
  const predicates = [ids && `${alias}.id=ANY(${ids}::text[])`, restrict?.participantUserId && `(${alias}.owner_user_id=${restrict.participantUserId} OR ${alias}.renter_user_id=${restrict.participantUserId})`].filter(Boolean);
  return predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
 };
 return `
 SELECT ${nativeColumns}
  FROM zzsh_order.rental_order o JOIN zzsh_auth_user."user" ou ON ou.id=o.owner_user_id
  JOIN zzsh_auth_user."user" ru ON ru.id=o.renter_user_id JOIN zzsh_supply.rental_account a ON a.id=o.account_id
  LEFT JOIN zzsh_order.im_order_group g ON g.order_id=o.id${where('o',restrict?.nativeIds)}
 UNION ALL
 SELECT ${legacyColumns}
  FROM zzsh_order.legacy_order_read_snapshot l JOIN zzsh_auth_user."user" ou ON ou.id=l.owner_user_id
  ${continuationReady ? CONTINUATION_JOIN : ABSENT_CONTINUATION_JOIN}
  JOIN zzsh_auth_user."user" ru ON ru.id=l.renter_user_id JOIN zzsh_supply.rental_account a ON a.id=l.account_id
  LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id${where('l',restrict?.legacyIds)}`; }

export function orderReadRelation(continuationReady: boolean, summaryOnly = false, restrict?: OrderReadRestriction): string {
 return orderReadSql(continuationReady,
  NATIVE_HEAD + (summaryOnly ? "" : `,${NATIVE_FILTER},${NATIVE_RECORD} AS record`),
  LEGACY_HEAD + "," + LEGACY_ORDER_STATUS_SQL + (summaryOnly ? "" : `,${LEGACY_FILTER},${LEGACY_RECORD(continuationReady)} AS record`),
  restrict);
}
/** The same rows and the same filter columns without the record projection.
 *  Authorization, filtering, counting and key selection run on this relation;
 *  only the page's own keys are read again for their full record. */
export function orderReadKeyRelation(continuationReady: boolean, restrict?: OrderReadRestriction): string {
 return orderReadSql(continuationReady, NATIVE_HEAD + "," + NATIVE_FILTER, LEGACY_HEAD + "," + LEGACY_ORDER_STATUS_SQL + "," + LEGACY_FILTER,restrict);
}
function money(value:unknown){return typeof value==='string'?centsToYuan(value):null;}
type PrepaymentBreakdown = {
 basis:'NATIVE_FROZEN_ORDER_QUOTE'|'LEGACY_ORIGINAL_ORDER';completeness:'COMPLETE'|'PARTIAL'|'UNKNOWN';
 haffRental:ReturnType<typeof centsToYuan>|null;materialsPrepay:ReturnType<typeof centsToYuan>|null;
};
function prepaymentCents(value:unknown):bigint{
 if(!value||typeof value!=='object'||Array.isArray(value)||!('amount' in value)||typeof value.amount!=='string')throw invalid('Frozen prepayment amount is invalid');
 return yuanToCents(value as ReturnType<typeof centsToYuan>,'Frozen prepayment amount');
}
function nativePrepaymentBreakdown(r:Record<string,any>,amounts:any):PrepaymentBreakdown{
 const unknown:PrepaymentBreakdown={basis:'NATIVE_FROZEN_ORDER_QUOTE',completeness:'UNKNOWN',haffRental:null,materialsPrepay:null},quote=r.quote_snapshot;
 if(r.currency!=='CNY'||quote?.currency!=='CNY'||!Array.isArray(quote.lines)||!quote.lines.length)return unknown;
 try{
  const ids=new Set<string>();let haff:bigint|null=null,materials=0n;
  for(const line of quote.lines){
   if(!line||typeof line.itemId!=='string'||!line.itemId.trim()||ids.has(line.itemId))return unknown;
   ids.add(line.itemId);
   const isHaff=line.pricingKind==='HAFF_RATIO'&&line.unit==='HAFF_BASE';
   if(!isHaff&&!(line.pricingKind==='FIXED_UNIT'&&['ROUND','PIECE','DAY'].includes(line.unit)))return unknown;
   const amount=prepaymentCents(line.buyerAmount);
   if(isHaff){if(haff!==null)return unknown;haff=amount;}else materials+=amount;
  }
  const resource=prepaymentCents(quote.resourceTotal),deposit=prepaymentCents(quote.tenantDeposit);
  if(haff===null||haff+materials!==resource||resource!==prepaymentCents(amounts.rental)
   ||deposit!==prepaymentCents(amounts.deposit)||resource+deposit!==prepaymentCents(amounts.totalDue))return unknown;
  return {...unknown,completeness:'COMPLETE',haffRental:centsToYuan(haff),materialsPrepay:centsToYuan(materials)};
 }catch{return unknown;}
}
function legacyPrepaymentPart(value:unknown):{cents:string|null;invalid:boolean}{
 try{return {cents:legacyMoneyCents(value),invalid:false};}catch{return {cents:null,invalid:true};}
}
function legacyPrepaymentBreakdown(goods:ReturnType<typeof legacyPrepaymentPart>,items:ReturnType<typeof legacyPrepaymentPart>):PrepaymentBreakdown{
 const unknown:PrepaymentBreakdown={basis:'LEGACY_ORIGINAL_ORDER',completeness:'UNKNOWN',haffRental:null,materialsPrepay:null};
 if(goods.invalid||items.invalid||(goods.cents!==null&&BigInt(goods.cents)<0n)||(items.cents!==null&&BigInt(items.cents)<0n))return unknown;
 return {...unknown,completeness:goods.cents!==null&&items.cents!==null?'COMPLETE':goods.cents!==null||items.cents!==null?'PARTIAL':'UNKNOWN',
  haffRental:goods.cents===null?null:centsToYuan(goods.cents),materialsPrepay:items.cents===null?null:centsToYuan(items.cents)};
}
/** 合计核对投影（附加字段）：completeness 仍只表示分项是否齐全，不代表合计闭合。
 *  原生：冻结报价行逐项相加与本单合计/押金一致才为 RECONCILED。
 *  旧单：只做原单记录的整数分算术比对，结果仅 MATCH/MISMATCH/UNKNOWN，永不标为已闭合。 */
export type PrepaymentReconciliation={
 state:'RECONCILED'|'MISMATCH'|'NOT_VERIFIED';
 basis:'NATIVE_FROZEN_QUOTE_CLOSURE'|'LEGACY_RECORD_ARITHMETIC'|'INSUFFICIENT_FACTS';
 arithmetic:'MATCH'|'MISMATCH'|'UNKNOWN';closed:boolean;
};
function nativeReconciliation(breakdown:PrepaymentBreakdown):PrepaymentReconciliation{
 return breakdown.completeness==='COMPLETE'
  ?{state:'RECONCILED',basis:'NATIVE_FROZEN_QUOTE_CLOSURE',arithmetic:'MATCH',closed:true}
  :{state:'NOT_VERIFIED',basis:'INSUFFICIENT_FACTS',arithmetic:'UNKNOWN',closed:false};
}
const CENTS=/^-?(0|[1-9]\d{0,30})$/;
function legacyReconciliation(goods:ReturnType<typeof legacyPrepaymentPart>,items:ReturnType<typeof legacyPrepaymentPart>,depositCents:unknown,dueCents:unknown):PrepaymentReconciliation{
 const unknown:PrepaymentReconciliation={state:'NOT_VERIFIED',basis:'INSUFFICIENT_FACTS',arithmetic:'UNKNOWN',closed:false};
 // 任一项缺失或格式异常都保持未知，不把缺项当 0，也不从合计倒推分项。
 if(goods.invalid||items.invalid||goods.cents===null||items.cents===null||BigInt(goods.cents)<0n||BigInt(items.cents)<0n)return unknown;
 if(typeof depositCents!=='string'||!CENTS.test(depositCents)||typeof dueCents!=='string'||!CENTS.test(dueCents))return unknown;
 const match=BigInt(goods.cents)+BigInt(items.cents)+BigInt(depositCents)===BigInt(dueCents);
 return {state:match?'NOT_VERIFIED':'MISMATCH',basis:'LEGACY_RECORD_ARITHMETIC',arithmetic:match?'MATCH':'MISMATCH',closed:false};
}
/** 旧单原单资源：复用 legacyUserOrderResources 的字段与校验；单位未记录时保持 null，不猜测 M。 */
const LEGACY_RESOURCE_RAW_KEYS=[["expend_haff","expendHaff"],["awm_bullet_num","awmBulletNum"],["level6_bullet_num","level6BulletNum"],["level6_helmet_num","level6HelmetNum"],["level6_armor_num","level6ArmorNum"],["top_insure_card_num","topInsureCardNum"],["barrett_bullet_num","barrettBulletNum"],["coffee_num","coffeeNum"]] as const;
const LEGACY_RESOURCE_NAMES:Record<string,string>={df_billable_haff:"哈夫币",df_billable_awm_bullet:"AWM子弹",df_billable_level6_bullet:"6级子弹",df_billable_level6_helmet:"6级头盔",df_billable_level6_armor:"6级护甲",df_billable_top_insure_card:"顶级保险",df_billable_barrett_bullet:"巴雷特子弹",df_billable_coffee:"咖啡豆"};
export type LegacyOrderResources={source:'LEGACY_ORIGINAL_ORDER';state:'KNOWN'|'NONE'|'INVALID';items:Array<{code:string;name:string;quantity:string;unit:string|null;zero:boolean}>};
export function legacyOrderResources(raw:unknown):LegacyOrderResources{
 const none:LegacyOrderResources={source:'LEGACY_ORIGINAL_ORDER',state:'NONE',items:[]};
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return none;
 const row=raw as Record<string,unknown>,input:Record<string,string|null>={};
 for(const [key,field] of LEGACY_RESOURCE_RAW_KEYS){
  const value=row[key];
  if(value===null||value===undefined||(typeof value==='string'&&!value.trim()))continue;
  // 非字符串的原值不强转，整组标为异常而不是 0。
  if(typeof value!=='string')return {...none,state:'INVALID'};
  input[field]=value.trim();
 }
 try{
  const items=legacyUserOrderResources(input).map(item=>({code:item.code,name:LEGACY_RESOURCE_NAMES[item.code]??item.code,quantity:item.quantity as string,unit:item.unit,
   zero:item.code==='df_billable_haff'?legacyMoneyCents(item.quantity)==='0':item.quantity==='0'}));
  return items.length?{...none,state:'KNOWN',items}:none;
 }catch{return {...none,state:'INVALID'};}
}
/** 本单哈夫币兑换比例：只读下单冻结报价 pricingInputs.denominators.buyer（万哈夫币/元，已含会员/礼遇后的成交口径）；缺失或非法即 UNKNOWN，不回退上架价、不推算。 */
export type AdminOrderHaffRatio={source:'ORDER_QUOTE_SNAPSHOT'|'LEGACY_ORIGINAL_ORDER';state:'KNOWN'|'UNKNOWN'|'NOT_RECORDED';wanPerYuan:string|null;customerTier:string|null};
export function orderHaffRatio(quote:unknown):AdminOrderHaffRatio{
 const unknown:AdminOrderHaffRatio={source:'ORDER_QUOTE_SNAPSHOT',state:'UNKNOWN',wanPerYuan:null,customerTier:null};
 const rec=(v:unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:null;
 const q=rec(quote),inputs=rec(q?.pricingInputs),den=rec(inputs?.denominators);
 // 客户档位只取冻结报价自身记录；缺失保持 null，不默认为 STANDARD。
 const tierRaw=rec(inputs?.compatibility)?.customerTier??rec(rec(q?.personal)?.membership)?.tier;
 const customerTier=typeof tierRaw==='string'&&/^[A-Z_]{1,32}$/.test(tierRaw)?tierRaw:null;
 if(!q||!Array.isArray(q.lines)||!q.lines.some((line:any)=>rec(line)?.unit==='HAFF_BASE')||typeof den?.buyer!=='string')return {...unknown,customerTier};
 try{const ratio=parseNonNegativeDecimal(den.buyer,8,'order buyer ratio');return ratio.value>0n?{...unknown,state:'KNOWN',wanPerYuan:formatDecimalExact(ratio),customerTier}:{...unknown,customerTier};}catch{return {...unknown,customerTier};}
}
const LEGACY_HAFF_RATIO:AdminOrderHaffRatio={source:'LEGACY_ORIGINAL_ORDER',state:'NOT_RECORDED',wanPerYuan:null,customerTier:null};
function frozenQuoteSummary(quote: unknown): string | null {
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return null;
  const lines = (quote as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return null;
  const parts = lines.flatMap(line => {
    if (!line || typeof line !== "object") return [];
    const row = line as { quantity?: unknown; unit?: unknown; name?: unknown };
    if (typeof row.quantity !== "string" || !row.quantity.trim()) return [];
    const unit = typeof row.unit === "string" ? row.unit : "";
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : unit === "HAFF_BASE" ? "哈夫币" : "物资";
    return [`${name} ${row.quantity.trim()}${unit ? " " + unit : ""}`];
  });
  return parts.length ? `本单资源：${parts.join("、")}` : null;
}
function accountTitleFact(snapshotTitle: unknown, currentTitle: unknown, resourceSummary: string | null) {
  const titles = orderAccountTitleFact({ snapshotTitle, currentTitle, resourceSummary });
  return { title: titles.orderTitle, accountTitle: { source: titles.currentAccountSource, title: titles.currentAccountTitle, neutralSummary: titles.neutralSummary } };
}
// 只投影精确绑定的原APPLIED付款；报价不能补出实收，确认也不代表结算或到账。
function nativeRecordedAmount(r:Record<string,any>,viewer:OrderReadViewer){
 const p=r.native_payment_record;
 return viewer.financeReadable===true&&orderHasPaidState(r.status,r.cancel_reason)&&p&&p.id===r.paid_confirmation_id&&p.order_id===r.id
  &&p.disposition==='APPLIED'&&['CONTROLLED','JOINPAY'].includes(p.source)&&p.currency==='CNY'&&p.currency===r.currency
  &&typeof p.amount_cents==='string'&&/^(0|[1-9]\d{0,24})$/.test(p.amount_cents)?centsToYuan(p.amount_cents):null;
}
export function projectAdminReadOrder(origin:string,r:Record<string,any>,viewer:OrderReadViewer):Record<string,any>{
 if(origin==='NATIVE'){
  const row:OrderRow={id:r.id,displayNo:r.display_no,accountId:r.account_id,versionId:r.listing_version_id,ownerUserId:r.owner_user_id,renterUserId:r.renter_user_id,gameId:r.game_id,releaseId:r.rule_release_id,contentHash:r.content_hash,termOptionCode:r.term_option_code,status:r.status,rentalAmountCents:r.rental_amount_cents,depositAmountCents:r.deposit_amount_cents,currency:r.currency,termSeconds:r.term_seconds,quoteSnapshot:r.quote_snapshot,title:r.title,holdUntil:r.hold_until,paidAt:r.paid_at,dispatchState:r.dispatch_state,dispatchWaitReason:r.wait_reason,assignedAt:r.assigned_at,teamState:r.team_state,firstResponseAt:r.first_response_at??null,remindDueAt:r.remind_due_at??null,addRound:r.add_round??0,escalationState:r.escalation_state??'NOT_STARTED',cancelReason:r.cancel_reason,cancelledAt:r.cancelled_at,createdAt:r.created_at,revision:r.revision,expiredAwaitingCancel:r.expired,ownerName:r.owner_name,renterName:r.renter_name};
  const result=projectOrder(row,'admin',{internalQuote:viewer.internalQuote});const paid=orderHasPaidState(r.status,r.cancel_reason);
  const titles = accountTitleFact(r.title, null, frozenQuoteSummary(r.quote_snapshot));
  const breakdown=nativePrepaymentBreakdown(r,result.amounts);
  return {...result,...titles,haffRatio:orderHaffRatio(r.quote_snapshot),prepaymentBreakdown:breakdown,prepaymentReconciliation:nativeReconciliation(breakdown),source:{origin:'NATIVE',ruleOrigin:'NATIVE_ORDER'},accountDisplayNo:r.account_no,payment:{state:paid?'RECORDED_PAID':'RECORDED_UNPAID',recordedAt:r.paid_at,recordedAmount:nativeRecordedAmount(r,viewer)}};
 }
 const raw=r.source_snapshot,paid=r.source_pay_status===1,unpaid=r.source_pay_status===0;
 const state=legacyOrderReadState(r.continuation_stage??r.source_order_status,r.source_pay_status),status=state.status;
 const goodsRead=legacyPrepaymentPart(raw.goods_money),itemsRead=legacyPrepaymentPart(raw.expend_pay_money),goods=goodsRead.cents,items=itemsRead.cents;
 const resources=legacyOrderResources(raw),titles = accountTitleFact(undefined, null, null);
 return {id:r.id,displayNo:r.original_order_no,status,title:titles.title,accountTitle:titles.accountTitle,accountId:r.account_id,accountDisplayNo:r.account_no??null,legacyAccountNo:r.legacy_account_no??null,gameId:r.game_id,versionId:null,releaseId:null,contentHash:null,revision:'1',termOptionCode:null,termSeconds:null,
  amounts:{rental:goods!==null&&items!==null?centsToYuan(BigInt(goods)+BigInt(items)):null,deposit:money(r.deposit_amount_cents),totalDue:money(r.due_amount_cents),currency:'CNY'},
  haffRatio:LEGACY_HAFF_RATIO,prepaymentBreakdown:legacyPrepaymentBreakdown(goodsRead,itemsRead),prepaymentReconciliation:legacyReconciliation(goodsRead,itemsRead,r.deposit_amount_cents,r.due_amount_cents),legacyResources:resources,
  createdAt:r.source_created_at,paidAt:r.source_paid_at,cancelledAt:r.source_cancelled_at,completedAt:r.source_completed_at,holdUntil:null,expiredAwaitingCancel:false,paymentOpen:false,cancelOpen:false,
  ownerUserId:r.owner_user_id,renterUserId:r.renter_user_id,ownerName:r.owner_name,renterName:r.renter_name,ownerBusinessNo:r.legacy_owner_no,renterBusinessNo:r.legacy_renter_no,
  payment:{state:paid?'RECORDED_PAID':unpaid?'RECORDED_UNPAID':'UNKNOWN',recordedAt:r.source_paid_at,recordedAmount:paid&&viewer.financeReadable===true?money(r.recorded_paid_amount_cents):null},
  source:{origin:'LEGACY',ruleOrigin:'LEGACY_ORDER',originalStatus:r.source_order_status,statusLabel:state.statusLabel,originalPayStatus:r.source_pay_status},
  legacyAmounts:{required:money(r.due_amount_cents),paid:paid&&viewer.financeReadable===true?money(r.recorded_paid_amount_cents):null,deposit:money(r.deposit_amount_cents),refund:money(legacyMoneyCents(raw.return_order_money)),refundChannelState:'UNKNOWN'},quote:null};
}
export type AdminOrderProgress={
 asOfUtc:string|null;
 opening:{state:'NOT_STARTED'|'AWAITING_CONFIRMATION'|'CONFIRMED'|'NOT_APPLICABLE'|'UNKNOWN';confirmedAtUtc:string|null};
 ending:{state:'NOT_STARTED'|'PENDING_CLASSIFICATION'|'PENDING_PARTIES'|'PENDING_SUPPORT_REVIEW'|'PENDING_APPROVAL'|'READY'|'POSTED'|'NOT_APPLICABLE'|'UNKNOWN';currentVersionNo:number|null;postedAtUtc:string|null};
};
const unknownProgress=():AdminOrderProgress=>({asOfUtc:null,opening:{state:'UNKNOWN',confirmedAtUtc:null},ending:{state:'UNKNOWN',currentVersionNo:null,postedAtUtc:null}});
type ProgressRow={id:string;versionId:string|null;orderStatus:string;asOf:string|null;openingConfirmedAt:string|null;openingAny:boolean;intakeOpen:boolean;versionNo:number|null;kind:string|null;early:boolean|null;initiatorParty:string|null;versionHash:string|null;renterConfirmed:boolean;ownerConfirmed:boolean;renterRejected:boolean;ownerRejected:boolean;supportReviewed:boolean;approvalStatus:string|null;approvalRequestedBy:string|null;approvalDecidedBy:string|null;approvalPayloadHash:string|null;postedAt:string|null};
const PROGRESS_SQL=`WITH orders AS(
 SELECT r.id,r.status FROM zzsh_order.rental_order r WHERE r.id=ANY($1::text[])
),opening AS(
 SELECT o.id,max(op.confirmed_at) FILTER(WHERE op.status='CONFIRMED') AS confirmed_at,count(op.id)>0 AS any_row
 FROM orders o LEFT JOIN zzsh_order.rental_opening op ON op.order_id=o.id GROUP BY o.id
),latest_intake AS(
 SELECT DISTINCT ON(i.order_id) i.order_id AS id,i.status FROM zzsh_order.settlement_intake i JOIN orders o ON o.id=i.order_id ORDER BY i.order_id,i.version_no DESC
),current_version AS(
 SELECT v.order_id AS id,v.id AS version_id,v.version_no,v.kind,v.early,v.initiator_party,v.version_hash,v.approval_request_id
 FROM zzsh_order.settlement_version v JOIN orders o ON o.id=v.order_id WHERE v.superseded_at IS NULL
),decisions AS(
 SELECT cv.id,bool_or(d.party='RENTER' AND d.action='CONFIRM') AS renter_confirmed,bool_or(d.party='OWNER' AND d.action='CONFIRM') AS owner_confirmed,
  bool_or(d.party='RENTER' AND d.action='REJECT') AS renter_rejected,bool_or(d.party='OWNER' AND d.action='REJECT') AS owner_rejected,bool_or(d.party='SUPPORT' AND d.action='REVIEW') AS support_reviewed
 FROM current_version cv LEFT JOIN zzsh_order.settlement_decision d ON d.settlement_version_id=cv.version_id GROUP BY cv.id
),approval AS(
 SELECT cv.id,CASE WHEN a.status IN('PENDING','APPROVED') AND a.expires_at<=transaction_timestamp() THEN 'EXPIRED' ELSE a.status END AS status,
  a.requested_by,a.decided_by,a.operation_payload_hash
 FROM current_version cv JOIN zzsh_iam.approval_request a ON a.id=cv.approval_request_id
),posting AS(
 SELECT p.order_id AS id,p.posted_at FROM zzsh_order.settlement_posting p JOIN orders o ON o.id=p.order_id
)
SELECT o.id,o.status AS "orderStatus",to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "asOf",
 op.confirmed_at AS "openingConfirmedAt",COALESCE(op.any_row,false) AS "openingAny",COALESCE(li.status='OPEN',false) AS "intakeOpen",
 cv.version_id AS "versionId",cv.version_no AS "versionNo",cv.kind,cv.early,cv.initiator_party AS "initiatorParty",cv.version_hash AS "versionHash",
 COALESCE(d.renter_confirmed,false) AS "renterConfirmed",COALESCE(d.owner_confirmed,false) AS "ownerConfirmed",
 COALESCE(d.renter_rejected,false) AS "renterRejected",COALESCE(d.owner_rejected,false) AS "ownerRejected",COALESCE(d.support_reviewed,false) AS "supportReviewed",
 a.status AS "approvalStatus",a.requested_by AS "approvalRequestedBy",a.decided_by AS "approvalDecidedBy",a.operation_payload_hash AS "approvalPayloadHash",
 p.posted_at AS "postedAt"
 FROM orders o LEFT JOIN opening op ON op.id=o.id LEFT JOIN latest_intake li ON li.id=o.id
 LEFT JOIN current_version cv ON cv.id=o.id LEFT JOIN decisions d ON d.id=o.id
 LEFT JOIN approval a ON a.id=o.id LEFT JOIN posting p ON p.id=o.id`;
function orderProgress(row:ProgressRow):AdminOrderProgress{
 const versionNo=row.versionNo??null;
 let ending:AdminOrderProgress['ending'];
 if(row.postedAt)ending={state:'POSTED',currentVersionNo:versionNo,postedAtUtc:row.postedAt};
 else if(row.intakeOpen)ending={state:'PENDING_CLASSIFICATION',currentVersionNo:versionNo,postedAtUtc:null};
 else if(row.versionNo===null)ending={state:row.orderStatus==='CANCELLED'?'NOT_APPLICABLE':'NOT_STARTED',currentVersionNo:null,postedAtUtc:null};
 else if(row.versionHash===null)ending={state:'UNKNOWN',currentVersionNo:versionNo,postedAtUtc:null};
 else{
  const status=row.approvalStatus,versionId=row.versionId??row.id;
  const opsApproval=status==='APPROVED'||status==='PENDING'||status==='REJECTED'?{status:status as 'APPROVED'|'PENDING'|'REJECTED',requesterId:row.approvalRequestedBy??'',approverId:row.approvalDecidedBy??'',payloadHash:row.approvalPayloadHash??''}:null;
  const readiness=settlementConfirmationReady({settlementVersionId:versionId,currentVersionHash:row.versionHash,kind:row.kind as SettlementConfirmationFacts['kind'],early:row.early===true,initiatorParty:row.initiatorParty as SettlementConfirmationFacts['initiatorParty'],
   renterConfirmedVersionId:row.renterConfirmed?versionId:null,ownerConfirmedVersionId:row.ownerConfirmed?versionId:null,renterRejectedVersionId:row.renterRejected?versionId:null,ownerRejectedVersionId:row.ownerRejected?versionId:null,
   supportReviewedVersionId:row.supportReviewed?versionId:null,opsApproval});
  const reasons=new Set(readiness.reasons);
  const state:AdminOrderProgress['ending']['state']=readiness.ready?'READY':[...reasons].some(reason=>reason.startsWith('OPS_'))?'PENDING_APPROVAL'
   :reasons.has('RENTER_CONFIRMATION_MISSING')||reasons.has('OWNER_CONFIRMATION_MISSING')||reasons.has('PARTY_REJECTED')?'PENDING_PARTIES'
   :reasons.has('SUPPORT_REVIEW_MISSING')?'PENDING_SUPPORT_REVIEW':'UNKNOWN';
  ending={state,currentVersionNo:versionNo,postedAtUtc:null};
 }
 const opening:AdminOrderProgress['opening']=row.openingConfirmedAt?{state:'CONFIRMED',confirmedAtUtc:row.openingConfirmedAt}
  :row.openingAny?{state:'AWAITING_CONFIRMATION',confirmedAtUtc:null}
  :row.orderStatus==='CANCELLED'?{state:'NOT_APPLICABLE',confirmedAtUtc:null}:{state:'NOT_STARTED',confirmedAtUtc:null};
 return {asOfUtc:row.asOf,opening,ending};
}
/** One bounded read for this page's native orders. Missing or denied relations stay UNKNOWN, never "not started".
 *  A failed statement aborts the surrounding RR transaction; the savepoint restores it before any later read. */
async function readNativeOrderProgress(client:PoolClient,ids:string[]):Promise<Map<string,AdminOrderProgress>>{
 const unique=[...new Set(ids)],result=new Map<string,AdminOrderProgress>(),savepoint='admin_order_progress_read';
 if(!unique.length)return result;
 let rows:ProgressRow[]=[];
 await client.query(`SAVEPOINT ${savepoint}`);
 try{
  rows=(await client.query<ProgressRow>(PROGRESS_SQL,[unique])).rows;
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
 }catch(error){
  const code=(error as {code?:string}).code;
  const unavailable=code==='42P01'||code==='42501';
  try{await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);await client.query(`RELEASE SAVEPOINT ${savepoint}`);}catch(recoveryError){if(unavailable)throw recoveryError;}
  if(unavailable){for(const id of unique)result.set(id,unknownProgress());return result;}
  throw error;
 }
 for(const row of rows)result.set(row.id,orderProgress(row));
 return result;
}
export type AdminOrderFrozenAccount={
 source:'ORDER_VERSION'|'ACCOUNT_PUBLIC_VERSION';
 haff:{itemId:string;code:string;name:string|null;quantity:string|null;unit:string}|null;
 materials:Array<{itemId:string;code:string;name:string|null;quantity:string|null;unit:string}>;
 termDays:string|null;termSeconds:string|null;loginMethodText:string|null;safeBoxText?:string|null;gradingText?:string|null;
};
/** 订单关联账号视图：与账号供给页同一公开版本口径（不读当前草稿、不读历史参考）；由路由注入，避免订单读与供给读循环依赖。 */
export type OrderAccountView={source:'ACCOUNT_PUBLIC_VERSION';versionId:string;haff:{itemId:string;quantity:string|null}|null;
 materials:Array<{itemId:string;code:string|null;name:string|null;quantity:string|null;unit:string|null}>;materialsVisibleTotal:number;
 safeBoxText:string|null;gradingText:string|null;loginMethodText:string|null;term:{name:string|null;termSeconds:string|null;dailyConsumption:string|null};
 fullPayout:'SELECTED'|'NOT_SELECTED'|'NOT_DECLARED';haffRatioWanPerYuan:string|null;
 fees:{completeness:string;haffRental:unknown;materials:unknown;resourceTotal:unknown;tenantDeposit:unknown;tenantPayableTotal:unknown;baseDepositCents:string|null}};
export type OrderAccountViewReader=(client:PoolClient,accountIds:string[])=>Promise<Map<string,OrderAccountView>>;
type FrozenNativeRow={orderId:string;versionId:string|null;attributes:Record<string,unknown>|null;presentationItems:unknown;resources:Array<{itemId:string;code:string;quantity:string|null;unit:string}>;termSeconds:string|null};
/** Native frozen account facts: the order table lives in zzsh_order, never zzsh_supply. */
export const NATIVE_FROZEN_ACCOUNT_SQL=`SELECT /* admin-order-frozen-account */ wanted."orderId",v.id AS "versionId",v.attributes,v.presentation->'items' AS "presentationItems",
   o.term_seconds::text AS "termSeconds",
   COALESCE(jsonb_agg(jsonb_build_object('itemId',l.item_id,'code',i.code,'quantity',l.quantity::text,'unit',i.unit) ORDER BY i.sort_order,i.id) FILTER(WHERE i.id IS NOT NULL),'[]'::jsonb) AS resources
  FROM jsonb_to_recordset($1::jsonb) AS wanted("orderId" text,"accountId" text,"versionId" text,"contentHash" text)
  JOIN zzsh_supply.rental_account a ON a.id=wanted."accountId"
  LEFT JOIN zzsh_order.rental_order o ON o.id=wanted."orderId"
  LEFT JOIN zzsh_supply.listing_version v ON v.id=wanted."versionId" AND v.account_id=wanted."accountId" AND v.content_hash=wanted."contentHash"
  LEFT JOIN zzsh_supply.inventory_line l ON l.version_id=v.id
  LEFT JOIN zzsh_supply.billable_item i ON i.id=l.item_id
  WHERE ${gameScopeSql('a.game_id','$3','$2')}
  GROUP BY wanted."orderId",v.id,v.attributes,v.presentation,o.term_seconds`;
/** One bounded read for this page's native frozen order versions; no current account/catalog substitution. */
export async function readNativeFrozenAccounts(client:PoolClient,viewer:OrderReadViewer,items:Record<string,any>[]):Promise<Map<string,AdminOrderFrozenAccount>>{
 const result=new Map<string,AdminOrderFrozenAccount>();
 const wanted=items.filter(item=>item.source?.origin==='NATIVE'&&typeof item.id==='string'&&typeof item.accountId==='string'&&typeof item.versionId==='string'&&typeof item.contentHash==='string')
  .map(item=>({orderId:item.id,accountId:item.accountId,versionId:item.versionId,contentHash:item.contentHash}));
 if(!wanted.length)return result;
 const rows=(await client.query<FrozenNativeRow>(NATIVE_FROZEN_ACCOUNT_SQL,[JSON.stringify(wanted),viewer.isBoss,viewer.adminId])).rows;
 for(const row of rows){
  if(!row.versionId)continue;
  const resources=frozenResourceLines(row.presentationItems,row.resources);
  const haff=resources.find(item=>item.unit==='HAFF_BASE')??null;
  const termSeconds=row.termSeconds;
  const termDays=termSeconds&&/^\d+$/.test(termSeconds)&&BigInt(termSeconds)%86400n===0n?(BigInt(termSeconds)/86400n).toString():null;
  result.set(row.orderId,{source:'ORDER_VERSION',haff,materials:resources.filter(item=>item!==haff),termDays,termSeconds,loginMethodText:projectPublicAttributeDisplay(row.attributes??{}).loginMethod?.displayName??null,safeBoxText:projectPublicAttributeDisplay(row.attributes??{}).safeBox?.displayName??null,gradingText:projectPublicAttributeDisplay(row.attributes??{}).grading?.displayName??null});
 }
 return result;
}
/** 迁入单：账号即账号，账号资料取公开版本（与账号页一致）；租期用账号当前租期，不再读历史快照。 */
export function accountViewFrozen(view:OrderAccountView):AdminOrderFrozenAccount{
 const seconds=view.term.termSeconds,termDays=seconds&&/^\d+$/.test(seconds)&&BigInt(seconds)%86400n===0n?(BigInt(seconds)/86400n).toString():null;
 return {source:'ACCOUNT_PUBLIC_VERSION',haff:view.haff?{itemId:view.haff.itemId,code:view.haff.itemId,name:'哈夫币',quantity:view.haff.quantity,unit:'HAFF_BASE'}:null,
  materials:view.materials.map(m=>({itemId:m.itemId,code:m.code??m.itemId,name:m.name,quantity:m.quantity,unit:m.unit??''})),termDays,termSeconds:seconds,loginMethodText:view.loginMethodText,safeBoxText:view.safeBoxText,gradingText:view.gradingText};
}
async function attachFrozenAccounts(client:PoolClient,viewer:OrderReadViewer,items:Record<string,any>[],accountViews?:OrderAccountViewReader){
 if(!(viewer.isBoss||viewer.permissions?.has("supply.rental_account.read")))return;
 const native=await readNativeFrozenAccounts(client,viewer,items);
 const ids=[...new Set(items.map(item=>item.accountId).filter((id):id is string=>typeof id==='string'))];
 const views=accountViews&&ids.length?await accountViews(client,ids):new Map<string,OrderAccountView>();
 for(const item of items){
  const view=views.get(item.accountId);if(view)item.accountView=view;
  if(item.source?.origin==='NATIVE'){const summary=native.get(item.id);if(summary)item.frozenAccount=summary;continue;}
  if(!view)continue;
  item.frozenAccount=accountViewFrozen(view);
  // 旧单原单无比例：用账号公开比例并标明来源；账号也无则保持未知
  if(item.haffRatio?.state!=='KNOWN'&&view.haffRatioWanPerYuan)item.haffRatio={source:'ACCOUNT_PUBLIC_VERSION',state:'KNOWN',wanPerYuan:view.haffRatioWanPerYuan,customerTier:null};
 }
}
function summaryOf(summaries:Map<string,DirectoryUserSummary>,id:unknown){return typeof id==='string'?summaries.get(id):undefined;}
/** Page-selected ids only: one progress read for native rows and one directory summary read for both parties. */
async function attachAdminOrderExtras(client:PoolClient,items:Record<string,any>[],viewer:OrderReadViewer,accountViews?:OrderAccountViewReader){
 const progress=await readNativeOrderProgress(client,items.filter(item=>item.source?.origin==='NATIVE').map(item=>item.id));
 const summaries=await readDirectoryUserSummaries(client,items.flatMap(item=>[item.ownerUserId,item.renterUserId]).filter((id):id is string=>typeof id==='string'),viewer.permissions,viewer.permissions?{adminId:viewer.adminId,isBoss:viewer.isBoss,membershipSummaryRead:viewer.permissions.has('membership.growth.read.summary'),creditRead:viewer.permissions.has('credit.read')}:undefined);
 for(const item of items){
  if(item.source?.origin==='NATIVE')item.progress=progress.get(item.id)??unknownProgress();
  const owner=summaryOf(summaries,item.ownerUserId),renter=summaryOf(summaries,item.renterUserId);
  if(owner)item.ownerSummary=owner;if(renter)item.renterSummary=renter;
 }
 await attachFrozenAccounts(client,viewer,items,accountViews);
}
/** 列表轻量视图：仅在显式 view=list 时截断冻结物资数组并给出精确总数；默认形状不变，详情始终完整。 */
export const LIST_MATERIALS_LIMIT=3;
function slimListItem(item:Record<string,any>){
 const frozen=item.frozenAccount as AdminOrderFrozenAccount|undefined;
 if(!frozen)return;
 const total=frozen.materials.length;
 item.frozenAccount={...frozen,materials:frozen.materials.slice(0,LIST_MATERIALS_LIMIT),materialsTotal:total,materialsTruncated:total>LIST_MATERIALS_LIMIT};
}
/** 列表金额权限：无财务读权限（finance.read）时列表不下发订单金额及其分项，前端按权限受限显示「—」；详情另行按原口径处理。 */
export function restrictListMoney(item:Record<string,any>){
 item.amounts={...(item.amounts??{}),rental:null,deposit:null,totalDue:null};
 if(item.prepaymentBreakdown)item.prepaymentBreakdown={...item.prepaymentBreakdown,haffRental:null,materialsPrepay:null};
 if(item.legacyAmounts)item.legacyAmounts=null;
 if(item.payment)item.payment={...item.payment,recordedAmount:null};
 item.prepaymentReconciliation=null;
 // 兜底：列表项内任何金额对象（含报价、冻结物资等）一律置空，确保无权限时列表不泄露金额
 const sweep=(v:any):any=>{if(Array.isArray(v))return v.map(sweep);if(v&&typeof v==='object'){if('amount' in v&&'currency' in v)return null;for(const k of Object.keys(v))v[k]=sweep(v[k]);}return v;};
 for(const k of Object.keys(item))item[k]=sweep(item[k]);
 item.amountsRestricted='FINANCE_PERMISSION_REQUIRED';
}
export async function queryAdminReadOrders(client:PoolClient,viewer:OrderReadViewer,filter:OrderReadFilters,accountViews?:OrderAccountViewReader){
 if(filter.restoreKey&&filter.restoreKey!==viewer.authorizationKey)throw conflict('Authorization context changed');
 const values:unknown[]=[viewer.isBoss,viewer.adminId],where=[gameScopeSql("x.game_id","$2","$1")];
 const exact=(field:string,value:string|undefined)=>{if(value!==undefined)where.push(`${field}=$${values.push(value)}`);};
 exact('x.status',filter.status);exact('x.origin',filter.origin);exact('x.display_no',filter.displayNo);exact('x.account_id',filter.accountId);exact('x.renter_user_id',filter.renterUserId);exact('x.owner_user_id',filter.ownerUserId);
 if(filter.createdFrom)where.push(`x.created_at>=$${values.push(filter.createdFrom)}::timestamptz`);if(filter.createdTo)where.push(`x.created_at<$${values.push(filter.createdTo)}::timestamptz`);
 if(filter.qValue){const q=filter.qValue,p='$'+values.push(q);if(filter.qKind==='order')where.push(`x.display_no=${p}`);else if(filter.qKind==='account')where.push(`x.account_no=${p} OR x.account_id=${p} OR x.legacy_account_no=${p}`);else{
  if(/^(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}$/.test(q))throw invalid('Phone lookup must use the user lookup contract');
  const pattern='$'+values.push('%'+escapeLike(q)+'%'),party=(role:string)=>`(x.${role}_user_id=${p} OR x.${role}_no=${p} OR x.${role}_name ILIKE ${pattern} ESCAPE '\\' OR x.${role}_username ILIKE ${pattern} ESCAPE '\\')`;
  where.push(filter.qKind==='renter'?party('renter'):filter.qKind==='owner'?party('owner'):`(${party('renter')} OR ${party('owner')})`);
 }}
 const pageSize='$'+values.push(filter.pageSize),offset='$'+values.push((filter.page-1)*filter.pageSize);
 const continuationReady=await legacyContinuationReady(client);
 // Authorization, filtering, counting and key selection run on the narrow
 // relation; only this page's own keys are read again for their full record.
 const page=(await client.query<{total:string;keys:Array<{origin:string;id:string}>}>(`WITH all_orders AS(${orderReadKeyRelation(continuationReady)}),filtered AS(SELECT * FROM all_orders x WHERE ${where.map(w=>'('+w+')').join(' AND ')}),paged AS(SELECT origin,id,created_at FROM filtered ORDER BY created_at DESC NULLS LAST,id DESC LIMIT ${pageSize} OFFSET ${offset}) SELECT (SELECT count(*)::text FROM filtered) AS total,COALESCE((SELECT jsonb_agg(jsonb_build_object('origin',p.origin,'id',p.id) ORDER BY p.created_at DESC NULLS LAST,p.id DESC) FROM paged p),'[]'::jsonb) AS keys`,values)).rows[0]!;
 const keys=page.keys,items:Record<string,any>[]=[];
 if(keys.length){
  // The keys are already authorized and filtered; their records are read back
  // by origin, so a native and a legacy row with the same id never mix.
  const recordValues=[keys.filter(k=>k.origin==='NATIVE').map(k=>k.id),keys.filter(k=>k.origin==='LEGACY').map(k=>k.id)];
  const records=(await client.query<{origin:string;id:string;record:Record<string,any>}>(`WITH all_orders AS(${orderReadRelation(continuationReady,false,{nativeIds:'$1',legacyIds:'$2'})}) SELECT x.origin,x.id,x.record FROM all_orders x`,recordValues)).rows;
  const byKey=new Map(records.map(row=>[`${row.origin}\u0000${row.id}`,row.record]));
  for(const key of keys){
   const record=byKey.get(`${key.origin}\u0000${key.id}`);
   if(!record)throw notFound();
   items.push(projectAdminReadOrder(key.origin,record,viewer));
  }
 }
 await attachAdminOrderExtras(client,items,viewer,accountViews);
 if(filter.view==='list')for(const item of items){slimListItem(item);if(viewer.financeReadable!==true)restrictListMoney(item);}
 return {items,page:filter.page,pageSize:filter.pageSize,total:Number(page.total),contextKey:viewer.authorizationKey};
}
export async function getAdminReadOrder(client:PoolClient,viewer:OrderReadViewer,id:string,paymentReadOptions?:ChannelPaymentReadOptions,accountViews?:OrderAccountViewReader){
 const relation=orderReadRelation(await legacyContinuationReady(client),false,{nativeIds:'$1',legacyIds:'$1'});
 const row=(await client.query<{origin:string;record:Record<string,any>}>(`WITH all_orders AS(${relation}) SELECT x.origin,x.record FROM all_orders x WHERE x.id=ANY($1::text[]) AND ${gameScopeSql("x.game_id","$3","$2")}`,[[id],viewer.isBoss,viewer.adminId])).rows[0];
 if(!row)throw notFound();
 const order=projectAdminReadOrder(row.origin,row.record,viewer);
 await attachAdminOrderExtras(client,[order],viewer,accountViews);
 const paymentSummary=await readOrderPaymentSummary(client,{orderId:id,origin:row.origin==="NATIVE"?"NATIVE":"LEGACY",financeReadable:viewer.financeReadable===true},paymentReadOptions);
 const refundSummary=await readAdminOrderRefundSummary(client,{orderId:id,origin:row.origin==='NATIVE'?'NATIVE':'LEGACY',financeReadable:viewer.financeReadable===true});
 return {order,contextKey:viewer.authorizationKey,paymentSummary,refundSummary};
}
