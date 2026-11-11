import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { importLegacyBankBinding, legacyBankImportCounts, legacyBankImportRequestId, legacyBankImportSubjects, prepareLegacyBankImport,
  readbackLegacyBankBinding, releaseLegacyBankImportPlan, type LocalBankTarget } from "../src/finance/legacy-withdrawal-bank-import";
import type { WithdrawalBankBindingOptions } from "../src/finance/withdrawal-bank-binding";

// Synthetic only: no database connection, real card, real user or provider call.
const source = { sourceReceiptSha256: "1".repeat(64), sourceDumpSha256: "2".repeat(64), sourceCutoff: "2026-10-26T00:00:00.000Z" };
const target: LocalBankTarget = { round: 6, host: "127.0.0.1", port: 55432, database: "zzsh_test_round06_bank", databaseOid: 998877,
  marker: "zzsh:round06-bank:v1", nonce: "a".repeat(24), owner: "zzsh", ownerOid: 1122, runtimeUser: "zzsh_round06_runtime", runtimeRoleOid: 3344 };
const input = { user_id: "1", name: "虚构用户", card_no: "0000000000000015", create_time: "1760000000", update_time: "1760000001" };
const users = new Map([["1", "a".repeat(64)]]);
const operator = { userId: "unit_boss", sessionId: "unit_admin_session" };
const options: WithdrawalBankBindingOptions = { database: target.database, runtimeUser: target.runtimeUser,
  protection: { currentKeyVersion: "unit_key_v1", keyFor: version => { if (version !== "unit_key_v1") throw Error(); return Buffer.alloc(32, 17); } } };

function component(boundTarget:LocalBankTarget = target) {
  const state = { identity: { ...boundTarget, system_identifier:boundTarget.instance?.systemIdentifier, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit:false, rolbypassrls: false },
    status: "ACTIVE", matched: "1", total: "1", existing: false, readonly: false, race: false, adminStatus: "ACTIVE", isBoss: true,
    sessionLocked: false, sessionExpired: false, twoFactorEnabled: true, audits: [] as any[][],
    rows: new Map<string, any>(), commands: [] as string[] };
  const client = { connectionParameters: { host: boundTarget.host, port: boundTarget.port, database: boundTarget.database, user: boundTarget.runtimeUser },
    getTransactionStatus: () => "T", async query(sql: string, values: any[] = []) {
      state.commands.push(sql);
      if (sql.startsWith("SELECT d.oid::text AS oid")) { const r = state.identity; return { rows: [{ oid: String(r.databaseOid), name: r.database, role: r.runtimeUser,
        role_oid: String(r.runtimeRoleOid), owner: r.owner, owner_oid: String(r.ownerOid), marker: r.marker, nonce: r.nonce,
        rolsuper: r.rolsuper, rolcreatedb: r.rolcreatedb, rolcreaterole: r.rolcreaterole, rolinherit:r.rolinherit, rolbypassrls: r.rolbypassrls, system_identifier:r.system_identifier, ready: true }] }; }
      if (sql.includes('AS "databaseName"')) return { rows: [{ databaseName: boundTarget.database, currentUser: boundTarget.runtimeUser, owner: boundTarget.owner }] };
      if (sql.includes('AS "ownsBusinessSchema"')) return { rows: [{ ownsBusinessSchema: false, ownsBusinessRelation: false, hasPrivilegedMembership: false }] };
      if (sql.startsWith('SELECT "status" FROM "zzsh_iam"."admin_security"')) return { rows: [{ status: state.adminStatus }] };
      if (sql.includes('FROM "zzsh_auth_admin"."session" s')) return { rows: values[0] === operator.sessionId && values[1] === operator.userId
        ? [{ locked: state.sessionLocked, pinHash: null, pinFailures: 0, expiresAt: state.sessionExpired ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z", suspended: false, twoFactorEnabled: state.twoFactorEnabled }] : [] };
      if (sql.startsWith('SELECT "status", "is_boss" AS "isBoss"')) return { rows: [{ status: state.adminStatus, isBoss: state.isBoss, passwordChangeRequired: false }] };
      if (sql.includes("WITH role_permissions AS")) return { rows: [] };
      if (sql.startsWith("SELECT s.account_status AS status")) return { rows: [{ status: state.status, matched: state.matched, total: state.total }] };
      if (sql.startsWith("SELECT 1 FROM zzsh_order.withdrawal_bank_binding")) return { rowCount: state.existing || state.rows.has(values[0]) ? 1 : 0, rows: [] };
      if (sql.startsWith("INSERT INTO zzsh_order.withdrawal_bank_binding")) {
        if (state.race || state.rows.has(values[1])) return { rowCount: 0, rows: [] };
        const row = { id: values[0], user_id: values[1], revision: "1", sealed_details: values[2], card_mask: values[3], holder_mask: values[4], updated_at: "2026-10-25T01:00:00.000000Z" };
        state.rows.set(values[1], row); return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { state.audits.push(values); return { rows: [] }; }
      if (sql.startsWith("SELECT current_setting('transaction_read_only')")) return { rows: [{ mode: state.readonly ? "on" : "off" }] };
      if (sql.startsWith("SELECT current_database()")) return { rows: [{ database: boundTarget.database, runtime_user: boundTarget.runtimeUser, ready: true }] };
      if (sql.startsWith("SELECT id,user_id,revision::text")) { const r = state.rows.get(values[0]); return { rows: r ? [structuredClone(r)] : [] }; }
      if (sql.startsWith("SELECT action,actor_type,actor_id,session_id,outcome,details FROM zzsh_iam.audit_event")) return { rows: state.audits.filter(a => a[6] === values[0]
        && JSON.parse(a[10]).revision === values[1]).map(a => ({ action: a[4], actor_type: a[1], actor_id: a[2], session_id: a[3], outcome: a[7], details: JSON.parse(a[10]) })) };
      if (sql.startsWith("SELECT 1 FROM zzsh_iam.audit_event a JOIN zzsh_order.withdrawal_bank_binding b")) {
        const row = state.rows.get(values[1]); return { rowCount: row && state.audits.some(a => a[6] === row.id && a[8] === values[0]) ? 1 : 0, rows: [] };
      }
      throw Error("UNEXPECTED_SYNTHETIC_BANK_SQL");
    } } as unknown as PoolClient;
  return { client, state };
}

test("先在内存筛选全量来源：缺字段、重复主体、缺用户映射均隔离，输出仅计数", () => {
  const rows = [input, { ...input, user_id: "2" }, { ...input, user_id: "3", card_no: "0000000000000023", name: "" },
    { ...input, user_id: "4", card_no: "0000000000000049" }, { ...input, user_id: "5", card_no: "0000000000000056" },
    { ...input, user_id: "5", card_no: "0000000000000064" }];
  const plan = prepareLegacyBankImport(rows, users, source, target, operator), counts = legacyBankImportCounts(plan);
  assert.deepEqual(counts, { source: 6, ready: 1, invalid: 1, duplicate: 2, userSourceMissing: 2 });
  assert(!JSON.stringify([counts, plan]).includes(input.name)); assert(!JSON.stringify([counts, plan]).includes(input.card_no));
  assert.equal([...legacyBankImportSubjects(plan)].length, 1); releaseLegacyBankImportPlan(plan);
  assert.throws(() => legacyBankImportCounts(plan));
});

test("R07 绑定实例、端口和独立恢复键，错误或缺失实例在写入前拒绝", async () => {
  const instance={host:"127.0.0.1" as const,port:55433 as const,systemIdentifier:"123456"};
  const r07:LocalBankTarget={...target,round:7,port:55433,instance,migrationUser:"zzsh_regression_migration",migrationRoleOid:9988};
  assert.throws(()=>prepareLegacyBankImport([input],users,source,{...r07,instance:undefined},operator));
  assert.throws(()=>prepareLegacyBankImport([input],users,source,{...r07,instance:{...instance,port:55432}},operator));
  assert.throws(()=>prepareLegacyBankImport([input],users,source,{...r07,migrationRoleOid:undefined},operator));
  const plan=prepareLegacyBankImport([input],users,source,r07,operator),requestId=legacyBankImportRequestId(plan,"1",options);
  for(const changed of ["999999",undefined]){
    const blocked=component(r07);blocked.state.identity.system_identifier=changed;
    await assert.rejects(importLegacyBankBinding(blocked.client,plan,"1",options,requestId),/RESOURCE_MISMATCH/);
    assert.equal(blocked.state.rows.size,0);assert.equal(blocked.state.audits.length,0);
  }
  const wrongPort=component(r07);(wrongPort.client as PoolClient & {connectionParameters:{port:number}}).connectionParameters.port=55432;
  await assert.rejects(importLegacyBankBinding(wrongPort.client,plan,"1",options,requestId),/RESOURCE_MISMATCH/);
  assert.equal(wrongPort.state.rows.size,0);
  const valid=component(r07);assert.equal((await importLegacyBankBinding(valid.client,plan,"1",options,requestId)).status,"IMPORTED");
  const other=prepareLegacyBankImport([input],users,source,{...r07,instance:{...instance,systemIdentifier:"654321"}},operator);
  assert.notEqual(legacyBankImportRequestId(other,"1",options),requestId);
  releaseLegacyBankImportPlan(other);releaseLegacyBankImportPlan(plan);
});

test("next-round bank import requires its exact registered local cluster, epoch and role",async()=>{
  const instance={host:"127.0.0.1" as const,port:55435,systemIdentifier:"123456"};
  const next:LocalBankTarget={...target,round:'next',port:instance.port,instance,database:'zzsh_test_regression',marker:'zzsh:regression-test:v1',
    owner:'zzsh',runtimeUser:'zzsh_regression_runtime',migrationUser:'zzsh_regression_migration',migrationRoleOid:9988,migrationProfile:'LOCAL_MIGRATION_NEXT_V1'};
  const opts={...options,database:next.database,runtimeUser:next.runtimeUser};
  for(const changed of [{migrationProfile:undefined},{port:55433},{instance:{...instance,systemIdentifier:''}},
    {runtimeUser:'zzsh_regression_migration'},{migrationUser:'other_role'},{nonce:'bad'}])
    assert.throws(()=>prepareLegacyBankImport([input],users,source,{...next,...changed} as LocalBankTarget,operator));
  const plan=prepareLegacyBankImport([input],users,source,next,operator),requestId=legacyBankImportRequestId(plan,'1',opts),valid=component(next);
  assert.equal((await importLegacyBankBinding(valid.client,plan,'1',opts,requestId)).status,'IMPORTED');
  for(const changed of ['999999',undefined]){const blocked=component(next);blocked.state.identity.system_identifier=changed;
    await assert.rejects(importLegacyBankBinding(blocked.client,plan,'1',opts,requestId),/RESOURCE_MISMATCH/);assert.equal(blocked.state.rows.size,0);}
  const wrong=component(next);(wrong.client as PoolClient & {connectionParameters:{port:number}}).connectionParameters.port=55433;
  await assert.rejects(importLegacyBankBinding(wrong.client,plan,'1',opts,requestId),/RESOURCE_MISMATCH/);
  const other=prepareLegacyBankImport([input],users,source,{...next,instance:{...instance,systemIdentifier:'654321'}},operator);
  assert.notEqual(legacyBankImportRequestId(other,'1',opts),requestId);releaseLegacyBankImportPlan(other);releaseLegacyBankImportPlan(plan);
});

test("不同已映射用户可以沿用同一卡号，姓名差异本身也不虚构归属验证", () => {
  const other = { ...input, user_id: "2", name: "另一虚构用户" }, both = new Map([...users, ["2", "b".repeat(64)]]);
  const plan = prepareLegacyBankImport([input, other], both, source, target, operator);
  assert.deepEqual(legacyBankImportCounts(plan), { source: 2, ready: 2, invalid: 0, duplicate: 0, userSourceMissing: 0 });
  releaseLegacyBankImportPlan(plan);
});

test("未进入本轮封签选集的旧用户即使目标存在也不得读取或写入", async () => {
  const unselected = { ...input, user_id: "2", card_no: "0000000000000023" }, plan = prepareLegacyBankImport([input, unselected], users, source, target, operator);
  const f = component(); f.state.matched = "1"; f.state.total = "1"; f.state.status = "ACTIVE";
  assert.equal(legacyBankImportCounts(plan).ready, 1); assert.equal(legacyBankImportCounts(plan).userSourceMissing, 1);
  await assert.rejects(importLegacyBankBinding(f.client, plan, "2", options, "bank-import_" + "a".repeat(32)));
  assert.equal(f.state.commands.length, 0); assert.equal(f.state.rows.size, 0); assert.equal(f.state.audits.length, 0);
});

test("冻结与活动用户仅加密保存，不改变账号状态；独立只读读回比对原值及来源", async () => {
  for (const status of ["ACTIVE", "FROZEN"]) {
    const plan = prepareLegacyBankImport([input], users, source, target, operator), f = component(); f.state.status = status;
    const requestId = legacyBankImportRequestId(plan, "1", options), result = await importLegacyBankBinding(f.client, plan, "1", options, requestId);
    assert.equal(result.status, "IMPORTED"); assert(result.encryptMs >= 0); assert.equal(f.state.rows.size, 1); assert.equal(f.state.audits.length, 1);
    const audit = f.state.audits[0]!, bank = [...f.state.rows.values()][0];
    assert.equal(audit[1], "admin"); assert.equal(audit[2], operator.userId); assert.equal(audit[3], operator.sessionId); assert.equal(audit[4], "withdrawal.bank_binding.legacy_imported");
    assert(!JSON.stringify(audit).includes(input.name)); assert(!JSON.stringify(audit).includes(input.card_no));
    assert(!bank.sealed_details.includes(input.name)); assert(!bank.sealed_details.includes(input.card_no));
    assert(f.state.commands.every(sql => !/^\s*(UPDATE|DELETE|TRUNCATE)\b/i.test(sql)));
    await assert.rejects(readbackLegacyBankBinding(f.client, plan, "1", options), /READBACK_REQUIRES_READ_ONLY/);
    f.state.readonly = true; assert.equal(await readbackLegacyBankBinding(f.client, plan, "1", options), true);
    const wrong = { ...options, protection: { currentKeyVersion: "unit_key_v1", keyFor: () => Buffer.alloc(32, 18) } };
    await assert.rejects(readbackLegacyBankBinding(f.client, plan, "1", wrong));
    releaseLegacyBankImportPlan(plan);
  }
});

test("映射异常、注销、已有绑定与并发冲突均隔离；错误资源和 R05 不得写入", async () => {
  for (const [field, value, expected] of [["matched", "0", "TARGET_NOT_MATCHED"], ["total", "2", "TARGET_NOT_MATCHED"],
    ["status", "CANCELLED", "TARGET_NOT_AVAILABLE"], ["existing", true, "BINDING_CONFLICT"], ["race", true, "BINDING_CONFLICT"]] as const) {
    const plan = prepareLegacyBankImport([input], users, source, target, operator), f = component(); (f.state as any)[field] = value;
    assert.equal((await importLegacyBankBinding(f.client, plan, "1", options, legacyBankImportRequestId(plan, "1", options))).status, expected);
    assert.equal(f.state.rows.size, 0); assert.equal(f.state.audits.length, 0);
  }
  const plan = prepareLegacyBankImport([input], users, source, target, operator), f = component(); f.state.identity.databaseOid++;
  await assert.rejects(importLegacyBankBinding(f.client, plan, "1", options, legacyBankImportRequestId(plan, "1", options)), /RESOURCE_MISMATCH/);
  assert.equal(f.state.rows.size, 0);
  assert.throws(() => prepareLegacyBankImport([input], users, source, { ...target, databaseOid: 3179610 }, operator));
  for (const changes of [{ adminStatus: "FROZEN" }, { isBoss: false }, { sessionLocked: true }, { sessionExpired: true }, { twoFactorEnabled: false }]) {
    const blocked = component(); Object.assign(blocked.state, changes);
    await assert.rejects(importLegacyBankBinding(blocked.client, plan, "1", options, legacyBankImportRequestId(plan, "1", options)));
    assert.equal(blocked.state.rows.size, 0); assert.equal(blocked.state.audits.length, 0);
  }
});
