// 新版设置宿主（R2）行为检查：真实命令适配、真实宿主回调、示例预览只对本机 4381 生效、
// 正式页面不再有 blockedCommands/空回调/“未接入数据”提示；路由与 /account 兼容另见
// workspace-origin-links.test.mjs。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/settings" });
browser.Element.prototype.scrollIntoView = function () {};
for (const name of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "DOMRect", "DOMException", "Storage", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Response", "Headers", "AbortController"]) {
  globalThis[name] = browser[name];
}
globalThis.window = browser;
for (const name of ["navigator", "localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, name, { value: browser[name], configurable: true });
}
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  root: adminRoot,
  configFile: false,
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/settings-workspace-host"),
  plugins: [
    react(),
    {
      name: "settings-host-recovery-stub",
      enforce: "pre",
      resolveId(id, importer) {
        const fromSettings = importer?.replaceAll("\\", "/").endsWith("/src/workspace/settings-page.tsx");
        if (fromSettings && (id === "../views/recovery-view" || id === "../views/recovery-view.tsx")) return "\0settings-host-recovery-stub";
        return undefined;
      },
      load(id) {
        if (id !== "\0settings-host-recovery-stub") return undefined;
        return `import {createElement} from "react";
export function RecoveryView(p) {
  return createElement("div", null,
    createElement("p", null, "恢复面板桩"),
    createElement("button", { onClick: () => p.onCompleted && p.onCompleted() }, "恢复完成"));
}`;
      },
    },
  ],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { SettingsWorkspace } = await vite.ssrLoadModule("/src/workspace/settings-page.tsx");

after(async () => { await vite.close(); await browser.happyDOM.abort(); });

const settle = async (ms = 25) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
async function waitFor(fn, timeout = 3000) { const until = Date.now() + timeout; while (!fn()) { if (Date.now() > until) throw new Error("Component condition timed out"); await settle(); } }
const buttonByText = (text) => [...browser.document.querySelectorAll("button")].find((element) => element.textContent.trim() === text);
const click = async (element) => { assert.ok(element, "expected clickable element"); await act(async () => element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }))); await settle(); };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SNAPSHOT = {
  authenticated: true,
  adminUserId: "admin-1",
  user: { name: "测试管理员", username: "ZZ00001", displayUsername: "ZZ00001", twoFactorEnabled: true },
  security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
  session: { id: "session-1", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
  permissions: [],
};

async function mount(t, overrides = {}) {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const opened = [];
  const props = {
    query: {}, snapshot: SNAPSHOT, idleMinutes: 15, onIdleMinutes: () => {},
    onLock: () => {}, onRefresh: async () => SNAPSHOT, onRecoveryCompleted: () => {},
    onDirtyChange: () => {}, onQueryChange: () => {}, onOpenPath: (target, title) => opened.push({ path: target, title }),
    theme: "dark", themeMode: "dark", onSelectThemeMode: () => {}, onResetTheme: () => {},
    themeStorageError: false, themeStorageStatus: "saved", urlTheme: null, onExitPreview: () => {},
    ...overrides,
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); await settle(); });
  await act(async () => root.render(createElement(SettingsWorkspace, props)));
  await settle();
  return { opened, container };
}

test("security section runs on the real command adapter with real host callbacks", async (t) => {
  browser.location.href = "http://127.0.0.1:3101/settings?section=security";
  let locks = 0;
  let recoveries = 0;
  await mount(t, {
    query: { section: "security" },
    onLock: () => { locks += 1; },
    onRecoveryCompleted: () => { recoveries += 1; },
  });
  const text = () => browser.document.body.textContent;
  assert.equal(text().includes("暂未开放"), false, "formal security actions must not claim to be closed");
  assert.equal(text().includes("仅验收"), false);
  assert.equal(text().includes("尚未接入本人设置数据"), false);
  const password = buttonByText("修改密码");
  assert.ok(password && !password.disabled, "password dialog is reachable through the real adapter");
  assert.ok(buttonByText("重新生成备份码")?.disabled === false, "backup-code action is reachable");
  const lock = buttonByText("立即锁定当前会话");
  assert.ok(lock && !lock.disabled, "lock uses the real Root callback and keeps its PIN prerequisite");
  await click(lock);
  assert.equal(locks, 1, "onLockSession forwards to the host onLock, not an empty callback");
  await click(buttonByText("进入账号恢复"));
  await waitFor(() => text().includes("恢复面板桩"));
  await click(buttonByText("恢复完成"));
  assert.equal(recoveries, 1, "recovery completion calls the Root onRecoveryCompleted");
  await waitFor(() => !text().includes("恢复面板桩"));
});

test("profile section saves display name through the real self-profile adapter", async (t) => {
  browser.location.href = "http://127.0.0.1:3101/settings?section=profile";
  const calls = [];
  let refreshes = 0;
  const profile = { adminUserId: "admin-1", zzNumber: "ZZ00001", displayName: "测试管理员", avatarUrl: null, updatedAt: "2026-10-15T00:00:00.000Z" };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname !== "/api/bff/admin/self/profile") throw new Error(`unexpected test request ${url.pathname}`);
    const method = init.method ?? "GET";
    calls.push({ method, body: init.body });
    if (method === "GET") return json(profile);
    const body = JSON.parse(String(init.body));
    return json({ status: true, profile: { ...profile, displayName: body.displayName } });
  };
  await mount(t, { query: { section: "profile" }, onRefresh: async () => { refreshes += 1; return SNAPSHOT; } });
  await waitFor(() => browser.document.body.textContent.includes("测试管理员"));
  const input = browser.document.querySelector("input");
  assert.ok(input, "display-name input is rendered on the real profile section");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
    setter.call(input, "新显示名称");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await settle();
  const save = buttonByText("保存显示名称");
  assert.ok(save && !save.disabled);
  await click(save);
  await waitFor(() => calls.some((call) => call.method === "POST"));
  assert.deepEqual(JSON.parse(calls.find((call) => call.method === "POST").body), { displayName: "新显示名称" });
  await waitFor(() => browser.document.body.textContent.includes("显示名称已保存"));
  assert.equal(refreshes, 1, "successful save refreshes the workspace session");
});

test("sidebar order panel starts collapsed and keeps accessible move controls", async (t) => {
  browser.location.href = "http://127.0.0.1:3101/settings";
  await mount(t, { snapshot: { ...SNAPSHOT, security: { ...SNAPSHOT.security, isBoss: true } } });
  const panel = browser.document.querySelector('section[aria-labelledby="nav-group-panel-title"]');
  assert.ok(panel, "appearance section renders the sidebar-order panel");
  const toggle = panel.querySelector(".nav-group-panel__toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.match(panel.textContent, /可调整 \d+ 个分组/);
  assert.equal(panel.querySelectorAll(".nav-group-panel__row").length, 0);
  await click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  await waitFor(() => panel.querySelectorAll(".nav-group-panel__row").length > 0);
  assert.equal(panel.querySelectorAll("[title]").length, 0, "move buttons do not use native title hints");
  assert.match(panel.querySelector(".nav-group-panel__move").getAttribute("aria-label"), /上移/);
});

test("preview=1 stays inert outside the isolated 4381 port (production-like 3101)", async (t) => {
  browser.location.href = "http://127.0.0.1:3101/settings?section=profile&preview=1";
  const reads = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), browser.location.href);
    if (url.pathname === "/api/bff/admin/self/profile") {
      reads.push(url.search);
      return json({ adminUserId: "admin-1", zzNumber: "ZZ00001", displayName: "真实读取管理员", avatarUrl: null, updatedAt: "2026-10-15T00:00:00.000Z" });
    }
    throw new Error(`unexpected test request ${url.pathname}`);
  };
  await mount(t, { query: { section: "profile", preview: "1" } });
  await waitFor(() => reads.length === 1);
  await waitFor(() => browser.document.body.textContent.includes("真实读取管理员"));
  assert.equal(browser.document.body.textContent.includes("示例管理员"), false, "preview data never serves real profile reads");
  assert.equal(buttonByText("查看示例布局"), undefined, "example toggle is not offered outside the isolated preview");
});

test("isolated 4381 preview still serves example layouts without real data fetches", async (t) => {
  browser.location.href = "http://127.0.0.1:4381/settings?section=profile&preview=1";
  const fetches = [];
  globalThis.fetch = async (input) => { fetches.push(String(input)); throw new Error("no real fetch expected in preview"); };
  await mount(t, { query: { section: "profile", preview: "1" } });
  await waitFor(() => browser.document.body.textContent.includes("示例管理员（示例）") || browser.document.body.textContent.includes("示例管理员"));
  assert.equal(fetches.length, 0, "example layout must not read or write real data");
  assert.ok(buttonByText("返回真实读取"), "preview offers a way back to real reads");
});
