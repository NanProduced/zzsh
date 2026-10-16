import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accessSummaryOf,
  directoryActionBlockedReason,
  eligibilityOf,
  EMPTY_FILTERS,
  filterAdminEntries,
  hasActiveFilters,
  clampPage,
  planDirectoryActions,
  parseListQuery,
  scopeSummaryOf,
  securitySummaryOf,
  sortAdminEntries,
} from "../src/lib/admin-directory-list.ts";

const entry = (overrides = {}) => ({
  id: "id-x",
  username: "ZZ00009",
  name: "同事",
  status: "ACTIVE",
  ...overrides,
});

test("业务范围四态各自成立，缺字段不塌成无范围或 0", () => {
  assert.equal(scopeSummaryOf(entry()).label, "未提供");
  assert.equal(scopeSummaryOf(entry()).known, false);
  assert.equal(scopeSummaryOf(entry({ scopeSummary: { mode: "ALL_GAMES" } })).label, "全部游戏");
  assert.equal(scopeSummaryOf(entry({ scopeSummary: { mode: "SELECTED_GAMES", gameCount: 0 } })).label, "无业务范围");
  assert.equal(scopeSummaryOf(entry({ scopeSummary: { mode: "SELECTED_GAMES", gameCount: 3 } })).label, "指定 3 个游戏");
  assert.equal(scopeSummaryOf(entry({ scopeSummary: { mode: "SELECTED_GAMES" } })).label, "指定游戏 · 数量未提供");
  // ALL_GAMES 下历史勾选行仍然存在，数它会给出错误数字。
  assert.equal(scopeSummaryOf(entry({ scopeSummary: { mode: "ALL_GAMES" } })).filterValue, "ALL_GAMES");
});

test("访问配置不把无角色说成无权限，也不把缺读取说成无例外", () => {
  assert.deepEqual(
    { roles: accessSummaryOf(entry()).roles, exception: accessSummaryOf(entry()).exception },
    { roles: "无权查看", exception: "例外未提供" },
  );
  assert.equal(accessSummaryOf(entry({ roles: [] })).roles, "未分配角色");
  const onlyExceptions = accessSummaryOf(entry({ roles: [], personalGrantSummary: { allows: 2, denies: 0 } }));
  assert.equal(onlyExceptions.roles, "未分配角色");
  assert.equal(onlyExceptions.exception, "允许 2 · 禁止 0", "没有角色仍可能有直接授权，不能表达成无权限");
  assert.equal(accessSummaryOf(entry({ roles: [], personalGrantSummary: { allows: 0, denies: 0 } })).exception, "无个人例外");
  assert.equal(accessSummaryOf(entry({ roles: [{ code: "ops", name: "运营", status: "ACTIVE" }, { code: "old", name: "旧角色", status: "DISABLED" }] })).disabledCount, 1);
});

test("登录与安全优先给出真正需要处理的事实，而不是把缺字段当成未启用", () => {
  assert.equal(securitySummaryOf(entry()).headline, "未提供");
  const pending = securitySummaryOf(entry({ status: "PENDING_ENROLLMENT", securitySummary: { passwordChangeRequired: false, twoFactorEnabled: null, bootstrapExpiresAt: "2026-10-20T00:00:00Z", firstActivatedAt: null } }));
  assert.equal(pending.headline, "待激活");
  assert.deepEqual({ label: pending.timeLabel, time: pending.time }, { label: "引导有效期至", time: "2026-10-20T00:00:00Z" }, "时间只给原始值，格式化由视图层负责");
  const mustChange = securitySummaryOf(entry({ securitySummary: { passwordChangeRequired: true, twoFactorEnabled: true, bootstrapExpiresAt: null, firstActivatedAt: null } }));
  assert.equal(mustChange.headline, "需修改密码");
  assert.equal(mustChange.time, null, "需改密时不拿完整登录时间当重点");
  assert.equal(securitySummaryOf(entry({ securitySummary: { passwordChangeRequired: false, twoFactorEnabled: null, bootstrapExpiresAt: null, firstActivatedAt: "x" } })).headline, "双因素状态未提供");
  assert.equal(securitySummaryOf(entry({ securitySummary: { passwordChangeRequired: false, twoFactorEnabled: false, bootstrapExpiresAt: null, firstActivatedAt: null } })).headline, "双因素未启用", "false 是事实，不能和 null 混为一谈");
});

test("F2 行菜单的资格判定：缺预检一律禁用并说明，明确允许才放开", () => {
  const noActions = entry();
  assert.deepEqual(
    planDirectoryActions(noActions).map((plan) => [plan.action, plan.blockedReason]),
    [
      ["update", "操作资格未提供"],
      ["assign", "操作资格未提供"],
      ["scope", "操作资格未提供"],
      ["freeze", "操作资格未提供"],
      ["force-logout", "操作资格未提供"],
    ],
    "旧运行版本不返回 actions 时，六个入口都不能看起来可操作",
  );
  const emptyActions = entry({ actions: [] });
  assert.ok(emptyActions && planDirectoryActions(emptyActions).every((plan) => plan.blockedReason === "操作资格未提供"));
  const explicit = entry({
    actions: [
      { action: "update", allowed: true, reasonCode: "OK", needsReauthentication: false, needsFullGrantBaseline: false },
      { action: "freeze", allowed: false, reasonCode: "BOSS_ACTOR_REQUIRED", needsReauthentication: true, needsFullGrantBaseline: false },
    ],
  });
  const byAction = new Map(planDirectoryActions(explicit).map((plan) => [plan.action, plan]));
  assert.equal(byAction.get("update")?.blockedReason, null, "明确允许才放开");
  assert.equal(byAction.get("freeze")?.blockedReason, "仅限 Boss 执行");
  assert.equal(byAction.get("assign")?.blockedReason, "操作资格未提供", "给了部分预检时，缺的那几项仍按未知禁用");
  assert.deepEqual(planDirectoryActions(entry({ status: "FROZEN" })).map((plan) => plan.action), ["update", "assign", "scope", "unfreeze", "force-logout"], "冻结目标给解冻而不是冻结");
});

test("快捷入口与菜单共用缺预检判定，只有布尔 true 放行", () => {
  for (const actions of [undefined, [], [{ action: "assign", allowed: true, reasonCode: "OK" }]]) {
    assert.equal(directoryActionBlockedReason(entry({ actions }), "update"), "操作资格未提供");
  }
  assert.equal(directoryActionBlockedReason(undefined, "update"), "操作资格未提供");
  assert.equal(directoryActionBlockedReason(entry({ actions: [{ action: "update", allowed: true, reasonCode: "OK" }] }), "update"), null);
  assert.equal(directoryActionBlockedReason(entry({ actions: [{ action: "update", allowed: false, reasonCode: "PERMISSION_REQUIRED" }] }), "update"), "没有该操作的权限");
  assert.notEqual(directoryActionBlockedReason(entry({ actions: [{ action: "update", allowed: "true", reasonCode: "OK" }] }), "update"), null);
});

test("状态排序用业务顺序而不是字典序，未登记值排最后", () => {
  const rows = [
    entry({ username: "ZZ00003", status: "ACTIVE" }),
    entry({ username: "ZZ00001", status: "PENDING_ENROLLMENT" }),
    entry({ username: "ZZ00002", status: "FROZEN" }),
    entry({ username: "ZZ00004", status: "SOMETHING_NEW" }),
  ];
  assert.deepEqual(sortAdminEntries(rows, "status", "asc").map((row) => row.status), ["PENDING_ENROLLMENT", "FROZEN", "ACTIVE", "SOMETHING_NEW"]);
  assert.deepEqual(sortAdminEntries(rows, "status", "desc").map((row) => row.status).slice(0, 3), ["ACTIVE", "FROZEN", "PENDING_ENROLLMENT"]);
});

test("排序作用于完整匹配结果，分页只是排序之后切片", () => {
  const rows = Array.from({ length: 7 }, (_, index) => entry({ username: `ZZ${String(index).padStart(5, "0")}`, name: `同事${index}`, status: index === 6 ? "FROZEN" : "ACTIVE" }));
  const sorted = sortAdminEntries(rows, "status", "asc");
  assert.equal(sorted[0]?.status, "FROZEN", "先排序再分页，冻结账号才会出现在第一页");
  const firstPage = sorted.slice(0, 3);
  assert.equal(firstPage[0]?.status, "FROZEN");
  assert.equal(sortAdminEntries(rows, "status", "asc").length, rows.length, "排序不得丢行");
});

test("范围与安全的未知值排在有值之后，不冒充最小值", () => {
  const rows = [
    entry({ username: "ZZ00001", name: "未知范围" }),
    entry({ username: "ZZ00002", name: "全部游戏", scopeSummary: { mode: "ALL_GAMES" } }),
    entry({ username: "ZZ00003", name: "两个游戏", scopeSummary: { mode: "SELECTED_GAMES", gameCount: 2 } }),
    entry({ username: "ZZ00004", name: "无范围", scopeSummary: { mode: "SELECTED_GAMES", gameCount: 0 } }),
  ];
  assert.deepEqual(sortAdminEntries(rows, "scope", "asc").map((row) => row.name), ["全部游戏", "无范围", "两个游戏", "未知范围"]);
});

test("筛选条按四个维度收敛，重置回到全集", () => {
  const rows = [
    entry({ id: "a", username: "zz00001", name: "周宁", status: "ACTIVE", scopeSummary: { mode: "ALL_GAMES" }, roles: [{ id: "r-ops", code: "ops", name: "运营" }] }),
    entry({ id: "b", username: "zz00002", name: "林悦", status: "FROZEN", scopeSummary: { mode: "SELECTED_GAMES", gameCount: 0 } }),
    entry({ id: "c", username: "zz00003", name: "阿航", status: "PENDING_ENROLLMENT", scopeSummary: { mode: "SELECTED_GAMES", gameCount: 4 }, roles: [{ id: "r-cs", code: "cs", name: "客服" }] }),
  ];
  assert.equal(filterAdminEntries(rows, EMPTY_FILTERS).length, 3);
  assert.equal(hasActiveFilters(EMPTY_FILTERS), false);
  assert.equal(filterAdminEntries(rows, { ...EMPTY_FILTERS, q: " 林悦 " })[0]?.id, "b", "搜索要修剪空白，按姓名或账号命中");
  assert.equal(filterAdminEntries(rows, { ...EMPTY_FILTERS, q: "zz00003" })[0]?.id, "c");
  assert.equal(filterAdminEntries(rows, { ...EMPTY_FILTERS, status: "FROZEN" }).map((row) => row.id).join(), "b");
  assert.equal(filterAdminEntries(rows, { ...EMPTY_FILTERS, role: "r-cs" }).map((row) => row.id).join(), "c");
  assert.equal(filterAdminEntries(rows, { ...EMPTY_FILTERS, role: "ops" }).map((row) => row.id).join(), "a", "也接受角色码");
  assert.equal(filterAdminEntries(rows, { ...EMPTY_FILTERS, scope: "NO_SCOPE" }).map((row) => row.id).join(), "b");
  assert.equal(filterAdminEntries(rows, { ...EMPTY_FILTERS, scope: "UNKNOWN" }).length, 0, "b 的范围是确定的无范围，不该归进未提供");
  const withUnknownScope = [...rows, entry({ id: "d", username: "zz00004", name: "缺范围", scopeSummary: undefined })];
  assert.equal(filterAdminEntries(withUnknownScope, { ...EMPTY_FILTERS, scope: "UNKNOWN" }).map((row) => row.id).join(), "d");
  assert.equal(filterAdminEntries(withUnknownScope, EMPTY_FILTERS).length, 4, "未提供的行仍然出现在未筛选的列表里");
  assert.equal(hasActiveFilters({ ...EMPTY_FILTERS, scope: "ALL_GAMES" }), true);
});

test("未登记状态与未知值在任何方向下都留在末尾", () => {
  const known = { passwordChangeRequired: false, twoFactorEnabled: true, bootstrapExpiresAt: null, firstActivatedAt: null };
  const rows = [
    entry({ username: "ZZ00001", name: "未知状态", status: "SOMETHING_NEW", securitySummary: known }),
    entry({ username: "ZZ00002", name: "无安全事实", status: "ACTIVE" }),
    entry({ username: "ZZ00003", name: "正常", status: "ACTIVE", securitySummary: known }),
  ];
  assert.equal(sortAdminEntries(rows, "status", "desc")[2]?.status, "SOMETHING_NEW", "反向排序不得把读不懂的值顶到最前");
  assert.equal(sortAdminEntries(rows, "security", "desc")[2]?.name, "无安全事实", "反向排序也不得把未知顶到最前");
  assert.equal(sortAdminEntries(rows, "security", "asc")[2]?.name, "无安全事实");
});

test("操作资格预检按动作取值，缺席就是没有预检而不是允许", () => {
  const withActions = entry({
    actions: [
      { action: "update", allowed: false, reasonCode: "BOSS_ACTOR_REQUIRED", needsReauthentication: false, needsFullGrantBaseline: false },
      { action: "freeze", allowed: true, reasonCode: "OK", needsReauthentication: true, needsFullGrantBaseline: false },
    ],
  });
  assert.equal(eligibilityOf(withActions, "freeze")?.allowed, true);
  assert.equal(eligibilityOf(withActions, "update")?.reasonCode, "BOSS_ACTOR_REQUIRED");
  assert.equal(eligibilityOf(withActions, "assign"), undefined, "服务端没给这个动作就是没有预检，不能当成允许");
});

test("F3 登录与安全列真的按该列呈现的事实排序，两个方向结果不同", () => {
  const known = (over = {}) => ({ passwordChangeRequired: false, twoFactorEnabled: true, bootstrapExpiresAt: null, firstActivatedAt: null, ...over });
  const rows = [
    entry({ username: "ZZ00001", name: "已启用双因素", securitySummary: known(), lastFullAuthenticatedAt: "2026-10-09T00:00:00Z" }),
    entry({ username: "ZZ00002", name: "未启用双因素", securitySummary: known({ twoFactorEnabled: false }) }),
    entry({ username: "ZZ00003", name: "需改密", securitySummary: known({ passwordChangeRequired: true }) }),
    entry({ username: "ZZ00004", name: "待激活", status: "PENDING_ENROLLMENT", securitySummary: known() }),
  ];
  assert.deepEqual(sortAdminEntries(rows, "security", "asc").map((row) => row.name), ["待激活", "需改密", "未启用双因素", "已启用双因素"]);
  assert.deepEqual(sortAdminEntries(rows, "security", "desc").map((row) => row.name), ["已启用双因素", "未启用双因素", "需改密", "待激活"]);
  // 同级内按完整认证时间从旧到新，而不是按账号名。
  const sameLevel = [
    entry({ username: "ZZ00001", name: "较新登录", securitySummary: known(), lastFullAuthenticatedAt: "2026-10-10T00:00:00Z" }),
    entry({ username: "ZZ00009", name: "较旧登录", securitySummary: known(), lastFullAuthenticatedAt: "2026-01-01T00:00:00Z" }),
  ];
  assert.deepEqual(sortAdminEntries(sameLevel, "security", "asc").map((row) => row.name), ["较旧登录", "较新登录"]);
});

test("F4 URL 是外部输入：页码、排序与筛选都要被校验和收敛", () => {
  assert.deepEqual(parseListQuery({ page: "999" }).page, 999, "合法正整数先原样接受，由 clampPage 收敛");
  for (const bad of ["0", "-3", "1.5", "Infinity", "abc", undefined]) {
    assert.equal(parseListQuery({ page: bad }).page, 1, `page=${bad} 必须回落到第一页`);
  }
  assert.equal(parseListQuery({ sort: "notAColumn" }).sort.key, "name");
  assert.equal(parseListQuery({ sort: "status", dir: "desc" }).sort.direction, "desc");
  // 去掉排序参数就是默认值，不能保留上一次的排序。
  assert.deepEqual(parseListQuery({ q: "测试" }).sort, { key: "name", direction: "asc" });
  assert.equal(parseListQuery({ status: "SOMETHING_NEW" }).filters.status, "", "未登记的状态筛选不生效");
  assert.equal(parseListQuery({ scope: "DROP TABLE" }).filters.scope, "");
  assert.equal(clampPage(999, 1), 1);
  assert.equal(clampPage(2, 3), 2);
  assert.equal(clampPage(Number.POSITIVE_INFINITY, 3), 1);
});

test("F5 列表边界用例已登记进标准前端测试入口", async () => {
  const { readFile } = await import("node:fs/promises");
  const scripts = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).scripts;
  for (const entry of ["test:compiled", "test"]) {
    if (!scripts[entry]) continue;
    if (entry === "test") {
      assert.ok(scripts.test.includes("admin-directory-list.test.mjs"), "新增列表套件必须进标准入口，否则正常检查永远漏掉它");
      assert.ok(scripts.test.includes("admin-directory-component.test.mjs"), "组件反例同样要在标准入口内");
    }
  }
});

import { scopedInFlight } from "../src/lib/shared-inflight.ts";

test("E-R1-01 scoped single-flight: same scope coalesces, other scope/session/generation never reuses, failure releases", async () => {
  let calls = 0; const releases = [];
  const read = scopedInFlight(() => { calls += 1; const n = calls; return new Promise((resolve, reject) => releases.push({ resolve: () => resolve({ subject: n }), reject })); });
  const a1 = read("A|s1|g1"); const a2 = read("A|s1|g1");
  assert.equal(a1, a2); assert.equal(calls, 1);
  const b = read("B|s2|g1"); assert.notEqual(b, a1); assert.equal(calls, 2);
  const aAgain = read("A|s1|g1"); assert.notEqual(aAgain, a1, "older scope is forgotten once another scope asked"); assert.equal(calls, 3);
  read("A|s9|g1"); read("A|s9|g2"); assert.equal(calls, 5);
  releases.forEach((r) => r.resolve());
  assert.deepEqual(await b, { subject: 2 });
  const f = scopedInFlight(() => { calls += 1; return Promise.reject(new Error("403")); });
  await assert.rejects(f("A"), /403/); await assert.rejects(f("A"), /403/); assert.equal(calls, 7);
});