// SYNTHETIC_COMPONENT_MODEL：内存Admin/PG替身；不证明真实权限、PG或渠道退款。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import * as adminAuthSession from "../src/auth/admin-auth-session";
import * as adminAuthorization from "../src/auth/admin-authorization";
import * as adminScope from "../src/auth/admin-scope";
import * as securityCore from "../src/auth/security-core";
import * as orderTeam from "../src/im/order-team-access";
import * as abnormalStore from "../src/order/joinpay-abnormal-refund-store";
import { requestAdminAbnormalNativeRefund } from "../src/order/native-refund-command";

const ACTOR = { userId: "admin_1", sessionId: "admin_session" };
const ACCESS = { status: "ACTIVE", isBoss: true, passwordChangeRequired: false, permissions: new Set<string>(["order.settlement.write"]) };
const input = { actor: ACTOR, orderId: "order_1", confirmationId: "pay_1", idempotencyKey: "abnormal_key_1", requestId: "request_1" };
const execution = { admission: {} as never, initialProfile: {} as never };
function model(options: { commitLoss?: boolean } = {}) {
  const calls = { connects: 0, queries: [] as string[] };
  const client = { release() {}, async query(sql: string) {
    calls.queries.push(sql);
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql === "COMMIT") { if (options.commitLoss) throw Object.assign(Error("SYNTHETIC_COMMIT_ACK_LOSS"), { code: "ECONNRESET" }); return { rows: [], rowCount: 0 }; }
    if (sql.startsWith("SELECT game_id FROM zzsh_order.rental_order")) return { rows: [{ game_id: "game_1" }], rowCount: 1 };
    throw Error("UNEXPECTED_SQL " + sql);
  } } as unknown as PoolClient;
  return { pool: { connect: async () => { calls.connects++; return client; } } as unknown as Pool, calls };
}
function mocks(t: any, options: { access?: unknown; team?: boolean; receipt?: any; onTeam?: () => void } = {}) {
  t.mock.method(orderTeam, "readOrderTeamAccess", async () => { options.onTeam?.(); return { teamState: "READY", canRead: options.team !== false }; });
  t.mock.method(adminAuthSession, "assertAdminCommandAuthorizedInTransaction", async () => ({}));
  t.mock.method(adminAuthorization, "loadEffectiveAdminAccess", async () => options.access ?? ACCESS);
  t.mock.method(adminScope, "readAdminGameScope", async () => ({ mode: "ALL_GAMES", gameIds: [] }));
  const creates: any[] = [];
  t.mock.method(abnormalStore, "createAbnormalFormalRefundIntent", async (_c: PoolClient, value: any) => {
    creates.push(value);
    return options.receipt ?? { kind: "ALLOCATED", intentId: "refund_1", refundOrderNo: "RF" + "a".repeat(28), state: "READY",
      budgetDisposition: "ALLOCATED", amountCents: "1000", currency: "CNY", confirmationId: "pay_1", evidenceId: "jpe_1",
      anchorId: "paytrx_1", reasonCode: "LATE_PAYMENT", liabilityRootId: "liability_root_1", liabilityEventId: "liability_event_1" };
  });
  return creates;
}

test("C04B 异常退款命令复用order.settlement.write与对象范围，finance.read不足不通过", async t => {
  const denied = mocks(t, { access: { ...ACCESS, permissions: new Set(["finance.read"]) } });
  const m = model();
  await assert.rejects(requestAdminAbnormalNativeRefund(m.pool, execution, input), /denied|permission|FORBIDDEN/i);
  assert.equal(denied.length, 0);
  t.mock.restoreAll();
  mocks(t, { team: false });
  await assert.rejects(requestAdminAbnormalNativeRefund(model().pool, execution, input), error => (error as any).status === 403);
});

test("C04B 核准只建原责任/意图并返回NOT_SUBMITTED，金额不来自客户端", async t => {
  const creates = mocks(t);
  const audits: any[] = [];
  t.mock.method(securityCore, "recordAudit", async (_c: unknown, event: any) => { audits.push(event); });
  const result = await requestAdminAbnormalNativeRefund(model().pool, execution, input);
  assert.equal(creates.length, 1); assert.deepEqual(creates[0], { orderId: "order_1", confirmationId: "pay_1",
    idempotencyKey: "abnormal_key_1", requestId: "request_1", admission: execution.admission, profile: execution.initialProfile });
  assert.equal(result.outcome, "ALLOCATED"); assert.equal(result.amountCents, "1000"); assert.equal(result.currency, "CNY");
  assert.deepEqual(result.channel, { result: "NOT_SUBMITTED", bankArrival: "UNKNOWN" });
  assert.equal(result.responsibility.confirmationId, "pay_1");
  assert.equal(audits.length, 1); assert.equal(audits[0].action, "order.refund.abnormal.requested");
  assert.equal(audits[0].actorType, "admin"); assert.equal(audits[0].details.channelResult, "NOT_SUBMITTED");
});

test("C04B 原号歧义只返回REVIEW，不建意图也不伪称已提交", async t => {
  mocks(t, { receipt: { kind: "REVIEW_REQUIRED", reason: "ORIGINAL_ORDER_NO_AMBIGUOUS", confirmationId: "pay_1" } });
  const audits: any[] = [];
  t.mock.method(securityCore, "recordAudit", async (_c: unknown, event: any) => { audits.push(event); });
  const result = await requestAdminAbnormalNativeRefund(model().pool, execution, input);
  assert.equal(result.outcome, "REVIEW_REQUIRED"); assert.equal(result.intentId, null); assert.equal(result.amountCents, null);
  assert.deepEqual(result.channel, { result: "NOT_SUBMITTED", bankArrival: "UNKNOWN" });
  assert.equal(audits.length, 1); assert.equal(audits[0].action, "order.refund.abnormal.review_required");
});

test("R1 旧键恢复无新准入仍先复核当前Admin身份/对象，COMMIT未知保留原key", async t => {
  const receipt={kind:"REPLAYED",intentId:"refund_1",refundOrderNo:"RF"+"a".repeat(28),state:"SUCCEEDED",
    budgetDisposition:"CONSUMED",amountCents:"1000",currency:"CNY",confirmationId:"pay_1",evidenceId:"jpe_1",
    anchorId:"paytrx_1",reasonCode:"LATE_PAYMENT",liabilityRootId:"liability_root_1",liabilityEventId:"liability_event_1"};
  let team = 0; const creates = mocks(t, { receipt, onTeam: () => { team++; } });
  t.mock.method(securityCore, "recordAudit", async () => {});
  const model0 = model();
  const result = await requestAdminAbnormalNativeRefund(model0.pool, { admission: undefined, initialProfile: undefined }, input);
  assert.equal(team, 1); assert.equal(creates.length, 1);
  assert.equal("admission" in creates[0], false); assert.equal("profile" in creates[0], false);
  assert.equal(result.replayed, true); assert.equal(result.state, "SUCCEEDED");
  assert.deepEqual(result.channel, { result: "UNKNOWN", bankArrival: "UNKNOWN" });
  await assert.rejects(requestAdminAbnormalNativeRefund(model({ commitLoss: true }).pool,
    { admission: undefined, initialProfile: undefined }, input), error =>
    error instanceof Error && (error as any).code === "EVIDENCE_UNAVAILABLE" && (error as any).originalKey === input.idempotencyKey);
});
test("C04B 异常退款审计失败整笔回滚", async t => {
  mocks(t); t.mock.method(securityCore, "recordAudit", async () => { throw Error("abnormal refund audit failed"); });
  const m = model();
  await assert.rejects(requestAdminAbnormalNativeRefund(m.pool, execution, input), /audit failed/);
  assert.ok(m.calls.queries.includes("ROLLBACK"));
});

test("Master：已派发/已成功原键重放不能回NOT_SUBMITTED或再记人工核准",async t=>{
  const receipt={kind:"REPLAYED",intentId:"refund_1",refundOrderNo:"RF"+"a".repeat(28),state:"SUCCEEDED",
    budgetDisposition:"CONSUMED",amountCents:"1000",currency:"CNY",confirmationId:"pay_1",evidenceId:"jpe_1",
    anchorId:"paytrx_1",reasonCode:"LATE_PAYMENT",liabilityRootId:"liability_root_1",liabilityEventId:"liability_event_1"};
  mocks(t,{receipt});const audits:any[]=[];
  t.mock.method(securityCore,"recordAudit",async(_c:unknown,event:any)=>{audits.push(event);});
  const result=await requestAdminAbnormalNativeRefund(model().pool,execution,input);
  assert.equal(result.replayed,true);assert.equal(result.state,"SUCCEEDED");
  assert.equal(result.channel.result,"UNKNOWN");assert.equal(audits.length,0);
});
