// Offline handler/SQL-contract tests. No PG, live HTTP, Owner session, or sensitive command is used.
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { types as pgTypes, type Pool, type PoolClient } from "pg";
import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import { type AuthSecurityOptions } from "../src/auth/auth-security";
import { handleAdminSelfSettingsRoute, mountAdminSelfSettingsHandlers, SELF_ACTIVITY_READABLE_ACTIONS, SELF_ACTIVITY_RECORDED_ACTIONS, SELF_ACTIVITY_NOT_RECORDED } from "../src/auth/admin-self-settings";
import { withDirectoryRead } from "../src/auth/user-directory-read";

const SELF = "admin_one", OTHER = "admin_two", CURRENT = "session_one";
const ORIGIN = "http://127.0.0.1:4301", API = "http://127.0.0.1:4302";
const COOKIE = "zzsh_admin.session_token=offline_admin";
const PATHS = ["/profile", "/sessions", "/security-activity"];
const NOW = new Date("2026-10-15T12:00:00Z");
type User = { id: string; username: string | null; displayUsername: string | null; name: string; image: string | null; updatedAt: Date; suspended: boolean; twoFactorEnabled: boolean };
type Session = { id: string; userId: string; createdAt: Date; expiresAt: Date; userAgent: string | null; locked: boolean };
type Audit = { id: string; actorType: string; actorId: string | null; objectType: string; objectId: string | null; action: string; occurredAt: string; details: Record<string, unknown>; reason: string | null; outcome: string; requestId: string | null };
function micros(value: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value)!;
  return BigInt(Date.parse(m[1]! + "Z")) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}
function audit(overrides: Partial<Audit> = {}): Audit {
  return { id: "audit_x", actorType: "admin", actorId: SELF, objectType: "admin_session", objectId: CURRENT, action: "admin.pin.set", occurredAt: "2026-10-15T12:00:00.000501Z", details: {}, reason: null, outcome: "SUCCESS", requestId: "req_event", ...overrides };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
class Fixture {
  users = new Map<string, User>([SELF, OTHER].map((id, i) => [id, { id, username: `zz0000${i + 1}`, displayUsername: `ZZ0000${i + 1}`, name: `离线管理员${i}`, image: null, updatedAt: NOW, suspended: false, twoFactorEnabled: true }]));
  sessions = new Map<string, Session>();
  audits: Audit[] = [];
  queries: { handle: string; sql: string; values: unknown[] }[] = [];
  releases: boolean[] = [];
  clients: EventEmitter[] = [];
  status = "ACTIVE";
  snapshotLocked = false;
  securityMissing = false;
  sdkHeaders: Headers[] = [];
  onAuthentication?: () => void;
  beforeSql?: (sql: string, values: unknown[], emitter: EventEmitter) => Promise<void>;
  leaseState: "I" | "T" | "E" | null = "I";
  rollbackError?: Error;
  connectError?: Error;
  connectWait?: Promise<void>;
  constructor() {
    for (const [id, userId, age, valid] of [[CURRENT, SELF, 3, true], ["session_two", SELF, 2, true], ["session_three", SELF, 1, true], ["expired", SELF, 4, false], ["foreign", OTHER, 0, true]] as const) {
      this.sessions.set(id, { id, userId, createdAt: new Date(NOW.getTime() - age * 1000), expiresAt: new Date(Date.now() + (valid ? 86400000 : -86400000)), userAgent: id === CURRENT ? "Offline UA" : null, locked: id === "session_three" });
    }
  }
  readonly pool = {
    query: async (sql: string, values: unknown[] = []) => this.query("pool", sql, values),
    connect: async () => {
      if (this.connectError) throw this.connectError;
      if (this.connectWait) await this.connectWait;
      const emitter = new EventEmitter(); this.clients.push(emitter);
      let state = this.leaseState;
      return Object.assign(emitter, {
        getTransactionStatus: () => state,
        query: async (sql: string, values: unknown[] = []) => {
          this.queries.push({ handle: "client", sql, values });
          if (this.beforeSql) await this.beforeSql(sql, values, emitter);
          if (sql === "ROLLBACK" && this.rollbackError) throw this.rollbackError;
          if (sql === "BEGIN READ ONLY") state = "T";
          if (sql === "ROLLBACK") state = "I";
          return this.query("recorded-client", sql, values);
        },
        release: (destroy: boolean) => this.releases.push(destroy),
      }) as unknown as PoolClient;
    },
  } as unknown as Pool;
  readonly options = {
    pool: this.pool, apiOrigin: API, adminOrigin: ORIGIN, userOrigin: "http://127.0.0.1:4300",
    adminAuth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      this.sdkHeaders.push(headers);
      if (!headers.get("cookie")?.includes(COOKIE) && headers.get("authorization") !== "Bearer offline_admin") return null;
      const s = this.sessions.get(CURRENT), u = s ? this.users.get(s.userId) : undefined;
      if (!s || !u || s.expiresAt.getTime() <= Date.now()) return null;
      const snapshot = { user: { ...u }, session: { ...s, locked: this.snapshotLocked } };
      this.onAuthentication?.(); return snapshot;
    } } },
  } as unknown as AuthSecurityOptions;
  private async query(handle: string, sql: string, values: unknown[]) {
    if (handle !== "recorded-client") this.queries.push({ handle, sql, values });
    const q = sql.replace(/\s+/g, " ").trim(), rows = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    assert(!/admin_security_command|admin_backup_code_generation|admin_(permission|role)|FOR UPDATE|COMMIT|INSERT |UPDATE |DELETE |CREATE |ALTER /i.test(q), "read entered a writer, initialization, or global permission path");
    if (q === "BEGIN READ ONLY" || q === "ROLLBACK" || q.startsWith("SELECT set_config")) return rows([]);
    if (q.startsWith('SELECT "status", "is_boss"')) { assert.deepEqual(values, [SELF]); return rows(this.securityMissing ? [] : [{ status: this.status, isBoss: false, passwordChangeRequired: false }]); }
    if (q.startsWith('SELECT s."locked"')) {
      assert.deepEqual(values, [CURRENT, SELF]); const s = this.sessions.get(CURRENT), u = this.users.get(SELF);
      return rows(s?.userId === SELF && s.expiresAt.getTime() > Date.now() && u ? [{ locked: s.locked, twoFactorEnabled: u.twoFactorEnabled }] : []);
    }
    if (q.startsWith('SELECT "id", "username"')) { assert.deepEqual(values, [SELF]); const u = this.users.get(SELF); return rows(u ? [{ ...u }] : []); }
    if (q.startsWith('SELECT "id", "createdAt"')) {
      assert.deepEqual(values, [SELF]); assert.match(q, /WHERE "userId" = \$1 AND "expiresAt" > clock_timestamp\(\) ORDER BY "createdAt" DESC, "id" LIMIT 101$/);
      return rows([...this.sessions.values()].filter(s => s.userId === SELF && s.expiresAt.getTime() > Date.now()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 101));
    }
    if (q.startsWith('SELECT e."id"')) return this.activity(q, values);
    assert.fail("Unrecognized read SQL: " + q);
  }
  private activity(sql: string, values: unknown[]) {
    assert.deepEqual(values[0], SELF);
    assert.match(sql, /e\."object_type" = CASE WHEN e\."action" IN/);
    assert.match(sql, /e\."object_type" = 'admin_recovery_request' AND/);
    assert.match(sql, /to_char\(e\."occurred_at" AT TIME ZONE 'UTC'/);
    assert.match(sql, /WHERE .* ORDER BY e\."occurred_at" DESC, e\."id" DESC LIMIT \$5$/);
    const actors = values[1] as string[], targets = values[2] as string[], recovery = values[3] as string[];
    const param = (pattern: RegExp) => { const m = pattern.exec(sql); return m ? String(values[Number(m[1]) - 1]) : undefined; };
    const action = param(/e\."action" = \$(\d+)/), from = param(/e\."occurred_at" >= \$(\d+)/), to = param(/e\."occurred_at" <= \$(\d+)/);
    const cursor = param(/e\."occurred_at" < \$(\d+)::/), cursorId = param(/e\."id" < \$(\d+)/);
    const selected = this.audits.filter(a => {
      const objectType = ["admin.frozen", "admin.unfrozen", "admin.enrollment.activated"].includes(a.action) ? "admin_security" : "admin_user";
      return (["admin", "admin_recovery_target"].includes(a.actorType) && a.actorId === SELF && actors.includes(a.action))
        || (a.objectType === objectType && a.objectId === SELF && targets.includes(a.action))
        || (a.objectType === "admin_recovery_request" && recovery.includes(a.action) && a.details.targetAdminId === SELF);
    }).filter(a => !action || a.action === action).filter(a => !from || micros(a.occurredAt) >= micros(from)).filter(a => !to || micros(a.occurredAt) <= micros(to))
      .filter(a => !cursor || micros(a.occurredAt) < micros(cursor) || (micros(a.occurredAt) === micros(cursor) && a.id < cursorId!))
      .sort((a, b) => micros(a.occurredAt) === micros(b.occurredAt) ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : micros(a.occurredAt) < micros(b.occurredAt) ? 1 : -1).slice(0, Number(values[4]));
    return { rows: selected.map(a => { const actor = ["admin", "admin_recovery_target"].includes(a.actorType) && a.actorId ? this.users.get(a.actorId) : undefined; return { ...a, eventId: a.id, occurredAt: new Date(Number(micros(a.occurredAt) / 1000n)), occurredAtExact: a.occurredAt, actorUsername: actor?.username ?? null, actorDisplayUsername: actor?.displayUsername ?? null }; }) };
  }
}
function capture() {
  const state = { status: 0, body: undefined as any, headers: {} as Record<string, unknown> };
  const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false, headersSent: false,
    setHeader(name: string, value: unknown) { state.headers[name.toLowerCase()] = value; return response; },
    status(status: number) { state.status = status; return response; },
    json(body: unknown) { state.body = body; response.headersSent = true; response.writableFinished = true; response.emit("close"); },
  });
  return { state, response };
}
type RouteOptions = { method?: string; headers?: Record<string, string | undefined>; body?: unknown; originalUrl?: string; aborted?: boolean; destroyed?: boolean };
function invoke(f: Fixture, path: string, bff = false, input: RouteOptions = {}) {
  const { state, response } = capture(); response.destroyed = input.destroyed === true;
  const url = input.originalUrl ?? (bff ? "/api/bff/admin/self" : "/api/v1/admin/self") + path;
  const request = Object.assign(new EventEmitter(), { method: input.method ?? "GET", url, originalUrl: url, aborted: input.aborted === true, body: input.body, headers: { origin: ORIGIN, cookie: COOKIE, "x-request-id": "req_offline", ...input.headers } });
  Object.defineProperty(request, "aborted", { value: input.aborted === true, enumerable: false });
  const pending = bff ? handleAdminBff(request as never, response, { adminOrigin: ORIGIN, apiOrigin: API, adminSecurityOptions: f.options } as AdminBffOptions) : handleAdminSelfSettingsRoute(request as never, response, f.options);
  return { pending, request, response, state };
}
async function read(f: Fixture, path: string, bff = false, input: RouteOptions = {}) { const r = invoke(f, path, bff, input); await r.pending; assert.equal(r.request.listenerCount("aborted"), 0); assert.equal(r.response.listenerCount("close"), 0); return r.state; }
function failure(result: Awaited<ReturnType<typeof read>>, status: number, reason?: string) {
  assert.equal(result.status, status, JSON.stringify(result.body)); if (reason) assert.equal(result.body.error.reason, reason);
  assert.equal(result.headers["cache-control"], "no-store"); assert.equal(result.headers["x-request-id"], "req_offline");
}

test("ordinary admin reads all three DTOs through direct and BFF with no permission/init/new-table queries", async () => {
  for (const bff of [false, true]) {
    const f = new Fixture(); const before = structuredClone([f.users, f.sessions, f.audits]);
    const profile = await read(f, "/profile?adminUserId=admin_two", bff, { body: { userId: OTHER } });
    assert.equal(profile.status, 200); assert.deepEqual(profile.body, { adminUserId: SELF, zzNumber: "ZZ00001", displayName: "离线管理员0", avatarUrl: null, updatedAt: NOW.toISOString() });
    const sessions = await read(f, "/sessions", bff); assert.equal(sessions.status, 200);
    assert.deepEqual(sessions.body.sessions.map((s: any) => s.id), ["session_three", "session_two", CURRENT]);
    assert.equal(sessions.body.sessions.find((s: any) => s.id === CURRENT).isCurrent, true);
    const activity = await read(f, "/security-activity", bff); assert.equal(activity.status, 200); assert.deepEqual(activity.body.events, []); assert.equal(activity.body.nextCursor, null);
    assert.deepEqual(activity.body.coverage, { scope: "SELF_SECURITY_ACTIVITY", recordedActions: SELF_ACTIVITY_RECORDED_ACTIONS, notRecorded: SELF_ACTIVITY_NOT_RECORDED });
    assert.deepEqual([f.users, f.sessions, f.audits], before); assert.deepEqual(f.releases, [false, false, false]);
    assert.equal(f.queries.filter(q => q.sql === "ROLLBACK").length, 3); assert.equal(f.queries.filter(q => q.handle === "pool").length, 3);
    const clientQueries = f.queries.filter(q => q.handle === "client"); assert.equal(clientQueries[0]!.sql, "BEGIN READ ONLY"); assert.match(clientQueries[1]!.sql, /statement_timeout','3000'.*lock_timeout','500'/);
  }
});
test("profile uses actual username fallback or null, never invents an internal-ID ZZ number", async () => {
  const f = new Fixture(), u = f.users.get(SELF)!; u.displayUsername = " "; assert.equal((await read(f, "/profile")).body.zzNumber, "ZZ00001"); u.username = null; assert.equal((await read(f, "/profile")).body.zzNumber, null);
});
test("sessions expose only permitted fields, truncate UA, retain locked valid rows and reject capacity 101", async () => {
  for (const bff of [false, true]) {
    const f = new Fixture(); f.sessions.get(CURRENT)!.userAgent = "x".repeat(600);
    Object.assign(f.sessions.get(CURRENT)!, { token: "private_token", ipAddress: "private_ip", pinHash: "private_pin" });
    const first = await read(f, "/sessions", bff); const own = first.body.sessions.find((s: any) => s.id === CURRENT);
    assert.deepEqual(Object.keys(own).sort(), ["createdAt", "expiresAt", "id", "isCurrent", "locked", "userAgent"]); assert.equal(own.userAgent.length, 512); assert(!JSON.stringify(first.body).includes("private_"));
    for (let i = 3; i < 100; i++) f.sessions.set("extra_" + i, { ...f.sessions.get(CURRENT)!, id: "extra_" + i });
    const full = await read(f, "/sessions", bff); assert.equal(full.status, 200); assert.equal(full.body.sessions.length, 100); assert.equal(full.body.sessions.filter((s: any) => s.isCurrent).length, 1);
    f.sessions.set("one_over", { ...f.sessions.get(CURRENT)!, id: "one_over" }); const over = await read(f, "/sessions", bff); failure(over, 503, "session_list_limit_exceeded"); assert.equal(over.body.sessions, undefined); assert.equal(f.queries.at(-1)!.sql, "ROLLBACK");
  }
});
test("one current session is a complete one-row list, never an empty-device success", async () => {
  for (const bff of [false, true]) { const f = new Fixture(); for (const id of ["session_two", "session_three"]) f.sessions.delete(id); const r = await read(f, "/sessions", bff); assert.equal(r.status, 200); assert.equal(r.body.sessions.length, 1); assert.equal(r.body.sessions[0].id, CURRENT); assert.equal(r.body.sessions[0].isCurrent, true); }
});
test("all reads reject anonymous, expired/revoked, user realm, frozen, enrollment, no-2FA, locked and suspended", async () => {
  for (const bff of [false, true]) for (const path of PATHS) {
    for (const scenario of ["anonymous", "user", "expired", "revoked", "frozen", "pending", "2fa", "locked", "suspended", "security_missing"] as const) {
      const f = new Fixture(); const headers: Record<string, string | undefined> = {};
      if (scenario === "anonymous") headers.cookie = undefined;
      if (scenario === "user") headers.cookie = "zzsh_user.session_token=offline_user";
      if (scenario === "expired") f.sessions.get(CURRENT)!.expiresAt = new Date(0);
      if (scenario === "revoked") f.sessions.delete(CURRENT);
      if (scenario === "frozen") f.status = "FROZEN";
      if (scenario === "pending") f.status = "PENDING_ENROLLMENT";
      if (scenario === "2fa") f.users.get(SELF)!.twoFactorEnabled = false;
      if (scenario === "locked") f.snapshotLocked = true;
      if (scenario === "suspended") f.users.get(SELF)!.suspended = true;
      if (scenario === "security_missing") f.securityMissing = true;
      const status = scenario === "locked" ? 423 : ["pending", "2fa", "security_missing"].includes(scenario) ? 403 : 401;
      failure(await read(f, path, bff, { headers }), status);
      if (scenario !== "suspended") assert.equal(f.clients.length, 0);
    }
  }
});
test("transaction rechecks own existence/suspension/session/ACTIVE/2FA/lock after successful SDK snapshot", async () => {
  for (const bff of [false, true]) for (const path of PATHS) for (const scenario of ["missing_user", "suspended", "revoked", "expired", "frozen", "pending", "2fa", "locked"] as const) {
    const f = new Fixture(); f.beforeSql = async sql => {
      if (sql !== "BEGIN READ ONLY") return;
      if (scenario === "missing_user") f.users.delete(SELF);
      if (scenario === "suspended") f.users.get(SELF)!.suspended = true;
      if (scenario === "revoked") f.sessions.delete(CURRENT);
      if (scenario === "expired") f.sessions.get(CURRENT)!.expiresAt = new Date(0);
      if (scenario === "frozen") f.status = "FROZEN";
      if (scenario === "pending") f.status = "PENDING_ENROLLMENT";
      if (scenario === "2fa") f.users.get(SELF)!.twoFactorEnabled = false;
      if (scenario === "locked") f.sessions.get(CURRENT)!.locked = true;
    };
    failure(await read(f, path, bff), scenario === "locked" ? 423 : ["pending", "2fa"].includes(scenario) ? 403 : 401);
    assert.deepEqual(f.releases, [false]); assert.equal(f.queries.at(-1)!.sql, "ROLLBACK"); assert(!f.queries.some(q => q.sql.includes('SELECT e."id"') || q.sql.includes('SELECT "id", "createdAt"')));
  }
});
test("BFF filters user cookies, rejects Authorization/Origin and preserves query and requestId", async () => {
  const f = new Fixture(); assert.equal((await read(f, "/profile", true, { headers: { cookie: "zzsh_user.session_token=user_private; " + COOKIE } })).status, 200);
  assert.equal(f.sdkHeaders[0]!.get("cookie"), COOKIE);
  for (const path of PATHS) {
    failure(await read(new Fixture(), path, true, { headers: { authorization: "Bearer offline_admin" } }), 400);
    failure(await read(new Fixture(), path, true, { headers: { origin: API } }), 403);
    for (const bff of [false, true]) failure(await read(new Fixture(), path, bff, { headers: { origin: "https://untrusted.invalid" } }), 403);
    assert.equal((await read(new Fixture(), path, true, { headers: { origin: undefined } })).status, 200);
  }
  const direct = await read(new Fixture(), "/profile", false, { headers: { cookie: undefined, authorization: "Bearer offline_admin" } }); assert.equal(direct.status, 200);
  failure(await read(new Fixture(), "/profile", false, { headers: { authorization: "Bearer offline_admin" } }), 400);
  failure(await read(new Fixture(), "/profile", false, { headers: { cookie: undefined, authorization: "Bearer offline_user" } }), 401);
  failure(await read(new Fixture(), "/profile", false, { headers: { cookie: undefined, authorization: "Basic malformed" } }), 400);
});
test("only three exact GET paths enter R0; write/HEAD/OPTIONS/encoded/case/tail/neighbor paths never authenticate", async () => {
  for (const bff of [false, true]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) for (const path of PATHS) { const f = new Fixture(); failure(await read(f, path, bff, { method }), 404); assert.equal(f.sdkHeaders.length, 0); }
    for (const path of ["/profile/", "/%70rofile", "/profile%2f", "/Profile", "/profile/extra", "/sessions/revoke", "/sessions/revoke-others", "/security-activity/", "/../self/profile"]) { const f = new Fixture(); failure(await read(f, path, bff), 404); assert.equal(f.sdkHeaders.length, 0); }
    for (const url of ["/api/v1/admin/selfish/profile", "/api/bff/admin/%73elf/profile", "/api/bff/admin/self%2fprofile"]) { const f = new Fixture(); failure(await read(f, "/profile", bff, { originalUrl: url }), 404); assert.equal(f.sdkHeaders.length, 0); }
  }
});
test("activity filters own actor/typed target/recovery before pagination, with safe details and actor projections", async () => {
  for (const bff of [false, true]) {
    const f = new Fixture(); f.audits = [
      audit({ id: "own", action: "admin.password.changed", details: { revokedSessionCount: 4, token: "PRIVATE", before: "PRIVATE" } }),
      audit({ id: "target", actorId: OTHER, action: "admin.frozen", objectType: "admin_security", objectId: SELF, reason: "x".repeat(400) }),
      audit({ id: "recovery", actorId: OTHER, action: "admin.recovery.issued", objectType: "admin_recovery_request", details: { targetAdminId: SELF, token: "PRIVATE" } }),
      audit({ id: "maintenance", actorType: "maintenance", actorId: OTHER, action: "admin.recovery.disaster.issued", objectType: "admin_recovery_request", details: { targetAdminId: SELF } }),
      audit({ id: "foreign", actorId: OTHER, objectId: OTHER }), audit({ id: "collision", actorId: OTHER, objectId: SELF, action: "admin.account.updated", objectType: "order" }),
      audit({ id: "wrong_realm", actorType: "user", actorId: SELF }), audit({ id: "not_allowed", action: "admin.order.read" }), audit({ id: "wrong_recovery_type", actorId: OTHER, objectType: "order", action: "admin.recovery.issued", details: { targetAdminId: SELF } }),
    ];
    const r = await read(f, "/security-activity?limit=2", bff); assert.equal(r.status, 200); assert.deepEqual(r.body.events.map((e: any) => e.eventId), ["target", "recovery"]);
    assert.deepEqual(r.body.events[0].actor, { kind: "other", ref: "ZZ00002" }); assert.equal(r.body.events[0].reason.length, 256); assert.deepEqual(r.body.events[1].details, {});
    const next = await read(f, "/security-activity?limit=2&cursor=" + r.body.nextCursor, bff); assert.deepEqual(next.body.events.map((e: any) => e.eventId), ["own", "maintenance"]); assert.equal(next.body.nextCursor, null);
    assert.deepEqual(next.body.events[0].details, { revokedSessionCount: 4 }); assert.deepEqual(next.body.events[0].actor, { kind: "self", ref: null }); assert.deepEqual(next.body.events[1].actor, { kind: "system", ref: null });
    assert(!JSON.stringify([r.body, next.body]).includes("PRIVATE")); assert(!JSON.stringify([r.body.events, next.body.events]).includes(OTHER));
    assert(SELF_ACTIVITY_READABLE_ACTIONS.includes("admin.password.changed")); assert(next.body.coverage.recordedActions.includes("admin.password.changed")); assert(!next.body.coverage.recordedActions.includes("admin.self.sessions.revoked")); assert(next.body.coverage.notRecorded.includes("sign_in"));
  }
});
test("activity projects each whitelisted details shape without raw JSON or credential fields", async () => {
  const f = new Fixture(); const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["admin.backup_codes.generated", { generation: 2, codeCount: 10, codes: ["PRIVATE"] }, { generation: 2, codeCount: 10 }],
    ["admin.pin.change", { pinFailures: 2, locked: true, pin: "PRIVATE" }, { pinFailures: 2, locked: true }],
    ["admin.pin.unlock", { pinFailures: "bad", locked: false }, { locked: false }],
    ["admin.self.sessions.revoked", { scope: "others", revokedSessionCount: 2, sessionIds: ["PRIVATE"] }, { scope: "others", revokedSessionCount: 2 }],
    ["admin.session.force_logged_out", { revokedSessions: 3, targetAdminId: "PRIVATE" }, { revokedSessions: 3 }],
  ];
  for (const [action, details, expected] of cases) { f.audits = [audit({ action, details, objectType: "admin_user", objectId: SELF })]; const r = await read(f, "/security-activity"); assert.deepEqual(r.body.events[0].details, expected); assert(!JSON.stringify(r.body).includes("PRIVATE")); }
});
test("microsecond and equal-time ID cursors neither repeat nor omit rows across both entries", async () => {
  const parsePgTime = pgTypes.getTypeParser(1184, "text"); assert.equal(parsePgTime("2026-10-15 12:00:00.000501+00").getTime(), parsePgTime("2026-10-15 12:00:00.000502+00").getTime());
  for (const bff of [false, true]) {
    const f = new Fixture(); f.audits = [audit({ id: "c", occurredAt: "2026-10-15T12:00:00.000502Z" }), audit({ id: "b", occurredAt: "2026-10-15T12:00:00.000502Z" }), audit({ id: "z", occurredAt: "2026-10-15T12:00:00.000501Z" })];
    const seen: string[] = []; let cursor: string | null = null;
    do { const r = await read(f, "/security-activity?limit=1" + (cursor ? "&cursor=" + cursor : ""), bff); assert.equal(r.status, 200); seen.push(...r.body.events.map((e: any) => e.eventId)); cursor = r.body.nextCursor; if (cursor) assert.equal(JSON.parse(Buffer.from(cursor, "base64url").toString()).occurredAt, "2026-10-15T12:00:00.000502Z"); } while (cursor && seen.length < 5);
    assert.deepEqual(seen, ["c", "b", "z"]);
    const q = f.queries.filter(q => q.sql.startsWith('SELECT e."id"')); assert.equal(q[1]!.values.at(-2), "2026-10-15T12:00:00.000502Z");
  }
});
test("action and inclusive microsecond time filters run before limit/cursor", async () => {
  for (const bff of [false, true]) {
    const f = new Fixture(); f.audits = [audit({ id: "a", occurredAt: "2026-10-15T12:00:00.000501Z" }), audit({ id: "b", occurredAt: "2026-10-15T12:00:00.000502Z" }), audit({ id: "c", action: "admin.pin.change", occurredAt: "2026-10-15T12:00:00.000502Z" })];
    const r = await read(f, "/security-activity?limit=1&action=admin.pin.set&from=2026-10-15T12%3A00%3A00.000502Z&to=2026-10-15T12%3A00%3A00.000502Z", bff); assert.equal(r.status, 200); assert.deepEqual(r.body.events.map((e: any) => e.eventId), ["b"]); assert.equal(r.body.nextCursor, null);
    failure(await read(f, "/security-activity?from=2026-10-15T12%3A00%3A00.000502Z&to=2026-10-15T12%3A00%3A00.000501Z", bff), 400, "time_range_invalid");
  }
});
test("invalid calendar/cursor/limits/actions are controlled failures and do not start DB transactions", async () => {
  for (const bff of [false, true]) {
    for (const time of ["2026-02-30T12:00:00.000001Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "0000-01-01T00:00:00Z", "2026-10-15T12:00:00.0000001Z"]) {
      const f = new Fixture(), cursor = Buffer.from(JSON.stringify({ occurredAt: time, id: "audit_1" })).toString("base64url"); failure(await read(f, "/security-activity?cursor=" + cursor, bff), 400, "cursor_invalid"); failure(await read(f, "/security-activity?from=" + encodeURIComponent(time), bff), 400, "time_filter_invalid"); assert.equal(f.clients.length, 0);
    }
    for (const id of ["", "x".repeat(129), "audit_\u0000", "audit_\u0080"]) { const cursor = Buffer.from(JSON.stringify({ occurredAt: "2026-10-15T12:00:00.000001Z", id })).toString("base64url"); failure(await read(new Fixture(), "/security-activity?cursor=" + cursor, bff), 400, "cursor_invalid"); }
    for (const query of ["limit=0", "limit=51", "limit=1.5", "limit=NaN", "action=admin.order.read", "cursor=malformed", "cursor=" + "x".repeat(257)]) failure(await read(new Fixture(), "/security-activity?" + query, bff), 400);
    const f = new Fixture(); assert.equal((await read(f, "/security-activity?limit=50", bff)).status, 200); assert.equal(f.queries.find(q => q.sql.startsWith('SELECT e."id"'))!.values[4], 51);
  }
});
test("request abort/response close during read holds the lease until SQL ends, then rolls back with no late response", async () => {
  for (const bff of [false, true]) for (const event of ["aborted", "close"] as const) {
    const f = new Fixture(), started = deferred(), finish = deferred(); f.beforeSql = async sql => { if (sql.startsWith('SELECT s."locked"')) { started.resolve(); await finish.promise; } };
    const r = invoke(f, "/sessions", bff); await started.promise; if (event === "close") r.response.emit("close"); else r.request.emit("aborted");
    assert.equal(f.releases.length, 0); finish.resolve(); await r.pending; assert.deepEqual(f.releases, [false]); assert.equal(f.queries.at(-1)!.sql, "ROLLBACK"); assert(!f.queries.some(q => q.sql.startsWith('SELECT "id", "createdAt"'))); assert.equal(r.state.body, undefined); assert.equal(r.request.listenerCount("aborted"), 0); assert.equal(r.response.listenerCount("close"), 0); assert.equal(f.clients[0]!.listenerCount("error"), 0);
  }
});
test("normal finished close is not a cancellation; disconnected authentication never borrows a client", async () => {
  for (const bff of [false, true]) {
    const f = new Fixture(); const r = invoke(f, "/profile", bff); f.beforeSql = async sql => { if (sql === "BEGIN READ ONLY") { r.response.writableFinished = true; r.response.emit("close"); } }; await r.pending; assert.equal(r.state.status, 200);
    const other = new Fixture(), auth = deferred(); const api = (other.options.adminAuth.api as any), original = api.getSession;
    api.getSession = async (v: any) => { await auth.promise; return original(v); }; const stopped = invoke(other, "/profile", bff); stopped.request.emit("aborted"); auth.resolve(); await stopped.pending; assert.equal(other.clients.length, 0); assert.equal(stopped.state.body, undefined);
  }
});
test("abort during acquisition destroys a late lease without BEGIN", async () => {
  for (const bff of [false, true]) { const f = new Fixture(), wait = deferred(), authenticated = deferred(); f.connectWait = wait.promise; f.onAuthentication = authenticated.resolve; const r = invoke(f, "/profile", bff); await authenticated.promise; await new Promise<void>(resolve => setImmediate(resolve)); r.request.emit("aborted"); wait.resolve(); await r.pending; assert.deepEqual(f.releases, [true]); assert(!f.queries.some(q => q.sql.startsWith("BEGIN"))); assert.equal(r.state.body, undefined); }
});
test("already aborted requests or destroyed responses never authenticate through either entry", async () => {
  for (const bff of [false, true]) for (const input of [{ aborted: true }, { destroyed: true }]) { const f = new Fixture(); const r = await read(f, "/profile", bff, input); assert.equal(r.body, undefined); assert.equal(f.sdkHeaders.length, 0); }
});
test("unknown borrowed transaction states destroy only that lease without BEGIN/ROLLBACK", async () => {
  for (const bff of [false, true]) for (const state of ["T", "E", null] as const) { const f = new Fixture(); f.leaseState = state; failure(await read(f, "/profile", bff), 503); assert.deepEqual(f.releases, [true]); assert(!f.queries.some(q => q.handle === "client")); }
});
test("57014 is safe 504 after rollback; rollback loss and connection errors destroy the lease", async () => {
  for (const bff of [false, true]) for (const scenario of ["sql_budget", "rollback_after_success", "rollback_after_error", "connection_error", "acquire_error"] as const) {
    const f = new Fixture();
    if (scenario.startsWith("rollback")) f.rollbackError = new Error("PRIVATE rollback failure");
    if (scenario === "acquire_error") f.connectError = new Error("PRIVATE connection failure");
    f.beforeSql = async (sql, _values, client) => { if (!sql.startsWith('SELECT "id", "username"')) return; if (scenario === "connection_error") client.emit("error", new Error("PRIVATE socket")); if (scenario === "sql_budget") throw Object.assign(new Error("PRIVATE SQL"), { code: "57014" }); if (scenario === "rollback_after_error") throw new Error("PRIVATE read failure"); };
    const r = await read(f, "/profile", bff); failure(r, scenario === "sql_budget" ? 504 : scenario === "acquire_error" ? 503 : 500); assert(!JSON.stringify(r.body).includes("PRIVATE"));
    assert.equal(f.queries.filter(q => q.sql === "ROLLBACK").length, scenario === "acquire_error" ? 0 : 1); assert.deepEqual(f.releases, scenario === "acquire_error" ? [] : [scenario !== "sql_budget"]);
    for (const c of f.clients) assert.equal(c.listenerCount("error"), 0);
  }
});
test("self reads do not take directory's two-request admission slots", async () => {
  const f = new Fixture(), hold = deferred(); const events = () => ({ req: new EventEmitter(), res: new EventEmitter() }); const a = events(), b = events();
  const one = withDirectoryRead(f.pool, a.req as never, a.res as never, async () => hold.promise), two = withDirectoryRead(f.pool, b.req as never, b.res as never, async () => hold.promise);
  try { assert.equal((await read(f, "/profile")).status, 200); } finally { hold.resolve(); await Promise.all([one, two]); }
});
test("direct registration mounts only self scope and keeps originalUrl when Express strips req.url", async () => {
  const mounts: [string, Function][] = []; const f = new Fixture(); mountAdminSelfSettingsHandlers({ getHttpAdapter: () => ({ getInstance: () => ({ use: (path: string, handler: Function) => mounts.push([path, handler]) }) }) } as never, f.options); assert.deepEqual(mounts.map(m => m[0]), ["/api/v1/admin/self"]);
  const c = capture(); await mounts[0]![1]({ method: "GET", url: "/profile", originalUrl: "/api/v1/admin/self/profile", headers: { cookie: COOKIE } }, c.response); assert.equal(c.state.status, 200);
});
test("R0 wiring retains shared read/write transactions and introduces no command module dependencies", () => {
  const source = readFileSync(resolve("src/auth/admin-self-settings.ts"), "utf8"), runtime = readFileSync(resolve("src/auth/auth-runtime.ts"), "utf8");
  assert(!/admin-security-commands|admin-self-security-plugin|admin-auth-session|withTransaction|recordAudit|setAuditContext|FOR UPDATE/.test(source));
  assert.match(source, /withDirectoryReadTransaction\(options\.pool/); assert(!/withDirectoryRead\(/.test(source));
  assert.match(runtime, /mountAuthSecurityHandlers\(app, securityOptions\);\s+mountAdminSelfSettingsHandlers\(app, securityOptions\);/);
  assert.match(runtime, /mountCreditGuaranteeRoutes\(app, \{\s*\.\.\.securityOptions,\s*listingCursorKey: options\.listingCursorKey\s*\}, options\.creditGuaranteeEnabled === true\)/);
  assert.match(runtime, /mountMembershipGrowth/);
});
