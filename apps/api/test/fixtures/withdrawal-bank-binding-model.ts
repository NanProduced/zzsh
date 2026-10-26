// SYNTHETIC_COMPONENT_ONLY：无socket内存事务替身，不能证明PG锁或真实银行验证。
import type { Pool, PoolClient } from "pg";
import type { WithdrawalBankBindingOptions } from "../../src/finance/withdrawal-bank-binding";

export const actor = { userId: "unit_bank_user", sessionId: "unit_bank_session", requestId: "unit_bank_request" };
export const input = { name: "虚构用户", cardNo: "0000000000000015", expectedRevision: "0" };
type Data = { banks: Map<string, any>; receipts: Map<string, any>; audits: unknown[][] };
export function fixture() {
  let data: Data = { banks: new Map(), receipts: new Map(), audits: [] }, staged: Data | null = null, keys = 0;
  const state = { integrated: true, database: "unit_bank_database", runtimeUser: "unit_bank_r", authenticated: true,
    identityRow: { accountStatus: "ACTIVE", identityStatus: "UNVERIFIED", ageStatus: "UNKNOWN", provider: "fake", providerReference: "unit_ref", version: 1, verifiedAt: "2026-10-25T00:00:00.000Z", now: "2026-10-25T02:00:00.000Z" },
    quotaUsed: "0",
    failAudit: false, commitUnknown: false, casFailure: false, queries: [] as { sql: string; values: any[] }[], releases: [] as unknown[] };
  const current = () => staged ?? data;
  const client = { release(value?: unknown) { state.releases.push(value); }, async query(sql: string, values: any[] = []) {
    state.queries.push({ sql, values });
    if (sql === "BEGIN") { staged = structuredClone(data); return { rows: [] }; }
    if (sql === "COMMIT") { if (staged) data = staged; staged = null; if (state.commitUnknown) throw Error("unit lost commit response"); return { rows: [] }; }
    if (sql === "ROLLBACK") { staged = null; return { rows: [] }; }
    if (sql.startsWith("SELECT current_database()")) return { rows: [{ database: state.database, runtime_user: state.runtimeUser, ready: state.integrated }] };
    if (sql.startsWith('SELECT "suspended"')) return { rows: state.authenticated ? [{ suspended: false }] : [] };
    if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [{ ...state.identityRow }] };
    if (sql.includes('FROM "zzsh_auth_user"."session"')) return { rows: [], rowCount: state.authenticated ? 1 : 0 };
    if (sql.includes("SELECT count(*)::text AS count FROM zzsh_order.joinpay_withdrawal_intent")) return { rows: [{ count: state.quotaUsed }] };
    if (sql.includes('SELECT "request_fingerprint" AS "requestFingerprint"')) {
      const r = current().receipts.get(JSON.stringify(values)); return { rows: r ? [structuredClone(r)] : [] };
    }
    if (sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')) {
      current().receipts.set(JSON.stringify(values.slice(0, 2)), { requestFingerprint: values[2], responseStatus: values[3], responseBody: JSON.parse(values[4]), publishRequired: values[5] }); return { rows: [] };
    }
    if (sql.startsWith("SELECT b.id FROM zzsh_supply.idempotency_record")) {
      const r = current().receipts.get(JSON.stringify(values.slice(0, 2))), b = current().banks.get(values[2]);
      return { rows: b && b.id === r?.responseBody?.binding?.id ? [{ id: b.id }] : [] };
    }
    if (sql.startsWith("SELECT response_body FROM zzsh_supply.idempotency_record")) {
      const r = current().receipts.get(JSON.stringify(values)); return { rows: r ? [{ response_body: structuredClone(r.responseBody) }] : [] };
    }
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (sql.startsWith("SELECT id,user_id,revision::text")) {
      const r = current().banks.get(values[0]); if (!r) return { rows: [] };
      const row = structuredClone(r); if (!sql.includes(",sealed_details")) delete row.sealed_details; return { rows: [row] };
    }
    if (sql.startsWith("INSERT INTO zzsh_order.withdrawal_bank_binding") || sql.startsWith("UPDATE zzsh_order.withdrawal_bank_binding")) {
      const old = current().banks.get(values[1]);
      if (state.casFailure || sql.startsWith("UPDATE") && (!old || old.id !== values[0] || old.revision !== values[6])) return { rows: [] };
      const row = { id: values[0], user_id: values[1], revision: values[2], sealed_details: values[3], card_mask: values[4], holder_mask: values[5], updated_at: "2026-10-25T01:00:00.000000Z" };
      current().banks.set(values[1], row); return { rows: [structuredClone(row)] };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (state.failAudit) throw Error("unit audit failure"); current().audits.push(values); return { rows: [] }; }
    throw Error("UNEXPECTED_BANK_COMPONENT_SQL");
  } } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const originalKey = Buffer.alloc(32, 17);
  const options: WithdrawalBankBindingOptions = { database: state.database, runtimeUser: state.runtimeUser,
    protection: { currentKeyVersion: "unit_storage_key", keyFor: () => { keys++; return originalKey; } } };
  return { state, client, pool, options, originalKey, data: () => data, keys: () => keys };
}
