import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

import { filterSearchablePages, searchableWorkspacePages } from "../src/workspace/nav-config.ts";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace" });
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
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!globalThis.Element.prototype.scrollIntoView) {
  globalThis.Element.prototype.scrollIntoView = () => {};
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  cacheDir: path.resolve(adminRoot, "../../tmp/admin-test-cache/page-search"),
  configFile: false,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
const { WorkspacePageSearch } = await vite.ssrLoadModule("/src/workspace/page-search.tsx");

after(async () => {
  await vite.close();
  await browser.happyDOM.abort();
});

test("page search only lists implemented pages in the current permission set", () => {
  const boss = searchableWorkspacePages({
    isBoss: true,
    permissions: ["admin.account.read", "admin.role.read", "approval.request.read", "admin.audit.read", "user.account.restore"],
  });
  assert.deepEqual(boss.map((page) => page.path), [
    "/workbench",
    "/support",
    "/membership-growth",
    "/admins",
    "/roles",
    "/supply/catalog",
    "/supply/gunsmith",
    "/supply/rules",
    "/supply/reviews",
    "/supply/media",
    "/content",
    "/orders",
    "/users/restore",
    "/approvals",
    "/audit",
    "/settings?section=security",
    "/settings",
  ]);

  const limited = searchableWorkspacePages({ isBoss: false, permissions: [] });
  assert.deepEqual(limited.map((page) => page.path), ["/workbench", "/settings?section=security", "/settings"]);
  assert.deepEqual(filterSearchablePages(limited, "PIN").map((page) => page.path), ["/settings?section=security"]);
  assert.equal(limited.some((page) => page.path === "/admins"), false);
  assert.equal(limited.some((page) => page.path === "/membership-growth"), false);
  for (const permission of ["membership.policy.draft", "membership.policy.publish", "membership.growth.read.summary"]) {
    assert.ok(searchableWorkspacePages({ isBoss: false, permissions: [permission] }).some(page => page.path === "/membership-growth"));
  }
});

test("page search matches label, group and path, and stays empty for unknown business queries", () => {
  const pages = searchableWorkspacePages({
    isBoss: true,
    permissions: ["admin.account.read", "admin.audit.read"],
  });
  assert.deepEqual(filterSearchablePages(pages, "审计").map((page) => page.path), ["/audit"]);
  assert.deepEqual(filterSearchablePages(pages, "/admins").map((page) => page.path), ["/admins"]);
  assert.deepEqual(filterSearchablePages(pages, "系统").map((page) => page.path), ["/admins"]);
  assert.deepEqual(filterSearchablePages(pages, "设置").map((page) => page.path), ["/settings"]);
  assert.deepEqual(filterSearchablePages(pages, "外观").map((page) => page.path), ["/settings"]);
  assert.deepEqual(filterSearchablePages(pages, "主题").map((page) => page.path), ["/settings"]);
  assert.equal(filterSearchablePages(pages, "订单号").length, 0);
  assert.equal(filterSearchablePages(pages, "用户手机").length, 0);
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

async function setInput(element, value) {
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set;
  setValue.call(element, value);
  await act(async () => {
    element.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}

async function renderSearch(props = {}) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  let latest = props;
  const render = async (extra = {}) => {
    latest = { ...latest, ...extra };
    await act(async () => {
      root.render(createElement(WorkspacePageSearch, latest));
    });
  };
  await render();
  return {
    rootNode,
    root,
    render,
    cleanup: async () => {
      await act(async () => root.unmount());
      rootNode.remove();
    },
  };
}

test("page search component interaction: no match shows empty state, Enter guarded, clear restores results", async () => {
  const pages = [
    { label: "账号与权限审计", path: "/audit", group: "系统管理" },
    { label: "设置", path: "/settings", group: "偏好设置" },
  ];
  const navigated = [];
  const search = await renderSearch({
    pages,
    onNavigate: (p) => navigated.push(p),
  });

  try {
    // Click trigger button to open search popover
    const triggerBtn = search.rootNode.querySelector('button[aria-label="搜索页面"]');
    assert.ok(triggerBtn, "renders search trigger button");

    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // Find input inside popover
    const input = browser.document.body.querySelector('input[placeholder*="在当前权限内的已实现页面中查找"]');
    assert.ok(input, "search input is rendered in popover");

    // Initially with empty query and non-empty pages, results list is displayed
    const listbox = browser.document.body.querySelector('[role="listbox"]');
    assert.ok(listbox, "listbox rendered with initial pages");
    assert.equal(listbox.querySelectorAll('[role="option"]').length, 2);

    // Type query that matches nothing
    await setInput(input, "unknown-page-query");
    await settle();

    // Verify empty state is displayed
    const emptyState = browser.document.body.querySelector('[role="status"]');
    assert.ok(emptyState, "renders empty state with role=status");
    assert.ok(browser.document.body.textContent.includes("未找到匹配的可访问页面"));
    assert.ok(browser.document.body.textContent.includes("unknown-page-query"));
    assert.equal(listbox.querySelectorAll('[role="option"]').length, 0, "no options when empty");

    // Press Enter while results is empty - must NOT navigate!
    await act(async () => {
      input.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    assert.equal(navigated.length, 0, "Enter key with empty results must not trigger navigation");

    // Click "清空搜索" button
    const clearBtn = [...browser.document.body.querySelectorAll("button")].find((b) => b.textContent.trim() === "清空搜索");
    assert.ok(clearBtn, "renders clear search button");

    await act(async () => {
      clearBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // Verify query is cleared and results are restored
    assert.equal(input.value, "", "input value is cleared");
    const restoredListbox = browser.document.body.querySelector('[role="listbox"]');
    assert.ok(restoredListbox, "results listbox is restored after clearing");
    assert.equal(restoredListbox.querySelectorAll('[role="option"]').length, 2);
  } finally {
    await search.cleanup();
  }
});

test("page search component: genuinely empty pages shows '当前无可访问页面' without clear button", async () => {
  const navigated = [];
  const search = await renderSearch({
    pages: [],
    onNavigate: (p) => navigated.push(p),
  });

  try {
    const triggerBtn = search.rootNode.querySelector('button[aria-label="搜索页面"]');
    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    const emptyState = browser.document.body.querySelector('[role="status"]');
    assert.ok(emptyState, "renders empty state when pages array is genuinely empty");
    assert.ok(browser.document.body.textContent.includes("当前无可访问页面"));
    assert.ok(browser.document.body.textContent.includes("当前登录账号未分配可在此打开的管理页面"));
    assert.equal(browser.document.body.textContent.includes("清空搜索"), false, "no clear button when pages is empty");
  } finally {
    await search.cleanup();
  }
});

test("F3: long unbroken query string wraps without overflowing empty state container", async () => {
  const pages = [
    { label: "账号与权限审计", path: "/audit", group: "系统管理" },
  ];
  const search = await renderSearch({ pages, onNavigate: () => {} });
  try {
    const triggerBtn = search.rootNode.querySelector('button[aria-label="搜索页面"]');
    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    const input = browser.document.body.querySelector('input[placeholder*="在当前权限内的已实现页面中查找"]');
    const longString = "NO_MATCH_" + "X".repeat(180);
    await setInput(input, longString);
    await settle();

    const emptyState = browser.document.body.querySelector('[role="status"]');
    assert.ok(emptyState, "renders empty state with role=status");
    assert.ok(browser.document.body.textContent.includes("未找到匹配的可访问页面"));
    assert.ok(browser.document.body.textContent.includes(longString));

    // Verify empty state container has overflow-hidden and max-w-full
    assert.ok(emptyState.classList.contains("overflow-hidden"), "empty state has overflow-hidden");
    assert.ok(emptyState.classList.contains("max-w-full"), "empty state has max-w-full");

    // Verify query span has break-all class
    const querySpan = emptyState.querySelector("span.inline");
    assert.ok(querySpan, "query span is rendered");
    assert.ok(querySpan.classList.contains("break-all"), "query span has break-all");
  } finally {
    await search.cleanup();
  }
});

test("aliases, pinyin initials, and multi-token AND matching work accurately", () => {
  const boss = searchableWorkspacePages({
    isBoss: true,
    permissions: ["admin.account.read", "admin.role.read", "supply.rules.edit", "supply.review.read", "approval.request.read", "admin.audit.read"],
  });

  // Explicit aliases
  assert.deepEqual(filterSearchablePages(boss, "定价").map((p) => p.path), ["/supply/rules"]);
  assert.deepEqual(filterSearchablePages(boss, "价目").map((p) => p.path), ["/supply/rules"]);
  assert.deepEqual(filterSearchablePages(boss, "图片审核").map((p) => p.path), ["/supply/media"]);
  assert.deepEqual(filterSearchablePages(boss, "素材").map((p) => p.path), ["/supply/media"]);
  assert.deepEqual(filterSearchablePages(boss, "外观").map((p) => p.path), ["/settings"]);
  assert.deepEqual(filterSearchablePages(boss, "偏好").map((p) => p.path), ["/settings"]);
  assert.deepEqual(filterSearchablePages(boss, "待办").map((p) => p.path), ["/approvals"]);

  // Pinyin initials
  assert.deepEqual(filterSearchablePages(boss, "sz").map((p) => p.path), ["/settings"]);
  assert.deepEqual(filterSearchablePages(boss, "sp").map((p) => p.path), ["/approvals"]);
  assert.deepEqual(filterSearchablePages(boss, "sj").map((p) => p.path), ["/audit"]);

  // Multi-token AND search: every token must match across title/group/alias
  const multiMatched = filterSearchablePages(boss, "供给 规则");
  assert.ok(multiMatched.some((p) => p.path === "/supply/rules"), "multi-token matches supply rules");
  assert.equal(filterSearchablePages(boss, "未知 规则").length, 0, "unmatched token fails entire search");

  // Full-width ASCII & spaces normalization
  assert.deepEqual(filterSearchablePages(boss, "　ｓｚ　").map((p) => p.path), ["/settings"]);
});

test("open tabs search preserves detail ID leading zeros and activates without duplicating pages", async () => {
  const pages = [
    { label: "工作台", path: "/workbench", group: "工作区" },
    { label: "账号与权限审计", path: "/audit", group: "审批与审计" },
    { label: "订单", path: "/orders", group: "交易" },
  ];
  const tabs = [
    { id: "workbench", title: "工作台", path: "/workbench", query: {}, closable: false, kind: "workbench" },
    { id: "order:00123", title: "订单详情", path: "/orders/00123", query: {}, closable: true, kind: "order-object", objectId: "00123" },
  ];

  const activatedTabs = [];
  const navigatedPaths = [];

  const search = await renderSearch({
    pages,
    tabs,
    activeTabId: "workbench",
    onActivateTab: (id) => { activatedTabs.push(id); return true; },
    onNavigate: (p) => { navigatedPaths.push(p); return true; },
  });

  try {
    const triggerBtn = search.rootNode.querySelector('button[aria-label="搜索页面"]');
    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    const input = browser.document.body.querySelector('input[placeholder*="在当前权限内的已实现页面中查找"]');

    // Search by exact leading-zero ID
    await setInput(input, "00123");
    await settle();

    // Verify open tab section is rendered with "已打开" badge and exact object ID
    assert.ok(browser.document.body.textContent.includes("已打开标签"));
    assert.ok(browser.document.body.textContent.includes("00123"));
    assert.ok(browser.document.body.textContent.includes("已打开"));

    // Select the open tab item
    const openTabItem = browser.document.body.querySelector('[role="option"]');
    assert.ok(openTabItem, "open tab option is rendered");

    await act(async () => {
      openTabItem.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // Verify onActivateTab was called with the exact tab ID, NOT onNavigate!
    assert.deepEqual(activatedTabs, ["order:00123"]);
    assert.equal(navigatedPaths.length, 0, "open tab activation must not call onNavigate");
  } finally {
    await search.cleanup();
  }
});

test("dirty leave cancellation does not record recent access or switch tabs", async () => {
  const pages = [
    { label: "工作台", path: "/workbench", group: "工作区" },
    { label: "规则与价目", path: "/supply/rules", group: "供给与目录" },
  ];
  const tabs = [
    { id: "workbench", title: "工作台", path: "/workbench", query: {}, closable: false, kind: "workbench" },
  ];

  // onNavigate returns false simulating user cancelling dirty leave confirmation
  const search = await renderSearch({
    pages,
    tabs,
    activeTabId: "workbench",
    onNavigate: () => false,
    adminUserId: "boss-1",
    sessionId: "sess-1",
  });

  try {
    const triggerBtn = search.rootNode.querySelector('button[aria-label="搜索页面"]');
    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    const input = browser.document.body.querySelector('input[placeholder*="在当前权限内的已实现页面中查找"]');
    await setInput(input, "规则");
    await settle();

    const option = browser.document.body.querySelector('[role="option"]');
    assert.ok(option, "option found");

    await act(async () => {
      option.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // Reopen search: query should be empty and recent access should NOT contain the cancelled item!
    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // Verify "最近访问" does not appear since dirty cancellation rejected the transition
    assert.equal(browser.document.body.textContent.includes("最近访问"), false);
  } finally {
    await search.cleanup();
  }
});

test("recent access records actual activation, evicts closed details, and unmounts on lock", async () => {
  const pages = [
    { label: "工作台", path: "/workbench", group: "工作区" },
    { label: "设置", path: "/settings", group: "个人" },
    { label: "管理员管理", path: "/admins", group: "系统管理" },
  ];
  const tabs = [
    { id: "workbench", title: "工作台", path: "/workbench", query: {}, closable: false, kind: "workbench" },
    { id: "admin:admin-1", title: "管理员详情", path: "/admins/admin-1", query: {}, closable: true, kind: "admin-object", objectId: "admin-1" },
  ];

  const search = await renderSearch({
    pages,
    tabs,
    activeTabId: "workbench",
    adminUserId: "boss-1",
    sessionId: "sess-1",
    onNavigate: () => true,
    onActivateTab: () => true,
  });

  try {
    await search.render({ activeTabId: "admin:admin-1" });
    const triggerBtn = search.rootNode.querySelector('button[aria-label="搜索页面"]');
    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // Empty query shows Recent Access group with the active tab recorded
    assert.ok(browser.document.body.textContent.includes("最近访问"));
    assert.ok(browser.document.body.textContent.includes("admin-1"));

    // Close the search
    const escEvent = new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    await act(async () => { browser.document.dispatchEvent(escEvent); });
    await settle();

    // Now simulate closing the detail tab by updating tabs prop without admin-1
    await search.render({
      tabs: [{ id: "workbench", title: "工作台", path: "/workbench", query: {}, closable: false, kind: "workbench" }],
      activeTabId: "workbench",
    });
    await settle();

    // Reopen: admin-1 should be evicted from recent access!
    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    assert.equal(browser.document.body.textContent.includes("admin-1"), false, "closed detail tab is evicted");

    // Simulate session change or screen lock: clears recent access completely
    await search.render({ isLocked: true });
    await settle();

    assert.equal(browser.document.body.textContent.includes("最近访问"), false, "locked session clears recent items");
  } finally {
    await search.cleanup();
  }
});

test("IME composition prevents premature navigation on Enter key", async () => {
  const pages = [
    { label: "工作台", path: "/workbench", group: "工作区" },
    { label: "设置", path: "/settings", group: "个人" },
  ];
  const navigated = [];
  const search = await renderSearch({
    pages,
    onNavigate: (p) => navigated.push(p),
  });

  try {
    const triggerBtn = search.rootNode.querySelector('button[aria-label="搜索页面"]');
    await act(async () => {
      triggerBtn.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
    });
    await settle();

    const input = browser.document.body.querySelector('input[placeholder*="在当前权限内的已实现页面中查找"]');

    // Start IME composition
    await act(async () => {
      input.dispatchEvent(new browser.Event("compositionstart", { bubbles: true }));
    });

    // Press Enter during IME composition
    const enterEvent = new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    Object.defineProperty(enterEvent, "isComposing", { value: true });
    await act(async () => {
      input.dispatchEvent(enterEvent);
    });
    await settle();

    // Must NOT trigger navigation!
    assert.equal(navigated.length, 0, "IME composition Enter must not trigger navigation");
  } finally {
    await search.cleanup();
  }
});

test("global Ctrl+K is guarded when another modal dialog is already open", async () => {
  const pages = [{ label: "工作台", path: "/workbench", group: "工作区" }];
  const search = await renderSearch({ pages, onNavigate: () => {} });

  try {
    // Inject a non-command dialog into the body
    const otherDialog = browser.document.createElement("div");
    otherDialog.setAttribute("data-slot", "dialog-content");
    browser.document.body.appendChild(otherDialog);

    // Press Ctrl+K
    const ctrlK = new browser.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true });
    await act(async () => {
      browser.window.dispatchEvent(ctrlK);
    });
    await settle();

    // Command palette must NOT open!
    assert.equal(browser.document.body.querySelector('[data-command-palette="true"]'), null, "Ctrl+K is guarded by other dialog");

    // Remove the blocking dialog
    otherDialog.remove();

    // Press Ctrl+K again
    await act(async () => {
      browser.window.dispatchEvent(ctrlK);
    });
    await settle();

    // Now it opens!
    assert.ok(browser.document.body.querySelector('[data-command-palette="true"]'), "Ctrl+K opens command palette when unblocked");
  } finally {
    await search.cleanup();
  }
});

async function openPalette(view) {
  await act(async () => view.rootNode.querySelector('button[aria-label="搜索页面"]').click());
  await settle();
  return browser.document.querySelector('[cmdk-input]');
}

test("F1 alias and recent selections activate the current tab, preserving its query", async () => {
  const page = { label: "用户管理", path: "/users", group: "用户", keywords: ["yh"] };
  const tab = { id: "users", title: page.label, path: page.path, kind: "users", closable: true, query: { q: "KEEP", cursor: "CURSOR" } };
  const activated = [], navigated = [];
  const view = await renderSearch({ pages: [page], tabs: [tab], onActivateTab: id => { activated.push(id); return true; }, onNavigate: p => { navigated.push(p); return true; } });
  try {
    const input = await openPalette(view);
    await setInput(input, "yh");
    await settle();
    assert.equal(browser.document.querySelectorAll('[cmdk-item]').length, 1);
    await act(async () => browser.document.querySelector('[cmdk-item]').click());
    await settle();
    await openPalette(view);
    await act(async () => browser.document.querySelector('[cmdk-item]').click());
    await settle();
    assert.deepEqual(activated, ["users", "users"]);
    assert.deepEqual(navigated, []);
    assert.deepEqual(tab.query, { q: "KEEP", cursor: "CURSOR" });
  } finally { await view.cleanup(); }
});

test("F2 page-only recent entries disappear when their page permission is withdrawn", async () => {
  const page = { label: "审计", path: "/audit", group: "系统" };
  let navigated = 0;
  const view = await renderSearch({ pages: [page], onNavigate: () => { navigated++; return true; } });
  try {
    await openPalette(view);
    await act(async () => browser.document.querySelector('[cmdk-item]').click());
    await settle();
    await view.render({ pages: [], tabs: [] });
    await openPalette(view);
    assert.equal(browser.document.querySelectorAll('[cmdk-item]').length, 0);
    assert.equal(browser.document.body.textContent.includes("最近访问"), false);
    assert.equal(navigated, 1);
  } finally { await view.cleanup(); }
});

test("F3 lock, identity and authentication-session changes remove the palette and query", async () => {
  const props = { pages: [{ label: "设置", path: "/settings", group: "个人" }], onNavigate: () => true, adminUserId: "one", sessionId: "s1" };
  const view = await renderSearch(props);
  const hotkey = async () => { await act(async () => browser.window.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }))); await settle(); };
  try {
    await setInput(await openPalette(view), "PRIVATE_QUERY");
    await view.render({ isLocked: true });
    await hotkey();
    assert.equal(browser.document.querySelector('[data-command-palette="true"]'), null);
    assert.equal(view.rootNode.querySelector('button'), null);
    await view.render({ isLocked: false });
    assert.equal((await openPalette(view)).value, "");
    await setInput(browser.document.querySelector('[cmdk-input]'), "OLD_IDENTITY");
    await view.render({ adminUserId: "two" });
    assert.equal(browser.document.querySelector('[data-command-palette="true"]'), null);
    assert.equal((await openPalette(view)).value, "");
    await setInput(browser.document.querySelector('[cmdk-input]'), "OLD_SESSION");
    await view.render({ sessionId: "s2" });
    assert.equal(browser.document.querySelector('[data-command-palette="true"]'), null);
    assert.equal((await openPalette(view)).value, "");
  } finally { await view.cleanup(); }
});

test("F4 a real open Sheet blocks Ctrl+K; closed and already-handled events do not steal focus", async () => {
  const { Sheet, SheetContent, SheetTitle } = await vite.ssrLoadModule('/src/components/ui/sheet.tsx');
  const host = browser.document.createElement('div'); browser.document.body.appendChild(host);
  const sheet = createRoot(host);
  const view = await renderSearch({ pages: [], onNavigate: () => true });
  const key = () => new browser.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  try {
    await act(async () => sheet.render(createElement(Sheet, { open: true }, createElement(SheetContent, null, createElement(SheetTitle, null, "阻塞表单")))));
    await act(async () => browser.window.dispatchEvent(key())); await settle();
    assert.equal(browser.document.querySelector('[data-command-palette="true"]'), null);
    await act(async () => sheet.render(createElement(Sheet, { open: false }, createElement(SheetContent, null, createElement(SheetTitle, null, "阻塞表单")))));
    await settle();
    const handled = key(); handled.preventDefault();
    await act(async () => browser.window.dispatchEvent(handled)); await settle();
    assert.equal(browser.document.querySelector('[data-command-palette="true"]'), null);
    await act(async () => browser.window.dispatchEvent(key())); await settle();
    assert.ok(browser.document.querySelector('[data-command-palette="true"]'));
  } finally { await view.cleanup(); await act(async () => sheet.unmount()); host.remove(); }
});

test("F5 command dialog has an associated accessible title", async () => {
  const view = await renderSearch({ pages: [], onNavigate: () => true });
  try {
    await openPalette(view);
    const dialog = browser.document.querySelector('[data-command-palette="true"]');
    const ids = dialog.getAttribute('aria-labelledby')?.split(/\s+/);
    assert.ok(ids?.length);
    assert.equal(ids.map(id => browser.document.getElementById(id)?.textContent).join(' '), "搜索页面与标签");
  } finally { await view.cleanup(); }
});

test("recent access keeps only the six actual activations and removes closed details", async () => {
  const tabs = Array.from({ length: 7 }, (_, i) => ({ id: `admin:${i}`, title: `管理员${i}`, path: `/admins/${i}`, query: {}, kind: "admin-object", objectId: String(i), closable: true }));
  const view = await renderSearch({ pages: [], tabs, activeTabId: "workbench", onNavigate: () => true, onActivateTab: () => true });
  try {
    for (const tab of tabs) await view.render({ activeTabId: tab.id });
    await openPalette(view);
    const group = () => [...browser.document.querySelectorAll('[cmdk-group]')].find(el => el.textContent.includes('最近访问'));
    assert.equal(group().querySelectorAll('[cmdk-item]').length, 6);
    assert.equal(group().textContent.includes('管理员0'), false);
    await view.render({ tabs: tabs.slice(0, 6), activeTabId: "workbench" });
    assert.equal(group().textContent.includes('管理员6'), false);
    assert.equal(group().querySelectorAll('[cmdk-item]').length, 5);
  } finally { await view.cleanup(); }
});
