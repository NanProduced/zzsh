import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleAdminFinanceRead, type AdminFinanceOptions } from "../src/finance/admin-finance-routes";

function environment(permissions = ["finance.read", "finance.document.read"]) {
  const state = { permissions, connected: 0, auditFailure: false, revokeOnPrepare: false, schemaReady: true, locked: false, passwordChangeRequired: false, authenticated: true, withdrawalsReady: false, operations: [] as Record<string, unknown>[], subjects: [{ id: "u1", name: "用户一" }, { id: "u2", name: "用户二" }], extraLedger: [] as Record<string, unknown>[], audits: [] as Record<string, unknown>[], statements: [] as string[] };
  const query = async (sql: string, values: unknown[] = []) => {
    state.statements.push(sql);
    if(sql.includes("AS finance_version"))return {rows:[{finance_version:createHash("sha256").update(JSON.stringify({subjects:state.subjects,extra:state.extraLedger,operations:state.operations,ready:state.schemaReady,withdrawals:state.withdrawalsReady})).digest("hex")}],rowCount:1};
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (state.auditFailure) throw Error("audit unavailable"); state.audits.push(JSON.parse(String(values[10]))); return { rows: [], rowCount: 1 }; }
    if (sql.includes('SELECT s."locked"')) return { rows: [{ locked: state.locked, twoFactorEnabled: true }], rowCount: 1 };
    if (sql.includes('"zzsh_iam"."admin_security"')) return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: state.passwordChangeRequired }], rowCount: 1 };
    if (sql.includes("WITH role_permissions")) return { rows: state.permissions.map(permissionCode => ({ permissionCode })), rowCount: state.permissions.length };
    if (sql.includes("to_regclass")) return { rows: [{ ready: state.schemaReady, withdrawals: state.withdrawalsReady }], rowCount: 1 };
    if (sql.includes("FROM zzsh_order.withdrawal_intent i")) return { rows: [{ id: "w1", user_id: "u1", state: "UNKNOWN", funds_disposition: "RESERVED", gross_cents: "20000", net_cents: "19600", fee_cents: "400", policy_version: "local-rule1", accepted_at: "2026-10-03T01:00:00.000000Z", operation_version: "3" }], rowCount: 1 };
    if (sql.includes("FROM zzsh_order.withdrawal_provider_fact")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM zzsh_order.controlled_payout_operation")) return { rows: state.operations, rowCount: state.operations.length };
    if (sql.includes("FROM zzsh_order.settlement_ledger_entry l")) {const rows=[
      { id: "reserve-out", account_code: "WALLET_AVAILABLE", subject_id: "u1", subject_name: "用户一", delta: "-20000", at: "2026-10-03T01:00:00.000000Z", event_kind: "RESERVE", source_entity: "withdrawal_intent", source_id: "w1" },
      { id: "reserve-in", account_code: "WALLET_RESERVED", subject_id: "u1", subject_name: "用户一", delta: "20000", at: "2026-10-03T01:00:00.000000Z", event_kind: "RESERVE", source_entity: "withdrawal_intent", source_id: "w1" },
      ...state.extraLedger,
    ];const selected=values.includes("WITHDRAWAL:w1")?rows.filter(row=>row.source_id==="w1"):rows;return {rows:selected.slice(0,20001),rowCount:selected.length};}
    if (sql.includes("FROM zzsh_order.personal_finance_observation")) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM zzsh_auth_user."user" WHERE id=ANY')) { const ids=values[0] as string[]; const rows=state.subjects.filter(subject=>ids.includes(subject.id)); return {rows,rowCount:rows.length}; }
    if (sql.includes('SELECT count(*)::text AS total FROM zzsh_auth_user."user"')) {const needle=String(values[0]).slice(1,-1);return {rows:[{total:String(state.subjects.filter(subject=>subject.id.includes(needle)||subject.name.includes(needle)).length)}],rowCount:1};}
    if (sql.includes('FROM zzsh_auth_user."user" WHERE lower')) {const needle=String(values[0]).slice(1,-1),rows=state.subjects.filter(subject=>subject.id.includes(needle)||subject.name.includes(needle)).slice(Number(values[2]),Number(values[2])+Number(values[1]));return {rows,rowCount:rows.length};}
    if (sql.includes("FROM zzsh_order.wallet_revision r")) return { rows: [{ user_id: "u1", ledger_revision: "1", read_revision: "1", coverage_version: "1", basis_id: "b1" }], rowCount: 1 };
    if (sql.includes("clock_timestamp() AT TIME ZONE")) return { rows: [{ at: "2026-10-03T10:00:00.000000Z" }], rowCount: 1 };
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [], rowCount: 0 };
    throw Error("Unexpected query in boundary test");
  };
  const pool = { query, connect: async () => { state.connected++; if (state.revokeOnPrepare && state.connected > 1) state.permissions = []; return { query, release() {} }; } };
  const options = { pool, apiOrigin: "http://127.0.0.1:4242", adminOrigin: "http://127.0.0.1:4241", userOrigin: "http://127.0.0.1:4240", adminAuth: { api: { getSession: async () => state.authenticated ? { user: { id: "admin1", twoFactorEnabled: true }, session: { id: "session1", locked: state.locked } } : null } }, listingCursorKey: { keyId: "read1", secret: "k".repeat(64) } } as unknown as AdminFinanceOptions;
  return { options, state };
}
async function request(options: AdminFinanceOptions, route: string, query = "") {
  const result = { status: 200, json: undefined as any, bytes: undefined as Buffer | undefined, headers: {} as Record<string, string>, events: new Map<string, () => void>() };
  const response = { headersSent: false, status(code: number) { result.status = code; return this; }, setHeader(name: string, value: string | string[]) { result.headers[name] = Array.isArray(value) ? value.join(",") : value; return this; }, json(body: unknown) { result.json = body; }, send(body: unknown) { assert.ok(Buffer.isBuffer(body)); result.bytes = body; }, end() {}, once(event: string, callback: () => void) { result.events.set(event, callback); } };
  await handleAdminFinanceRead({ method: "GET", originalUrl: `/api/v1/admin/finance/${route}?from=2026-10-03&to=2026-10-03${query ? "&" + query : ""}`, headers: { origin: options.adminOrigin } }, response, options);
  return result;
}
test("complete read does not require role name, user allowlist, agent assignment or group membership", async () => {
  const env = environment(); const period = await request(env.options, "period");
  assert.equal(period.status, 200); assert.equal(period.json.entryCount, 2); assert.equal(period.json.documentCount, 1);
  assert.ok(env.state.statements.some(sql => sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
  assert.ok(env.state.statements.every(sql => !sql.includes("personal_finance_read_scope") && !sql.includes("admin_supply_scope")));
});
test("document capability can locate exact business but cannot read wallet, period or export", async () => {
  const env = environment(["finance.document.read"]);
  for (const route of ["period", "subjects/u1"]) assert.equal((await request(env.options, route)).status, 403);
  assert.equal((await request(env.options, "lookup")).status, 400);
  const lookup = await request(env.options, "lookup", "q=w1"); assert.equal(lookup.status, 200); assert.equal(lookup.json.documents.length, 1); assert.deepEqual(lookup.json.subjects, []);
  const doc = await request(env.options, "documents/WITHDRAWAL%3Aw1"); assert.equal(doc.status, 200); assert.equal(doc.json.entries.length, 2); assert.equal(doc.json.wallet, undefined);
  const exportDenied = await request(env.options, "export", `snapshot=${encodeURIComponent(doc.json.snapshot)}`); assert.equal(exportDenied.status, 403); assert.equal(exportDenied.bytes, undefined);
});
test("complete funds capability does not bypass independent document permission removal", async () => {
  const env = environment(["finance.read"]); assert.equal((await request(env.options, "period")).status, 200);
  assert.equal((await request(env.options, "documents/WITHDRAWAL%3Aw1")).status, 403);
});
test("ordinary user, locked session, missing source and unknown reference remain distinct", async () => {
  const env = environment(); env.state.authenticated = false; assert.equal((await request(env.options, "period")).status, 401);
  env.state.authenticated = true; env.state.locked = true; assert.equal((await request(env.options, "period")).status, 423);
  env.state.locked = false; env.state.schemaReady = false; assert.equal((await request(env.options, "period")).status, 503);
  env.state.schemaReady = true; env.state.passwordChangeRequired = true; assert.equal((await request(env.options, "period")).status, 403); env.state.passwordChangeRequired = false;
  env.state.schemaReady = true; assert.equal((await request(env.options, "documents/WITHDRAWAL%3Amissing")).status, 404);
});
test("durable local operation truth stays separate from unknown intent and invalidates prior snapshot", async () => {
  const env = environment(); env.state.withdrawalsReady = true;
  const first = await request(env.options, "documents/WITHDRAWAL%3Aw1"); assert.equal(first.status, 200); assert.equal(first.json.document.state, "UNKNOWN");
  env.state.operations.push({ id: "op1", intent_id: "w1", final_evidence_digest: "a".repeat(64), at: "2026-10-03T02:00:00.000000Z", outcome: "SUCCEEDED", reference: "local-ref1" });
  const stale = await request(env.options, "documents/WITHDRAWAL%3Aw1", `snapshot=${encodeURIComponent(first.json.snapshot)}`); assert.equal(stale.status, 409);
  const current = await request(env.options, "documents/WITHDRAWAL%3Aw1"); assert.equal(current.json.document.state, "UNKNOWN"); assert.equal(current.json.evidence.fundsDisposition, "RESERVED"); assert.equal(current.json.evidence.originalOperationOutcome, "SUCCEEDED"); assert.ok(current.json.reasonCodes.includes("LOCAL_OPERATION_NOT_APPLIED"));
});
test("revoke after consistent read but before JSON delivery cannot return private rows", async () => {
  const env = environment(); env.state.revokeOnPrepare = true;
  const result = await request(env.options, "period"); assert.equal(result.status, 403); assert.equal(result.json.entries, undefined); assert.equal(result.bytes, undefined);
});
test("pagination/export require original snapshot and changes invalidate instead of stitching", async () => {
  const env = environment(); assert.equal((await request(env.options, "period", "page=2")).status, 400);
  assert.equal((await request(env.options, "export")).status, 400);
  const first = await request(env.options, "period");
  const changed = await request(env.options, "period", `scope=u2&snapshot=${encodeURIComponent(first.json.snapshot)}`); assert.equal(changed.status, 409); assert.equal(changed.json.entries, undefined);
});
test("new subject or older off-page cross-subject ledger fact invalidates an unchanged filtered page", async () => {
  for (const added of ["subject", "ledger"] as const) {
    const env = environment(); const first = await request(env.options, "period");
    if (added === "subject") env.state.subjects.push({ id: "u3", name: "用户三" });
    else env.state.extraLedger.push({ id: "outside-period", account_code: "WALLET_AVAILABLE", subject_id: "u3", subject_name: "用户三", delta: "100", at: "2026-10-01T00:00:00.000000Z", event_kind: "OPENING", basis_id: "b3" });
    const next = await request(env.options, "period", `snapshot=${encodeURIComponent(first.json.snapshot)}`);
    assert.equal(next.status, 409); assert.equal(next.json.entries, undefined);
  }
});
test("all-page CSV follows prepared audit commit and server completion never claims client saved", async () => {
  const env = environment(); const first = await request(env.options, "period", "pageSize=1");
  const exported = await request(env.options, "export", `snapshot=${encodeURIComponent(first.json.snapshot)}`);
  assert.equal(exported.status, 200); assert.equal(exported.headers["X-Finance-Row-Count"], "2"); assert.equal(exported.headers["X-Finance-Export-Phase"], "PREPARED"); assert.ok(exported.bytes);
  assert.equal(env.state.audits[0]!.phase, "PREPARED");
  const insert = env.state.statements.findIndex(sql => sql.includes('INSERT INTO "zzsh_iam"."audit_event"')); assert.ok(env.state.statements.slice(insert + 1).includes("COMMIT"));
  exported.events.get("finish")?.(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.state.audits[1]!.phase, "SERVER_FINISHED"); assert.equal(env.state.audits[1]!.clientSaved, "UNCONFIRMED");
});
test("audit preparation failure or revoke between generation and preparation sends no file", async () => {
  for (const mode of ["audit", "revoke"] as const) {
    const env = environment(); const first = await request(env.options, "period");
    env.state.auditFailure = mode === "audit"; env.state.revokeOnPrepare = mode === "revoke"; env.state.connected = 0;
    const exported = await request(env.options, "export", `snapshot=${encodeURIComponent(first.json.snapshot)}`);
    assert.equal(exported.status, mode === "audit" ? 500 : 403); assert.equal(exported.bytes, undefined); assert.equal(exported.headers["Content-Disposition"], undefined);
  }
});
test("6000 unrelated subjects and 25001 unrelated ledger facts do not block exact document",async()=>{
 const env=environment();env.state.subjects.push(...Array.from({length:6000},(_,n)=>({id:`other_${n}`,name:"其他用户"})));
 env.state.extraLedger.push(...Array.from({length:25001},(_,n)=>({id:`extra_${n}`,account_code:"WALLET_AVAILABLE",subject_id:`other_${n%6000}`,subject_name:"其他用户",delta:"1",at:"2026-10-03T01:00:00.000000Z",event_kind:"RESERVE",source_entity:"withdrawal_intent",source_id:`other_intent_${n}`})));
 const doc=await request(env.options,"documents/WITHDRAWAL%3Aw1");assert.equal(doc.status,200);assert.equal(doc.json.entries.length,2);assert.ok(env.state.statements.some(sql=>sql.includes('WHERE id=ANY($1::text[])')));assert.ok(!env.state.statements.some(sql=>/user.*LIMIT \$1/.test(sql)));
});
test("over 20000 matching facts fail explicitly without partial CSV or audit, selected pages export one scope",async()=>{
 const env=environment();const first=await request(env.options,"period","pageSize=1");const next=await request(env.options,"period",`page=2&pageSize=1&snapshot=${encodeURIComponent(first.json.snapshot)}`);assert.equal(next.status,200);assert.equal(next.json.entries.length,1);assert.equal(next.json.entryCount,2);
 const exported=await request(env.options,"export",`snapshot=${encodeURIComponent(first.json.snapshot)}`);assert.equal(exported.headers["X-Finance-Row-Count"],"2");
 env.state.extraLedger.push(...Array.from({length:20001},(_,n)=>({id:`matching_${n}`,account_code:"WALLET_AVAILABLE",subject_id:"u1",subject_name:"用户一",delta:"1",at:"2026-10-03T01:00:00.000000Z",source_entity:"withdrawal_intent",source_id:`m_${n}`})));
 const beforeAudit=env.state.audits.length;const over=await request(env.options,"export",`snapshot=${encodeURIComponent(first.json.snapshot)}`);assert.equal(over.status,503);assert.equal(over.bytes,undefined);assert.equal(over.headers["Content-Disposition"],undefined);assert.equal(env.state.audits.length,beforeAudit);assert.equal(over.json.error.details[0].path,"finance.matchingLimit.20000");
});
