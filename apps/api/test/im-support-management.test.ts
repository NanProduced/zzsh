import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import {
  PRESENCE_SESSION_CLOSE_SQL,
  PRESENCE_SESSION_OPEN_SQL,
  heartbeatOwnPresence,
  presenceSessionAction,
  presenceSessionEndReason,
  readAdminMessageAccess,
  readOwnPresence,
  supportManagerIdentityKey,
  takeoverConsultation,
  takeoverDecision,
} from "../src/im/consultation";
import { reapStaleSupportSessions } from "../src/im/support-dispatch";
import {
  decodeSupportAuditCursor,
  encodeSupportAuditCursor,
  listAuditConversations,
  listSupportHandovers,
  parseHandoverLimit,
  parseHandoverNote,
  parseSupportDate,
  readPatrolOrderTeamAccess,
  readSupportOverview,
  readSupportToday,
  recordSupportHandover,
  readLatestHandoverNote,
  requireSupportAuditTakeover,
  requireSupportManagementRead,
} from "../src/im/support-management";

const APP_ID = "provider-test";

type QueryResult = { rows: unknown[] };
type Call = { sql: string; values: unknown[] };

function fakePool(handler: (sql: string, values: unknown[]) => QueryResult) {
  const calls: Call[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return handler(sql, values);
  };
  return {
    calls,
    pool: { query, connect: async () => ({ query, release() {} }) },
  };
}

function adminAccess(permissions: string[], boss = false) {
  return { status: "ACTIVE" as const, isBoss: boss, passwordChangeRequired: false, permissions: new Set(permissions) };
}

const TRANSACTION_SQL = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"]);

function adminContextHandler(input: {
  boss?: boolean;
  permissions?: string[];
  extras?: (sql: string, values: unknown[]) => QueryResult | null;
}) {
  const boss = input.boss === true;
  const permissions = input.permissions ?? [];
  return (sql: string, values: unknown[]): QueryResult => {
    if (TRANSACTION_SQL.has(sql)) return { rows: [] };
    if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: [{ locked: false, twoFactorEnabled: true, suspended: false }] };
    if (sql.includes('FROM "zzsh_iam"."admin_security"')) return { rows: [{ status: "ACTIVE", isBoss: boss, passwordChangeRequired: false }] };
    if (sql.includes("WITH role_permissions AS")) return { rows: permissions.map((permissionCode) => ({ permissionCode })) };
    const extra = input.extras?.(sql, values);
    if (extra) return extra;
    throw new Error("Unexpected SQL in support management test: " + sql);
  };
}

const adminContext = { userId: "admin_a", sessionId: "session_a", credentials: {}, security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false }, sessionLocked: false } as never;

test("support date, handover note and limit follow the strict server contract", () => {
  assert.equal(parseSupportDate(undefined), null);
  assert.equal(parseSupportDate("2026-10-29"), "2026-10-29");
  for (const bad of ["", "2026-2-9", "2026-02-30", "2026-13-01", "20261029"]) {
    assert.throws(() => parseSupportDate(bad), /Date is invalid/, bad);
  }
  assert.equal(parseHandoverNote(undefined), null);
  assert.equal(parseHandoverNote("  "), null);
  assert.equal(parseHandoverNote("  已电话沟通  "), "已电话沟通");
  assert.equal(parseHandoverNote("a".repeat(200)), "a".repeat(200));
  assert.throws(() => parseHandoverNote("a".repeat(201)), /Handover note is invalid/);
  assert.throws(() => parseHandoverNote("a\nb"), /Handover note is invalid/);
  assert.throws(() => parseHandoverNote(42), /Handover note is invalid/);
  assert.equal(parseHandoverLimit(undefined), 20);
  assert.equal(parseHandoverLimit("50"), 50);
  for (const bad of ["", "0", "51", "01", "1.5", "abc"]) assert.throws(() => parseHandoverLimit(bad), /Limit is invalid/, bad);
});

test("audit cursor round-trips microseconds and rejects cross-shape payloads", () => {
  const stamp = "2026-10-29T08:19:04.123456Z";
  const cursor = encodeSupportAuditCursor(stamp, "ORDER_GROUP", "rental_order_1");
  assert.deepEqual(decodeSupportAuditCursor(cursor), { sortAt: stamp, kind: "ORDER_GROUP", id: "rental_order_1" });
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const bad of [
    "not-base64-json",
    encoded([stamp, "CONSULTATION"]),
    encoded([stamp, "MESSAGE", "rental_order_1"]),
    encoded([stamp, "CONSULTATION", "bad id"]),
    encoded(["2026-10-29T08:19:04Z", "CONSULTATION", "im_consult_1"]),
    encodeSupportAuditCursor(stamp, "CONSULTATION", "im_consult_1") + "=",
  ]) {
    assert.throws(() => decodeSupportAuditCursor(bad), /Cursor is invalid/, bad);
  }
});

test("management read and takeover permissions stay separate", () => {
  assert.throws(() => requireSupportManagementRead(null), (error: { status?: number }) => error.status === 403);
  assert.throws(() => requireSupportManagementRead(adminAccess([])), (error: { status?: number }) => error.status === 403);
  assert.doesNotThrow(() => requireSupportManagementRead(adminAccess(["im.support.management.read"])));
  assert.throws(() => requireSupportAuditTakeover(adminAccess(["im.support.management.read"])), (error: { status?: number }) => error.status === 403);
  assert.doesNotThrow(() => requireSupportAuditTakeover(adminAccess(["im.support.management.read", "im.support.audit.takeover"])));
  assert.doesNotThrow(() => requireSupportAuditTakeover(adminAccess(["im.support.management.read", "im.support.audit.takeover"], true)));
});

test("presence session transitions classify every end reason without double-opening", () => {
  assert.equal(presenceSessionAction("AVAILABLE", "CONNECTED"), "OPEN");
  assert.equal(presenceSessionAction("AVAILABLE", "RECONNECTING"), "CLOSE");
  assert.equal(presenceSessionAction("PAUSED", "CONNECTED"), "CLOSE");
  assert.equal(presenceSessionAction("OFF_DUTY", "DISCONNECTED"), "CLOSE");
  assert.equal(presenceSessionEndReason("PAUSED", "CONNECTED"), "PAUSED");
  assert.equal(presenceSessionEndReason("PAUSED", "DISCONNECTED"), "PAUSED");
  assert.equal(presenceSessionEndReason("OFF_DUTY", "CONNECTED"), "OFF_DUTY");
  assert.equal(presenceSessionEndReason("AVAILABLE", "KICKED"), "DISCONNECTED");
  assert.equal(presenceSessionEndReason("AVAILABLE", "CONNECTED"), null);
  assert.match(PRESENCE_SESSION_OPEN_SQL, /ON CONFLICT \("app_id", "admin_user_id"\) WHERE "ended_at" IS NULL DO NOTHING/);
  assert.match(PRESENCE_SESSION_CLOSE_SQL, /"ended_at" = clock_timestamp\(\), "end_reason" = \$3/);
  assert.match(PRESENCE_SESSION_CLOSE_SQL, /"ended_at" IS NULL/);
});

test("0108 creates one open interval per admin and records both permissions", () => {
  const sql = readFileSync(resolve("migrations/business/0108_im_support_management.sql"), "utf8");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "im_support_presence_session_open_unique"[\s\S]*?WHERE "ended_at" IS NULL/);
  assert.match(sql, /"end_reason" IN \('MANUAL_OFF', 'PAUSED', 'DISCONNECTED', 'STALE', 'FORCED', 'OFF_DUTY'\)/);
  assert.match(sql, /'im\.support\.management\.read'/);
  assert.match(sql, /'im\.support\.audit\.takeover'/);
  assert.match(sql, /"note" text CHECK \("note" IS NULL OR char_length\("note"\) BETWEEN 1 AND 200\)/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  const entries = journal.entries.map(({ idx, tag }: { idx: number; tag: string }) => ({ idx, tag }));
  assert.ok(entries.some((entry: { idx: number; tag: string }) => entry.idx === 108 && entry.tag === "0108_im_support_management"));
  assert.ok(entries.some((entry: { idx: number; tag: string }) => entry.idx === 109 && entry.tag === "0109_ops_support_management_grants"));
  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /GRANT SELECT, INSERT ON TABLE "zzsh_iam"\."im_support_presence_session"/);
  assert.match(acl, /GRANT UPDATE \("ended_at", "end_reason", "last_heartbeat_at"\) ON TABLE "zzsh_iam"\."im_support_presence_session"/);
  assert.match(acl, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"\."im_support_presence_session"/);
  assert.match(acl, /GRANT SELECT, INSERT ON TABLE "zzsh_iam"\."im_support_handover"/);
  assert.match(acl, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"\."im_support_handover"/);
  assert.doesNotMatch(acl, /GRANT[^;\n]*DELETE[^;\n]*"im_support_(presence_session|handover)"/);
});

test("today seconds intersect the Beijing day and truncate STALE at the last heartbeat", async () => {
  const f = fakePool((sql, values) => {
    assert.deepEqual(values, [APP_ID, "admin_a", "2026-10-29"]);
    assert.match(sql, /Asia\/Shanghai/);
    assert.match(sql, /LEAST\(COALESCE\(s\."ended_at", clock_timestamp\(\)\), b\.day_end\)/);
    assert.match(sql, /e\."event_type" IN \('ASSIGNED', 'CLAIMED', 'TRANSFERRED'\)/);
    assert.match(sql, /e\."event_type" = 'CLOSED' AND e\."actor_type" = 'admin'/);
    return { rows: [{ seconds: "5400", sessions: 4, users: 3 }] };
  });
  assert.deepEqual(await readSupportToday(f.pool as never, APP_ID, "admin_a", "2026-10-29"), { seconds: 5400, sessions: 4, users: 3 });
});

test("stale reaper closes at the last heartbeat, disconnects only when no newer interval exists", async () => {
  const f = fakePool((sql, values) => {
    assert.deepEqual(values, [APP_ID, 180]);
    assert.match(sql, /SET "ended_at" = "last_heartbeat_at", "end_reason" = 'STALE'/);
    assert.match(sql, /clock_timestamp\(\) - \(\$2::int \* interval '1 second'\)/);
    assert.match(sql, /"connection_state" = 'DISCONNECTED'/);
    assert.match(sql, /"version" = p\."version" \+ 1/);
    assert.match(sql, /NOT EXISTS \([\s\S]*s\."ended_at" IS NULL/);
    return { rows: [{ sessions: 2, presences: 1 }] };
  });
  assert.deepEqual(await reapStaleSupportSessions(f.pool as never, APP_ID), { sessions: 2, presences: 1 });
});

test("presence read extends the existing projection with today's counts", async () => {
  const f = fakePool(adminContextHandler({
    boss: true,
    extras: (sql) => {
      if (sql.includes('FROM "zzsh_iam"."im_support_presence" WHERE "app_id"')) {
        return { rows: [{ adminUserId: "admin_a", availability: "AVAILABLE", connectionState: "CONNECTED", lastConnectedAt: "2026-10-29T01:00:00.000Z", activeLoad: 2, version: 7 }] };
      }
      if (sql.includes("im_support_presence_session") && sql.includes("LEAST")) {
        return { rows: [{ seconds: 120, sessions: 2, users: 1 }] };
      }
      return null;
    },
  }));
  const presence = await readOwnPresence({ pool: f.pool, appId: APP_ID } as never, adminContext);
  assert.deepEqual(presence, {
    adminUserId: "admin_a", availability: "AVAILABLE", connectionState: "CONNECTED",
    lastConnectedAt: "2026-10-29T01:00:00.000Z", activeLoad: 2, version: 7,
    today: { seconds: 120, sessions: 2, users: 1 },
  });
});

test("heartbeat only advances an open interval while the admin is available and connected", async () => {
  const f = fakePool(adminContextHandler({
    boss: true,
    extras: (sql) => {
      assert.match(sql, /"availability" = 'AVAILABLE' AND "connection_state" = 'CONNECTED'/);
      assert.match(sql, /AND EXISTS \(SELECT 1 FROM p\)/);
      return { rows: [{ presence: true, session: true, serverTime: "2026-10-29T08:00:00.000000Z" }] };
    },
  }));
  assert.deepEqual(await heartbeatOwnPresence({ pool: f.pool, appId: APP_ID } as never, adminContext),
    { ok: true, serverTime: "2026-10-29T08:00:00.000000Z" });
});

function overviewHandler(state: {
  onDuty: unknown[];
  totals: unknown;
  trend: unknown[];
  hourly: unknown[];
}) {
  return adminContextHandler({
    boss: true,
    extras: (sql) => {
      if (sql.includes('"currentOrderGroups"')) {
        assert.match(sql, /o\."status" = 'PAID'/);
        assert.match(sql, /COALESCE\(g\."responsible_admin_id", g\."assigned_admin_id"\)/);
        return { rows: state.onDuty };
      }
      if (sql.includes('"waitingConsultations"')) return { rows: [state.totals] };
      if (sql.includes("generate_series(0, 23)")) return { rows: state.hourly };
      if (sql.includes("AS day")) return { rows: state.trend };
      return null;
    },
  });
}

test("overview keeps zeros out of fabricated trends and exposes the documented fields", async () => {
  const f = fakePool(overviewHandler({
    onDuty: [{ adminUserId: "admin_a", name: "客服甲", availability: "AVAILABLE", connectionState: "CONNECTED", activeLoad: 2, todaySeconds: "3600", todaySessions: 3, todayUsers: 2, currentOrderGroups: 1 }],
    totals: { onDutyCount: 1, waitingConsultations: 2, todaySessions: 3, todayUsers: 2 },
    trend: Array.from({ length: 7 }, (_, index) => ({ date: `2026-10-2${index + 3}`, sessions: 0, users: 0 })),
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, sessions: 0 })),
  }));
  const overview = await readSupportOverview({ pool: f.pool, appId: APP_ID } as never, adminContext, "2026-10-29");
  assert.deepEqual(overview, {
    onDuty: [{ adminUserId: "admin_a", name: "客服甲", availability: "AVAILABLE", connectionState: "CONNECTED", activeLoad: 2, todaySeconds: 3600, todaySessions: 3, todayUsers: 2, currentOrderGroups: 1 }],
    totals: { onDutyCount: 1, waitingConsultations: 2, todaySessions: 3, todayUsers: 2 },
    trend: [],
    hourly: [],
  });
});

test("overview returns real zero days only when at least one fact exists", async () => {
  const f = fakePool(overviewHandler({
    onDuty: [],
    totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 1, todayUsers: 1 },
    trend: [{ date: "2026-10-28", sessions: 1, users: 1 }, { date: "2026-10-29", sessions: 0, users: 0 }],
    hourly: [{ hour: 9, sessions: 1 }, { hour: 10, sessions: 0 }],
  }));
  const overview = await readSupportOverview({ pool: f.pool, appId: APP_ID } as never, adminContext, null);
  assert.equal(overview.trend.length, 2);
  assert.deepEqual(overview.hourly, [{ hour: 9, sessions: 1 }, { hour: 10, sessions: 0 }]);
});

test("overview requires management read before any metric query", async () => {
  const f = fakePool(adminContextHandler({ boss: false, permissions: [] }));
  await assert.rejects(
    readSupportOverview({ pool: f.pool, appId: APP_ID } as never, adminContext, null),
    (error: { status?: number }) => error.status === 403,
  );
  assert.ok(!f.calls.some(({ sql }) => sql.includes('"currentOrderGroups"')));
});

test("handover listing shows all rows to management and only self rows otherwise", async () => {
  const rows = [{
    id: "im_handover_1", objectType: "CONSULTATION", objectId: "im_consult_1",
    fromAdminId: "admin_a", fromName: "客服甲", toAdminId: "admin_b", toName: "客服乙",
    note: "已电话沟通", createdAt: "2026-10-29T08:00:00.000000Z",
    consultationType: "SERVICE", userId: "user_a", userName: "用户甲", userUsername: "user_a", displayNo: null,
  }, {
    id: "im_handover_2", objectType: "ORDER_GROUP", objectId: "rental_order_1",
    fromAdminId: "admin_a", fromName: "客服甲", toAdminId: "admin_b", toName: "客服乙",
    note: null, createdAt: "2026-10-29T07:00:00.000000Z",
    consultationType: null, userId: null, userName: null, userUsername: null, displayNo: "R20261029001",
  }];
  for (const [boss, expectedAll] of [[true, true], [false, false]] as const) {
    const f = fakePool(adminContextHandler({
      boss,
      permissions: [],
      extras: (sql, values) => {
        assert.match(sql, /im_support_handover/);
        assert.equal(values[1], expectedAll);
        return { rows };
      },
    }));
    const result = await listSupportHandovers({ pool: f.pool, appId: APP_ID } as never, adminContext, "20");
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0], {
      id: "im_handover_1", objectType: "CONSULTATION", objectId: "im_consult_1",
      from: { id: "admin_a", name: "客服甲" }, to: { id: "admin_b", name: "客服乙" },
      note: "已电话沟通", createdAt: "2026-10-29T08:00:00.000000Z",
      object: { kind: "CONSULTATION", id: "im_consult_1", type: "SERVICE", user: { id: "user_a", name: "用户甲" } },
    });
    assert.deepEqual(result.items[1]!.object, { kind: "ORDER_GROUP", id: "rental_order_1", displayNo: "R20261029001" });
  }
});

test("handover rows are append-only and note lookup is scoped to the exact pair", async () => {
  const f = fakePool((sql, values) => {
    assert.match(sql, /INSERT INTO "zzsh_iam"\."im_support_handover"/);
    assert.deepEqual(values.slice(1), [APP_ID, "CONSULTATION", "im_consult_1", "admin_a", "admin_b", "备注"]);
    return { rows: [] };
  });
  await recordSupportHandover(f.pool as never, { appId: APP_ID, objectType: "CONSULTATION", objectId: "im_consult_1", fromAdminId: "admin_a", toAdminId: "admin_b", note: "备注" });
  await assert.rejects(
    recordSupportHandover(f.pool as never, { appId: APP_ID, objectType: "CONSULTATION", objectId: "im_consult_1", fromAdminId: "admin_a", toAdminId: "admin_a", note: null }),
    /Handover staff must differ/,
  );
  const reader = fakePool((sql) => {
    assert.match(sql, /"from_admin_id" = \$4 AND "to_admin_id" = \$5/);
    return { rows: [{ note: "备注" }] };
  });
  assert.equal(await readLatestHandoverNote(reader.pool as never, APP_ID, "CONSULTATION", "im_consult_1", "admin_a", "admin_b"), "备注");
});

test("audit list includes closed consultations and order groups without a JOINED membership", async () => {
  const account = (() => {
    const key = { provider: "yunxin" as const, appId: APP_ID, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: "admin_a" };
    return { accountId: deriveYunxinAccountId(key), identityMarker: buildYunxinIdentityMarker(key) };
  })();
  const consultation = {
    kind: "CONSULTATION", id: "im_consult_1", type: "SERVICE", state: "CLOSED",
    user: { id: "user_a", name: "用户甲" }, assignedAdmin: { id: "admin_b", name: "客服乙" },
    lastMessageAt: "2026-10-29T07:00:00.000000Z", updatedAt: "2026-10-29T07:01:00.000000Z", conversationId: null,
  };
  const group = {
    kind: "ORDER_GROUP", id: "rental_order_1", displayNo: "R20261029001", title: "三角洲账号", status: "PAID",
    teamState: "READY", gameName: "三角洲行动", firstResponseAt: null, remindDueAt: null, addRound: 0,
    escalationState: "NOT_STARTED", conversationId: `${account.accountId}|2|900001`,
  };
  const f = fakePool(adminContextHandler({
    boss: true,
    extras: (sql, values) => {
      if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) return { rows: [account] };
      if (sql.includes("WITH items AS")) {
        assert.match(sql, /FROM "zzsh_iam"\."im_consultation" c/);
        assert.doesNotMatch(sql, /state\s*<>\s*'CLOSED'/);
        assert.doesNotMatch(sql, /im_order_member/);
        assert.doesNotMatch(sql, /consultation_message|"body"/i);
        assert.equal(values[1], account.accountId);
        return {
          rows: [
            { sortAt: "2026-10-29T07:01:00.000000Z", kind: "CONSULTATION", id: "im_consult_1", payload: consultation },
            { sortAt: "2026-10-29T07:00:00.000000Z", kind: "ORDER_GROUP", id: "rental_order_1", payload: group },
          ],
        };
      }
      return null;
    },
  }));
  const page = await listAuditConversations({ pool: f.pool, appId: APP_ID } as never, adminContext, "1", null);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0], consultation);
  assert.ok(page.nextCursor);
  assert.deepEqual(decodeSupportAuditCursor(page.nextCursor!), { sortAt: "2026-10-29T07:01:00.000000Z", kind: "CONSULTATION", id: "im_consult_1" });
  const second = await listAuditConversations({ pool: f.pool, appId: APP_ID } as never, adminContext, "5", page.nextCursor);
  assert.equal(second.nextCursor, null);
});

test("audit list and patrol message reads fail closed without management read", async () => {
  const list = fakePool(adminContextHandler({ boss: false, permissions: [] }));
  await assert.rejects(
    listAuditConversations({ pool: list.pool, appId: APP_ID } as never, adminContext, null, null),
    (error: { status?: number }) => error.status === 403,
  );
  assert.ok(!list.calls.some(({ sql }) => sql.includes("WITH items AS")));

  const key = { provider: "yunxin" as const, appId: APP_ID, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: "admin_a" };
  const read = fakePool(adminContextHandler({
    boss: false,
    permissions: ["im.support.read"],
    extras: (sql) => {
      if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) {
        return { rows: [{ accountId: deriveYunxinAccountId(key), identityMarker: buildYunxinIdentityMarker(key), status: "READY" }] };
      }
      if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) {
        return { rows: [{
          id: "im_consult_1", userId: "user_a", kind: "SERVICE", state: "ACTIVE", userAccountId: "user_im_a",
          peerAccountId: "staff_im_b", assignedAdminId: "admin_b", subjectRef: null, version: 2,
          lastMessageAt: null, createdAt: new Date(0), updatedAt: new Date(0), userName: "用户甲", userUsername: null,
          adminName: "客服乙", appId: APP_ID, messageScopeType: "TEAM", messageScopeId: "900001",
          messageScopeState: "READY", messageScopeVersion: 1,
          threadId: "im_thread_1", roundSeq: 1, threadState: "ACTIVE", threadScopeId: "900001",
          threadScopeState: "READY", threadPeerAccountId: "staff_im_b",
        }] };
      }
      return null;
    },
  }));
  await assert.rejects(
    readAdminMessageAccess({ pool: read.pool, appId: APP_ID } as never, adminContext, `${deriveYunxinAccountId(key)}|2|900001`),
    (error: { status?: number }) => error.status === 403,
  );
  assert.ok(!read.calls.some(({ sql }) => sql.includes('INSERT INTO "zzsh_iam"."audit_event"')));
});

test("patrol read allows another admin's consultation and writes a silent audit", async () => {
  const key = { provider: "yunxin" as const, appId: APP_ID, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: "admin_a" };
  const f = fakePool(adminContextHandler({
    boss: true,
    extras: (sql, values) => {
      if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) {
        return { rows: [{ accountId: deriveYunxinAccountId(key), identityMarker: buildYunxinIdentityMarker(key), status: "READY" }] };
      }
      if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) {
        assert.match(sql, /t\."message_scope_state" = 'READY'/);
        return { rows: [{
          id: "im_consult_1", userId: "user_a", kind: "SERVICE", state: "CLOSED", userAccountId: "user_im_a",
          peerAccountId: "staff_im_b", assignedAdminId: "admin_b", subjectRef: null, version: 2,
          lastMessageAt: null, createdAt: new Date(0), updatedAt: new Date(0), userName: "用户甲", userUsername: null,
          adminName: "客服乙", appId: APP_ID, messageScopeType: "TEAM", messageScopeId: "900001",
          messageScopeState: "READY", messageScopeVersion: 1,
          threadId: "im_thread_1", roundSeq: 1, threadState: "IDLE", threadScopeId: "900001",
          threadScopeState: "READY", threadPeerAccountId: null,
        }] };
      }
      if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) {
        assert.equal(values[4], "im.audit.conversation_viewed");
        assert.equal(values[5], "im_consultation");
        assert.equal(values[6], "im_consult_1");
        return { rows: [] };
      }
      return null;
    },
  }));
  const access = await readAdminMessageAccess({ pool: f.pool, appId: APP_ID } as never, adminContext, `${deriveYunxinAccountId(key)}|2|900001`, false, "req_patrol");
  assert.deepEqual(access, { viewerAccountId: deriveYunxinAccountId(key), peerAccountId: "user_im_a" });
  const audit = f.calls.find(({ sql }) => sql.includes('INSERT INTO "zzsh_iam"."audit_event"'));
  assert.ok(audit, "patrol read must record a silent view audit");
  assert.ok(audit!.values.includes("im.audit.conversation_viewed"));
  assert.ok(audit!.values.includes("im_consult_1"));
});

test("patrol order-team read accepts a non-member but requires the manager's own conversation id", async () => {
  const key = { provider: "yunxin" as const, appId: APP_ID, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: "admin_a" };
  const account = (() => ({ accountId: deriveYunxinAccountId(key), identityMarker: buildYunxinIdentityMarker(key) }))();
  const f = fakePool(adminContextHandler({
    boss: true,
    extras: (sql) => {
      if (sql.includes('FROM "zzsh_order"."im_order_group" g')) {
        return { rows: [{ orderId: "rental_order_1", teamState: "READY" }] };
      }
      if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) return { rows: [account] };
      if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) return { rows: [] };
      return null;
    },
  }));
  const accepted = await readPatrolOrderTeamAccess(f.pool as never, {
    appId: APP_ID, teamId: "900001", conversationId: `${account.accountId}|2|900001`, requestId: "req_team",
  }, { userId: "admin_a", sessionId: "session_a" });
  assert.deepEqual(accepted, {
    viewerAccountId: account.accountId, peerAccountId: "900001",
    scope: { appId: APP_ID, orderId: "rental_order_1", teamId: "900001" },
  });
  assert.ok(f.calls.some(({ sql }) => sql.includes('INSERT INTO "zzsh_iam"."audit_event"')));
  const wrong = await readPatrolOrderTeamAccess(f.pool as never, {
    appId: APP_ID, teamId: "900001", conversationId: "someone_else|2|900001", requestId: "req_team",
  }, { userId: "admin_a", sessionId: "session_a" });
  assert.equal(wrong, null);
});

test("takeover is idempotent for the current owner and rejects non-active consultations", () => {
  assert.equal(takeoverDecision({ state: "ACTIVE", assignedAdminId: "admin_b" }, "admin_a"), "TRANSFER");
  assert.equal(takeoverDecision({ state: "ACTIVE", assignedAdminId: "admin_a" }, "admin_a"), "NOOP");
  assert.throws(() => takeoverDecision({ state: "CLOSED", assignedAdminId: "admin_b" }, "admin_a"), (error: { status?: number }) => error.status === 409);
  assert.throws(() => takeoverDecision({ state: "WAITING", assignedAdminId: null }, "admin_a"), (error: { status?: number }) => error.status === 409);
  // Takeover reuses the transfer scope-version fence instead of a second write path.
  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  const transfer = source.slice(source.indexOf("async function beginTransfer"), source.indexOf("async function transferWithScope"));
  assert.match(transfer, /state" IN \('PENDING', 'RUNNING', 'UNKNOWN'\)/);
  assert.match(transfer, /WHERE "app_id" = \$1 AND "id" = \$2 AND "message_scope_state" = 'READY'/);
  assert.match(source.slice(source.indexOf("export async function takeoverConsultation"), source.indexOf("export async function closeConsultation")), /beginTransfer\([^)]*"TAKEOVER"\)/);
});

test("takeover on an already-owned consultation performs no second write", async () => {
  const key = { provider: "yunxin" as const, appId: APP_ID, realm: "admin" as const, kind: "ADMIN" as const, platformSubjectId: "admin_a" };
  const row = {
    id: "im_consult_1", userId: "user_a", kind: "SERVICE", state: "ACTIVE", userAccountId: "user_im_a",
    peerAccountId: deriveYunxinAccountId(key), assignedAdminId: "admin_a", subjectRef: null, version: 4,
    lastMessageAt: null, createdAt: new Date(0), updatedAt: new Date(0), userName: "用户甲", userUsername: null,
    adminName: "客服甲", appId: APP_ID, messageScopeType: "TEAM", messageScopeId: "900001",
    messageScopeState: "READY", messageScopeVersion: 2,
  };
  const f = fakePool(adminContextHandler({
    boss: true,
    extras: (sql) => {
      if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) {
        return { rows: [{ accountId: deriveYunxinAccountId(key), identityMarker: buildYunxinIdentityMarker(key), status: "READY" }] };
      }
      if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) return { rows: [row] };
      return { rows: [] };
    },
  }));
  const result = await takeoverConsultation({
    pool: f.pool,
    appId: APP_ID,
    provider: {} as never,
    supportManager: { key: supportManagerIdentityKey(APP_ID), provisioner: {} as never },
  } as never, adminContext, "im_consult_1", "req_takeover", null);
  assert.equal(result.consultation.id, "im_consult_1");
  assert.equal(result.consultation.assignedAdmin?.id, "admin_a");
  assert.ok(!f.calls.some(({ sql }) => /INSERT INTO "zzsh_iam"\."im_support_handover"|operation_type/.test(sql)));
  assert.ok(!f.calls.some(({ sql }) => /^UPDATE "zzsh_iam"\."im_consultation"/.test(sql.trim())));
});

test("admin BFF forwards the new support-management routes with strict methods", async () => {
  const origin = "http://127.0.0.1:4291";
  const security = {
    pool: {} as never,
    apiOrigin: "http://127.0.0.1:4292",
    adminOrigin: origin,
    adminAuth: { api: { getSession: async () => null } },
  };
  const options = {
    adminOrigin: origin,
    apiOrigin: security.apiOrigin,
    adminSecurityOptions: security,
    adminAuthHandler: (() => undefined) as never,
    supply: {} as never,
    order: {} as never,
    yunxin: { security, appId: APP_ID, repository: {} as never, provisioner: {} as never, tokenService: {} as never },
  } as unknown as AdminBffOptions;
  const run = async (path: string, method = "GET") => {
    let status = 200;
    let body: unknown;
    const response = { setHeader() { return response; }, status(code: number) { status = code; return response; }, json(value: unknown) { body = value; }, send(value: unknown) { body = value; } };
    await handleAdminBff({ method, url: path, originalUrl: path, headers: { origin } }, response as never, options);
    return { status, body };
  };
  // No authenticated session: reaching 401 proves forwarding past the 404 gate.
  assert.equal((await run("/im/support-overview?date=2026-10-29")).status, 401);
  assert.equal((await run("/im/handovers?limit=20")).status, 401);
  assert.equal((await run("/im/audit/conversations?limit=20")).status, 401);
  assert.equal((await run("/im/presence/heartbeat", "POST")).status, 503);
  assert.equal((await run("/im/audit/consultations/im_consult_1/takeover", "POST")).status, 503);
  assert.equal((await run("/im/support-overview", "POST")).status, 404);
  assert.equal((await run("/im/handovers", "POST")).status, 404);
  assert.equal((await run("/im/audit/conversations", "POST")).status, 404);
  assert.equal((await run("/im/presence/heartbeat", "GET")).status, 404);
  assert.equal((await run("/im/audit/consultations/im_consult_1/takeover", "GET")).status, 404);
  assert.equal((await run("/im/audit/consultations/im_consult_1/other", "POST")).status, 404);
});
