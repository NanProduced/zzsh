import type { PoolClient } from "pg";
import { gameScopeSql, noGameScopeError } from "../auth/admin-scope";
import { SecurityApiError } from "../auth/security-core";

export type UserConsumptionComponents = {
  haffRentCents: string | null;
  itemConsumptionCents: string | null;
  earlyMakeupCents: string | null;
  renterFeeCents: string | null;
};
export type AdminUserConsumptionItem = UserConsumptionComponents & {
  orderId: string; displayNo: string; gameId: string; postingId: string;
  settlementVersionId: string; versionHash: string; postedAt: string;
  documentRef: string; knowledge: "KNOWN" | "UNKNOWN"; amountCents: string | null; reasonCodes: string[];
};
export type AdminUserConsumption = {
  contractVersion: "admin-user-consumption.v1"; subjectId: string; currency: "CNY"; amountUnit: "CENT";
  scope: "CURRENT_POSTED_NATIVE_SETTLEMENTS"; asOfUtc: string;
  knowledge: "KNOWN" | "UNKNOWN"; amountCents: string | null; knownAmountCents: string;
  components: UserConsumptionComponents; total: number; unknownCount: number; page: number; pageSize: number;
  items: AdminUserConsumptionItem[];
  legacyHistory: { knowledge: "UNKNOWN"; amountCents: null; reason: "LEGACY_COMPONENT_BREAKDOWN_NOT_AVAILABLE" };
};

const invalid = () => new SecurityApiError(400, "INVALID_ARGUMENT", "User consumption query is invalid");
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "User consumption evidence is unavailable");
const keys = ["haffRentCents", "itemConsumptionCents", "earlyMakeupCents", "renterFeeCents"] as const;
const utc = (field: string) => `to_char(${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const snapshotCents = (field: string) => `CASE WHEN jsonb_typeof(s.input_snapshot #> '{amounts,${field}}')='string'
  AND (s.input_snapshot #>> '{amounts,${field}}') ~ '^(0|[1-9][0-9]{0,21})\\.[0-9]{2}$'
  THEN ((s.input_snapshot #>> '{amounts,${field}}')::numeric * 100)::numeric(24,0) END`;

/** One immutable posting per order; never join the ledger's multiple lines into the consumption sum. */
export const ADMIN_USER_CONSUMPTION_SQL = `WITH source AS MATERIALIZED (
  SELECT o.id AS order_id,o.display_no,o.game_id,o.renter_user_id,o.owner_user_id,o.status,o.paid_confirmation_id,
    p.id AS posting_id,p.settlement_version_id,p.payment_confirmation_id,p.version_hash,p.early,p.currency,
    p.captured_cents,p.system_renter_refund_cents,p.renter_refund_cents,p.compensation_fee_cents,p.posted_at,
    v.order_id AS version_order_id,v.kind,v.version_hash AS snapshot_hash,v.superseded_at,v.input_snapshot,v.computation,
    pay.order_id AS payment_order_id,pay.disposition,pay.amount_cents AS paid_cents,pay.currency AS paid_currency
  FROM zzsh_order.rental_order o
  JOIN zzsh_order.settlement_posting p ON p.order_id=o.id
  LEFT JOIN zzsh_order.settlement_version v ON v.id=p.settlement_version_id
  LEFT JOIN zzsh_order.payment_confirmation pay ON pay.id=p.payment_confirmation_id
  WHERE o.renter_user_id=$1 AND ${gameScopeSql("o.game_id", "$2", "$3")}
), amounts AS MATERIALIZED (
  SELECT s.*,${snapshotCents("haffConsumedBuyer")} AS haff,
    ${snapshotCents("itemConsumedBuyer")} AS items,${snapshotCents("earlyMakeup")} AS makeup,
    ${snapshotCents("feeAmount")} AS fee,${snapshotCents("renterCharge")} AS charge,
    s.input_snapshot #>> '{amounts,feePayer}' AS fee_payer
  FROM source s
), checked AS MATERIALIZED (
  SELECT a.*,array_remove(ARRAY[
    CASE WHEN a.status IS DISTINCT FROM 'COMPLETED' OR a.paid_confirmation_id IS DISTINCT FROM a.payment_confirmation_id
      OR a.version_order_id IS DISTINCT FROM a.order_id OR a.snapshot_hash IS DISTINCT FROM a.version_hash
      OR a.superseded_at IS NOT NULL OR a.payment_order_id IS DISTINCT FROM a.order_id
      OR a.disposition IS DISTINCT FROM 'APPLIED' OR a.paid_currency IS DISTINCT FROM 'CNY'
      OR a.currency IS DISTINCT FROM 'CNY' OR a.paid_cents IS DISTINCT FROM a.captured_cents
      THEN 'POSTING_BINDING_INVALID' END,
    CASE WHEN a.input_snapshot->>'schema' IS DISTINCT FROM 'settlement-version-v2'
      OR a.input_snapshot->>'orderId' IS DISTINCT FROM a.order_id
      OR a.input_snapshot->>'renterUserId' IS DISTINCT FROM a.renter_user_id
      OR a.input_snapshot->>'ownerUserId' IS DISTINCT FROM a.owner_user_id
      OR a.input_snapshot->>'kind' IS DISTINCT FROM a.kind
      OR a.input_snapshot->>'early' IS DISTINCT FROM a.early::text
      OR a.computation->>'ok' IS DISTINCT FROM 'true'
      OR a.computation #>> '{amounts,haffConsumedBuyer,amount}' IS DISTINCT FROM a.input_snapshot #>> '{amounts,haffConsumedBuyer}'
      OR a.computation #>> '{amounts,itemConsumedBuyer,amount}' IS DISTINCT FROM a.input_snapshot #>> '{amounts,itemConsumedBuyer}'
      OR a.computation #>> '{amounts,earlyMakeup,amount}' IS DISTINCT FROM a.input_snapshot #>> '{amounts,earlyMakeup}'
      OR a.computation #>> '{amounts,feeAmount,amount}' IS DISTINCT FROM a.input_snapshot #>> '{amounts,feeAmount}'
      OR a.computation #>> '{amounts,feePayer}' IS DISTINCT FROM a.input_snapshot #>> '{amounts,feePayer}'
      OR a.computation #>> '{amounts,renterCharge,amount}' IS DISTINCT FROM a.input_snapshot #>> '{amounts,renterCharge}'
      THEN 'SETTLEMENT_SNAPSHOT_INVALID' END,
    CASE WHEN a.haff IS NULL OR a.items IS NULL OR a.makeup IS NULL OR a.fee IS NULL OR a.charge IS NULL
      OR a.fee_payer IS NULL OR a.fee_payer NOT IN ('RENTER','OWNER','NONE')
      OR a.fee_payer='NONE' AND a.fee<>0
      OR a.fee IS DISTINCT FROM a.compensation_fee_cents
      OR a.haff+a.items+a.makeup+CASE WHEN a.fee_payer='RENTER' THEN a.fee ELSE 0 END IS DISTINCT FROM a.charge
      OR a.makeup<>0 AND (a.input_snapshot->>'endReason' IS DISTINCT FROM 'TENANT_VOLUNTARY_EARLY' OR NOT a.early)
      THEN 'CONSUMPTION_COMPONENTS_INVALID' END,
    CASE WHEN a.kind='MANUAL_ADJUSTMENT' AND a.renter_refund_cents IS DISTINCT FROM a.system_renter_refund_cents
      THEN 'MANUAL_RENTER_ADJUSTMENT_UNALLOCATED' END
    ],NULL) AS reasons
  FROM amounts a
), eligible AS MATERIALIZED (
  SELECT c.*,cardinality(c.reasons)=0 AS known,
    c.haff+c.items+c.makeup+CASE WHEN c.fee_payer='RENTER' THEN c.fee ELSE 0 END AS total_cents
  FROM checked c
), totals AS (
  SELECT count(*)::text AS total,count(*) FILTER(WHERE NOT known)::text AS unknown_count,
    COALESCE(sum(total_cents) FILTER(WHERE known),0)::text AS known_amount,
    COALESCE(sum(haff) FILTER(WHERE known),0)::text AS haff,
    COALESCE(sum(items) FILTER(WHERE known),0)::text AS items,
    COALESCE(sum(makeup) FILTER(WHERE known),0)::text AS makeup,
    COALESCE(sum(CASE WHEN fee_payer='RENTER' THEN fee ELSE 0 END) FILTER(WHERE known),0)::text AS renter_fee
  FROM eligible
), page AS (
  SELECT * FROM eligible ORDER BY posted_at DESC,posting_id COLLATE "C" DESC LIMIT $4 OFFSET $5
)
SELECT ${utc("statement_timestamp()")} AS "asOfUtc",row_to_json(t) AS summary,
  COALESCE((SELECT json_agg(json_build_object(
    'orderId',p.order_id,'displayNo',p.display_no,'gameId',p.game_id,'postingId',p.posting_id,
    'settlementVersionId',p.settlement_version_id,'versionHash',p.version_hash,'postedAt',${utc("p.posted_at")},
    'documentRef','ORDER:'||p.order_id,'knowledge',CASE WHEN p.known THEN 'KNOWN' ELSE 'UNKNOWN' END,
    'amountCents',CASE WHEN p.known THEN p.total_cents::text END,
    'haffRentCents',CASE WHEN p.known THEN p.haff::text END,
    'itemConsumptionCents',CASE WHEN p.known THEN p.items::text END,
    'earlyMakeupCents',CASE WHEN p.known THEN p.makeup::text END,
    'renterFeeCents',CASE WHEN p.known THEN (CASE WHEN p.fee_payer='RENTER' THEN p.fee ELSE 0 END)::text END,
    'reasonCodes',p.reasons) ORDER BY p.posted_at DESC,p.posting_id COLLATE "C" DESC) FROM page p),'[]'::json) AS items
FROM totals t`;

function count(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw unavailable();
  return Number(value);
}
function cents(value: unknown): string {
  // Aggregates can exceed a single source row's numeric(24,0) precision.
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw unavailable();
  return value;
}
function verifyComponents(row: UserConsumptionComponents & { amountCents: string | null; knowledge: string }): void {
  if (row.knowledge === "UNKNOWN") {
    if (row.amountCents !== null || keys.some(key => row[key] !== null)) throw unavailable();
    return;
  }
  if (row.knowledge !== "KNOWN" || keys.reduce((sum,key) => sum + BigInt(cents(row[key])),0n) !== BigInt(cents(row.amountCents))) throw unavailable();
}

/** The caller authenticates the directory subject and runs this inside its read transaction. */
export async function readAdminUserConsumption(
  client: PoolClient,
  viewer: { adminId: string; isBoss: boolean; subjectFinancialRead: boolean; businessScopeUsable?: boolean },
  userId: string,
  query: { page?: number; pageSize?: number } = {},
): Promise<AdminUserConsumption> {
  if (!viewer.subjectFinancialRead && !viewer.isBoss) throw new SecurityApiError(403, "FORBIDDEN", "User financial reading permission is required");
  if (viewer.businessScopeUsable === false && !viewer.isBoss) throw noGameScopeError();
  const page = query.page ?? 1, pageSize = query.pageSize ?? 20, offset = (page-1)*pageSize;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId) || !Number.isSafeInteger(page) || page < 1
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(offset)) throw invalid();
  const result = (await client.query(ADMIN_USER_CONSUMPTION_SQL,[userId,viewer.adminId,viewer.isBoss,pageSize,offset])).rows[0];
  if (!result || typeof result.asOfUtc !== "string" || !Number.isFinite(Date.parse(result.asOfUtc))
    || !result.summary || !Array.isArray(result.items)) throw unavailable();
  const summary = result.summary, total = count(summary.total), unknownCount = count(summary.unknown_count);
  const knownAmountCents = cents(summary.known_amount);
  if (unknownCount > total) throw unavailable();
  const knownComponents = { haffRentCents:cents(summary.haff),itemConsumptionCents:cents(summary.items),
    earlyMakeupCents:cents(summary.makeup),renterFeeCents:cents(summary.renter_fee) };
  verifyComponents({...knownComponents,amountCents:knownAmountCents,knowledge:"KNOWN"});
  if (result.items.length !== Math.min(pageSize,Math.max(0,total-offset))) throw unavailable();
  for (const item of result.items as AdminUserConsumptionItem[]) {
    verifyComponents(item);
    if (!Array.isArray(item.reasonCodes) || item.reasonCodes.some(reason => typeof reason !== "string")
      || item.knowledge === "KNOWN" && item.reasonCodes.length !== 0 || item.knowledge === "UNKNOWN" && item.reasonCodes.length === 0) throw unavailable();
  }
  return {
    contractVersion:"admin-user-consumption.v1",subjectId:userId,currency:"CNY",amountUnit:"CENT",
    scope:"CURRENT_POSTED_NATIVE_SETTLEMENTS",asOfUtc:result.asOfUtc,
    knowledge:unknownCount ? "UNKNOWN" : "KNOWN",amountCents:unknownCount ? null : knownAmountCents,knownAmountCents,
    components:unknownCount ? {haffRentCents:null,itemConsumptionCents:null,earlyMakeupCents:null,renterFeeCents:null} : knownComponents,
    total,unknownCount,page,pageSize,items:result.items,
    legacyHistory:{knowledge:"UNKNOWN",amountCents:null,reason:"LEGACY_COMPONENT_BREAKDOWN_NOT_AVAILABLE"},
  };
}
