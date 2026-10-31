// 离线：迁移 0114 的预设授权必须与 src/auth/admin-role-presets.ts 常量逐条一致。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_PERMISSION, ADMIN_PERMISSION_CODES } from "../src/auth/admin-authorization";
import { assertNoNewBossOnlyPersonalAllows, assertNoNewBossOnlyRoleGrants, isBossOnlyPermission, BOSS_ONLY_PERMISSIONS, OPS_PRESET_0118_ADDITIONS, OPS_PRESET_PERMISSIONS, ROLE_PRESET_GRANTS, SUPPORT_PRESET_PERMISSIONS } from "../src/auth/admin-role-presets";

const sql = readFileSync(resolve("migrations/business/0114_admin_role_preset_grants.sql"), "utf8");
const pairs = [...sql.matchAll(/\('(role_preset_\w+)',\s*'([a-z0-9_.]+)'\)/g)].map((m) => [m[1], m[2]] as const);

const sql0118 = readFileSync(resolve("migrations/business/0118_ops_preset_account_admin.sql"), "utf8");
const pairs0118 = [...sql0118.matchAll(/\('(role_preset_\w+)',\s*'([a-z0-9_.]+)'\)/g)].map((m) => [m[1], m[2]] as const);
const later = new Set<string>(OPS_PRESET_0118_ADDITIONS);

test("0114 + 0118 seed rows equal the code constants exactly", () => {
  const expected = Object.entries(ROLE_PRESET_GRANTS).flatMap(([role, codes]) => codes.filter((c) => role !== "role_preset_ops" || !later.has(c)).map((c) => [role, c] as const));
  assert.deepEqual(pairs, expected);
  assert.deepEqual(pairs0118, OPS_PRESET_0118_ADDITIONS.map((c) => ["role_preset_ops", c] as const));
  assert.match(sql0118, /ON CONFLICT \(role_id, permission_code\) DO NOTHING/);
  assert.doesNotMatch(sql0118.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''"), /\b(DELETE|UPDATE|DROP|TRUNCATE|GRANT)\b|admin_user_/i);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.equal(journal.entries[118].tag, "0118_ops_preset_account_admin");
  for (const c of OPS_PRESET_0118_ADDITIONS) assert.ok(!isBossOnlyPermission(c), c);
  assert.equal(new Set(pairs.map((p) => p.join("|"))).size, pairs.length);
});

test("presets only use defined, non-Boss-only codes and exclude the order.read baseline", () => {
  const defined = new Set<string>(ADMIN_PERMISSION_CODES);
  const bossOnly = new Set<string>(BOSS_ONLY_PERMISSIONS);
  for (const code of [...SUPPORT_PRESET_PERMISSIONS, ...OPS_PRESET_PERMISSIONS]) {
    assert.ok(defined.has(code), code);
    assert.ok(!bossOnly.has(code), code);
    assert.notEqual(code, ADMIN_PERMISSION.orderRead);
    assert.notEqual(code, "user.account.restore");
  }
});

test("Owner decisions: support scope", () => {
  const s = new Set<string>(SUPPORT_PRESET_PERMISSIONS);
  assert.ok(s.has(ADMIN_PERMISSION.orderSettlementWrite));
  assert.ok(!s.has(ADMIN_PERMISSION.userRentalMembershipManage));
  assert.ok(!s.has(ADMIN_PERMISSION.supplyGuaranteeVerify));
  // 客服可发起会员礼遇申请，但不能审批、执行、决定或撤销
  for (const c of [ADMIN_PERMISSION.approvalRequestCreate, ADMIN_PERMISSION.approvalRequestRead, ADMIN_PERMISSION.membershipEntitlementRequest, ADMIN_PERMISSION.membershipGrowthSummaryRead]) assert.ok(s.has(c), c);
  for (const c of [ADMIN_PERMISSION.approvalRequestApprove, ADMIN_PERMISSION.approvalRequestExecute, ADMIN_PERMISSION.approvalRequestAddApprover, ADMIN_PERMISSION.membershipEntitlementDecide, ADMIN_PERMISSION.membershipEntitlementExecute, ADMIN_PERMISSION.membershipEntitlementRevoke]) assert.ok(!s.has(c), c);
  const o = new Set<string>(OPS_PRESET_PERMISSIONS);
  for (const c of SUPPORT_PRESET_PERMISSIONS) assert.ok(o.has(c), c);
  for (const c of [ADMIN_PERMISSION.financeRead, ADMIN_PERMISSION.accountRead, ADMIN_PERMISSION.roleRead, ADMIN_PERMISSION.supplyGuaranteeVerify, ADMIN_PERMISSION.membershipEntitlementDecide, ADMIN_PERMISSION.membershipGrowthBackfill]) assert.ok(o.has(c), c);
  assert.ok(!o.has("membership.growth.audit.read"));
  for (const c of [ADMIN_PERMISSION.approvalRequestApprove, ADMIN_PERMISSION.approvalRequestExecute, ADMIN_PERMISSION.membershipEntitlementExecute, ADMIN_PERMISSION.membershipEntitlementRevoke]) assert.ok(o.has(c), c);
  for (const c of [ADMIN_PERMISSION.approvalRequestAddApprover, ADMIN_PERMISSION.approvalTemplateRead, ADMIN_PERMISSION.approvalTemplateConfigure, ADMIN_PERMISSION.roleConfigure, ADMIN_PERMISSION.permissionGrant]) assert.ok(!o.has(c), c);
  for (const c of [ADMIN_PERMISSION.accountCreate, ADMIN_PERMISSION.accountUpdate, ADMIN_PERMISSION.accountFreeze, ADMIN_PERMISSION.accountUnfreeze, ADMIN_PERMISSION.userIdentitySensitiveRead]) { assert.ok(o.has(c), c); assert.ok(!s.has(c), c); }
});

test("0114 is additive and journaled", () => {
  assert.match(sql, /ON CONFLICT \(role_id, permission_code\) DO NOTHING/);
  assert.doesNotMatch(sql, /\b(DELETE|UPDATE|DROP|TRUNCATE|GRANT)\b|admin_user_/i);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.equal(journal.entries[114].tag, "0114_admin_role_preset_grants");
});
test("roles cannot newly gain Boss-only permissions; legacy grants do not block other edits", () => {
  assert.ok(isBossOnlyPermission(ADMIN_PERMISSION.roleConfigure));
  assert.ok(!isBossOnlyPermission(ADMIN_PERMISSION.approvalRequestApprove));
  assert.throws(() => assertNoNewBossOnlyRoleGrants([], [ADMIN_PERMISSION.contentRead, ADMIN_PERMISSION.permissionGrant]), /Boss-only/);
  assert.throws(() => assertNoNewBossOnlyRoleGrants([ADMIN_PERMISSION.contentRead], [ADMIN_PERMISSION.contentRead, ADMIN_PERMISSION.approvalTemplateConfigure]), /Boss-only/);
  assert.doesNotThrow(() => assertNoNewBossOnlyRoleGrants([ADMIN_PERMISSION.permissionGrant], [ADMIN_PERMISSION.permissionGrant, ADMIN_PERMISSION.contentRead]));
  assert.doesNotThrow(() => assertNoNewBossOnlyRoleGrants([], [...OPS_PRESET_PERMISSIONS]));
});

test("personal ALLOW grants cannot add boss-only codes; DENY and pre-existing allows are not blocked", () => {
  assert.throws(() => assertNoNewBossOnlyPersonalAllows([], [ADMIN_PERMISSION.contentRead, ADMIN_PERMISSION.permissionGrant]), /Boss-only permissions cannot be granted personally/);
  assert.throws(() => assertNoNewBossOnlyPersonalAllows([], [ADMIN_PERMISSION.approvalTemplateConfigure]), /Boss-only/);
  assert.doesNotThrow(() => assertNoNewBossOnlyPersonalAllows([], [ADMIN_PERMISSION.accountCreate]));
  assert.doesNotThrow(() => assertNoNewBossOnlyPersonalAllows([ADMIN_PERMISSION.accountFreeze], [ADMIN_PERMISSION.accountFreeze]));
  assert.doesNotThrow(() => assertNoNewBossOnlyPersonalAllows([], [ADMIN_PERMISSION.contentRead]));
});

test("grant/role writes stay Boss-only; account create/update/freeze use permission checks with Boss/self guards (source wiring)", () => {
  const root = resolve("src/auth");
  const directory = readFileSync(resolve(root, "admin-directory.ts"), "utf8");
  for (const fn of ["createAdministrator", "updateAdministrator", "assignAdministratorAccess", "assignAdministratorGameScope", "createRole", "updateRole"]) {
    const start = directory.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, fn);
    const next = directory.indexOf("export async function ", start + 10);
    const body = directory.slice(start, next < 0 ? undefined : next);
    if (fn === "createAdministrator" || fn === "updateAdministrator") assert.doesNotMatch(body, /requireBossActor\(actor\)/, `${fn} is delegated (0118)`);
    else assert.match(body, /requireBossActor\(actor\)/, `${fn} must require Boss`);
    if (fn === "createAdministrator") assert.match(body, /assertDelegable\(actor/, fn);
    if (fn === "createAdministrator") assert.match(body, /requirePermission\(actor, ADMIN_PERMISSION\.permissionGrant\)/, fn);
    if (fn === "updateAdministrator") { assert.match(body, /target\.isBoss && !actor\.isBoss/); assert.match(body, /target\.id === context\.userId && !actor\.isBoss/); }
    if (fn === "createAdministrator" || fn === "assignAdministratorAccess") assert.match(body, /assertNoNewBossOnlyPersonalAllows\(/, fn);
    if (fn === "assignAdministratorAccess" || fn === "assignAdministratorGameScope") assert.match(body, /target\.id === context\.userId/, `${fn} self guard`);
  }
  const security = readFileSync(resolve(root, "auth-security.ts"), "utf8");
  const freeze = security.slice(security.indexOf("async function changeAdminFreezeState("), security.indexOf("async function changeUserAccountFreezeState("));
  assert.doesNotMatch(freeze, /if \(!actorAccess\.isBoss\) throw new SecurityApiError\(403/);
  assert.match(freeze, /target\.rows\[0\]\.isBoss && !actorAccess\.isBoss/);
  assert.match(freeze, /targetAdminId === context\.userId/);
  assert.match(freeze, /verifyAdminReauthentication\(/);
});

test("credential reset routes are Boss-only, re-verified, self/Boss/frozen guarded, audited and revoke sessions", () => {
  const src = readFileSync(resolve("src/auth/auth-security.ts"), "utf8");
  const bff = readFileSync(resolve("src/bff/admin-bff.ts"), "utf8");
  assert.match(src, /"\/admins\/reset-password"\) return await resetAdminCredential\(.*"password"\)/);
  assert.match(src, /"\/admins\/reset-2fa"\) return await resetAdminCredential\(.*"two_factor"\)/);
  const body = src.slice(src.indexOf("async function resetAdminCredential"), src.indexOf("async function forceLogoutAdmin"));
  for (const needle of ["await requireBoss(context, options)", "verifyAdminReauthentication(", "targetAdminId === context.userId", "before.isBoss", "FROZEN", "lockActor(", "DELETE FROM \"zzsh_auth_admin\".\"session\"", "DELETE FROM \"zzsh_auth_admin\".\"twoFactor\"", "\"password_change_required\" = $1", "admin.password.reset", "admin.two_factor.reset", "before: {", "after: {", "randomBytes(18)"]) {
    assert.ok(body.includes(needle), "missing " + needle);
  }
  assert.ok(body.indexOf("requireBoss") < body.indexOf("verifyAdminReauthentication"));
  assert.ok(bff.includes('"/security/admins/reset-password"') && bff.includes('"/security/admins/reset-2fa"'));
});
