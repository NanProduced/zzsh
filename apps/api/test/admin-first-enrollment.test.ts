import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { handleAdminSecurity, type AuthSecurityOptions } from "../src/auth/auth-security";

type Security = {
  status: "PENDING_ENROLLMENT" | "ACTIVE";
  isBoss: boolean;
  passwordChangeRequired: boolean;
  bootstrapExpiresAt: Date | null;
  bootstrapUsedAt: Date | null;
  firstActivatedAt: Date | null;
};

async function activate(overrides: Partial<Security>, twoFactor = true) {
  const row: Security = { status: "PENDING_ENROLLMENT", isBoss: true, passwordChangeRequired: false,
    bootstrapExpiresAt: null, bootstrapUsedAt: null, firstActivatedAt: null, ...overrides };
  let writes = 0, audits = 0;
  const query = async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("set_config")) return { rows: [] };
    if (sql.includes('FROM "zzsh_iam"."admin_security"') && sql.includes('WHERE "admin_user_id"')) return { rows: [{ ...row }] };
    if (sql.startsWith('UPDATE "zzsh_iam"."admin_security"')) { writes++; row.status = "ACTIVE"; return { rows: [] }; }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { audits++; return { rows: [] }; }
    throw new Error("Unexpected fixture query");
  };
  const client = { query, release() {} } as unknown as PoolClient;
  const pool = { query, connect: async () => client } as unknown as Pool;
  const auth = { api: { getSession: async () => ({ user: { id: "admin_fixture", twoFactorEnabled: twoFactor },
    session: { id: "session_fixture", locked: false } }) } };
  const options = { pool, adminAuth: auth, userAuth: auth, apiOrigin: "http://127.0.0.1:4292", adminOrigin: "http://127.0.0.1:4291" } as unknown as AuthSecurityOptions;
  let status = 200;
  const response = { setHeader() { return this; }, status(value: number) { status = value; return this; }, json() {} };
  await handleAdminSecurity({ method: "POST", url: "/api/v1/admin/security/enrollment/activate", body: {},
    headers: { origin: options.adminOrigin, "x-request-id": "req_fixture" } }, response, options);
  return { status, writes, audits };
}

test("first Boss activation has no expiry, including pending accounts created by an older version", async () => {
  for (const bootstrapExpiresAt of [null, new Date("2020-01-01T00:00:00Z")]) {
    assert.deepEqual(await activate({ bootstrapExpiresAt }), { status: 200, writes: 1, audits: 1 });
  }
});

test("first Boss still requires a changed password, TOTP and an unused activation", async () => {
  assert.deepEqual(await activate({ passwordChangeRequired: true }), { status: 403, writes: 0, audits: 0 });
  assert.deepEqual(await activate({}, false), { status: 403, writes: 0, audits: 0 });
  assert.deepEqual(await activate({ bootstrapUsedAt: new Date() }), { status: 409, writes: 0, audits: 0 });
});

test("ordinary and previously activated Boss recovery retain their activation deadlines", async () => {
  for (const overrides of [
    { isBoss: false, bootstrapExpiresAt: null },
    { isBoss: false, bootstrapExpiresAt: new Date("2020-01-01T00:00:00Z") },
    { firstActivatedAt: new Date("2019-01-01T00:00:00Z"), bootstrapExpiresAt: new Date("2020-01-01T00:00:00Z") },
  ]) assert.deepEqual(await activate(overrides), { status: 409, writes: 0, audits: 0 });
});
