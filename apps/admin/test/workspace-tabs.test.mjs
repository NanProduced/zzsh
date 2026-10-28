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
  sanitizeFinanceReturn,
  tabFromKeyboard,
  tabFromLocation,
  tabHref,
  tabPresentation,
  upsertTab,
} from "../src/workspace/tab-model.ts";

const nav = { isBoss: true, permissions: ["admin.account.read", "admin.role.read", "approval.request.read", "admin.audit.read", "user.account.freeze"] };
const limited = { isBoss: false, permissions: [] };

test('finance business numbers retain full digits while phone tokens never enter workspace query storage', () => {
  const business='20260913125844629986';
  assert.equal(sanitizeTabQuery({q:business}).q,business);
  assert.equal(sanitizeTabQuery({q:'ZZ261019-000002'}).q,'ZZ261019-000002');
  for(const q of ['13812345678','+86 138-1234-5678','用户 13812345678 资金','x+86 13812345678y']) assert.equal(sanitizeTabQuery({q}).q,undefined);
  const tab=tabFromLocation('/finance',`q=${business}&page=2&kind=SETTLEMENT`);
  assert.equal(tab.query.q,business);assert.equal(tab.query.page,'2');
});

test('finance reload return is bounded, local, non-nested and strips no phone into storage',()=>{
  const path='/finance?q=20260913125844629986&page=2&kind=WITHDRAWAL';
  assert.equal(sanitizeFinanceReturn(path),path);assert.equal(sanitizeTabQuery({financeReturn:path}).financeReturn,path);
  for(const value of ['https://example.com/finance','//example.com/finance','/\\example.com/finance','/supply/accounts/a1','/finance?financeReturn=%2Ffinance','/finance?q='+encodeURIComponent('+86 138-1234-5678'),'/finance?token=private','/finance?q='+'x'.repeat(2048)]) assert.equal(sanitizeFinanceReturn(value),undefined,value);
  assert.equal(sanitizeFinanceReturn('/orders/order-one?cookie=private'),'/orders/order-one');
});
test('R1 formatted phone clues cannot be persisted or embedded in return paths while long business IDs remain',()=>{
  for(const q of ['+86 (138) 1234-5678','138.1234.5678','＋８６（１３８）１２３４－５６７８','查询 138.1234.5678 退款']){
    assert.equal(sanitizeTabQuery({q}).q,undefined,q);assert.equal(sanitizeFinanceReturn('/finance?q='+encodeURIComponent(q)),undefined,q);
  }
  assert.equal(sanitizeTabQuery({q:'20260913125844629986'}).q,'20260913125844629986');
  for(const q of ['13812345-678a-4abc-8abc-0123456789ab','user_aa13812345678bb0123456789abcdef012345678','ORDER:order_aa13812345678bb0123456789abcdef012345678','http://127.0.0.1:4221/orders/13812345-678a-4abc-8abc-0123456789ab']){assert.equal(sanitizeTabQuery({q}).q,q);assert.ok(sanitizeFinanceReturn('/finance?q='+encodeURIComponent(q)));}
});

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

test("restoring legacy and supply account tabs keeps one canonical object and the active source context", () => {
  const memory = new Map();
  globalThis.sessionStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const reader = { isBoss: false, permissions: ["supply.rental_account.read"] };
  const legacy = { id: "resource:account-one", kind: "resource-object", objectType: "resource", objectId: "account-one", title: "旧来源号 000123", path: "/supply/accounts/account-one", query: { fromOrderId: "order-one", fromUserId: "user-one", fromUserSection: "resources", fromUserPublication: "published" }, closable: true };
  const review = tabFromLocation("/supply/reviews/account-one", "?context=changes&versionId=version-old");
  memory.set("zzsh-admin-workspace-tabs:restore-account", JSON.stringify({ adminUserId: "restore-account", activeId: legacy.id, tabs: [legacy, review] }));
  const restored = restoreTabs("restore-account", reader);
  assert.equal(restored.activeId, "supply:account-one");
  assert.equal(restored.tabs.length, 2, "one account plus workbench");
  const account = restored.tabs.find(tab => tab.id === restored.activeId);
  assert.equal(account.kind, "listing-object");
  assert.equal(account.path, "/supply/reviews/account-one");
  assert.deepEqual(account.query, legacy.query);
  assert.equal(account.title, legacy.title);
  assert.equal(tabHref(legacy).startsWith("/supply/reviews/account-one?"), true);
  const reopened = upsertTab([legacy, review], tabFromLocation("/supply/accounts/account-one", "?fromOrderId=order-two"));
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].id, restored.activeId);
  assert.deepEqual(reopened[0].query, { fromOrderId: "order-two" });
  assert.equal(restoreTabs("restore-account", { isBoss: false, permissions: ["order.read"] }).tabs.length, 1, "lost supply reading removes the restored account");
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


test('return context approval open and close preserves only the bounded membership source subtab', () => {
  const workbench = tabFromLocation('/workbench');
  const member = tabFromLocation('/membership-growth', '?userId=user-a&gameId=game-1&tab=entitlements&page=3');
  const original = structuredClone(member);
  for (const fromTab of ['policy', 'entitlements']) {
    const approval = tabFromLocation('/approvals/member-request', '?from=membership-growth&fromTab=' + fromTab);
    const opened = upsertTab([workbench, member], approval);
    assert.equal(opened.length, 3, 'opening a detail adds only that detail');
    assert.deepEqual(opened.find(tab => tab.id === member.id).query, { ...original.query, tab: fromTab });
    assert.deepEqual(member, original, 'upsert does not mutate the existing source tab');
    const closed = closeTabs(opened, approval.id, 'self', approval.id);
    assert.equal(closed.activeId, member.id);
    assert.deepEqual(closed.tabs.find(tab => tab.id === member.id).query, { ...original.query, tab: fromTab });
    const reopened = upsertTab(upsertTab([workbench, member], approval), { ...approval, title: '同一申请' });
    assert.equal(reopened.filter(tab => tab.id === approval.id).length, 1, 'existing detail still uses the original de-duplication path');
    assert.equal(reopened.find(tab => tab.id === member.id).query.tab, fromTab);
    assert.equal(upsertTab([workbench], approval).some(tab => tab.kind === 'membership-growth'), false, 'no new membership page is created');
  }
  for (const next of [
    tabFromLocation('/approvals/member-request', '?from=users&fromTab=policy'),
    tabFromLocation('/approvals/member-request', '?from=membership-growth&fromTab=unknown'),
    tabFromLocation('/approvals/member-request', '?from=membership-growth'),
    tabFromLocation('/approvals', '?from=membership-growth&fromTab=policy'),
    tabFromLocation('/orders/order-one', '?from=membership-growth&fromTab=policy'),
  ]) assert.deepEqual(upsertTab([workbench, member], next).find(tab => tab.id === member.id), original, 'other origins/kinds/invalid subtabs do not change membership context');
});
