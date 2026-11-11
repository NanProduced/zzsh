import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { handleAdminSecurity, type AuthSecurityOptions } from "../src/auth/auth-security";
import { initializeFirstAdministrators, type InitialAdministratorsInput } from "../src/auth/initial-administrators";

type Security = {
  status: "PENDING_ENROLLMENT" | "ACTIVE";
  isBoss: boolean;
  passwordChangeRequired: boolean;
  bootstrapExpiresAt: Date | null;
  unlimitedInitialEnrollment: boolean;
  bootstrapUsedAt: Date | null;
  firstActivatedAt: Date | null;
};

async function activate(overrides: Partial<Security>, twoFactor = true) {
  const row: Security = { status: "PENDING_ENROLLMENT", isBoss: true, passwordChangeRequired: false,
    bootstrapExpiresAt: null, unlimitedInitialEnrollment: false, bootstrapUsedAt: null, firstActivatedAt: null, ...overrides };
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

test("initial operations account can activate without a deadline, but its later recovery cannot", async () => {
  assert.deepEqual(await activate({ isBoss: false, unlimitedInitialEnrollment: true }), { status: 200, writes: 1, audits: 1 });
  assert.deepEqual(await activate({ isBoss: false, unlimitedInitialEnrollment: true, firstActivatedAt: new Date("2019-01-01T00:00:00Z") }), { status: 409, writes: 0, audits: 0 });
});

test("ordinary and previously activated Boss recovery retain their activation deadlines", async () => {
  for (const overrides of [
    { isBoss: false, bootstrapExpiresAt: null },
    { isBoss: false, bootstrapExpiresAt: new Date("2020-01-01T00:00:00Z") },
    { firstActivatedAt: new Date("2019-01-01T00:00:00Z"), bootstrapExpiresAt: new Date("2020-01-01T00:00:00Z") },
  ]) assert.deepEqual(await activate(overrides), { status: 409, writes: 0, audits: 0 });
});

const initialInput: InitialAdministratorsInput = {
  bosses: [{ name: "Boss 1", password: "fixture-password-boss-1" }, { name: "Boss 2", password: "fixture-password-boss-2" }],
  operations: [{ name: "运营 1", password: "fixture-password-ops-1" }, { name: "运营 2", password: "fixture-password-ops-2" }],
};

test("initial administrator creation requires a transaction and four distinct valid passwords", async () => {
  let queries = 0, hashes = 0;
  const client = { getTransactionStatus: () => "I", query: async () => { queries++; return { rows: [] }; } } as unknown as PoolClient;
  const hash = async () => { hashes++; return "fixture-hash"; };
  await assert.rejects(initializeFirstAdministrators(client, initialInput, hash, "init-fixture"), /INITIAL_ADMINS_TRANSACTION_REQUIRED/);
  (client as unknown as { getTransactionStatus: () => string }).getTransactionStatus = () => "T";
  const duplicate: InitialAdministratorsInput = { ...initialInput, operations: [initialInput.operations[0], initialInput.bosses[0]] };
  await assert.rejects(initializeFirstAdministrators(client, duplicate, hash, "init-fixture"), /INITIAL_ADMINS_INPUT_INVALID/);
  assert.equal(queries, 0); assert.equal(hashes, 0);
});

test("initial administrator creation refuses occupied targets and an unsafe operations preset before hashing", async () => {
  for (const occupied of [true, false]) {
    let hashes = 0, writes = 0;
    const client = { getTransactionStatus: () => "T", async query(sql: string) {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("AS occupied")) return { rows: [{ occupied }] };
      if (sql.includes("AS valid")) return { rows: [{ valid: false }] };
      writes++; throw new Error("unexpected write");
    } } as unknown as PoolClient;
    await assert.rejects(initializeFirstAdministrators(client, initialInput, async () => { hashes++; return "hash"; }, "init-fixture"),
      occupied ? /INITIAL_ADMINS_TARGET_NOT_EMPTY/ : /INITIAL_ADMINS_OPERATIONS_ROLE_NOT_READY/);
    assert.equal(hashes, 0); assert.equal(writes, 0);
  }
});
