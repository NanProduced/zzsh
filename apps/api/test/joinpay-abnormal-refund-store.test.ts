// SYNTHETIC_COMPONENT_MODEL：内存事务/替身；不证明PG约束、真实预算锁或渠道退款。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../src/auth/security-core";
import * as channelStore from "../src/order/channel-refund-store";
import * as profile from "../src/order/joinpay-refund-profile";
import { createAbnormalFormalRefundIntent, readAbnormalRefundGate } from "../src/order/joinpay-abnormal-refund-store";

const CANONICAL = JSON.stringify({ kind: "FORMAL_NATIVE_REFUND_SERVER_REVIEW", reference: "ref_1", reviewSha256: "d".repeat(64),
  database: "db", runtimeUser: "runtime", merchantIdentityId: "merchant_1", merchantNo: "999900000000001",
  acceptedProfiles: [{ operation: "SUBMIT", profileId: "profile_1", profileSha256: "b".repeat(64), keyVersionRef: "key_1" }] });
const ADMISSION = { reference: "ref_1", sha256: createHash("sha256").update(CANONICAL).digest("hex"), canonical: CANONICAL,
  database: "db", runtimeUser: "runtime", merchantIdentityId: "merchant_1", merchantNo: "999900000000001",
  acceptedProfiles: [{ operation: "SUBMIT", profileId: "profile_1", profileSha256: "b".repeat(64), keyVersionRef: "key_1" }] };
const PROFILE = { purpose: "MERCHANT_REFUND", operation: "SUBMIT", profileId: "profile_1", profileSha256: "b".repeat(64),
  keyVersionRef: "key_1", merchantIdentityId: "merchant_1", merchantNo: "999900000000001",
  notifyUrl: "https://merchant.example.test/refund", fundsAccount: "SETTLED" };
const basis = (patch: Record<string, unknown> = {}) => ({ order_id: "order_1", merchant_identity_id: "merchant_1",
  provider_transaction_id: "trx_late", merchant_order_no: "ORDER_1", amount_cents: "1000", currency: "CNY",
  disposition: "REVIEW_REQUIRED", reason_code: "LATE_PAYMENT", renter_user_id: "renter_1", source: "JOINPAY",
  joinpay_request_id: "payreq_1", joinpay_evidence_id: "jpe_1", joinpay_anchor_id: "paytrx_1",
  request_channel: "JOINPAY", request_evidence_level: "JOINPAY_CANDIDATE", request_merchant: "merchant_1",
  request_order_no: "ORDER_1", request_amount_cents: "1000", request_currency: "CNY",
  binding_wire_merchant_no: "999900000000001", formal_admission_ref: "ref_1", evidence_event: "E4",
  evidence_trx: "trx_late", evidence_schema: "VALID", evidence_signature: "MATCH", evidence_binding: "MATCH",
  evidence_raw_sha256: "c".repeat(64), anchor_channel: "JOINPAY", anchor_evidence_level: "JOINPAY_VERIFIED",
  anchor_order: "order_1", anchor_request: "payreq_1", anchor_merchant: "merchant_1", anchor_trx: "trx_late",
  order_no_trx_count: "1", has_applied_same_trx: false, has_posting: false, ...patch });
function model(options: { ready?: boolean; readable?: boolean; writable?: boolean; auditFailure?: boolean } = {}) {
  const s: any = { readable: options.readable ?? options.ready ?? true, writable: options.writable ?? options.ready ?? true,
    auditFailure: options.auditFailure === true, b: basis(),
    oldRows: [] as any[], allocated: "0", roots: [] as any[], events: [] as any[], entries: [] as any[], audits: [] as any[],
    rootRows: new Map<string, any>(), eventRows: new Map<string, any>(), entryRows: new Map<string, any>(),
    intents: [] as any[], row: null as any, intentSql: "", intentParams: [] as any[], lockCalls: [] as string[], sql: [] as string[] };
  let snapshot: any;
  const one = (row?: any, count = row ? 1 : 0) => ({ rows: row ? [structuredClone(row)] : [], rowCount: count });
  const client = { release() {}, async query(sql: string, p: any[] = []) {
    s.sql.push(sql);
    if (sql === "BEGIN") { snapshot = structuredClone(s); return one(); }
    if (sql === "COMMIT") { snapshot = undefined; return one(); }
    if (sql === "ROLLBACK") { if (snapshot) Object.assign(s, snapshot); snapshot = undefined; return one(); }
    if (sql.includes("AS readable")) return one({ readable: s.readable });
    if (sql.includes("AS writable")) return one({ writable: s.writable });
    if (sql.includes("SELECT current_database() AS db")) return one({ db: "db", actor: "runtime", xid: "1", isolation: "read committed" });
    if (sql.includes("FROM zzsh_order.payment_confirmation c JOIN zzsh_order.rental_order o ON o.id=c.order_id")
      && sql.includes("WHERE c.id=$1 AND c.order_id=$2") && !sql.includes("FOR SHARE")) return one(s.b);
    if (sql.includes("pg_advisory_xact_lock")) return one();
    if (sql.includes("SELECT id FROM zzsh_auth_user")) return one({ id: "renter_1" });
    if (sql.includes("WHERE payment_confirmation_id=$1 AND basis_kind='REVIEW_CONFIRMATION'")) return { rows: s.oldRows.map((r: any) => structuredClone(r)), rowCount: s.oldRows.length };
    if (sql.includes("FOR SHARE OF c,o")) return one(s.b);
    if (sql.includes("FROM zzsh_order.wallet_revision")) return one({ ledger_revision: "7" });
    if (sql.includes("COALESCE(sum(amount_cents),0)::text AS allocated")) return one({ allocated: s.allocated });
    if (sql.includes("AS roots")) return one({ roots: s.rootRows.has(p[0]) ? 1 : 0, events: s.eventRows.has(p[1]) ? 1 : 0,
      entries: [...s.entryRows.values()].filter((x: any) => x.eventId === p[1]).length });
    if (sql.includes("FROM zzsh_order.finance_economic_root r")) {
      const [rootId, eventId, confirmationId, renterId, digest, amount] = p;
      const root = s.rootRows.get(rootId), ev = s.eventRows.get(eventId);
      const lines = [...s.entryRows.values()].filter((x: any) => x.eventId === eventId);
      const valid = !!root && !!ev && root.p[1] === confirmationId && root.p[2] === renterId && root.p[3] === digest
        && ev.p[1] === rootId && ev.p[2] === renterId && lines.length === 2
        && lines.some((x: any) => x.line === 1 && x.amount === amount && x.party === null && x.detailsRaw.abnormalRefundLiabilityId === confirmationId
          && x.detailsRaw.paymentConfirmationId === confirmationId && x.detailsRaw.amountCents === amount
          && x.detailsRaw.evidenceId === "jpe_1" && x.detailsRaw.anchorId === "paytrx_1")
        && lines.some((x: any) => x.line === 2 && x.amount === amount && x.party === renterId && x.detailsRaw.abnormalRefundLiabilityId === confirmationId
          && x.detailsRaw.paymentConfirmationId === confirmationId && x.detailsRaw.amountCents === amount
          && x.detailsRaw.evidenceId === "jpe_1" && x.detailsRaw.anchorId === "paytrx_1");
      return one({ valid });
    }
    if (sql.includes("INSERT INTO zzsh_order.finance_economic_root")) {
      if (!s.rootRows.has(p[0])) { s.rootRows.set(p[0], { p }); s.roots.push(p); }
      return one();
    }
    if (sql.includes("INSERT INTO zzsh_order.finance_event")) {
      if (!s.eventRows.has(p[0])) { s.eventRows.set(p[0], { p }); s.events.push(p); }
      return one();
    }
    if (sql.includes("INSERT INTO zzsh_order.settlement_ledger_entry")) {
      const details = JSON.parse(p[3]); let added = false;
      if (!s.entryRows.has(p[0])) { s.entryRows.set(p[0], { eventId: p[1], line: 1, amount: p[2], party: null, detailsRaw: details }); added = true; }
      if (!s.entryRows.has(p[4])) { s.entryRows.set(p[4], { eventId: p[1], line: 2, amount: p[2], party: p[5], detailsRaw: details }); added = true; }
      if (added) s.entries.push({ sql, p }); return one();
    }
    if (sql.includes("INSERT INTO zzsh_order.channel_refund_intent")) {
      s.intentSql = sql; s.intentParams = p;
      s.row = { id: p[0], posting_id: null, basis_kind: "REVIEW_CONFIRMATION", order_id: p[1], payment_confirmation_id: p[2],
        renter_user_id: p[3], merchant_identity_id: p[4], original_payment_trx_no: p[5], original_payment_order_no: p[6],
        responsibility_version_hash: p[7], refund_order_no: p[8], amount_cents: p[9], currency: "CNY", idempotency_key: p[10],
        request_fingerprint: p[11], due_at: new Date(0).toISOString(), state: "READY", revision: "1", lease_version: "0",
        lease_owner: null, budget_disposition: "ALLOCATED", requires_review: false, refund_reason: p[21],
        liability_root_id: p[22], liability_event_id: p[23], evidence_level: "JOINPAY_FORMAL",
        initial_admission_ref: p[12], initial_admission_sha256: p[13], initial_admission_canonical: p[14], wire_merchant_no: p[15],
        initial_profile_id: p[16], initial_profile_sha256: p[17], initial_key_version_ref: p[18], notify_url: p[19],
        funds_account: p[20], terminal_evidence_id: null, terminal_root_id: null, terminal_event_id: null,
        provider_refund_trx_no: null, completed_at: null };
      s.intents.push(s.row); return one(s.row);
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (s.auditFailure) throw Error("AUDIT_FAILURE"); s.audits.push(p); return one(); }
    if (sql.includes("joinpay_evidence_id AS evidence_id")) return one({ evidence_id: "jpe_1", anchor_id: "paytrx_1" });
    throw Error("UNEXPECTED_SQL " + sql);
  } } as unknown as PoolClient;
  return { s, client, pool: { connect: async () => client } as unknown as Pool };
}
function mocks(t: any) {
  t.mock.method(profile, "assertFormalRefundProfile", () => ADMISSION as any);
  t.mock.method(profile, "describeRefundProfile", () => PROFILE as any);
  t.mock.method(profile, "assertRefundStart", () => {});
  t.mock.method(profile, "assertRefundBinding", () => {});
  t.mock.method(channelStore, "assertRefundResource", async () => "xid");
  t.mock.method(channelStore, "lockRefundFunds", async (_c: any, _s: string, _m: string, _t: string) => {});
}
const input = { orderId: "order_1", confirmationId: "pay_1", idempotencyKey: "key_1", requestId: "req_1", admission: {} as any, profile: {} as any };
const create = (d: ReturnType<typeof model>, patch: Record<string, unknown> = {}) => withTransaction(d.pool,
  c => createAbnormalFormalRefundIntent(c, { ...input, ...patch }));

test("C04B 迟到REVIEW原款可建全额责任，唯一原号消歧后不造posting", async t => {
  const d = model(); mocks(t);
  const result = await create(d);
  assert.equal(result.kind, "ALLOCATED");
  assert.equal(result.amountCents, "1000"); assert.equal(result.currency, "CNY"); assert.equal(result.state, "READY");
  assert.equal(d.s.roots.length, 1); assert.ok(d.s.sql.some((q: string) => q.includes("NATIVE_ABNORMAL_REFUND")));
  assert.equal(d.s.events.length, 1); assert.ok(d.s.sql.some((q: string) => q.includes("REFUND_LIABILITY_RECOGNIZED")));
  assert.equal(d.s.entries.length, 1); assert.match(d.s.entries[0].sql, /JOINPAY_UNALLOCATED_RECEIPT/);
  assert.match(d.s.entries[0].sql, /RENTER_REFUND_PAYABLE/);
  assert.equal(d.s.entries[0].p[2], "1000"); assert.equal(d.s.entries[0].p[5], "renter_1");
  assert.match(d.s.intentSql, /VALUES\(\$1,NULL,\$2/); assert.match(d.s.intentSql, /REVIEW_CONFIRMATION/);
  assert.equal(d.s.intents.length, 1); assert.equal(d.s.intents[0].posting_id, null);
  assert.equal(d.s.audits.length, 1); assert.ok(d.s.audits[0].includes("order.refund.abnormal.allocated"));
  assert.ok(JSON.stringify(d.s.audits[0]).includes("NOT_SUBMITTED"));
});

test("C04B 同key恢复原责任，不同key不并发重复占用", async t => {
  const d = model(); mocks(t); await create(d);
  d.s.oldRows = [structuredClone(d.s.row)]; const roots = d.s.roots.length, entries = d.s.entries.length;
  const replay = await create(d);
  assert.equal(replay.kind, "REPLAYED"); assert.equal(d.s.roots.length, roots); assert.equal(d.s.entries.length, entries);
  await assert.rejects(create(d, { idempotencyKey: "key_2" }), error => (error as any).code === "IDEMPOTENCY_KEY_REUSED");
  assert.equal(d.s.roots.length, roots);
});

test("C04B 原号对应多trx、APPLIED同trx、错锚点均留REVIEW且0写", async t => {
  mocks(t);
  for (const patch of [{ order_no_trx_count: "2" }, { has_applied_same_trx: true }, { anchor_trx: "other_trx" },
    { evidence_signature: "MISMATCH" }, { source: "CONTROLLED" }, { amount_cents: "0" }]) {
    const d = model(); d.s.b = basis(patch);
    const result = await create(d);
    assert.equal(result.kind, "REVIEW_REQUIRED", JSON.stringify(patch));
    assert.equal(d.s.roots.length, 0); assert.equal(d.s.entries.length, 0); assert.equal(d.s.intents.length, 0);
  }
});

test("C04B 共同原款预算已占用时不重复获得全额", async t => {
  const d = model(); mocks(t); d.s.allocated = "1000";
  await assert.rejects(create(d), /exceeds original payment/i);
  assert.equal(d.s.roots.length, 0); assert.equal(d.s.entries.length, 0);
});

test("C04B 新basis schema/ACL未装时503且不读原款", async t => {
  const d = model({ ready: false }); mocks(t);
  await assert.rejects(create(d), error => (error as any).status === 503);
  assert.equal(d.s.sql.filter((sql: string) => sql.includes("FROM zzsh_order.payment_confirmation")).length, 0);
});

test("C04B 审计失败整笔回滚，不留责任/账务/意图", async t => {
  const d = model({ auditFailure: true }); mocks(t);
  await assert.rejects(create(d), /AUDIT_FAILURE/);
  assert.equal(d.s.intents.length, 0); assert.equal(d.s.roots.length, 0); assert.equal(d.s.events.length, 0); assert.equal(d.s.entries.length, 0);
});

test("C04B 已释放旧key不阻止新key重新分配，同key仍恢复", async t => {
  const d = model(); mocks(t); await create(d);
  const released = structuredClone(d.s.row); released.budget_disposition = "RELEASED"; released.state = "FAILED";
  d.s.oldRows = [released]; d.s.allocated = "0";
  const fresh = await create(d, { idempotencyKey: "key_3" });
  assert.equal(fresh.kind, "ALLOCATED"); assert.equal(d.s.intents.length, 2);
  assert.equal(d.s.rootRows.size, 1); assert.equal(d.s.eventRows.size, 1); assert.equal(d.s.entryRows.size, 2);
  assert.equal(d.s.roots.length, 1); assert.equal(d.s.events.length, 1); assert.equal(d.s.entries.length, 1);
  d.s.oldRows = [released, structuredClone(d.s.intents[1])];
  const replay = await create(d, { idempotencyKey: "key_3" });
  assert.equal(replay.kind, "REPLAYED");
});

test("Master负债模型：已释放重试遇同ID错绑root必须拒绝，不能ON CONFLICT后继续派意图",async t=>{
  const d=model();mocks(t);await create(d);
  const released=structuredClone(d.s.row);released.state="FAILED";released.budget_disposition="RELEASED";
  d.s.oldRows=[released];d.s.allocated="0";d.s.roots[0][1]="other_confirmation";
  const query=d.client.query.bind(d.client);
  (d.client as any).query=async(sql:string,p:any[]=[])=>sql.includes("FROM zzsh_order.finance_economic_root")
    ?{rows:[{valid:false,source_id:"other_confirmation"}],rowCount:1}:query(sql,p);
  await assert.rejects(create(d,{idempotencyKey:"key_retry"}));
  assert.equal(d.s.intents.length,1);
});

test("R1负债root/event/ledger任一不符都在新意图前拒绝", async t => {
  for (const variant of ["ROOT_BIND","EVENT_KIND","LEDGER_LINES"]) {
    const d = model(); mocks(t);
    const query = d.client.query.bind(d.client);
    (d.client as any).query = async (sql: string, p: any[] = []) => sql.includes("FROM zzsh_order.finance_economic_root r")
      ? { rows: [{ valid: false, variant }], rowCount: 1 } : query(sql, p);
    await assert.rejects(create(d, { idempotencyKey: "key_" + variant }), error => (error as any).status === 503);
    assert.equal(d.s.intents.length, 0, variant); assert.equal(d.s.roots.length, 0, variant);
  }
});

test("R1复用前读回错绑root在写入前拒绝", async t => {
  const d = model(); mocks(t); await create(d);
  const released = structuredClone(d.s.row); released.state = "FAILED"; released.budget_disposition = "RELEASED";
  d.s.oldRows = [released]; d.s.allocated = "0";
  const original = d.s.rootRows.get([...d.s.rootRows.keys()][0]); original.p[1] = "other_confirmation";
  await assert.rejects(create(d, { idempotencyKey: "key_bound" }), error => (error as any).status === 503);
  assert.equal(d.s.intents.length, 1);
});

test("R1负债批次缺行/多行在写入前拒绝，不盲补", async t => {
  for (const variant of ["missing-entry", "extra-entry"]) {
    const d = model(); mocks(t); await create(d);
    const released = structuredClone(d.s.row); released.state = "FAILED"; released.budget_disposition = "RELEASED";
    d.s.oldRows = [released]; d.s.allocated = "0";
    const ids = [...d.s.entryRows.keys()];
    if (variant === "missing-entry") d.s.entryRows.delete(ids[0]);
    else d.s.entryRows.set("extra", { eventId: d.s.eventRows.keys().next().value, line: 3, amount: "1000", party: null, detailsRaw: {} });
    await assert.rejects(create(d, { idempotencyKey: "key_" + variant }), error => (error as any).status === 503);
    assert.equal(d.s.intents.length, 1, variant);
  }
});

test("R1旧键恢复不要求新列INSERT权限/新SUBMIT准入，但仍重验持久身份与原准入", async t => {
  const d = model(); mocks(t); await create(d);
  d.s.oldRows = [structuredClone(d.s.row)]; d.s.writable = false;
  const replay = await create(d, { admission: undefined, profile: undefined });
  assert.equal(replay.kind, "REPLAYED"); assert.equal(replay.state, "READY");
  const query = d.client.query.bind(d.client);
  (d.client as any).query = async (sql: string, p: any[] = []) => sql.includes("SELECT current_database() AS db")
    ? { rows: [{ db: "db", actor: "other_runtime", xid: "1", isolation: "read committed" }], rowCount: 1 } : query(sql, p);
  await assert.rejects(create(d, { admission: undefined, profile: undefined }), /Original native refund admission unavailable/);
  (d.client as any).query = query;
  const broken = structuredClone(d.s.oldRows[0]); broken.initial_admission_canonical = broken.initial_admission_canonical.replace("merchant_1", "merchant_2");
  d.s.oldRows = [broken];
  await assert.rejects(create(d, { admission: undefined, profile: undefined }), /Original native refund admission unavailable/);
});

test("R1新请求仍由新准入与INSERT写闭包控制，缺失时503且0写", async t => {
  mocks(t);
  const noAdmission = model();
  await assert.rejects(create(noAdmission, { admission: undefined, profile: undefined }), error => (error as any).status === 503);
  assert.equal(noAdmission.s.roots.length, 0); assert.equal(noAdmission.s.intents.length, 0);
  const noWrite = model({ writable: false });
  await assert.rejects(create(noWrite), error => (error as any).status === 503);
  assert.equal(noWrite.s.roots.length, 0); assert.equal(noWrite.s.entries.length, 0); assert.equal(noWrite.s.intents.length, 0);
});

test("R1结构探针不依赖不存在列名直接权限判断，且要求terminal函数", async t => {
  const d = model(); mocks(t); await create(d);
  const probe = d.s.sql.find((sql: string) => sql.includes("AS readable"))!;
  assert.match(probe, /pg_attribute/); assert.match(probe, /has_column_privilege/);
  assert.match(probe, /native_abnormal_refund_terminal_complete\(text\)/);
  assert.match(probe, /native_abnormal_refund_liability_complete\(text\)/);
  assert.match(probe, /abnormal_refund_liability_root_guard/);
  assert.match(probe, /abnormal_refund_liability_entry_batch_guard/);
  assert.equal(probe.includes("channel_refund_intent.basis_kind"), false);
});

test("Master：首派SQL必须传入原intentId，替身也核实际绑定参数",async()=>{
  const c={query:async(_sql:string,values:unknown[]=[])=>{
    assert.deepEqual(values,["refund_gate_1"]);
    return{rows:[{valid:false,order_no_trx_count:"2"}]};
  }} as unknown as PoolClient;
  const result=await readAbnormalRefundGate(c,"refund_gate_1");
  assert.equal(result.valid,false);assert.equal(result.reason,"ORIGINAL_ORDER_NO_AMBIGUOUS");
});

test("Master：已存在完整负债的重试不重新触发本事务新建INSERT守卫",async t=>{
  const d=model();mocks(t);await create(d);
  const old=structuredClone(d.s.row);old.state="FAILED";old.budget_disposition="RELEASED";
  d.s.oldRows=[old];d.s.allocated="0";
  const inserts=()=>d.s.sql.filter((sql:string)=>/INSERT INTO zzsh_order\.(finance_economic_root|finance_event|settlement_ledger_entry)/.test(sql)).length;
  const prior=inserts();const result=await create(d,{idempotencyKey:"retry_complete"});
  assert.equal(result.kind,"ALLOCATED");assert.equal(inserts(),prior);
  assert.equal(d.s.roots.length,1);assert.equal(d.s.events.length,1);assert.equal(d.s.entries.length,1);
});

test("Master SQL契约：同一金额参数用于numeric列和JSON文本时显式定型",async t=>{
  const d=model();mocks(t);await create(d);
  const sql=d.s.sql.find((q:string)=>q.includes("FROM zzsh_order.finance_economic_root r"))!;
  assert.match(sql,/debit_cents=\$6::numeric/);
  assert.match(sql,/'amountCents',\$6::text/);
});
