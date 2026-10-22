import { readOrderPaymentSummary } from "./channel-payment-read";
import type { PoolClient } from "pg";
import { gameScopeSql } from "../auth/admin-scope";
import { projectOrder, centsToYuan, type OrderRow } from "./order";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { escapeLike } from "../supply/catalog";
import { legacyContinuationReady, legacyMoneyCents, legacyOrderReadState, LEGACY_ORDER_STATUS_SQL } from "./legacy-order-read";

export type OrderReadViewer = { adminId: string; isBoss: boolean; internalQuote: boolean; authorizationKey: string; financeReadable?: boolean };
export type OrderReadFilters = { page: number; pageSize: number; status?: string; displayNo?: string; accountId?: string; renterUserId?: string; ownerUserId?: string; createdFrom?: string; createdTo?: string; qKind?: "order" | "account" | "party" | "renter" | "owner"; qValue?: string; restoreKey?: string };
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
const NATIVE_FILTER = `a.display_no AS account_no,NULL::text AS renter_no,NULL::text AS owner_no,ou.name AS owner_name,ru.name AS renter_name,ou.username AS owner_username,ru.username AS renter_username,'NATIVE'::text AS origin`;
const LEGACY_FILTER = `l.legacy_account_no,l.legacy_renter_no,l.legacy_owner_no,ou.name,ru.name,ou.username,ru.username,'LEGACY'::text`;
const NATIVE_RECORD = `to_jsonb(o)||jsonb_build_object('rental_amount_cents',o.rental_amount_cents::text,'deposit_amount_cents',o.deposit_amount_cents::text,
    'term_seconds',o.term_seconds::text,'revision',o.revision::text,'created_at',${utc('o.created_at')},'hold_until',${utc('o.hold_until')},'paid_at',${utc('o.paid_at')},'cancelled_at',${utc('o.cancelled_at')},
    'owner_name',ou.name,'renter_name',ru.name,'account_no',a.display_no,'expired',o.status='PENDING_PAYMENT' AND o.hold_until<=clock_timestamp(),
    'dispatch_state',g.provision_state,'wait_reason',g.wait_reason,'assigned_at',${utc('g.assigned_at')},'team_state',g.team_state,
    'first_response_at',to_jsonb(g)->>'first_response_at','remind_due_at',to_jsonb(g)->>'remind_due_at',
    'add_round',COALESCE((to_jsonb(g)->>'add_round')::int,0),'escalation_state',COALESCE(to_jsonb(g)->>'escalation_state','NOT_STARTED'))`;
const LEGACY_RECORD = (continuationReady: boolean) => `to_jsonb(l)||jsonb_build_object('due_amount_cents',l.due_amount_cents::text,'recorded_paid_amount_cents',l.recorded_paid_amount_cents::text,'deposit_amount_cents',l.deposit_amount_cents::text,
    'source_created_at',${utc('l.source_created_at')},'source_paid_at',${utc('l.source_paid_at')},'source_cancelled_at',${utc('l.source_cancelled_at')},'source_completed_at',${utc(continuationReady ? CONTINUATION_COMPLETED_AT : "l.source_completed_at")},
    'continuation_stage',h.stage,
    'owner_name',ou.name,'renter_name',ru.name,'title',v.title)`;

/** Restricts one source branch to its own ids; the values are the caller's
 *  parameter placeholders, so the same relation serves the page read and the
 *  single-order read. */
export type OrderReadRestriction = { nativeIds?: string; legacyIds?: string };

function orderReadSql(continuationReady: boolean, nativeColumns: string, legacyColumns: string, restrict?: OrderReadRestriction): string { return `
 SELECT ${nativeColumns}
  FROM zzsh_order.rental_order o JOIN zzsh_auth_user."user" ou ON ou.id=o.owner_user_id
  JOIN zzsh_auth_user."user" ru ON ru.id=o.renter_user_id JOIN zzsh_supply.rental_account a ON a.id=o.account_id
  LEFT JOIN zzsh_order.im_order_group g ON g.order_id=o.id${restrict?.nativeIds ? ` WHERE o.id=ANY(${restrict.nativeIds}::text[])` : ""}
 UNION ALL
 SELECT ${legacyColumns}
  FROM zzsh_order.legacy_order_read_snapshot l JOIN zzsh_auth_user."user" ou ON ou.id=l.owner_user_id
  ${continuationReady ? CONTINUATION_JOIN : ABSENT_CONTINUATION_JOIN}
  JOIN zzsh_auth_user."user" ru ON ru.id=l.renter_user_id JOIN zzsh_supply.rental_account a ON a.id=l.account_id
  LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id${restrict?.legacyIds ? ` WHERE l.id=ANY(${restrict.legacyIds}::text[])` : ""}`; }

export function orderReadRelation(continuationReady: boolean, summaryOnly = false, restrict?: OrderReadRestriction): string {
 return orderReadSql(continuationReady,
  NATIVE_HEAD + (summaryOnly ? "" : `,${NATIVE_FILTER},${NATIVE_RECORD} AS record`),
  LEGACY_HEAD + "," + LEGACY_ORDER_STATUS_SQL + (summaryOnly ? "" : `,${LEGACY_FILTER},${LEGACY_RECORD(continuationReady)} AS record`),
  restrict);
}
/** The same rows and the same filter columns without the record projection.
 *  Authorization, filtering, counting and key selection run on this relation;
 *  only the page's own keys are read again for their full record. */
export function orderReadKeyRelation(continuationReady: boolean): string {
 return orderReadSql(continuationReady, NATIVE_HEAD + "," + NATIVE_FILTER, LEGACY_HEAD + "," + LEGACY_ORDER_STATUS_SQL + "," + LEGACY_FILTER);
}
function money(value:unknown){return typeof value==='string'?centsToYuan(value):null;}
export function projectAdminReadOrder(origin:string,r:Record<string,any>,viewer:OrderReadViewer):Record<string,any>{
 if(origin==='NATIVE'){
  const row:OrderRow={id:r.id,displayNo:r.display_no,accountId:r.account_id,versionId:r.listing_version_id,ownerUserId:r.owner_user_id,renterUserId:r.renter_user_id,gameId:r.game_id,releaseId:r.rule_release_id,contentHash:r.content_hash,termOptionCode:r.term_option_code,status:r.status,rentalAmountCents:r.rental_amount_cents,depositAmountCents:r.deposit_amount_cents,currency:r.currency,termSeconds:r.term_seconds,quoteSnapshot:r.quote_snapshot,title:r.title,holdUntil:r.hold_until,paidAt:r.paid_at,dispatchState:r.dispatch_state,dispatchWaitReason:r.wait_reason,assignedAt:r.assigned_at,teamState:r.team_state,firstResponseAt:r.first_response_at??null,remindDueAt:r.remind_due_at??null,addRound:r.add_round??0,escalationState:r.escalation_state??'NOT_STARTED',cancelReason:r.cancel_reason,cancelledAt:r.cancelled_at,createdAt:r.created_at,revision:r.revision,expiredAwaitingCancel:r.expired,ownerName:r.owner_name,renterName:r.renter_name};
  const result=projectOrder(row,'admin',{internalQuote:viewer.internalQuote});const paid=['PAID','COMPLETED'].includes(r.status);
  return {...result,source:{origin:'NATIVE',ruleOrigin:'NATIVE_ORDER'},accountDisplayNo:r.account_no,payment:{state:paid?'RECORDED_PAID':'RECORDED_UNPAID',recordedAt:r.paid_at,recordedAmount:null}};
 }
 const raw=r.source_snapshot,paid=r.source_pay_status===1,unpaid=r.source_pay_status===0;
 const state=legacyOrderReadState(r.continuation_stage??r.source_order_status,r.source_pay_status),status=state.status;
 const goods=legacyMoneyCents(raw.goods_money),items=legacyMoneyCents(raw.expend_pay_money);
 return {id:r.id,displayNo:r.original_order_no,status,title:r.title??'资源资料待核',accountId:r.account_id,accountDisplayNo:r.legacy_account_no,gameId:r.game_id,versionId:null,releaseId:null,contentHash:null,revision:'1',termOptionCode:null,termSeconds:null,
  amounts:{rental:goods!==null&&items!==null?centsToYuan(BigInt(goods)+BigInt(items)):null,deposit:money(r.deposit_amount_cents),totalDue:money(r.due_amount_cents),currency:'CNY'},
  createdAt:r.source_created_at,paidAt:r.source_paid_at,cancelledAt:r.source_cancelled_at,completedAt:r.source_completed_at,holdUntil:null,expiredAwaitingCancel:false,paymentOpen:false,cancelOpen:false,
  ownerUserId:r.owner_user_id,renterUserId:r.renter_user_id,ownerName:r.owner_name,renterName:r.renter_name,ownerBusinessNo:r.legacy_owner_no,renterBusinessNo:r.legacy_renter_no,
  payment:{state:paid?'RECORDED_PAID':unpaid?'RECORDED_UNPAID':'UNKNOWN',recordedAt:r.source_paid_at,recordedAmount:paid?money(r.recorded_paid_amount_cents):null},
  source:{origin:'LEGACY',ruleOrigin:'LEGACY_ORDER',originalStatus:r.source_order_status,statusLabel:state.statusLabel,originalPayStatus:r.source_pay_status},
  legacyAmounts:{required:money(r.due_amount_cents),paid:paid?money(r.recorded_paid_amount_cents):null,deposit:money(r.deposit_amount_cents),refund:money(legacyMoneyCents(raw.return_order_money)),refundChannelState:'UNKNOWN'},quote:null};
}
export async function queryAdminReadOrders(client:PoolClient,viewer:OrderReadViewer,filter:OrderReadFilters){
 if(filter.restoreKey&&filter.restoreKey!==viewer.authorizationKey)throw conflict('Authorization context changed');
 const values:unknown[]=[viewer.isBoss,viewer.adminId],where=[gameScopeSql("x.game_id","$2","$1")];
 const exact=(field:string,value:string|undefined)=>{if(value!==undefined)where.push(`${field}=$${values.push(value)}`);};
 exact('x.status',filter.status);exact('x.display_no',filter.displayNo);exact('x.account_id',filter.accountId);exact('x.renter_user_id',filter.renterUserId);exact('x.owner_user_id',filter.ownerUserId);
 if(filter.createdFrom)where.push(`x.created_at>=$${values.push(filter.createdFrom)}::timestamptz`);if(filter.createdTo)where.push(`x.created_at<$${values.push(filter.createdTo)}::timestamptz`);
 if(filter.qValue){const q=filter.qValue,p='$'+values.push(q);if(filter.qKind==='order')where.push(`x.display_no=${p}`);else if(filter.qKind==='account')where.push(`x.account_no=${p} OR x.account_id=${p}`);else{
  if(/(?:\+?86[\s-]*)?1[3-9](?:[\s-]*\d){9}/.test(q))throw invalid('Phone lookup must use the user lookup contract');
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
 return {items,page:filter.page,pageSize:filter.pageSize,total:Number(page.total),contextKey:viewer.authorizationKey};
}
export async function getAdminReadOrder(client:PoolClient,viewer:OrderReadViewer,id:string){
 const relation=orderReadRelation(await legacyContinuationReady(client),false,{nativeIds:'$1',legacyIds:'$1'});
 const row=(await client.query<{origin:string;record:Record<string,any>}>(`WITH all_orders AS(${relation}) SELECT x.origin,x.record FROM all_orders x WHERE x.id=ANY($1::text[]) AND ${gameScopeSql("x.game_id","$3","$2")}`,[[id],viewer.isBoss,viewer.adminId])).rows[0];
 if(!row)throw notFound();
 const paymentSummary=await readOrderPaymentSummary(client,{orderId:id,origin:row.origin==="NATIVE"?"NATIVE":"LEGACY",financeReadable:viewer.financeReadable===true});
 return {order:projectAdminReadOrder(row.origin,row.record,viewer),contextKey:viewer.authorizationKey,paymentSummary};
}
