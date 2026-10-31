// 离线：迁移 0114 的预设授权必须与 src/auth/admin-role-presets.ts 常量逐条一致。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADMIN_PERMISSION, ADMIN_PERMISSION_CODES } from "../src/auth/admin-authorization";
import { assertNoNewBossOnlyRoleGrants, isBossOnlyPermission, BOSS_ONLY_PERMISSIONS, OPS_PRESET_PERMISSIONS, ROLE_PRESET_GRANTS, SUPPORT_PRESET_PERMISSIONS } from "../src/auth/admin-role-presets";

const sql = readFileSync(resolve("migrations/business/0114_admin_role_preset_grants.sql"), "utf8");
const pairs = [...sql.matchAll(/\('(role_preset_\w+)',\s*'([a-z0-9_.]+)'\)/g)].map((m) => [m[1], m[2]] as const);

test("0114 seed rows equal the code constants exactly", () => {
  const expected = Object.entries(ROLE_PRESET_GRANTS).flatMap(([role, codes]) => codes.map((c) => [role, c] as const));
  assert.deepEqual(pairs, expected);
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
  for (const c of [ADMIN_PERMISSION.approvalRequestAddApprover, ADMIN_PERMISSION.approvalTemplateRead, ADMIN_PERMISSION.approvalTemplateConfigure, ADMIN_PERMISSION.accountCreate, ADMIN_PERMISSION.accountUpdate, ADMIN_PERMISSION.accountFreeze, ADMIN_PERMISSION.accountUnfreeze, ADMIN_PERMISSION.roleConfigure, ADMIN_PERMISSION.permissionGrant]) assert.ok(!o.has(c), c);
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
