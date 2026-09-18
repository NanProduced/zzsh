import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { MessageScopeRecoveryLifecycle, parseConsultationBody, parseLimit, parsePresenceBody, parseSupportType, startMessageScopeRecovery, toView } from "../src/im/consultation";
import { OrderDispatchLifecycle } from "../src/im/order-dispatch";
import { createImScopeLease, onLeaseConnection } from "../src/im/scope-lease";
import { scanOrderTeams } from "../src/im/order-team";

test("order Team scanning stops on a global database failure instead of trying every object", async () => {
  const failure=Object.assign(new Error("private connection detail"),{code:"08006"});
  let attempted=0;
  const pool={query:async(sql:string)=>{
    if(sql.includes("SELECT g.*,o.renter_user_id")){attempted++;throw failure;}
    return {rows:sql.includes("SELECT g.order_id,op.id")?[{order_id:"a",id:null},{order_id:"b",id:null}]:[]};
  }};
  await assert.rejects(scanOrderTeams({pool,appId:"unavailable"} as never),error=>error===failure);
  assert.equal(attempted,1);
});

test("shared lease renews on its borrowed connection but never inside the callback transaction", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let transaction = false, renewals = 0, releases = 0;
  const connection = { query: async (sql: string) => {
    if (sql === "BEGIN") transaction = true;
    if (sql === "COMMIT" || sql === "ROLLBACK") transaction = false;
    return { rows: [] };
  }, release: () => { releases++; } };
  const pool = { connect: async () => connection };
  const lease = createImScopeLease(pool as never, "test-app", async (db) => {
    assert.equal(db, connection); assert.equal(transaction, false); renewals++; return true;
  }, () => new Error("lease lost"), 10);
  try {
    await lease.mutate("order:test", async (client) => {
      const before = renewals;
      await onLeaseConnection(client, async () => {
        t.mock.timers.tick(30); await Promise.resolve(); assert.equal(renewals, before);
      });
      t.mock.timers.tick(10); await Promise.resolve(); assert.ok(renewals > before);
    });
    assert.equal(releases, 1);
  } finally { await lease.stop(); t.mock.timers.reset(); }
});

for (const kind of ["onResult", "onFailure"] as const) {
  test(`dispatcher isolates throwing ${kind}, settles stop and accepts a later wake`, () => {
    const script = `
      const assert=require('node:assert/strict');
      const {OrderDispatchLifecycle}=require(${JSON.stringify(resolve(__dirname, "../src/im/order-dispatch.js"))});
      (async()=>{
        let calls=0, commits=0, observerCalls=0, oppositeCalls=0, reached;
        const signal=()=>new Promise(r=>{reached=r});
        let seen=signal();
        const pool={connect:async()=>{calls++; ${kind === "onFailure" ? "throw Object.assign(new Error('database-secret'),{code:'55P03'});" : "return {query:async sql=>{if(sql==='COMMIT')commits++;return {rows:[]}},release(){}};"}}};
        const worker=new OrderDispatchLifecycle();
        const options={pool,appId:'observer-regression',batchLimit:1,intervalMs:100000,
          ${kind === "onResult" ? "onFailure" : "onResult"}:()=>{oppositeCalls++},
          ${kind}:()=>{observerCalls++;reached();if(observerCalls===1)throw new Error('observer-secret');}};
        worker.start(options);await seen;await worker.beforeApplicationShutdown();
        worker.wake();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
        seen=signal();worker.start(options);await seen;await worker.beforeApplicationShutdown();
        await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(oppositeCalls,0);
        assert.equal(commits,${kind === "onResult" ? 2 : 0});
      })().catch(e=>{console.error(e);process.exitCode=1});`;
    const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "-e", script], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout + child.stderr, /im.order.dispatch.observer_failed/);
    assert.doesNotMatch(child.stdout + child.stderr, /observer-secret|database-secret/);
  });
}

test("order dispatcher stays off by default and reports only sanitized failure codes", async () => {
  const lifecycle = new OrderDispatchLifecycle();
  let calls = 0;
  let observed!: () => void;
  const failed = new Promise<void>((resolve) => { observed = resolve; });
  const failures: string[] = [];
  lifecycle.wake();
  await lifecycle.beforeApplicationShutdown();
  assert.equal(calls, 0);
  lifecycle.start({ appId: "unit-dispatch", batchLimit: 1, intervalMs: 100_000,
    pool: { connect: async () => { calls++; throw Object.assign(new Error("sensitive connection detail"), { code: "55P03" }); } } as never,
    onFailure: (code) => { failures.push(code); observed(); },
  });
  await failed;
  await lifecycle.beforeApplicationShutdown();
  lifecycle.wake();
  assert.equal(calls, 1);
  assert.deepEqual(failures, ["LOCK_BUSY"]);
  assert.equal(JSON.stringify(failures).includes("sensitive"), false);
});

test("consultation input accepts only the supported type and safe subject reference", () => {
  assert.deepEqual(parseConsultationBody({ type: "SERVICE", subjectRef: "listing_01" }), { type: "SERVICE", subjectRef: "listing_01" });
  assert.deepEqual(parseConsultationBody({ type: "COMPLAINT" }), { type: "COMPLAINT", subjectRef: null });
  assert.throws(() => parseConsultationBody({ type: "SERVICE", subjectRef: "../private" }), /Subject reference is invalid/);
  assert.throws(() => parseConsultationBody({ type: "SERVICE", extra: true }), /unknown field/);
  assert.throws(() => parseSupportType("CHAT"), /Support type is invalid/);
});

test("presence and queue limits reject values outside the server contract", () => {
  assert.deepEqual(parsePresenceBody({ availability: "AVAILABLE", connectionState: "CONNECTED" }), { availability: "AVAILABLE", connectionState: "CONNECTED" });
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit("100"), 100);
  assert.throws(() => parsePresenceBody({ availability: "AVAILABLE", connectionState: "CONNECTED", adminUserId: "other" }), /unknown field/);
  assert.throws(() => parsePresenceBody({ availability: "AVAILABLE", connectionState: "ONLINE" }), /Connection state is invalid/);
  assert.throws(() => parseLimit("101"), /Limit is invalid/);
});

test("consultation views project the authorized team from each account and never self-address", () => {
  const row = {
    id: "consult-1",
    userId: "user-1",
    kind: "SERVICE" as const,
    state: "ACTIVE" as const,
    userAccountId: "user_im_1",
    peerAccountId: "staff_im_1",
    assignedAdminId: "admin-1",
    subjectRef: "listing-1",
    version: 2,
    lastMessageAt: null,
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
    updatedAt: new Date("2026-09-16T00:00:00.000Z"),
    userName: "用户一",
    userUsername: "user-1",
    adminName: "客服一",
    appId: "provider-test",
    messageScopeType: "TEAM" as const,
    messageScopeId: "900001",
    messageScopeState: "READY" as const,
    messageScopeVersion: 1,
  };

  const userView = toView(row, "user_im_1");
  assert.equal(userView.peerAccountId, "staff_im_1");
  assert.equal(userView.conversationId, "user_im_1|2|900001");

  const adminView = toView(row, "staff_im_1", true, "admin-1");
  assert.equal(adminView.peerAccountId, "user_im_1");
  assert.equal(adminView.conversationId, "staff_im_1|2|900001");
  assert.notEqual(adminView.peerAccountId, "staff_im_1");

  const oldAdminView = toView(row, "old_staff_im", true, "admin-2");
  assert.equal(oldAdminView.peerAccountId, "user_im_1");
  assert.equal(oldAdminView.conversationId, null);

  assert.equal(toView({ ...row, state: "CLOSED" }, "user_im_1").conversationId, null);
});

test("scope recovery shutdown waits for the in-flight batch and prevents later ticks", async () => {
  let queryCount = 0;
  let releaseQuery!: () => void;
  let queryStarted!: () => void;
  const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
  const startedGate = new Promise<void>((resolve) => { queryStarted = resolve; });
  const client = {
    query: async () => { queryCount += 1; queryStarted(); await queryGate; return { rows: [] }; },
    release: () => undefined,
  };
  const options = {
    pool: { query: client.query, connect: async () => client },
    appId: "provider-test",
    provider: {} as never,
    supportManager: {} as never,
  } as never;
  const lifecycle = new MessageScopeRecoveryLifecycle();
  lifecycle.start(options, 1);
  await startedGate;
  let stopped = false;
  const shutdown = lifecycle.beforeApplicationShutdown().then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, false);
  releaseQuery();
  await shutdown;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, true);
  assert.ok(queryCount >= 1);
});

test("scope recovery reports a safe failure class when the batch query fails", async () => {
  let failureClass: string | undefined;
  const options = {
    pool: { query: async () => { throw new Error("private database failure"); } },
    appId: "provider-test",
    provider: {} as never,
    supportManager: {} as never,
  } as never;
  const stop = startMessageScopeRecovery(options, 1, (value) => { failureClass = value; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await stop();
  assert.equal(failureClass, "RECOVERY_UNEXPECTED");
});
