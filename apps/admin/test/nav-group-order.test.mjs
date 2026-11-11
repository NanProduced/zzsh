/**
 * 侧栏分组顺序：纯规则 + 本地存储。
 * 覆盖评审验收标准里可离线断言的部分：默认一致、刷新保持、按账号隔离、
 * 新分组默认位置、权限隐藏后恢复原位、未知/损坏 ID、恢复默认、固定首尾、
 * 排序后审批角标不丢、存储异常不抛错。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { NAV_GROUP_DEFAULT_ORDER, NAV_GROUP_IDS, workspaceMenuItems } from "../src/workspace/nav-config.ts";
import {
  clearNavGroupOrder,
  movableNavGroupIds,
  moveVisibleNavGroup,
  orderNavGroups,
  readNavGroupOrder,
  sanitizeNavGroupOrder,
  splitNavGroups,
  writeNavGroupOrder,
} from "../src/workspace/nav-group-order.ts";

class FakeStorage {
  constructor() { this.map = new Map(); this.failWrite = false; }
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { if (this.failWrite) throw new Error("quota exceeded"); this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

let storage;
beforeEach(() => {
  storage = new FakeStorage();
  globalThis.localStorage = storage;
});

const groups = (...ids) => ids.flatMap((id) => [
  { label: `分组-${id}`, isTitle: true, groupId: id },
  { label: `页面-${id}`, path: `/${id}`, ...(id === "audit" ? { badge: 3 } : {}) },
]);
const all = () => groups(...NAV_GROUP_DEFAULT_ORDER);
const idsOf = (items) => splitNavGroups(items).map((group) => group.id);
const pagesOf = (items) => items.filter((item) => !item.isTitle).map((item) => item.path);
/** 真实写入路径始终保存完整顺序：把指定分组提到可排序段最前，其余保持默认相对顺序。 */
const completeOrder = (...firstIds) => {
  const movable = movableNavGroupIds(all());
  const head = firstIds.filter((id) => movable.includes(id));
  return ["workspace", ...head, ...movable.filter((id) => !head.includes(id)), "personal"];
};

test("没有保存过顺序时，侧栏与现在完全一致", () => {
  const items = all();
  assert.deepEqual(orderNavGroups(items, null), items);
  assert.deepEqual(orderNavGroups(items, []), items);
  assert.deepEqual(idsOf(orderNavGroups(items, null)), [...NAV_GROUP_DEFAULT_ORDER]);
});

test("已保存顺序即时生效，工作区固定最前、个人固定最后", () => {
  const items = all();
  const saved = completeOrder("orders", "audit", "support");
  const ordered = orderNavGroups(items, saved);
  const ids = idsOf(ordered);
  assert.deepEqual(ids, saved);
  assert.equal(ids[0], "workspace");
  assert.equal(ids.at(-1), "personal");
  assert.equal(new Set(pagesOf(ordered)).size, pagesOf(items).length, "排序不能丢菜单项");
});

test("调整后重新读取（模拟刷新）顺序保持，且不同管理账号互不影响", () => {
  const saved = completeOrder("finance", "orders");
  assert.equal(writeNavGroupOrder("admin-a", saved), true);
  assert.deepEqual(readNavGroupOrder("admin-a"), saved);
  assert.deepEqual(readNavGroupOrder("admin-b"), [...NAV_GROUP_DEFAULT_ORDER]);
  assert.deepEqual(idsOf(orderNavGroups(all(), readNavGroupOrder("admin-a"))), saved);
  assert.deepEqual(idsOf(orderNavGroups(all(), readNavGroupOrder("admin-b"))), [...NAV_GROUP_DEFAULT_ORDER]);
});

test("上线新分组：出现在默认位置附近，已排好的分组相对顺序不变", () => {
  const items = all();
  const saved = completeOrder("orders", "finance").filter((id) => id !== "content");
  const ids = idsOf(orderNavGroups(items, saved));
  assert.deepEqual(ids.filter((id) => id !== "content"), saved, "已排好的分组相对顺序完全不变");
  const defaultIndex = NAV_GROUP_DEFAULT_ORDER.indexOf("content");
  const predecessor = NAV_GROUP_DEFAULT_ORDER[defaultIndex - 1];
  assert.ok(ids.indexOf("content") > ids.indexOf(predecessor), "新分组落在默认位置的前一个分组之后");
  assert.equal(ids[0], "workspace");
  assert.equal(ids.at(-1), "personal");
});

test("失去分组权限后又恢复：隐藏期间不显示，恢复后回到原来排好的位置", () => {
  const saved = completeOrder("audit", "support", "distribution");
  const hidden = all().filter((item) => !(item.isTitle && item.groupId === "support") && item.path !== "/support");
  const whileHidden = idsOf(orderNavGroups(hidden, saved));
  assert.equal(whileHidden.includes("support"), false);
  assert.deepEqual(whileHidden, saved.filter((id) => id !== "support"), "其余已保存分组相对顺序保持");
  assert.deepEqual(idsOf(orderNavGroups(all(), saved)), saved);
  assert.equal(movableNavGroupIds(all()).includes("personal"), false);
  assert.equal(movableNavGroupIds(all()).includes("workspace"), false);
});

test("未知 ID、重复 ID 与损坏内容：静默忽略或回到默认顺序，不抛错", () => {
  const items = all();
  const ordered = orderNavGroups(items, ["workspace", "unknown-group", "audit", "audit", "personal"]);
  assert.equal(idsOf(ordered).filter((id) => id === "audit").length, 1);
  assert.deepEqual(sanitizeNavGroupOrder(["unknown", "orders", "orders"]), ["orders"]);
  storage.setItem("zzsh.admin.navGroupOrder.v1:admin-bad", "{not-json");
  assert.deepEqual(readNavGroupOrder("admin-bad"), [...NAV_GROUP_DEFAULT_ORDER]);
  storage.setItem("zzsh.admin.navGroupOrder.v1:admin-shape", JSON.stringify({ nope: true }));
  assert.deepEqual(readNavGroupOrder("admin-shape"), [...NAV_GROUP_DEFAULT_ORDER]);
  storage.setItem("zzsh.admin.navGroupOrder.v1:admin-long", JSON.stringify(Array.from({ length: 200 }, () => "orders")));
  assert.deepEqual(readNavGroupOrder("admin-long"), [...NAV_GROUP_DEFAULT_ORDER]);
});

test("恢复默认：删除该账号的 key 后立即回到默认顺序，不影响其他账号", () => {
  writeNavGroupOrder("admin-a", ["workspace", "orders", "finance", "personal"]);
  writeNavGroupOrder("admin-b", ["workspace", "audit", "support", "personal"]);
  clearNavGroupOrder("admin-a");
  assert.deepEqual(readNavGroupOrder("admin-a"), [...NAV_GROUP_DEFAULT_ORDER]);
  assert.deepEqual(readNavGroupOrder("admin-b"), ["workspace", "audit", "support", "personal"]);
  assert.deepEqual(orderNavGroups(all(), readNavGroupOrder("admin-a")), all());
});

test("上移/下移只与相邻的可见分组交换，边界不越界", () => {
  const full = [...NAV_GROUP_DEFAULT_ORDER];
  const visible = ["support", "distribution", "system"];
  const moved = moveVisibleNavGroup(full, visible, "distribution", -1);
  assert.equal(moved.indexOf("support"), 2, "与相邻可见分组交换");
  assert.equal(moved.indexOf("distribution"), 1);
  assert.deepEqual(moveVisibleNavGroup(full, visible, "support", -1), full);
  assert.deepEqual(moveVisibleNavGroup(full, visible, "system", 1), full);
  assert.deepEqual(moveVisibleNavGroup(full, visible, "finance", -1), full, "不可见分组不能移动");
});

test("排序后审批角标仍挂在审批中心上", () => {
  const ordered = orderNavGroups(all(), ["workspace", "audit", "orders", "personal"]);
  const approval = ordered.find((item) => item.path === "/audit");
  assert.equal(approval.badge, 3);
  assert.equal(ordered.filter((item) => item.badge === 3).length, 1);
});

test("「会员与礼遇」并入「用户与会员」，不再有独立的「会员运营」分组", () => {
  const items = workspaceMenuItems({ isBoss: true, permissions: ["user.directory.read"] });
  const groups = splitNavGroups(items);
  const userGroup = groups.find((group) => group.label === "用户与会员");
  assert.ok(userGroup, "用户与会员分组仍存在");
  assert.equal(groups.some((group) => group.label === "会员运营"), false);
  assert.equal(NAV_GROUP_IDS["会员运营"], undefined);
  assert.equal(NAV_GROUP_DEFAULT_ORDER.includes("membership"), false);
  const labels = userGroup.items.filter((item) => !item.isTitle).map((item) => item.label);
  assert.deepEqual(labels, ["用户管理", "头像审核", "会员与礼遇"]);
  assert.equal(items.some((item) => item.path === "/membership-growth"), true, "会员与礼遇入口不能丢");

  // 只有会员审批权限、没有用户目录权限时，分组仍应显示且只露出有权访问的入口。
  const limited = workspaceMenuItems({ isBoss: false, permissions: ["approval.request.create", "membership.entitlement.request"] });
  const limitedGroups = splitNavGroups(limited);
  assert.equal(limitedGroups.some((group) => group.label === "会员运营"), false);
  const limitedUsers = limitedGroups.find((group) => group.label === "用户与会员");
  assert.ok(limitedUsers);
  assert.deepEqual(limitedUsers.items.filter((item) => !item.isTitle).map((item) => item.label), ["会员与礼遇"]);
});

test("存储不可用时降级为默认顺序，不抛错也不假装保存成功", () => {
  storage.failWrite = true;
  assert.equal(writeNavGroupOrder("admin-a", ["workspace", "orders", "personal"]), false);
  assert.deepEqual(readNavGroupOrder("admin-a"), [...NAV_GROUP_DEFAULT_ORDER]);
  const bare = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  globalThis.localStorage = bare;
  assert.deepEqual(readNavGroupOrder("admin-a"), [...NAV_GROUP_DEFAULT_ORDER]);
  assert.equal(writeNavGroupOrder("admin-a", ["orders"]), false);
  assert.doesNotThrow(() => clearNavGroupOrder("admin-a"));
});
