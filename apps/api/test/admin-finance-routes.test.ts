import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminFinanceRead, type AdminFinanceOptions } from "../src/finance/admin-finance-routes";
import { FinanceSqlFixture, legacyFinanceOrder } from "./admin-finance-fixture";
import { financeSnapshot } from "../src/finance/admin-finance-read";

function environment(permissions = ["finance.read", "finance.document.read"], financeSql?: FinanceSqlFixture) {
  const state = { permissions, isBoss: false, connected: 0, auditFailure: false, revokeOnPrepare: false, schemaReady: true, locked: false, passwordChangeRequired: false, authenticated: true, withdrawalsReady: false, versionSqlOverride:undefined as string|undefined, beforeSecondTransaction:undefined as (()=>void)|undefined, operations: [] as Record<string, unknown>[], subjects: [{ id: "u1", name: "用户一" }, { id: "u2", name: "用户二" }], extraLedger: [] as Record<string, unknown>[], audits: [] as Record<string, unknown>[], statements: [] as string[] };
  const ledgerRows=()=>[
    { id: "reserve-out", account_code: "WALLET_AVAILABLE", subject_id: "u1", subject_name: "用户一", delta: "-20000", at: "2026-10-03T01:00:00.000000Z", event_kind: "RESERVE", source_entity: "withdrawal_intent", source_id: "w1" },
    { id: "reserve-in", account_code: "WALLET_RESERVED", subject_id: "u1", subject_name: "用户一", delta: "20000", at: "2026-10-03T01:00:00.000000Z", event_kind: "RESERVE", source_entity: "withdrawal_intent", source_id: "w1" },...state.extraLedger,
  ];
  const query = async (sql: string, values: unknown[] = []) => {
    state.statements.push(sql);
    if(sql.includes('finance period complete ledger balances')){
      if(financeSql)return financeSql.query(sql,values);
      const fixture=new FinanceSqlFixture({ledger:ledgerRows(),subjects:state.subjects});try{return fixture.query(sql,values);}finally{fixture.close();}
    }
    if(sql.includes("AS finance_version")){
      if(financeSql)return financeSql.query(state.versionSqlOverride??sql,values);
      const fixture=new FinanceSqlFixture({ledger:ledgerRows(),subjects:state.subjects,operations:state.operations});
      try{return fixture.query(state.versionSqlOverride??sql,values);}finally{fixture.close();}
    }
    if(financeSql&&(sql.startsWith("WITH finance_")||/FROM zzsh_auth_user\."user" WHERE (id=ANY|lower)/.test(sql)))return financeSql.query(sql,values);
    if(sql.startsWith("WITH finance_lookup")){
      const fixture=new FinanceSqlFixture({ledger:ledgerRows(),subjects:state.subjects});
      try{return fixture.query(sql,values);}finally{fixture.close();}
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (state.auditFailure) throw Error("audit unavailable"); state.audits.push(JSON.parse(String(values[10]))); return { rows: [], rowCount: 1 }; }
    if (sql.includes('SELECT s."locked"')) return { rows: [{ locked: state.locked, twoFactorEnabled: true }], rowCount: 1 };
    if (sql.includes('"zzsh_iam"."admin_security"')) return { rows: [{ status: "ACTIVE", isBoss: state.isBoss, passwordChangeRequired: state.passwordChangeRequired }], rowCount: 1 };
    if (sql.includes("WITH role_permissions")) return { rows: state.permissions.map(permissionCode => ({ permissionCode })), rowCount: state.permissions.length };
    if (sql.includes("to_regclass")) return { rows: [{ ready: state.schemaReady, withdrawals: state.withdrawalsReady, native_orders: !!financeSql, legacy_orders: !!financeSql,native_distribution:false,history_coverage:false }], rowCount: 1 };
    if (sql.includes("FROM zzsh_order.withdrawal_intent i")) return { rows: [{ id: "w1", user_id: "u1", state: "UNKNOWN", funds_disposition: "RESERVED", gross_cents: "20000", net_cents: "19600", fee_cents: "400", policy_version: "local-rule1", accepted_at: "2026-10-03T01:00:00.000000Z", operation_version: "3" }], rowCount: 1 };
    if (sql.includes("FROM zzsh_order.withdrawal_provider_fact")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM zzsh_order.controlled_payout_operation")) return { rows: state.operations, rowCount: state.operations.length };
    if (sql.includes("FROM zzsh_order.settlement_ledger_entry l")) {const rows=ledgerRows();const selected=values.includes("WITHDRAWAL:w1")?rows.filter(row=>row.source_id==="w1"):rows;return {rows:selected.slice(0,20001),rowCount:selected.length};}
    if (sql.includes("FROM zzsh_order.personal_finance_observation")) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM zzsh_auth_user."user" WHERE id=ANY')) { const ids=values[0] as string[]; const rows=state.subjects.filter(subject=>ids.includes(subject.id)); return {rows,rowCount:rows.length}; }
    if (sql.includes('SELECT count(*)::text AS total FROM zzsh_auth_user."user"')) {const needle=String(values[0]).slice(1,-1);return {rows:[{total:String(state.subjects.filter(subject=>subject.id.includes(needle)||subject.name.includes(needle)).length)}],rowCount:1};}
    if (sql.includes('FROM zzsh_auth_user."user" WHERE lower')) {const needle=String(values[0]).slice(1,-1),rows=state.subjects.filter(subject=>subject.id.includes(needle)||subject.name.includes(needle)).slice(Number(values[2]),Number(values[2])+Number(values[1]));return {rows,rowCount:rows.length};}
    if (sql.includes("FROM zzsh_order.wallet_revision r")) return { rows: [{ user_id: "u1", ledger_revision: "1", read_revision: "1", coverage_version: "1", basis_id: "b1" }], rowCount: 1 };
    if (sql.includes("clock_timestamp() AT TIME ZONE")) return { rows: [{ at: "2026-10-03T10:00:00.000000Z" }], rowCount: 1 };
    if (sql.startsWith('SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR SHARE')) {if(financeSql){const next=BigInt(financeSql.clusterSnapshot.split(":")[1]!)+1n;financeSql.clusterSnapshot=`${next}:${next}:`;}const rows=state.subjects.filter(subject=>subject.id===values[0]);return {rows,rowCount:rows.length};}
    if (sql.startsWith("SELECT c.origin,")||sql.startsWith('SELECT ledger_revision::text AS "ledgerRevision"')) return {rows:[],rowCount:0};
    if (sql.includes('AS available')&&sql.includes('FROM zzsh_order.settlement_ledger_entry')) return {rows:[{available:"999",reserved:'0',pending:'0',refund:'0'}],rowCount:1};
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql)) return { rows: [], rowCount: 0 };
    throw Error("Unexpected query in boundary test");
  };
  const pool = { query, connect: async () => { state.connected++; if(state.connected===2)state.beforeSecondTransaction?.();if (state.revokeOnPrepare && state.connected > 1) state.permissions = []; return { query, release() {} }; } };
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

test("default lookup over 25000 legacy orders loads only selected pages, including deep and empty tail",async t=>{
 const count=25037,legacy=Array.from({length:count},(_,n)=>legacyFinanceOrder(`old-${String(n).padStart(5,"0")}`));
 const fixture=new FinanceSqlFixture({legacy}),env=environment([],fixture);t.after(()=>fixture.close());env.state.isBoss=true;
 const first=await request(env.options,"lookup","period=0");assert.equal(first.status,200);assert.equal(first.json.documentCount,count);assert.equal(first.json.entryCount,0);assert.equal(first.json.documents.length,20);assert.equal(first.json.hasMore,true);
 assert.equal(first.json.documents[0].ref,"LEGACY_ORDER:old-25036");assert.equal(first.json.documents[19].ref,"LEGACY_ORDER:old-25017");
 for(const [page,size,hasMore]of [[2,20,true],[1252,17,false],[1253,0,false]]as const){
  const result=await request(env.options,"lookup",`period=0&page=${page}&snapshot=${encodeURIComponent(first.json.snapshot)}`);
  assert.equal(result.status,200);assert.equal(result.json.documents.length,size);assert.equal(result.json.documentCount,count);assert.equal(result.json.hasMore,hasMore);
  assert.deepEqual(result.json.documents.map((d:any)=>d.ref),Array.from({length:size},(_,n)=>`LEGACY_ORDER:old-${String(count-1-(page-1)*20-n).padStart(5,"0")}`));
 }
 assert(fixture.reads.every(read=>read.rows<=20),"no full history payload is loaded into the application");assert.equal(env.state.audits.length,0);
 const subject=await request(env.options,"subjects/u1","period=0");assert.equal(subject.status,200);assert.equal(subject.json.wallet.coverage.knowledge,"UNKNOWN");assert.equal(subject.json.wallet.buckets.available.amountCents,null);assert.deepEqual(subject.json.documents,[]);
 assert(fixture.reads.slice(-4).filter(read=>read.family==="orders").every(read=>read.rows===0),"subject wallet does not load all order-only documents");
});

test("mixed lookup deduplicates funds/order refs, preserves source types and equal-time page boundaries",async t=>{
 const legacy=Array.from({length:43},(_,n)=>legacyFinanceOrder(`L${String(n).padStart(2,"0")}`,{original_order_no:n===0?"SHARED":"SN"+n}));
 const native=[{id:"L00",display_no:"SHARED",owner_user_id:"u1",renter_user_id:"u2",account_id:"a1",status:"ENDED",revision:"1",rental_amount_cents:"10000",deposit_amount_cents:"0",created_at:"2026-10-03T01:00:00.000000Z"}];
 const ledger=[{id:"z",account_code:"WALLET_AVAILABLE",subject_id:"u1",subject_name:"用户一",delta:"900719925474099312345",at:"2026-10-03T03:00:00.000000Z",order_id:"L00",display_no:"SHARED",source_id:"p1",posting_id:"p1"},
  {id:"a",account_code:"WALLET_AVAILABLE",subject_id:"u1",subject_name:"用户一",delta:"-1",at:"2026-10-03T02:00:00.000000Z",order_id:"L00",display_no:"SHARED",source_id:"p1",posting_id:"p1"}];
 const history=[{id:"unknown",subject_id:"u1",subject_name:"用户一",source_entity:"la_log_earnings",source_id:"x",source_type:"LEGACY_MYSQL",source_system:"synthetic-legacy",reference_id:"L01",reference_no:"SN1",amount:"bad",action:"9",at:null,imported_at:"2026-10-03T01:00:00.000000Z"}];
 const fixture=new FinanceSqlFixture({legacy,native,ledger,history}),env=environment(undefined,fixture);t.after(()=>fixture.close());
 const expected=["ORDER:L00",...legacy.map(row=>"LEGACY_ORDER:"+row.id).reverse(),"HISTORY_EARNINGS:unknown"],all:string[]=[];
 let snapshot="";
 for(let page=1;page<=3;page++){
  const response=await request(env.options,"lookup",`period=0&page=${page}${snapshot?"&snapshot="+encodeURIComponent(snapshot):""}`);assert.equal(response.status,200);snapshot=response.json.snapshot;
  assert.equal(response.json.documentCount,45);assert.equal(response.json.entryCount,3);assert.equal(response.json.hasMore,page<3);
  all.push(...response.json.documents.map((d:any)=>d.ref));
  if(page===1){const d=response.json.documents[0];assert.equal(d.entryCount,2);assert.equal(d.occurredAt,"2026-10-03T03:00:00.000000Z");assert.equal(d.amounts[0].knownNetCents,"900719925474099312344");}
  if(page===3){const d=response.json.documents.at(-1);assert.equal(d.amounts[0].unknownCount,1);assert.equal(d.amounts[0].knownNetCents,"0");}
 }
 assert.deepEqual(all,expected);assert.equal(new Set(all).size,45);
 const exact=await request(env.options,"lookup","period=0&q=ORDER_LINK%3AL00");assert.equal(exact.status,200);assert.deepEqual(exact.json.documents.map((d:any)=>d.ref),["ORDER:L00","LEGACY_ORDER:L00"]);
 const detail=await request(env.options,"documents/LEGACY_ORDER%3AL00","period=0");assert.equal(detail.status,200);assert.equal(detail.json.evidence.recordedPaidCents,"9000");assert.equal(detail.json.entries.length,0);assert(detail.json.reasonCodes.includes("ORDER_RECORD_NOT_CHANNEL_RESULT"));
 const historical=await request(env.options,"documents/HISTORY_EARNINGS%3Aunknown","period=0");assert.equal(historical.status,200);assert(historical.json.related.some((r:any)=>r.ref==="LEGACY_ORDER:L01"));assert.equal(historical.json.entries[0].deltaCents,null);
 const period=await request(env.options,"period");assert.equal(period.status,200);assert.equal(period.json.entryCount,3);assert(period.json.reconciliation.every((r:any)=>r.knowledge==="KNOWN"&&r.scope==='CURRENT_LEDGER_ONLY'));assert.equal(period.json.reconciliation.find((r:any)=>r.bucket==='AVAILABLE').closingBalance,'900719925474099312344');assert(period.json.gaps.includes('CURRENT_LEDGER_EXCLUDES_UNADMITTED_LEGACY'));
 const filtered=await request(env.options,"lookup","period=0&state=HISTORICAL_ORDER_RECORDED");assert.equal(filtered.status,200);assert.equal(filtered.json.documentCount,43);assert.equal(filtered.json.entryCount,0);
 const byBucket=await request(env.options,"lookup","period=0&bucket=AVAILABLE");assert.equal(byBucket.status,200);assert.equal(byBucket.json.documentCount,2);assert.equal(byBucket.json.entryCount,3);
});

test("SQL lookup uses projected document number and masked name, not unrelated basis or raw display text",async t=>{
 const maskedName="1"+"38"+"0".repeat(8),ledger=[{id:"basis-test",account_code:"WALLET_AVAILABLE",subject_id:"u1",subject_name:maskedName,delta:"10",at:"2026-10-03T00:00:00.000000Z",event_kind:"RESERVE",source_entity:"withdrawal_intent",source_id:"w1",basis_id:"unrelated-basis"}];
 const fixture=new FinanceSqlFixture({ledger,subjects:[{id:"u1",name:maskedName}]}),env=environment(undefined,fixture);t.after(()=>fixture.close());
 const basis=await request(env.options,"lookup","period=0&q=unrelated-basis");assert.equal(basis.status,200);assert.equal(basis.json.documentCount,0);
 const masked=await request(env.options,"lookup","period=0&q="+encodeURIComponent("138****0000"));assert.equal(masked.status,200);assert.equal(masked.json.documentCount,1);assert.equal(masked.json.documents[0].subjects[0].name,"138****0000");
});

test("lookup filters and document-only exact permission act before pagination, including literal wildcard query",async t=>{
 const legacy=Array.from({length:51},(_,n)=>legacyFinanceOrder("id"+n,{original_order_no:n===50?"%_\\target":"SHARED-prefix-"+n,owner_user_id:n===50?"u3":"u1",source_created_at:n===50?null:"2026-10-03T00:00:00.000000Z"}));
 const fixture=new FinanceSqlFixture({legacy}),env=environment(undefined,fixture);t.after(()=>fixture.close());
 const literal=await request(env.options,"lookup","period=0&q="+encodeURIComponent("%_\\"));assert.equal(literal.status,200);assert.equal(literal.json.documentCount,1);assert.equal(literal.json.documents[0].ref,"LEGACY_ORDER:id50");
 const scope=await request(env.options,"lookup","period=0&scope=u3");assert.equal(scope.status,200);assert.equal(scope.json.documentCount,1);assert.equal(scope.json.documents[0].ref,"LEGACY_ORDER:id50");
 const restricted=environment(["finance.document.read"],fixture);
 const partial=await request(restricted.options,"lookup","period=0&q=SHARED");assert.equal(partial.status,200);assert.equal(partial.json.documentCount,0);assert.deepEqual(partial.json.subjects,[]);
 const exact=await request(restricted.options,"lookup","period=0&q="+encodeURIComponent("%_\\target"));assert.equal(exact.status,200);assert.equal(exact.json.documentCount,1);assert.equal(exact.json.documents[0].ref,"LEGACY_ORDER:id50");
 restricted.state.revokeOnPrepare=true;restricted.state.connected=0;const revoked=await request(restricted.options,"lookup","period=0&q="+encodeURIComponent("%_\\target"));assert.equal(revoked.status,403);assert.equal(revoked.json.documents,undefined);
});

test("lookup independently pages subject candidates after documents are exhausted",async t=>{
 const subjects=Array.from({length:45},(_,n)=>({id:`candidate-${String(n).padStart(2,"0")}`,name:"匹配用户"+n}));
 const fixture=new FinanceSqlFixture({subjects}),env=environment(undefined,fixture);t.after(()=>fixture.close());
 const first=await request(env.options,"lookup","period=0&q=candidate");assert.equal(first.status,200);assert.equal(first.json.documentCount,0);assert.equal(first.json.subjectCount,45);assert.equal(first.json.subjects.length,20);assert.equal(first.json.hasMore,true);
 const last=await request(env.options,"lookup",`period=0&q=candidate&page=3&snapshot=${encodeURIComponent(first.json.snapshot)}`);assert.equal(last.status,200);assert.equal(last.json.subjects.length,5);assert.equal(last.json.subjects[0].id,"candidate-40");assert.equal(last.json.hasMore,false);assert.deepEqual(last.json.documents,[]);
});

test("lookup retains the 20000 matched-entry guard inside a selected document",async t=>{
 const ledger=Array.from({length:20001},(_,n)=>({id:"line-"+n,account_code:"WALLET_AVAILABLE",subject_id:"u1",subject_name:"用户一",delta:"1",at:"2026-10-03T00:00:00.000000Z",event_kind:"OPENING",basis_id:"one-large-document"}));
 const fixture=new FinanceSqlFixture({ledger}),env=environment(undefined,fixture);t.after(()=>fixture.close());
 const result=await request(env.options,"lookup","period=0");assert.equal(result.status,503);assert.equal(result.json.documents,undefined);assert.equal(result.json.error.details[0].path,"finance.matchingLimit.20000");assert.equal(env.state.audits.length,0);
});

test("lookup snapshot rejects off-page in-place mutation and filter/access drift; known empty remains valid",async t=>{
 const fixture=new FinanceSqlFixture({legacy:Array.from({length:31},(_,n)=>legacyFinanceOrder(`id${String(n).padStart(2,"0")}`))}),env=environment(undefined,fixture);t.after(()=>fixture.close());
 const first=await request(env.options,"lookup","period=0");assert.equal(first.status,200);
 // Model source replacement evidence; the real legacy table is immutable (0057), no real row is updated.
 fixture.db.prepare("UPDATE zzsh_order.legacy_order_read_snapshot SET recorded_paid_amount_cents='9999',source_digest=? WHERE id='id00'").run("c".repeat(64));
 const changed=await request(env.options,"lookup",`period=0&page=2&snapshot=${encodeURIComponent(first.json.snapshot)}`);assert.equal(changed.status,409);assert.equal(changed.json.documents,undefined);
 const fresh=await request(env.options,"lookup","period=0");assert.equal(fresh.status,200);
 for(const suffix of ["&scope=u2","&bucket=AVAILABLE"]){const response=await request(env.options,"lookup",`period=0&snapshot=${encodeURIComponent(fresh.json.snapshot)}${suffix}`);assert.equal(response.status,409);}
 env.state.permissions=["finance.read"];const access=await request(env.options,"lookup",`period=0&snapshot=${encodeURIComponent(fresh.json.snapshot)}`);assert.equal(access.status,409);
 const empty=await request(env.options,"lookup","period=0&q=no-matching-synthetic-value");assert.equal(empty.status,200);assert.deepEqual(empty.json.documents,[]);assert.equal(empty.json.documentCount,0);assert.equal(empty.json.entryCount,0);assert.equal(empty.json.hasMore,false);
});

test("restored version fixes the original unrelated-cluster counterexample without changing finance rows",async()=>{
 const results=[];
 for(const original of [true,false]){
  const fixture=new FinanceSqlFixture({legacy:[legacyFinanceOrder("stable01"),legacyFinanceOrder("stable02")]}),env=environment(undefined,fixture);
  try{
   if(original)env.state.versionSqlOverride="SELECT 'pg-snapshot-v2:'||md5(current_database()||':'||pg_current_snapshot()::text) AS finance_version";
   const rows=()=>JSON.stringify(fixture.db.prepare("SELECT * FROM zzsh_order.legacy_order_read_snapshot ORDER BY id").all()),before=rows();
   const first=await request(env.options,"lookup","period=0&pageSize=1");assert.equal(first.status,200);
   fixture.clusterSnapshot="101:101:";
   const next=await request(env.options,"lookup",`period=0&pageSize=1&page=2&snapshot=${encodeURIComponent(first.json.snapshot)}`);
   assert.equal(next.status,original?409:200);assert.equal(rows(),before);
   results.push({case:"UNCHANGED_FINANCE_UNRELATED_MVCC_CHANGE",implementation:original?"PRESERVED_PG_SNAPSHOT_V2":"RESTORED_SOURCE_CONTENT",firstStatus:first.status,nextStatus:next.status,financeRowsUnchanged:before===rows(),pass:next.status===200,evidence:"actual route/generated version SQL, SQLite selected relations and modeled cluster counter; not PG"});
  }finally{fixture.close();}
 }
 console.log("AFRC1_VERSION_COUNTEREXAMPLES "+JSON.stringify(results));
});

test("unrelated commits, rolled-back changes and subject read locks preserve content version and pagination",async t=>{
 const fixture=new FinanceSqlFixture({legacy:[legacyFinanceOrder("stable01"),legacyFinanceOrder("stable02")]}),env=environment(undefined,fixture);t.after(()=>fixture.close());
 fixture.db.exec("CREATE TABLE unrelated_audit(id TEXT,detail TEXT)");
 const first=await request(env.options,"lookup","period=0&pageSize=1");assert.equal(first.status,200);
 const next=()=>request(env.options,"lookup",`period=0&pageSize=1&page=2&snapshot=${encodeURIComponent(first.json.snapshot)}`);
 fixture.db.exec("BEGIN; INSERT INTO unrelated_audit VALUES('unrelated','committed'); COMMIT");fixture.clusterSnapshot="101:101:";
 assert.equal((await next()).status,200);
 fixture.db.exec("BEGIN; UPDATE unrelated_audit SET detail='discarded'; ROLLBACK");fixture.clusterSnapshot="102:102:";
 assert.equal((await next()).status,200);
 // Simulate a failed source transaction in memory; no real immutable source is mutated.
 fixture.db.exec("BEGIN; DELETE FROM zzsh_order.legacy_order_read_snapshot WHERE id='stable01'; ROLLBACK");fixture.clusterSnapshot="103:103:";
 const afterRollback=await next();assert.equal(afterRollback.status,200);assert.equal(afterRollback.json.snapshotVersion,first.json.snapshotVersion);
 const subject=await request(env.options,"subjects/u1","period=0");assert.equal(subject.status,200);assert(env.state.statements.some(sql=>sql.includes("FOR SHARE")));
 const returned=await next();assert.equal(returned.status,200);assert.equal(returned.json.snapshotVersion,first.json.snapshotVersion);assert.equal(returned.json.documents[0].ref,"LEGACY_ORDER:stable01");
});

test("source-content version invalidates additions, deletions and non-last off-page dependencies across all finance sources",async()=>{
 const mutations:[string,string][]=[
  ["legacy-added","INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_digest,binding_digest) VALUES('new-source','digest-new','binding-new')"],
  ["legacy-deleted","DELETE FROM zzsh_order.legacy_order_read_snapshot WHERE id='id00'"],
  ["legacy-off-page-digest","UPDATE zzsh_order.legacy_order_read_snapshot SET source_digest='changed-source' WHERE id='id00'"],
  ["legacy-binding","UPDATE zzsh_order.legacy_order_read_snapshot SET binding_digest='changed-binding' WHERE id='id00'"],
  ["native-revision","UPDATE zzsh_order.rental_order SET revision='2',status='ENDED' WHERE id='n00'"],
  ["ledger-content","UPDATE fixture_ledger SET credit_cents='999' WHERE id='a-line'"],
  ["historical-observation","UPDATE fixture_history SET source_digest='changed-history' WHERE id='h00'"],
  ["wallet-revision","INSERT INTO zzsh_order.wallet_revision VALUES('u1','1','2')"],
  ["wallet-coverage","INSERT INTO zzsh_order.wallet_coverage VALUES('u1','basis1','1')"],
  ["opening-basis","INSERT INTO zzsh_order.finance_opening_basis VALUES('basis1','source','covered-set','cutoff')"],
  ["economic-root","INSERT INTO zzsh_order.finance_economic_root VALUES('root1','source','policy1')"],
  ["posting-version","INSERT INTO zzsh_order.settlement_posting VALUES('post1','changed-version')"],
  ["withdrawal-version","UPDATE zzsh_order.withdrawal_intent SET operation_version='2',state='PROCESSING' WHERE id='w1'"],
  ["provider-fact","INSERT INTO zzsh_order.withdrawal_provider_fact VALUES('fact1','source-evidence')"],
  ["controlled-operation","INSERT INTO zzsh_order.controlled_payout_operation VALUES('operation1','final-evidence')"],
  ["subject-display","UPDATE zzsh_auth_user.\"user\" SET name='changed display' WHERE id='u1'"],
 ];
 for(const [name,sql]of mutations){
  const fixture=new FinanceSqlFixture({legacy:Array.from({length:31},(_,n)=>legacyFinanceOrder(`id${String(n).padStart(2,"0")}`)),
   native:[{id:"n00",display_no:"NATIVE",owner_user_id:"u1",renter_user_id:"u2",account_id:"a1",revision:"1",status:"RUNNING",rental_amount_cents:"100",deposit_amount_cents:"0",created_at:"2026-10-01T00:00:00.000000Z"}],
   ledger:[{id:"a-line",account_code:"WALLET_AVAILABLE",subject_id:"u1",subject_name:"用户一",delta:"1",at:"2026-10-01T00:00:00.000000Z",source_id:"w1",source_entity:"withdrawal_intent"}],
   history:[{id:"h00",subject_id:"u1",subject_name:"用户一",source_entity:"la_log_earnings",source_id:"source1",source_digest:"old-history",amount:"1.00",action:"1",at:"2026-10-01T00:00:00.000000Z"}],
   withdrawals:[{id:"w1",state:"UNKNOWN",operation_version:"1",funds_disposition:"RESERVED"}]}),env=environment(undefined,fixture);env.state.withdrawalsReady=true;
  try{
   const first=await request(env.options,"lookup","period=0&pageSize=1");assert.equal(first.status,200,name);
   const before=fixture.db.prepare("SELECT count(*) AS count,max(id) AS max_id,max(source_created_at) AS max_at FROM zzsh_order.legacy_order_read_snapshot").get();
   fixture.db.exec(sql);
   if(name.includes("off-page")||name==="legacy-binding")assert.deepEqual(fixture.db.prepare("SELECT count(*) AS count,max(id) AS max_id,max(source_created_at) AS max_at FROM zzsh_order.legacy_order_read_snapshot").get(),before,"count+max would miss this source change");
   const next=await request(env.options,"lookup",`period=0&pageSize=1&page=2&snapshot=${encodeURIComponent(first.json.snapshot)}`);assert.equal(next.status,409,name);assert.equal(next.json.documents,undefined,name);
  }finally{fixture.close();}
 }
});

test("baseline content tokens remain compatible while rejected MVCC tokens require one reload",async t=>{
 const fixture=new FinanceSqlFixture({legacy:[legacyFinanceOrder("stable01"),legacyFinanceOrder("stable02")]}),env=environment(undefined,fixture);t.after(()=>fixture.close());
 const first=await request(env.options,"lookup","period=0&pageSize=1");assert.equal(first.status,200);assert.match(first.json.snapshotVersion,/^[a-f0-9]{32}$/);
 const mint=(version:string)=>financeSnapshot({entries:[],subjects:[],revisions:[],withdrawalsReady:false,asOf:first.json.asOf,version},first.json.applied,{userId:"admin1",sessionId:"session1",authorizationKey:first.json.contextKey},env.options.listingCursorKey).token;
 const oldContent=mint(first.json.snapshotVersion),compatible=await request(env.options,"lookup",`period=0&pageSize=1&page=2&snapshot=${encodeURIComponent(oldContent)}`);assert.equal(compatible.status,200);
 const obsolete=await request(env.options,"lookup",`period=0&pageSize=1&page=2&snapshot=${encodeURIComponent(mint("pg-snapshot-v2:"+"a".repeat(32)))}`);assert.equal(obsolete.status,409);assert.equal(obsolete.json.documents,undefined);
 const fresh=await request(env.options,"lookup","period=0&pageSize=1"),next=await request(env.options,"lookup",`period=0&pageSize=1&page=2&snapshot=${encodeURIComponent(fresh.json.snapshot)}`);assert.equal(next.status,200);
});

test("export generation and prepare recheck content, ignoring unrelated activity and rejecting financial drift",async()=>{
 for(const change of ["unrelated","financial"]as const){
  const fixture=new FinanceSqlFixture({ledger:[{id:"line1",account_code:"WALLET_AVAILABLE",subject_id:"u1",subject_name:"用户一",delta:"100",at:"2026-10-03T01:00:00.000000Z",event_kind:"OPENING",basis_id:"basis1"}],legacy:[legacyFinanceOrder("off-page")]}),env=environment(undefined,fixture);
  try{
   fixture.db.exec("CREATE TABLE unrelated_audit(id TEXT)");
   const first=await request(env.options,"period");assert.equal(first.status,200);env.state.connected=0;
   env.state.beforeSecondTransaction=()=>{fixture.clusterSnapshot="101:101:";if(change==="unrelated")fixture.db.exec("INSERT INTO unrelated_audit VALUES('technical-audit')");else fixture.db.exec("UPDATE zzsh_order.legacy_order_read_snapshot SET source_digest='changed' WHERE id='off-page'");};
   const exported=await request(env.options,"export",`snapshot=${encodeURIComponent(first.json.snapshot)}`);
   assert.equal(exported.status,change==="unrelated"?200:409,change);
   if(change==="unrelated"){assert(exported.bytes);assert.equal(env.state.audits[0]!.phase,"PREPARED");assert.equal(exported.headers["X-Finance-Row-Count"],"1");}
   else{assert.equal(exported.bytes,undefined);assert.equal(env.state.audits.length,0);assert.equal(exported.headers["Content-Disposition"],undefined);}
  }finally{fixture.close();}
 }
});
