import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../src/app";
import { applyReadCopy, handleReadCopy, mountReadCopyHandler, parseReadCopyEvent, parseReadCopySettings, readCopySettings, READ_COPY_PATH } from "../src/im/read-copy";

const NOW = 1793526400000, APP = "synthetic-read-copy", SECRET = "synthetic-only";
const event = { accountId: "reader", teamId: "9001", readMessageTime: NOW - 1000 };
const body = { eventType: "85", msgType: "1", accid: event.accountId, ackTeamId: event.teamId, ackMsgTime: String(event.readMessageTime) };
const input = { version: 0, enabled: true, publicOrigin: "https://im-dev.example.com/", operationId: "operation_readcopy01" };

function fixture() {
  const state = { settings: null as any, permissions: ["im.support.management.read", "im.support.integration.configure", "im.support.read", "im.support.accept"],
    mapping: { id: "mapping", realm: "user", identity_kind: "USER", platform_subject_id: "user" } as any,
    thread: { id: "thread", user_id: "user", user_account_id: "reader", created_at: new Date(NOW - 10000), round_id: "round" } as any,
    order: null as any, suspended: false, adminStatus: "ACTIVE", reads: 0, writes: 0, commits: 0, rollbacks: 0,
    positions: new Map<string, number>(), syncs: [] as Array<{ sql: string; values: unknown[] }>, audits: 0 };
  const query = async (sql: string, values: any[] = []): Promise<any> => {
    if (sql === "COMMIT") { state.commits++; return { rows: [] }; }
    if (sql === "ROLLBACK") { state.rollbacks++; return { rows: [] }; }
    if (sql.includes('"zzsh_auth_admin"."session"')) return { rows: [{ locked: false, twoFactorEnabled: true, suspended: false }] };
    if (sql.includes('"zzsh_iam"."admin_security"')) return { rows: [{ status: state.adminStatus, isBoss: false, passwordChangeRequired: false }] };
    if (sql.includes("WITH role_permissions")) return { rows: state.permissions.map(permissionCode => ({ permissionCode })) };
    if (sql.includes("pg_try_advisory")) return { rows: [{ locked: true }] };
    if (sql.includes("SELECT") && sql.includes("im_read_copy_settings")) { state.reads++; return { rows: state.settings ? [state.settings] : [] }; }
    if (sql.startsWith("INSERT INTO zzsh_iam.im_read_copy_settings")) {
      state.writes++; state.settings = { version: values[1], enabled: values[2], publicOrigin: values[3], updatedBy: values[4], operationId: values[5],
        updatedAt: new Date(NOW), lastVerifiedAt: null, lastEventAt: null }; return { rows: [state.settings], rowCount: 1 };
    }
    if (sql.includes("UPDATE zzsh_iam.im_read_copy_settings SET")) {
      state.settings[sql.includes("last_verified_at") ? "lastVerifiedAt" : "lastEventAt"] = new Date(NOW); return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { state.audits++; return { rows: [], rowCount: 1 }; }
    if (sql.includes("FROM zzsh_iam.im_identity_mapping")) return { rows: values[0] === APP && values[1] === "reader" && state.mapping ? [state.mapping] : [] };
    if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: state.suspended }] };
    if (sql.includes('FROM zzsh_auth_admin."user"')) return { rows: [{ suspended: state.suspended }] };
    if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [{ accountStatus: "ACTIVE" }] };
    if (sql.startsWith("SELECT") && sql.includes("FROM zzsh_iam.im_support_thread")) return { rows: values[0] === APP && values[1] === "9001" && state.thread ? [state.thread] : [] };
    if (sql.startsWith("SELECT") && sql.includes("FROM zzsh_order.im_order_group")) return { rows: state.order ? [state.order] : [] };
    if (sql.includes('"game_scope_mode"')) return { rows: [{ mode: "SELECTED_GAMES", gameIds: [] }] };
    if (sql.startsWith("INSERT INTO zzsh_iam.im_read_copy_position")) {
      const key = JSON.stringify(values.slice(0, 3)), prior = state.positions.get(key) ?? 0;
      if (prior >= values[5]) return { rows: [], rowCount: 0 };
      state.positions.set(key, values[5]); return { rows: [{ read_message_time: values[5] }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE zzsh_iam.im_") || sql.startsWith("UPDATE zzsh_order.im_order_unread")) {
      state.syncs.push({ sql, values }); return { rows: [], rowCount: 1 };
    }
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    throw new Error("Unexpected synthetic query: " + sql.slice(0, 90));
  };
  const db = { query } as never;
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  return { state, db, pool };
}

test("read-copy settings reject local URLs, credentials, paths and unsupported fields", () => {
  assert.equal(parseReadCopySettings(input).publicOrigin, "https://im-dev.example.com");
  assert.equal(parseReadCopySettings({ ...input, enabled: false, publicOrigin: null }).publicOrigin, null);
  for (const publicOrigin of [null, "http://im.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://im.local", "https://im.internal", "https://me:secret@im.example.com", "https://im.example.com/path", "https://im.example.com?x=1", "https://im.example.com#x"])
    assert.throws(() => parseReadCopySettings({ ...input, publicOrigin }));
  assert.throws(() => parseReadCopySettings({ ...input, appSecret: "secret" }));
  assert.throws(() => parseReadCopySettings({ ...input, version: -1 }));
});

test("85 parser preserves the message-time watermark and rejects P2P, invalid IDs and future times", () => {
  assert.deepEqual(parseReadCopyEvent(body, NOW), event);
  assert.deepEqual(parseReadCopyEvent({ ...body, eventType: 85, msgType: 1, ackMsgTime: event.readMessageTime }, NOW), event);
  for (const wrong of [null, [], { ...body, eventType: 1 }, { ...body, msgType: 0 }, { ...body, ackMsgTime: NOW + 1 },
    { ...body, ackMsgTime: "0" }, { ...body, ackMsgTime: 9007199254740992 }, { ...body, ackTeamId: 9007199254740992 }, { ...body, accid: "bad|account" }])
    assert.throws(() => parseReadCopyEvent(wrong, NOW));
});

test("management configuration uses read/write grants, CAS and original operation identity; saving cannot fake callback proof", async () => {
  const { state, pool } = fixture(), context = { userId: "staff", sessionId: "session" } as never, options = { pool, appId: APP, receiverReady: true };
  const defaults = await readCopySettings(options, context, undefined, "read");
  assert.equal(defaults.enabled, false); assert.equal(defaults.callbackUrl, null); assert.equal(defaults.status, "DISABLED");
  state.permissions = ["im.support.management.read"];
  await assert.rejects(readCopySettings(options, context, input, "write"), { status: 403 }); assert.equal(state.writes, 0);
  state.permissions.push("im.support.configure");
  await assert.rejects(readCopySettings(options, context, input, "welcome-only"), { status: 403 }); assert.equal(state.writes, 0);
  state.permissions.push("im.support.integration.configure");
  await assert.rejects(readCopySettings({ ...options, receiverReady: false }, context, input, "unavailable"), { status: 409 });
  const saved = await readCopySettings(options, context, input, "write");
  assert.equal(saved.status, "WAITING_FOR_CALLBACK"); assert.equal(saved.callbackUrl, "https://im-dev.example.com" + READ_COPY_PATH);
  assert.equal(saved.lastVerifiedAt, null); assert.equal(saved.lastEventAt, null); assert.ok(!JSON.stringify(saved).includes("Secret"));
  assert.equal((await readCopySettings(options, context, input, "retry")).version, 1); assert.equal(state.writes, 1); assert.equal(state.audits, 1);
  await assert.rejects(readCopySettings(options, context, { ...input, enabled: false }, "substitute"), { status: 409 });
  await assert.rejects(readCopySettings(options, context, { ...input, operationId: "operation_readcopy02" }, "stale"), { status: 409 });
  state.permissions = []; await assert.rejects(readCopySettings(options, context, undefined, "read"), { status: 403 });
});

test("a current user's position advances once; duplicates and old copies cannot re-clear newer unread work", async () => {
  const { state, db } = fixture();
  assert.equal(await applyReadCopy(db, APP, event), "APPLIED");
  const count = state.syncs.length;
  assert.equal(await applyReadCopy(db, APP, event), "UNCHANGED");
  assert.equal(await applyReadCopy(db, APP, { ...event, readMessageTime: NOW - 2000 }), "UNCHANGED");
  assert.equal(state.syncs.length, count);
  assert.equal(state.syncs[0]!.values[2], event.readMessageTime);
  assert.match(state.syncs[0]!.sql, /GREATEST\(user_read_at/);
  assert.match(state.syncs[1]!.sql, /last_message_at<=to_timestamp/);
  assert.ok(!state.syncs.some(s => /version=|first_response|updated_at=/.test(s.sql)));
});

test("wrong App, unknown or SYSTEM identities, frozen users and unrelated threads never move a read pointer", async () => {
  for (const variant of ["app", "missing", "system", "suspended", "other-user", "other-account", "early"] as const) {
    const { state, db } = fixture();
    if (variant === "missing") state.mapping = null;
    if (variant === "system") state.mapping = { ...state.mapping, realm: "system", identity_kind: "SYSTEM" };
    if (variant === "suspended") state.suspended = true;
    if (variant === "other-user") state.thread.user_id = "other";
    if (variant === "other-account") state.thread.user_account_id = "other";
    if (variant === "early") state.thread.created_at = new Date(NOW);
    assert.equal(await applyReadCopy(db, variant === "app" ? "other-app" : APP, event), "IGNORED", variant);
    assert.equal(state.positions.size + state.syncs.length, 0);
  }
});

test("admin receipts require current assignment and active support permissions; order receipts also require game scope", async () => {
  const { state, db } = fixture(); state.mapping = { ...state.mapping, realm: "admin", identity_kind: "ADMIN", platform_subject_id: "staff" };
  state.thread.round_id = null; assert.equal(await applyReadCopy(db, APP, event), "IGNORED");
  state.thread.round_id = "round"; state.permissions = []; assert.equal(await applyReadCopy(db, APP, event), "IGNORED");
  state.permissions = ["im.support.read", "im.support.accept"];
  assert.equal(await applyReadCopy(db, APP, event), "APPLIED");
  assert.match(state.syncs[0]!.sql, /assigned_admin_id=\$5 AND peer_account_id=\$7/);
  assert.match(state.syncs[0]!.sql, /GREATEST\(admin_read_at,to_timestamp/);
  const order = fixture(); order.state.thread = null; order.state.mapping = state.mapping;
  order.state.order = { order_id: "order", party: "STAFF", game_id: "other-game" };
  assert.equal(await applyReadCopy(order.db, APP, event), "IGNORED"); assert.equal(order.state.positions.size, 0);
});

function signed(raw: string, curtime = String(NOW)) {
  const md5 = createHash("md5").update(raw).digest("hex");
  return { appkey: APP, curtime, md5, checksum: createHash("sha1").update(SECRET + md5 + curtime).digest("hex") };
}
test("real HTTP parser preserves signed bytes; probes, bad signatures, disabled ingress and storage failures have distinct outcomes", async () => {
  const { state, pool } = fixture();
  state.settings = { ...input, publicOrigin: "https://im-dev.example.com", updatedBy: "staff", updatedAt: new Date(NOW), lastVerifiedAt: null, lastEventAt: null };
  const app = await createApp({ health: { dependencies: {
    postgres: { check: async () => undefined, close: async () => undefined }, redis: { check: async () => undefined, close: async () => undefined } } }, logSink: { write() {} } });
  mountReadCopyHandler(app, { pool, appId: APP, appSecret: SECRET, now: () => NOW });
  await app.listen(0, "127.0.0.1");
  try {
    const base = await app.getUrl();
    const send = (raw: string, headers = signed(raw), path = READ_COPY_PATH) => fetch(base + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: raw || undefined });
    assert.equal((await send("", { ...signed(""), checksum: "0".repeat(40) })).status, 403); assert.equal(state.reads, 0);
    assert.equal((await send("", signed("", String(NOW - 400000)))).status, 403);
    assert.equal((await send("{}")).status, 200); assert.ok(state.settings.lastVerifiedAt); assert.equal(state.settings.lastEventAt, null); assert.equal(state.positions.size, 0);
    assert.equal((await send("")).status, 200);
    const raw = JSON.stringify(body, null, 2);
    assert.equal((await send(raw)).status, 200); assert.equal(state.positions.size, 1); assert.ok(state.settings.lastEventAt);
    assert.equal((await send(raw)).status, 200); assert.equal(state.positions.size, 1);
    assert.equal((await send(raw, { ...signed(raw), appkey: "other" })).status, 403);
    assert.equal((await send("{")).status, 400); assert.equal((await send(JSON.stringify({ ...body, msgType: 0 }))).status, 400);
    state.settings.enabled = false; assert.equal((await send(raw)).status, 503); assert.equal((await send("{}")).status, 503);
    assert.equal((await send(raw, signed(raw), READ_COPY_PATH + "?x=1")).status, 404);
    assert.equal((await fetch(base + READ_COPY_PATH)).status, 404);
    assert.equal((await send("x".repeat(102401))).status, 413);
  } finally { await app.close(); }
  const broken = { connect: async () => { throw new Error("db unavailable"); } } as unknown as Pool;
  let code = 0; const response: any = { status(n: number) { code = n; return this; }, setHeader() { return this; }, json() {} };
  await handleReadCopy({ method: "POST", originalUrl: READ_COPY_PATH, headers: signed("{}"), rawBody: Buffer.from("{}") } as never, response, { pool: broken, appId: APP, appSecret: SECRET, now: () => NOW });
  assert.equal(code, 503);
});
