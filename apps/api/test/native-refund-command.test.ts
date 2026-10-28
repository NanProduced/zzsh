// SYNTHETIC_COMPONENT_MODEL：内存Admin/PG替身；验证命令边界，不证明真实权限、PG事务或渠道退款。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import * as adminAuthSession from "../src/auth/admin-auth-session";
import * as adminAuthorization from "../src/auth/admin-authorization";
import * as adminScope from "../src/auth/admin-scope";
import * as refundStore from "../src/order/channel-refund-store";
import * as refundProfile from "../src/order/joinpay-refund-profile";
import * as securityCore from "../src/auth/security-core";
import * as orderTeam from "../src/im/order-team-access";
import { requestAdminNativeRefund, readAdminNativeRefunds } from "../src/order/native-refund-command";

const ACTOR = { userId: "admin_1", sessionId: "admin_session" };
const ACCESS = { status: "ACTIVE", isBoss: true, passwordChangeRequired: false, permissions: new Set<string>(["order.settlement.write"]) };
const POSTING = { id: "posting_1", renter_user_id: "renter_1", due_at: "2026-10-25T00:00:00+00:00", frozen_cents: "5000", due: true };
function model(options: { access?: unknown; scope?: unknown; postings?: unknown[]; receipt?: unknown; failCreate?: Error; commitLoss?: boolean } = {}) {
  const calls = { creates: [] as any[], queries: [] as string[], connects: 0 };
  const client = { release() {}, async query(sql: string, values: unknown[] = []) {
    calls.queries.push(sql);
    if (sql === "COMMIT" && options.commitLoss) throw Object.assign(new Error("SYNTHETIC_COMMIT_ACK_LOSS"), { code: "ECONNRESET" });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT game_id FROM zzsh_order.rental_order")) return { rows: [{ game_id: "game_1" }], rowCount: 1 };
    if (sql.includes("FROM zzsh_order.settlement_posting p")) return { rows: options.postings ?? [POSTING] };
    if (sql.includes("FROM zzsh_order.channel_refund_intent i")) return { rows: [] };
    throw Error("UNEXPECTED_SQL " + sql);
  } } as unknown as PoolClient;
  const pool = { connect: async () => { calls.connects++; return client; } } as unknown as Pool;
  return { pool, calls };
}
function mocks(t: any, options: { access?: unknown; scope?: unknown; receipt?: unknown; failCreate?: Error } = {}) {
  t.mock.method(orderTeam, "readOrderTeamAccess", async () => ({ teamState: "READY", canRead: true }));
  t.mock.method(adminAuthSession, "assertAdminCommandAuthorizedInTransaction", async () => ({}));
  t.mock.method(adminAuthorization, "loadEffectiveAdminAccess", async () => options.access ?? ACCESS);
  t.mock.method(adminScope, "readAdminGameScope", async () => options.scope ?? { mode: "ALL_GAMES", gameIds: [] });
  t.mock.method(refundProfile, "describeRefundProfile", () => ({ notifyUrl: "https://refund.example.invalid/notify" }));
  const creates: any[] = [];
  t.mock.method(refundStore, "createFormalRefundIntent", async (_c: PoolClient, input: any) => {
    if (!input.profile && !(options.receipt as any)?.replayed) throw new Error("Native refund initial admission unavailable");
    creates.push(input);
    if (options.failCreate) throw options.failCreate;
    return options.receipt ?? { replayed: false, intentId: "refund_1", refundOrderNo: "RF" + "a".repeat(28), state: "READY", budgetDisposition: "ALLOCATED" };
  });
  return creates;
}
const execution = { admission: {} as never, initialProfile: {} as never };
const input = { actor: ACTOR, orderId: "order_1", amountCents: "1200", reason: "部分退款", idempotencyKey: "refund_key_1", requestId: "request_1" };

test("MasterReader：异常意图没有posting时，不把posting分配额填成0",async t=>{
  mocks(t);const m=model(),c=await m.pool.connect(),query=c.query.bind(c);
  (c as any).query=async(sql:string,p:unknown[]=[])=>sql.includes("FROM zzsh_order.channel_refund_intent i")
    ?{rows:[{id:"refund_review",posting_id:null,refund_order_no:"RF_REVIEW",amount_cents:"1000",state:"READY",budget_disposition:"ALLOCATED",
      requires_review:false,provider_refund_trx_no:null,completed_at:null,frozen_cents:null,allocated_cents:"0",
      latest_event:null,latest_evidence_level:null,latest_observed_at:null}]}:query(sql,p);
  const result=await readAdminNativeRefunds(m.pool,{actor:ACTOR,orderId:"order_1"});
  assert.equal(result.items[0]?.amountCents,"1000");assert.equal(result.items[0]?.budgetDisposition,"ALLOCATED");
  assert.deepEqual(result.items[0]?.postingResponsibility,{frozenCents:null,allocatedCents:null,remainingCents:null});
});

test("正式退款命令要求命令权限与对象范围；finance.read等无写权限不通过", async t => {
  const denied = mocks(t, { access: { ...ACCESS, permissions: new Set(["finance.read"]) } });
  const m = model(); await assert.rejects(requestAdminNativeRefund(m.pool, execution, input), /Access denied|Permission required|FORBIDDEN/i);
  assert.equal(denied.length, 0); assert.equal(m.calls.connects, 1);
  t.mock.restoreAll();
  mocks(t, { access: { ...ACCESS, isBoss: false }, scope: { mode: "SELECTED_GAMES", gameIds: ["other_game"] } });
  const scoped = model();
  await assert.rejects(requestAdminNativeRefund(scoped.pool, execution, { ...input, actor: { ...ACTOR } }), /Access denied|FORBIDDEN|scope|Permission|denied/i);
});

test("只从已过账、已到期的冻结应退责任创建；未到期/超额/歧义均不建退款意图", async t => {
  const creates = mocks(t);
  for (const posting of [{ ...POSTING, due: false }, { ...POSTING, frozen_cents: "100" }]) {
    const m = model({ postings: [posting] });
    await assert.rejects(requestAdminNativeRefund(m.pool, execution, input), /not due|exceeds frozen/i);
  }
  const multiple = model({ postings: [POSTING, { ...POSTING, id: "posting_2" }] });
  await assert.rejects(requestAdminNativeRefund(multiple.pool, execution, input), /Multiple settlement postings/i);
  assert.equal(creates.length, 0);
});

test("部分退款只创建原责任意图并明确渠道尚未提交；重放保留原回执", async t => {
  const creates = mocks(t);
  const audits: any[] = [];
  t.mock.method(securityCore, "recordAudit", async (_c: unknown, event: any) => { audits.push(event); });
  const m = model();
  const result = await requestAdminNativeRefund(m.pool, execution, input);
  assert.equal(audits.length, 1); assert.equal(audits[0].actorType, "admin"); assert.equal(audits[0].actorId, "admin_1");
  assert.equal(audits[0].action, "order.refund.native.requested"); assert.equal(audits[0].objectId, "refund_1");
  assert.equal(audits[0].details.channelResult, "NOT_SUBMITTED"); assert.equal(audits[0].details.amountCents, "1200");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0], { postingId: "posting_1", renterUserId: "renter_1", amountCents: "1200", idempotencyKey: "refund_key_1",
    requestId: "request_1", admission: execution.admission, profile: execution.initialProfile, notifyUrl: "https://refund.example.invalid/notify", reason: "部分退款" });
  assert.equal(result.replayed, false); assert.equal(result.amountCents, "1200"); assert.equal(result.currency, "CNY");
  assert.deepEqual(result.responsibility, { postingId: "posting_1", frozenCents: "5000", dueAt: POSTING.due_at });
  assert.deepEqual(result.channel, { result: "NOT_SUBMITTED", bankArrival: "UNKNOWN" });
  t.mock.restoreAll();
  mocks(t, { receipt: { replayed: true, intentId: "refund_1", refundOrderNo: "RF" + "a".repeat(28), state: "SUBMITTING", budgetDisposition: "ALLOCATED" } });
  const replay = await requestAdminNativeRefund(model().pool, execution, input);
  assert.equal(replay.replayed, true); assert.equal(replay.state, "SUBMITTING"); assert.equal(replay.channel.result, "UNKNOWN");
});

test("非法金额/原因/缺初始准入在连接前拒绝；查询错误不吞成成功", async t => {
  const creates = mocks(t);
  for (const bad of [{ ...input, amountCents: "0" }, { ...input, amountCents: "01" }, { ...input, amountCents: "1.2" }, { ...input, reason: " " }, { ...input, reason: "退".repeat(134) }]) {
    const m = model(); await assert.rejects(requestAdminNativeRefund(m.pool, execution, bad)); assert.equal(m.calls.connects, 0);
  }
  const m = model(); await assert.rejects(requestAdminNativeRefund(m.pool, { admission: {} as never }, input), /initial admission/i); assert.equal(m.calls.connects, 1); assert.equal(creates.length, 0);
  t.mock.restoreAll();
  mocks(t, { failCreate: new Error("audit failure") });
  await assert.rejects(requestAdminNativeRefund(model().pool, execution, input), /audit failure/);
  assert.equal(creates.length, 0);
});

test("Admin读取退款列表区分本地意图与渠道观察，不把未取得终态读成到账", async t => {
  t.mock.method(orderTeam, "readOrderTeamAccess", async () => ({ teamState: "READY", canRead: true }));
  t.mock.method(adminAuthSession, "assertAdminCommandAuthorizedInTransaction", async () => ({}));
  t.mock.method(adminAuthorization, "loadEffectiveAdminAccess", async () => ACCESS);
  const client = { release() {}, async query(sql: string) {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT game_id FROM zzsh_order.rental_order")) return { rows: [{ game_id: "game_1" }] };
    if (sql.includes("FROM zzsh_order.channel_refund_intent i")) return { rows: [{ id: "refund_1", posting_id: "posting_1", refund_order_no: "RF" + "b".repeat(28),
      amount_cents: "1200", state: "UNKNOWN", budget_disposition: "ALLOCATED", requires_review: false, provider_refund_trx_no: null,
      completed_at: null, frozen_cents: "5000", allocated_cents: "1200", latest_event: "UNKNOWN", latest_evidence_level: "PROVIDER_RESPONSE",
      latest_observed_at: "2026-10-25T00:00:00.000000Z" }] };
    throw Error("UNEXPECTED_SQL " + sql);
  } } as unknown as PoolClient;
  const view = await readAdminNativeRefunds({ connect: async () => client } as unknown as Pool, { actor: ACTOR, orderId: "order_1" });
  assert.equal(view.items.length, 1); assert.equal(view.items[0]!.state, "UNKNOWN"); assert.equal(view.items[0]!.channelArrival, "UNKNOWN");
  assert.equal(view.items[0]!.providerRefundTrxNo, null);
  assert.deepEqual(view.items[0]!.postingResponsibility, { frozenCents: "5000", allocatedCents: "1200", remainingCents: "3800" });
});

test("Admin退款审计失败回滚整个命令，不留下成功回执", async t => {
  mocks(t);
  t.mock.method(securityCore, "recordAudit", async () => { throw Error("admin refund audit failed"); });
  const m = model();
  await assert.rejects(requestAdminNativeRefund(m.pool, execution, input), /admin refund audit failed/);
  assert(m.calls.queries.includes("ROLLBACK"));
});

test("退款命令沿用原订单对象范围，不凭同游戏写权限扩大到任意订单", async t => {
  const creates = mocks(t);
  t.mock.method(orderTeam, "readOrderTeamAccess", async () => ({ teamState: "READY", canRead: false }));
  await assert.rejects(requestAdminNativeRefund(model().pool, execution, input), error => (error as any).status === 403);
  assert.equal(creates.length, 0);
});

test("关闭新退款后仍允许原键恢复，重放不伪称尚未提交渠道", async t => {
  mocks(t, { receipt: { replayed: true, intentId: "refund_1", refundOrderNo: "RF" + "a".repeat(28), state: "SUBMITTING", budgetDisposition: "ALLOCATED" } });
  const result = await requestAdminNativeRefund(model().pool, {}, input);
  assert.equal(result.replayed, true); assert.equal(result.state, "SUBMITTING"); assert.equal(result.channel.result, "UNKNOWN");
});

test("退款意图提交结果未知保留原键并返回明确未知语义", async t => {
  mocks(t); t.mock.method(securityCore, "recordAudit", async () => {});
  await assert.rejects(requestAdminNativeRefund(model({ commitLoss: true }).pool, execution, input), error =>
    (error as any).status === 503 && (error as any).code === "EVIDENCE_UNAVAILABLE" && (error as any).originalKey === input.idempotencyKey);
});
