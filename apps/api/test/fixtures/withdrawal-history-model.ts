// SYNTHETIC_LOCAL_HISTORY：只支持固定SELECT的内存模型，不是PG快照/并发/资金证据。
import { createHash } from "node:crypto";
import { fixture as bankFixture, actor } from "./withdrawal-bank-binding-model";
export { actor };
export const cursorKey = { keyId: "unit_history", secret: "synthetic_history_cursor_key_not_production_01" };
export function nativeRow(letter: string, at = "2026-10-25T02:00:00.000000Z", userId = actor.userId) {
  const id = "jwd_" + letter.repeat(40), destination = "bank_" + "a".repeat(32), canonical = JSON.stringify({ userId, target: { userId, destinationId: destination, revision: "1",
    mask: "**** **** 0015", receiverAccountNoEnc: "0000000000000015", receiverNameEnc: "虚构用户" } });
  return { id, user_id: userId, gross_cents: "10000", net_cents: "9900", fee_cents: "100", currency: "CNY", state: "UNKNOWN", operation_version: "1", funds_disposition: "RESERVED", requires_review: false,
    merchant_order_no: "W" + letter.repeat(24), platform_serial_no: null, policy_version: "unit_policy", destination_id: destination, destination_revision: "1", admission_canonical: canonical,
    admission_sha256: createHash("sha256").update(canonical).digest("hex"), accepted_at: at, updated_at: at };
}
export function fixture(rows: Record<string, any>[] = []) {
  const f = bankFixture(), base = f.client.query.bind(f.client), trace: { sql: string; values: any[] }[] = [];
  const state = { ready: true, installed: true, database: f.options.database, runtimeUser: f.options.runtimeUser, databaseOid: "12345", now: "2026-10-25T03:00:00.000000Z", rows, injectForeign: false, receipts: new Map<string, string>() };
  (f.client as any).query = async (sql: string, values: any[] = []) => {
    trace.push({ sql, values });
    if (sql.includes("to_regclass($1) IS NOT NULL AS installed")) return { rows: [{ installed: state.installed, ready: state.ready, database: state.database, runtime_user: state.runtimeUser, database_oid: state.databaseOid }] };
    if (sql.startsWith("SELECT count(*)::text AS total_count")) {
      const own = state.rows.filter(r => r.user_id === values[0]), filtered = own.filter(r => values[1] === "ALL" || r.state === values[1]);
      return { rows: [{ total_count: String(own.length), filtered_count: String(filtered.length), version_sum: own.reduce((s, r) => s + BigInt(r.operation_version), 0n).toString(), modified_at: own.length ? own.map(r => r.updated_at).sort().at(-1)! : null }] };
    }
    if (sql.startsWith("SELECT to_char(clock_timestamp()")) return { rows: [{ at: state.now }] };
    if (sql.startsWith("SELECT i.id,i.user_id")) {
      if (sql.includes("JOIN zzsh_supply.idempotency_record")) {
        const id = state.receipts.get(values[0] + ":" + values[2]); const r = state.rows.find(r => r.user_id === values[0] && r.id === id); return { rows: r ? [structuredClone(r)] : [] };
      }
      if (sql.includes(" WHERE id=$1 AND user_id=$2")) {
        const r = state.rows.find(r => r.id === values[0] && r.user_id === values[1]); return { rows: r ? [structuredClone(r)] : [] };
      }
      if (state.injectForeign) return { rows: [nativeRow("f", undefined, "unit_foreign_user")] };
      const found = state.rows.filter(r => r.user_id === values[0] && r.accepted_at <= values[1] && (values[2] === "ALL" || r.state === values[2])
        && (values[3] === null || r.accepted_at < values[3] || r.accepted_at === values[3] && r.id < values[4]))
        .sort((a, b) => a.accepted_at === b.accepted_at ? b.id.localeCompare(a.id) : b.accepted_at.localeCompare(a.accepted_at)).slice(0, values[5]);
      return { rows: structuredClone(found) };
    }
    return base(sql, values);
  };
  return { ...f, trace, history: state };
}
