import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { closeTabs, persistTabs, tabFromLocation } from "../src/workspace/tab-model.ts";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4381/admins" });
for (const name of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "DOMRect"]) globalThis[name] = browser[name];
globalThis.window = browser;
for (const name of ["navigator", "localStorage", "sessionStorage"]) Object.defineProperty(globalThis, name, { value: browser[name], configurable: true });
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  root: adminRoot, configFile: false,
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/workspace-tab-bar"),
  plugins: [react(), {
    name: "tab-bar-dirty-page", enforce: "pre",
    resolveId(id, importer) {
      if (id === "./page-content" && importer?.replaceAll("\\", "/").endsWith("/workspace/app-shell.tsx")) return "\0tab-bar-dirty-page";
    },
    load(id) {
      if (id === "\0tab-bar-dirty-page") return 'import {createElement} from "react"; export function WorkspacePageContent({onDirtyChange,onOpenPath}) { return createElement("div",null,createElement("button",{onClick:()=>onDirtyChange(true)},"标记未保存"),createElement("button",{onClick:()=>onOpenPath("/finance")},"打开资金")); }';
    },
  }],
  resolve: { alias: { "@": path.join(adminRoot, "src"), "@brand": path.resolve(adminRoot, "../../assets/brand") } },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { WorkspaceTabBar } = await vite.ssrLoadModule("/src/workspace/tab-bar.tsx");
const { WorkspaceApp } = await vite.ssrLoadModule("/src/workspace/app-shell.tsx");
after(async () => { await vite.close(); await browser.happyDOM.abort(); });
const settle = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
const buttons = () => [...browser.document.querySelectorAll("button")];
const button = name => buttons().find(e => (e.getAttribute("aria-label") || e.textContent.trim()) === name);
const item = name => [...browser.document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent === name);
const tabButton = id => browser.document.querySelector(`[data-tab-id="${id}"]`);
async function dispatch(element, type, options = {}) {
  assert.ok(element, `missing ${type} target`);
  await act(async () => element.dispatchEvent(type === "keydown" ? new browser.KeyboardEvent(type, { bubbles: true, cancelable: true, ...options }) : new browser.MouseEvent(type, { bubbles: true, cancelable: true, ...options })));
  await settle();
}
async function mount(t, component) {
  const host = browser.document.createElement("div"); host.className = "workspace-root"; browser.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); await settle(); });
  await act(async () => root.render(component)); await settle();
  host.render = async component => { await act(async () => root.render(component)); await settle(); };
  return host;
}
function Harness({ initialTabs, initialActive, calls }) {
  const [state, setState] = useState({ tabs: initialTabs, activeId: initialActive });
  return createElement(WorkspaceTabBar, { ...state,
    onActivate: id => { calls.push(["activate", id]); setState(s => ({ ...s, activeId: id })); },
    onClose: (action, id) => { calls.push([action, id]); setState(s => closeTabs(s.tabs, s.activeId, action, id)); },
  });
}
const standardTabs = () => [tabFromLocation("/workbench"), tabFromLocation("/admins"), tabFromLocation("/roles"), tabFromLocation("/account")];

test("right-clicking an inactive tab opens only its actions and closing it does not activate it", async t => {
  const calls = [];
  await mount(t, createElement(Harness, { initialTabs: standardTabs(), initialActive: "account", calls }));
  await dispatch(tabButton("admins"), "contextmenu", { button: 2 });
  assert.ok(item("关闭标签页")); assert.equal(tabButton("account").getAttribute("aria-selected"), "true");
  assert.equal(browser.document.querySelectorAll('[role="menuitem"]').length, 4);
  await dispatch(item("关闭标签页"), "click");
  assert.deepEqual(calls, [["self", "admins"]]);
  assert.equal(tabButton("admins"), null);
  assert.equal(tabButton("account").getAttribute("aria-selected"), "true");
});

test("keyboard menu and touch/click trigger share disabled boundaries and preserve fixed workbench", async t => {
  const calls = [];
  await mount(t, createElement(Harness, { initialTabs: [tabFromLocation("/workbench")], initialActive: "workbench", calls }));
  await dispatch(tabButton("workbench"), "keydown", { key: "F10", shiftKey: true });
  assert.equal(browser.document.querySelectorAll('[role="menuitem"][aria-disabled="true"]').length, 4);
  await dispatch(item("关闭标签页"), "click"); assert.deepEqual(calls, []);
  await dispatch(item("关闭标签页"), "keydown", { key: "Escape" });
  await dispatch(button("工作台的标签页操作"), "click");
  assert.ok(item("关闭右侧标签页"));
  assert.equal(button("已打开页面"), undefined, "no overflow switcher when all tabs fit");
});

test("icons distinguish details while visible labels stay compact; Delete on more button does not close active page", async t => {
  const calls = [];
  const detail = { ...tabFromLocation("/users/person-1"), title: "林舟" };
  await mount(t, createElement(Harness, { initialTabs: [tabFromLocation("/users"), detail], initialActive: detail.id, calls }));
  assert.equal(tabButton("users").querySelector("svg"), null);
  assert.ok(tabButton(detail.id).querySelector("svg"));
  assert.equal(tabButton(detail.id).textContent, "林舟");
  assert.equal(tabButton(detail.id).getAttribute("aria-label"), "用户详情：林舟");
  await dispatch(button("用户详情：林舟的标签页操作"), "keydown", { key: "Delete" });
  assert.deepEqual(calls, []);
});

test("closing left targets the menu tab, not current active page", async t => {
  const calls = [];
  await mount(t, createElement(Harness, { initialTabs: standardTabs(), initialActive: "account", calls }));
  await dispatch(tabButton("roles"), "contextmenu", { button: 2 });
  await dispatch(item("关闭左侧标签页"), "click");
  assert.deepEqual(calls, [["left", "roles"]]);
  assert.equal(tabButton("admins"), null); assert.ok(tabButton("workbench"));
  assert.equal(tabButton("account").getAttribute("aria-selected"), "true");
});

test("long detail names retain their differing final identifier and the full accessible name", async t => {
  const detail = { ...tabFromLocation("/supply/reviews/account-41"), title: "旧来源号 202607210241" };
  const long = { ...detail, title: "很长的账号展示名称 · 202607210241" };
  await mount(t, createElement(Harness, { initialTabs: [long], initialActive: long.id, calls: [] }));
  assert.equal(tabButton(long.id).querySelector(".workspace-tab-tail").textContent, "07210241");
  assert.equal(tabButton(long.id).textContent, long.title);
  assert.equal(tabButton(long.id).getAttribute("aria-label"), "供给账号详情：" + long.title);
});

test("keyboard closing after context-menu focus uses focused tab instead of unrelated active tab", async t => {
  const calls = [];
  await mount(t, createElement(Harness, { initialTabs: standardTabs(), initialActive: "account", calls }));
  await act(async () => tabButton("admins").focus());
  await dispatch(tabButton("admins"), "keydown", { key: "Delete" });
  assert.deepEqual(calls, [["self", "admins"]]); assert.ok(tabButton("account"));
});

test("shell keeps dirty tab when close-others is cancelled and checks it again before actual removal", async t => {
  const snap = { authenticated: true, adminUserId: "tabs-review-admin", user: { name: "测试运营", username: "ZZ1" }, security: { status: "ACTIVE", isBoss: false }, session: { id: "tabs-review-session", pinConfigured: false, locked: false }, permissions: ["admin.account.read", "admin.role.read", "im.support.read"] };
  persistTabs(snap.adminUserId, { tabs: standardTabs(), activeId: "admins" });
  await mount(t, createElement(WorkspaceApp, { snapshot: snap, theme: "dark", onToggleTheme() {}, idleMinutes: 15, onIdleMinutes() {}, onLock() {}, onSignOut() {}, onRefresh: async () => snap, onRecoveryCompleted() {} }));
  await dispatch(button("标记未保存"), "click");
  await dispatch(tabButton("roles"), "contextmenu", { button: 2 });
  await dispatch(item("关闭其他标签页"), "click");
  assert.ok(browser.document.querySelector("[role=\"alertdialog\"]"));
  assert.match(browser.document.body.textContent, /管理员管理/);
  assert.ok(tabButton("admins"));
  await dispatch(button("继续编辑"), "click");
  assert.ok(tabButton("admins"));
  await dispatch(tabButton("roles"), "contextmenu", { button: 2 });
  await dispatch(item("关闭其他标签页"), "click");
  assert.ok(browser.document.querySelector("[role=\"alertdialog\"]"));
  await dispatch(button("放弃修改并离开"), "click");
  assert.equal(tabButton("admins"), null); assert.ok(tabButton("workbench")); assert.ok(tabButton("roles"));
});

let shellSerial = 0;
function shellProps(snapshot) {
  return { snapshot, theme: "dark", onToggleTheme() {}, idleMinutes: 15, onIdleMinutes() {}, onLock() {}, onSignOut() {}, onRefresh: async () => snapshot, onRecoveryCompleted() {} };
}
async function mountDirtyShell(t) {
  const snapshot = { authenticated: true, adminUserId: `discard-admin-${++shellSerial}`, user: { name: "测试运营", username: "ZZ1" }, security: { status: "ACTIVE", isBoss: false }, session: { id: `discard-session-${shellSerial}`, pinConfigured: false, locked: false }, permissions: ["admin.account.read", "admin.role.read", "im.support.read", "finance.read"] };
  browser.history.replaceState({}, "", "/admins");
  persistTabs(snapshot.adminUserId, { tabs: [tabFromLocation("/workbench"), tabFromLocation("/admins"), tabFromLocation("/roles"), tabFromLocation("/finance")], activeId: "admins" });
  const host = await mount(t, createElement(WorkspaceApp, shellProps(snapshot)));
  await dispatch(button("标记未保存"), "click");
  return { host, snapshot };
}
async function beginCloseOthers() {
  await dispatch(tabButton("finance-lookup"), "contextmenu", { button: 2 });
  await dispatch(item("关闭其他标签页"), "click");
  assert.ok(browser.document.querySelector('[role="alertdialog"]'));
}
async function confirmOnlyIfStillPending() {
  const pending = button("放弃修改并离开");
  if (pending) await dispatch(pending, "click");
}

test("finance failure invalidates pending close-others and cannot revive a removed tab", async t => {
  await mountDirtyShell(t); await beginCloseOthers();
  await act(async () => browser.dispatchEvent(new browser.CustomEvent("zzsh-admin-finance-access-failure"))); await settle();
  assert.equal(tabButton("finance-lookup"), null);
  assert.equal(browser.document.querySelector('[role="alertdialog"]'), null);
  await confirmOnlyIfStillPending();
  assert.equal(tabButton("finance-lookup"), null);
  assert.ok(tabButton("admins"), "revocation does not discard the dirty source");
  assert.equal(browser.location.pathname, "/workbench");
});

for (const boundary of ["identity", "session", "lock", "permissions"]) {
  test(`${boundary} change cancels queued discard without clearing the original dirty page`, async t => {
    const { host, snapshot } = await mountDirtyShell(t); await beginCloseOthers();
    const changed = boundary === "identity" ? { ...snapshot, adminUserId: snapshot.adminUserId + "-other" }
      : boundary === "session" ? { ...snapshot, session: { ...snapshot.session, id: snapshot.session.id + "-other" } }
      : boundary === "lock" ? { ...snapshot, session: { ...snapshot.session, locked: true } }
      : { ...snapshot, permissions: snapshot.permissions.filter(permission => permission !== "finance.read") };
    await host.render(createElement(WorkspaceApp, shellProps(changed)));
    assert.equal(browser.document.querySelector('[role="alertdialog"]'), null);
    await confirmOnlyIfStillPending(); assert.ok(tabButton("admins"));
    if (boundary === "permissions") assert.equal(tabButton("finance-lookup"), null);
    if (boundary === "lock") await host.render(createElement(WorkspaceApp, shellProps({ ...changed, session: { ...changed.session, locked: false } })));
    await dispatch(tabButton("roles"), "click");
    assert.ok(browser.document.querySelector('[role="alertdialog"]'), "cancelled consent did not silently clear dirty state");
    await dispatch(button("继续编辑"), "click");
  });
}

test("pending path navigation cannot recreate finance after its access failure", async t => {
  await mountDirtyShell(t); await dispatch(button("打开资金"), "click");
  assert.ok(browser.document.querySelector('[role="alertdialog"]'));
  await act(async () => browser.dispatchEvent(new browser.CustomEvent("zzsh-admin-finance-access-failure"))); await settle();
  await confirmOnlyIfStillPending(); assert.equal(tabButton("finance-lookup"), null);
  assert.equal(browser.location.pathname, "/workbench");
});

test("pending browser-history navigation is cancelled with revoked finance context", async t => {
  await mountDirtyShell(t);
  browser.history.pushState({}, "", "/finance");
  await act(async () => browser.dispatchEvent(new browser.PopStateEvent("popstate"))); await settle();
  assert.ok(browser.document.querySelector('[role="alertdialog"]'));
  await act(async () => browser.dispatchEvent(new browser.CustomEvent("zzsh-admin-finance-access-failure"))); await settle();
  await confirmOnlyIfStillPending(); assert.equal(tabButton("finance-lookup"), null);
  assert.equal(browser.location.pathname, "/workbench");
});
