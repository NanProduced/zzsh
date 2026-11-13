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
    ["/finance", "?q=OLD-ORDER", ["/finance/records"]],
    ["/finance/period", "", []],
    ["/finance/search", "", ["/finance/records"]],
    ["/finance/records", "", ["/finance/records"]],
    ["/finance/records/history", "", ["/finance/records"]],
    ["/finance/balances", "", ["/finance/balances"]],
    ["/finance/balances/history", "", ["/finance/balances"]],
    ["/finance/balances/opening", "", ["/finance/balances"]],
    ["/finance/channels", "", ["/finance/channels"]],
    ["/finance/documents/doc_1", "", ["/finance/records"]],
    ["/finance/users/user_1", "", ["/finance/records"]],
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
    ["/distribution", "", ["/distribution"]],
    ["/distribution/earnings", "", ["/distribution/earnings"]],
    ["/distribution/participants", "", ["/distribution/participants"]],
    ["/distribution/participants/user_1", "", ["/distribution/participants"]],
    ["/distribution/policy", "", ["/distribution/policy"]],
    ["/distribution-policy", "", []],
    ["/content", "", ["/content/help"]],
    ["/content", "?tab=news", ["/content/updates"]],
    ["/content/updates", "?tab=announcement", ["/content/updates"]],
    ["/content/legal", "", ["/content/legal"]],
    ["/docs", "", ["/docs"]],
    ["/docs/doc_a", "", ["/docs"]],
    ["/support", "", ["/support"]],
    ["/workbench", "", ["/workbench"]],
  ];
  for (const [pathname, search, expected] of cases) {
    assert.deepEqual(activeEntries(pathname, search), expected, `${pathname}${search} 的唯一活动入口`);
  }
});

test("带 query 的入口只在对应分区点亮，旧入口与分区入口互不双亮", () => {
  assert.deepEqual(activeEntries("/settings", "?section=security"), [], "账号安全入口在头像菜单，不再占用侧栏");
  assert.deepEqual(activeEntries("/settings", "?section=appearance"), []);
  assert.deepEqual(activeEntries("/settings", ""), []);
  assert.equal(navEntryIsActive("/settings?section=security", { pathname: "/settings", search: "?section=profile" }), false);
  // 旧地址 /account 打开同一安全页；旧地址仍可用，但不点亮侧栏。
  assert.deepEqual(activeEntries("/account", ""), []);
  assert.equal(activeNavPath(["/account", "/settings?section=security"], { pathname: "/settings", search: "?section=security" }), "/settings?section=security");
});

test("侧栏菜单保留全部既有入口与分组命名一致性", () => {
  const items = workspaceMenuItems(boss);
  const titles = items.filter((item) => item.isTitle).map((item) => item.label);
  assert.deepEqual(titles, ["工作区", "客户服务", "交易", "资金", "用户与会员", "分销", "运营内容", "审批与审计", "规则与价目", "目录与素材", "系统与安全"]);
  for (const title of titles) {
    assert.equal(items.filter((item) => item.path).some((item) => item.label === title), false, `组名不得与组内入口同名：${title}`);
  }
  assert.equal(items.find((item) => item.path === "/approvals").label, "审批中心", "侧栏与页内审批命名一致");
  const paths = menuPaths(boss);
  assert.equal(paths.length, 41, "账号安全入口移到头像菜单后少一项；其余入口保留");
  assert.deepEqual(paths.filter((path) => path.startsWith("/content")), ["/content/help", "/content/updates", "/content/legal", "/content/pages", "/content/media"]);
  assert.equal(paths.includes("/users/restore"), false, "账号恢复入口已移除");
  assert.equal(paths.includes("/finance/period"), false, "期间核对从导航移除，旧链接仍可使用");
  assert.equal(paths.includes("/settings?section=security"), false, "账号安全入口移到头像菜单");
  assert.equal(items.find((item) => item.path === "/finance").label, "资金与经营看板");
  for (const path of ["/system","/distribution","/distribution/earnings","/distribution/participants","/distribution/policy","/supply/media","/support","/support/mine","/support/overview","/support/patrol","/support/settings","/avatar-reviews"]) {
    assert.ok(paths.includes(path), `保留既有入口 ${path}`);
  }
  assert.deepEqual(paths.filter((path) => path.startsWith("/supply/rules")), [
    "/supply/rules?section=overview", "/supply/rules?section=deposit", "/supply/rules?section=settlement", "/supply/rules?section=agreement",
    "/supply/rules?section=pricing", "/supply/rules?section=items", "/supply/rules?section=skin",
  ], "同一规则页面壳的 7 个分区不再拆到两个组");
  assert.equal(items.find((item) => item.path === "/supply/reviews").label, "出租账号");
  assert.equal(items.find((item) => item.path === "/supply/catalog").label, "游戏目录");
  assert.equal(items.find((item) => item.path === "/supply/media").label, "素材审核");
  assert.equal(items.find((item) => item.path === "/operation-log").label, "操作日志");
  const groupOf = (path) => {
    let group = "";
    for (const item of items) {
      if (item.isTitle) group = item.label;
      if (item.path === path) return group;
    }
    return null;
  };
  assert.equal(groupOf("/orders"), "交易");
  assert.equal(groupOf("/supply/reviews"), "交易");
  assert.equal(groupOf("/operation-log"), "审批与审计");
  assert.equal(groupOf("/supply/catalog"), "目录与素材");
  assert.equal(groupOf("/supply/media"), "目录与素材");
  assert.equal(groupOf("/supply/rules?section=pricing"), "规则与价目");
  assert.equal(titles.includes("个人"), false, "个人分组已移除");
  assert.equal(titles.includes("三角洲行动"), false, "游戏名不再作为一级分组");
  assert.equal(titles.includes("供给与目录"), false);
  assert.equal(titles.includes("供给与规则"), false);
});

test("侧栏每个入口使用不同且业务可区分的图标", () => {
  const items = workspaceMenuItems(boss).filter((item) => item.path);
  assert.equal(items.length, 41);
  const names = items.map((item) => item.icon?.displayName ?? item.icon?.name ?? "NO_ICON");
  assert.equal(names.filter((name) => name === "NO_ICON").length, 0, "每个入口都要有图标");
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  assert.deepEqual(duplicates, [], `图标不得重复：${duplicates.join("、")}`);
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
