import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createAdministrator, listAdministrators, readAdministratorDetail } from "../src/auth/admin-directory";
import { evaluateAdminDirectoryActions, type AdminDirectoryAction } from "../src/auth/admin-authorization";

const ROWS = [
  { adminId: "admin-boss", username: "ZZ00001", displayName: "老板", twoFactorEnabled: true, status: "ACTIVE", isBoss: true, passwordChangeRequired: false, bootstrapExpiresAt: null, firstActivatedAt: new Date("2026-01-01T00:00:00Z"), scopeMode: "ALL_GAMES", createdAt: new Date("2026-01-01T00:00:00Z"), lastFullAuthenticatedAt: null, roles: [{ id: "r1", code: "ops", name: "运营", status: "DISABLED" }] },
  { adminId: "admin-staff", username: "ZZ00002", displayName: "同事", twoFactorEnabled: null, status: "FROZEN", isBoss: false, passwordChangeRequired: true, bootstrapExpiresAt: new Date("2026-10-20T00:00:00Z"), firstActivatedAt: null, scopeMode: "SELECTED_GAMES", createdAt: new Date("2026-02-01T00:00:00Z"), lastFullAuthenticatedAt: null, roles: [] },
  { adminId: "admin-self", username: "ZZ00003", displayName: "自己", twoFactorEnabled: false, status: "PENDING_ENROLLMENT", isBoss: false, passwordChangeRequired: false, bootstrapExpiresAt: null, firstActivatedAt: null, scopeMode: "SELECTED_GAMES", createdAt: new Date("2026-03-01T00:00:00Z"), lastFullAuthenticatedAt: null, roles: [] },
];

function harness(options: { roleRead: boolean; permissionRead: boolean }) {
  const sql: string[] = [];
  const pool = {
    async query(text: string) {
      sql.push(text);
      if (text.includes('FROM "zzsh_auth_admin"."user" u')) return { rows: ROWS };
      if (text.includes('FROM "zzsh_iam"."admin_user_permission"')) {
        return { rows: [{ adminId: "admin-staff", allows: "3", denies: "1" }] };
      }
      if (text.includes('FROM "zzsh_supply"."admin_supply_scope"')) {
        return { rows: [{ adminId: "admin-staff", gameCount: "2" }, { adminId: "admin-self", gameCount: "0" }] };
      }
      if (text.includes('FROM "zzsh_auth_admin"."session"')) {
        return { rows: [{ adminId: "admin-staff", activeCount: "1", lockedCount: "0", latestSessionAt: new Date("2026-10-10T08:00:00Z") }] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
  return { sql, pool };
}

const bossActor = { id: "admin-boss", status: "ACTIVE", isBoss: true, permissions: new Set(["admin.account.read", "admin.account.update", "admin.permission.grant", "admin.account.freeze", "admin.account.unfreeze"]) };

test("administrator creation rejects missing or implicit selected scope before hashing or writes", async () => {
  let touched = 0;
  const options = { pool: { connect: async () => { touched += 1; throw new Error("must not connect"); } }, hashPassword: async () => { touched += 1; return "fixture"; } };
  for (const scope of [{}, { mode: "SELECTED_GAMES" }, { mode: "UNREGISTERED" }]) {
    await assert.rejects(() => createAdministrator({ userId: "creator", sessionId: "fixture-session" } as never, { name: "Explicit scope fixture", ...scope }, "fixture-create", options as never), (error: any) => error.status === 400);
  }
  assert.equal(touched, 0);
});

test("directory detail selects and returns user.image without session identifiers or network facts", async () => {
  for (const image of ["https://cdn.example/avatar.png", null]) {
    const queries: string[] = [];
    const pool = { async query(sql: string) {
      queries.push(sql);
      if (sql.includes('FROM "zzsh_auth_admin"."user" u')) return { rows: [{ ...ROWS[1], image, bootstrapUsedAt: null, ipAddress: "PRIVATE_IP", userAgent: "PRIVATE_UA", token: "PRIVATE_TOKEN" }] };
      if (sql.includes('FROM "zzsh_auth_admin"."session"')) return { rows: [{ activeCount: "0", lockedCount: "0", latestSessionAt: null, id: "PRIVATE_SESSION" }] };
      if (sql.includes('FROM "zzsh_iam"."admin_security" s')) return { rows: [{ mode: "SELECTED_GAMES", gameIds: [] }] };
      throw new Error("unexpected detail query");
    } };
    const detail = await readAdministratorDetail(pool as never, "ZZ00002", { roleRead: false, permissionRead: false });
    assert.equal(detail.image, image);
    assert.match(queries[0] ?? "", /u\."image"/);
    for (const marker of ["PRIVATE_IP", "PRIVATE_UA", "PRIVATE_TOKEN", "PRIVATE_SESSION"]) assert.equal(JSON.stringify(detail).includes(marker), false);
    assert.deepEqual(detail.sessionSummary, { activeCount: 0, lockedCount: 0, lastSessionCreatedAt: null });
  }
});

test("directory list reads batch summaries with a fixed number of queries, never per row", async () => {
  const { sql, pool } = harness({ roleRead: true, permissionRead: true });
  const { admins } = await listAdministrators(pool as never, { roleRead: true, permissionRead: true }, bossActor);
  assert.equal(admins.length, ROWS.length);
  assert.equal(sql.length, 4, "主查询 + 个人例外聚合 + 范围聚合 + 会话聚合；行数增加不得增加查询条数");
  assert.ok(sql.every((text) => !/WHERE\s+s?\."?admin_user_id"?\s*=\s*\$/i.test(text)), "聚合查询不得按单个管理员过滤");
});

test("directory list omits summaries the viewer may not read instead of reporting zero", async () => {
  const { sql, pool } = harness({ roleRead: false, permissionRead: false });
  const { admins } = await listAdministrators(pool as never, { roleRead: false, permissionRead: false }, bossActor);
  const staff = admins.find((row) => row.id === "admin-staff");
  assert.ok(staff);
  assert.equal("roles" in staff, false, "无角色读取能力时省略字段，不给空数组");
  assert.equal("personalGrantSummary" in staff, false, "无权限读取能力时省略字段，不给 0/0");
  assert.equal(sql.filter((text) => text.includes('FROM "zzsh_iam"."admin_user_permission"')).length, 0, "无权读取时连聚合查询都不发");
  assert.deepEqual(staff.securitySummary, { passwordChangeRequired: true, twoFactorEnabled: null, bootstrapExpiresAt: "2026-10-20T00:00:00.000Z", firstActivatedAt: null });
});

test("directory list reports personal grant counts and distinguishes all-games from a selected set", async () => {
  const { pool } = harness({ roleRead: true, permissionRead: true });
  const { admins } = await listAdministrators(pool as never, { roleRead: true, permissionRead: true }, bossActor);
  const byId = new Map(admins.map((row) => [row.id as string, row]));
  assert.deepEqual(byId.get("admin-staff")?.personalGrantSummary, { allows: 3, denies: 1 });
  assert.deepEqual(byId.get("admin-self")?.personalGrantSummary, { allows: 0, denies: 0 }, "聚合里没有该行就是真的零条例外，不是读取失败");
  assert.deepEqual(byId.get("admin-boss")?.scopeSummary, { mode: "ALL_GAMES" }, "全部游戏不去数历史勾选");
  assert.deepEqual(byId.get("admin-staff")?.scopeSummary, { mode: "SELECTED_GAMES", gameCount: 2 });
  assert.deepEqual(byId.get("admin-self")?.scopeSummary, { mode: "SELECTED_GAMES", gameCount: 0 }, "指定集合为空就是无业务范围");
});

test("directory list keeps role status so a disabled assignment stays visible", async () => {
  const { pool } = harness({ roleRead: true, permissionRead: true });
  const { admins } = await listAdministrators(pool as never, { roleRead: true, permissionRead: true }, bossActor);
  const boss = admins.find((row) => row.id === "admin-boss");
  assert.deepEqual(boss?.roles, [{ id: "r1", code: "ops", name: "运营", status: "DISABLED" }]);
});

type EligibilityInput = Parameters<typeof evaluateAdminDirectoryActions>[0];

function reasonsFor(input: EligibilityInput) {
  const table = new Map(evaluateAdminDirectoryActions(input).map((entry) => [entry.action, entry]));
  return (action: AdminDirectoryAction) => table.get(action);
}

test("action preflight mirrors the write rules for boss targets, self targets and frozen state", () => {
  const base = { actorStatus: "ACTIVE", actorIsBoss: false, actorPermissions: new Set(["admin.account.read", "admin.account.update", "admin.permission.grant", "admin.account.freeze", "admin.account.unfreeze"]) };

  const staffOnBoss = reasonsFor({ ...base, actorId: "admin-staff", targetId: "admin-boss", targetIsBoss: true, targetStatus: "ACTIVE" });
  assert.equal(staffOnBoss("update")?.reasonCode, "BOSS_ACTOR_REQUIRED", "非 Boss 不能改 Boss 资料");
  assert.equal(staffOnBoss("assign")?.reasonCode, "BOSS_TARGET_NOT_CONFIGURABLE", "Boss 角色与范围不由普通分配接口配置");
  assert.equal(staffOnBoss("scope")?.reasonCode, "BOSS_TARGET_NOT_CONFIGURABLE");
  assert.equal(staffOnBoss("freeze")?.reasonCode, "BOSS_ACTOR_REQUIRED");
  assert.equal(staffOnBoss("force-logout")?.reasonCode, "BOSS_ACTOR_REQUIRED");

  const bossPermissions = new Set(["admin.account.read", "admin.account.update", "admin.permission.grant", "admin.account.freeze", "admin.account.unfreeze"]);
  const bossOnStaff = reasonsFor({ actorId: "admin-boss", actorStatus: "ACTIVE", actorIsBoss: true, actorPermissions: bossPermissions, targetId: "admin-staff", targetIsBoss: false, targetStatus: "FROZEN" });
  assert.equal(bossOnStaff("update")?.allowed, true);
  assert.equal(bossOnStaff("freeze")?.reasonCode, "ALREADY_FROZEN", "已冻结的目标不再给冻结入口");
  assert.equal(bossOnStaff("unfreeze")?.allowed, true);

  const bossOnSelf = reasonsFor({ actorId: "admin-boss", actorStatus: "ACTIVE", actorIsBoss: true, actorPermissions: bossPermissions, targetId: "admin-boss", targetIsBoss: true, targetStatus: "ACTIVE" });
  assert.equal(bossOnSelf("freeze")?.reasonCode, "SELF_TARGET", "不能冻结自己，同级 Boss 也不绕过");
  assert.equal(bossOnSelf("force-logout")?.reasonCode, "SELF_TARGET", "不能撤销自己的会话");
  assert.equal(bossOnSelf("update")?.allowed, true, "本人改自己的显示名仍然允许");

  const bossOnUnfrozen = reasonsFor({ actorId: "admin-boss", actorStatus: "ACTIVE", actorIsBoss: true, actorPermissions: bossPermissions, targetId: "admin-self", targetIsBoss: false, targetStatus: "PENDING_ENROLLMENT" });
  assert.equal(bossOnUnfrozen("unfreeze")?.reasonCode, "NOT_FROZEN");
  assert.equal(bossOnUnfrozen("freeze")?.allowed, true);
});

test("action preflight reports missing capability and inactive actor rather than allowing", () => {
  const noGrant = new Map(evaluateAdminDirectoryActions({
    actorId: "admin-staff", actorStatus: "ACTIVE", actorIsBoss: false, actorPermissions: new Set(["admin.account.read"]),
    targetId: "admin-self", targetIsBoss: false, targetStatus: "ACTIVE",
  }).map((entry) => [entry.action, entry]));
  assert.equal(noGrant.get("update")?.reasonCode, "PERMISSION_REQUIRED");
  assert.equal(noGrant.get("assign")?.reasonCode, "PERMISSION_REQUIRED");
  assert.equal(noGrant.get("force-logout")?.reasonCode, "BOSS_ACTOR_REQUIRED");

  const frozenActor = new Map(evaluateAdminDirectoryActions({
    actorId: "admin-staff", actorStatus: "FROZEN", actorIsBoss: false, actorPermissions: new Set(["admin.account.update"]),
    targetId: "admin-self", targetIsBoss: false, targetStatus: "ACTIVE",
  }).map((entry) => [entry.action, entry]));
  assert.equal(frozenActor.get("update")?.reasonCode, "ACTOR_INACTIVE", "冻结的发起方一律不给可用入口");
});

test("assign is the only action that needs a complete grant baseline, and reauth is declared per action", () => {
  const table = evaluateAdminDirectoryActions({
    actorId: "admin-boss", actorStatus: "ACTIVE", actorIsBoss: true, actorPermissions: bossActor.permissions,
    targetId: "admin-self", targetIsBoss: false, targetStatus: "ACTIVE",
  });
  assert.deepEqual(table.filter((entry) => entry.needsFullGrantBaseline).map((entry) => entry.action), ["assign"]);
  assert.deepEqual(table.filter((entry) => entry.needsReauthentication).map((entry) => entry.action).sort(), ["force-logout", "freeze", "reset-2fa", "reset-password", "unfreeze"]);
  assert.equal(table.find((entry) => entry.action === "update")?.needsReauthentication, false, "改名不该在普通表单里收密码与动态码");
});

test("directory list returns avatar and session facts without leaking identifiers or network facts", async () => {
  const queries: string[] = [];
  const pool = {
    async query(text: string) {
      queries.push(text);
      if (text.includes('FROM "zzsh_auth_admin"."user" u')) {
        return {
          rows: [
            { adminId: "admin-a", username: "ZZ00001", displayName: "甲", twoFactorEnabled: true, status: "ACTIVE", isBoss: false, passwordChangeRequired: false, bootstrapExpiresAt: null, firstActivatedAt: null, scopeMode: "ALL_GAMES", image: "https://cdn.example/a.png", createdAt: new Date("2026-01-01T00:00:00Z"), lastFullAuthenticatedAt: null, roles: [] },
            { adminId: "admin-b", username: "ZZ00002", displayName: "乙", twoFactorEnabled: null, status: "ACTIVE", isBoss: false, passwordChangeRequired: false, bootstrapExpiresAt: null, firstActivatedAt: null, scopeMode: "SELECTED_GAMES", image: null, createdAt: new Date("2026-01-01T00:00:00Z"), lastFullAuthenticatedAt: null, roles: [] },
          ],
        };
      }
      if (text.includes('FROM "zzsh_iam"."admin_user_permission"')) return { rows: [] };
      if (text.includes('FROM "zzsh_supply"."admin_supply_scope"')) return { rows: [{ adminId: "admin-b", gameCount: "2" }] };
      if (text.includes('FROM "zzsh_auth_admin"."session"')) {
        return { rows: [{ adminId: "admin-a", activeCount: "2", lockedCount: "1", latestSessionAt: new Date("2026-10-10T08:00:00Z") }] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    },
  };
  const { admins } = await listAdministrators(pool as never, { roleRead: true, permissionRead: true }, { id: "admin-a", status: "ACTIVE", isBoss: true, permissions: new Set(["admin.account.read"]) });
  const byId = new Map(admins.map((row) => [row.id as string, row]));
  const withSessions = byId.get("admin-a");
  const withoutSessions = byId.get("admin-b");
  assert.deepEqual(withSessions?.sessionSummary, { activeCount: 2, lockedCount: 1, lastSessionCreatedAt: "2026-10-10T08:00:00.000Z" });
  assert.equal(withSessions?.image, "https://cdn.example/a.png");
  assert.deepEqual(withoutSessions?.sessionSummary, { activeCount: 0, lockedCount: 0, lastSessionCreatedAt: null }, "没有会话行是 0 与无最近建立，不是读取失败");
  assert.equal(withoutSessions?.image, null);
  assert.equal(queries.filter((text) => text.includes('FROM "zzsh_auth_admin"."session"')).length, 1, "会话摘要必须是一条分组查询");
  const serialized = JSON.stringify(admins);
  assert.equal(serialized.includes("ipAddress"), false, "列表不得泄漏登录 IP");
  assert.equal(serialized.includes("userAgent"), false, "列表不得泄漏 userAgent");
  assert.equal(/"id":"sess/i.test(serialized), false, "列表不得泄漏会话标识");
});

test("reset password / 2FA preflight: Boss only, never self, never another Boss, not frozen", () => {
  const perms = new Set(["admin.account.read"]);
  const staff = reasonsFor({ actorId: "s", actorStatus: "ACTIVE", actorIsBoss: false, actorPermissions: perms, targetId: "t", targetIsBoss: false, targetStatus: "ACTIVE" });
  assert.equal(staff("reset-password")?.reasonCode, "BOSS_ACTOR_REQUIRED");
  assert.equal(staff("reset-2fa")?.reasonCode, "BOSS_ACTOR_REQUIRED");
  const boss = reasonsFor({ actorId: "b", actorStatus: "ACTIVE", actorIsBoss: true, actorPermissions: perms, targetId: "t", targetIsBoss: false, targetStatus: "ACTIVE" });
  assert.equal(boss("reset-password")?.allowed, true);
  assert.equal(boss("reset-2fa")?.allowed, true);
  const bossOnBoss = reasonsFor({ actorId: "b", actorStatus: "ACTIVE", actorIsBoss: true, actorPermissions: perms, targetId: "b2", targetIsBoss: true, targetStatus: "ACTIVE" });
  assert.equal(bossOnBoss("reset-password")?.reasonCode, "BOSS_TARGET_NOT_CONFIGURABLE");
  const self = reasonsFor({ actorId: "b", actorStatus: "ACTIVE", actorIsBoss: true, actorPermissions: perms, targetId: "b", targetIsBoss: false, targetStatus: "ACTIVE" });
  assert.equal(self("reset-2fa")?.reasonCode, "SELF_TARGET");
  const frozen = reasonsFor({ actorId: "b", actorStatus: "ACTIVE", actorIsBoss: true, actorPermissions: perms, targetId: "t", targetIsBoss: false, targetStatus: "FROZEN" });
  assert.equal(frozen("reset-password")?.reasonCode, "TARGET_FROZEN");
});
