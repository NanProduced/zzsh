import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canOpenKind,
  closeTabs,
  filterTabsByPermission,
  persistTabs,
  restoreTabs,
  sanitizeTabQuery,
  tabFromKeyboard,
  tabFromLocation,
  upsertTab,
} from "../src/workspace/tab-model.ts";

const nav = { isBoss: true, permissions: ["admin.account.read", "admin.role.read", "approval.request.read", "admin.audit.read", "user.account.restore"] };
const limited = { isBoss: false, permissions: [] };

test("object tabs are de-duplicated by type and stable id", () => {
  const first = tabFromLocation("/admins/ZZ00001");
  const second = tabFromLocation("/admins/ZZ00001", "q=1");
  const other = tabFromLocation("/admins/ZZ00002");
  const tabs = upsertTab(upsertTab([tabFromLocation("/workbench")], first), second);
  assert.equal(tabs.filter((tab) => tab.id === "admin:ZZ00001").length, 1);
  const withOther = upsertTab(tabs, other);
  assert.equal(withOther.filter((tab) => tab.kind === "admin-object").length, 2);
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
