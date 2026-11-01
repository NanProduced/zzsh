import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import {
  autoAssignWaitingConsultations,
  claimConsultation,
  closeConsultation,
  createOrResumeUserConsultation,
  readUserMessageAccess,
  retryMessageScopeOperation,
  supportManagerIdentityKey,
  takeoverConsultation,
  transferConsultation,
  transferNoticeText,
} from "../src/im/consultation";
import { FakeSupportScopeProvider } from "./im-test-fixtures";

const APP_ID = "provider-test";
const MANAGER_KEY = supportManagerIdentityKey(APP_ID);
const MANAGER_ACCOUNT = deriveYunxinAccountId(MANAGER_KEY);

type QueryResult = { rows: unknown[]; rowCount?: number };
type Call = { sql: string; values: unknown[] };

const TRANSACTION_SQL = new Set(["BEGIN", "COMMIT", "ROLLBACK"]);

/** Let fire-and-forget side effects (all fake promises) settle without sleeping. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakePool(handler: (sql: string, values: unknown[]) => QueryResult | null | undefined) {
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

function identityFor(kind: "USER" | "ADMIN", subject: string) {
  const key = { provider: "yunxin" as const, appId: APP_ID, realm: kind === "ADMIN" ? "admin" as const : "user" as const, kind, platformSubjectId: subject };
  return { key, accountId: deriveYunxinAccountId(key), marker: buildYunxinIdentityMarker(key) };
}

function identityRows(kind: "USER" | "ADMIN", subject: string) {
  const identity = identityFor(kind, subject);
  return { rows: [{ accountId: identity.accountId, identityMarker: identity.marker, status: "READY" }] };
}

function userAuth(sql: string, values: unknown[]): QueryResult | null {
  if (TRANSACTION_SQL.has(sql)) return { rows: [] };
  if (sql.includes('FROM "zzsh_auth_user"."session"')) return { rows: [{ locked: false, suspended: false }] };
  if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: false, accountStatus: "ACTIVE" }] };
  if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [] };
  if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) return identityRows("USER", String(values[3] ?? "user_a"));
  return null;
}

/** Shared lock/auth surface of lockSupportMutation + assertAdminContextInTransaction (boss admin). */
function supportBase(sql: string): QueryResult | null {
  if (TRANSACTION_SQL.has(sql)) return { rows: [] };
  if (sql === "SET LOCAL lock_timeout = '750ms'" || sql.startsWith("SELECT pg_advisory")) return { rows: [] };
  if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: [{ locked: false, twoFactorEnabled: true, suspended: false }] };
  if (sql.includes('FROM "zzsh_iam"."admin_security"')) {
    if (sql.includes('"is_boss"')) return { rows: [{ status: "ACTIVE", isBoss: true, passwordChangeRequired: false }] };
    return { rows: [{ admin_user_id: "admin_a", game_scope_mode: "ALL_GAMES" }] };
  }
  if (sql.includes("WITH role_permissions AS")) return { rows: [] };
  if (sql.includes("UNION SELECT unnest")) return { rows: [{ id: "admin_a" }] };
  if (sql.includes('FROM "zzsh_auth_admin"."user"') && sql.includes("FOR SHARE NOWAIT")) return { rows: [{ id: "admin_a" }] };
  if (sql.includes("SELECT r.id FROM zzsh_iam.admin_role r")) return { rows: [] };
  if (sql.includes('FROM "zzsh_iam"."im_support_presence"') && sql.includes("FOR UPDATE NOWAIT")) return { rows: [{ admin_user_id: "admin_a" }] };
  if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"') && sql.includes("FOR SHARE NOWAIT")) return { rows: [{ id: "im_admin", platform_subject_id: "admin_a" }] };
  if (sql.includes("FROM zzsh_supply.admin_supply_scope")) return { rows: [] };
  if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) return identityRows("ADMIN", "admin_a");
  if (sql.includes("INSERT INTO zzsh_iam.audit_event")) return { rows: [] };
  if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) return { rows: [] };
  if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation_event"')) return { rows: [] };
  if (sql.includes("SELECT set_config")) return { rows: [] };
  if (sql.includes("UPDATE zzsh_iam.im_support_presence SET") || sql.includes('UPDATE "zzsh_iam"."im_support_presence"')) return { rows: [] };
  return null;
}

function staffRows(...admins: string[]) {
  return {
    rows: admins.map((adminUserId) => ({
      adminUserId,
      adminName: `客服${adminUserId}`,
      accountId: identityFor("ADMIN", adminUserId).accountId,
      identityMarker: identityFor("ADMIN", adminUserId).marker,
    })),
  };
}

function adminContext(adminId = "admin_a") {
  return {
    userId: adminId,
    sessionId: `session_${adminId}`,
    credentials: {},
    security: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false },
    sessionLocked: false,
  } as never;
}

const userContext = { userId: "user_a", sessionId: "session_user_a" } as never;

function managerOptions(provider: FakeSupportScopeProvider) {
  return {
    key: MANAGER_KEY,
    provisioner: {
      ensure: async () => ({
        outcome: "READY",
        mapping: {
          id: "manager_mapping", key: MANAGER_KEY, accountId: MANAGER_ACCOUNT, identityMarker: buildYunxinIdentityMarker(MANAGER_KEY),
          status: "READY", version: 1, attemptCount: 0, attemptLeaseUntil: null, nextRetryAt: null, lastFailure: null,
        },
      }),
    },
  };
}

/* ---------------------------------- CS-05 ---------------------------------- */

test("CS-05: the first send after a closed round opens one round and sends the entry welcome without assigning", async () => {
  let round: { id: string; state: string } | null = null;
  let threadState = "IDLE";
  let autoAssignCalls = 0;
  const welcomes: Array<{ messageClientId: string; text: string }> = [];
  const inserts: unknown[][] = [];
  const f = fakePool((sql, values) => {
    const auth = userAuth(sql, values);
    if (auth) return auth;
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c') && sql.includes("NOT EXISTS")) {
      autoAssignCalls += 1;
      return { rows: [] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_support_thread"') && sql.includes('"message_scope_id" = $3')) {
      return {
        rows: [{
          id: "thread_1", appId: APP_ID, userId: "user_a", kind: "SERVICE", state: threadState,
          userAccountId: identityFor("USER", "user_a").accountId, peerAccountId: null,
          messageScopeId: "900001", messageScopeState: "READY", lastRoundSeq: "1", version: "2",
        }],
      };
    }
    if (sql.includes('FROM "zzsh_iam"."im_support_thread"') && sql.includes('"id" = $2')) {
      return {
        rows: [{
          id: "thread_1", appId: APP_ID, userId: "user_a", kind: "SERVICE", state: threadState,
          userAccountId: identityFor("USER", "user_a").accountId, peerAccountId: null,
          messageScopeId: "900001", messageScopeState: "READY", lastRoundSeq: "1", version: "2",
        }],
      };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation"') && sql.includes('"state" <> \'CLOSED\'')) {
      return { rows: round ? [{ id: round.id, state: round.state }] : [] };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation"')) {
      inserts.push(values);
      round = { id: String(values[0]), state: "WAITING" };
      return { rows: [] };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_support_thread"') && sql.includes('"state" = \'WAITING\'')) {
      threadState = "WAITING";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation" c') && sql.includes("last_message_preview")) return { rows: [] };
    return null;
  });
  const options = {
    pool: f.pool,
    appId: APP_ID,
    provider: {} as never,
    messageTransport: {
      sendText: async (input: { messageClientId: string; text: string }) => { welcomes.push({ messageClientId: input.messageClientId, text: input.text }); },
    },
    supportManager: managerOptions(new FakeSupportScopeProvider()),
    autoAssignConsultations: true,
  } as never;

  const access = await readUserMessageAccess(options, userContext, `${identityFor("USER", "user_a").accountId}|2|900001`, true);
  await flush();
  assert.equal(access.peerAccountId, MANAGER_ACCOUNT);
  assert.equal(inserts.length, 1, "exactly one waiting round is opened");
  assert.equal(inserts[0]?.[3], "SERVICE");
  assert.equal(inserts[0]?.[6], "thread_1", "the round reuses the persistent thread");
  assert.equal(inserts[0]?.[10], "SERVICE", "the service entry is recorded on the round");
  assert.deepEqual(welcomes.map((item) => item.messageClientId),
    [`support_welcome_${round!.id}_1`, `support_welcome_${round!.id}_2`], "the entry welcome is keyed by the opened round");
  assert.deepEqual(welcomes.map((item) => item.text), [
    "您好，欢迎光临洲洲商行，很高兴为您服务～",
    "账号、订单或售后问题都可以直接发在这里，客服会尽快为您处理。",
  ]);
  assert.equal(autoAssignCalls, 0, "opening a round or sending its welcome never starts auto-assign");

  await readUserMessageAccess(options, userContext, `${identityFor("USER", "user_a").accountId}|2|900001`, true);
  await flush();
  assert.equal(inserts.length, 1, "a normal send does not open a second round");
  assert.equal(welcomes.length, 2, "a normal send never repeats the welcome");
  assert.equal(autoAssignCalls, 0, "a plain send without preview recording does not assign here");
});

test("entry intent: a COMPLAINT entry still opens a SERVICE thread and sends the complaint welcome", async () => {
  const texts: string[] = [];
  const fixture = createConsultationFixture({
    sendText: async (input: { text: string }) => { texts.push(input.text); },
  });
  const created = await createOrResumeUserConsultation({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: {} as never,
    messageTransport: { sendText: fixture.transport.sendText },
    supportManager: managerOptions(new FakeSupportScopeProvider()),
    autoAssignConsultations: true,
  } as never, userContext, "SERVICE", null, "req_complaint_entry", "COMPLAINT");
  await flush();
  assert.equal(created.consultation.type, "SERVICE", "the thread kind stays SERVICE");
  assert.equal(created.consultation.state, "WAITING");
  assert.equal(fixture.inserts[0]!.values[3], "SERVICE", "the round kind is normalized");
  assert.equal(fixture.inserts[0]!.values[10], "COMPLAINT", "the raw entry intent is stored for the welcome");
  assert.deepEqual(texts, [
    "抱歉给您带来不好的体验，您的反馈已记录。",
    "请把具体情况发在这里，客服会尽快跟进处理。",
  ]);
  assert.equal(fixture.autoAssignCalls, 0, "entering through the complaint scene never assigns");
});

/* ---------------------------------- CS-03 ---------------------------------- */test("CS-03: a NEEDS_REVIEW ADD_MEMBER keeps auto-assign from inserting a second operation", async () => {
  const fixture = claimFixture({ opState: "NEEDS_REVIEW", opTarget: "admin_a" });
  const result = await autoAssignWaitingConsultations({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
    autoAssignConsultations: true,
  } as never, 5);
  assert.deepEqual(result, []);
  assert.equal(fixture.state.inserts, 0, "no second ADD_MEMBER is created while one is unresolved");
  const candidateQuery = fixture.f.calls.find(({ sql }) => sql.includes("NOT EXISTS"));
  assert.ok(candidateQuery);
  assert.match(candidateQuery!.sql, /'NEEDS_REVIEW'/);
  assert.match(candidateQuery!.sql, /'FAILED'/);
});

test("CS-03: the reserved agent re-claims the same NEEDS_REVIEW ADD_MEMBER and activates the round", async () => {
  const fixture = claimFixture({ opState: "NEEDS_REVIEW", opTarget: "admin_a" });
  const result = await claimConsultation({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
  } as never, adminContext(), "consult_2", "req_claim_retry");

  assert.equal(fixture.state.resets, 1, "the same operation row is reset");
  assert.equal(fixture.state.inserts, 0, "no second ADD_MEMBER is inserted");
  assert.equal(fixture.state.opId, fixture.operationId, "the original operation id is executed");
  assert.equal(result.consultation.state, "ACTIVE");
  assert.equal(result.consultation.assignedAdmin?.id, "admin_a");
  assert.deepEqual([...fixture.provider.members.get("900001")!].sort(),
    [MANAGER_ACCOUNT, identityFor("USER", "user_a").accountId, identityFor("ADMIN", "admin_a").accountId].sort());
  // 复用同一条操作只做只读资格校验；失败结算已释放原预留，恢复成功补回一次。
  assert.ok(fixture.f.calls.some(({ sql }) => sql.includes("FROM zzsh_iam.im_support_presence p JOIN")),
    "the reuse path still checks eligibility");
  assert.ok(!fixture.f.calls.some(({ sql }) => sql.includes("last_consultation_assigned_at")),
    "reuse never advances last_consultation_assigned_at");
  assert.equal(countCalls(fixture.f.calls, "active_load=active_load+1"), 1,
    "recovery restores the released load exactly once");
  assert.equal(countCalls(fixture.f.calls, '"active_load" = GREATEST'), 0,
    "a successful recovery does not release again");
});

test("CS-03: another agent gets an explicit conflict instead of a second ADD_MEMBER", async () => {
  const fixture = claimFixture({ opState: "NEEDS_REVIEW", opTarget: "admin_b" });
  await assert.rejects(
    claimConsultation({
      pool: fixture.f.pool,
      appId: APP_ID,
      provider: fixture.provider,
      supportManager: managerOptions(fixture.provider),
    } as never, adminContext(), "consult_2", "req_claim_conflict"),
    (error: { status?: number; message?: string }) => error.status === 409 && /待对账/.test(error.message ?? ""),
  );
  assert.equal(fixture.state.inserts, 0, "the conflicting target never creates a second operation");
  assert.equal(fixture.state.resets, 0, "the conflicting target never resets someone else's operation");
});

test("CS-03: retryMessageScopeOperation resets and executes the same ADD_MEMBER", async () => {
  const fixture = claimFixture({ opState: "NEEDS_REVIEW", opTarget: "admin_a" });
  const result = await retryMessageScopeOperation({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
  } as never, adminContext(), "consult_2", "req_retry_add_member");

  assert.equal(fixture.state.resets, 1);
  assert.equal(fixture.state.inserts, 0);
  assert.equal(fixture.state.opId, fixture.operationId);
  assert.equal(result.consultation.state, "ACTIVE");
  assert.equal(result.consultation.messageScopeState, "READY", "ADD_MEMBER recovery never moves the round scope");
  assert.ok(!fixture.f.calls.some(({ sql }) => sql.includes("last_consultation_assigned_at")),
    "the recovery entry never reserves a second load");
  assert.equal(countCalls(fixture.f.calls, "active_load=active_load+1"), 1,
    "retry recovery restores the released load exactly once");
  assert.equal(countCalls(fixture.f.calls, '"active_load" = GREATEST'), 0,
    "a successful retry does not release again");
});

test("CS-03: an unreadable Team leaves the same ADD_MEMBER in NEEDS_REVIEW and the round READY", async () => {
  const fixture = claimFixture({ opState: "NEEDS_REVIEW", opTarget: "admin_a" });
  fixture.provider.teams.delete("900001");
  fixture.provider.members.delete("900001");
  await assert.rejects(
    retryMessageScopeOperation({
      pool: fixture.f.pool,
      appId: APP_ID,
      provider: fixture.provider,
      supportManager: managerOptions(fixture.provider),
    } as never, adminContext(), "consult_2", "req_retry_unreadable"),
    /being recovered/,
  );
  assert.equal(fixture.state.inserts, 0, "an unreadable Team never creates a replacement operation");
  assert.equal(fixture.state.opState, "NEEDS_REVIEW");
  assert.equal(fixture.state.round, "WAITING");
  assert.equal(fixture.state.scopeState, "READY", "ADD_MEMBER failures keep the round scope READY");
});

/* ---------------------------------- CS-07 ---------------------------------- */

test("CS-07: auto-assign yields to pending paid orders before reserving an agent for the consultation", async () => {
  const fixture = claimFixture({ opState: "NONE", opTarget: "admin_a", pendingOrders: true });
  const result = await autoAssignWaitingConsultations({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
    autoAssignConsultations: true,
  } as never, 5);
  assert.deepEqual(result, []);
  assert.equal(fixture.state.inserts, 0, "the consultation does not get an ADD_MEMBER while orders remain");
  const orderQuery = fixture.f.calls.findIndex(({ sql }) => sql.includes("FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o"));
  const reserveQuery = fixture.f.calls.findIndex(({ sql }) => sql.includes("last_consultation_assigned_at"));
  assert.ok(orderQuery >= 0, "the order dispatch runs first");
  assert.equal(reserveQuery, -1, "no consultation candidate is reserved while orders remain");
  assert.equal(fixture.state.round, "WAITING");
});

/* ---------------------------------- CS-04 ---------------------------------- */

test("CS-04: a successful close wakes auto-assign; a rejected close does not", async () => {
  const fixture = closeFixture();
  const options = {
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: {} as never,
    supportManager: managerOptions(new FakeSupportScopeProvider()),
    autoAssignConsultations: true,
  } as never;
  const closed = await closeConsultation(options, adminContext(), "consult_2", "req_close");
  assert.equal(closed.consultation.state, "CLOSED");
  assert.equal(fixture.state.autoAssignCalls, 1, "the freed slot is offered to waiting rounds");
  const closeUpdate = fixture.f.calls.findIndex(({ sql }) => sql.startsWith('UPDATE "zzsh_iam"."im_consultation"') && sql.includes("'CLOSED'"));
  const wakeQuery = fixture.f.calls.findIndex(({ sql }) => sql.includes("NOT EXISTS") && sql.includes("im_consultation_scope_operation"));
  assert.ok(closeUpdate >= 0 && wakeQuery > closeUpdate, "the wake runs only after the close writeback");

  const rejected = closeFixture();
  await assert.rejects(
    closeConsultation({
      pool: rejected.f.pool,
      appId: APP_ID,
      provider: {} as never,
      supportManager: managerOptions(new FakeSupportScopeProvider()),
      autoAssignConsultations: true,
    } as never, adminContext("admin_b"), "consult_2", "req_close_denied"),
    (error: { status?: number }) => error.status === 403,
  );
  assert.equal(rejected.state.autoAssignCalls, 0, "a failed close never wakes auto-assign");
});

test("CS-04: transfer and takeover wake auto-assign only after their successful writeback", () => {
  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  const between = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end));
  const transfer = between("async function transferWithScope", "export async function listTransferTargets");
  assert.match(transfer, /await runScopeOperationNow\([^;]+\);\s*const result = await readAdminConsultationView\([^;]+\);[\s\S]*?void wakeAutoAssign\(options\);/);
  const takeover = between("export async function takeoverConsultation", "export async function closeConsultation");
  assert.match(takeover, /await runScopeOperationNow\(options, plan!\.operationId\);\s*const result = await readAdminConsultationView\([^;]+\);\s*void wakeAutoAssign\(options\);/s);
});

/* ------------------------- transfer user broadcast ------------------------- */

test("a completed transfer broadcasts one bot notice naming the new agent", async () => {
  const fixture = transferFixture();
  const result = await transferConsultation(fixture.options, adminContext("admin_a"), "consult_2", "admin_b", "req_transfer_notice");
  assert.equal(result.consultation.state, "ACTIVE");
  assert.equal(result.consultation.assignedAdmin?.id, "admin_b", "the server view still reports the new assignee");
  assert.deepEqual(fixture.notices, [{
    conversationId: `${MANAGER_ACCOUNT}|2|900001`,
    senderAccountId: MANAGER_ACCOUNT,
    receiverAccountId: "900001",
    messageClientId: `support_transfer_${fixture.state.opId}`,
    text: transferNoticeText("客服 B"),
  }]);
  assert.equal(fixture.state.opState, "SUCCEEDED");
});

test("takeover moves responsibility without broadcasting a transfer notice", async () => {
  const fixture = transferFixture();
  const transferred = await transferConsultation(fixture.options, adminContext("admin_a"), "consult_2", "admin_b", "req_transfer_before_takeover");
  assert.equal(transferred.consultation.assignedAdmin?.id, "admin_b");
  assert.equal(fixture.notices.length, 1);

  const taken = await takeoverConsultation(fixture.options, adminContext("admin_a"), "consult_2", "req_takeover_silent", null);
  assert.equal(taken.consultation.assignedAdmin?.id, "admin_a");
  assert.equal(fixture.notices.length, 1, "takeover reuses the transfer scope operation but never notifies the user");
  assert.equal(fixture.sendAttempts, 1);
});

test("a failed transfer notice never changes the transfer outcome", async () => {
  const fixture = transferFixture({ failSend: true });
  const result = await transferConsultation(fixture.options, adminContext("admin_a"), "consult_2", "admin_b", "req_transfer_notice_failure");
  assert.equal(result.consultation.state, "ACTIVE");
  assert.equal(result.consultation.assignedAdmin?.id, "admin_b");
  assert.equal(fixture.sendAttempts, 1, "the bot notice is attempted once");
  assert.equal(fixture.state.opState, "SUCCEEDED", "the transfer operation still settles successfully");
});

test("retrying a settled transfer never sends a second notice", async () => {
  const fixture = transferFixture();
  await transferConsultation(fixture.options, adminContext("admin_a"), "consult_2", "admin_b", "req_transfer_before_retry");
  assert.equal(fixture.notices.length, 1);

  const retried = await retryMessageScopeOperation(fixture.options, adminContext("admin_b"), "consult_2", "req_transfer_retry");
  assert.equal(retried.consultation.assignedAdmin?.id, "admin_b");
  assert.equal(fixture.sendAttempts, 1);
  assert.equal(fixture.notices.length, 1, "the settled operation is reused and the notice id is not replayed");
});

/* ------------------------------ hardening --------------------------------- */

test("hardening: an offline agent cannot reuse the reserved ADD_MEMBER and no load is taken", async () => {
  const fixture = claimFixture({ opState: "NEEDS_REVIEW", opTarget: "admin_a", offline: true });
  await assert.rejects(
    claimConsultation({
      pool: fixture.f.pool,
      appId: APP_ID,
      provider: fixture.provider,
      supportManager: managerOptions(fixture.provider),
    } as never, adminContext(), "consult_2", "req_claim_offline"),
    (error: { status?: number; message?: string }) => error.status === 503 && /不可接待/.test(error.message ?? ""),
  );
  assert.equal(fixture.state.inserts, 0, "an ineligible agent never creates a second operation");
  assert.equal(fixture.state.resets, 0, "an ineligible agent never resets the reserved operation");
  assert.equal(fixture.state.opState, "NEEDS_REVIEW");
  assert.ok(!fixture.f.calls.some(({ sql }) => sql.includes("last_consultation_assigned_at")),
    "the failed reuse never reserves");
});

test("hardening: a new claim still reserves exactly once and success never releases it", async () => {
  const fixture = claimFixture({ opState: "NONE", opTarget: "admin_a" });
  const result = await claimConsultation({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
  } as never, adminContext(), "consult_2", "req_claim_new");
  assert.equal(result.consultation.state, "ACTIVE");
  assert.equal(fixture.state.inserts, 1, "the new claim records one ADD_MEMBER");
  assert.equal(fixture.state.resets, 0);
  assert.equal(countCalls(fixture.f.calls, "active_load=active_load+1"), 1, "exactly one reservation");
  assert.equal(countCalls(fixture.f.calls, '"active_load" = GREATEST'), 0, "a successful claim keeps its load");
});

/* ----------------------- complaints unified to SERVICE ----------------------- */

test("complaints: a legacy COMPLAINT round claims with read+accept plus management takeover and never reads exclusions", async () => {
  const fixture = claimFixture({
    opState: "NONE", opTarget: "admin_a", kind: "COMPLAINT",
    permissions: ["im.support.read", "im.support.accept", "im.support.audit.takeover"],
  });
  const result = await claimConsultation({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
  } as never, adminContext(), "consult_2", "req_claim_legacy_complaint");
  assert.equal(result.consultation.type, "COMPLAINT", "legacy rows keep their read type");
  assert.equal(result.consultation.state, "ACTIVE");
  assert.equal(fixture.state.inserts, 1, "exactly one ADD_MEMBER is recorded");
  assert.ok(!fixture.f.calls.some(({ sql }) => sql.includes("SELECT details FROM zzsh_iam.im_consultation_event")),
    "complaint exclusion evidence no longer participates in claim");
});

test("complaints: auto-assign reserves a legacy COMPLAINT round without im.support.complaint", async () => {
  const fixture = claimFixture({
    opState: "NONE", opTarget: "admin_a", kind: "COMPLAINT",
    permissions: ["im.support.read", "im.support.accept"],
  });
  const assigned = await autoAssignWaitingConsultations({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
    autoAssignConsultations: true,
  } as never, 5);
  assert.deepEqual(assigned, ["consult_2"]);
  assert.equal(fixture.state.inserts, 1, "exactly one ADD_MEMBER is recorded");
  assert.equal(fixture.state.round, "ACTIVE");
  assert.equal(countCalls(fixture.f.calls, "active_load=active_load+1"), 1);
  assert.ok(!fixture.f.calls.some(({ sql }) => sql.includes("SELECT details FROM zzsh_iam.im_consultation_event")),
    "complaint exclusion evidence no longer participates in assignment");
});

test("hardening: auto-assign releases the reserved load when the claim never starts", async () => {
  const fixture = claimFixture({ opState: "NONE", opTarget: "admin_a", claimNeverStarts: true });
  const result = await autoAssignWaitingConsultations({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
    autoAssignConsultations: true,
  } as never, 5);
  assert.deepEqual(result, []);
  assert.equal(fixture.state.inserts, 1, "the candidate was reserved and an operation was recorded");
  assert.equal(countCalls(fixture.f.calls, "active_load=active_load+1"), 1);
  assert.equal(countCalls(fixture.f.calls, '"active_load" = GREATEST'), 1, "the unused reservation is given back");
  assert.equal(fixture.state.round, "WAITING");
});

test("hardening: a settled operation releases the load exactly once, never twice", async () => {
  const fixture = claimFixture({ opState: "NONE", opTarget: "admin_a", reconcileFailure: true });
  fixture.provider.teams.delete("900001");
  fixture.provider.members.delete("900001");
  const result = await autoAssignWaitingConsultations({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
    autoAssignConsultations: true,
  } as never, 5);
  assert.deepEqual(result, []);
  assert.equal(fixture.state.inserts, 1);
  assert.equal(countCalls(fixture.f.calls, "active_load=active_load+1"), 1);
  assert.equal(countCalls(fixture.f.calls, '"active_load" = GREATEST'), 1,
    "settleScopeOperationFailure released it; the caller guard must not release again");
  assert.equal(fixture.state.opState, "NEEDS_REVIEW");
  assert.equal(fixture.state.round, "WAITING");
});

/* --------------------- waiting rounds and no-support fallback ---------------------- */

test("no support: a waiting round with a user message gets exactly one platform fallback", async () => {
  const fixture = claimFixture({ opState: "NONE", opTarget: "admin_a", offline: true });
  const texts: string[] = [];
  const options = {
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
    messageTransport: { sendText: async (input: { text: string }) => { texts.push(input.text); } },
    autoAssignConsultations: true,
  } as never;

  assert.deepEqual(await autoAssignWaitingConsultations(options, 5), []);
  assert.deepEqual(texts, ["抱歉，当前暂无在线客服，请先留言，客服上线后我们会第一时间联系您！"],
    "no eligible agent sends the one platform fallback");
  assert.equal(fixture.state.noSupportMarked, true);

  assert.deepEqual(await autoAssignWaitingConsultations(options, 5), []);
  assert.equal(texts.length, 1, "the same round is never told twice");
  const mark = fixture.f.calls.find(({ sql }) => sql.includes('"no_support_notice_at" = clock_timestamp()'));
  assert.match(mark!.sql, /"first_user_message_at" IS NOT NULL AND "no_support_notice_at" IS NULL/,
    "the notice is guarded by the user-message and one-shot facts");
  const scan = fixture.f.calls.find(({ sql }) => sql.includes("NOT EXISTS") && sql.includes("im_consultation_scope_operation"));
  assert.match(scan!.sql, /c\."first_user_message_at" IS NOT NULL/,
    "empty rounds never enter the assignment scan");
});

test("no support: a successful assignment never sends the fallback", async () => {
  const fixture = claimFixture({ opState: "NONE", opTarget: "admin_a" });
  const texts: string[] = [];
  const assigned = await autoAssignWaitingConsultations({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: fixture.provider,
    supportManager: managerOptions(fixture.provider),
    messageTransport: { sendText: async (input: { text: string }) => { texts.push(input.text); } },
    autoAssignConsultations: true,
  } as never, 5);
  assert.deepEqual(assigned, ["consult_2"]);
  assert.equal(fixture.state.noSupportMarked, false);
  assert.deepEqual(texts, ["您好，我是本次为您服务的客服客服admin_a，已收到您的留言，马上为您处理。"],
    "only the assigned agent greets the user");
});

test("hardening: create returns after committing the round even when the welcome transport is slow", async () => {
  let releaseWelcome!: () => void;
  const welcomeGate = new Promise<void>((resolve) => { releaseWelcome = resolve; });
  const welcomes: string[] = [];
  const fixture = createConsultationFixture({
    sendText: async (input: { messageClientId: string }) => { welcomes.push(input.messageClientId); await welcomeGate; },
  });
  const pending = createOrResumeUserConsultation({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: {} as never,
    messageTransport: { sendText: fixture.transport.sendText },
    supportManager: managerOptions(new FakeSupportScopeProvider()),
  } as never, userContext, "SERVICE", "listing_slow", "req_slow");
  const outcome = await Promise.race([
    pending.then(() => "created" as const),
    flush().then(() => "pending" as const),
  ]);
  assert.equal(outcome, "created", "the HTTP path never waits for the welcome transport");
  const created = await pending;
  assert.equal(created.consultation.state, "WAITING");
  assert.equal(fixture.inserts.length, 1, "the round is committed before the welcome runs");
  await flush();
  assert.deepEqual(welcomes, [`support_welcome_${created.consultation.id}_1`], "the first welcome is attempted once after loading settings");
  assert.equal(fixture.previewUpdates.length, 0, "the message preview lands only after the transport resolves");
  assert.equal(fixture.autoAssignCalls, 0, "opening a round never scans the assignment queue");
  releaseWelcome();
  await flush();
  assert.equal(welcomes.length, 2, "both entry messages are attempted after the transport resolves");
  assert.equal(fixture.previewUpdates.length, 2, "the fire-and-forget side effect finishes after the response");
});

test("hardening: a failed welcome still leaves the user-opened round queue-visible", async () => {
  const fixture = createConsultationFixture({
    sendText: async () => { throw new Error("welcome transport is down"); },
  });
  const created = await createOrResumeUserConsultation({
    pool: fixture.f.pool,
    appId: APP_ID,
    provider: {} as never,
    messageTransport: { sendText: fixture.transport.sendText },
    supportManager: managerOptions(new FakeSupportScopeProvider()),
  } as never, userContext, "SERVICE", null, "req_welcome_failed");
  await flush();
  assert.equal(created.consultation.state, "WAITING", "the business fact survives the failed welcome");
  const insert = fixture.inserts[0]!;
  assert.match(insert.sql, /"last_message_at", "entry_intent"\)/);
  assert.match(insert.sql, /clock_timestamp\(\)/);
  const threadUpdate = fixture.f.calls.find(({ sql }) => sql.includes('UPDATE "zzsh_iam"."im_support_thread"') && sql.includes('"state" = \'WAITING\''));
  assert.match(threadUpdate!.sql, /"user_read_at" = clock_timestamp\(\)/, "the opener's own action does not fabricate unread");
  assert.equal(fixture.previewUpdates.length, 0, "no welcome preview was written");
  // 队列与自动分配都只隐藏 first_user_message_at 为空的无主 WAITING 轮次。
  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  assert.match(source, /AND NOT \(c\."state" = 'WAITING' AND c\."assigned_admin_id" IS NULL AND c\."first_user_message_at" IS NULL\)/);
  assert.match(source, /AND c\."first_user_message_at" IS NOT NULL/);
});

/* ------------------------------- fixtures ---------------------------------- */

function countCalls(calls: Call[], needle: string): number {
  return calls.filter(({ sql }) => sql.includes(needle)).length;
}

/** ACTIVE round already owned by admin_a on a READY thread Team with admin_b as a second eligible agent. */
function transferFixture(input: { failSend?: boolean } = {}) {
  const provider = new FakeSupportScopeProvider();
  const userAccountId = identityFor("USER", "user_a").accountId;
  const adminAAccountId = identityFor("ADMIN", "admin_a").accountId;
  const adminBAccountId = identityFor("ADMIN", "admin_b").accountId;
  provider.teams.set("900001", { appId: APP_ID, consultationId: "thread_1", ownerAccountId: MANAGER_ACCOUNT, memberAccountIds: [userAccountId, adminAAccountId] } as never);
  provider.members.set("900001", new Set([MANAGER_ACCOUNT, userAccountId, adminAAccountId]));

  const state = {
    assignedAdminId: "admin_a" as string | null,
    peerAccountId: adminAAccountId as string | null,
    threadPeer: adminAAccountId as string | null,
    scopeState: "READY" as string,
    scopeVersion: "2",
    opId: "",
    opState: "NONE" as string,
    opLeaseHash: null as string | null,
    opAttemptCount: 0,
    previousAdminId: null as string | null,
    previousAdminAccountId: null as string | null,
    targetAdminId: null as string | null,
    targetAdminAccountId: null as string | null,
  };
  const adminName = (id: string | null) => id === "admin_b" ? "客服 B" : id === "admin_a" ? "客服 A" : null;
  const row = () => ({
    id: "consult_2", userId: "user_a", kind: "SERVICE", state: "ACTIVE",
    userAccountId, peerAccountId: state.peerAccountId, assignedAdminId: state.assignedAdminId, subjectRef: null,
    version: 3, lastMessageAt: null, lastMessagePreview: null,
    createdAt: new Date("2026-10-20T00:00:00.000Z"), updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    userName: "用户甲", userUsername: "user_a", adminName: adminName(state.assignedAdminId), appId: APP_ID,
    messageScopeType: "TEAM", messageScopeId: "900001", messageScopeState: state.scopeState, messageScopeVersion: 3,
    threadId: "thread_1", roundSeq: 2, threadState: "ACTIVE", threadScopeId: "900001",
    threadScopeState: "READY", threadPeerAccountId: state.threadPeer,
    userReadAt: null, adminReadAt: null, userUnreadCount: 0, adminUnreadCount: 0,
  });
  const thread = () => ({
    id: "thread_1", appId: APP_ID, userId: "user_a", kind: "SERVICE", state: "ACTIVE",
    userAccountId, peerAccountId: state.threadPeer, messageScopeId: "900001", messageScopeState: "READY",
    lastRoundSeq: "2", version: "3",
  });
  const scopeRow = () => ({
    id: state.opId, appId: APP_ID, consultationId: "consult_2", operationType: "TRANSFER", state: state.opState,
    scopeVersion: state.scopeVersion, ownerAccountId: MANAGER_ACCOUNT, userAccountId,
    previousAdminId: state.previousAdminId, targetAdminId: state.targetAdminId,
    previousAdminAccountId: state.previousAdminAccountId, targetAdminAccountId: state.targetAdminAccountId,
    providerTeamId: "900001", attemptCount: state.opAttemptCount,
    leaseTokenHash: state.opLeaseHash, leaseUntil: state.opLeaseHash ? new Date(Date.now() + 60_000).toISOString() : null,
    nextRetryAt: new Date(0).toISOString(), lastFailureClass: null, lastFailureDetail: null,
  });

  const notices: Array<{ conversationId: string; senderAccountId: string; receiverAccountId: string; text: string; messageClientId: string }> = [];
  let sendAttempts = 0;

  const f = fakePool((sql, values) => {
    if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"') && !sql.includes("FOR SHARE NOWAIT")) {
      return identityRows("ADMIN", String(values[3] ?? "admin_a"));
    }
    // Locked roster: every participant is present and mapped so both agents stay candidates.
    if (sql.includes("SELECT admin_user_id AS id FROM zzsh_iam.im_support_presence")) {
      return { rows: (values[1] as string[]).map((id) => ({ id })) };
    }
    if (sql.includes("FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=ANY($2::text[])")) {
      return { rows: (values[1] as string[]).map((admin_user_id) => ({ admin_user_id })) };
    }
    if (sql.includes("FROM zzsh_iam.admin_security") && sql.includes("FOR SHARE NOWAIT")) {
      return { rows: (values[0] as string[]).map((admin_user_id) => ({ admin_user_id, mode: "ALL_GAMES" })) };
    }
    if (sql.includes('FROM "zzsh_iam"."admin_security"') && sql.includes("FOR SHARE NOWAIT")) {
      return { rows: (values[0] as string[]).map((admin_user_id) => ({ admin_user_id, mode: "ALL_GAMES" })) };
    }
    if (sql.includes('FROM "zzsh_auth_admin"."user"') && sql.includes("FOR SHARE NOWAIT")) {
      return { rows: (values[0] as string[]).map((id) => ({ id })) };
    }
    if (sql.includes("FROM zzsh_iam.im_identity_mapping") && sql.includes("FOR SHARE NOWAIT")) {
      return { rows: (values[1] as string[]).map((id) => ({ id: `im_${id}`, platform_subject_id: id })) };
    }
    const base = supportBase(sql);
    if (base) return base;
    if (sql.includes("FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o")) return { rows: [] };
    if (sql.includes("SET wait_reason='NO_ELIGIBLE_STAFF'")) return { rows: [] };
    if (sql.includes("FROM zzsh_iam.im_support_presence p JOIN")) {
      return { rows: [
        { adminUserId: "admin_a", adminName: "客服 A", accountId: adminAAccountId, identityMarker: identityFor("ADMIN", "admin_a").marker },
        { adminUserId: "admin_b", adminName: "客服 B", accountId: adminBAccountId, identityMarker: identityFor("ADMIN", "admin_b").marker },
      ] };
    }
    if ((sql.includes("SELECT admin_user_id FROM zzsh_iam.im_support_presence") || sql.includes('SELECT p."admin_user_id" FROM zzsh_iam.im_support_presence p')) && sql.includes("last_consultation_assigned_at")) {
      return { rows: [{ admin_user_id: (values[1] as string[])[0] }] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation_scope_operation"')) {
      if (sql.includes('SELECT "id" FROM')) {
        if (sql.includes("IN ('PENDING', 'RUNNING', 'UNKNOWN')")) {
          return { rows: ["PENDING", "RUNNING", "UNKNOWN"].includes(state.opState) ? [{ id: state.opId }] : [] };
        }
        return { rows: state.opId ? [{ id: state.opId }] : [] };
      }
      if (sql.includes('"consultation_id" AS "consultationId"')) return { rows: state.opId ? [scopeRow()] : [] };
      return { rows: [] };
    }
    if (sql.includes("UPDATE zzsh_iam.im_consultation_scope_operation") && sql.includes("SET lease_until=clock_timestamp()")) {
      return { rows: [{ id: state.opId }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation_scope_operation"')) {
      state.opId = String(values[0]);
      state.scopeVersion = String(values[3]);
      state.previousAdminId = values[6] === null ? null : String(values[6]);
      state.targetAdminId = String(values[7]);
      state.previousAdminAccountId = values[8] === null ? null : String(values[8]);
      state.targetAdminAccountId = String(values[9]);
      state.opState = "PENDING";
      state.opLeaseHash = null;
      state.opAttemptCount = 0;
      return { rows: [] };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation_scope_operation"')) {
      if (sql.includes('SET "state" = \'RUNNING\'')) {
        if (!["PENDING", "UNKNOWN"].includes(state.opState)) return { rows: [], rowCount: 0 };
        state.opState = "RUNNING";
        state.opLeaseHash = String(values[3]);
        state.opAttemptCount += 1;
        return { rows: [scopeRow()] };
      }
      if (sql.includes('"state" = \'SUCCEEDED\'')) {
        state.opState = "SUCCEEDED";
        state.opLeaseHash = null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SET "state" = $3')) {
        state.opState = String(values[2]);
        state.opLeaseHash = null;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation"') && sql.includes('"assigned_admin_id" = $3')) {
      if (state.scopeState !== "TRANSFERRING") return { rows: [], rowCount: 0 };
      state.assignedAdminId = String(values[2]);
      state.peerAccountId = String(values[3]);
      state.scopeState = "READY";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation"') && sql.includes("'TRANSFERRING'")) {
      state.scopeState = "TRANSFERRING";
      return { rows: [{ messageScopeVersion: "3" }], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_support_thread" t')) {
      state.threadPeer = String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c') && sql.includes('JOIN "zzsh_iam"."im_support_thread" t')) {
      return { rows: [row()] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_support_thread"') && sql.includes('"id" = $2')) return { rows: [thread()] };
    if (sql.includes('SELECT "note" FROM "zzsh_iam"."im_support_handover"')) return { rows: [] };
    if (sql.includes('INSERT INTO "zzsh_iam"."im_support_handover"')) return { rows: [] };
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation" c') && sql.includes("last_message_preview")) return { rows: [] };
    return null;
  });

  const options = {
    pool: f.pool,
    appId: APP_ID,
    provider,
    messageTransport: {
      sendText: async (message: { conversationId: string; senderAccountId: string; receiverAccountId: string; text: string; messageClientId?: string }) => {
        sendAttempts += 1;
        const messageClientId = String(message.messageClientId);
        notices.push({ conversationId: message.conversationId, senderAccountId: message.senderAccountId,
          receiverAccountId: message.receiverAccountId, text: message.text, messageClientId });
        if (input.failSend) throw new Error("transport unavailable");
        return { messageClientId, messageServerId: "server-notice", conversationId: message.conversationId,
          senderId: message.senderAccountId, receiverId: message.receiverAccountId, createTime: Date.now(), text: message.text, messageType: 0 as const };
      },
    },
    supportManager: managerOptions(provider),
  } as never;

  return { f, provider, state, notices, options, get sendAttempts() { return sendAttempts; } };
}

function claimFixture(input: {
  opState: string;
  opTarget: string;
  automatic?: boolean;
  pendingOrders?: boolean;
  /** No eligible candidate: the agent went offline or lost the reception grant. */
  offline?: boolean;
  /** The recorded operation is never claimed (lease race): runScopeOperationNow returns silently. */
  claimNeverStarts?: boolean;
  /** The new operation is claimed but the provider reconciliation fails and settles it. */
  reconcileFailure?: boolean;
  /** Legacy read type of the round; old COMPLAINT rows must share SERVICE permissions. */
  kind?: "SERVICE" | "COMPLAINT";
  /** Non-boss grants; omitted keeps the fixture's boss administrator. */
  permissions?: string[];
}) {
  const provider = new FakeSupportScopeProvider();
  const userAccountId = identityFor("USER", "user_a").accountId;
  const targetAccountId = identityFor("ADMIN", input.opTarget).accountId;
  const operationId = "im_scope_op_existing";
  provider.teams.set("900001", { appId: APP_ID, consultationId: "thread_1", ownerAccountId: MANAGER_ACCOUNT, memberAccountIds: [userAccountId] } as never);
  provider.members.set("900001", new Set([MANAGER_ACCOUNT, userAccountId]));

  const state = {
    round: "WAITING" as "WAITING" | "ACTIVE",
    assignedAdminId: null as string | null,
    peerAccountId: null as string | null,
    threadState: "WAITING" as "WAITING" | "ACTIVE",
    threadPeer: null as string | null,
    scopeState: "READY",
    opId: operationId,
    opState: input.opState,
    opTarget: input.opTarget,
    opLeaseHash: null as string | null,
    attemptCount: 1,
    inserts: 0,
    resets: 0,
    noSupportMarked: false,
  };

  const scopeRow = () => ({
    id: state.opId,
    appId: APP_ID,
    consultationId: "consult_2",
    operationType: "ADD_MEMBER",
    state: state.opState,
    scopeVersion: "2",
    ownerAccountId: MANAGER_ACCOUNT,
    userAccountId,
    previousAdminId: null,
    targetAdminId: state.opTarget,
    previousAdminAccountId: null,
    targetAdminAccountId: targetAccountId,
    providerTeamId: "900001",
    attemptCount: state.attemptCount,
    leaseTokenHash: state.opLeaseHash,
    leaseUntil: state.opLeaseHash ? new Date(Date.now() + 60_000).toISOString() : null,
    nextRetryAt: new Date(0).toISOString(),
    lastFailureClass: null,
    lastFailureDetail: null,
  });

  const row = () => ({
    id: "consult_2", userId: "user_a", kind: input.kind ?? "SERVICE", state: state.round,
    userAccountId, peerAccountId: state.peerAccountId, assignedAdminId: state.assignedAdminId, subjectRef: null,
    version: 3, lastMessageAt: null, createdAt: new Date("2026-10-20T00:00:00.000Z"), updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    userName: "用户甲", userUsername: "user_a", adminName: state.assignedAdminId ? "客服甲" : null, appId: APP_ID,
    messageScopeType: "TEAM", messageScopeId: "900001", messageScopeState: state.scopeState, messageScopeVersion: 2,
    threadId: "thread_1", roundSeq: 2, threadState: state.threadState, threadScopeId: "900001",
    threadScopeState: "READY", threadPeerAccountId: state.threadPeer,
  });

  const thread = () => ({
    id: "thread_1", appId: APP_ID, userId: "user_a", kind: input.kind ?? "SERVICE", state: state.threadState,
    userAccountId, peerAccountId: state.threadPeer, messageScopeId: "900001", messageScopeState: "READY",
    lastRoundSeq: "2", version: "3",
  });

  const f = fakePool((sql, values) => {
    if (sql.includes("AS automatic")) return {rows:[{automatic:input.automatic===true}]};
    if (input.permissions && sql.includes('FROM "zzsh_iam"."admin_security"') && sql.includes('"is_boss"')) {
      return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false }] };
    }
    if (input.permissions && sql.includes("WITH role_permissions AS")) {
      return { rows: input.permissions.map((permissionCode) => ({ permissionCode })) };
    }
    const base = supportBase(sql);
    if (base) return base;
    if (sql.includes('"no_support_notice_at" = clock_timestamp()')) {
      // 先原子标记再发送：第一次命中，后续同轮不再命中。
      if (state.noSupportMarked) return { rows: [], rowCount: 0 };
      state.noSupportMarked = true;
      return { rows: [{ id: "consult_2" }], rowCount: 1 };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c') && sql.includes("NOT EXISTS")) {
      return { rows: [row()] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation_scope_operation"')) {
      if (state.opState === "NONE") return { rows: [] };
      if (sql.includes('"consultation_id" = $2')) {
        return { rows: [{ id: state.opId, operationType: "ADD_MEMBER", state: state.opState, targetAdminId: state.opTarget }] };
      }
      if (sql.startsWith('SELECT "id" FROM')) return { rows: [{ id: state.opId }] };
      if (sql.includes('"consultation_id" AS "consultationId"')) return { rows: [scopeRow()] };
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation_scope_operation"')) {
      state.inserts += 1;
      if (input.reconcileFailure) {
        state.opId = String(values[0]);
        state.opState = "PENDING";
      }
      return { rows: [] };
    }
    if (sql.includes("UPDATE zzsh_iam.im_consultation_scope_operation") && sql.includes("RETURNING id")) {
      return { rows: [{ id: state.opId }], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation_scope_operation"')) {
      if (sql.includes('SET "state" = \'RUNNING\'')) {
        if (input.claimNeverStarts) return { rows: [], rowCount: 0 };
        state.opState = "RUNNING";
        state.opLeaseHash = String(values[3]);
        state.attemptCount += 1;
        return { rows: [scopeRow()] };
      }
      if (sql.includes("SET lease_until=clock_timestamp()")) return { rows: [{ id: state.opId }] };
      if (sql.includes('"state" = \'SUCCEEDED\'')) { state.opState = "SUCCEEDED"; return { rows: [], rowCount: 1 }; }
      if (sql.includes('SET "state" = $3')) { state.opState = String(values[2]); state.opLeaseHash = null; return { rows: [], rowCount: 1 }; }
      if (sql.includes('SET "state" = \'PENDING\', "attempt_count" = 0')) {
        state.opState = "PENDING"; state.attemptCount = 0; state.resets += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT "thread_id" AS "threadId"')) return { rows: [{ threadId: "thread_1" }] };
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) return { rows: [row()] };
    if (sql.includes('FROM "zzsh_iam"."im_support_thread"')) return { rows: [thread()] };
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation"')) {
      if (sql.includes('"state" = \'ACTIVE\'')) {
        state.round = "ACTIVE"; state.assignedAdminId = String(values[2]); state.peerAccountId = String(values[3]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('"message_scope_state" = $3')) {
        if (["PROVISIONING", "TRANSFERRING", "REVOKING"].includes(state.scopeState)) {
          state.scopeState = String(values[2]);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_support_thread"')) {
      if (sql.includes('"state" = \'ACTIVE\'')) {
        state.threadState = "ACTIVE"; state.threadPeer = String(values[2]);
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM zzsh_iam.im_support_presence p JOIN")) return input.offline ? { rows: [] } : staffRows(input.opTarget);
    if ((sql.includes("SELECT admin_user_id FROM zzsh_iam.im_support_presence") || sql.includes('SELECT p."admin_user_id" FROM zzsh_iam.im_support_presence p')) && sql.includes("last_consultation_assigned_at")) {
      return { rows: [{ admin_user_id: input.opTarget }] };
    }
    if (sql.includes("SELECT details FROM zzsh_iam.im_consultation_event")) return { rows: [] };
    if (sql.includes("FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o")) {
      return input.pendingOrders
        ? { rows: [{ id: "order_1", account_id: "account_1", game_id: "game_1" }] }
        : { rows: [] };
    }
    if (sql.includes("SELECT status FROM zzsh_order.rental_order")) return { rows: [{ status: "CANCELLED" }] };
    if (sql.includes("FROM zzsh_order.im_order_group WHERE order_id")) return { rows: [{ provision_state: "WAITING" }] };
    if (sql.includes("SELECT id FROM zzsh_supply.rental_account")) return { rows: [] };
    if (sql.includes("SET wait_reason='NO_ELIGIBLE_STAFF'")) return { rows: [] };
    return null;
  });

  return { f, provider, state, operationId, userAccountId, targetAccountId };
}

function closeFixture() {
  const userAccountId = identityFor("USER", "user_a").accountId;
  const state = {
    round: "ACTIVE" as "ACTIVE" | "CLOSED",
    autoAssignCalls: 0,
  };
  const row = () => ({
    id: "consult_2", userId: "user_a", kind: "SERVICE", state: state.round,
    userAccountId, peerAccountId: identityFor("ADMIN", "admin_a").accountId, assignedAdminId: "admin_a", subjectRef: null,
    version: 3, lastMessageAt: null, createdAt: new Date("2026-10-20T00:00:00.000Z"), updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    userName: "用户甲", userUsername: "user_a", adminName: "客服甲", appId: APP_ID,
    messageScopeType: "TEAM", messageScopeId: null, messageScopeState: "PENDING", messageScopeVersion: 1,
    threadId: "thread_1", roundSeq: 2, threadState: "ACTIVE", threadScopeId: null,
    threadScopeState: "PENDING", threadPeerAccountId: identityFor("ADMIN", "admin_a").accountId,
  });
  const f = fakePool((sql, values) => {
    const base = supportBase(sql);
    if (base) return base;
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c') && sql.includes("NOT EXISTS")) {
      state.autoAssignCalls += 1;
      return { rows: [] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation_scope_operation"')) return { rows: [] };
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) return { rows: [row()] };
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation"')) {
      if (sql.includes('"state" = \'CLOSED\'')) { state.round = "CLOSED"; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_support_thread"')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation_event"')) return { rows: [] };
    if (sql.includes("WITH role_permissions AS")) return { rows: [] };
    return null;
  });
  return { f, state };
}

/**
 * createOrResumeUserConsultation fixture: a persistent READY thread whose next
 * round is opened by the create transaction, with the welcome delegated to the
 * supplied transport.
 */
function createConsultationFixture(transport: { sendText: (input: { messageClientId: string; text: string }) => Promise<void> }) {
  const userAccountId = identityFor("USER", "user_a").accountId;
  let round: { id: string; state: string } | null = null;
  let threadState = "IDLE";
  const inserts: Call[] = [];
  const previewUpdates: unknown[][] = [];
  let autoAssignCalls = 0;

  const threadRow = () => ({
    id: "thread_1", appId: APP_ID, userId: "user_a", kind: "SERVICE", state: threadState,
    userAccountId, peerAccountId: null, messageScopeId: "900001", messageScopeState: "READY",
    lastRoundSeq: "1", version: "1",
  });
  const consultationRow = () => ({
    id: round!.id, userId: "user_a", kind: "SERVICE", state: "WAITING",
    userAccountId, peerAccountId: null, assignedAdminId: null, subjectRef: null,
    version: 1, lastMessageAt: new Date("2026-10-20T00:00:00.000Z"), lastMessagePreview: null,
    createdAt: new Date("2026-10-20T00:00:00.000Z"), updatedAt: new Date("2026-10-20T00:00:00.000Z"),
    userName: "用户甲", userUsername: "user_a", adminName: null, appId: APP_ID,
    messageScopeType: "TEAM", messageScopeId: "900001", messageScopeState: "READY", messageScopeVersion: 1,
    threadId: "thread_1", roundSeq: 2, threadState: "WAITING", threadScopeId: "900001",
    threadScopeState: "READY", threadPeerAccountId: null, userReadAt: new Date("2026-10-20T00:00:00.000Z"), adminReadAt: null,
  });

  const f = fakePool((sql, values) => {
    const auth = userAuth(sql, values);
    if (auth) return auth;
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c') && sql.includes("NOT EXISTS")) {
      autoAssignCalls += 1;
      return { rows: [] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_support_thread"') && sql.includes('"kind" = $3')) {
      return { rows: [threadRow()] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation"') && sql.includes('"state" <> \'CLOSED\'')) {
      return { rows: round ? [{ id: round.id, state: round.state }] : [] };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation"')) {
      inserts.push({ sql, values });
      round = { id: String(values[0]), state: "WAITING" };
      return { rows: [] };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_support_thread"') && sql.includes('"state" = \'WAITING\'')) {
      threadState = "WAITING";
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c') && sql.includes('c."user_id" = $3')) {
      return { rows: [consultationRow()] };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation" c') && sql.includes("last_message_preview")) {
      previewUpdates.push(values);
      return { rows: [] };
    }
    return null;
  });
  return { f, inserts, previewUpdates, transport, get autoAssignCalls() { return autoAssignCalls; } };
}

test("automatic reception records ASSIGNED once after membership confirmation",async()=>{
  const fixture=claimFixture({opState:"NEEDS_REVIEW",opTarget:"admin_a",automatic:true});
  const options={pool:fixture.f.pool,appId:APP_ID,provider:fixture.provider,supportManager:managerOptions(fixture.provider)} as never;
  await claimConsultation(options,adminContext("admin_a"),"consult_2","req_auto_fact");
  const events=fixture.f.calls.filter(c=>c.sql.includes('INSERT INTO "zzsh_iam"."im_consultation_event"'));
  const assigned=events.filter(c=>c.values[2]==="ASSIGNED");assert.equal(assigned.length,1);assert.equal(assigned[0]!.values[3],"system");assert.equal(assigned[0]!.values[6],"admin_a");
  await claimConsultation(options,adminContext("admin_a"),"consult_2","req_auto_fact_retry");
  assert.equal(fixture.f.calls.filter(c=>c.sql.includes('INSERT INTO "zzsh_iam"."im_consultation_event"')&&c.values[2]==="ASSIGNED").length,1);
});

test("a later round records REOPENED rather than another first-time creation",async()=>{
  const fixture=createConsultationFixture({sendText:async()=>{}});
  await createOrResumeUserConsultation({pool:fixture.f.pool,appId:APP_ID,provider:{} as never,
    supportManager:managerOptions(new FakeSupportScopeProvider()),messageTransport:{sendText:fixture.transport.sendText}} as never,userContext,"SERVICE",null,"req_reopened_fact");
  const events=fixture.f.calls.filter(c=>c.sql.includes('INSERT INTO "zzsh_iam"."im_consultation_event"'));
  assert.ok(events.some(c=>c.values[2]==="REOPENED"));assert.equal(events.some(c=>c.values[2]==="CREATED"),false);
});
