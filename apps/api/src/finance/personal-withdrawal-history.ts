import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { conflict, invalid, notFound } from "../supply/supply-util";
import type { ListingCursorKey } from "../supply/listing-cursor";
import type { NativeWithdrawalScope } from "./native-withdrawal-resource";
import { encodeFinanceCursor, decodeFinanceCursor } from "./personal-finance-read";
import { exactCents } from "./finance-money";
import { parsePersonalWithdrawalQuery, readPersonalWithdrawals, type PersonalWithdrawalQuery } from "./personal-withdrawal-read";
import { projectOriginalWithdrawalBankDestination } from "./native-withdrawal-store";

export const PERSONAL_WITHDRAWAL_HISTORY_VERSION = "personal-withdrawals.read.v2";
const STATES = ["RESERVED", "SUBMITTING", "PROCESSING", "UNKNOWN", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "SUCCEEDED", "FAILED"];
type Actor = UserContext & { requestId: string };
export type WithdrawalHistoryQuery = Omit<PersonalWithdrawalQuery, "source"> & { source: PersonalWithdrawalQuery["source"] | "JOINPAY" };
const TABLE = "zzsh_order.joinpay_withdrawal_intent", ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const COLUMNS = ["id", "user_id", "gross_cents", "net_cents", "fee_cents", "currency", "state", "operation_version", "funds_disposition", "requires_review",
  "merchant_order_no", "platform_serial_no", "policy_version", "destination_id", "destination_revision", "admission_canonical", "admission_sha256", "accepted_at", "updated_at", "request_fingerprint"];
const SELECT = `SELECT i.id,i.user_id,i.gross_cents::text,i.net_cents::text,i.fee_cents::text,i.currency,i.state,i.operation_version::text,i.funds_disposition,i.requires_review,
  i.merchant_order_no,i.platform_serial_no,i.policy_version,i.destination_id,i.destination_revision,i.admission_canonical,i.admission_sha256,
  to_char(i.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted_at FROM ${TABLE} i`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Local channel withdrawal evidence is unavailable");
const token = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v) && Number.isFinite(Date.parse(v));

export function parseWithdrawalHistoryQuery(query: URLSearchParams): WithdrawalHistoryQuery {
  if (query.get("source") !== "JOINPAY") return parsePersonalWithdrawalQuery(query);
  for (const name of query.keys()) if (!["source", "state", "limit", "cursor"].includes(name) || query.getAll(name).length !== 1) throw invalid("Unsupported withdrawal history filter");
  const state = query.get("state") ?? "ALL", limit = query.get("limit") ?? "20", cursor = query.get("cursor");
  if (state !== "ALL" && !STATES.includes(state) || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100
    || cursor !== null && (!cursor || cursor.length > 4096)) throw invalid("Invalid withdrawal history query");
  return { source: "JOINPAY", state, limit: Number(limit), cursor };
}
async function ready(c: PoolClient) {
  const r = (await c.query(`SELECT current_database() AS database,current_user AS runtime_user,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,to_regclass($1) IS NOT NULL AS installed,
    (SELECT count(*)=$3::integer FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped
      AND a.attname=ANY($2::text[]) AND has_column_privilege(current_user,a.attrelid,a.attnum,'SELECT'))
    AND EXISTS(SELECT 1 FROM pg_class t JOIN pg_roles p ON p.rolname=current_user WHERE t.oid=to_regclass($1)
      AND t.relkind='r' AND t.relpersistence='p' AND NOT t.relrowsecurity AND NOT p.rolsuper AND NOT p.rolbypassrls) AS ready`, [TABLE, COLUMNS, COLUMNS.length])).rows[0];
  return r?.installed === true && r.ready === true && typeof r.database === "string" && typeof r.runtime_user === "string"
    && typeof r.database_oid === "string" && /^[1-9][0-9]*$/.test(r.database_oid)
    ? { database: r.database as string, runtimeUser: r.runtime_user as string, databaseOid: r.database_oid as string } : null;
}
export function nativeProjection(row: Record<string, any>, userId: string) {
  try {
    if (row.user_id !== userId || !token(row.id) || row.currency !== "CNY" || !timestamp(row.accepted_at) || !token(row.destination_id)
      || typeof row.destination_revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.destination_revision)
      || typeof row.operation_version !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(row.operation_version) || typeof row.requires_review !== "boolean"
      || typeof row.merchant_order_no !== "string" || !/^[A-Za-z0-9]{12,25}$/.test(row.merchant_order_no)
      || !token(row.policy_version) || row.platform_serial_no !== null && !token(row.platform_serial_no)) throw Error();
    const gross = exactCents(row.gross_cents), net = exactCents(row.net_cents), fee = exactCents(row.fee_cents);
    if (BigInt(gross) <= 0n || BigInt(net) <= 0n || BigInt(fee) < 0n || BigInt(gross) > 9999999999999999n || BigInt(gross) !== BigInt(net) + BigInt(fee)) throw Error();
    const knownState = STATES.includes(row.state), disposition = ["RESERVED", "PAYOUT_POSTED", "RELEASE_POSTED"].includes(row.funds_disposition) ? row.funds_disposition as string : "UNKNOWN";
    return { id: "joinpay:" + row.id, source: "JOINPAY" as const, sourceReference: { type: "NATIVE" as const, system: "zzsh", entity: "joinpay_withdrawal_intent", id: row.id as string },
      intentId: row.id as string, amountCents: gross, netCents: net, feeCents: fee, currency: "CNY" as const, state: knownState ? row.state as string : "UNKNOWN",
      operationVersion: row.operation_version as string, fundsDisposition: disposition, requiresReview: row.requires_review as boolean,
      merchantOrderNo: row.merchant_order_no as string, platformSerialNo: row.platform_serial_no as string | null, policyVersion: row.policy_version as string,
      occurredAt: row.accepted_at as string, originalDestination: projectOriginalWithdrawalBankDestination(row as any),
      evidenceLevel: "LOCAL_RECORDS_NOT_REVALIDATED" as const, bankArrival: "UNKNOWN" as const, mayResubmit: false,
      reasonCodes: [...(!knownState ? ["UNKNOWN_NATIVE_WITHDRAWAL_STATE"] : []), ...(disposition === "UNKNOWN" ? ["UNKNOWN_NATIVE_WITHDRAWAL_DISPOSITION"] : [])] };
  } catch { throw unavailable(); }
}
async function nativeRead(c: PoolClient, actor: Actor, query: WithdrawalHistoryQuery, key: ListingCursorKey | undefined, id?: string) {
  // 调用方已重验会话并锁本人行；原Native资金写入口也锁同一行，分开读不会跨过一次合法状态更新。
  const resource = await ready(c);
  if (!resource) {
    if (query.cursor) throw conflict("Channel withdrawal read source changed; reload first page");
    if (id) throw unavailable();
    return { availability: "NOT_INTEGRATED" as const, reasonCodes: ["NATIVE_WITHDRAWAL_READ_NOT_READY"], data: null };
  }
  if (id) {
    const row = (await c.query(SELECT + " WHERE id=$1 AND user_id=$2", [id, actor.userId])).rows[0]; if (!row) throw notFound();
    return { availability: "AVAILABLE" as const, reasonCodes: [], data: { item: nativeProjection(row, actor.userId), scope: "LOCAL_NATIVE_INTENTS_ONLY" as const } };
  }
  const aggregate = (await c.query(`SELECT count(*)::text AS total_count,count(*) FILTER(WHERE $2='ALL' OR state=$2)::text AS filtered_count,
    COALESCE(sum(operation_version),0)::text AS version_sum,to_char(max(updated_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS modified_at
    FROM ${TABLE} WHERE user_id=$1`, [actor.userId, query.state])).rows[0];
  if (![aggregate?.total_count, aggregate?.filtered_count, aggregate?.version_sum].every(v => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v))
    || aggregate.filtered_count !== "0" && aggregate.modified_at === null || aggregate.modified_at !== null && !timestamp(aggregate.modified_at)) throw unavailable();
  const snapshotVersion = "joinpay-withdrawals.read.v1:" + hash([resource, aggregate.total_count, aggregate.version_sum, aggregate.modified_at]);
  const binding = { userId: actor.userId, sessionHash: hash(actor.sessionId), snapshotVersion, bucket: "PERSONAL_WITHDRAWALS:JOINPAY:" + query.state };
  const after = query.cursor ? decodeFinanceCursor(query.cursor, binding, key) : null;
  const asOf = after?.asOf ?? (await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]?.at;
  if (!timestamp(asOf)) throw unavailable();
  const rows = (await c.query(SELECT + ` WHERE user_id=$1 AND accepted_at<=$2::timestamptz AND($3='ALL' OR state=$3)
    AND($4::timestamptz IS NULL OR(accepted_at,id COLLATE "C")<($4::timestamptz,$5 COLLATE "C"))
    ORDER BY accepted_at DESC,id COLLATE "C" DESC LIMIT $6`, [actor.userId, asOf, query.state, after?.position.at ?? null, after?.position.id ?? null, query.limit + 1])).rows;
  const items = rows.slice(0, query.limit).map(row => nativeProjection(row, actor.userId)), last = items.at(-1);
  return { availability: "AVAILABLE" as const, reasonCodes: [], data: { items, count: aggregate.filtered_count as string, scope: "LOCAL_NATIVE_INTENTS_ONLY" as const,
    asOf, snapshotVersion, nextCursor: rows.length > query.limit && last ? encodeFinanceCursor({ at: last.occurredAt, id: last.intentId }, asOf, binding, key) : null } };
}
export async function readJoinpayWithdrawalHistory(pool: Pool, actor: Actor, query: WithdrawalHistoryQuery, key: ListingCursorKey | undefined, id?: string) {
  if (id !== undefined && !token(id)) throw notFound();
  return withTransaction(pool, async c => { await assertUserContextInTransaction(c, actor); return nativeRead(c, actor, query, key, id); });
}
const notRequested = () => ({ availability: "NOT_REQUESTED" as const, reasonCodes: [] as string[], data: null });
export async function readPersonalWithdrawalHistory(pool: Pool, actor: Actor, query: WithdrawalHistoryQuery, key: ListingCursorKey | undefined, controlledScope?: NativeWithdrawalScope, detailId?: string) {
  if (detailId !== undefined) {
    const m = /^(history|controlled|joinpay):([A-Za-z0-9][A-Za-z0-9._:-]{0,179})$/.exec(detailId); if (!m) throw notFound();
    if (m[1] !== "joinpay") return { ...await readPersonalWithdrawals(pool, actor, { source: "ALL", state: "ALL", limit: 20, cursor: null }, key, controlledScope, detailId), contractVersion: PERSONAL_WITHDRAWAL_HISTORY_VERSION };
    const value = await readJoinpayWithdrawalHistory(pool, actor, { ...query, state: "ALL", cursor: null }, key, m[2]);
    return { contractVersion: PERSONAL_WITHDRAWAL_HISTORY_VERSION, subjectId: actor.userId, source: "JOINPAY", ...value };
  }
  const sections = { historical: notRequested() as any, controlled: notRequested() as any, joinpay: notRequested() as any };
  for (const source of ["HISTORICAL", "LOCAL_CONTROLLED", "JOINPAY"] as const) {
    if (query.source !== "ALL" && query.source !== source) continue;
    const name = source === "HISTORICAL" ? "historical" : source === "LOCAL_CONTROLLED" ? "controlled" : "joinpay";
    try {
      if (source === "JOINPAY") sections.joinpay = await readJoinpayWithdrawalHistory(pool, actor, query, key);
      else { const old = await readPersonalWithdrawals(pool, actor, { ...query, source }, key, controlledScope);
        const data = source === "HISTORICAL" ? (old as any).historical : (old as any).controlled;
        sections[name] = { availability: data?.availability ?? "UNAVAILABLE", reasonCodes: !data ? ["WITHDRAWAL_SOURCE_UNAVAILABLE"]
          : source === "LOCAL_CONTROLLED" && data.reason ? [/^[A-Z0-9_]+$/.test(data.reason) ? data.reason : "CONTROLLED_LOCAL_EVIDENCE_UNAVAILABLE"] : [],
          data: source === "LOCAL_CONTROLLED" ? data?.data ?? null : data ?? null };
      }
    } catch (error) {
      if (!(error instanceof SecurityApiError) || error.status !== 503 || error.code !== "EVIDENCE_UNAVAILABLE") throw error;
      if (query.cursor) throw conflict("Withdrawal history evidence changed; reload first page");
      sections[name] = { availability: "UNAVAILABLE", reasonCodes: [source + "_LOCAL_EVIDENCE_UNAVAILABLE"], data: null };
    }
  }
  return { contractVersion: PERSONAL_WITHDRAWAL_HISTORY_VERSION, subjectId: actor.userId, source: query.source, state: query.state, sections };
}

/** 关闭渠道后也可本地读原key；不调用执行器，不将原回执状态当当前状态。 */
export async function recoverJoinpayWithdrawalFromHistory(pool: Pool, actor: Actor, requestKey: unknown) {
  const k = validateIdempotencyKey(requestKey);
  return withTransaction(pool, async c => {
    await assertUserContextInTransaction(c, actor); if (!await ready(c)) throw unavailable();
    const row = (await c.query(SELECT + ` JOIN zzsh_supply.idempotency_record r ON i.id=r.response_body->'intent'->>'id'
      AND i.request_fingerprint=r.request_fingerprint WHERE i.user_id=$1 AND r.scope_key=$2 AND r.key=$3`,
      [actor.userId, JSON.stringify(["user", actor.userId, "joinpay.withdrawal.reserve.v1", null]), k])).rows[0];
    return { contractVersion: PERSONAL_WITHDRAWAL_HISTORY_VERSION, subjectId: actor.userId, source: "JOINPAY", knowledge: row ? "KNOWN" : "UNKNOWN",
      item: row ? nativeProjection(row, actor.userId) : null, mayResubmit: false, receiptMeaning: "CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK" };
  });
}
