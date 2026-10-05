import type { PoolClient } from "pg";
import { exactCents } from "./personal-finance-read";
import { SecurityApiError } from "../auth/security-core";
import { escapeLike } from "../supply/catalog";
import type { FinanceLoadScope } from "./admin-finance-query";

export type FinanceOrderFact = { ref: string; id: string; number: string; sourceType: string; sourceSystem: string; sourceId: string; sourceDigest: string | null; kind: "SETTLEMENT"; state: "ORDER_RECORDED" | "HISTORICAL_ORDER_RECORDED"; occurredAt: string | null; importedAt: string; ownerId: string; renterId: string; accountId: string; dueCents: string | null; recordedPaidCents: string | null; depositCents: string | null; originalOrderStatus: string; originalPaymentStatus: string | null };
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function amount(value: unknown) { try { return exactCents(value); } catch { return null; } }
function scopedOrderSql(sql: string, legacy: boolean, scope: FinanceLoadScope, related: Record<string, any>[]) {
  const values: unknown[] = [], predicates: string[] = [], bind = (value: unknown) => `$${values.push(value)}`;
  if(scope.documentRef){const prefix=legacy?"LEGACY_ORDER:":"ORDER:";predicates.push(scope.documentRef.startsWith(prefix)?`r.id=${bind(scope.documentRef.slice(prefix.length))}`:"FALSE");}
  else if(scope.subjectId){const p=bind(scope.subjectId);predicates.push(`(r.owner_user_id=${p} OR r.renter_user_id=${p})`);}
  else if(scope.filters){const f=scope.filters;if(f.scope!=="ALL"){const p=bind(f.scope);predicates.push(`(r.owner_user_id=${p} OR r.renter_user_id=${p})`);}if(f.bucket!=="ALL"||!["ALL","SETTLEMENT"].includes(f.kind)||!["ALL",legacy?"HISTORICAL_ORDER_RECORDED":"ORDER_RECORDED"].includes(f.state))predicates.push("FALSE");
    if(f.period){const start=bind(`${f.from}T00:00:00+08:00`),end=bind(new Date(Date.parse(`${f.to}T00:00:00+08:00`)+86400_000).toISOString());predicates.push(`(r.at IS NULL OR (r.at::timestamptz>=${start}::timestamptz AND r.at::timestamptz<${end}::timestamptz))`);}
    if(f.q.startsWith("ORDER_LINK:"))predicates.push(`r.id=${bind(f.q.slice(11))}`);else if(f.q){const p=bind(`%${escapeLike(f.q.toLocaleLowerCase("zh-CN"))}%`);predicates.push(`(lower(r.id) LIKE ${p} ESCAPE '\\' OR lower(${legacy?"r.original_order_no":"r.display_no"}) LIKE ${p} ESCAPE '\\' OR lower('${legacy?"LEGACY_ORDER:":"ORDER:"}'||r.id) LIKE ${p} ESCAPE '\\' ${legacy?`OR lower(r.legacy_id) LIKE ${p} ESCAPE '\\'`:""} OR EXISTS(SELECT 1 FROM zzsh_auth_user."user" u WHERE u.id IN(r.owner_user_id,r.renter_user_id) AND (lower(u.id) LIKE ${p} ESCAPE '\\' OR lower(COALESCE(u.name,'')) LIKE ${p} ESCAPE '\\')))`);}}
  const main=predicates.length?predicates.join(" AND "):"TRUE", links:string[]=[];
  if(legacy)for(const row of related){if(row.reference_id||row.reference_no){const fields=[`r.source_system=${bind(row.source_system)}`];if(row.reference_id)fields.push(`r.legacy_id=${bind(row.reference_id)}`);if(row.reference_no)fields.push(`r.original_order_no=${bind(row.reference_no)}`);links.push("("+fields.join(" AND ")+")");}}
  return {text:`WITH finance_order_rows AS (${sql.replace(/\s+ORDER BY id COLLATE "C" LIMIT 20001\s*$/," ")}) SELECT r.* FROM finance_order_rows r WHERE (${main})${links.length?" OR "+links.join(" OR "):""} ORDER BY r.id COLLATE "C" LIMIT 20001`,values};
}
export async function loadFinanceOrderFacts(client: PoolClient, ready: { native_orders?: boolean; legacy_orders?: boolean }, scope: FinanceLoadScope = {}, related: Record<string, any>[] = []): Promise<FinanceOrderFact[]> {
  const records: FinanceOrderFact[] = [];
  if (ready.native_orders) {
    const query=scopedOrderSql(`SELECT id,display_no,owner_user_id,renter_user_id,account_id,status,revision::text,
      (rental_amount_cents+deposit_amount_cents)::text AS due,deposit_amount_cents::text AS deposit,${utc("created_at")} AS at
      FROM zzsh_order.rental_order ORDER BY id COLLATE "C" LIMIT 20001`,false,scope,related);const rows=(await client.query(query.text,query.values)).rows;
    for (const row of rows) records.push({ ref: `ORDER:${row.id}`, id: row.id, number: row.display_no, sourceType: "NATIVE", sourceSystem: "zzsh", sourceId: row.id, sourceDigest: null, kind: "SETTLEMENT", state: "ORDER_RECORDED", occurredAt: row.at, importedAt: row.at, ownerId: row.owner_user_id, renterId: row.renter_user_id, accountId: row.account_id, dueCents: amount(row.due), recordedPaidCents: null, depositCents: amount(row.deposit), originalOrderStatus: row.status, originalPaymentStatus: null });
  }
  if (ready.legacy_orders) {
    const query=scopedOrderSql(`SELECT id,source_system,legacy_id,source_digest,original_order_no,owner_user_id,renter_user_id,account_id,
      due_amount_cents::text AS due,recorded_paid_amount_cents::text AS recorded_paid,deposit_amount_cents::text AS deposit,
      source_order_status::text AS order_status,source_pay_status::text AS pay_status,${utc("source_created_at")} AS at,${utc("imported_at")} AS imported_at
      FROM zzsh_order.legacy_order_read_snapshot ORDER BY id COLLATE "C" LIMIT 20001`,true,scope,related);const rows=(await client.query(query.text,query.values)).rows;
    for (const row of rows) records.push({ ref: `LEGACY_ORDER:${row.id}`, id: row.id, number: row.original_order_no, sourceType: "LEGACY_MYSQL", sourceSystem: row.source_system, sourceId: row.legacy_id, sourceDigest: row.source_digest, kind: "SETTLEMENT", state: "HISTORICAL_ORDER_RECORDED", occurredAt: row.at, importedAt: row.imported_at, ownerId: row.owner_user_id, renterId: row.renter_user_id, accountId: row.account_id, dueCents: amount(row.due), recordedPaidCents: amount(row.recorded_paid), depositCents: amount(row.deposit), originalOrderStatus: row.order_status, originalPaymentStatus: row.pay_status });
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
