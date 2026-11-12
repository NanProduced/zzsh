import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

/**
 * 内容管理「帮助目录」tab 组件测试（happy-dom + 离线源码转译 + 合成 fetch）。
 * IA 收尾：帮助中心目录从内部文档库迁到内容管理；覆盖树渲染/新建/改名/移动/删除确认/
 * 点击文章落在可编辑编辑器（复用 resource 编辑链路）/回收站恢复权限/分区顺序与 helper 文案。
 * 证据边界：合成 DOM 与 fetch，不等于真实 HTTP/浏览器验收。
 */

const MANAGE = ["content.platform.read", "content.platform.edit", "content.platform.publish"];
const READ_ONLY = ["content.platform.read"];

const GLOBAL_KEYS = [
  "Window", "Document", "ShadowRoot", "DocumentFragment", "DocumentType", "CharacterData", "ProcessingInstruction",
  "Attr", "DOMImplementation", "XMLSerializer", "DOMParser", "Element", "SVGElement", "HTMLElement", "Node",
  "Text", "Comment", "Range", "Selection", "StaticRange", "AbstractRange", "Event", "EventTarget", "CustomEvent",
  "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "ClipboardEvent", "DragEvent",
  "CompositionEvent", "WheelEvent", "PointerEvent", "TouchEvent", "MutationObserver", "MutationRecord",
  "ResizeObserver", "ResizeObserverEntry", "IntersectionObserver", "Image", "DOMRect", "DOMRectReadOnly",
  "DOMRectList", "DOMPoint", "DOMMatrix", "DataTransfer", "DataTransferItem", "DataTransferItemList",
  "NodeList", "HTMLCollection", "NamedNodeMap", "DOMTokenList", "DOMStringMap", "CSSStyleSheet", "CSSRule",
  "CSSStyleDeclaration", "MediaList", "CSS", "StyleSheet", "FileList", "FileReader", "File", "FormData",
  "matchMedia", "MediaQueryList", "screen", "history", "location", "getComputedStyle",
];

function exposeBrowserGlobals(browser) {
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  for (const key of GLOBAL_KEYS) if (browser[key] !== undefined) globalThis[key] = browser[key];
  for (const key of Object.getOwnPropertyNames(browser)) {
    if (key.startsWith("HTML") && browser[key] !== undefined) globalThis[key] = browser[key];
  }
  globalThis.requestAnimationFrame = browser.requestAnimationFrame.bind(browser);
  globalThis.cancelAnimationFrame = browser.cancelAnimationFrame.bind(browser);
  globalThis.innerWidth = browser.innerWidth;
  globalThis.innerHeight = browser.innerHeight;
  if (globalThis.Node && globalThis.Node.prototype.DOCUMENT_POSITION_PRECEDING === undefined) {
    Object.assign(globalThis.Node.prototype, {
      DOCUMENT_POSITION_DISCONNECTED: 1, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_CONTAINS: 8, DOCUMENT_POSITION_CONTAINED_BY: 16, DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32,
    });
  }
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  Object.defineProperty(browser.navigator, "locks", { value: { request: async (name, _options, callback) => callback({ name }) }, configurable: true });
}

const bootstrap = new Window({ url: "http://127.0.0.1:3101/" });
exposeBrowserGlobals(bootstrap);
const { createRoot } = await import("react-dom/client");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = await createOfflineAdminSource({ root });
const { ContentHelpTree } = await source.ssrLoadModule("/apps/admin/src/views/content-help-tree.tsx");
const { ContentView } = await source.ssrLoadModule("/apps/admin/src/views/content-view.tsx");
// 预热懒加载编辑器：harness 缓存命中后 lazy import 立即解析。
await source.ssrLoadModule("/apps/admin/src/components/plate/plate-editor.tsx");
await source.ssrLoadModule("/apps/admin/src/views/content-resource-editor.tsx");

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const snapshot = (permissions, isBoss = false) => ({
  authenticated: true,
  adminUserId: "admin_help",
  user: { name: "内容管理员", username: "admin_help", displayUsername: "内容管理员", twoFactorEnabled: false },
  security: { status: "ACTIVE", isBoss, passwordChangeRequired: false },
  session: { id: "sess_help", locked: false, pinConfigured: false, createdAt: null, expiresAt: null },
  permissions,
});

const helpFolder = { id: "help_rental", parentId: null, depth: 1, kind: "FOLDER", title: "租号与使用", iconKey: "rental", sortKey: "a0", revision: "3", updatedAt: "2026-11-11T02:00:00.000Z", updatedBy: "admin_ops", referenceCount: 2 };
const helpArticle = { id: "help_art_1", parentId: "help_rental", depth: 2, kind: "ARTICLE", title: "如何下单", resourceKey: "guide:how-to-order", sortKey: "a0", revision: "5", updatedAt: "2026-11-11T02:00:00.000Z", updatedBy: "admin_ops", published: true, hasDraft: true, referenceCount: 2 };
const helpArticleNoDraft = { id: "help_art_2", parentId: "help_rental", depth: 2, kind: "ARTICLE", title: "下单前检查", resourceKey: "guide:check-before-order", sortKey: "b0", revision: "6", updatedAt: "2026-11-11T02:00:00.000Z", updatedBy: "admin_ops", published: true, hasDraft: false };
const HELP_TREE = { nodes: [helpFolder, helpArticle, helpArticleNoDraft] };

const plateDoc = (text = "帮助文章正文") => ({ format: "plate", schemaVersion: 1, preset: "help", value: [{ type: "p", id: "n1", children: [{ text }] }] });
const guidePayload = (slug, title, over = {}) => ({
  kind: "guide", id: slug, slug, title, summary: "摘要", category: "rental", audience: ["all"], keywords: [], related: [],
  updatedAt: "2026-11-11", format: "plate", schemaVersion: 1, document: plateDoc(), mediaIds: [], ...over,
});
const RESOURCE_SCHEMA = "content-resource.v1";
const resourceDetail = (slug, title, { withDraft = true } = {}) => {
  const key = `guide:${slug}`;
  const payload = guidePayload(slug, title);
  const published = { id: `pub_${slug}`, sequence: 1, state: "PUBLISHED", revision: "1", title, payload, publishedAt: "2026-11-11T02:00:00.000Z", updatedAt: "2026-11-11T02:00:00.000Z" };
  const draft = withDraft ? { id: `draft_${slug}`, sequence: 2, state: "DRAFT", revision: "2", title, payload, publishedAt: null, updatedAt: "2026-11-11T03:00:00.000Z" } : null;
  return {
    key,
    definition: { key, kind: "guide", label: title, group: "help", locations: [`/help/${slug}`] },
    item: { id: `item_${slug}`, resourceKey: key, gameId: null, revision: "3" },
    draft, published, versions: [...(draft ? [draft] : []), published],
    current: { schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: "available", payload, media: [] },
    baseline: null,
  };
};

function router(handlers) {
  return (url, init) => {
    const method = init.method ?? "GET";
    const entry = handlers.find((h) => (h.method ?? "GET") === method && (h.match instanceof RegExp ? h.match.test(url.pathname) : url.pathname === h.match));
    if (!entry) throw new Error(`unexpected help-tree test request ${method} ${url.pathname}${url.search}`);
    return entry.response(url, init);
  };
}

const helpTreeHandler = (page = HELP_TREE) => ({ match: "/api/bff/admin/content/help-tree", response: () => json(page) });
const helpTrashHandler = (page = { items: [], nextCursor: null }) => ({ match: "/api/bff/admin/content/help-tree/trash", response: () => json(page) });
const resourceHandler = (slug, title, options) => ({ match: `/api/bff/admin/content/resources/${encodeURIComponent(`guide:${slug}`)}`, response: () => json(resourceDetail(slug, title, options)) });

async function mountHelp(t, { perms = MANAGE, handlers = [], component = ContentHelpTree, props = {} }) {
  const browser = new Window({ url: "http://127.0.0.1:3101/content?tab=help" });
  browser.Element.prototype.scrollIntoView = function () {};
  exposeBrowserGlobals(browser);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    requests.push({ path: url.pathname, query: url.search, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : null, key: new Headers(init.headers).get("idempotency-key") });
    return router(handlers)(url, init);
  };
  const el = browser.document.createElement("div");
  el.className = "workspace-root";
  browser.document.body.append(el);
  const reactRoot = createRoot(el);
  const dirtyLog = [];
  const lockLog = [];
  const renderWithPermissions = async (permissions) => {
    await act(async () => {
      reactRoot.render(createElement(component, {
        snapshot: snapshot(permissions),
        refreshNonce: 0,
        onDirtyChange: (dirty) => dirtyLog.push(dirty),
        onWriteLockChange: (locked) => lockLog.push(locked),
        ...props,
      }));
    });
  };
  await renderWithPermissions(perms);
  const settle = async (ms = 30) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  await settle();
  const click = async (node) => { await act(async () => { node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); }); await settle(); };
  const setInput = async (input, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
  };
  const waitFor = async (predicate, timeout = 6000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (predicate()) return;
      await settle(25);
    }
    assert.ok(predicate(), "waitFor 超时：条件未成立");
  };
  const btn = (name, scope = el) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === name);
  t.after(async () => {
    await act(async () => { reactRoot.unmount(); });
    globalThis.fetch = originalFetch;
    await browser.happyDOM.abort();
  });
  return { browser, el, requests, dirtyLog, lockLog, settle, click, setInput, waitFor, btn, renderWithPermissions };
}

async function openMenu(h, trigger) {
  await act(async () => { trigger.dispatchEvent(new h.browser.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await h.settle(40);
}

async function clickMenuItem(h, label) {
  const item = [...h.browser.document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim() === label);
  assert.ok(item, `menu item ${label}`);
  await act(async () => {
    item.dispatchEvent(new h.browser.PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    item.dispatchEvent(new h.browser.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await h.settle(40);
}

async function openNew(h, label) {
  await h.waitFor(() => h.btn("新建"));
  await openMenu(h, h.btn("新建"));
  await clickMenuItem(h, label);
}

test("目录显示分组、文章与服务端发布状态，缺少状态时不误报未发布", async (t) => {
  const unknown = { ...helpArticleNoDraft, id: "unknown", resourceKey: "guide:unknown", published: undefined, hasDraft: undefined };
  const withdrawn = { ...helpArticleNoDraft, id: "withdrawn", resourceKey: "guide:withdrawn", published: false, hasDraft: false, withdrawn: true };
  const h = await mountHelp(t, { handlers: [helpTreeHandler({ nodes: [...HELP_TREE.nodes, unknown, withdrawn] })] });
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_1"]'));
  const tree = h.el.querySelector('[role="tree"][aria-label="帮助中心目录"]');
  assert.ok(tree, "帮助目录树容器");
  assert.equal(h.el.querySelector(".help-directory-header h2").textContent, "帮助目录");
  const folder = h.el.querySelector('[data-help-id="help_rental"]');
  assert.ok(folder.textContent.includes("租号与使用"));
  assert.equal(folder.getAttribute("aria-level"), "1");
  const article = h.el.querySelector('[data-help-id="help_art_1"]');
  assert.ok(article.textContent.includes("如何下单"));
  assert.ok(article.textContent.includes("待发布"), "已发布且有草稿 → 待发布");
  assert.equal(article.querySelector(".help-tree-status").getAttribute("title"), "有未发布修改");
  assert.equal(article.getAttribute("aria-level"), "2");
  const noDraft = h.el.querySelector('[data-help-id="help_art_2"]');
  assert.ok(noDraft.textContent.includes("已发布"), "已发布无草稿 → 已发布");
  assert.equal(h.el.querySelector('[data-help-id="unknown"] .help-tree-status'), null);
  assert.ok(h.el.querySelector('[data-help-id="withdrawn"] .help-tree-status').textContent.includes("已下线"));
  assert.ok(h.btn("新建"));
  assert.equal(h.requests.some(request => request.path === "/api/bff/admin/content/resources"), false);
  await h.setInput(h.el.querySelector('[aria-label="搜索帮助文章"]'), "检查");
  assert.equal(h.el.querySelector('[data-help-id="help_art_1"]'), null);
  assert.ok(h.el.querySelector('[data-help-id="help_art_2"]'));
});

test("新建文件夹与文章走幂等写接口；slug 墓碑冲突给出可读提示", async (t) => {
  const writes = [];
  const h = await mountHelp(t, {
    handlers: [
      helpTreeHandler(), helpTrashHandler(),
      { method: "POST", match: "/api/bff/admin/content/help-tree/folders", response: (url, init) => { writes.push({ path: url.pathname, body: JSON.parse(init.body), key: new Headers(init.headers).get("idempotency-key") }); return json({ node: { ...helpFolder, id: "help_new", title: JSON.parse(init.body).title } }); } },
      { method: "POST", match: "/api/bff/admin/content/help-tree/articles", response: (url, init) => { writes.push({ path: url.pathname, body: JSON.parse(init.body), key: new Headers(init.headers).get("idempotency-key") }); return json({ error: { code: "INVALID_ARGUMENT", reason: "SLUG_RETIRED" } }, 400); } },
    ],
  });
  await openNew(h, "新建分组");
  const dialog = h.browser.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "新建文件夹弹窗");
  await h.setInput(dialog.querySelector("input"), "费用与资金");
  await h.click([...dialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "创建"));
  await h.waitFor(() => writes.length === 1);
  assert.equal(writes[0].path, "/api/bff/admin/content/help-tree/folders");
  assert.deepEqual(writes[0].body, { parentId: null, title: "费用与资金" });
  assert.match(writes[0].key, /^idem_/);

  await openNew(h, "新建文章");
  const articleDialog = h.browser.document.querySelector('[role="dialog"]');
  await h.setInput(articleDialog.querySelector("input"), "已下线的文章");
  await h.setInput([...articleDialog.querySelectorAll("input")][1], "retired-slug");
  await h.click([...articleDialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "创建"));
  await h.waitFor(() => h.browser.document.body.textContent.includes("此文章地址已被使用"));
  assert.equal(writes[1].path, "/api/bff/admin/content/help-tree/articles");
  assert.equal(writes[1].body.slug, "retired-slug");
});

test("改名与移动带树节点 revision；删除确认显示引用数并进回收站", async (t) => {
  const writes = [];
  const record = (url, init) => { writes.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body), key: new Headers(init.headers).get("idempotency-key") }); };
  const h = await mountHelp(t, {
    handlers: [
      helpTreeHandler(), helpTrashHandler(),
      { method: "PATCH", match: "/api/bff/admin/content/help-tree/help_rental", response: (url, init) => { record(url, init); return json({ node: { ...helpFolder, title: JSON.parse(init.body).title, revision: "4" } }); } },
      { method: "POST", match: "/api/bff/admin/content/help-tree/help_art_1/move", response: (url, init) => { record(url, init); return json({ node: helpArticle }); } },
      { method: "DELETE", match: "/api/bff/admin/content/help-tree/help_rental", response: (url, init) => { record(url, init); return json({ deletedCount: 3, batchId: "hbatch_1", purgeAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), referenceCount: 2 }); } },
    ],
  });
  await h.waitFor(() => h.el.querySelector('[aria-label="「租号与使用」操作"]'));
  await openMenu(h, h.el.querySelector('[aria-label="「租号与使用」操作"]'));
  await clickMenuItem(h, "编辑分组");
  const renameDialog = h.browser.document.querySelector('[role="dialog"]');
  await h.setInput(renameDialog.querySelector("input"), "租号与使用（改）");
  await h.click([...renameDialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "保存"));
  await h.waitFor(() => writes.length === 1);
  assert.equal(writes[0].method, "PATCH");
  assert.deepEqual(writes[0].body, { expectedRevision: "3", title: "租号与使用（改）", iconKey: "rental" });
  assert.match(writes[0].key, /^idem_/);

  await h.waitFor(() => h.el.querySelector('[aria-label="「如何下单」操作"]'));
  await openMenu(h, h.el.querySelector('[aria-label="「如何下单」操作"]'));
  await clickMenuItem(h, "移动到…");
  const moveDialog = h.browser.document.querySelector('[role="dialog"]');
  assert.ok(moveDialog, "移动弹窗");
  assert.ok(moveDialog.textContent.includes("线上目录立即更新，文章地址保持不变"));
  await h.click([...moveDialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "移动"));
  await h.waitFor(() => writes.length === 2);
  assert.equal(writes[1].path, "/api/bff/admin/content/help-tree/help_art_1/move");
  assert.deepEqual(writes[1].body, { expectedRevision: "5", parentId: "help_rental", afterId: null });

  await h.waitFor(() => h.el.querySelector('[aria-label="「租号与使用」操作"]'));
  await openMenu(h, h.el.querySelector('[aria-label="「租号与使用」操作"]'));
  await clickMenuItem(h, "删除");
  const deleteDialog = h.browser.document.querySelector('[role="alertdialog"]');
  assert.ok(deleteDialog.textContent.includes("有 2 处引用"), "确认框显示引用数不拦截");
  assert.ok(deleteDialog.textContent.includes("保留 30 天"));
  await h.click([...deleteDialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "删除进回收站"));
  await h.waitFor(() => writes.length === 3);
  assert.equal(writes[2].method, "DELETE");
  assert.deepEqual(writes[2].body, { expectedRevision: "3" });
  await h.waitFor(() => h.el.textContent.includes("已将 3 项移到回收站"));
});

test("目录常驻，预览保留输入，切文档前确认未保存修改，手动保存走幂等写链路", async (t) => {
  const h = await mountHelp(t, {
    handlers: [
      helpTreeHandler(), helpTrashHandler(),
      resourceHandler("how-to-order", "如何下单"),
      resourceHandler("check-before-order", "下单前检查", { withDraft: false }),
      { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.versionId, "draft_how-to-order");
        assert.equal(body.expectedRevision, "3");
        const detail = resourceDetail("how-to-order", body.payload.title);
        detail.item.revision = "4";
        return json(detail);
      } },
    ],
  });
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_1"]'));
  await h.click(h.el.querySelector('[data-help-id="help_art_1"]'));
  await h.waitFor(() => h.el.querySelector('.plate-editor [contenteditable="true"]'), 8000);
  assert.ok(h.el.querySelector('[aria-label="内容编辑器"]'), "落在内容编辑器而非只读预览");
  assert.equal(h.el.querySelector('[aria-label="正文只读视图"]'), null, "不是只读渲染");
  const title = h.el.querySelector('input[aria-label="文档标题"]');
  assert.ok(title && !title.disabled, "标题输入可编辑");
  const row = h.el.querySelector('[data-help-id="help_art_1"]');
  assert.equal(row.getAttribute("aria-selected"), "true");
  assert.equal(h.btn("撤回审批"), undefined);
  await h.setInput(title, "如何下单（改）");
  await h.click(h.btn("草稿预览"));
  const preview = h.el.querySelector('[aria-label="用户端预览"]');
  assert.ok(preview?.textContent.includes("如何下单（改）"));
  await h.click(h.btn("返回编辑"));
  assert.equal(title.value, "如何下单（改）");

  await h.click(h.el.querySelector('[data-help-id="help_art_2"]'));
  const discard = h.browser.document.querySelector('[role="alertdialog"]');
  assert.ok(discard?.textContent.includes("放弃未保存的修改"));
  assert.equal(row.getAttribute("aria-selected"), "true");
  await h.click(h.btn("继续编辑", discard));
  assert.equal(title.value, "如何下单（改）");
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => h.requests.some((request) => request.method === "PUT" && request.path.endsWith("/draft")));
  const save = h.requests.find((request) => request.method === "PUT" && request.path.endsWith("/draft"));
  assert.match(save.key, /^idem_/);
  assert.equal(save.body.payload.title, "如何下单（改）");
  await h.waitFor(() => row.textContent.includes("如何下单（改）"));
  await h.click(h.el.querySelector('[data-help-id="help_art_2"]'));
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_2"][aria-selected="true"]'));
  assert.ok(h.el.querySelector('[data-help-id="help_art_1"]'), "切换后目录仍在");
});

test("草稿保存结果待核对时保留输入，回执确认后原编辑器不重新挂载", async (t) => {
  let acceptedTitle = "";
  const h = await mountHelp(t, {
    handlers: [
      helpTreeHandler(),
      { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order", response: () => {
        const detail = resourceDetail("how-to-order", acceptedTitle || "如何下单");
        if (acceptedTitle) detail.item.revision = "4";
        return json(detail);
      } },
      { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: (url, init) => {
        acceptedTitle = JSON.parse(init.body).payload.title;
        return json({ error: { code: "INTERNAL_ERROR" } }, 502);
      } },
      { match: "/api/bff/admin/content/operation-result", response: url => json({
        receipt: "RECORDED", operation: url.searchParams.get("operation"), resourceId: url.searchParams.get("resourceId"),
        responseStatus: 200, result: { itemId: "item_how-to-order" },
      }) },
    ],
  });
  await h.click(h.el.querySelector('[data-help-id="help_art_1"]'));
  await h.waitFor(() => h.el.querySelector('[aria-label="文档标题"]'));
  const title = h.el.querySelector('[aria-label="文档标题"]');
  await h.setInput(title, "等待核对的标题");
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => h.btn("核对原操作结果"));
  assert.equal(title.value, "等待核对的标题");
  await h.click(h.btn("核对原操作结果"));
  await h.waitFor(() => !h.btn("核对原操作结果") && h.el.querySelector('[data-phase="saved"]'));
  assert.equal(h.el.querySelector('[aria-label="文档标题"]'), title);
  assert.equal(title.value, "等待核对的标题");
});

test("已发布无草稿文章：线上快照只读提示＋创建草稿后编辑，创建后进入编辑态", async (t) => {
  let created = false;
  const h = await mountHelp(t, {
    handlers: [
      helpTreeHandler(), helpTrashHandler(),
      { match: "/api/bff/admin/content/resources/guide%3Acheck-before-order", response: () => json(resourceDetail("check-before-order", "下单前检查", { withDraft: created })) },
      { method: "POST", match: "/api/bff/admin/content/resources/guide%3Acheck-before-order/draft", response: () => { created = true; return json(resourceDetail("check-before-order", "下单前检查")); } },
    ],
  });
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_2"]'));
  await h.click(h.el.querySelector('[data-help-id="help_art_2"]'));
  await h.waitFor(() => h.el.textContent.includes("发布后，用户才能看到修改。"));
  const createDraft = h.btn("开始编辑");
  assert.ok(createDraft, "canEdit 时提供创建草稿入口（编辑态链路，而非只读预览）");
  await h.click(createDraft);
  await h.waitFor(() => h.el.querySelector('.plate-editor [contenteditable="true"]'), 8000);
  assert.equal(h.el.querySelector('input[aria-label="文档标题"]').disabled, false);
});

test("客服窄权限只读线上文章，目录不拉通用资源列表，写入 403 保留错误", async (t) => {
  let narrow = false;
  const h = await mountHelp(t, {
    perms: READ_ONLY,
    handlers: [
      helpTreeHandler(),
      { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order", response: () => json(resourceDetail("how-to-order", narrow ? "如何下单" : "仅平台账号可见的草稿", { withDraft: !narrow })) },
    ],
  });
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_1"]'));
  await h.click(h.el.querySelector('[data-help-id="help_art_1"]'));
  await h.waitFor(() => h.el.textContent.includes("仅平台账号可见的草稿"));
  narrow = true;
  await h.renderWithPermissions(["content.help.read"]);
  assert.equal(h.el.textContent.includes("仅平台账号可见的草稿"), false, "权限收窄时清除旧详情");
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_1"]'));
  assert.equal(h.btn("新建"), undefined);
  assert.equal(h.btn("回收站"), undefined);
  assert.equal(h.el.querySelector('[aria-label="「如何下单」操作"]'), null, "只读无行菜单");
  assert.ok(h.el.textContent.includes("只读"), "只读徽章");
  await h.click(h.el.querySelector('[data-help-id="help_art_1"]'));
  await h.waitFor(() => h.el.querySelector('[aria-label="正文只读视图"]'));
  assert.equal(h.el.textContent.includes("版本历史"), false);
  assert.equal(h.requests.some(request => request.path === "/api/bff/admin/content/resources"), false);
  assert.equal(h.el.querySelector('.plate-editor [contenteditable="true"]'), null);

  const denied = await mountHelp(t, {
    handlers: [
      helpTreeHandler(), helpTrashHandler(),
      { method: "POST", match: "/api/bff/admin/content/help-tree/folders", response: () => json({ error: { code: "FORBIDDEN" } }, 403) },
    ],
  });
  await openNew(denied, "新建分组");
  const dialog = denied.browser.document.querySelector('[role="dialog"]');
  await denied.setInput(dialog.querySelector("input"), "无权目录");
  await denied.click([...dialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "创建"));
  await denied.waitFor(() => denied.browser.document.body.textContent.includes("没有权限"));
});

test("帮助回收站：30 天倒计时、恢复需发布权限、只读无恢复按钮", async (t) => {
  const trashPage = { items: [{ batchId: "hbatch_1", rootNodeId: "help_rental", title: "租号与使用", deletedAt: "2026-11-01T02:00:00.000Z", deletedBy: "admin_ops", count: 2, purgeAt: new Date(Date.now() + 12 * 86_400_000).toISOString() }], nextCursor: null };
  const restores = [];
  const handlers = [
    helpTreeHandler(),
    { match: "/api/bff/admin/content/help-tree/trash", response: () => json(trashPage) },
    { method: "POST", match: "/api/bff/admin/content/help-tree/trash/hbatch_1/restore", response: (url, init) => { restores.push(new Headers(init.headers).get("idempotency-key")); return json({ node: helpFolder }); } },
  ];
  const ops = await mountHelp(t, { handlers, perms: ["content.platform.read", "content.platform.edit", "content.help.publish"] });
  await ops.click(ops.btn("回收站"));
  await ops.waitFor(() => ops.browser.document.querySelector('[data-help-batch="hbatch_1"]'));
  const item = ops.browser.document.querySelector('[data-help-batch="hbatch_1"]');
  assert.ok(item.textContent.includes("12 天后永久清理"));
  const restoreButton = [...item.querySelectorAll("button")].find((button) => button.textContent.includes("恢复"));
  assert.ok(restoreButton, "有发布权限可恢复");
  await ops.click(restoreButton);
  await ops.waitFor(() => restores.length === 1);
  assert.match(restores[0], /^idem_/);
  assert.ok(ops.browser.document.body.textContent.includes("已恢复 2 项"));

  const readOnly = await mountHelp(t, { perms: READ_ONLY, handlers });
  await readOnly.click(readOnly.btn("回收站"));
  await readOnly.waitFor(() => readOnly.browser.document.querySelector('[data-help-batch="hbatch_1"]'));
  assert.equal(readOnly.browser.document.querySelectorAll('[data-help-batch="hbatch_1"] button').length, 0, "只读无恢复按钮");
});

test("新建文章响应不确定时保留输入，同一请求键重试后进入草稿", async (t) => {
  const requestKeys = [];
  const newNode = { ...helpArticle, id: "new_article", resourceKey: "guide:new-article", title: "新文章", published: false };
  let created = false;
  const h = await mountHelp(t, {
    handlers: [
      { match: "/api/bff/admin/content/help-tree", response: () => json({ nodes: created ? [...HELP_TREE.nodes, newNode] : HELP_TREE.nodes }) },
      { method: "POST", match: "/api/bff/admin/content/help-tree/articles", response: (url, init) => {
        requestKeys.push(new Headers(init.headers).get("idempotency-key"));
        if (requestKeys.length === 1) return json({ error: { code: "INTERNAL_ERROR" } }, 502);
        created = true;
        return json({ node: newNode });
      } },
      resourceHandler("new-article", "新文章"),
    ],
  });
  await openNew(h, "新建文章");
  const dialog = h.browser.document.querySelector('[role="dialog"]');
  await h.setInput(dialog.querySelector("input"), "新文章");
  await h.click(h.btn("创建", dialog));
  await h.waitFor(() => dialog.textContent.includes("可保留填写内容并重试"));
  assert.equal(dialog.querySelector("input").value, "新文章");
  await h.click(h.btn("创建", dialog));
  await h.waitFor(() => h.el.querySelector('[data-help-id="new_article"][aria-selected="true"]'));
  await h.waitFor(() => h.el.querySelector('[aria-label="文档标题"]')?.value === "新文章");
  assert.equal(requestKeys.length, 2);
  assert.match(requestKeys[0], /^idem_/);
  assert.equal(requestKeys[0], requestKeys[1]);
});

test("独立帮助中心入口允许窄权限客服查看，且不打开其它内容面板", async (t) => {
  const h = await mountHelp(t, {
    perms: ["content.help.read"],
    component: ContentView,
    props: { surface: "help", tab: { id: "content-help", title: "帮助中心", path: "/content/help", query: {}, closable: true, kind: "content-help" }, onQueryChange: () => {} },
    handlers: [helpTreeHandler(), resourceHandler("how-to-order", "如何下单", { withDraft: false })],
  });
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_1"]'));
  assert.equal(h.btn("平台公告"), undefined);
  assert.equal(h.btn("新建"), undefined);
  assert.deepEqual(h.requests.map(request => request.path), ["/api/bff/admin/content/help-tree", "/api/bff/admin/content/resources/guide%3Ahow-to-order"]);
});


test("帮助发布先保存当前内容，再用保存回执的版本和修订号发布；线上链接使用服务端地址", async (t) => {
  let saved;
  const h = await mountHelp(t, { handlers: [
    helpTreeHandler({ ...HELP_TREE, publicOrigin: "https://public.example.test" }),
    resourceHandler("how-to-order", "如何下单"),
    { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: (_url, init) => {
      const body = JSON.parse(init.body);
      saved = resourceDetail("how-to-order", body.payload.title);
      saved.item.revision = "4"; saved.draft.revision = "3"; saved.draft.payload = body.payload;
      return json(saved);
    } },
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/versions/draft_how-to-order", response: () => json({ version: saved.draft, media: [] }) },
    { method: "POST", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/publish", response: (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { versionId: "draft_how-to-order", expectedRevision: "4" });
      return json({ ...saved, item: { ...saved.item, revision: "5" }, published: { ...saved.draft, state: "PUBLISHED" }, draft: null });
    } },
  ] });
  await h.waitFor(() => h.el.querySelector('[aria-label="文档标题"]'));
  const online = h.el.querySelector(".help-online-link");
  assert.equal(online?.href, "https://public.example.test/help/how-to-order");
  await h.setInput(h.el.querySelector('[aria-label="文档标题"]'), "保存回执中的标题");
  await h.click(h.btn("草稿预览"));
  assert.ok(h.el.querySelector('[aria-label="用户端预览"]').textContent.includes("草稿预览 · 尚未发布"));
  await h.click(h.btn("返回编辑"));
  await h.click(h.btn("发布"));
  await h.waitFor(() => h.requests.some(request => request.path.endsWith("/publish")));
  const writes = h.requests.filter(request => request.method !== "GET");
  assert.deepEqual(writes.map(request => request.method), ["PUT", "POST"]);
  assert.equal(writes[0].body.payload.title, "保存回执中的标题");
  assert.deepEqual(writes[1].body, { versionId: "draft_how-to-order", expectedRevision: "4" });
});

test("发布检查期间继续修改时不发布旧回执；保存结果未知时也不发布", async (t) => {
  let saved, resolveVersion;
  const h = await mountHelp(t, { handlers: [
    helpTreeHandler(), resourceHandler("how-to-order", "如何下单"),
    { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: (_url, init) => {
      const body = JSON.parse(init.body);
      saved = resourceDetail("how-to-order", body.payload.title);
      saved.item.revision = "4"; saved.draft.revision = "3"; saved.draft.payload = body.payload;
      return json(saved);
    } },
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/versions/draft_how-to-order", response: () => new Promise(resolve => { resolveVersion = () => resolve(json({ version: saved.draft, media: [] })); }) },
  ] });
  await h.waitFor(() => h.el.querySelector('[aria-label="文档标题"]'));
  assert.equal(h.el.querySelector(".help-online-link"), null, "兼容没有公开地址的旧回包");
  await h.click(h.btn("发布"));
  await h.waitFor(() => typeof resolveVersion === "function");
  assert.ok(h.lockLog.includes(true), "发布前检查期间工作台保持写入锁");
  await h.waitFor(() => !h.el.querySelector('[aria-label="文档标题"]').disabled);
  await h.setInput(h.el.querySelector('[aria-label="文档标题"]'), "检查时的新修改");
  await act(async () => { resolveVersion(); });
  await h.waitFor(() => h.btn("查看发布问题"));
  await h.click(h.btn("查看发布问题"));
  assert.ok(h.browser.document.body.textContent.includes("检查期间草稿又有修改"));
  assert.equal(h.requests.some(request => request.path.endsWith("/publish")), false);

  const unknown = await mountHelp(t, { handlers: [
    helpTreeHandler(), resourceHandler("how-to-order", "如何下单"),
    { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: () => json({ error: { code: "INTERNAL_ERROR" } }, 502) },
  ] });
  await unknown.waitFor(() => unknown.btn("发布"));
  await unknown.click(unknown.btn("发布"));
  await unknown.waitFor(() => unknown.btn("核对原操作结果"));
  assert.equal(unknown.requests.some(request => request.path.endsWith("/publish")), false);
  assert.ok(unknown.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_help"));
});

test("同层排序在已发布文章写入前提示线上影响；新文章默认当前分组", async (t) => {
  const writes = [];
  const h = await mountHelp(t, { handlers: [
    helpTreeHandler(), resourceHandler("how-to-order", "如何下单"),
    { method: "POST", match: "/api/bff/admin/content/help-tree/help_art_1/move", response: (_url, init) => { writes.push(JSON.parse(init.body)); return json({ node: helpArticle }); } },
    { method: "POST", match: "/api/bff/admin/content/help-tree/articles", response: (_url, init) => { writes.push(JSON.parse(init.body)); return json({ error: { code: "INVALID_ARGUMENT", reason: "SLUG_RETIRED" } }, 400); } },
  ] });
  await h.waitFor(() => h.el.querySelector('[aria-label="「如何下单」操作"]'));
  await openMenu(h, h.el.querySelector('[aria-label="「如何下单」操作"]'));
  await clickMenuItem(h, "下移");
  const confirmation = h.browser.document.querySelector('[role="alertdialog"]');
  assert.ok(confirmation.textContent.includes("线上目录立即更新，文章地址保持不变"));
  assert.ok(confirmation.textContent.includes("下单前检查"));
  assert.equal(writes.length, 0);
  await h.click(h.btn("确认移动", confirmation));
  await h.waitFor(() => writes.length === 1);
  assert.deepEqual(writes[0], { expectedRevision: "5", parentId: "help_rental", afterId: "help_art_2" });
  await openNew(h, "新建文章");
  const dialog = h.browser.document.querySelector('[role="dialog"]');
  await h.setInput(dialog.querySelector("input"), "虚构文章");
  await h.click(h.btn("创建", dialog));
  await h.waitFor(() => writes.length === 2);
  assert.equal(writes[1].parentId, "help_rental");
});

test("游戏手册留在帮助工作台并按游戏权限读取，返回后恢复选中文章", async (t) => {
  const opened = [];
  const h = await mountHelp(t, {
    perms: [...MANAGE, "content.read"], component: ContentView,
    props: { surface: "help", tab: { id: "content-help", title: "帮助中心", path: "/content/help", query: {}, closable: true, kind: "content-help" }, onQueryChange: () => {}, onOpenPath: path => opened.push(path) },
    handlers: [
      helpTreeHandler(), resourceHandler("how-to-order", "如何下单"), resourceHandler("check-before-order", "下单前检查", { withDraft: false }),
      { match: "/api/bff/admin/content/games", response: () => json({ games: [{ id: "game_fixture", code: "fixture", name: "虚构游戏" }] }) },
      { match: "/api/bff/admin/content/resources", response: url => { assert.equal(url.searchParams.get("scope"), "game"); assert.equal(url.searchParams.get("gameId"), "game_fixture"); return json({ items: [], nextCursor: null, limit: 5 }); } },
    ],
  });
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_2"]'));
  await h.click(h.el.querySelector('[data-help-id="help_art_2"]'));
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_2"][aria-selected="true"]'));
  await h.click(h.btn("游戏手册"));
  await h.waitFor(() => h.requests.some(request => request.path === "/api/bff/admin/content/resources"));
  assert.ok(h.el.textContent.includes("游戏手册"));
  assert.equal(h.el.querySelector('[aria-label="内容范围"]'), null);
  assert.deepEqual(opened, [], "不跳转旧内容管理");
  await h.click(h.btn("返回帮助中心"));
  await h.waitFor(() => h.el.querySelector('[data-help-id="help_art_2"][aria-selected="true"]'));
  assert.ok(h.el.querySelector('[data-help-id="help_art_1"]'), "保留展开位置");
});

test("发布前以保存版本检查素材资格，失去公开资格时阻止发布", async (t) => {
  let saved;
  const initial = resourceDetail("how-to-order", "如何下单");
  const image = { type: "img", id: "image_1", mediaId: "media_fixture", alt: "虚构图片", children: [{ text: "" }] };
  initial.draft.payload.document.value.push(image);
  initial.draft.payload.mediaIds = ["media_fixture"];
  const h = await mountHelp(t, { handlers: [
    helpTreeHandler(),
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order", response: () => json(initial) },
    { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: (_url, init) => {
      saved = structuredClone(initial); saved.item.revision = "4"; saved.draft.revision = "3"; saved.draft.payload = JSON.parse(init.body).payload;
      return json(saved);
    } },
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/versions/draft_how-to-order", response: () => json(saved
      ? { version: saved.draft, media: [{ id: "media_fixture", url: null }] }
      : { version: initial.draft, media: [{ id: "media_fixture", url: "/fixture.jpg" }] }) },
  ] });
  await h.waitFor(() => h.btn("发布") && !h.btn("发布").disabled);
  await h.click(h.btn("发布"));
  await h.waitFor(() => h.btn("查看发布问题"));
  await h.click(h.btn("查看发布问题"));
  assert.ok(h.browser.document.body.textContent.includes("media_fixture"));
  assert.ok(h.btn("定位到正文第 2 块", h.browser.document), "素材问题给出可定位的正文位置");
  let scrolledTo;
  h.browser.Element.prototype.scrollIntoView = function () { scrolledTo = this; };
  await h.click(h.btn("定位到正文第 2 块", h.browser.document));
  await h.waitFor(() => !h.browser.document.body.textContent.includes("处理后可再次发布；草稿仍会保留。"));
  assert.ok(scrolledTo?.querySelector("figure"), "定位滚动到对应图片块");
  assert.equal(h.requests.some(request => request.path.endsWith("/publish")), false);
});

test("另一管理员先发布时保留工作副本并展示冲突，不重复提交", async (t) => {
  let saved;
  const h = await mountHelp(t, { handlers: [
    helpTreeHandler(), resourceHandler("how-to-order", "如何下单"),
    { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: (_url, init) => {
      saved = resourceDetail("how-to-order", JSON.parse(init.body).payload.title);
      saved.item.revision = "4"; saved.draft.revision = "3";
      return json(saved);
    } },
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/versions/draft_how-to-order", response: () => json({ version: saved.draft, media: [] }) },
    { method: "POST", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/publish", response: () => json({ error: { code: "CONFLICT" } }, 409) },
  ] });
  await h.waitFor(() => h.el.querySelector('[aria-label="文档标题"]'));
  await h.setInput(h.el.querySelector('[aria-label="文档标题"]'), "需要保留的本地内容");
  await h.click(h.btn("发布"));
  await h.waitFor(() => h.el.textContent.includes("别人刚改过"));
  assert.equal(h.el.querySelector(".help-article-title").textContent, "需要保留的本地内容");
  assert.equal(h.requests.filter(request => request.path.endsWith("/publish")).length, 1);
  assert.equal(h.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_help"), null);
});

test("仅有游戏读取权限时从帮助工作台直接进入游戏手册", async (t) => {
  const h = await mountHelp(t, {
    perms: ["content.read"], component: ContentView,
    props: { surface: "help", tab: { id: "content-help", title: "帮助中心", path: "/content/help", query: {}, closable: true, kind: "content-help" }, onQueryChange: () => {} },
    handlers: [
      { match: "/api/bff/admin/content/games", response: () => json({ games: [{ id: "game_fixture", code: "fixture", name: "虚构游戏" }] }) },
      { match: "/api/bff/admin/content/resources", response: url => { assert.equal(url.searchParams.get("scope"), "game"); return json({ items: [], nextCursor: null, limit: 5 }); } },
    ],
  });
  await h.waitFor(() => h.requests.some(request => request.path === "/api/bff/admin/content/resources"));
  assert.ok(h.el.textContent.includes("游戏手册"));
  assert.equal(h.btn("返回帮助中心"), undefined);
  assert.equal(h.requests.some(request => request.path === "/api/bff/admin/content/help-tree"), false);
});

test("帮助插图复用素材库并保持 Plate 工作副本挂载", async (t) => {
  const writes = [];
  const h = await mountHelp(t, { handlers: [
    helpTreeHandler(), resourceHandler("how-to-order", "如何下单"),
    { match: "/api/bff/admin/content/media-options", response: () => json({ items: [{ id: "media_fixture", mime: "image/png", width: 640, height: 320, byteSize: "1024" }], nextCursor: null, limit: 20 }) },
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/versions/draft_how-to-order", response: () => json({ version: resourceDetail("how-to-order", "如何下单").draft, media: [] }) },
    { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: (_url, init) => {
      const body = JSON.parse(init.body); writes.push(body);
      const saved = resourceDetail("how-to-order", body.payload.title); saved.item.revision = "4"; saved.draft.payload = body.payload;
      return json(saved);
    } },
  ] });
  await h.waitFor(() => h.el.querySelector('.plate-editor [contenteditable="true"]'));
  const editable = h.el.querySelector('.plate-editor [contenteditable="true"]');
  assert.equal(h.btn("插入图片"), undefined, "正文上方不常驻图片入口");
  const insert = h.el.querySelector('.plate-editor button[aria-label="插入块"]');
  await h.click(insert);
  const doc = h.browser.document;
  await h.waitFor(() => [...doc.querySelectorAll('[role="option"]')].some(option => option.textContent.trim() === "图片"));
  await h.click([...doc.querySelectorAll('[role="option"]')].find(option => option.textContent.trim() === "图片"));
  await h.waitFor(() => doc.querySelector('[role="dialog"]')?.textContent.includes("640 × 320"));
  await h.click([...doc.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.includes("640 × 320")));
  await h.waitFor(() => h.el.querySelector('.plate-editor img[src*="media_fixture"]'));
  assert.equal(h.el.querySelector('.plate-editor [contenteditable="true"]'), editable);
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => writes.length === 1);
  assert.equal(writes[0].payload.document.value.find(node => node.type === "img")?.mediaId, "media_fixture");
  assert.deepEqual(writes[0].payload.mediaIds, ["media_fixture"]);
});

test("发布请求结果未知时冻结正文，核对结果前不能写入下一版", async (t) => {
  let saved, resolvePublish, recovered = false;
  const h = await mountHelp(t, { handlers: [
    helpTreeHandler(),
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order", response: () => json(recovered ? { ...saved, item: { ...saved.item, revision: "5" }, published: { ...saved.draft, state: "PUBLISHED" }, draft: null } : resourceDetail("how-to-order", "如何下单")) },
    { method: "PUT", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/draft", response: (_url, init) => {
      saved = resourceDetail("how-to-order", JSON.parse(init.body).payload.title);
      saved.item.revision = "4"; saved.draft.revision = "3"; return json(saved);
    } },
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/versions/draft_how-to-order", response: () => json({ version: saved.draft, media: [] }) },
    { method: "POST", match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/publish", response: () => new Promise(resolve => { resolvePublish = () => resolve(json({ error: { code: "INTERNAL_ERROR" } }, 502)); }) },
    { match: "/api/bff/admin/content/operation-result", response: url => { recovered = true; return json({ receipt: "RECORDED", operation: url.searchParams.get("operation"), resourceId: url.searchParams.get("resourceId"), responseStatus: 200, result: { itemId: "item_how-to-order" } }); } },
  ] });
  await h.waitFor(() => h.btn("发布"));
  await h.click(h.btn("发布"));
  await h.waitFor(() => typeof resolvePublish === "function");
  const editor = h.el.querySelector('.content-notion-page[inert]');
  assert.ok(editor, "发布请求已发出后不能继续输入");
  assert.equal(h.el.querySelector('[aria-label="文档标题"]').disabled, true);
  await act(async () => { resolvePublish(); });
  await h.waitFor(() => h.btn("核对原操作结果"));
  assert.ok(h.el.querySelector('.content-notion-page[inert]'), "结果未知时继续保护本地编辑器");
  assert.equal(h.requests.filter(request => request.path.endsWith("/publish")).length, 1);
  await h.renderWithPermissions(["content.help.read"]);
  await h.renderWithPermissions(MANAGE);
  await h.waitFor(() => h.el.querySelector('.content-notion-page[inert]'));
  assert.ok(h.btn("核对原操作结果"), "重新打开后仍保持原请求和冻结状态");
  await h.click(h.btn("核对原操作结果"));
  await h.waitFor(() => h.el.textContent.includes("线上 v2"));
  assert.equal(h.el.querySelector('.content-notion-page[inert]'), null);
  assert.equal(h.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_help"), null);
});

test("文章设置与版本历史按需打开，历史读取失败不阻断发布资格", async (t) => {
  const h = await mountHelp(t, { handlers: [
    helpTreeHandler(), resourceHandler("how-to-order", "如何下单"),
    { match: "/api/bff/admin/content/resources/guide%3Ahow-to-order/versions/pub_how-to-order", response: () => json({ error: { code: "INTERNAL_ERROR" } }, 500) },
  ] });
  await h.waitFor(() => h.btn("发布"));
  assert.equal(h.el.querySelector(".content-doc-settings"), null);
  await openMenu(h, h.el.querySelector('[aria-label="文章操作"]'));
  await clickMenuItem(h, "文章设置");
  let dialog = h.browser.document.querySelector('[role="dialog"]');
  assert.ok(dialog.textContent.includes("在帮助页标明适用对象；此设置不限制文章访问"));
  assert.ok(dialog.querySelector('[aria-label="搜索相关阅读"]'));
  await h.click(h.btn("完成", dialog));
  await openMenu(h, h.el.querySelector('[aria-label="文章操作"]'));
  await clickMenuItem(h, "版本历史");
  dialog = h.browser.document.querySelector('[role="dialog"]');
  assert.match(dialog.querySelector('[aria-pressed="true"]').textContent, /线上/);
  await h.waitFor(() => dialog.querySelector('[role="alert"]'));
  await h.click(h.btn("完成", dialog));
  assert.equal(h.btn("发布").disabled, false);
});
