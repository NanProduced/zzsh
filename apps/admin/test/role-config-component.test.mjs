import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4303/roles" });
for (const name of ["window", "document", "HTMLElement", "Element", "ShadowRoot", "HTMLInputElement", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "getComputedStyle"]) {
  globalThis[name] = name === "window" ? browser : name === "getComputedStyle" ? browser[name].bind(browser) : browser[name];
}
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  root: adminRoot, configFile: false,
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/role-config"),
  plugins: [react()], resolve: { alias: { "@": path.join(adminRoot, "src") } },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { RoleConfigView } = await vite.ssrLoadModule("/src/views/role-config-view.tsx");
after(async () => { await vite.close(); await browser.happyDOM.abort(); });

const ROLES = [
  { id: "r-a", code: "a", name: "角色A", description: null, status: "ACTIVE", permissionCodes: ["order.read"] },
  { id: "r-b", code: "b", name: "角色B", description: null, status: "ACTIVE", permissionCodes: [] },
];
const SNAPSHOT = {
  authenticated: true, adminUserId: "fixture-admin", user: { name: "测试操作者", twoFactorEnabled: true },
  security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
  session: { id: "fixture-session", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
  permissions: ["admin.role.read", "admin.permission.read", "admin.role.configure"],
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const button = (node, label) => [...node.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
const popup = () => browser.document.querySelector('[data-slot="dialog-content"]');
const closeButton = () => popup()?.querySelector('[data-slot="dialog-close"]') ?? undefined;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await settle(); }
  throw new Error("role component condition timed out");
}
const click = async (node) => { assert.ok(node); await act(async () => node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }))); await settle(); };
const escape = async () => { await act(async () => browser.document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await settle(); };
async function rename(value) {
  await act(async () => {
    const input = popup().querySelector("input[required]");
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}
async function setup(t, handler = () => json({})) {
  const posts = [];
  // Only fetch fixtures: no API, credentials, PG or real role writes.
  globalThis.fetch = async (input, init = {}) => {
    if (init.body) { const body = JSON.parse(init.body); posts.push(body); return handler(body); }
    return json({ roles: ROLES, permissions: [{ code: "order.read", name: "订单读取", description: null }, { code: "supply.rules.edit", name: "规则编辑", description: null }] });
  };
  const container = browser.document.createElement("div"); browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); await settle(); });
  const render = async (props = {}) => {
    await act(async () => root.render(createElement(RoleConfigView, { snapshot: SNAPSHOT, ...props })));
    await settle();
  };
  await render();
  await until(() => button(container, "编辑「角色A」") || button(container, "查看「角色A」权限"));
  return { container, render, posts };
}

test("保存在途拒绝 ESC、遮罩、底栏退出；成功回执只关闭当前窗口", async (t) => {
  let finish;
  const view = await setup(t, () => new Promise((resolve) => { finish = () => resolve(json({})); }));
  await click(button(view.container, "编辑「角色A」"));
  await rename("A 已修改");
  await click(button(popup(), "保存更改"));
  await until(() => finish);
  assert.equal(closeButton(), undefined, "在途提交隐藏右上角关闭");
  assert.equal(button(popup(), "放弃修改").disabled, true);
  await escape();
  assert.ok(popup(), "ESC 不能关闭在途提交");
  const backdrop = browser.document.querySelector('[data-slot="dialog-overlay"]');
  await act(async () => {
    backdrop.dispatchEvent(new browser.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    backdrop.dispatchEvent(new browser.MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    backdrop.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
  assert.ok(popup(), "遮罩不能关闭在途提交");
  await click(button(popup(), "放弃修改"));
  assert.ok(popup(), "禁用的底栏不能关闭在途提交");
  assert.equal(view.posts.length, 1);
  await act(async () => finish());
  await until(() => !popup());
});

test("普通关闭保留草稿，明确放弃才退出，零 fixture POST", async (t) => {
  const view = await setup(t);
  await click(button(view.container, "编辑「角色A」"));
  await rename("未保存的角色草稿");
  await click(closeButton());
  assert.ok(popup());
  assert.equal(popup().querySelector("input[required]").value, "未保存的角色草稿");
  assert.ok(popup().textContent.includes("选择“放弃修改”才会关闭"));
  await escape();
  assert.ok(popup());
  await click(button(popup(), "放弃修改"));
  assert.equal(popup(), null);
  assert.equal(view.posts.length, 0);
});

test("路由切换卸载 A 编辑器后，A 的迟到 ACK 不能关闭 B 草稿", async (t) => {
  let finishA;
  const view = await setup(t, () => new Promise((resolve) => { finishA = () => resolve(json({})); }));
  await view.render({ objectOnly: true, initialCode: "a" });
  await until(() => popup()?.textContent.includes("编辑角色「角色A」"));
  await rename("A 的保存");
  await click(button(popup(), "保存更改"));
  await until(() => finishA);
  await view.render({ objectOnly: true, initialCode: "b" });
  await until(() => popup()?.textContent.includes("编辑角色「角色B」"));
  await rename("B 的未保存草稿");
  await act(async () => finishA());
  await settle();
  assert.ok(popup()?.textContent.includes("编辑角色「角色B」"));
  assert.equal(popup().querySelector("input[required]").value, "B 的未保存草稿");
  assert.equal(view.posts.length, 1);
});

test("只读角色有查看入口、权限可展开搜索、深链不可提交", async (t) => {
  const view = await setup(t);
  const snapshot = { ...SNAPSHOT, permissions: ["admin.role.read", "admin.permission.read"] };
  await view.render({ snapshot });
  await click(button(view.container, "查看「角色A」权限"));
  assert.ok(popup().textContent.includes("查看角色「角色A」"));
  assert.equal(popup().querySelector("input[required]").readOnly, true);
  assert.equal(popup().querySelector("button[type=submit]"), null);
  const search = popup().querySelector('input[aria-label="搜索权限名称或说明"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(search, "规则");
    search.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert.ok(popup().querySelector('input[type="checkbox"]'));
  for (const control of popup().querySelectorAll('input[type="checkbox"]')) assert.equal(control.disabled, true);
  await act(async () => popup().querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(view.posts.length, 0);
  await view.render({ snapshot, objectOnly: true, initialCode: "b" });
  await until(() => popup()?.textContent.includes("查看角色「角色B」"));
  assert.equal(popup().querySelector("input[required]").readOnly, true);
  assert.equal(popup().querySelector("button[type=submit]"), null);
});

test("编辑权限撤销后，已有角色窗口立即只读且Enter提交拒发", async (t) => {
  const view = await setup(t);
  await click(button(view.container, "编辑「角色A」"));
  await rename("权限撤销前的草稿");
  await view.render({ snapshot: { ...SNAPSHOT, permissions: ["admin.role.read", "admin.permission.read"] } });
  assert.equal(popup().querySelector("input[required]").readOnly, true);
  assert.equal(popup().querySelector("button[type=submit]"), null);
  await act(async () => popup().querySelector("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(view.posts.length, 0);
});

test("E-R1-01 directory read is scoped per identity/session/permission generation and old responses never land", async (t) => {
  const pending = []; let directoryCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/security/admins")) { directoryCalls += 1; return new Promise((resolve) => pending.push(resolve)); }
    return json({ roles: ROLES, permissions: [] });
  };
  const container = browser.document.createElement("div"); browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); await settle(); });
  const snap = (adminUserId, sessionId, extra = []) => ({ ...SNAPSHOT, adminUserId, session: { ...SNAPSHOT.session, id: sessionId }, permissions: [...SNAPSHOT.permissions, "admin.account.read", ...extra] });
  const admins = (bosses) => json({ admins: Array.from({ length: bosses }, (_, i) => ({ id: `b${i}`, username: `b${i}`, name: "x", status: "ACTIVE", isBoss: true, roles: [] })) });
  await act(async () => root.render(createElement(RoleConfigView, { snapshot: snap("A", "s1") }))); await settle();
  assert.equal(directoryCalls, 1);
  // Identity switch while A is still in flight: B must start its own request.
  await act(async () => root.render(createElement(RoleConfigView, { snapshot: snap("B", "s2") }))); await settle();
  assert.equal(directoryCalls, 2, "a different identity never joins the other identity's in-flight read");
  await act(async () => { pending[1](admins(1)); }); await settle();
  await act(async () => { pending[0](admins(5)); }); await settle();
  assert.match(container.textContent, /使用成员 1/);
  assert.doesNotMatch(container.textContent, /使用成员 5/, "late response of the old identity must not overwrite the new page");
  // Same person, new session; and same session with a permission generation change: both start new reads.
  await act(async () => root.render(createElement(RoleConfigView, { snapshot: snap("B", "s3") }))); await settle();
  assert.equal(directoryCalls, 3);
  await act(async () => { pending[2](admins(2)); }); await settle();
  await act(async () => root.render(createElement(RoleConfigView, { snapshot: snap("B", "s3", ["admin.account.freeze"]) }))); await settle();
  assert.equal(directoryCalls, 4);
  await act(async () => { pending[3](admins(3)); }); await settle();
  assert.match(container.textContent, /使用成员 3/);
});
