// 离线：登录 2FA 偏好（迁移 0115）——钩子包装失败即安全、快照字段、自助接口接线与审计。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { adminLoginTwoFactorOptedOut, readAdminLoginTwoFactorRequired, withAdminLoginTwoFactorPreference } from "../src/auth/admin-login-two-factor";

const poolReturning = (rows: unknown[] | Error) => ({
  query: async () => { if (rows instanceof Error) throw rows; return { rows }; },
}) as any;

function plugin(calls: string[]) {
  return { id: "two-factor", hooks: { after: [{ matcher: () => true, handler: async (_ctx: unknown) => { calls.push("challenge"); return { twoFactorRedirect: true }; } }] } };
}
const ctxFor = (twoFactorEnabled: boolean) => ({ context: { newSession: { user: { id: "admin-1", twoFactorEnabled } } } });

test("opted-out ACTIVE account skips the login challenge", async () => {
  const calls: string[] = [];
  const wrapped = withAdminLoginTwoFactorPreference(plugin(calls), poolReturning([{ optedOut: true }]));
  assert.deepEqual(await (wrapped.hooks.after[0] as any).handler(ctxFor(true)), { response: undefined, headers: undefined });
  assert.deepEqual(calls, []);
});

test("default, missing row, query error or unbound account keep the original behaviour", async () => {
  for (const pool of [poolReturning([{ optedOut: false }]), poolReturning([]), poolReturning(new Error("column does not exist"))]) {
    const calls: string[] = [];
    const wrapped = withAdminLoginTwoFactorPreference(plugin(calls), pool);
    assert.deepEqual(await (wrapped.hooks.after[0] as any).handler(ctxFor(true)), { twoFactorRedirect: true });
    assert.deepEqual(calls, ["challenge"]);
  }
  const calls: string[] = [];
  const wrapped = withAdminLoginTwoFactorPreference(plugin(calls), poolReturning([{ optedOut: true }]));
  await (wrapped.hooks.after[0] as any).handler(ctxFor(false));
  assert.deepEqual(calls, ["challenge"]);
});

test("opt-out query requires ACTIVE status and explicit false", async () => {
  let sql = "";
  await adminLoginTwoFactorOptedOut({ query: async (text: string) => { sql = text; return { rows: [] }; } } as any, "admin-1");
  assert.match(sql, /"login_two_factor_required" = false AND "status" = 'ACTIVE'/);
  assert.equal(await readAdminLoginTwoFactorRequired(poolReturning(new Error("x")), "a"), undefined);
  assert.equal(await readAdminLoginTwoFactorRequired(poolReturning([{ required: false }]), "a"), false);
});

test("migration 0115, runtime wiring, self endpoint and audit are in place", () => {
  const sql = readFileSync(resolve("migrations/business/0115_admin_login_two_factor_preference.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS login_two_factor_required boolean NOT NULL DEFAULT true/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { tag: string }) => entry.tag === "0115_admin_login_two_factor_preference"));
  const runtime = readFileSync(resolve("src/auth/auth-runtime.ts"), "utf8");
  assert.match(runtime, /withAdminLoginTwoFactorPreference\(twoFactor\(\), options\.pool\)/);
  // 回归：不得再套 createAuthMiddleware（会嵌套 { response, headers }，登录 200 却丢失 2FA 跳转）。
  assert.doesNotMatch(runtime, /withAdminLoginTwoFactorPreference\([^)]*createAuthMiddleware/);
  const security = readFileSync(resolve("src/auth/auth-security.ts"), "utf8");
  assert.match(security, /path === "\/login-two-factor"\) return await changeLoginTwoFactorPreference/);
  const body = security.slice(security.indexOf("async function changeLoginTwoFactorPreference"), security.indexOf("const ADMIN_CREDENTIAL_RESET_TTL"));
  assert.match(body, /verifyAdminReauthentication\(request, context, body, options\)/);
  assert.match(body, /action: "admin\.login_two_factor\.changed"/);
  assert.match(body, /before: \{ loginTwoFactorRequired: previous \}, after: \{ loginTwoFactorRequired: enabled \}/);
  assert.doesNotMatch(body, /requireBoss/);
  const bff = readFileSync(resolve("src/bff/admin-bff.ts"), "utf8");
  assert.match(bff, /"\/security\/login-two-factor", "\/api\/v1\/admin\/security\/login-two-factor"/);
});
test("default path passes the SDK hook result through unchanged (no re-wrapping)", async () => {
  const inner = { response: { twoFactorRedirect: true }, headers: new Headers({ "set-cookie": "zzsh_admin.two_factor=x" }) };
  const plugin2 = { hooks: { after: [{ matcher: () => true, handler: async () => inner }] } };
  const wrapped = withAdminLoginTwoFactorPreference(plugin2, poolReturning([{ optedOut: false }]));
  assert.equal(await (wrapped.hooks.after[0] as any).handler(ctxFor(true)), inner);
});
