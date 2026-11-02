import type { PoolClient } from "pg";
import { exactCents } from "./personal-finance-read";
import { SecurityApiError } from "../auth/security-core";
import { escapeLike } from "../supply/catalog";
import type { FinanceLoadScope } from "./admin-finance-query";
import { gameScopeSql } from "../auth/admin-scope";
import type { HistoricalRelationAccess } from "./legacy-observation-display";

export type FinanceOrderFact = { ref: string; id: string; number: string; sourceType: string; sourceSystem: string; sourceId: string; sourceDigest: string | null; kind: "SETTLEMENT"; state: "ORDER_RECORDED" | "HISTORICAL_ORDER_RECORDED"; occurredAt: string | null; importedAt: string; ownerId: string; renterId: string; accountId: string; dueCents: string | null; recordedPaidCents: string | null; depositCents: string | null; originalOrderStatus: string; originalPaymentStatus: string | null;
  payment?: { state: "SITE_ACCEPTED" | "REVIEW_REQUIRED" | "NO_ACCEPTED_PAYMENT" | "LEGACY_RECORDED" | "UNAVAILABLE"; amountCents: string | null; confirmedAt: string | null; source?:string|null; hasReviewPayment: boolean | null }; postingState?: "POSTED" | "NOT_POSTED" | "LEGACY_OBSERVATION" | "UNAVAILABLE";
  objectReadable?:boolean;accountReadable?:boolean;legacySource?:{entity:string;snapshot:Record<string,unknown>;completedAt:string|null} };
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function amount(value: unknown) { try { return exactCents(value); } catch { return null; } }
export function financeOrderSql(legacy: boolean, scope: FinanceLoadScope, related: Record<string, any>[] = [], limit: number | null = 20001,access?:HistoricalRelationAccess) {
  const sql = legacy ? `SELECT id,source_system,source_entity,legacy_id,source_digest,original_order_no,owner_user_id,renter_user_id,account_id,game_id,source_snapshot,
    due_amount_cents::text AS due,recorded_paid_amount_cents::text AS recorded_paid,deposit_amount_cents::text AS deposit,
    source_order_status::text AS order_status,source_pay_status::text AS pay_status,${utc("source_completed_at")} AS completed_at,${utc("source_created_at")} AS at,${utc("imported_at")} AS imported_at
    FROM zzsh_order.legacy_order_read_snapshot` : `SELECT o.id,o.display_no,o.owner_user_id,o.renter_user_id,o.account_id,o.game_id,o.status,o.revision::text,
    (o.rental_amount_cents+o.deposit_amount_cents)::text AS due,o.deposit_amount_cents::text AS deposit,${utc("o.created_at")} AS at,
    p.id AS accepted_payment_id,p.amount_cents::text AS accepted_paid,p.source AS accepted_source,${utc("o.paid_at")} AS paid_at,
    EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation review WHERE review.order_id=o.id AND review.disposition='REVIEW_REQUIRED') AS has_review_payment,
    EXISTS(SELECT 1 FROM zzsh_order.settlement_posting posting WHERE posting.order_id=o.id) AS has_posting
    FROM zzsh_order.rental_order o LEFT JOIN zzsh_order.payment_confirmation p ON p.id=o.paid_confirmation_id AND p.order_id=o.id AND p.disposition='APPLIED' AND p.currency='CNY'`;
  const values: unknown[] = [], predicates: string[] = [], bind = (value: unknown) => `$${values.push(value)}`;
  if(scope.orderRefs)predicates.push(`('${legacy?"LEGACY_ORDER:":"ORDER:"}'||r.id)=ANY(${bind(scope.orderRefs)}::text[])`);
  else if(scope.documentRef){const prefix=legacy?"LEGACY_ORDER:":"ORDER:";predicates.push(scope.documentRef.startsWith(prefix)?`r.id=${bind(scope.documentRef.slice(prefix.length))}`:"FALSE");}
  else if(scope.subjectId){const p=bind(scope.subjectId);predicates.push(`(r.owner_user_id=${p} OR r.renter_user_id=${p})`);}
  else if(scope.filters){const f=scope.filters;if(f.scope!=="ALL"){const p=bind(f.scope);predicates.push(`(r.owner_user_id=${p} OR r.renter_user_id=${p})`);}if(f.bucket!=="ALL"||!["ALL","SETTLEMENT"].includes(f.kind)||!["ALL",legacy?"HISTORICAL_ORDER_RECORDED":"ORDER_RECORDED"].includes(f.state))predicates.push("FALSE");
    if(f.period){const start=bind(`${f.from}T00:00:00+08:00`),end=bind(new Date(Date.parse(`${f.to}T00:00:00+08:00`)+86400_000).toISOString());predicates.push(`(r.at IS NULL OR (r.at::timestamptz>=${start}::timestamptz AND r.at::timestamptz<${end}::timestamptz))`);}
    if(f.q.startsWith("ORDER_LINK:"))predicates.push(`r.id=${bind(f.q.slice(11))}`);else if(f.q){
      const exact=scope.lookup?.exact,p=bind(exact?f.q:`%${escapeLike(f.q.toLocaleLowerCase("zh-CN"))}%`),match=(field:string)=>exact?`(${field})=${p}`:`lower(${field}) LIKE ${p} ESCAPE '\\'`;
      const fields=[`${legacy?"r.original_order_no":"r.display_no"}`,`'${legacy?"LEGACY_ORDER:":"ORDER:"}'||r.id`,...(!exact?["r.id",...(legacy?["r.legacy_id"]:[])]:[])];
      const name=`CASE WHEN u.name ~ '^1[3-9][0-9]{9}$' THEN left(u.name,3)||'****'||right(u.name,4) ELSE COALESCE(u.name,u.id) END`;
      predicates.push(`(${fields.map(match).join(" OR ")} OR EXISTS(SELECT 1 FROM zzsh_auth_user."user" u WHERE u.id IN(r.owner_user_id,r.renter_user_id) AND (${match("u.id")} OR ${match(name)})))`);
    }}
  const main=predicates.length?predicates.join(" AND "):"TRUE", links:string[]=[];
  if(legacy)for(const row of related){if(row.reference_id||row.reference_no){const fields=[`r.source_system=${bind(row.source_system)}`];if(row.reference_id)fields.push(`r.legacy_id=${bind(row.reference_id)}`);if(row.reference_no)fields.push(`r.original_order_no=${bind(row.reference_no)}`);links.push("("+fields.join(" AND ")+")");}}
  const scoped=access&&(access.isBoss||access.orderRead||access.resourceRead)?gameScopeSql('r.game_id',bind(access.adminId),bind(access.isBoss)):'false';
  return {text:`WITH finance_order_rows AS (${sql}) SELECT r.*,(${access?.isBoss||access?.orderRead?scoped:'false'}) AS object_readable,(${access?.isBoss||access?.resourceRead?scoped:'false'}) AS account_readable FROM finance_order_rows r WHERE (${main})${links.length?" OR "+links.join(" OR "):""}${limit===null?"":` ORDER BY r.id COLLATE "C" LIMIT ${limit}`}`,values};
}
export async function loadFinanceOrderFacts(client: PoolClient, ready: { native_orders?: boolean; legacy_orders?: boolean }, scope: FinanceLoadScope = {}, related: Record<string, any>[] = [],access?:HistoricalRelationAccess): Promise<FinanceOrderFact[]> {
  const records: FinanceOrderFact[] = [];
  if (ready.native_orders) {
    const query=financeOrderSql(false,scope,related,20001,access);const rows=(await client.query(query.text,query.values)).rows;
    for (const row of rows) records.push({ ref: `ORDER:${row.id}`, id: row.id, number: row.display_no, sourceType: "NATIVE", sourceSystem: "zzsh", sourceId: row.id, sourceDigest: null, kind: "SETTLEMENT", state: "ORDER_RECORDED", occurredAt: row.at, importedAt: row.at, ownerId: row.owner_user_id, renterId: row.renter_user_id, accountId: row.account_id, dueCents: amount(row.due), recordedPaidCents: null, depositCents: amount(row.deposit), originalOrderStatus: row.status, originalPaymentStatus: null,...nativePaymentFacts(row),objectReadable:row.object_readable===true||row.object_readable===1,accountReadable:row.account_readable===true||row.account_readable===1 });
  }
  if (ready.legacy_orders) {
    const query=financeOrderSql(true,scope,related,20001,access);const rows=(await client.query(query.text,query.values)).rows;
    for (const row of rows) records.push({ ref: `LEGACY_ORDER:${row.id}`, id: row.id, number: row.original_order_no, sourceType: "LEGACY_MYSQL", sourceSystem: row.source_system, sourceId: row.legacy_id, sourceDigest: row.source_digest, kind: "SETTLEMENT", state: "HISTORICAL_ORDER_RECORDED", occurredAt: row.at, importedAt: row.imported_at, ownerId: row.owner_user_id, renterId: row.renter_user_id, accountId: row.account_id, dueCents: amount(row.due), recordedPaidCents: amount(row.recorded_paid), depositCents: amount(row.deposit), originalOrderStatus: row.order_status, originalPaymentStatus: row.pay_status,objectReadable:row.object_readable===true||row.object_readable===1,accountReadable:row.account_readable===true||row.account_readable===1,
      legacySource:{entity:row.source_entity,snapshot:row.source_snapshot,completedAt:row.completed_at??null} });
  }
  if (records.length > 20000) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Finance order reference size limit reached");
  return records;
}
export function matchFinanceOrderReference(entry: { sourceSystem: string; evidence: Record<string, string | null> }, records: FinanceOrderFact[]): FinanceOrderFact[] {
  const id = entry.evidence.originalReference, number = entry.evidence.originalNumber;
  if (!id && !number) return [];
  // Exact source-system + both supplied references. No heuristic ID/number/party merge.
  return records.filter(order => order.sourceType === "LEGACY_MYSQL" && order.sourceSystem === entry.sourceSystem && (!id || order.sourceId === id) && (!number || order.number === number));
}

function nativePaymentFacts(row: Record<string, unknown>): Pick<FinanceOrderFact, 'payment' | 'postingState'> {
 const amountCents=amount(row.accepted_paid),hasReviewPayment=typeof row.has_review_payment==='boolean'?row.has_review_payment:null;
 const present=typeof row.accepted_payment_id==='string'&&amountCents!==null;
 const knownAbsent=row.accepted_payment_id===null&&hasReviewPayment!==null&&!['PAID','COMPLETED'].includes(String(row.status));
 return {payment:{state:present?'SITE_ACCEPTED':knownAbsent?(hasReviewPayment?'REVIEW_REQUIRED':'NO_ACCEPTED_PAYMENT'):'UNAVAILABLE',amountCents:present?amountCents:null,
  confirmedAt:present&&typeof row.paid_at==='string'?row.paid_at:null,source:present&&['CONTROLLED','JOINPAY'].includes(String(row.accepted_source))?String(row.accepted_source):null,hasReviewPayment},postingState:row.has_posting===true?'POSTED':row.has_posting===false?'NOT_POSTED':'UNAVAILABLE'};
}
export function financeOrderLifecycle(order: FinanceOrderFact) {
 return {origin:order.sourceType==='NATIVE'?'NATIVE' as const:'LEGACY_MYSQL' as const,orderStatus:order.originalOrderStatus,
  payment:order.sourceType==='NATIVE'?(order.payment??{state:'UNAVAILABLE' as const,amountCents:null,confirmedAt:null,hasReviewPayment:null})
   :{state:'LEGACY_RECORDED' as const,amountCents:order.recordedPaidCents,confirmedAt:null,hasReviewPayment:null},
  postingState:order.sourceType==='NATIVE'?(order.postingState??'UNAVAILABLE' as const):'LEGACY_OBSERVATION' as const};
}
