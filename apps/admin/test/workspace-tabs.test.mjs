import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canOpenKind,
  changesSettingsContent,
  closeTabs,
  filterTabsByPermission,
  persistTabs,
  restoreTabs,
  sanitizeTabQuery,
  tabFromKeyboard,
  tabFromLocation,
  tabPresentation,
  upsertTab,
} from "../src/workspace/tab-model.ts";

const nav = { isBoss: true, permissions: ["admin.account.read", "admin.role.read", "approval.request.read", "admin.audit.read", "user.account.restore"] };
const limited = { isBoss: false, permissions: [] };

test("settings section or preview switches require leave protection within the same tab", () => {
  const profile = tabFromLocation("/settings", "?section=profile");
  assert.equal(changesSettingsContent(profile, tabFromLocation("/settings", "?section=sessions")), true);
  assert.equal(changesSettingsContent(profile, tabFromLocation("/settings", "?section=profile&preview=1")), true);
  assert.equal(changesSettingsContent(profile, tabFromLocation("/settings", "?section=profile&action=x")), false);
  assert.equal(changesSettingsContent(tabFromLocation("/users"), tabFromLocation("/users", "?q=x")), false);
});

test("detail presentation keeps module names plain and identifies unnamed objects without a visible type prefix", () => {
  const module = tabFromLocation("/supply/reviews");
  const detail = tabFromLocation("/supply/reviews/account-123");
  assert.deepEqual(tabPresentation(module, [module, detail]), { type: undefined, label: "账号供给", description: "账号供给" });
  assert.deepEqual(tabPresentation(detail, [module, detail]), { type: "供给账号", label: "account-123", description: "供给账号详情：account-123" });
  const named = { ...detail, title: "旧来源号 202607210241" };
  assert.equal(tabPresentation(named, [named]).label, named.title);
  assert.equal(tabPresentation({ ...detail, title: "   " }, []).label, "account-123");
});

test("same-type names are disambiguated even when short ID suffixes collide; identity is unchanged", () => {
  const a = { ...tabFromLocation("/users/owner-12345678"), title: "同名用户" };
  const b = { ...tabFromLocation("/users/renter-12345678"), title: "同名用户" };
  assert.equal(tabPresentation(a, [a, b]).label, "同名用户 · owner-12345678");
  assert.equal(tabPresentation(b, [a, b]).label, "同名用户 · renter-12345678");
  assert.equal(upsertTab([a, b], { ...a, title: "新名字" }).length, 2);
  assert.equal(tabPresentation({ ...a, title: "新名字" }, [a, b]).label, "新名字");
});

test("left and right batch close bind the target rather than the active tab and always retain workbench", () => {
  const tabs = [tabFromLocation("/workbench"), tabFromLocation("/admins"), tabFromLocation("/roles"), tabFromLocation("/account")];
  assert.deepEqual(closeTabs(tabs, "account", "left", "roles").tabs.map(t => t.id), ["workbench", "roles", "account"]);
  assert.equal(closeTabs(tabs, "account", "left", "roles").activeId, "account");
  assert.deepEqual(closeTabs(tabs, "account", "right", "admins").tabs.map(t => t.id), ["workbench", "admins"]);
  assert.ok(["workbench", "admins"].includes(closeTabs(tabs, "account", "right", "admins").activeId));
});

test("object tabs are de-duplicated by type and stable id", () => {
  const first = tabFromLocation("/admins/ZZ00001");
  const second = tabFromLocation("/admins/ZZ00001", "q=1");
  const other = tabFromLocation("/admins/ZZ00002");
  const tabs = upsertTab(upsertTab([tabFromLocation("/workbench")], first), second);
  assert.equal(tabs.filter((tab) => tab.id === "admin:ZZ00001").length, 1);
  const withOther = upsertTab(tabs, other);
  assert.equal(withOther.filter((tab) => tab.kind === "admin-object").length, 2);
});

test("order tabs use the list singleton and stable order object IDs", () => {
  const list = tabFromLocation("/orders", "status=PAID&displayNo=ZZ-should-not-be-here&renterUserId=user-1&ownerUserId=user-2&createdFrom=2026-09-01T00:00:00.000Z&createdTo=2026-10-01T00:00:00.000Z&qKind=party&qValue=private-clue");
  const detail = tabFromLocation("/orders/order_123");
  assert.equal(list.id, "orders");
  assert.equal(list.kind, "orders");
  assert.equal(list.query.status, "PAID");
  assert.equal(list.query.displayNo, undefined);
  assert.equal(list.query.qKind, undefined);
  assert.equal(list.query.qValue, undefined);
  assert.equal(list.query.renterUserId, undefined);
  assert.equal(list.query.ownerUserId, undefined);
  assert.equal(list.query.createdFrom, undefined);
  assert.equal(list.query.createdTo, undefined);
  assert.equal(detail.id, "order:order_123");
  assert.equal(detail.kind, "order-object");
  assert.equal(detail.objectId, "order_123");
  assert.equal(canOpenKind("orders", limited), true, "direct access can render the server-denied permission state");
  assert.equal(canOpenKind("order-object", limited), true);
});

test("list modules stay single-instance while workbench cannot close", () => {
  const workbench = tabFromLocation("/workbench");
  const admins = tabFromLocation("/admins", "page=2");
  const again = tabFromLocation("/admins", "page=3");
  const tabs = upsertTab(upsertTab([workbench], admins), again);
  assert.equal(tabs.filter((tab) => tab.id === "admins").length, 1);
  const closed = closeTabs(tabs, "admins", "self", "workbench");
  assert.equal(closed.tabs.some((tab) => tab.id === "workbench"), true);
});

test("sensitive query keys are excluded from persistence", () => {
  const sanitized = sanitizeTabQuery({
    tab: "pending",
    password: "secret",
    totpCode: "123456",
    pin: "111111",
    backupCode: "AbCdE",
    credential: "abc",
    temporaryPassword: "tmp",
    q: "ZZ00001",
  });
  assert.deepEqual(sanitized, { tab: "pending", q: "ZZ00001" });
  const memory = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
    clear: () => memory.clear(),
    key: (index) => [...memory.keys()][index] ?? null,
    get length() { return memory.size; },
  };
  persistTabs("admin-1", {
    activeId: "account",
    tabs: [{ ...tabFromLocation("/account"), query: { password: "nope", tab: "ok" } }],
  });
  const restored = restoreTabs("admin-1", nav);
  assert.equal(restored?.tabs[0]?.query.password, undefined);
  assert.equal(JSON.stringify(memory.get("zzsh-admin-workspace-tabs:admin-1") ?? "").includes("nope"), false);
});

test("admin list query is stored on the tab and restored from the URL", () => {
  const tab = tabFromLocation("/admins", "q=zz&status=ACTIVE&page=2");
  assert.equal(tab.id, "admins");
  assert.equal(tab.query.q, "zz");
  assert.equal(tab.query.status, "ACTIVE");
  assert.equal(tab.query.page, "2");
  assert.equal(tab.query.password, undefined);
});

test("tab keyboard moves across the list and closes the closable tab", () => {
  const tabs = [tabFromLocation("/workbench"), tabFromLocation("/admins"), tabFromLocation("/account")];
  assert.deepEqual(tabFromKeyboard(tabs, "workbench", "ArrowRight"), { type: "activate", id: "admins" });
  assert.deepEqual(tabFromKeyboard(tabs, "admins", "ArrowLeft"), { type: "activate", id: "workbench" });
  assert.deepEqual(tabFromKeyboard(tabs, "admins", "Home"), { type: "activate", id: "workbench" });
  assert.deepEqual(tabFromKeyboard(tabs, "workbench", "End"), { type: "activate", id: "account" });
  assert.deepEqual(tabFromKeyboard(tabs, "admins", "Delete"), { type: "close", id: "admins" });
  assert.equal(tabFromKeyboard(tabs, "workbench", "Delete"), null);
});

test("permission loss removes protected tabs and falls back to workbench", () => {
  const tabs = [
    tabFromLocation("/workbench"),
    tabFromLocation("/admins"),
    tabFromLocation("/account"),
  ];
  const filtered = filterTabsByPermission(tabs, limited);
  assert.equal(filtered.some((tab) => tab.id === "admins"), false);
  assert.equal(filtered.some((tab) => tab.id === "account"), true);
  assert.equal(canOpenKind("admins", limited), false);
  assert.equal(canOpenKind("account", limited), true);
});
