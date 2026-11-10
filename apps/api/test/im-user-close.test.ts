// SYNTHETIC_COMPONENT_MODEL：真实 consultation 域函数；PG、锁和远端 Team 均为内存替身。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import { closeUserConsultation, parseUserCloseBody } from "../src/im/consultation";

const APP_ID = "provider-test";
const USER_ID = "user_a";
const OP = "support_close_0123456789abcdef";

type QueryResult = { rows: unknown[]; rowCount?: number };

function identityFor(kind: "USER" | "ADMIN", subject: string) {
  const key = { provider: "yunxin" as const, appId: APP_ID, realm: kind === "ADMIN" ? "admin" as const : "user" as const, kind, platformSubjectId: subject };
  return { key, accountId: deriveYunxinAccountId(key), marker: buildYunxinIdentityMarker(key) };
}

function internalOperationId(operationId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([APP_ID, USER_ID, operationId]), "utf8").digest("hex");
  return `im_scope_op_${digest.slice(0, 32)}`;
}

function fixture(options: {
  state?: "WAITING" | "ACTIVE" | "CLOSED";
  messageScopeId?: string | null;
  messageScopeState?: string;
  knownId?: string;
  existingOperation?: { id: string; consultationId: string; operationType: string; state: string } | null;
  closedEvent?: { consultationId: string; operationId: string } | null;
} = {}) {
  let round = options.state ?? "ACTIVE";
  let threadState = round === "ACTIVE" ? "ACTIVE" : round === "WAITING" ? "WAITING" : "IDLE";
  const messageScopeId = options.messageScopeId ?? null;
  const messageScopeState = options.messageScopeState ?? (messageScopeId ? "READY" : "PENDING");
  const userAccountId = identityFor("USER", USER_ID).accountId;
  const adminAccountId = identityFor("ADMIN", "admin_a").accountId;
  const knownId = options.knownId ?? "consult_1";
  const events: Array<{ consultationId: string; eventType: string; actorType: string; actorId: string; details: Record<string, unknown> }> = [];
  const audits: Array<{ actorType: string; actorId: string; action: string; objectId: string; details: Record<string, unknown> }> = [];
  let updates = 0;
  let presenceUpdates = 0;

  const row = (id: string) => ({
    id, userId: USER_ID, kind: "SERVICE", state: round,
    userAccountId, peerAccountId: adminAccountId, assignedAdminId: "admin_a", subjectRef: null,
    version: 3, lastMessageAt: null, lastMessagePreview: null,
    createdAt: new Date("2026-10-20T00:00:00.000Z"), updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    userName: "用户甲", userUsername: USER_ID, adminName: "客服甲", appId: APP_ID,
    messageScopeType: "TEAM", messageScopeId, messageScopeState, messageScopeVersion: 2,
    threadId: "thread_1", roundSeq: 2, threadState, threadScopeId: messageScopeId,
    threadScopeState: messageScopeId ? "READY" : "PENDING", threadPeerAccountId: adminAccountId,
    userReadAt: null, adminReadAt: null, userUnreadCount: 0, adminUnreadCount: 0,
  });
  const thread = () => ({
    id: "thread_1", appId: APP_ID, userId: USER_ID, kind: "SERVICE", state: threadState,
    userAccountId, peerAccountId: adminAccountId, messageScopeId, messageScopeState,
    lastRoundSeq: "2", version: "3",
  });

  const query = async (sql: string, values: unknown[] = []): Promise<QueryResult> => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (sql === "SET LOCAL lock_timeout = '750ms'" || sql.startsWith("SELECT pg_advisory") || sql.includes("set_config")) return { rows: [] };
    if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: false }] };
    if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [] };
    if (sql.includes('FROM "zzsh_auth_user"."session"')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) {
      const identity = identityFor("USER", String(values[3]));
      return { rows: [{ accountId: identity.accountId, identityMarker: identity.marker, status: "READY" }] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation_event" e')) {
      if (!options.closedEvent || options.closedEvent.operationId !== values[2]) return { rows: [] };
      return { rows: [{ consultationId: options.closedEvent.consultationId }] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation_scope_operation"') && sql.includes('WHERE "app_id" = $1 AND "id" = $2')) {
      const operation = options.existingOperation;
      return { rows: operation && operation.id === values[1] ? [operation] : [] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation_scope_operation"') && sql.includes("ORDER BY")) return { rows: [] };
    if (sql.includes('FROM "zzsh_iam"."im_consultation" c')) {
      if (values[0] !== APP_ID || values[1] !== knownId) return { rows: [] };
      return { rows: [row(knownId)] };
    }
    if (sql.includes('FROM "zzsh_iam"."im_support_thread"') && sql.includes('"app_id" = $1 AND "id" = $2')) return { rows: [thread()] };
    if (sql.includes('FROM "zzsh_iam"."im_support_round_rating"')) return { rows: [] };
    if (sql.includes('UPDATE "zzsh_iam"."im_support_presence"')) { presenceUpdates += 1; return { rows: [], rowCount: 1 }; }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation"') && sql.includes("'CLOSED'")) {
      if (round !== "ACTIVE") return { rows: [], rowCount: 0 };
      round = "CLOSED"; updates += 1; return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_support_thread"')) { threadState = "IDLE"; return { rows: [], rowCount: 1 }; }
    if (sql.includes('INSERT INTO "zzsh_iam"."im_consultation_event"')) {
      const details = JSON.parse(String(values[8])) as Record<string, unknown>;
      events.push({
        consultationId: String(values[1]), eventType: String(values[2]), actorType: String(values[3]),
        actorId: String(values[4]), details,
      });
      if (String(values[2]) === "CLOSED" && typeof details.operationId === "string") {
        options.closedEvent = { consultationId: String(values[1]), operationId: details.operationId };
      }
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) {
      audits.push({
        actorType: String(values[1]), actorId: String(values[2]), action: String(values[4]),
        objectId: String(values[6]), details: JSON.parse(String(values[10])) as Record<string, unknown>,
      });
      return { rows: [] };
    }
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return {
    pool, userAccountId,
    get round() { return round; },
    get threadState() { return threadState; },
    get updates() { return updates; },
    get presenceUpdates() { return presenceUpdates; },
    events, audits,
  };
}

function user(userId = USER_ID) {
  return { userId, sessionId: `session_${userId}` } as never;
}

function options(f: ReturnType<typeof fixture>, appId = APP_ID) {
  return { pool: f.pool, appId } as never;
}

test("user close body requires one stable operationId", () => {
  assert.deepEqual(parseUserCloseBody({ operationId: OP }), { operationId: OP });
  for (const body of [undefined, null, {}, { operationId: "short" }, { operationId: `${OP}!` }, { operationId: OP, extra: true }]) {
    assert.throws(() => parseUserCloseBody(body), (error: { status?: number }) => error.status === 400);
  }
});

test("only the round owner in the same App can close; other owners and missing rounds are 404", async () => {
  const otherUser = fixture();
  await assert.rejects(closeUserConsultation(options(otherUser), user("user_b"), "consult_1", OP, "req_1"),
    (error: { status?: number }) => error.status === 404);
  assert.equal(otherUser.updates, 0);

  const otherApp = fixture();
  await assert.rejects(closeUserConsultation(options(otherApp, "other-app"), user(), "consult_1", OP, "req_2"),
    (error: { status?: number }) => error.status === 404);
  assert.equal(otherApp.updates, 0);

  const missing = fixture();
  await assert.rejects(closeUserConsultation(options(missing), user(), "consult_missing", OP, "req_3"),
    (error: { status?: number }) => error.status === 404);
  assert.equal(missing.updates, 0);
});

test("WAITING and already closed rounds return a stable 409 without writes", async () => {
  const waiting = fixture({ state: "WAITING" });
  await assert.rejects(closeUserConsultation(options(waiting), user(), "consult_1", OP, "req_waiting"),
    (error: { status?: number; message?: string }) => error.status === 409 && /等待客服接入/.test(error.message ?? ""));
  assert.equal(waiting.updates, 0);
  assert.equal(waiting.events.length, 0);

  const closed = fixture({ state: "CLOSED" });
  await assert.rejects(closeUserConsultation(options(closed), user(), "consult_1", OP, "req_closed"),
    (error: { status?: number; message?: string }) => error.status === 409 && /已结束/.test(error.message ?? ""));
  assert.equal(closed.updates, 0);
});

test("ACTIVE round closes locally, frees the agent, writes a user CLOSED event and user audit", async () => {
  const f = fixture({ state: "ACTIVE" });
  const result = await closeUserConsultation(options(f), user(), "consult_1", OP, "req_close");
  assert.equal(result.consultation.state, "CLOSED");
  assert.equal(result.consultation.threadState, "IDLE");
  assert.deepEqual(result.consultation.rating, { available: true, submitted: false, dismissed: false, score: null });
  assert.equal(f.updates, 1);
  assert.equal(f.threadState, "IDLE");
  assert.equal(f.presenceUpdates, 1);
  assert.deepEqual(f.events, [{
    consultationId: "consult_1", eventType: "CLOSED", actorType: "user", actorId: USER_ID,
    details: { operationId: OP, local: true },
  }]);
  const closedAudit = f.audits.find((item) => item.action === "im.consultation.closed");
  assert.ok(closedAudit, "closing writes an audit row");
  assert.equal(closedAudit.actorType, "user");
  assert.equal(closedAudit.actorId, USER_ID);
  assert.deepEqual(closedAudit.details, { operationId: OP, local: true });
});

test("same operationId replays the local close without a second write", async () => {
  const f = fixture({ state: "ACTIVE" });
  await closeUserConsultation(options(f), user(), "consult_1", OP, "req_first");
  const updates = f.updates;
  const events = f.events.length;
  const audits = f.audits.length;
  const replay = await closeUserConsultation(options(f), user(), "consult_1", OP, "req_replay");
  assert.equal(replay.consultation.state, "CLOSED");
  assert.equal(f.updates, updates);
  assert.equal(f.events.length, events);
  assert.equal(f.audits.length, audits);
});

test("the same operationId on a different round is a conflict", async () => {
  const f = fixture({ state: "ACTIVE", knownId: "consult_1" });
  await closeUserConsultation(options(f), user(), "consult_1", OP, "req_first");
  const updates = f.updates;
  const second = fixture({ state: "ACTIVE", knownId: "consult_2", closedEvent: { consultationId: "consult_1", operationId: OP } });
  await assert.rejects(closeUserConsultation(options(second), user(), "consult_2", OP, "req_conflict"),
    (error: { status?: number }) => error.status === 409);
  assert.equal(second.updates, 0);
  assert.equal(f.updates, updates);
});

test("a scope operation bound to another round under the same operationId is a conflict", async () => {
  const f = fixture({
    state: "ACTIVE",
    existingOperation: { id: internalOperationId(OP), consultationId: "consult_other", operationType: "ROUND_CLOSE", state: "SUCCEEDED" },
  });
  await assert.rejects(closeUserConsultation(options(f), user(), "consult_1", OP, "req_scope_conflict"),
    (error: { status?: number }) => error.status === 409);
  assert.equal(f.updates, 0);
  assert.equal(f.events.length, 0);
});
