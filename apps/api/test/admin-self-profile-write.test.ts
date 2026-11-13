// Offline writer contract tests: no PG, live HTTP, Owner session, or sensitive command.
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";

import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import { handleAdminSelfSettingsRoute } from "../src/auth/admin-self-settings";
import type { AuthSecurityOptions } from "../src/auth/auth-security";

const SELF = "admin_one";
const OTHER = "admin_two";
const CURRENT = "session_one";
const ORIGIN = "http://127.0.0.1:4301";
const API = "http://127.0.0.1:4302";
const COOKIE = "zzsh_admin.session_token=offline_admin";
const OLD_NAME = "离线管理员";
const NOW = new Date("2026-10-15T12:00:00Z");

type Audit = { action: string; objectType: string; objectId: string; actorId: string; details: Record<string, any> };

class Fixture {
  user = { id: SELF, username: "zz00001", displayUsername: "ZZ00001", name: OLD_NAME, image: null, updatedAt: NOW };
  status = "ACTIVE";
  twoFactorEnabled = true;
  locked = false;
  suspended = false;
  auditFails = false;
  audits: Audit[] = [];
  queries: { handle: string; sql: string; values: unknown[] }[] = [];
  releases: boolean[] = [];
  connected = 0;
  committed = false;
  rolledBack = false;
  private pendingName: string | null = null;

  readonly pool = {
    query: async (sql: string, values: unknown[] = []) => this.query("pool", sql, values),
    connect: async () => {
      this.connected += 1;
      const client = {
        query: async (sql: string, values: unknown[] = []) => this.query("client", sql, values),
        release: (destroy?: boolean) => this.releases.push(destroy === true),
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;

  readonly options = {
    pool: this.pool,
    apiOrigin: API,
    adminOrigin: ORIGIN,
    adminAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          if (headers.get("cookie") !== COOKIE) return null;
          return {
            user: { id: SELF, name: this.user.name, twoFactorEnabled: this.twoFactorEnabled, suspended: this.suspended },
            session: { id: CURRENT, locked: this.locked },
          };
        },
      },
    },
  } as unknown as AuthSecurityOptions;

  private async query(handle: string, sql: string, values: unknown[]) {
    this.queries.push({ handle, sql, values });
    const rows = (value: unknown[]) => ({ rows: value, rowCount: value.length });
    const q = sql.replace(/\s+/g, " ").trim();
    if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK") {
      if (q === "COMMIT") {
        if (this.pendingName !== null) this.user.name = this.pendingName;
        this.pendingName = null;
        this.committed = true;
      }
      if (q === "ROLLBACK") {
        this.pendingName = null;
        this.rolledBack = true;
      }
      return rows([]);
    }
    if (q.startsWith("SELECT set_config")) return rows([]);
    if (q.startsWith('SELECT "status", "is_boss"')) {
      return rows([{ status: this.status, isBoss: false, passwordChangeRequired: false }]);
    }
    if (q.startsWith('SELECT s."locked",u."twoFactorEnabled",u."suspended"')) {
      return rows([{ locked: this.locked, twoFactorEnabled: this.twoFactorEnabled, suspended: this.suspended }]);
    }
    if (q.startsWith('SELECT u."id", u."username"')) {
      return rows([{ ...this.user, suspended: this.suspended, status: this.status }]);
    }
    if (q.startsWith('UPDATE "zzsh_auth_admin"."user"')) {
      this.pendingName = String(values[0]);
      return rows([{ ...this.user, name: this.pendingName, updatedAt: NOW }]);
    }
    if (q.startsWith('INSERT INTO "zzsh_iam"."audit_event"')) {
      if (this.auditFails) throw new Error("PRIVATE audit failure");
      this.audits.push({
        action: String(values[4]),
        objectType: String(values[5]),
        objectId: String(values[6]),
        actorId: String(values[2]),
        details: JSON.parse(String(values[10])),
      });
      return rows([]);
    }
    assert.fail(`Unrecognized SQL: ${q}`);
  }
}

function capture() {
  const state = { status: 0, body: undefined as any, headers: {} as Record<string, unknown> };
  const response = Object.assign(new EventEmitter(), {
    writableFinished: false,
    destroyed: false,
    headersSent: false,
    setHeader(name: string, value: unknown) { state.headers[name.toLowerCase()] = value; return response; },
    status(status: number) { state.status = status; return response; },
    json(body: unknown) { state.body = body; response.headersSent = true; response.writableFinished = true; response.emit("close"); },
  });
  return { state, response };
}

type Input = { method?: string; bff?: boolean; body?: unknown; headers?: Record<string, string | undefined>; originalUrl?: string };
function invoke(f: Fixture, input: Input = {}) {
  const { state, response } = capture();
  const url = input.originalUrl ?? (input.bff ? "/api/bff/admin/self/profile" : "/api/v1/admin/self/profile");
  const request = Object.assign(new EventEmitter(), {
    method: input.method ?? "POST",
    url,
    originalUrl: url,
    aborted: false,
    body: input.body,
    headers: { origin: ORIGIN, cookie: COOKIE, "x-request-id": "req_offline", ...input.headers },
  });
  const pending = input.bff
    ? handleAdminBff(request as never, response, { adminOrigin: ORIGIN, apiOrigin: API, adminSecurityOptions: f.options } as AdminBffOptions)
    : handleAdminSelfSettingsRoute(request as never, response, f.options);
  return { pending, state, request, response };
}

test("self display-name write updates only the session subject and audits before/after", async () => {
  for (const bff of [false, true]) {
    const f = new Fixture();
    const r = invoke(f, { bff, body: { displayName: " 新名称 " } });
    await r.pending;
    assert.equal(r.state.status, 200, JSON.stringify(r.state.body));
    assert.equal(r.state.body.status, true);
    assert.equal(r.state.body.profile.adminUserId, SELF);
    assert.equal(r.state.body.profile.zzNumber, "ZZ00001");
    assert.equal(r.state.body.profile.displayName, "新名称");
    assert.equal(r.state.body.profile.avatarUrl, null);
    assert.equal(r.state.body.profile.updatedAt, NOW.toISOString());
    assert.equal(r.state.headers["cache-control"], "no-store");
    assert.equal(r.state.headers["x-request-id"], "req_offline");
    assert.equal(f.user.name, "新名称");
    assert.equal(f.committed, true);
    assert.equal(f.rolledBack, false);
    assert.deepEqual(f.audits, [{
      action: "admin.account.updated",
      objectType: "admin_user",
      objectId: SELF,
      actorId: SELF,
      details: { username: "zz00001", before: { name: OLD_NAME }, after: { name: "新名称" } },
    }]);
    assert(f.queries.some((query) => query.sql.includes("FOR UPDATE OF u, s")), "locks the self user and security rows");
    assert.equal(f.queries.filter((query) => /admin_permission|admin_user_role|admin_role/.test(query.sql)).length, 0, "does not require directory permission tables");
    assert.equal(f.queries.at(-1)!.sql, "COMMIT");
    assert.deepEqual(f.releases, [false]);
  }
});

test("display-name validation rejects extra targets, controls, empty and overlong input before a transaction", async () => {
  const invalid = [
    undefined,
    [],
    {},
    { displayName: "x", adminUserId: OTHER },
    { displayName: "x", username: "zz00002" },
    { displayName: 1 },
    { displayName: "   " },
    { displayName: "a\nb" },
    { displayName: "x".repeat(121) },
    { displayName: "😀".repeat(121) },
  ];
  for (const body of invalid) {
    const f = new Fixture();
    const r = invoke(f, { body });
    await r.pending;
    assert.equal(r.state.status, 400, JSON.stringify(body));
    assert.equal(f.connected, 0, "invalid input never acquires a write transaction");
    assert.equal(f.user.name, OLD_NAME);
    assert.equal(f.audits.length, 0);
  }
  const emoji = "😀".repeat(120);
  const f = new Fixture();
  const r = invoke(f, { body: { displayName: emoji } });
  await r.pending;
  assert.equal(r.state.status, 200);
  assert.equal(f.user.name, emoji, "120 Unicode code points are accepted even when UTF-16 length exceeds 120");
});

test("self write keeps the same ACTIVE, TOTP, unlocked and unfrozen gates as the read", async () => {
  for (const [apply, status] of [
    [(f: Fixture) => { f.locked = true; }, 423],
    [(f: Fixture) => { f.twoFactorEnabled = false; }, 403],
    [(f: Fixture) => { f.status = "PENDING_ENROLLMENT"; }, 403],
    [(f: Fixture) => { f.status = "FROZEN"; }, 401],
    [(f: Fixture) => { f.suspended = true; }, 401],
  ] as const) {
    const f = new Fixture();
    apply(f);
    const r = invoke(f, { body: { displayName: "新名称" } });
    await r.pending;
    assert.equal(r.state.status, status);
    assert.equal(f.user.name, OLD_NAME);
    assert.equal(f.audits.length, 0);
  }
});

test("audit failure rolls back the name and returns a controlled server error", async () => {
  const f = new Fixture();
  f.auditFails = true;
  const r = invoke(f, { body: { displayName: "新名称" } });
  await r.pending;
  assert.equal(r.state.status, 500);
  assert.equal(f.user.name, OLD_NAME);
  assert.equal(f.committed, false);
  assert.equal(f.rolledBack, true);
  assert.equal(f.audits.length, 0);
  assert.equal(f.queries.at(-1)!.sql, "ROLLBACK");
  assert.deepEqual(f.releases, [false]);
});

test("only POST /profile enters the writer; other methods and paths keep the 404 gate", async () => {
  for (const input of [
    { method: "POST", originalUrl: "/api/v1/admin/self/sessions" },
    { method: "POST", originalUrl: "/api/v1/admin/self/security-activity" },
    { method: "GET", originalUrl: "/api/v1/admin/self/profile/" },
    { method: "PUT", originalUrl: "/api/v1/admin/self/profile" },
    { method: "DELETE", originalUrl: "/api/v1/admin/self/profile" },
  ] as Input[]) {
    const f = new Fixture();
    const r = invoke(f, input);
    await r.pending;
    assert.equal(r.state.status, 404);
    assert.equal(f.connected, 0);
    assert.equal(f.user.name, OLD_NAME);
  }
});
