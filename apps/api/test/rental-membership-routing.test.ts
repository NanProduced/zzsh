import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { ADMIN_PERMISSION } from "../src/auth/admin-authorization";
import type { AuthSecurityOptions } from "../src/auth/auth-security";
import { mountMembershipGrowthRoutes } from "../src/auth/membership-growth-routes";
import { mountRentalMembership } from "../src/auth/rental-membership-routes";
import { mountUserDirectory } from "../src/auth/user-directory-routes";
import type { SupplyResponse } from "../src/supply/supply-routes";
import type { SupplyNodeRequest } from "../src/supply/supply-util";

type Middleware = (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => Promise<void> | void;

function environment(authenticated = false, permissions: string[] = []) {
  const statements: string[] = [];
  let authCalls = 0;
  const query = async (sql: string) => {
    statements.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('"zzsh_iam"."admin_security"')) return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false }], rowCount: 1 };
    if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: [{ locked: false, twoFactorEnabled: true, suspended: false }], rowCount: 1 };
    if (sql.includes("WITH role_permissions")) return { rows: permissions.map(permissionCode => ({ permissionCode })), rowCount: permissions.length };
    if (sql === 'SELECT id FROM zzsh_auth_user."user" WHERE id=$1') return { rows: [{ id: "user1" }], rowCount: 1 };
    if (sql.includes("FROM zzsh_iam.user_rental_membership")) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected query in routing test");
  };
  const options = {
    pool: { query, connect: async () => ({ query, release() {} }) },
    apiOrigin: "http://127.0.0.1:4222", adminOrigin: "http://127.0.0.1:4221", userOrigin: "http://127.0.0.1:4220",
    adminAuth: { api: { getSession: async () => { authCalls++; return authenticated ? { user: { id: "admin1", twoFactorEnabled: true }, session: { id: "session1", locked: false } } : null; } } },
  } as unknown as AuthSecurityOptions;
  const registrations: Array<{ prefix: string; middleware: Middleware }> = [];
  const app = { getHttpAdapter: () => ({ getInstance: () => ({ use: (prefix: string, middleware: Middleware) => registrations.push({ prefix, middleware }) }) }) } as unknown as INestApplication;
  return { options, app, registrations, statements, authCalls: () => authCalls };
}

function response() {
  const result = { status: 200, body: null as any };
  const value = { headersSent: false, status(code: number) { result.status = code; return this; }, setHeader() { return this; }, json(body: unknown) { result.body = body; return this; } } as unknown as SupplyResponse;
  return { result, value };
}

test("unmatched growth routes reach the next handler without reading auth or the database", async () => {
  const e = environment(); mountRentalMembership(e.app, e.options);
  const middleware = e.registrations.find(r => r.prefix === "/api/v1/admin/users")!.middleware;
  for (const path of ["/api/v1/admin/users/user1/membership-growth", "/api/v1/admin/users/user1/membership-growth?scope=LIFETIME"]) {
    const r = response(); let nextCalls = 0;
    await middleware({ method: "GET", originalUrl: path, headers: {} }, r.value, () => { nextCalls++; });
    assert.equal(nextCalls, 1); assert.equal(r.result.body, null);
  }
  assert.equal(e.authCalls(), 0); assert.deepEqual(e.statements, []);
});

test("the real directory, rental-membership, growth mount order reaches growth authentication", async () => {
  const e = environment(); mountUserDirectory(e.app, e.options); mountRentalMembership(e.app, e.options); mountMembershipGrowthRoutes(e.app, e.options);
  const handlers = e.registrations.filter(r => r.prefix === "/api/v1/admin/users").map(r => r.middleware), r = response();
  assert.equal(handlers.length, 3);
  const request = { method: "GET", originalUrl: "/api/v1/admin/users/user1/membership-growth", headers: { origin: e.options.adminOrigin } };
  const dispatch = async (index: number): Promise<void> => {
    assert(index < handlers.length, "growth route fell through every mounted handler");
    let downstream = Promise.resolve();
    await handlers[index]!(request, r.value, () => { downstream = dispatch(index + 1); });
    await downstream;
  };
  await dispatch(0);
  assert.equal(r.result.status, 401); assert.equal(r.result.body.error.code, "UNAUTHENTICATED");
  assert.equal(e.authCalls(), 1); assert.deepEqual(e.statements, []);
});

test("matched rental-membership GET retains authentication and permission checks", async () => {
  for (const authenticated of [false, true]) {
    const e = environment(authenticated); mountRentalMembership(e.app, e.options); const r = response(); let nextCalls = 0;
    await e.registrations.find(x => x.prefix === "/api/v1/admin/users")!.middleware({ method: "GET", originalUrl: "/api/v1/admin/users/user1/rental-membership", headers: { origin: e.options.adminOrigin } }, r.value, () => { nextCalls++; });
    assert.equal(nextCalls, 0); assert.equal(r.result.status, authenticated ? 403 : 401);
    assert.equal(r.result.body.error.code, authenticated ? "FORBIDDEN" : "UNAUTHENTICATED");
    assert(!e.statements.some(sql => sql.includes("FROM zzsh_iam.user_rental_membership")));
  }
});

test("an authorized matched GET still reads its own membership handler", async () => {
  const e = environment(true, [ADMIN_PERMISSION.userRentalMembershipManage]); mountRentalMembership(e.app, e.options); const r = response(); let nextCalls = 0;
  await e.registrations.find(x => x.prefix === "/api/v1/admin/users")!.middleware({ method: "GET", originalUrl: "/api/v1/admin/users/user1/rental-membership?unused=kept", headers: { origin: e.options.adminOrigin } }, r.value, () => { nextCalls++; });
  assert.equal(nextCalls, 0); assert.equal(r.result.status, 200); assert.deepEqual(r.result.body, { membership: { tier: "UNKNOWN", version: "0", sourceRef: null } });
});

test("matched unsupported methods and invalid write origin retain their errors", async () => {
  const e = environment(); mountRentalMembership(e.app, e.options); const middleware = e.registrations.find(x => x.prefix === "/api/v1/admin/users")!.middleware;
  for (const [method, origin, status] of [["POST", e.options.adminOrigin, 404], ["PUT", "http://127.0.0.1:9999", 403]] as const) {
    const r = response(); let nextCalls = 0;
    await middleware({ method, originalUrl: "/api/v1/admin/users/user1/rental-membership", headers: { origin } }, r.value, () => { nextCalls++; });
    assert.equal(nextCalls, 0); assert.equal(r.result.status, status);
  }
  assert.equal(e.authCalls(), 0); assert.deepEqual(e.statements, []);
});
