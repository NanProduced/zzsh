// 新版设置宿主（R2）行为检查：真实命令适配、真实宿主回调、示例预览只对本机 4381 生效、
// 正式页面不再有 blockedCommands/空回调/“未接入数据”提示；路由与 /account 兼容另见
// workspace-origin-links.test.mjs。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("formal settings host source has no blocked commands, empty callbacks or stale notices", async () => {
  const settings = readFileSync(path.join(adminRoot, "src/workspace/settings-page.tsx"), "utf8");
  assert.doesNotMatch(settings, /blockedCommands/);
  assert.doesNotMatch(settings, /const unavailable/);
  assert.doesNotMatch(settings, /onLockSession=\{\(\) => undefined\}/);
  assert.doesNotMatch(settings, /onOpenRecovery=\{\(\) => undefined\}/);
  assert.doesNotMatch(settings, /当前环境尚未接入本人设置数据/);
  assert.match(settings, /securityCommands/);
});
