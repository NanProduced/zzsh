import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { MessageScopeRecoveryLifecycle, listConsultationEvents, readConsultationContext, decodeEventCursor, encodeEventCursor, parseEventLimit, parseConsultationBody, parseLimit, parsePresenceBody, parseSupportType, startMessageScopeRecovery, toView } from "../src/im/consultation";
import { OrderDispatchLifecycle } from "../src/im/order-dispatch";
import { createImScopeLease, onLeaseConnection } from "../src/im/scope-lease";
import { scanOrderTeams } from "../src/im/order-team";
import { handleAdminBff } from "../src/bff/admin-bff";

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
    security: "ACTIVE", cookie: "", image: "https://media.example.test/avatar.png", exclusions: [] as unknown, hasExclusionEvent: true,
    row: { id: "cons_a", appId: "app_a", userId: "user_a", userName: "用户甲", userUsername: "name",
      kind: "SERVICE", state: "ACTIVE", assignedAdminId: "admin_a", adminName: "客服甲",
      subjectRef: null as string | null, version: 3, messageScopeState: "READY" },
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
    if (sql.includes("SELECT details FROM zzsh_iam.im_consultation_event")) return { rows: state.hasExclusionEvent ? [{ details: { excludedAdminIds: state.exclusions } }] : [] };
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) {
      assert.match(sql, /c\."id" = \$2/);
      const row = state.row;
      const own = row.assignedAdminId === values[2];
      const unassigned = !row.assignedAdminId && (row.kind === "SERVICE" ? values[3] : values[4]);
      return { rows: row.appId === values[0] && row.id === values[1] && row.state !== "CLOSED" && (own || unassigned) ? [row] : [] };
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
    if (sql.includes('SELECT "image" FROM "zzsh_auth_user"."user"')) return { rows: [{ image: state.image }] };
    if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ id: "user_a", name: "用户甲" }] };
    throw new Error("Unexpected SQL in consultation read test: " + sql);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const options = { pool, appId: "app_a" } as never;
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

test("context distinguishes absent and untyped subject without granting directory or membership access", async () => {
  const f = consultationReadFixture();
  f.state.permissions = ["im.support.read"];
  const value = await readConsultationContext(f.options, f.actor, "cons_a");
  assert.deepEqual(value.user, { status: "available", publicId: "user_a", displayName: "用户甲", avatar: f.state.image });
  assert.deepEqual(value.subject, { status: "absent" });
  assert.equal(value.membership.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(value), /phone|email|identityStatus|accountId|details|普通会员/);
  f.state.row.subjectRef = "listing_or_order";
  assert.deepEqual((await readConsultationContext(f.options, f.actor, "cons_a")).subject,
    { status: "unresolved", reference: "listing_or_order" });
  assert.ok(!f.calls.some(({ sql }) => /rental_order|rental_account|im_identity_mapping/.test(sql)));
  for (const image of ["javascript:alert(1)", "data:image/png;base64,secret", "https://name:secret@example.test/img", "not-a-url"]) {
    f.state.image = image;
    assert.equal((await readConsultationContext(f.options, f.actor, "cons_a")).user.avatar, null);
  }
});

test("read projections recheck session and current read/object grants inside their transaction", async () => {
  for (const kind of ["events", "context"]) {
    for (const scenario of ["no-read", "locked", "expired", "frozen", "other-app", "other-owner", "closed", "missing", "unqualified-complaint"]) {
      const f = consultationReadFixture();
      if (scenario === "no-read") f.state.permissions = ["im.support.accept"];
      if (scenario === "locked") f.state.locked = true;
      if (scenario === "expired") f.state.expired = true;
      if (scenario === "frozen") f.state.security = "FROZEN";
      if (scenario === "other-app") f.state.row.appId = "app_b";
      if (scenario === "other-owner") f.state.row.assignedAdminId = "admin_b";
      if (scenario === "closed") f.state.row.state = "CLOSED";
      if (scenario === "missing") f.state.row.id = "other";
      if (scenario === "unqualified-complaint") { f.state.row.kind = "COMPLAINT"; f.state.row.assignedAdminId = ""; }
      await assert.rejects(kind === "events" ? listConsultationEvents(f.options, f.actor, "cons_a", null, null)
        : readConsultationContext(f.options, f.actor, "cons_a"),
      (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && [401, 403, 404, 423].includes(Number(error.status))), scenario);
      assert.equal(f.calls.at(-1)!.sql, "ROLLBACK");
      assert.ok(!f.calls.some(({ sql }) => sql.includes('FROM "zzsh_iam"."im_consultation_event"')));
    }
  }
  const f = consultationReadFixture();
  f.state.row.kind = "COMPLAINT"; f.state.row.assignedAdminId = "";
  f.state.permissions.push("im.support.complaint");
  assert.equal((await readConsultationContext(f.options, f.actor, "cons_a")).service.type, "COMPLAINT");
});

test("both complaint reads reject excluded viewers and missing or malformed stored evidence", async () => {
  for (const assigned of [true, false]) {
    for (const evidence of ["excluded", "missing", "not-array", "invalid-entry", "absent-field"]) {
      const f = consultationReadFixture();
      f.state.row.kind = "COMPLAINT";
      f.state.row.assignedAdminId = assigned ? "admin_a" : "";
      f.state.permissions.push("im.support.complaint");
      f.state.exclusions = evidence === "excluded" ? ["admin_a"] : evidence === "invalid-entry" ? [42] : evidence === "not-array" ? "admin_a" : undefined;
      if (evidence === "missing") f.state.hasExclusionEvent = false;
      for (const read of [() => readConsultationContext(f.options, f.actor, "cons_a"), () => listConsultationEvents(f.options, f.actor, "cons_a", null, null)]) {
        await assert.rejects(read(), (error: unknown) => Boolean(error && typeof error === "object" && "status" in error && error.status === 404));
      }
      assert.ok(!f.calls.some(({ sql }) => sql.includes('SELECT "id", "event_type"') || sql.includes('SELECT "image"')));
    }
  }
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
