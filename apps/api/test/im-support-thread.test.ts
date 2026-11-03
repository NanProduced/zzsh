import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import { claimConsultation, readAdminMessageAccess, readUserMessageAccess, supportManagerIdentityKey, toView } from "../src/im/consultation";
import { FakeSupportScopeProvider } from "./im-test-fixtures";

const APP_ID = "provider-test";

type QueryResult = { rows: unknown[]; rowCount?: number };
type Call = { sql: string; values: unknown[] };

function fakePool(handler: (sql: string, values: unknown[]) => QueryResult | null) {
  const calls: Call[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    const result = handler(sql, values);
    if (result) return { rowCount: result.rowCount ?? result.rows.length, ...result };
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  return { calls, pool: { query, connect: async () => ({ query, release() {} }) } };
}

const TRANSACTION_SQL = new Set(["BEGIN", "COMMIT", "ROLLBACK"]);

function adminAuth(permissions: string[] = []) {
  return (sql: string) => {
    if (TRANSACTION_SQL.has(sql)) return { rows: [] };
    if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: [{ locked: false, twoFactorEnabled: true, suspended: false }] };
    if (sql.includes('FROM "zzsh_iam"."admin_security"')) return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false }] };
    if (sql.includes("WITH role_permissions AS")) return { rows: permissions.map((permissionCode) => ({ permissionCode })) };
    return null;
  };
}

function userAuth() {
  return (sql: string, values: unknown[] = []) => {
    if (TRANSACTION_SQL.has(sql)) return { rows: [] };
    if (sql.includes('FROM "zzsh_auth_user"."session"')) return { rows: [{ locked: false, suspended: false }] };
    if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: false, accountStatus: "ACTIVE" }] };
    if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [] };
    if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) return identityRows("USER", String(values[3] ?? "user_a"));
    return null;
  };
}

function identityFor(kind: "USER" | "ADMIN", subject: string) {
  const key = { provider: "yunxin" as const, appId: APP_ID, realm: kind === "ADMIN" ? "admin" as const : "user" as const, kind, platformSubjectId: subject };
  return { key, accountId: deriveYunxinAccountId(key), marker: buildYunxinIdentityMarker(key) };
}

function identityRows(kind: "USER" | "ADMIN", subject: string) {
  const identity = identityFor(kind, subject);
  return { rows: [{ accountId: identity.accountId, identityMarker: identity.marker, status: "READY" }] };
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread_1",
    appId: APP_ID,
    userId: "user_a",
    kind: "SERVICE",
    state: "ACTIVE",
    userAccountId: identityFor("USER", "user_a").accountId,
    peerAccountId: identityFor("ADMIN", "admin_a").accountId,
    messageScopeId: "900001",
    messageScopeState: "READY",
    lastRoundSeq: "2",
    version: "3",
    ...overrides,
  };
}

function userConversationId(teamId = "900001"): string {
  return `${identityFor("USER", "user_a").accountId}|2|${teamId}`;
}

const userContext = { userId: "user_a", sessionId: "session_a", credentials: {}, security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false }, sessionLocked: false } as never;

function contextRow(overrides: Record<string, unknown> = {}): Parameters<typeof toView>[0] {
  return {
    id: "consult_2", userId: "user_a", kind: "SERVICE", state: "CLOSED", userAccountId: identityFor("USER", "user_a").accountId,
    peerAccountId: identityFor("ADMIN", "admin_a").accountId, assignedAdminId: "admin_a", subjectRef: null, version: 4,
    lastMessageAt: null, createdAt: new Date("2026-10-20T00:00:00.000Z"), updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    userName: "用户甲", userUsername: "user_a", adminName: "客服甲", appId: APP_ID, messageScopeType: "TEAM",
    messageScopeId: "900001", messageScopeState: "READY", messageScopeVersion: 2, threadId: "thread_1", roundSeq: 2,
    threadState: "IDLE", threadScopeId: "900001", threadScopeState: "READY", threadPeerAccountId: null,
    ...overrides,
  } as Parameters<typeof toView>[0];
}

test("thread views keep history and sending after the round is closed, and never invent a dismissed Team", () => {
  const row = contextRow({});
  const userView = toView(row, identityFor("USER", "user_a").accountId);
  assert.equal(userView.threadId, "thread_1");
  assert.equal(userView.roundId, "consult_2");
  assert.equal(userView.roundSeq, 2);
  assert.equal(userView.threadState, "IDLE");
  assert.equal(userView.state, "CLOSED");
  assert.equal(userView.conversationId, userConversationId());
  assert.equal(userView.canSend, true, "user keeps read/send on a closed round while the Team exists");

  const adminAccount = identityFor("ADMIN", "admin_a").accountId;
  const adminView = toView(row, adminAccount, true, "admin_a");
  assert.equal(adminView.conversationId, `${adminAccount}|2|900001`, "the responsible admin can reopen the same thread history after close");
  assert.equal(adminView.canSend, false, "history read does not grant sending on a closed round");
  const otherAdmin = identityFor("ADMIN", "admin_b").accountId;
  assert.equal(toView(row, otherAdmin, true, "admin_b").conversationId, null, "an unrelated admin still cannot claim the team");
  assert.equal(toView(row, otherAdmin, true, "admin_b", true).conversationId, `${otherAdmin}|2|900001`, "management patrol can read the thread history");

  // Team dismissed / never created: no conversation may be claimed as recoverable.
  const dismissed = toView(contextRow({ threadScopeId: null, threadScopeState: "PENDING", messageScopeId: null, messageScopeState: "REVOKED" }), identityFor("USER", "user_a").accountId);
  assert.equal(dismissed.conversationId, null);
  assert.equal(dismissed.canSend, false);
  assert.equal(dismissed.threadState, "IDLE");
});

test("consultation projections keep managed user/admin avatars and discard external legacy images", () => {
  const user = "/api/v1/profile/avatars/user/user_a/1", admin = "/api/v1/profile/avatars/admin/admin_a/2";
  const row = contextRow({ userImage: user, adminImage: admin });
  const staff = toView(row, identityFor("ADMIN", "admin_a").accountId, true, "admin_a");
  assert.equal(staff.user?.avatar, user); assert.equal(staff.assignedAdmin?.avatar, admin);
  assert.equal(toView(row, identityFor("USER", "user_a").accountId).assignedAdmin?.avatar, admin);
  for (const image of ["https://legacy.invalid/avatar.jpg", "data:image/png,private", "//external.invalid/a", "/api/v1/profile/avatars/user/user_a/1?redirect=x"]) {
    const value = toView(contextRow({ userImage: image, adminImage: image }), identityFor("ADMIN", "admin_a").accountId, true, "admin_a");
    assert.equal(value.user?.avatar, undefined); assert.equal(value.assignedAdmin?.avatar, undefined);
  }
});

test("user read stays authorized across rounds while a missing thread Team fails closed", async () => {
  const f = fakePool((sql, values) => {
    const auth = userAuth()(sql);
    if (auth) return auth;
    if (sql.includes('"im_support_thread"')) {
      assert.equal(values[1], "user_a");
      assert.equal(values[2], "900001");
      return { rows: [threadRow({ state: "IDLE", peerAccountId: null })] };
    }
    return null;
  });
  const access = await readUserMessageAccess({ pool: f.pool, appId: APP_ID, supportManager: { key: supportManagerIdentityKey(APP_ID), provisioner: { ensure: async () => { throw new Error("unused"); } } } } as never, userContext, userConversationId(), false);
  assert.equal(access.viewerAccountId, identityFor("USER", "user_a").accountId);
  assert.equal(access.peerAccountId, deriveYunxinAccountId(supportManagerIdentityKey(APP_ID)));
  assert.ok(!f.calls.some(({ sql }) => sql.includes('INSERT INTO "zzsh_iam"."im_consultation"')), "read must not open a round");

  const empty = fakePool((sql) => userAuth()(sql));
  await assert.rejects(
    readUserMessageAccess({ pool: empty.pool, appId: APP_ID } as never, userContext, userConversationId(), true),
    (error: { status?: number }) => error.status === 403,
  );
});

test("a user message reopens the same thread and Team without creating another scope operation", async () => {
  const inserted: unknown[][] = [];
  const f = fakePool((sql, values) => {
    const auth = userAuth()(sql);
    if (auth) return auth;
    if (sql.includes('"im_support_thread"') && sql.includes("FOR UPDATE")) {
      return { rows: [threadRow({ state: "IDLE", peerAccountId: null })] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation"') && sql.includes('"state" <> \'CLOSED\'')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation"')) {
      inserted.push(values);
      return { rows: [] };
    }
    return null;
  });
  const access = await readUserMessageAccess({ pool: f.pool, appId: APP_ID, supportManager: { key: supportManagerIdentityKey(APP_ID), provisioner: { ensure: async () => { throw new Error("unused"); } } } } as never, userContext, userConversationId(), true);
  assert.equal(access.peerAccountId, deriveYunxinAccountId(supportManagerIdentityKey(APP_ID)));
  assert.equal(inserted.length, 1);
  const values = inserted[0]!;
  assert.equal(values[3], "SERVICE");
  assert.equal(values[6], "thread_1", "the next round is linked to the persistent thread");
  assert.equal(values[7], 3, "round sequence advances on the same thread");
  assert.equal(values[8], "900001", "the existing Team id is reused");
  assert.equal(values[9], "READY");
  assert.ok(!f.calls.some(({ sql }) => sql.includes('im_consultation_scope_operation')), "reopening must not create a second Team operation");
  assert.ok(!f.calls.some(({ sql }) => sql.includes("dismiss")));
});

test("the responsible agent may send, another admin may only read the same thread", async () => {
  for (const [adminId, adminName, send, expected] of [
    ["admin_a", "客服甲", true, 200],
    ["admin_b", "客服乙", true, 403],
    ["admin_b", "客服乙", false, 200],
  ] as const) {
    const identity = identityFor("ADMIN", adminId);
    const permissions = adminId === "admin_b" ? ["im.support.management.read"] : ["im.support.read", "im.support.accept"];
    const f = fakePool((sql, values) => {
      const auth = adminAuth(permissions)(sql);
      if (auth) return auth;
      if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) {
        assert.equal(values[3], adminId);
        return identityRows("ADMIN", adminId);
      }
      if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) {
        assert.match(sql, /t\."message_scope_state" = 'READY'/);
        return { rows: [contextRow({ state: "ACTIVE", threadState: "ACTIVE", assignedAdminId: "admin_a", adminName: "客服甲", peerAccountId: identityFor("ADMIN", "admin_a").accountId, threadPeerAccountId: identityFor("ADMIN", "admin_a").accountId })] };
      }
      if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) return { rows: [] };
      return null;
    });
    const context = { userId: adminId, sessionId: `session_${adminId}`, credentials: {}, security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false }, sessionLocked: false } as never;
    const call = readAdminMessageAccess({ pool: f.pool, appId: APP_ID } as never, context, `${identity.accountId}|2|900001`, send, "req_access");
    if (expected === 200) {
      const access = await call;
      assert.equal(access.peerAccountId, identityFor("USER", "user_a").accountId, adminId);
    } else {
      await assert.rejects(call, (error: { status?: number }) => error.status === 403, adminName);
    }
  }
});

test("0130 adds the persistent thread, round link and round-close operation without claiming dismissed Teams", () => {
  const sql = readFileSync(resolve("migrations/business/0130_im_support_thread.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "zzsh_iam"\."im_support_thread"/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "im_support_thread_user_kind_unique"[\s\S]*?\("app_id", "user_id", "kind"\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "im_consultation_thread_open_unique"[\s\S]*?WHERE "state" <> 'CLOSED'/);
  assert.match(sql, /DROP INDEX IF EXISTS "zzsh_iam"\."im_consultation_message_scope_unique_idx"/);
  assert.match(sql, /ADD COLUMN "thread_id" text/);
  assert.match(sql, /ADD COLUMN "round_seq" integer/);
  assert.match(sql, /CASE WHEN x\."state" = 'CLOSED' THEN NULL ELSE x\."message_scope_id" END/);
  assert.match(sql, /"operation_type" = 'ADD_MEMBER'/);
  assert.match(sql, /"operation_type" = 'ROUND_CLOSE'/);
  assert.match(sql, /"operation_type" = 'CREATE'[\s\S]*?"target_admin_id" IS NULL AND "target_admin_account_id" IS NULL/);

  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 130 && entry.tag === "0130_im_support_thread"));

  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /GRANT SELECT, INSERT ON TABLE "zzsh_iam"\."im_support_thread"/);
  assert.match(acl, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"\."im_support_thread"/);
  assert.match(acl, /GRANT UPDATE \("state", "peer_account_id", "message_scope_id", "message_scope_state", "last_round_seq", "version", "updated_at", "user_read_at"\) ON TABLE "zzsh_iam"\."im_support_thread"/);
});

test("round close ends the round only and never dismisses the thread Team", () => {
  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  const begin = source.indexOf("async function beginClose");
  const local = source.indexOf("async function completeLocalClose");
  assert.ok(begin > 0 && local > begin);
  const closeSection = source.slice(begin, local);
  assert.match(closeSection, /'ROUND_CLOSE'/);
  assert.doesNotMatch(closeSection, /dismissSupportTeam/);
  const roundClose = source.slice(source.indexOf("async function completeRoundCloseRecovery"), source.indexOf("async function reconcileRoundClose"));
  assert.ok(roundClose.length > 0);
  assert.match(roundClose, /teamRetained/);
  assert.doesNotMatch(roundClose, /dismissSupportTeam/);
});

test("claim adds the agent to the existing thread Team and activates the round only after membership", async () => {
  const managerKey = supportManagerIdentityKey(APP_ID);
  const managerAccountId = deriveYunxinAccountId(managerKey);
  const userAccountId = identityFor("USER", "user_a").accountId;
  const agentAccountId = identityFor("ADMIN", "admin_a").accountId;
  const provider = new FakeSupportScopeProvider();
  provider.teams.set("900001", { appId: APP_ID, consultationId: "thread_1", ownerAccountId: managerAccountId, memberAccountIds: [userAccountId] } as never);
  provider.members.set("900001", new Set([managerAccountId, userAccountId]));

  const state = {
    round: "WAITING" as "WAITING" | "ACTIVE",
    assignedAdminId: null as string | null,
    peerAccountId: null as string | null,
    threadState: "WAITING" as "WAITING" | "ACTIVE",
    threadPeer: null as string | null,
    opState: "PENDING" as string,
    opLeaseHash: null as string | null,
    opTeamId: null as string | null,
    attemptCount: 0,
  };
  let operation: { id: string; owner: string; userAccountId: string; targetAdminId: string; targetAccountId: string } | null = null;
  const audits: unknown[] = [];
  const scopeRow = () => ({
    id: operation!.id,
    appId: APP_ID,
    consultationId: "consult_2",
    operationType: "ADD_MEMBER",
    state: state.opState,
    scopeVersion: "2",
    ownerAccountId: operation!.owner,
    userAccountId: operation!.userAccountId,
    previousAdminId: null,
    targetAdminId: operation!.targetAdminId,
    previousAdminAccountId: null,
    targetAdminAccountId: operation!.targetAccountId,
    providerTeamId: state.opTeamId,
    attemptCount: state.attemptCount,
    leaseTokenHash: state.opLeaseHash,
    leaseUntil: state.opLeaseHash ? new Date(Date.now() + 60_000).toISOString() : null,
    nextRetryAt: new Date(0).toISOString(),
    lastFailureClass: null,
    lastFailureDetail: null,
  });
  const row = () => ({
    id: "consult_2", userId: "user_a", kind: "SERVICE", state: state.round,
    userAccountId, peerAccountId: state.peerAccountId, assignedAdminId: state.assignedAdminId, subjectRef: null,
    version: 3, lastMessageAt: null, createdAt: new Date("2026-10-20T00:00:00.000Z"), updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    userName: "用户甲", userUsername: "user_a", adminName: state.assignedAdminId ? "客服甲" : null, appId: APP_ID,
    messageScopeType: "TEAM", messageScopeId: "900001", messageScopeState: "READY", messageScopeVersion: 2,
    threadId: "thread_1", roundSeq: 2, threadState: state.threadState, threadScopeId: "900001",
    threadScopeState: "READY", threadPeerAccountId: state.threadPeer,
  });
  const thread = () => threadRow({ state: state.threadState, peerAccountId: state.threadPeer });
  const f = fakePool((sql, values) => {
    if (TRANSACTION_SQL.has(sql)) return { rows: [] };
    if (sql === "SET LOCAL lock_timeout = '750ms'" || sql.startsWith("SELECT pg_advisory")) return { rows: [] };
    if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: [{ locked: false, twoFactorEnabled: true, suspended: false }] };
    if (sql.includes('FROM "zzsh_iam"."admin_security"')) {
      if (sql.includes('"is_boss"')) return { rows: [{ status: "ACTIVE", isBoss: true, passwordChangeRequired: false }] };
      return { rows: [{ admin_user_id: "admin_a", game_scope_mode: "ALL_GAMES" }] };
    }
    if (sql.includes("UNION SELECT unnest")) return { rows: [{ id: "admin_a" }] };
    if (sql.includes('FROM "zzsh_auth_admin"."user"') && sql.includes("FOR SHARE NOWAIT")) return { rows: [{ id: "admin_a" }] };
    if (sql.includes("SELECT r.id FROM zzsh_iam.admin_role r")) return { rows: [] };
    if (sql.includes('FROM "zzsh_iam"."im_support_presence"') && sql.includes("FOR UPDATE NOWAIT")) return { rows: [{ admin_user_id: "admin_a" }] };
    if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"') && sql.includes("FOR SHARE NOWAIT")) return { rows: [{ id: "im_admin", platform_subject_id: "admin_a" }] };
    if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) return identityRows("ADMIN", "admin_a");
    if (sql.includes("FROM zzsh_supply.admin_supply_scope")) return { rows: [] };
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) return { rows: [row()] };
    if (sql.includes('FROM "zzsh_iam"."im_support_thread"') && sql.includes('"app_id" = $1 AND "id" = $2')) return { rows: [thread()] };
    if (sql.includes('SELECT "thread_id" AS "threadId"')) return { rows: [{ threadId: "thread_1" }] };
    if (sql.includes('FROM "zzsh_iam"."im_consultation_scope_operation"') && sql.includes("LIMIT 1 FOR UPDATE")) return { rows: [] };
    if (sql.includes('FROM "zzsh_iam"."im_consultation_scope_operation"') && sql.includes("FOR UPDATE")) return { rows: operation ? [scopeRow()] : [] };
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation_scope_operation"')) {
      operation = { id: String(values[0]), owner: String(values[4]), userAccountId: String(values[5]), targetAdminId: String(values[6]), targetAccountId: String(values[7]) };
      state.opTeamId = String(values[8]);
      state.opState = "PENDING";
      return { rows: [] };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation_scope_operation"') && sql.includes("RETURNING") && sql.includes("'RUNNING'")) {
      state.opState = "RUNNING";
      state.opLeaseHash = String(values[3]);
      state.attemptCount += 1;
      return { rows: [scopeRow()] };
    }
    if (sql.includes("UPDATE zzsh_iam.im_consultation_scope_operation") && sql.includes("RETURNING id")) return { rows: [{ id: operation?.id ?? "op" }] };
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation_scope_operation"') && sql.includes("'SUCCEEDED'")) {
      state.opState = "SUCCEEDED"; state.opTeamId = String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation_scope_operation"') && sql.includes('SET "state" = $3')) return { rows: [], rowCount: 1 };
    if (sql.includes("provision_state='WAITING'") || sql.includes("SET wait_reason='NO_ELIGIBLE_STAFF'")) return { rows: [] };
    if (sql.includes("FROM zzsh_iam.im_support_presence p JOIN")) {
      return { rows: [{ adminUserId: "admin_a", adminName: "客服甲", accountId: agentAccountId, identityMarker: buildYunxinIdentityMarker(identityFor("ADMIN", "admin_a").key) }] };
    }
    if ((sql.includes("SELECT admin_user_id FROM zzsh_iam.im_support_presence") || sql.includes('SELECT p."admin_user_id" FROM zzsh_iam.im_support_presence p')) && sql.includes("last_consultation_assigned_at")) return { rows: [{ admin_user_id: "admin_a" }] };
    if (sql.includes("UPDATE zzsh_iam.im_support_presence SET")) return { rows: [] };
    if (sql.includes("SELECT details FROM zzsh_iam.im_consultation_event")) return { rows: [] };
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation_event"')) return { rows: [] };
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { audits.push({ action: values[4], reason: values[9], details: values[10] }); return { rows: [] }; }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation"') && sql.includes('"state" = \'ACTIVE\'')) {
      state.round = "ACTIVE"; state.assignedAdminId = String(values[2]); state.peerAccountId = String(values[3]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_support_thread"') && sql.includes('"state" = \'ACTIVE\'')) {
      state.threadState = "ACTIVE"; state.threadPeer = String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    return null;
  });
  const options = {
    pool: f.pool,
    appId: APP_ID,
    provider,
    supportManager: {
      key: managerKey,
      provisioner: {
        ensure: async () => ({
          outcome: "READY",
          mapping: {
            id: "manager_mapping", key: managerKey, accountId: managerAccountId, identityMarker: buildYunxinIdentityMarker(managerKey),
            status: "READY", version: 1, attemptCount: 0, attemptLeaseUntil: null, nextRetryAt: null, lastFailure: null,
          },
        }),
      },
    },
  } as never;
  const admin = { userId: "admin_a", sessionId: "session_a", credentials: {}, security: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false }, sessionLocked: false } as never;
  let result: Awaited<ReturnType<typeof claimConsultation>>;
  try {
    result = await claimConsultation(options, admin, "consult_2", "req_claim");
  } catch (error) {
    throw new Error(`claim failed: ${JSON.stringify(audits)}`, { cause: error });
  }
  assert.equal(provider.created.length, 0, "claim must never create a second Team");
  assert.deepEqual([...provider.members.get("900001")!].sort(), [managerAccountId, userAccountId, agentAccountId].sort());
  assert.equal(provider.dismissed.length, 0);
  assert.equal(state.round, "ACTIVE");
  assert.equal(state.threadState, "ACTIVE");
  assert.equal(result.consultation.state, "ACTIVE");
  assert.equal(result.consultation.threadId, "thread_1");
  assert.equal(result.consultation.canSend, true);
  assert.equal(result.consultation.conversationId, `${agentAccountId}|2|900001`);
});
