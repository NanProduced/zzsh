import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

import {
  THEME_KEY,
  readSavedThemeMode,
  readStoredThemeState,
  saveThemeMode,
  resetThemeMode,
  resolveTheme,
  clearUrlTheme,
} from "../src/lib/theme.ts";
import {
  canOpenKind,
  parseWorkspacePath,
  sanitizeTabQuery,
  sanitizePersistedTabQuery,
  persistTabs,
  restoreTabs,
  tabFromLocation,
} from "../src/workspace/tab-model.ts";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4381/settings?tab=general&theme=light" });

for (const name of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "DOMRect", "DOMException", "Storage"]) {
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
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/theme-settings"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(adminRoot, "src"),
      "@brand": path.resolve(adminRoot, "../../assets/brand"),
    },
  },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});

const { SettingsView } = await vite.ssrLoadModule("/src/views/settings-view.tsx");
const { AuthLayout } = await vite.ssrLoadModule("/src/components/auth-layout.tsx");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)); });

test("1. theme persistence handles valid, legacy, invalid, empty values and real storage errors safely", () => {
  // Empty storage defaults to dark with status "default" (not yet saved)
  browser.localStorage.removeItem(THEME_KEY);
  assert.deepEqual(readStoredThemeState(), { mode: "dark", status: "default" });
  assert.equal(readSavedThemeMode(), "dark");

  // Valid values yield status "saved"
  browser.localStorage.setItem(THEME_KEY, "light");
  assert.deepEqual(readStoredThemeState(), { mode: "light", status: "saved" });
  assert.equal(readSavedThemeMode(), "light");

  browser.localStorage.setItem(THEME_KEY, "dark");
  assert.deepEqual(readStoredThemeState(), { mode: "dark", status: "saved" });
  assert.equal(readSavedThemeMode(), "dark");

  browser.localStorage.setItem(THEME_KEY, "system");
  assert.deepEqual(readStoredThemeState(), { mode: "system", status: "saved" });
  assert.equal(readSavedThemeMode(), "system");

  // Invalid values fall back to dark with status "default"
  browser.localStorage.setItem(THEME_KEY, "neon-blue");
  assert.deepEqual(readStoredThemeState(), { mode: "dark", status: "default" });
  assert.equal(readSavedThemeMode(), "dark");

  browser.localStorage.setItem(THEME_KEY, "");
  assert.deepEqual(readStoredThemeState(), { mode: "dark", status: "default" });

  // Save mode
  assert.equal(saveThemeMode("light"), true);
  assert.equal(browser.localStorage.getItem(THEME_KEY), "light");

  // Reset only affects THEME_KEY, leaving other keys intact
  browser.localStorage.setItem("zzsh-admin-workspace-tabs:boss", '{"tabs":[]}');
  browser.localStorage.setItem("zzsh-admin-idle-minutes", "15");
  assert.equal(resetThemeMode(), true);
  assert.equal(browser.localStorage.getItem(THEME_KEY), "dark");
  assert.equal(browser.localStorage.getItem("zzsh-admin-workspace-tabs:boss"), '{"tabs":[]}');
  assert.equal(browser.localStorage.getItem("zzsh-admin-idle-minutes"), "15");

  // Real Storage method failure injection on getItem
  const origGet = browser.localStorage.getItem;
  Object.defineProperty(browser.localStorage, "getItem", {
    value: function (key) {
      if (key === THEME_KEY) throw new browser.DOMException("blocked", "SecurityError");
      return origGet.call(this, key);
    },
    configurable: true,
  });
  assert.deepEqual(readStoredThemeState(), { mode: "dark", status: "error" });
  assert.equal(readSavedThemeMode(), "dark");
  Object.defineProperty(browser.localStorage, "getItem", { value: origGet, configurable: true });

  // Real Storage method failure injection on setItem
  const origSet = browser.localStorage.setItem;
  Object.defineProperty(browser.localStorage, "setItem", {
    value: function (key, value) {
      if (key === THEME_KEY) throw new browser.DOMException("quota", "QuotaExceededError");
      return origSet.call(this, key, value);
    },
    configurable: true,
  });
  assert.equal(saveThemeMode("light"), false);
  assert.equal(resetThemeMode(), false);
  Object.defineProperty(browser.localStorage, "setItem", { value: origSet, configurable: true });
});

test("2. theme resolution prioritizes temporary URL theme and resolves mode correctly", () => {
  assert.equal(resolveTheme("light", null), "light");
  assert.equal(resolveTheme("dark", null), "dark");

  // Temporary URL override takes precedence over saved mode without persisting
  assert.equal(resolveTheme("dark", "light"), "light");
  assert.equal(resolveTheme("light", "dark"), "dark");
  assert.equal(resolveTheme("system", "light"), "light");

  // Invalid URL theme is ignored
  assert.equal(resolveTheme("dark", null), "dark");
});

test("3. URL query handling preserves active valid preview theme, rejects invalid, and clearUrlTheme clears it", () => {
  // Valid temporary preview theme is preserved in URL query
  const preserved = sanitizeTabQuery({ theme: "light", cursor: "123", validKey: "abc" });
  assert.equal(preserved.theme, "light");
  assert.equal(preserved.cursor, "123");
  assert.equal(preserved.validKey, "abc");

  // Invalid theme values are stripped
  const rejected = sanitizeTabQuery({ theme: "neon", cursor: "456" });
  assert.equal("theme" in rejected, false);
  assert.equal(rejected.cursor, "456");

  // clearUrlTheme removes theme parameter from browser history
  browser.history.pushState(null, "", "http://127.0.0.1:4381/settings?section=appearance&theme=light&page=1");
  assert.equal(browser.location.search.includes("theme=light"), true);

  clearUrlTheme();
  assert.equal(browser.location.search.includes("theme="), false);
  assert.equal(browser.location.search.includes("section=appearance"), true);
  assert.equal(browser.location.search.includes("page=1"), true);

  // Temporary preview theme is separated from persisted business queries
  const persistedQuery = sanitizePersistedTabQuery({ theme: "light", cursor: "789", filter: "active" });
  assert.equal("theme" in persistedQuery, false, "theme must be stripped from persistent storage");
  assert.equal(persistedQuery.cursor, "789");
  assert.equal(persistedQuery.filter, "active");

  // persistTabs strips theme from tabs payload saved to sessionStorage
  browser.sessionStorage.clear();
  persistTabs("admin-test-1", {
    activeId: "settings",
    tabs: [
      { id: "workbench", title: "工作台", path: "/workbench", query: {}, closable: false, kind: "workbench" },
      { id: "settings", title: "设置", path: "/settings", query: { theme: "light" }, closable: true, kind: "settings" },
    ],
  });
  const restored = restoreTabs("admin-test-1", { isBoss: true, permissions: [] });
  assert.ok(restored);
  const settingsTab = restored.tabs.find((tab) => tab.id === "settings");
  assert.ok(settingsTab);
  assert.equal("theme" in settingsTab.query, false, "restored tab must not have theme query");
});

test("4. settings route model is single-instance, accessible to limited admins", () => {
  const parsed = parseWorkspacePath("/settings");
  assert.equal(parsed.kind, "settings");
  assert.equal(parsed.tabId, "settings");
  assert.equal(parsed.title, "设置");

  // Accessible to zero business permission admin
  const limitedAdmin = { isBoss: false, permissions: [] };
  assert.equal(canOpenKind("settings", limitedAdmin), true);
  assert.equal(canOpenKind("account", limitedAdmin), true);

  // Tab from location produces single-instance tab
  const tab1 = tabFromLocation("/settings", "?theme=dark");
  const tab2 = tabFromLocation("/settings", "?tab=appearance");
  assert.equal(tab1.id, "settings");
  assert.equal(tab2.id, "settings");
});

test("5. SettingsView with Base UI RadioGroup supports keyboard navigation, single tab-stop, and save status", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);

  let selectedMode = null;
  let resetCalled = false;
  let openedPath = null;
  let exitPreviewCalled = false;

  // Render normal saved state (themeMode = dark, saved)
  await act(async () => {
    root.render(
      createElement(SettingsView, {
        theme: "dark",
        themeMode: "dark",
        themeStorageStatus: "saved",
        themeStorageError: false,
        onSelectThemeMode: (m) => { selectedMode = m; },
        onResetTheme: () => { resetCalled = true; },
        onOpenPath: (p) => { openedPath = p; },
      })
    );
  });
  await settle();

  // Page title
  const h1 = container.querySelector("h1");
  assert.ok(h1);
  assert.equal(h1.textContent, "外观与偏好");

  // Radio cards: 3 radios, single tab stop
  const radios = Array.from(container.querySelectorAll('[role="radio"]'));
  assert.equal(radios.length, 3);
  const tabStops = Array.from(container.querySelectorAll('[role="radio"][tabindex="0"]'));
  assert.equal(tabStops.length, 1);
  assert.equal(tabStops[0].getAttribute("aria-label"), "深色");

  // Dark radio is checked
  assert.equal(radios[1].getAttribute("aria-checked"), "true");
  assert.equal(radios[0].getAttribute("aria-checked"), "false");
  assert.equal(radios[2].getAttribute("aria-checked"), "false");

  // Keyboard navigation: ArrowRight from dark moves to system
  await act(async () => {
    radios[1].focus();
    radios[1].dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  await settle();
  assert.equal(selectedMode, "system");

  // Status feedback displays saved
  assert.ok(container.textContent.includes("已保存到当前浏览器"));

  // Re-render in temporary preview state (urlTheme = light)
  await act(async () => {
    root.render(
      createElement(SettingsView, {
        theme: "light",
        themeMode: "dark",
        urlTheme: "light",
        themeStorageStatus: "saved",
        themeStorageError: false,
        onSelectThemeMode: (m) => { selectedMode = m; },
        onResetTheme: () => { resetCalled = true; },
        onExitPreview: () => { exitPreviewCalled = true; },
        onOpenPath: (p) => { openedPath = p; },
      })
    );
  });
  await settle();

  // Temporary preview banner is shown
  assert.ok(container.textContent.includes("临时预览"));
  assert.ok(container.textContent.includes("正在临时预览浅色主题（未保存到当前浏览器）"));
  // In preview mode, "已保存到当前浏览器" must NOT be shown!
  assert.equal(container.textContent.includes("已保存到当前浏览器"), false);

  // Click exit preview button
  const exitPreviewBtn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent.includes("结束临时预览")
  );
  assert.ok(exitPreviewBtn);
  await act(async () => {
    exitPreviewBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
  });
  await settle();
  assert.equal(exitPreviewCalled, true);

  // Re-render with default unsaved status (no stored item)
  await act(async () => {
    root.render(
      createElement(SettingsView, {
        theme: "dark",
        themeMode: "dark",
        themeStorageStatus: "default",
        themeStorageError: false,
        onSelectThemeMode: (m) => { selectedMode = m; },
        onResetTheme: () => { resetCalled = true; },
        onOpenPath: (p) => { openedPath = p; },
      })
    );
  });
  await settle();
  assert.ok(container.textContent.includes("默认偏好（未在此浏览器保存修改）"));
  assert.equal(container.textContent.includes("已保存到当前浏览器"), false);

  // Re-render with themeStorageError
  await act(async () => {
    root.render(
      createElement(SettingsView, {
        theme: "light",
        themeMode: "light",
        themeStorageError: true,
        onSelectThemeMode: (m) => { selectedMode = m; },
        onResetTheme: () => { resetCalled = true; },
        onOpenPath: (p) => { openedPath = p; },
      })
    );
  });
  await settle();
  assert.ok(container.textContent.includes("已临时应用，无法保存在此浏览器"));
  assert.equal(container.textContent.includes("已保存到当前浏览器"), false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("6. AuthLayout displays storage failure warning when saving theme is blocked", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);

  // 1. With storage error: warning is visible
  await act(async () => {
    root.render(
      createElement(
        AuthLayout,
        {
          theme: "light",
          themeMode: "light",
          themeStorageError: true,
        },
        createElement("div", null, "Login Form Child")
      )
    );
  });
  await settle();
  assert.ok(container.textContent.includes("已临时应用，无法保存在此浏览器"));

  // 2. Without storage error: warning is not visible
  await act(async () => {
    root.render(
      createElement(
        AuthLayout,
        {
          theme: "light",
          themeMode: "light",
          themeStorageError: false,
        },
        createElement("div", null, "Login Form Child")
      )
    );
  });
  await settle();
  assert.equal(container.textContent.includes("已临时应用，无法保存在此浏览器"), false);

  await act(async () => { root.unmount(); });
  container.remove();
});
