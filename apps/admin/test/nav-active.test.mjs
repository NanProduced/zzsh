import assert from "node:assert/strict";
import { test } from "node:test";

import { titleForPath, workspaceMenuItems } from "../src/workspace/nav-config.ts";
import { activeNavPath, navEntryIsActive, navItemPaths } from "../src/workspace/nav-path.ts";
import { tabFromLocation } from "../src/workspace/tab-model.ts";

/** 真实 Boss 权限集（2026-10-18 只读 GET /api/bff/admin/session 实测 68 项，按能力族列出）。 */
const BOSS_PERMISSIONS = [
  "admin.account.read", "admin.role.read", "admin.permission.read", "admin.audit.read",
  "approval.request.read", "approval.request.approve", "approval.template.read", "approval.audit.read",
  "content.platform.read", "content.platform.edit", "content.platform.publish", "content.read",
  "credit.read", "credit.decide", "credit.guarantee.read", "credit.guarantee.manage",
  "finance.read", "finance.document.read",
  "im.support.read",
  "membership.growth.read.summary", "membership.policy.draft", "membership.policy.publish",
  "order.read", "order.settlement.write",
  "personal.distribution.policy.read", "personal.distribution.policy.manage",
  "supply.catalog.manage", "supply.gunsmith.manage", "supply.review.read", "supply.rules.edit",
  "supply.rental_account.read",
  "user.account.freeze", "user.account.unfreeze", "user.directory.read",
];
const boss = { isBoss: true, permissions: BOSS_PERMISSIONS };

/** 与侧栏同一遍历口径：只统计当前权限下真实渲染的入口。 */
function menuPaths(nav) {
  return navItemPaths(workspaceMenuItems(nav));
}

function activeEntries(pathname, search = "", nav = boss) {
  return menuPaths(nav).filter((path) => navEntryIsActive(path, { pathname, search }));
}

test("每条目标路由只有唯一活动入口，不再按前缀点亮父级", () => {
  const cases = [
    ["/finance", "", ["/finance"]],
    ["/finance/period", "", ["/finance/period"]],
    ["/finance/documents/doc_1", "", ["/finance"]],
    ["/finance/users/user_1", "", ["/finance"]],
    ["/users", "", ["/users"]],
    ["/users/restore", "", ["/users"]],
    ["/users/user_1", "?section=orders", ["/users"]],
    ["/orders", "", ["/orders"]],
    ["/orders/order_1", "", ["/orders"]],
    ["/supply/reviews", "", ["/supply/reviews"]],
    ["/supply/reviews/account_1", "?context=situation", ["/supply/reviews"]],
    ["/supply/media", "", ["/supply/media"]],
    ["/supply/catalog", "", ["/supply/catalog"]],
    ["/supply/gunsmith", "", ["/supply/gunsmith"]],
    ["/supply/rules", "?section=overview", ["/supply/rules?section=overview"]],
    ["/supply/rules", "?section=pricing", ["/supply/rules?section=pricing"]],
    ["/supply/rules", "?section=skin", ["/supply/rules?section=skin"]],
    ["/approvals", "", ["/approvals"]],
    ["/approvals/req_1", "", ["/approvals"]],
    ["/audit", "", ["/audit"]],
    ["/admins", "", ["/admins"]],
    ["/admins/admin_1", "", ["/admins"]],
    ["/roles", "", ["/roles"]],
    ["/roles/role_1", "", ["/roles"]],
    ["/membership-growth", "", ["/membership-growth"]],
    ["/distribution-policy", "", ["/distribution-policy"]],
    ["/content", "", ["/content"]],
    ["/support", "", ["/support"]],
    ["/workbench", "", ["/workbench"]],
  ];
  for (const [pathname, search, expected] of cases) {
    assert.deepEqual(activeEntries(pathname, search), expected, `${pathname}${search} 的唯一活动入口`);
  }
});

test("带 query 的入口只在对应分区点亮，旧入口与分区入口互不双亮", () => {
  assert.deepEqual(activeEntries("/settings", "?section=security"), ["/settings?section=security"]);
  assert.deepEqual(activeEntries("/settings", "?section=appearance"), []);
  assert.deepEqual(activeEntries("/settings", ""), []);
  assert.equal(navEntryIsActive("/settings?section=security", { pathname: "/settings", search: "?section=profile" }), false);
  // 旧地址 /account 打开同一安全页；任一状态下都只有一个入口亮，且旧地址仍可用。
  assert.deepEqual(activeEntries("/account", ""), []);
  assert.equal(activeNavPath(["/account", "/settings?section=security"], { pathname: "/settings", search: "?section=security" }), "/settings?section=security");
});

test("侧栏菜单保留全部既有入口与分组命名一致性", () => {
  const items = workspaceMenuItems(boss);
  const titles = items.filter((item) => item.isTitle).map((item) => item.label);
  assert.deepEqual(titles, ["工作区", "客户服务", "会员运营", "系统与安全", "供给与目录", "供给与规则", "三角洲行动", "运营内容", "资金", "交易", "用户与会员", "审批与审计", "个人"]);
  for (const title of titles) {
    assert.equal(items.filter((item) => item.path).some((item) => item.label === title), false, `组名不得与组内入口同名：${title}`);
  }
  assert.equal(items.find((item) => item.path === "/approvals").label, "审批中心", "侧栏与页内审批命名一致");
  const paths = menuPaths(boss);
  assert.equal(paths.length, 26, "真实 Boss 权限下 26 个入口（含系统配置；账号恢复页已退役；规则与价目拆为 7 个分区入口）");
  assert.equal(paths.includes("/users/restore"), false, "账号恢复入口已移除");
  for (const path of ["/system", "/distribution-policy", "/supply/media", "/finance/period", "/settings?section=security"]) {
    assert.ok(paths.includes(path), `保留既有入口 ${path}`);
  }
});

test("权限裁剪后不误点亮无权限入口", () => {
  const limited = { isBoss: false, permissions: ["user.directory.read"] };
  assert.deepEqual(activeEntries("/audit", "", limited), []);
  assert.deepEqual(activeEntries("/users", "", limited), ["/users"]);
  assert.deepEqual(activeEntries("/users/restore", "", limited), ["/users"], "旧恢复地址落到用户管理");
  assert.equal(activeNavPath(menuPaths(limited), { pathname: "/finance/period", search: "" }), null);
  assert.equal(menuPaths(limited).includes("/supply/reviews"), false);
});

test("侧栏入口名、页面标题与工作区标签名一致（同一对象只有一套名称）", () => {
  for (const item of workspaceMenuItems(boss)) {
    if (!item.path) continue;
    const [pathname = "", search = ""] = item.path.split("?");
    if (item.path === "/settings?section=security") {
      // 设置壳下的安全分区：壳名「设置」，页内分区名「登录与安全」由 settings-page 的 SECTIONS 给出。
      assert.equal(tabFromLocation(pathname, `?${search}`).title, "设置", "/settings?section=security 使用设置壳标签");
      assert.ok(["账号安全", "登录与安全"].includes(item.label), "侧栏安全入口名保持在既有命名集合内");
      continue;
    }
    if (pathname === "/supply/rules") {
      // 规则与价目壳下的分区：壳名「规则与价目」，分区名由侧栏入口给出。
      assert.equal(titleForPath(pathname), "规则与价目");
      assert.equal(tabFromLocation(pathname, `?${search}`).title, "规则与价目", `${item.path} 使用规则与价目壳标签`);
      continue;
    }
    assert.equal(titleForPath(pathname), item.label, `${item.path} 的页面标题应与侧栏入口名一致`);
    const tab = tabFromLocation(pathname, search ? `?${search}` : "");
    assert.equal(tab.title, item.label, `${item.path} 的标签名应与入口名一致`);
  }
});

test("异常地址不抛错也不误点亮", () => {
  assert.deepEqual(activeEntries("/", ""), []);
  assert.deepEqual(activeEntries("/unknown-module", ""), []);
  assert.equal(navEntryIsActive("/settings?section=security", { pathname: "//evil.example", search: "" }), false);
  assert.equal(navEntryIsActive("/users", { pathname: "/users/", search: "" }), true, "尾斜杠归一到同一入口");
  assert.equal(navEntryIsActive("/workbench", { pathname: "/workbench/", search: "" }), true, "尾斜杠归一到同一入口");
  assert.equal(navEntryIsActive("/settings?section=security", { pathname: "/settings", search: "?section=%73ecurity" }), true, "query 值按解码后比较");
});
