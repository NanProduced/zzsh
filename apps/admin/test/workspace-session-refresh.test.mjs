import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/support" });
globalThis.window = browser;
globalThis.document = browser.document;
globalThis.HTMLElement = browser.HTMLElement;
globalThis.Element = browser.Element;
globalThis.Node = browser.Node;
globalThis.Event = browser.Event;
Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
globalThis.CustomEvent = browser.CustomEvent;
globalThis.getComputedStyle = browser.getComputedStyle.bind(browser);
globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
globalThis.matchMedia = browser.matchMedia.bind(browser);
globalThis.ResizeObserver = browser.ResizeObserver;
globalThis.MutationObserver = browser.MutationObserver;
globalThis.localStorage = browser.localStorage;
globalThis.sessionStorage = browser.sessionStorage;
globalThis.confirm = () => true;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const intervalCallbacks = [];
const realSetInterval = browser.setInterval.bind(browser);
const realClearInterval = browser.clearInterval.bind(browser);
let fakeIntervalId = 0;
browser.setInterval = (callback, delay) => {
  if (delay === 5_000) {
    const id = `test-${++fakeIntervalId}`;
    intervalCallbacks.push({ callback, delay, id, active: true });
    return id;
  }
  return realSetInterval(callback, delay);
};
browser.clearInterval = (id) => {
  const callback = intervalCallbacks.find((entry) => entry.id === id);
  if (callback) callback.active = false;
  else realClearInterval(id);
};
globalThis.setInterval = browser.setInterval;
globalThis.clearInterval = browser.clearInterval;

const vite = await createServer({
  root: adminRoot,
  plugins: [
    react(),
    {
      name: "workspace-shell-page-test-stub",
      enforce: "pre",
      resolveId(id, importer) {
        const normalized = id.replaceAll("\\", "/");
        const fromShell = importer?.replaceAll("\\", "/").endsWith("/src/workspace/app-shell.tsx");
        return (normalized.endsWith("/src/workspace/page-content.tsx") || ((id === "./page-content" || id === "./page-content.tsx") && fromShell)) ? "\0workspace-shell-page-test-stub" : undefined;
      },
      load(id) {
        if (id !== "\0workspace-shell-page-test-stub") return undefined;
        return `import { createElement } from "react";
export function WorkspacePageContent({ tab }) {
  return createElement("div", { "data-shell-page": tab.kind, "aria-label": tab.kind === "support" ? "客服工作台" : "工作台" });
}`;
      },
    },
  ],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { WorkspaceApp } = await vite.ssrLoadModule("/src/workspace/app-shell.tsx");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function snapshot(permissions) {
  return {
    authenticated: true,
    adminUserId: "admin-a",
    user: { name: "客服 A", username: "admin-a", displayUsername: "客服 A", twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: "session-a", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions,
  };
}

globalThis.fetch = async (input) => {
  const url = new URL(String(input), browser.location.href);
  if (url.pathname.endsWith("/im/token")) return response({ appKey: "test-app", accountId: "admin-a", token: "test-token", transport: "local-fake" });
  if (url.pathname.endsWith("/im/consultations")) return response({ consultations: [] });
  if (url.pathname.endsWith("/im/messages")) return response({ messages: [] });
  throw new Error(`unexpected test request ${url.pathname}${url.search}`);
};

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

test("shell keeps session refresh discoverable after read permission removes support tab", async (t) => {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  let refreshCalls = 0;
  const onRefresh = async () => {
    refreshCalls += 1;
    return snapshot(["im.support.read"]);
  };
  const props = (permissions) => ({
    snapshot: snapshot(permissions),
    theme: "dark",
    onToggleTheme: () => {},
    idleMinutes: 60,
    onIdleMinutes: () => {},
    onLock: () => {},
    onSignOut: () => {},
    onRefresh,
    onRecoveryCompleted: () => {},
  });

  t.after(async () => {
    await act(async () => { root.unmount(); });
    await vite.close();
  });

  await act(async () => { root.render(createElement(WorkspaceApp, props(["im.support.read", "im.support.accept"]))); });
  await settle();
  assert.equal(rootNode.querySelector('[aria-label="客服工作台"]') !== null, true);

  await act(async () => { root.render(createElement(WorkspaceApp, props([]))); });
  await settle();
  assert.equal(rootNode.querySelector('[aria-label="客服工作台"]'), null);
  const shellTimer = intervalCallbacks.find((entry) => entry.active && entry.delay === 5_000 && entry.callback);
  assert.ok(shellTimer, "shell refresh timer should survive protected support tab removal");
  const before = refreshCalls;
  await act(async () => { shellTimer.callback(); await Promise.resolve(); });
  assert.equal(refreshCalls, before + 1);
});
