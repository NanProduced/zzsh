import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { MessageScopeRecoveryLifecycle, listAdminConsultations, listConsultationEvents, readConsultationContext, readConsultationLegacyOrderReference, decodeEventCursor, encodeEventCursor, parseEventLimit, parseConsultationBody, parseLimit, parsePresenceBody, parseSupportType, requireSupportAccess, scanSupportFirstResponseBreaches, startMessageScopeRecovery, toView } from "../src/im/consultation";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import { OrderDispatchLifecycle } from "../src/im/order-dispatch";
import { reserveSupportCandidateOutcome, resolveSupportConcurrencyLimit } from "../src/im/support-dispatch";
import { createImScopeLease, onLeaseConnection } from "../src/im/scope-lease";
import { scanOrderTeams } from "../src/im/order-team";
import { handleAdminBff } from "../src/bff/admin-bff";
import { SecurityApiError } from "../src/auth/security-core";

test("order Team scanning stops on a global database failure instead of trying every object", async () => {
  const failure=Object.assign(new Error("private connection detail"),{code:"08006"});
  let attempted=0;
  const pool={query:async(sql:string)=>{
    if(sql.includes("SELECT g.*,COALESCE(o.renter_user_id")){attempted++;throw failure;}
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
  assert.deepEqual(parseConsultationBody({ type: "SERVICE", subjectRef: "listing_01" }),
    { type: "SERVICE", entryIntent: "SERVICE", subjectRef: "listing_01" });
  // 投诉与业务咨询各自保留持久线程；入口意图仍用于欢迎语文案。
  assert.deepEqual(parseConsultationBody({ type: "COMPLAINT", subjectRef: "listing_01" }),
    { type: "COMPLAINT", entryIntent: "COMPLAINT", subjectRef: "listing_01" });
  assert.deepEqual(parseConsultationBody({ type: "COMPLAINT" }),
    { type: "COMPLAINT", entryIntent: "COMPLAINT", subjectRef: null });
  assert.equal(parseSupportType("COMPLAINT"), "COMPLAINT");
  assert.throws(() => parseConsultationBody({ type: "SERVICE", subjectRef: "../private" }), /Subject reference is invalid/);
  assert.throws(() => parseConsultationBody({ type: "SERVICE", extra: true }), /unknown field/);
  assert.throws(() => parseSupportType("CHAT"), /Support type is invalid/);
});

test("COMPLAINT additionally requires im.support.complaint", () => {
  const serviceOnly = { status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(["im.support.accept"]) } as never;
  assert.throws(() => requireSupportAccess(serviceOnly, "COMPLAINT"), /Permission required/);
  assert.doesNotThrow(() => requireSupportAccess(serviceOnly, "SERVICE"));
  const complaint = { status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(["im.support.accept", "im.support.complaint"]) } as never;
  assert.doesNotThrow(() => requireSupportAccess(complaint, "COMPLAINT"));
  assert.throws(() => requireSupportAccess(complaint, "COMPLAINT", "transfer"), /Permission required/);
  const complaintTransfer = { status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(["im.support.accept", "im.support.complaint", "im.support.transfer"]) } as never;
  assert.doesNotThrow(() => requireSupportAccess(complaintTransfer, "COMPLAINT", "transfer"));
  // Object-level handover grant covers only the exact pre-upgrade conversation,
  // not new complaint queues or dispatch eligibility.
  assert.doesNotThrow(() => requireSupportAccess(serviceOnly, "COMPLAINT", "accept", true));
  assert.throws(() => requireSupportAccess(serviceOnly, "COMPLAINT", "transfer", true), /Permission required/);
});

test("presence and queue limits reject values outside the server contract", () => {
  assert.deepEqual(parsePresenceBody({ availability: "AVAILABLE", connectionState: "CONNECTED" }), { availability: "AVAILABLE", connectionState: "CONNECTED" });
  assert.deepEqual(parsePresenceBody({ availability: "AVAILABLE", connectionState: "CONNECTED", takeover: true }), { availability: "AVAILABLE", connectionState: "CONNECTED", takeover: true });
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit("100"), 100);
  assert.throws(() => parsePresenceBody({ availability: "AVAILABLE", connectionState: "CONNECTED", adminUserId: "other" }), /unknown field/);
  assert.throws(() => parsePresenceBody({ availability: "AVAILABLE", connectionState: "CONNECTED", takeover: "yes" }), /takeover flag is invalid/);
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
    threadId: "thread-1",
    roundSeq: 2,
    threadState: "ACTIVE" as const,
    threadScopeId: "900001",
    threadScopeState: "READY" as const,
    threadPeerAccountId: "staff_im_1",
  };

  const userView = toView(row, "user_im_1");
  assert.equal(userView.peerAccountId, "staff_im_1");
  assert.equal(userView.conversationId, "user_im_1|2|900001");
  assert.equal(userView.threadId, "thread-1");
  assert.equal(userView.roundId, "consult-1");
  assert.equal(userView.roundSeq, 2);
  assert.equal(userView.threadState, "ACTIVE");
  assert.equal(userView.canSend, true);

  const adminView = toView(row, "staff_im_1", true, "admin-1");
  assert.equal(adminView.peerAccountId, "user_im_1");
  assert.equal(adminView.conversationId, "staff_im_1|2|900001");
  assert.equal(adminView.canSend, true);
  assert.notEqual(adminView.peerAccountId, "staff_im_1");

  const oldAdminView = toView(row, "old_staff_im", true, "admin-2");
  assert.equal(oldAdminView.peerAccountId, "user_im_1");
  assert.equal(oldAdminView.conversationId, null);
  assert.equal(oldAdminView.canSend, false);
  // 管理岗/本人可在轮次结束后读取同一线程历史；发送仍由轮次状态决定。
  const patrolClosed = toView({ ...row, state: "CLOSED", threadState: "IDLE" }, "patrol_im", true, "admin-2", true);
  assert.equal(patrolClosed.conversationId, "patrol_im|2|900001");
  assert.equal(patrolClosed.canSend, false);

  // 结束本轮只结束 round：Team 与历史保留，用户仍可读可发，线程回 IDLE。
  const closedUserView = toView({ ...row, state: "CLOSED", threadState: "IDLE" }, "user_im_1");
  assert.equal(closedUserView.conversationId, "user_im_1|2|900001");
  assert.equal(closedUserView.canSend, true);
  assert.equal(toView({ ...row, state: "CLOSED", threadState: "IDLE" }, "staff_im_1", true, "admin-1").canSend, false);
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

/* ---------- right-hand read projections: cursor and limit contract (offline) ----------
 * These guard the two ways a keyset page goes silently wrong: timestamp precision
 * losing rows, and a cursor being replayed against another consultation.
 */
test("event limit defaults to 20, accepts the 50 ceiling and rejects anything else", () => {
  assert.equal(parseEventLimit(null), 20);
  assert.equal(parseEventLimit("1"), 1);
  assert.equal(parseEventLimit("50"), 50);
  for (const bad of ["", "0", "51", "-1", "1.5", "abc", "1e2", "1e1", " 2", "02", "0x10"]) {
    assert.throws(() => parseEventLimit(bad), /Limit is invalid/, `limit ${bad} must be rejected`);
  }
});

test("event cursor round-trips microsecond precision and is bound to its consultation", () => {
  const stamp = "2026-10-11T08:19:04.123456Z";
  const cursor = encodeEventCursor("cons_a", stamp, "im_event_1");
  assert.deepEqual(decodeEventCursor("cons_a", cursor), { createdAt: stamp, id: "im_event_1" });
  assert.throws(() => decodeEventCursor("cons_b", cursor), /Cursor is invalid/, "cursor must not cross consultations");
});

test("event cursor rejects malformed, truncated and non-canonical payloads", () => {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const bad = [
    "not-base64-json",
    Buffer.from("[]").toString("base64url"),
    encoded(["cons_a", "2026-10-11T08:19:04Z", "im_event_1"]),
    encoded(["cons_a", "2026-10-11T08:19:04.123456+08:00", "im_event_1"]),
    encoded(["cons_a", "2026-10-11T08:19:04.1234567Z", "im_event_1"]),
    encoded(["cons_a", "2026-02-30T08:19:04.123456Z", "im_event_1"]),
    encoded(["cons_a", "2026-10-11T25:19:04.123456Z", "im_event_1"]),
    encoded(["cons_a", "2026-10-11T08:19:04.123456Z", ""]),
    encoded(["cons_a", "2026-10-11T08:19:04.123456Z", "bad id"]),
    encoded(["cons_a", "2026-10-11T08:19:04.123456Z", "im_event_1", "extra"]),
    encodeEventCursor("cons_a", "2026-10-11T08:19:04.123456Z", "im_event_1") + "=",
    "a".repeat(1025),
  ];
  for (const value of bad) {
    assert.throws(() => decodeEventCursor("cons_a", value), /Cursor is invalid/, `must reject ${value}`);
  }
});

// Controlled SQL seam: exercises real authorization/projection/BFF code, not PG execution.
function consultationReadFixture() {
  const state = {
    permissions: ["im.support.read", "im.support.accept"], locked: false, expired: false,
    security: "ACTIVE", cookie: "", image: "/api/v1/profile/avatars/user/user_a/2",
    row: { id: "cons_a", appId: "app_a", userId: "user_a", userName: "用户甲", userUsername: "name",
      kind: "SERVICE", state: "ACTIVE", assignedAdminId: "admin_a", adminName: "客服甲",
      subjectRef: null as string | null, version: 3, messageScopeState: "READY" },
    subjectMatches: [] as { kind: string; id: string; displayNo: string | null; title: string | null; related?: boolean; versionId?: string | null }[],
    legacyOrders: [] as { id: string; displayNo: string; renter: string; owner: string; deleted?: boolean }[],
    publicVersionId: null as string | null, publicFailure: null as Error | null, publicReads: [] as string[],
    events: [
      { id: "event_c", type: "TRANSFERRED", actorType: "admin", actorId: "missing_admin", fromAdminId: "admin_a", toAdminId: "admin_b", createdAt: "2026-10-11T08:19:04.123457Z" },
      { id: "event_b", type: "ASSIGNED", actorType: "system", actorId: "user_a", fromAdminId: null, toAdminId: "admin_a", createdAt: "2026-10-11T08:19:04.123456Z" },
      { id: "event_a", type: "CREATED", actorType: "user", actorId: "user_a", fromAdminId: null, toAdminId: null, createdAt: "2026-10-11T08:19:04.123456Z" },
    ],
  };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (["BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"].includes(sql)) return { rows: [] };
    if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: state.expired ? [] : [{ locked: state.locked, twoFactorEnabled: true }] };
    if (sql.includes('FROM "zzsh_iam"."admin_security"')) return { rows: [{ status: state.security, isBoss: false, passwordChangeRequired: false }] };
    if (sql.includes("WITH role_permissions AS")) return { rows: state.permissions.map(permissionCode => ({ permissionCode })) };
    if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) {
      const key = { provider: "yunxin" as const, appId: "app_a", realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: "admin_a" };
      return { rows: [{ accountId: deriveYunxinAccountId(key), identityMarker: buildYunxinIdentityMarker(key), status: "READY" }] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c') && sql.includes('ORDER BY CASE WHEN c."assigned_admin_id" = $2')) {
      const row = { ...state.row, userImage: state.image };
      const visible = row.appId === values[0] && row.state !== "CLOSED"
        && (row.kind !== "COMPLAINT" || Boolean(values[4]))
        && (row.assignedAdminId === values[1] || (!row.assignedAdminId && Boolean(values[2])));
      return { rows: visible ? [row] : [] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) {
      assert.match(sql, /c\."id" = \$2/);
      assert.doesNotMatch(sql, /c\."kind" = 'COMPLAINT'/);
      const row = { ...state.row, userImage: state.image };
      const own = row.assignedAdminId === values[2];
      const unassigned = !row.assignedAdminId && Boolean(values[3]);
      return { rows: row.appId === values[0] && row.id === values[1] && row.state !== "CLOSED"
        && (row.kind !== "COMPLAINT" || Boolean(values[4])) && (own || unassigned) ? [row] : [] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation_event"')) {
      assert.match(sql, /ORDER BY "created_at" DESC, "id" DESC/);
      assert.ok(!sql.includes('"details"'));
      const [id, beforeId, beforeTime, limit] = values;
      return { rows: state.events.filter(event => id === state.row.id && (!beforeId || event.createdAt < String(beforeTime)
        || (event.createdAt === beforeTime && event.id < String(beforeId)))).slice(0, Number(limit)) };
    }
    if (sql.includes('FROM "zzsh_auth_admin"."user"')) {
      assert.deepEqual(values[0], [...new Set(values[0] as string[])]);
      return { rows: [{ id: "admin_a", name: "客服甲" }, { id: "admin_b", name: "客服乙" }] };
    }
    if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ id: "user_a", name: "用户甲" }] };
    if (sql.includes('FROM zzsh_order.legacy_order_read_snapshot l')) {
      assert.match(sql, /l\.renter_user_id=\$2 OR l\.owner_user_id=\$2/);
      assert.match(sql, /source_snapshot->>'is_delete'/);
      const row=state.legacyOrders.find(item=>item.id===values[0]&&!item.deleted&&(item.renter===values[1]||item.owner===values[1]));
      return { rows: row?[{id:row.id,displayNo:row.displayNo,party:row.renter===values[1]?"RENTER":"OWNER"}]:[] };
    }
    if (sql.includes('FROM "zzsh_order"."rental_order" o')) {
      assert.equal(values[2],state.row.userId);
      assert.match(sql,/o\."renter_user_id"=\$3 OR o\."owner_user_id"=\$3/);
      assert.match(sql,/own_order\.renter_user_id=\$3 OR own_order\.owner_user_id=\$3/);
      assert.doesNotMatch(sql,/own_order\.status|o\."status"/);
      return { rows: state.subjectMatches.map(row=>({...row,related:row.related===true,versionId:row.versionId??null})) };
    }
    throw new Error("Unexpected SQL in consultation read test: " + sql);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const options = { pool, appId: "app_a", readPublicAccount: async (_client:unknown,id:string) => {
    state.publicReads.push(id);if(state.publicFailure)throw state.publicFailure;
    if(!state.publicVersionId)throw new SecurityApiError(404,"NOT_FOUND","Not found");
    return {versionId:state.publicVersionId};
  } } as never;
  const actor = { userId: "admin_a", sessionId: "session_a" } as never;
  return { state, calls, pool, options, actor };
}

test("event projection keeps newest pages, microseconds and actor roles without private fields", async () => {
  const f = consultationReadFixture();
  const page = await listConsultationEvents(f.options, f.actor, "cons_a", "2", null);
  assert.deepEqual(page.events.map(row => row.id), ["event_b", "event_c"]);
  assert.deepEqual(page.events[0]!.actor, { kind: "system", displayName: "系统" });
  assert.deepEqual(page.events[1]!.actor, { kind: "admin", displayName: "客服" });
  assert.deepEqual(page.events[1]!.from, { displayName: "客服甲" });
  assert.deepEqual(page.events[1]!.to, { displayName: "客服乙" });
  const older = await listConsultationEvents(f.options, f.actor, "cons_a", "2", page.nextCursor);
  assert.deepEqual(older.events.map(row => row.id), ["event_a"]);
  assert.equal(older.nextCursor, null);
  assert.equal(older.events[0]!.actor.displayName, "用户甲");
  assert.deepEqual(Object.keys(page.events[0]!).sort(), ["actor", "from", "id", "occurredAt", "to", "type"]);
  assert.doesNotMatch(JSON.stringify(page), /actorId|peerAccountId|details|excludedAdminIds/);
  assert.equal(f.calls[1]!.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.ok(f.calls.every(({ sql }) => !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql)));
  f.state.events = [];
  assert.deepEqual(await listConsultationEvents(f.options, f.actor, "cons_a", null, null), { events: [], nextCursor: null });
});

test("legacy consultation reference checks current consultation user and keeps source distinct", async () => {
  const f=consultationReadFixture(), legacy=`legacy_order_${"a".repeat(40)}`;
  f.state.legacyOrders=[{id:legacy,displayNo:"OLD-123",renter:"user_a",owner:"owner"}];
  f.state.row.subjectRef=`legacy-order:${legacy}`;
  const subject=(await readConsultationContext(f.options,f.actor,"cons_a")).subject;
  assert.deepEqual(subject,{status:"resolved",kind:"ORDER",origin:"LEGACY",displayNo:"OLD-123",title:null,target:{kind:"ORDER",id:legacy},party:"RENTER"});
  const later=await readConsultationLegacyOrderReference(f.options,f.actor,"cons_a",legacy);
  assert.equal(later.contractVersion,"im-legacy-order-reference.v1");assert.deepEqual(later.subject,subject);
  assert.doesNotMatch(JSON.stringify(later),/amount|money|mobile|owner_user_id|renter_user_id/);
  f.state.legacyOrders[0]!.renter="other";f.state.legacyOrders[0]!.owner="user_a";
  assert.equal((await readConsultationLegacyOrderReference(f.options,f.actor,"cons_a",legacy)).subject.party,"OWNER");
  f.state.legacyOrders[0]!.owner="other";
  await assert.rejects(readConsultationLegacyOrderReference(f.options,f.actor,"cons_a",legacy),(error:any)=>error.status===404);
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"unresolved");
  f.state.legacyOrders[0]!.owner="user_a";f.state.legacyOrders[0]!.deleted=true;
  await assert.rejects(readConsultationLegacyOrderReference(f.options,f.actor,"cons_a",legacy),(error:any)=>error.status===404);
  await assert.rejects(readConsultationLegacyOrderReference(f.options,f.actor,"cons_a","legacy_order_invalid"),(error:any)=>error.status===404);
  for(const scenario of ["no-read","other-app","other-owner","closed","expired","locked","frozen"]){
    const denied=consultationReadFixture();denied.state.legacyOrders=[{id:legacy,displayNo:"OLD-123",renter:"user_a",owner:"owner"}];
    if(scenario==="no-read")denied.state.permissions=[];if(scenario==="other-app")denied.state.row.appId="app_other";
    if(scenario==="other-owner")denied.state.row.assignedAdminId="admin_other";if(scenario==="closed")denied.state.row.state="CLOSED";
    if(scenario==="expired")denied.state.expired=true;if(scenario==="locked")denied.state.locked=true;if(scenario==="frozen")denied.state.security="FROZEN";
    await assert.rejects(readConsultationLegacyOrderReference(denied.options,denied.actor,"cons_a",legacy));
    assert(!denied.calls.some(({sql})=>sql.includes('legacy_order_read_snapshot')));
  }
});

test("context distinguishes absent and untyped subject without granting directory or membership access", async () => {
  const f = consultationReadFixture();
  f.state.permissions = ["im.support.read"];
  const value = await readConsultationContext(f.options, f.actor, "cons_a");
  assert.deepEqual(value.user, { status: "available", publicId: "user_a", displayName: "用户甲", avatar: f.state.image });
  assert.ok(!f.calls.some(({ sql }) => sql.includes('SELECT "image" FROM')), "avatar reuses the authorized consultation join");
  assert.deepEqual(value.subject, { status: "absent" });
  assert.equal(value.membership.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(value), /phone|email|identityStatus|accountId|details|普通会员/);
  f.state.row.subjectRef = "listing_or_order";
  assert.deepEqual((await readConsultationContext(f.options, f.actor, "cons_a")).subject,
    { status: "unresolved", rawRef: "listing_or_order" });
  // 关联对象只查业务单表，不碰身份映射，也不写任何表。
  assert.ok(!f.calls.some(({ sql }) => /im_identity_mapping|\b(INSERT|UPDATE|DELETE)\b/.test(sql)));
  // 唯一命中才 resolved，且必须带业务展示号；标题可为 null。
  f.state.subjectMatches = [{ kind: "ORDER", id: "rental_order_1", displayNo: "DD20261031001", title: "三角洲行动账号", related:true }];
  assert.deepEqual((await readConsultationContext(f.options, f.actor, "cons_a")).subject, {
    status: "resolved", kind: "ORDER", displayNo: "DD20261031001", title: "三角洲行动账号",
    target: { kind: "ORDER", id: "rental_order_1" },
  });
  // 订单与账号撞号：无法确定，保持 unresolved，绝不猜成订单。
  f.state.subjectMatches = [
    { kind: "ORDER", id: "same_id", displayNo: "DD20261031002", title: null },
    { kind: "ACCOUNT", id: "same_id", displayNo: "AC0000000002", title: null },
  ];
  assert.equal((await readConsultationContext(f.options, f.actor, "cons_a")).subject.status, "unresolved");
  // 没有业务展示号（内部 id 不上屏）也不给 resolved。
  f.state.subjectMatches = [{ kind: "ACCOUNT", id: "acct_1", displayNo: null, title: null }];
  assert.equal((await readConsultationContext(f.options, f.actor, "cons_a")).subject.status, "unresolved");
  for (const image of ["https://media.example.test/avatar.png", "//media.example.test/avatar.png", "/api/v1/profile/avatars/user/user_a/2?token=secret", "javascript:alert(1)", "data:image/png;base64,secret", "https://name:secret@example.test/img", "not-a-url"]) {
    f.state.image = image;
    assert.equal((await readConsultationContext(f.options, f.actor, "cons_a")).user.avatar, null);
  }
});

test("subjects reject unrelated orders across aliases and retain related orders without a status gate",async()=>{
  const f=consultationReadFixture();
  for(const ref of ["order:other","ORDER:DD20261031001","other"]){
    f.state.row.subjectRef=ref;
    f.state.subjectMatches=[{kind:"ORDER",id:"other",displayNo:"DD20261031001",title:"private",related:false}];
    const view=await readConsultationContext(f.options,f.actor,"cons_a");
    assert.equal(view.subject.status,"unresolved");assert.doesNotMatch(JSON.stringify(view.subject),/private|DD20261031001.*title/);
  }
  f.state.subjectMatches[0]!.related=true;
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"resolved");
  assert.equal(f.state.publicReads.length,0);
});

test("account subjects preserve owned/order-related and public DETAIL visibility but not hidden version aliases",async()=>{
  const f=consultationReadFixture();f.state.row.subjectRef="account:acct";
  f.state.subjectMatches=[{kind:"ACCOUNT",id:"acct",displayNo:"AC0000000001",title:null,related:true}];
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"resolved");
  f.state.subjectMatches[0]!.related=false;
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"unresolved");
  f.state.publicVersionId="published-version";
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"resolved");
  f.state.row.subjectRef="listing:hidden-version";f.state.subjectMatches[0]!.versionId="hidden-version";
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"unresolved");
  f.state.subjectMatches[0]!.versionId="published-version";
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"resolved");
  f.state.publicFailure=new Error("database unavailable");
  await assert.rejects(readConsultationContext(f.options,f.actor,"cons_a"),/database unavailable/);
});

test("subject collisions remain unresolved before permission filtering and historical references are rechecked",async()=>{
  const f=consultationReadFixture();f.state.row.subjectRef="collision";
  f.state.subjectMatches=[{kind:"ORDER",id:"foreign",displayNo:null,title:null,related:false},{kind:"ACCOUNT",id:"mine",displayNo:"AC0000000001",title:null,related:true}];
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"unresolved");
  f.state.subjectMatches=[{kind:"ACCOUNT",id:"mine",displayNo:"AC0000000001",title:null,related:true}];
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"resolved");
  f.state.subjectMatches[0]!.related=false;
  assert.equal((await readConsultationContext(f.options,f.actor,"cons_a")).subject.status,"unresolved");
});

test("read projections recheck session and current read/object grants inside their transaction", async () => {
  for (const kind of ["events", "context"]) {
    for (const scenario of ["no-read", "locked", "expired", "frozen", "other-app", "other-owner", "closed", "missing"]) {
      const f = consultationReadFixture();
      if (scenario === "no-read") f.state.permissions = ["im.support.accept"];
      if (scenario === "locked") f.state.locked = true;
      if (scenario === "expired") f.state.expired = true;
      if (scenario === "frozen") f.state.security = "FROZEN";
      if (scenario === "other-app") f.state.row.appId = "app_b";
      if (scenario === "other-owner") f.state.row.assignedAdminId = "admin_b";
      if (scenario === "closed") f.state.row.state = "CLOSED";
      if (scenario === "missing") f.state.row.id = "other";
      await assert.rejects(kind === "events" ? listConsultationEvents(f.options, f.actor, "cons_a", null, null)
        : readConsultationContext(f.options, f.actor, "cons_a"),
      (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && [401, 403, 404, 423].includes(Number(error.status))), scenario);
      assert.equal(f.calls.at(-1)!.sql, "ROLLBACK");
      assert.ok(!f.calls.some(({ sql }) => sql.includes('FROM "zzsh_iam"."im_consultation_event"')));
    }
  }
});

test("COMPLAINT rows require the complaint grant and never read exclusion evidence", async () => {
  for (const assigned of [true, false]) {
    const f = consultationReadFixture();
    f.state.row.kind = "COMPLAINT";
    f.state.row.assignedAdminId = assigned ? "admin_a" : "";
    f.state.permissions.push("im.support.complaint");
    assert.equal((await readConsultationContext(f.options, f.actor, "cons_a")).service.type, "COMPLAINT");
    assert.equal((await listConsultationEvents(f.options, f.actor, "cons_a", null, null)).events.length, 3);
    assert.ok(!f.calls.some(({ sql }) => sql.includes("SELECT details FROM zzsh_iam.im_consultation_event")));
  }

  const denied = consultationReadFixture();
  denied.state.row.kind = "COMPLAINT";
  denied.state.row.assignedAdminId = "";
  assert.equal((await listAdminConsultations({ pool: denied.pool, appId: "app_a" } as never, denied.actor, null as never, 10)).consultations.length, 0);
  await assert.rejects(readConsultationContext(denied.options, denied.actor, "cons_a"), /Consultation not found/);

  const f = consultationReadFixture();
  f.state.row.kind = "COMPLAINT";
  f.state.row.assignedAdminId = "";
  f.state.permissions.push("im.support.complaint");
  const queue = await listAdminConsultations({ pool: f.pool, appId: "app_a" } as never, f.actor, null as never, 10);
  assert.equal(queue.consultations.length, 1, "an authorized unassigned complaint joins the queue");
  assert.equal(queue.consultations[0]!.type, "COMPLAINT");
  const listQuery = f.calls.find(({ sql }) => sql.includes('ORDER BY CASE WHEN c."assigned_admin_id" = $2'));
  assert.ok(listQuery);
  assert.match(listQuery!.sql, /c2\."kind" <> 'COMPLAINT' OR \$5::boolean/);
});

test("new consultation reads traverse the real BFF and handler with strict methods and queries", async () => {
  const f = consultationReadFixture();
  const origin = "http://127.0.0.1:4291";
  const security = { pool: f.pool, apiOrigin: "http://127.0.0.1:4292", adminOrigin: origin,
    adminAuth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      f.state.cookie = headers.get("cookie") ?? "";
      return { user: { id: "admin_a", twoFactorEnabled: true }, session: { id: "session_a", locked: false } };
    } } } };
  const opts = { adminOrigin: origin, apiOrigin: security.apiOrigin, adminSecurityOptions: security,
    yunxin: { security, appId: "app_a", consultation: f.options } } as never;
  const run = async (path: string, method = "GET", requestOrigin = origin) => {
    let status = 200, body: unknown;
    const response = { setHeader() { return response; }, status(code: number) { status = code; return response; },
      json(value: unknown) { body = value; }, send(value: unknown) { body = value; } };
    await handleAdminBff({ method, url: path, originalUrl: path,
      headers: { origin: requestOrigin, cookie: "zzsh_admin.session_token=fixture-only" } }, response as never, opts);
    return { status, body };
  };
  const page = await run("/im/consultations/cons_a/events?limit=1");
  assert.equal(page.status, 200);
  assert.equal((page.body as { events: unknown[] }).events.length, 1);
  assert.match(f.state.cookie, /fixture-only/);
  const cursor = (page.body as { nextCursor: string }).nextCursor;
  const second = await run("/im/consultations/cons_a/events?limit=1&cursor=" + cursor);
  assert.equal((second.body as { events: Array<{ id: string }> }).events[0]!.id, "event_b");
  assert.equal((await run("/im/consultations/cons_a/context")).status, 200);
  for (const suffix of ["events", "context"]) {
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await run("/im/consultations/cons_a/" + suffix, method)).status, 404);
    assert.equal((await run("/im/consultations/cons_a/" + suffix, "GET", "http://invalid.local")).status, 403);
    assert.equal((await run("/im/consultations/cons_a/" + suffix + "/extra")).status, 404);
  }
  for (const query of ["limit=0", "limit=2&limit=3", "cursor=", "limit=1e1", "other=1"]) {
    assert.equal((await run("/im/consultations/cons_a/events?" + query)).status, 400, query);
  }
  assert.equal((await run("/im/consultations/cons_a/context?userId=other")).status, 400);
});

test("support dispatch has no hard workload cap and filters complaint candidates", async () => {
  const staff = (id: string, complaint = true) => ({ adminUserId: id, adminName: id, accountId: `im_${id}`, allGames: true, gameIds: [] as string[], complaint });
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = (rows: (sql: string) => unknown[]) => ({
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: rows(sql) };
    },
  });

  calls.length = 0;
  const picked = client((sql) => (sql.includes('SELECT p."admin_user_id" FROM') ? [{ admin_user_id: "admin_a" }] : []));
  assert.equal((await reserveSupportCandidateOutcome(picked as never, "app_a", "SERVICE", [staff("admin_a")], undefined, 2)).candidate?.adminUserId, "admin_a");
  const select = calls[0]!;
  assert.doesNotMatch(select.sql, /active_load|responsible_admin_id|ORDER BY CASE/);
  assert.deepEqual(select.values, ["app_a", ["admin_a"]]);

  // 没有在线客服是唯一的空候选原因。
  const offline = client(() => []);
  assert.deepEqual(await reserveSupportCandidateOutcome(offline as never, "app_a", "SERVICE", [staff("admin_a")]),
    { candidate: null, reason: "NO_ONLINE_STAFF" });

  // 选中后咨询占用 +1；订单只推进轮换时间，不把订单当第二份咨询占用。
  calls.length = 0;
  const service = client((sql) => (sql.includes('SELECT p."admin_user_id" FROM') ? [{ admin_user_id: "admin_a" }] : []));
  await reserveSupportCandidateOutcome(service as never, "app_a", "SERVICE", [staff("admin_a")]);
  assert.match(calls[1]!.sql, /active_load=active_load\+1/);
  calls.length = 0;
  const order = client((sql) => (sql.includes('SELECT p."admin_user_id" FROM') ? [{ admin_user_id: "admin_a" }] : []));
  await reserveSupportCandidateOutcome(order as never, "app_a", "ORDER", [staff("admin_a")]);
  assert.doesNotMatch(calls[1]!.sql, /active_load=active_load\+1/);
  assert.match(calls[1]!.sql, /last_order_assigned_at=clock_timestamp\(\)/);

  // 投诉候选必须单独持有 im.support.complaint。
  const complaintPicked = {
    query: async (sql: string, values: unknown[] = []) => ({
      rows: sql.includes('SELECT p."admin_user_id" FROM') && (values[1] as string[]).length ? [{ admin_user_id: "admin_a" }] : [],
    }),
  };
  assert.deepEqual(await reserveSupportCandidateOutcome(complaintPicked as never, "app_a", "COMPLAINT", [staff("admin_a", false)]),
    { candidate: null, reason: "NO_ONLINE_STAFF" });
});

test("support concurrency limit keeps the historical default and rejects out-of-range values", () => {
  assert.equal(resolveSupportConcurrencyLimit(undefined), 3);
  assert.equal(resolveSupportConcurrencyLimit(null), 3);
  assert.equal(resolveSupportConcurrencyLimit(1), 1);
  assert.equal(resolveSupportConcurrencyLimit(100), 100);
  for (const bad of [0, 101, -1, 2.5, Number.NaN]) {
    assert.throws(() => resolveSupportConcurrencyLimit(bad), /Invalid support concurrency limit/, String(bad));
  }
});

test("first response breach scan writes one reminder fact per overdue round", async () => {
  let captured: { sql: string; values: unknown[] } | undefined;
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    captured = { sql, values };
    return { rows: [{ id: "im_consult_1", reminded: true }, { id: "im_consult_2", reminded: false }] };
  } };
  const result = await scanSupportFirstResponseBreaches({ pool: pool as never, appId: "app_a" }, 5);
  assert.deepEqual(result, { overdue: ["im_consult_1", "im_consult_2"], reminded: ["im_consult_1"] });
  assert.deepEqual(captured!.values, ["app_a", 120, "im.consultation.first_response", "im.consultation.first_response.reminder", 5]);
  assert.match(captured!.sql, /LIMIT \$5/);
  assert.match(captured!.sql, /NOT EXISTS/);
  await scanSupportFirstResponseBreaches({ pool: pool as never, appId: "app_a", firstResponseSeconds: 300 }, 500);
  assert.equal(captured!.values[1], 300);
  assert.equal(captured!.values[4], 100);
});

test("admin view exposes queue facts for a waiting round but never to the user", () => {
  const row = {
    id: "cons_wait", userId: "user_a", kind: "SERVICE" as const, state: "WAITING" as const,
    userAccountId: "user_im_a", peerAccountId: null, assignedAdminId: null, subjectRef: null,
    firstUserMessageAt: new Date(Date.now() - 65_000).toISOString(), version: 1,
    lastMessageAt: null, createdAt: new Date(0), updatedAt: new Date(0),
    userName: "用户甲", userUsername: null, adminName: null, appId: "app_a",
    messageScopeType: "TEAM" as const, messageScopeId: "900001", messageScopeState: "READY" as const,
    messageScopeVersion: 1, threadId: "thread_1", roundSeq: 1, threadState: "WAITING" as const,
    threadScopeId: "900001", threadScopeState: "READY" as const, threadPeerAccountId: null,
  };
  const adminView = toView(row, "staff_im_a", true, "admin_a");
  assert.equal(adminView.queued, true);
  assert.equal(adminView.waitingSince, row.firstUserMessageAt);
  assert.ok((adminView.queueWaitSeconds ?? 0) >= 60);
  const userView = toView(row, "user_im_a");
  assert.equal(userView.queued, undefined);
  assert.equal(userView.queueWaitSeconds, undefined);
  // 已接起的轮次不再算排队。
  assert.equal(toView({ ...row, state: "ACTIVE" as const, assignedAdminId: "admin_a" }, "staff_im_a", true, "admin_a").queued, false);
});
test("manual takeover and transfers have no capacity SQL gate", async () => {
  const staff = (id: string) => ({ adminUserId: id, adminName: id, accountId: `im_${id}`, allGames: true, gameIds: [] as string[], complaint: true });
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return { rows: sql.includes('SELECT p."admin_user_id" FROM') ? [{ admin_user_id: "admin_a" }] : [] };
  } };
  await reserveSupportCandidateOutcome(client as never, "app_a", "SERVICE", [staff("admin_a")], "admin_a", 1, false);
  assert.doesNotMatch(calls[0]!.sql, /< \$3/);
  assert.deepEqual(calls[0]!.values, ["app_a", ["admin_a"]]);
});
