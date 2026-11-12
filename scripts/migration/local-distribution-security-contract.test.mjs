import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url), build = resolve(process.env.ZZSH_DISTRIBUTION_SECURITY_BUILD ?? "apps/api/dist/src");
const available = existsSync(join(build, "auth/auth-security.js")) && existsSync(join(build, "auth/admin-directory.js"));
const { handleAdminSecurity } = available ? require(join(build, "auth/auth-security.js")) : {};
const directory = available ? require(join(build, "auth/admin-directory.js")) : {};

function response() {
  return { statusCode: 0, body: undefined, setHeader() { return this; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
}
function fixture({ authenticated = true, totpValid = true } = {}) {
  const sql = [], checks = [];
  const client = { query: async statement => { sql.push(statement); return { rows: [], rowCount: 0 }; }, release() {} };
  const pool = { query: async statement => { sql.push(statement); return { rows: [statement.includes('operation_code')
    ? { operationCode: 'distribution.policy.publish' } : { status: "ACTIVE", isBoss: false, passwordChangeRequired: false }] }; }, connect: async () => client };
  const adminAuth = { api: { getSession: async () => authenticated ? { user: { id: "actor", twoFactorEnabled: true }, session: { id: "session", locked: false } } : null,
    verifyPassword: async () => { checks.push("password"); return { status: true }; }, verifyTOTP: async () => { checks.push("totp"); if (!totpValid) throw Error("bad code"); return { status: true }; } } };
  const options = { pool, adminAuth, apiOrigin: "http://127.0.0.1:4232", adminOrigin: "http://127.0.0.1:4231", rateLimitState: new Map(), securityVerificationBudget: { inFlight: 0 }, testOperationsEnabled: false };
  return { sql, checks, options };
}
const request = () => ({ method: "POST", originalUrl: "/api/v1/admin/security/approvals/requests/decision", headers: { origin: "http://127.0.0.1:4231", cookie: "zzsh_admin.session_token=synthetic", "idempotency-key": "synthetic-idempotency-1" }, body: { requestId: "approval_1", decision: "APPROVE", totpCode: "123456" } });

test("real security handler denies unauthenticated approval before any database write", { skip: !available && "compiled API build unavailable" }, async () => {
  const f = fixture({ authenticated: false }), res = response();
  await handleAdminSecurity(request(), res, f.options);
  assert.equal(res.statusCode, 401); assert.equal(f.sql.length, 0); assert.equal(f.checks.length, 0);
});

test("real security handler rejects incorrect TOTP before approval transaction", { skip: !available && "compiled API build unavailable" }, async () => {
  const f = fixture({ totpValid: false }), res = response();
  await handleAdminSecurity(request(), res, f.options);
  assert.equal(res.statusCode, 401); assert.deepEqual(f.checks, ["totp"]);
  assert(!f.sql.some(s => /\bBEGIN\b|\bINSERT\b|\bUPDATE\b/.test(s)));
});

test("real security handler reaches permission check only after step-up and rolls back unauthorized actor", { skip: !available && "compiled API build unavailable" }, async () => {
  const f = fixture(), res = response(), old = directory.lockActor;
  directory.lockActor = async () => ({ status: "ACTIVE", passwordChangeRequired: false, isBoss: false, permissions: new Set() });
  try { await handleAdminSecurity(request(), res, f.options); } finally { directory.lockActor = old; }
  assert.equal(res.statusCode, 403); assert.deepEqual(f.checks, ["totp"]);
  assert(f.sql.some(s => s === "ROLLBACK")); assert(!f.sql.some(s => /INSERT INTO\s+"zzsh_iam"\."approval_decision"/.test(s)));
});
