import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

/**
 * P1a 内部文档库管理端组件测试（happy-dom + 离线源码转译 + 合成 fetch）。
 * 覆盖：树渲染/键盘、权限三态、409 冲突横幅、保存状态、回收站、搜索上限、图片关闭提示，
 * 以及 useDocAutosave 的停顿/单飞/409/退避行为。
 * IA 收尾：帮助中心（公开）目录已迁到内容管理「帮助目录」tab（content-help-tree.test.mjs），
 * 内部文档库不再渲染或请求帮助树。证据边界：合成 DOM 与 fetch，不等于真实 HTTP/浏览器验收。
 */

const MANAGE = ["docs.internal.read", "docs.internal.comment", "docs.internal.manage", "content.platform.read", "content.platform.edit", "content.platform.publish"];
const SUPPORT = ["docs.internal.read", "docs.internal.comment", "content.platform.read"];

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
}

// react-dom 的 canUseDOM 在模块加载时求值（门控 onChange 等）：必须先暴露 DOM 全局，
// 再加载 react-dom 与组件图，否则受控输入静默失效。
const bootstrap = new Window({ url: "http://127.0.0.1:3101/" });
exposeBrowserGlobals(bootstrap);
const { createRoot } = await import("react-dom/client");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = await createOfflineAdminSource({ root });
const { DocsView } = await source.ssrLoadModule("/apps/admin/src/views/docs/docs-view.tsx");
const { useDocAutosave } = await source.ssrLoadModule("/apps/admin/src/views/docs/use-doc-autosave.ts");
// 预热懒加载编辑器：harness 缓存命中后 lazy import 立即解析。
await source.ssrLoadModule("/apps/admin/src/components/plate/plate-editor.tsx");

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const envelope = (text = "客服值班手册正文") => ({ format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "p", id: "n1", children: [{ text }] }] });

const nodeA = { id: "doc_a", parentId: null, depth: 1, title: "客服值班手册", sortKey: "a0", updatedAt: "2026-11-11T02:00:00.000Z", updatedBy: "admin_ops" };
const nodeB = { id: "doc_b", parentId: "doc_a", depth: 2, title: "夜班交接", sortKey: "a0", updatedAt: "2026-11-11T02:00:00.000Z", updatedBy: "admin_ops" };
const nodeC = { id: "doc_c", parentId: null, depth: 1, title: "退款口径", sortKey: "b0", updatedAt: "2026-11-10T02:00:00.000Z", updatedBy: "admin_boss" };
const TREE = { nodes: [nodeA, nodeB, nodeC] };

const detailA = (over = {}) => ({
  node: nodeA,
  version: { id: "docv_1", seq: 3, kind: "EDIT", savedAt: "2026-11-11T02:00:00.000Z", saveCount: 4, document: envelope() },
  revision: "7",
  ...over,
});

const snapshot = (permissions, isBoss = false) => ({
  authenticated: true,
  adminUserId: "admin_docs",
  user: { name: "文档管理员", username: "admin_docs", displayUsername: "文档管理员", twoFactorEnabled: false },
  security: { status: "ACTIVE", isBoss, passwordChangeRequired: false },
  session: { id: "sess_docs", locked: false, pinConfigured: false, createdAt: null, expiresAt: null },
  permissions,
});

const docsTab = (query = {}) => ({ id: "docs", title: "内部文档", path: "/docs", query, closable: true, kind: "docs" });
const docTab = (id) => ({ id: "docs", title: "文档详情", path: `/docs/${id}`, query: {}, closable: true, kind: "docs-object", objectType: "doc", objectId: id });

function router(handlers) {
  return (url, init) => {
    const method = init.method ?? "GET";
    const entry = handlers.find((h) => (h.method ?? "GET") === method && (h.match instanceof RegExp ? h.match.test(url.pathname) : url.pathname === h.match));
    if (!entry) throw new Error(`unexpected docs test request ${method} ${url.pathname}${url.search}`);
    return entry.response(url, init);
  };
}

async function mountDocs(t, { perms = MANAGE, isBoss = false, tab = docsTab(), handlers }) {
  const browser = new Window({ url: `http://127.0.0.1:3101${tab.path}` });
  browser.Element.prototype.scrollIntoView = function () {};
  exposeBrowserGlobals(browser);
  const requests = [];
  const originalFetch = globalThis.fetch;
  // 详情加载预取讨论以展示块尾入口。
  const discussionDefaults = [
    { match: /^\/api\/bff\/admin\/docs\/[^/]+\/discussions$/, response: () => json({ discussions: [] }) },
  ];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    requests.push({ path: url.pathname, query: url.search, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : null, key: new Headers(init.headers).get("idempotency-key") });
    return router([...handlers, ...discussionDefaults])(url, init);
  };
  const el = browser.document.createElement("div");
  el.className = "workspace-root";
  browser.document.body.append(el);
  const reactRoot = createRoot(el);
  const opened = [];
  const dirtyLog = [];
  const props = {
    snapshot: snapshot(perms, isBoss),
    onOpenPath: (path, title, afterOpen) => { opened.push({ path, title }); afterOpen?.(); },
    onQueryChange: () => {},
    onDirtyChange: (dirty) => dirtyLog.push(dirty),
  };
  const renderTab = (nextTab = tab, refreshNonce = 0) => act(async () => {
    reactRoot.render(createElement(DocsView, { ...props, tab: nextTab, refreshNonce }));
  });
  await renderTab();
  const settle = async (ms = 30) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  await settle();
  const click = async (node) => { await act(async () => { node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); }); await settle(); };
  const setInput = async (input, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(input.constructor.prototype, "value").set.call(input, value);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
  };
  const waitFor = async (predicate, timeout = 4000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (predicate()) return;
      await settle(25);
    }
    assert.ok(predicate(), "waitFor 超时：条件未成立");
  };
  t.after(async () => {
    await act(async () => { reactRoot.unmount(); });
    globalThis.fetch = originalFetch;
    await browser.happyDOM.abort();
  });
  return { browser, el, opened, dirtyLog, requests, settle, click, setInput, waitFor, renderTab };
}

const treeHandler = (page = TREE) => ({ match: "/api/bff/admin/docs/tree", response: () => json(page) });
const detailHandler = (detail = detailA()) => ({ match: /^\/api\/bff\/admin\/docs\/doc_[a-z]+$/, response: () => json(detail) });

test("树渲染：只有内部文档根、骨架、tree/treeitem 与方向键/Home/End", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await mountDocs(t, {
    handlers: [
      { match: "/api/bff/admin/docs/tree", response: async () => { await gate; return json(TREE); } },
    ],
  });
  assert.ok(h.el.querySelector('[role="status"][aria-label="文档树加载中"]'), "加载中显示骨架");
  await act(async () => { release(); });
  await h.settle(60);
  const tree = h.el.querySelector('[role="tree"][aria-label="文档库目录"]');
  assert.ok(tree, "role=tree 容器");
  const items = tree.querySelectorAll('[role="treeitem"]');
  assert.equal(items.length, 4, "内部文档虚拟根 + 三篇文档；帮助中心根已迁出");
  assert.equal(h.el.textContent.includes("帮助中心（公开）"), false, "内部文档树不再渲染帮助中心根");
  assert.equal(h.el.querySelector('[data-help-id]'), null, "没有帮助树节点");
  const rowA = tree.querySelector('[data-doc-id="doc_a"]');
  assert.equal(rowA.getAttribute("aria-expanded"), "true", "一级文档默认展开");
  assert.ok(tree.querySelector('[data-doc-id="doc_b"]'), "子文档可见");
  assert.equal(rowA.getAttribute("aria-level"), "2");

  const key = async (target, name) => { await act(async () => { target.dispatchEvent(new h.browser.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); }); await h.settle(40); };
  const active = () => tree.querySelector('[role="treeitem"][tabindex="0"]');
  assert.ok(active().textContent.includes("内部文档"), "初始焦点在内部文档根");
  await key(active(), "ArrowDown");
  assert.equal(active().getAttribute("data-doc-id"), "doc_a");
  await key(active(), "ArrowRight");
  assert.equal(active().getAttribute("data-doc-id"), "doc_b", "已展开时 ArrowRight 进入第一个子文档");
  await key(active(), "ArrowLeft");
  assert.equal(active().getAttribute("data-doc-id"), "doc_a", "ArrowLeft 回到父文档");
  await key(active(), "ArrowLeft");
  assert.equal(tree.querySelector('[data-doc-id="doc_b"]'), null, "ArrowLeft 折叠父文档");
  await key(active(), "End");
  assert.equal(active().getAttribute("data-doc-id"), "doc_c");
  await key(active(), "Home");
  assert.ok(active().textContent.includes("内部文档"), "Home 回到内部文档根");
});

test("树读取失败显示可重试错误，重试后恢复", async (t) => {
  let calls = 0;
  const h = await mountDocs(t, {
    handlers: [{ match: "/api/bff/admin/docs/tree", response: () => { calls += 1; return calls === 1 ? json({ error: { code: "INTERNAL_ERROR" } }, 500) : json(TREE); } }],
  });
  assert.ok(h.el.textContent.includes("文档暂时无法读取"));
  const retry = [...h.el.querySelectorAll("button")].find((button) => button.textContent === "重试");
  assert.ok(retry);
  await h.click(retry);
  await h.waitFor(() => h.el.querySelector('[data-doc-id="doc_a"]'));
  assert.equal(calls, 2);
});

test("权限三态：客服能对只读正文的实际选区建评论；运营可编辑；无 read 不请求", async (t) => {
  const duplicate = detailA();
  duplicate.version.document = envelope("客服值班与客服值班");
  duplicate.version.document.value.push({ type: "img", id: "n2", imageId: "dimg_test", alt: "值班示意图", children: [{ text: "" }] });
  let releaseImage;
  let created = null;
  const support = await mountDocs(t, {
    perms: SUPPORT,
    tab: docTab("doc_a"),
    handlers: [
      treeHandler(), detailHandler(duplicate),
      { match: "/api/bff/admin/docs/doc_a/images/sign", method: "POST", response: () => new Promise((resolve) => { releaseImage = resolve; }) },
      { match: "/api/bff/admin/docs/doc_a/discussions", response: () => json({ discussions: created ? [created] : [] }) },
      { match: "/api/bff/admin/docs/doc_a/discussions", method: "POST", response: (_url, init) => {
        const body = JSON.parse(init.body);
        created = { id: body.discussionId, anchorText: body.anchorText, status: "OPEN", anchorState: "PRESENT", comments: [] };
        const annotated = structuredClone(duplicate.version.document);
        annotated.value[0].children = [{ text: "客服值班与" }, { text: "客服值班", [`comment_${body.discussionId}`]: true }];
        return json({ discussion: created, revision: "7", versionId: "docv_comment", seq: 4, document: annotated }, 201);
      } },
    ],
  });
  await support.waitFor(() => support.el.querySelector(".docs-readonly [data-slate-editor]"));
  assert.equal(support.el.querySelector('[aria-label="搜索文档标题"]').closest(".docs-tree-panel").textContent.includes("新建文档"), false, "客服不显示新建按钮");
  assert.ok(support.el.querySelector(".docs-readonly .plate-document"), "客服看到只读渲染");
  assert.ok(support.el.textContent.includes("只读"));
  assert.equal(support.el.textContent.includes("插入图片"), false);
  assert.equal(support.el.textContent.includes("删除"), false);
  assert.equal(support.el.querySelector('[contenteditable="true"]'), null);
  assert.equal(support.browser.document.querySelector("#internal-doc-comments"), null, "初始不打开评论");
  const editor = editorOf(support.el);
  await support.waitFor(() => releaseImage);
  assert.equal(support.el.querySelector('img[alt="值班示意图"]'), null);
  await act(async () => {
    releaseImage(json({ urls: { dimg_test: { url: "/api/bff/admin/docs/images/dimg_test/content", expiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
  });
  await support.waitFor(() => support.el.querySelector('img[alt="值班示意图"]'));
  assert.equal(editorOf(support.el), editor, "图片签发后不重建正在使用的编辑器");
  await act(async () => {
    editor.tf.select({ anchor: { path: [0, 0], offset: 5 }, focus: { path: [0, 0], offset: 9 } });
  });
  await support.waitFor(() => support.el.querySelector('[role="toolbar"] button[aria-label="评论"]'));
  const toolbar = support.el.querySelector('[role="toolbar"]');
  assert.equal(toolbar.querySelectorAll("button").length, 1, "客服选区仅有评论操作");
  await support.click(toolbar.querySelector("button"));
  const panel = support.browser.document.querySelector('#internal-doc-comments[data-view="draft"]');
  assert.ok(panel);
  const composer = panel.querySelector('textarea[aria-label="评论内容"]');
  await support.setInput(composer, "请核对这处交接");
  await support.click(panel.querySelector('button[aria-label="发布评论"]'));
  await support.waitFor(() => support.requests.some((r) => r.method === "POST" && r.path.endsWith("/discussions")));
  const request = support.requests.find((r) => r.method === "POST" && r.path.endsWith("/discussions"));
  assert.equal(request.body.anchorText, "客服值班");
  assert.equal(request.body.anchorOffset, 5, "选中的是第二处重复文字");
  assert.equal(request.body.expectedRevision, "7");
  assert.equal(support.requests.some((r) => r.method === "PUT"), false, "客服不保存正文");
  await support.waitFor(() => support.el.querySelector(`mark[data-comment-id="${request.body.discussionId}"]`));

  const ops = await mountDocs(t, {
    perms: MANAGE,
    tab: docTab("doc_a"),
    handlers: [treeHandler(), detailHandler()],
  });
  assert.ok(ops.el.textContent.includes("新建文档"), "运营可新建");
  await ops.waitFor(() => ops.el.querySelector('.plate-editor [contenteditable="true"]'), 6000);
  assert.ok(ops.el.querySelector('input[type="file"][aria-label="选择要插入的图片"]'));
  assert.ok(ops.el.textContent.includes("版本历史"));
  assert.ok(ops.el.querySelector('button[aria-label="更多文档操作"]'), "管理动作从正文移入菜单");

  const denied = await mountDocs(t, { perms: [], handlers: [] });
  assert.ok(denied.el.textContent.includes("没有权限"));
  assert.equal(denied.requests.length, 0, "无 read 不发起任何请求");
});

test("409 冲突：停止自动保存、横幅提示、编辑器只读但本地可复制", async (t) => {
  const h = await mountDocs(t, {
    perms: MANAGE,
    tab: docTab("doc_a"),
    handlers: [
      treeHandler(),
      detailHandler(),
      { match: /^\/api\/bff\/admin\/docs\/doc_a$/, method: "PATCH", response: () => json({ error: { code: "VERSION_CHANGED" } }, 409) },
    ],
  });
  await h.waitFor(() => h.el.querySelector('.plate-editor [contenteditable="true"]'), 6000);
  const input = h.el.querySelector('[aria-label="文档标题"]');
  assert.ok(input, "inline 大标题直接可编辑");
  assert.equal(h.el.querySelector('[aria-label="重命名文档"]'), null, "不再有铅笔重命名按钮");
  await h.setInput(input, "客服值班手册（改）");
  await act(async () => { input.dispatchEvent(new h.browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await h.waitFor(() => h.el.querySelector(".docs-conflict-banner"));
  assert.ok(h.el.querySelector(".docs-conflict-banner").textContent.includes("别人刚改过，刷新后再改"));
  await h.waitFor(() => h.el.querySelector('.plate-editor[data-readonly="true"]'), 6000);
  assert.equal(h.el.querySelector('.plate-editor [contenteditable="true"]'), null, "冲突后编辑器只读");
  const copy = [...h.el.querySelectorAll("button")].find((button) => button.textContent.includes("复制本地内容"));
  await h.click(copy);
  await h.settle(80);
  const fallback = h.el.querySelector('[aria-label="本地内容副本"]');
  if (fallback) {
    assert.ok(fallback.value.includes("客服值班手册正文"), "复制降级文本框保留本地内容");
  } else {
    assert.ok(h.el.textContent.includes("本地内容已复制"), "复制成功提示");
    assert.ok((await h.browser.navigator.clipboard.readText()).includes("客服值班手册正文"), "剪贴板拿到本地内容");
  }
  assert.equal(h.requests.filter((request) => request.method === "PUT").length, 0, "冲突后不再自动保存");
  const detailReads = h.requests.filter((request) => request.method === "GET" && request.path.endsWith("/doc_a")).length;
  await h.renderTab(docTab("doc_a"), 1);
  assert.equal(h.requests.filter((request) => request.method === "GET" && request.path.endsWith("/doc_a")).length, detailReads, "工作区刷新不会覆盖冲突输入");
  assert.ok(h.el.textContent.includes("客服值班手册（改）"), "冲突保留本地标题");
});

test("保存状态：已保存 HH:mm 文字+图标+aria-live", async (t) => {
  const h = await mountDocs(t, {
    perms: MANAGE,
    tab: docTab("doc_a"),
    handlers: [treeHandler(), detailHandler()],
  });
  await h.waitFor(() => h.el.querySelector('.docs-save-status[data-phase="saved"]'));
  const status = h.el.querySelector('.docs-save-status[data-phase="saved"]');
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.ok(status.textContent.includes("已保存 10:00"), "北京时间 HH:mm");
  assert.ok(status.querySelector("svg"), "状态带图标");
});

// 从可编辑 DOM 沿 React fiber 取 Plate editor 实例（与 plate-editor.test.mjs 同法）。
function editorOf(el) {
  const node = el.querySelector("[data-slate-editor]");
  assert.ok(node, "editable DOM node present");
  const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
  let fiber = node[key];
  while (fiber) {
    const props = fiber.memoizedProps;
    if (props?.editor?.tf) return props.editor;
    fiber = fiber.return;
  }
  throw new Error("Plate editor instance not found via fiber");
}

test("编辑手感：标题直接编辑、块旁插入以及可关闭的区块菜单", async (t) => {
  const h = await mountDocs(t, { perms: MANAGE, tab: docTab("doc_a"), handlers: [treeHandler(), detailHandler()] });
  await h.waitFor(() => h.el.querySelector('.plate-editor [contenteditable="true"]'), 6000);

  assert.ok(h.el.querySelector(".docs-title-input"), "inline 大标题输入直接可编辑");
  assert.equal(h.el.querySelector('[aria-label="重命名文档"]'), null, "去掉铅笔重命名按钮");

  const plus = h.el.querySelectorAll('.slate-blockPlusWrapper button[aria-label="插入块"]');
  assert.ok(plus.length >= 1, "块 gutter 渲染 Notion 式 plus 插入按钮");
  assert.ok(h.el.querySelectorAll(".slate-blockToolbarWrapper button").length >= 1, "拖拽把手保留");

  const editor = editorOf(h.el);
  await act(async () => {
    editor.tf.focus();
    editor.tf.select({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } });
    editor.tf.insertText("/");
  });
  await h.settle(80);
  const listbox = h.browser.document.querySelector('[role="listbox"]');
  assert.ok(listbox, "slash 菜单渲染 listbox");
  const closeMenu = h.browser.document.querySelector(".plate-slash-dismiss");
  assert.ok(closeMenu && !listbox.contains(closeMenu), "关闭按钮位于选项滚动区之外");
  assert.ok(h.browser.document.querySelector('[aria-label="搜索区块"]'), "菜单可搜索");
  assert.ok(h.browser.document.querySelectorAll('[role="option"]').length > 0, "菜单有选项");
  assert.ok(listbox.textContent.includes("基本区块"), "分组标签");
  assert.ok(listbox.textContent.includes("图片"), "内部文档菜单有选图入口");
});

test("浮动工具栏评论按钮：本地草稿高亮，选区旁打开评论输入区", async (t) => {
  const h = await mountDocs(t, { perms: MANAGE, tab: docTab("doc_a"), handlers: [treeHandler(), detailHandler()] });
  await h.waitFor(() => h.el.querySelector('.plate-editor [contenteditable="true"]'), 6000);
  const editor = editorOf(h.el);
  await act(async () => {
    editor.tf.focus();
    editor.tf.select({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 4 } });
  });
  await h.settle(80);
  const toolbar = h.browser.document.querySelector('[role="toolbar"]');
  assert.ok(toolbar, "展开选区渲染浮动工具栏");
  assert.equal(toolbar.closest("[data-slate-editor]"), null, "浮动工具栏不插入文档流");
  const commentBtn = [...toolbar.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "评论");
  assert.ok(commentBtn, "internal 浮动工具栏含评论按钮");

  await h.click(commentBtn);
  await h.settle(60);
  assert.ok(h.el.querySelector("mark.plate-comment"), "选区加草稿琥珀高亮 mark");
  const composer = h.browser.document.querySelector('[data-testid="discussion-composer"]');
  assert.ok(composer.querySelector('[aria-label="评论内容"]'), "选区旁能输入评论");
  assert.equal(h.el.querySelector("mark.plate-comment").textContent, "客服值班", "原文保持选区高亮");
  assert.equal(h.requests.filter((r) => r.method === "PUT").length, 0, "加草稿不触发内容保存");
});

test("发表评论请求期间可继续编辑，回执只标注原选区并保留当前输入与焦点", async (t) => {
  const detail = detailA();
  detail.version.document = envelope("重复词与重复词");
  detail.version.document.value.push({ type: "p", id: "n2", children: [{ text: "另一个块" }] });
  let finish;
  let published;
  const h = await mountDocs(t, {
    tab: docTab("doc_a"),
    handlers: [
      treeHandler(), detailHandler(detail),
      { match: "/api/bff/admin/docs/doc_a/discussions", response: () => json({ discussions: published ? [published] : [] }) },
      { match: "/api/bff/admin/docs/doc_a/discussions", method: "POST", response: (_url, init) => new Promise((resolve) => {
        const body = JSON.parse(init.body);
        finish = () => {
          published = { id: body.discussionId, anchorText: body.anchorText, status: "OPEN", anchorState: "PRESENT", comments: [] };
          const annotated = structuredClone(detail.version.document);
          annotated.value[0].children = [{ text: "重复词与" }, { text: "重复词", [`comment_${body.discussionId}`]: true }];
          resolve(json({ discussion: published, revision: "7", versionId: "docv_comment", seq: 4, document: annotated }, 201));
        };
      }) },
      { match: "/api/bff/admin/docs/doc_a/content", method: "PUT", response: () => json({ revision: "8", savedAt: "2026-11-12T02:00:00.000Z" }) },
    ],
  });
  await h.waitFor(() => h.el.querySelector("[data-slate-editor]"));
  const editor = editorOf(h.el);
  await act(async () => {
    editor.tf.focus();
    editor.tf.select({ anchor: { path: [0, 0], offset: 4 }, focus: { path: [0, 0], offset: 7 } });
  });
  await h.waitFor(() => h.el.querySelector('[role="toolbar"] button[aria-label="评论"]'));
  await h.click(h.el.querySelector('[role="toolbar"] button[aria-label="评论"]'));
  const panel = h.browser.document.querySelector("#internal-doc-comments");
  await h.setInput(panel.querySelector('[aria-label="评论内容"]'), "请确认第二处");
  await h.click(panel.querySelector('button[aria-label="发布评论"]'));
  await h.waitFor(() => finish);
  await act(async () => {
    editor.tf.select(editor.api.end([1]));
    editor.tf.focus();
    editor.tf.insertText("继续输入");
  });
  assert.equal(editor.children[1].children[0].text, "另一个块继续输入");
  assert.ok([...editor.api.rangeRefs()].some((ref) => ref.current?.anchor.path[0] === 0 && ref.current.anchor.offset === 4));
  assert.equal(h.requests.some((request) => request.method === "PUT"), false);
  await act(async () => finish());
  await h.waitFor(() => h.el.querySelector(`mark[data-comment-id="${published.id}"]`));
  assert.equal(editorOf(h.el), editor);
  assert.deepEqual(editor.children[0].children.map((leaf) => leaf.text), ["重复词与", "重复词"]);
  assert.equal(editor.children[1].children[0].text, "另一个块继续输入");
  assert.deepEqual(editor.selection.focus.path, [1, 0]);
  assert.equal(h.browser.document.activeElement, h.el.querySelector("[data-slate-editor]"));
  await h.waitFor(() => h.requests.some((request) => request.method === "PUT"));
  const saved = h.requests.find((request) => request.method === "PUT").body.document;
  assert.equal(saved.value[0].children[1][`comment_${published.id}`], true);
  assert.equal(saved.value[1].children[0].text, "另一个块继续输入");
});

test("新建后定位标题，中文输入确认期间保持焦点，Enter 提交后进入正文", async (t) => {
  const node = { ...nodeA, id: "doc_new", title: "新文档" };
  const detail = detailA({ node });
  detail.version.document = envelope("");
  const h = await mountDocs(t, {
    handlers: [
      treeHandler(), detailHandler(detail),
      { match: "/api/bff/admin/docs", method: "POST", response: () => json(detail, 201) },
      { match: "/api/bff/admin/docs/doc_new", method: "PATCH", response: (_url, init) => json({ ...detail, node: { ...node, title: JSON.parse(init.body).title }, revision: "8" }) },
    ],
  });
  await h.click([...h.el.querySelectorAll("button")].find((button) => button.textContent === "新建文档"));
  const dialog = h.browser.document.querySelector('[role="dialog"]');
  await h.setInput(dialog.querySelector("input"), node.title);
  await h.click([...dialog.querySelectorAll("button")].find((button) => button.textContent === "创建"));
  assert.equal(h.opened.at(-1).path, "/docs/doc_new");
  await h.renderTab(docTab("doc_new"));
  const title = h.el.querySelector('[aria-label="文档标题"]');
  assert.equal(h.browser.document.activeElement, title);
  await h.waitFor(() => h.el.querySelector("[data-slate-editor]"));
  await h.setInput(title, "新文档标题");
  const enter = (isComposing) => act(async () => title.dispatchEvent(new h.browser.KeyboardEvent("keydown", { key: "Enter", isComposing, bubbles: true, cancelable: true })));
  await enter(true);
  assert.equal(h.browser.document.activeElement, title);
  assert.equal(h.requests.some((request) => request.method === "PATCH"), false);
  await enter(false);
  await h.waitFor(() => h.browser.document.activeElement === h.el.querySelector("[data-slate-editor]"));
  assert.equal(h.requests.find((request) => request.method === "PATCH").body.title, "新文档标题");
  assert.deepEqual(editorOf(h.el).selection.focus, { path: [0, 0], offset: 0 });
});

test("404 细分：已在回收站可去回收站；已永久清理只提示", async (t) => {
  const deleted = await mountDocs(t, {
    perms: MANAGE,
    tab: docTab("doc_gone"),
    handlers: [treeHandler(), { match: "/api/bff/admin/docs/doc_gone", response: () => json({ error: { code: "NOT_FOUND", reason: "DOC_DELETED" } }, 404) }],
  });
  assert.ok(deleted.el.textContent.includes("该文档已在回收站"));
  const toTrash = [...deleted.el.querySelectorAll("button")].find((button) => button.textContent === "去回收站");
  assert.ok(toTrash, "manage 可去回收站");
  await deleted.click(toTrash);
  assert.deepEqual(deleted.opened.at(-1), { path: "/docs?view=trash", title: "回收站" });

  const purged = await mountDocs(t, {
    perms: MANAGE,
    tab: docTab("doc_gone"),
    handlers: [treeHandler(), { match: "/api/bff/admin/docs/doc_gone", response: () => json({ error: { code: "NOT_FOUND", reason: "DOC_PURGED" } }, 404) }],
  });
  assert.ok(purged.el.textContent.includes("该文档已被永久清理"));
  assert.equal([...purged.el.querySelectorAll("button")].some((button) => button.textContent === "去回收站"), false);
});

test("回收站：batch 分组、N 天后永久清理、恢复需 manage", async (t) => {
  const trashPage = {
    items: [
      { batchId: "batch_1", rootNodeId: "doc_old", title: "旧版值班表", deletedAt: "2026-11-01T02:00:00.000Z", deletedBy: "admin_ops", count: 3, purgeAt: new Date(Date.now() + 12 * 86_400_000).toISOString() },
      { batchId: "batch_2", rootNodeId: "doc_old2", title: "过期口径", deletedAt: "2026-11-05T02:00:00.000Z", deletedBy: "admin_boss", count: 1, purgeAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    ],
    nextCursor: null,
  };
  const handlers = [treeHandler(), { match: "/api/bff/admin/docs/trash", response: () => json(trashPage) }];
  const ops = await mountDocs(t, { perms: MANAGE, tab: docsTab({ view: "trash" }), handlers });
  await ops.waitFor(() => ops.el.querySelectorAll(".docs-trash-item").length === 2);
  const items = ops.el.querySelectorAll(".docs-trash-item");
  assert.ok(items[0].textContent.includes("旧版值班表"));
  assert.ok(items[0].textContent.includes("共 3 篇"));
  assert.ok(items[0].textContent.includes("12 天后永久清理"));
  assert.ok(items[1].textContent.includes("2 天后永久清理"));
  assert.equal(ops.el.querySelectorAll(".docs-trash-item button").length, 2, "manage 每批次可恢复");

  const support = await mountDocs(t, { perms: SUPPORT, tab: docsTab({ view: "trash" }), handlers });
  await support.waitFor(() => support.el.querySelectorAll(".docs-trash-item").length === 2);
  assert.equal(support.el.querySelectorAll(".docs-trash-item button").length, 0, "客服只读，无恢复按钮");
  assert.ok(support.el.textContent.includes("12 天后永久清理"));
});

test("回收站原父目录不可用时可以恢复到顶层", async (t) => {
  const batch = { batchId: "batch_parent", rootNodeId: "doc_old", title: "恢复样本", deletedAt: "2026-11-01T02:00:00.000Z",
    deletedBy: "admin_ops", count: 1, purgeAt: new Date(Date.now() + 86_400_000).toISOString() };
  let attempts = 0;
  const h = await mountDocs(t, { perms: MANAGE, tab: docsTab({ view: "trash" }), handlers: [
    treeHandler(),
    { match: "/api/bff/admin/docs/trash", response: () => json({ items: [batch], nextCursor: null }) },
    { method: "POST", match: "/api/bff/admin/docs/trash/batch_parent/restore", response: () => ++attempts === 1
      ? json({ error: { code: "INVALID_ARGUMENT", details: [{ path: "reason", code: "MOVE_INVALID" }] } }, 400)
      : json({ node: nodeA }) },
  ] });
  await h.waitFor(() => h.el.querySelector(".docs-trash-item button"));
  await h.click(h.el.querySelector(".docs-trash-item button"));
  const findDialog = () => [...h.browser.document.querySelectorAll("[role=dialog]")].find(node => node.textContent.includes("选择恢复位置"));
  await h.waitFor(findDialog);
  const confirm = [...findDialog().querySelectorAll("button")].find(button => button.textContent.trim() === "恢复到此目录");
  await h.click(confirm);
  await h.waitFor(() => h.opened.some(entry => entry.path === "/docs/doc_a"));
  assert.deepEqual(h.requests.filter(request => request.path.endsWith("/restore")).map(request => request.body), [{}, { parentId: null }]);
});

test("标题搜索：只查标题、超过 100 字不请求并提示", async (t) => {
  const h = await mountDocs(t, {
    handlers: [
      treeHandler(),
      { match: "/api/bff/admin/docs/search", response: (url) => json({ items: [nodeA], nextCursor: null, q: url.searchParams.get("q") }) },
      detailHandler(),
    ],
  });
  const input = h.el.querySelector('[aria-label="搜索文档标题"]');
  await h.setInput(input, "值".repeat(101));
  await h.settle(450);
  assert.equal(h.requests.filter((request) => request.path === "/api/bff/admin/docs/search").length, 0, "超上限不发起搜索");
  assert.ok(h.el.textContent.includes("搜索词最多 100 字"));
  await h.setInput(input, "值班");
  await h.waitFor(() => h.el.querySelector(".docs-search-row"));
  const search = h.requests.filter((request) => request.path === "/api/bff/admin/docs/search");
  assert.equal(search.length, 1);
  assert.equal(search[0].query, "?q=%E5%80%BC%E7%8F%AD");
  assert.ok(h.el.querySelector(".docs-search-row").textContent.includes("客服值班手册"));
  await h.renderTab(docTab("doc_a"));
  await h.waitFor(() => h.el.querySelector(".docs-title-input"));
  assert.equal(h.el.querySelector('[aria-label="搜索文档标题"]').value, "值班", "同一文档标签切换后保留目录搜索");
  await h.click(h.el.querySelector('button[aria-label="折叠目录"]'));
  await h.click(h.el.querySelector('button[aria-label="展开目录"]'));
  assert.equal(h.el.querySelector('[aria-label="搜索文档标题"]').value, "值班", "折叠和展开不会清除查询");
});

test("图片功能关闭：503 IMAGES_DISABLED 提示未开启图片存储，其余功能照常", async (t) => {
  globalThis.createImageBitmap = async () => ({ width: 100, height: 80, close() {} });
  const h = await mountDocs(t, {
    perms: MANAGE,
    tab: docTab("doc_a"),
    handlers: [
      treeHandler(),
      detailHandler(),
      { match: "/api/bff/admin/docs/doc_a/images", method: "POST", response: () => json({ error: { code: "IMAGES_DISABLED" } }, 503) },
    ],
  });
  await h.waitFor(() => h.el.querySelector('.plate-editor [contenteditable="true"]'), 6000);
  const fileInput = h.el.querySelector('input[type="file"][aria-label="选择要插入的图片"]');
  const file = new h.browser.File([new Uint8Array([137, 80, 78, 71])], "值班表.png", { type: "image/png" });
  await act(async () => {
    const editor = editorOf(h.el);
    editor.tf.select(editor.api.start([0]));
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new h.browser.Event("change", { bubbles: true }));
  });
  await h.waitFor(() => h.el.textContent.includes("未开启图片存储"));
  assert.ok(h.el.querySelector('.plate-editor [contenteditable="true"]'), "编辑器仍可用");
  assert.ok(h.el.textContent.includes("版本历史"), "其余功能照常");
  const uploadItem = h.el.querySelector(".docs-upload-item");
  assert.equal(uploadItem.getAttribute("data-status"), "error");
  assert.ok(uploadItem.closest('[data-plate-block-id="n1"]'), "图片错误占位保留在触发块");
  assert.ok([...uploadItem.querySelectorAll("button")].some((button) => button.textContent === "重试"));
  assert.ok([...uploadItem.querySelectorAll("button")].some((button) => button.textContent === "移除"));
  delete globalThis.createImageBitmap;
});

test("选图按批次顺序落在触发块，后续输入和选区保持在原编辑器", async (t) => {
  const previousXHR = globalThis.XMLHttpRequest;
  globalThis.createImageBitmap = async () => ({ width: 100, height: 80, close() {} });
  globalThis.XMLHttpRequest = class {
    upload = {};
    status = 200;
    open() {}
    send() { queueMicrotask(() => this.onload()); }
  };
  t.after(() => { delete globalThis.createImageBitmap; globalThis.XMLHttpRequest = previousXHR; });
  const detail = detailA();
  detail.version.document.value.push({ type: "p", id: "n2", children: [{ text: "下一段" }] });
  const complete = new Map();
  const h = await mountDocs(t, {
    tab: docTab("doc_a"),
    handlers: [
      treeHandler(), detailHandler(detail),
      { match: "/api/bff/admin/docs/doc_a/images", method: "POST", response: (_url, init) => {
        const imageId = `dimg_${JSON.parse(init.body).bytes}`;
        return json({ imageId, upload: { url: "/fake-upload", expiresAt: new Date(Date.now() + 60_000).toISOString() } });
      } },
      { match: /\/api\/bff\/admin\/docs\/images\/dimg_\d+\/complete/, method: "POST", response: (url) => new Promise((resolve) => {
        const imageId = url.pathname.split("/").at(-2);
        complete.set(imageId, () => resolve(json({ imageId, status: "READY" })));
      }) },
      { match: "/api/bff/admin/docs/doc_a/images/sign", method: "POST", response: () => json({ urls: {} }) },
      { match: "/api/bff/admin/docs/doc_a/content", method: "PUT", response: () => json({ revision: "8", savedAt: "2026-11-12T02:00:00.000Z" }) },
    ],
  });
  await h.waitFor(() => h.el.querySelector("[data-slate-editor]"));
  const editor = editorOf(h.el);
  const input = h.el.querySelector('input[type="file"]');
  const files = [1, 2].map((size) => new h.browser.File([new Uint8Array(size)], `${size}.png`, { type: "image/png" }));
  await act(async () => {
    editor.tf.select(editor.api.start([0]));
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new h.browser.Event("change", { bubbles: true }));
  });
  await h.waitFor(() => complete.size === 2);
  assert.equal(h.el.querySelectorAll('[data-plate-block-id="n1"] .docs-upload-item').length, 2);
  await act(async () => {
    editor.tf.select(editor.api.end([1]));
    editor.tf.insertText("继续输入");
    complete.get("dimg_2")();
  });
  await h.waitFor(() => h.el.querySelector('.docs-upload-item[data-status="ready"]'));
  assert.deepEqual(editor.children.map((block) => block.type), ["p", "p"]);
  await act(async () => complete.get("dimg_1")());
  await h.waitFor(() => editor.children.length === 4);
  assert.deepEqual(editor.children.map((block) => block.imageId ?? block.children[0].text), ["客服值班手册正文", "dimg_1", "dimg_2", "下一段继续输入"]);
  assert.deepEqual(editor.selection.focus.path, [3, 0]);
  assert.equal(editorOf(h.el), editor);

  const paste = new h.browser.DataTransfer();
  paste.items.add(new h.browser.File([new Uint8Array(3)], "3.png", { type: "image/png" }));
  await act(async () => {
    editor.tf.select(editor.api.start([0]));
    h.el.querySelector("[data-slate-editor]").dispatchEvent(new h.browser.ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }));
  });
  await h.waitFor(() => complete.has("dimg_3"));
  await act(async () => {
    editor.tf.removeNodes({ at: [0] });
    editor.tf.select(editor.api.end([2]));
    complete.get("dimg_3")();
  });
  await h.waitFor(() => h.el.querySelector(".docs-upload-recover"));
  assert.equal(editor.children.some((node) => node.imageId === "dimg_3"), false);
  await h.click(h.el.querySelector(".docs-upload-recover button"));
  await h.waitFor(() => editor.children.at(-1).imageId === "dimg_3");
  assert.equal(editorOf(h.el), editor);
});

/* ---- useDocAutosave 行为（短定时器 seam） ---- */

async function mountAutosave(t, { handlers, timings = { debounceMs: 5, backoffBaseMs: 1 }, enabled = true }) {
  const browser = new Window({ url: "http://127.0.0.1:3101/docs/doc_a" });
  exposeBrowserGlobals(browser);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    requests.push({ path: url.pathname, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : null, key: new Headers(init.headers).get("idempotency-key") });
    return router(handlers)(url, init);
  };
  const el = browser.document.createElement("div");
  browser.document.body.append(el);
  const reactRoot = createRoot(el);
  const api = { current: null };
  const conflicts = [];
  function Host() {
    const save = useDocAutosave({
      docId: "doc_a",
      enabled,
      timings,
      onConflict: () => conflicts.push(true),
    });
    api.current = save;
    return null;
  }
  await act(async () => { reactRoot.render(createElement(Host)); });
  const settle = async (ms = 15) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  t.after(async () => {
    await act(async () => { reactRoot.unmount(); });
    globalThis.fetch = originalFetch;
    await browser.happyDOM.abort();
  });
  return { browser, api, requests, conflicts, settle };
}

test("自动保存：停顿后单飞 PUT，期间修改并入下一次并链式 revision", async (t) => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const h = await mountAutosave(t, {
    handlers: [{
      match: "/api/bff/admin/docs/doc_a/content", method: "PUT",
      response: async (url, init) => {
        calls += 1;
        const body = JSON.parse(init.body);
        if (calls === 1) { await firstGate; return json({ revision: "8", versionId: "docv_8", seq: 4, merged: true, savedAt: "2026-11-11T02:01:00.000Z" }); }
        assert.equal(body.expectedRevision, "8", "第二次保存携带第一次返回的 revision");
        return json({ revision: "9", versionId: "docv_9", seq: 4, merged: true, savedAt: "2026-11-11T02:02:00.000Z" });
      },
    }],
  });
  await act(async () => { h.api.current.reset("7"); });
  await act(async () => { h.api.current.schedule(envelope("第一版")); });
  assert.equal(h.api.current.phase, "dirty");
  await h.settle(30);
  assert.equal(h.api.current.phase, "saving");
  assert.equal(calls, 1, "停顿后只有一个请求在飞");
  await act(async () => { h.api.current.schedule(envelope("第二版")); });
  await h.settle(30);
  assert.equal(calls, 1, "在飞期间不并发第二个请求");
  await act(async () => { releaseFirst(); });
  await h.settle(60);
  assert.equal(calls, 2, "在飞期间的修改并入下一次");
  assert.equal(h.requests[1].body.document.value[0].children[0].text, "第二版");
  assert.equal(h.api.current.phase, "saved");
  assert.equal(h.api.current.getRevision(), "9");
  assert.ok(h.requests[0].key && h.requests[1].key && h.requests[0].key !== h.requests[1].key, "每次尝试独立 Idempotency-Key");
});

test("自动保存：409 停止并进入冲突态", async (t) => {
  const h = await mountAutosave(t, {
    handlers: [{ match: "/api/bff/admin/docs/doc_a/content", method: "PUT", response: () => json({ error: { code: "VERSION_CHANGED" } }, 409) }],
  });
  await act(async () => { h.api.current.reset("7"); });
  await act(async () => { h.api.current.schedule(envelope()); });
  await h.settle(60);
  assert.equal(h.api.current.phase, "conflict");
  assert.equal(h.api.current.message, "别人刚改过，刷新后再改");
  assert.equal(h.conflicts.length, 1);
  await act(async () => { h.api.current.schedule(envelope("再改")); });
  await h.settle(40);
  assert.equal(h.requests.length, 1, "冲突后不再自动保存");
});

test("自动保存：失败指数退避重试 3 次后提示复制内容，重试复用同一幂等键", async (t) => {
  const h = await mountAutosave(t, {
    handlers: [{ match: "/api/bff/admin/docs/doc_a/content", method: "PUT", response: () => json({ error: { code: "INTERNAL_ERROR" } }, 500) }],
  });
  await act(async () => { h.api.current.reset("7"); });
  await act(async () => { h.api.current.schedule(envelope()); });
  await h.settle(200);
  assert.equal(h.requests.length, 4, "首次 + 3 次退避重试");
  assert.equal(h.api.current.phase, "failed");
  assert.equal(h.api.current.message, "未保存，请复制内容后刷新");
  assert.ok(h.requests.every((request) => request.key === h.requests[0].key), "重试用同一 Idempotency-Key 与同一报文");
  const event = new h.browser.Event("beforeunload", { cancelable: true });
  await act(async () => { h.browser.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, true, "未保存时 beforeunload 提示");
});

test("自动保存：403 提示没有权限并停止", async (t) => {
  const h = await mountAutosave(t, {
    handlers: [{ match: "/api/bff/admin/docs/doc_a/content", method: "PUT", response: () => json({ error: { code: "FORBIDDEN" } }, 403) }],
  });
  await act(async () => { h.api.current.reset("7"); });
  await act(async () => { h.api.current.schedule(envelope()); });
  await h.settle(80);
  assert.equal(h.api.current.phase, "failed");
  assert.equal(h.api.current.message, "没有权限");
  assert.equal(h.requests.length, 1, "403 不退避重试");
});

/* ---- IA 收尾：帮助中心目录已迁到内容管理「帮助目录」tab ---- */

test("内部文档库不再渲染或请求帮助树；回收站只保留内部文档批次", async (t) => {
  // 持有 content.platform.* 也不应让帮助树回到内部文档库；router 对 help-tree 请求会直接抛错。
  const h = await mountDocs(t, { perms: MANAGE, handlers: [treeHandler()] });
  await h.waitFor(() => h.el.querySelector('[data-doc-id="doc_a"]'));
  assert.equal(h.el.textContent.includes("帮助中心（公开）"), false, "不渲染帮助中心根");
  assert.equal(h.el.querySelector('[data-help-id]'), null, "不渲染帮助树节点");
  assert.equal(h.requests.some((request) => request.path.startsWith("/api/bff/admin/content/help-tree")), false, "不请求帮助树接口");

  const trash = await mountDocs(t, {
    perms: MANAGE,
    tab: docsTab({ view: "trash" }),
    handlers: [treeHandler(), { match: "/api/bff/admin/docs/trash", response: () => json({ items: [], nextCursor: null }) }],
  });
  await trash.settle(60);
  assert.equal(trash.el.textContent.includes("帮助中心回收站"), false, "帮助回收站已迁到内容管理帮助目录 tab");
  assert.equal(trash.requests.some((request) => request.path.startsWith("/api/bff/admin/content/help-tree")), false, "回收站视图不请求帮助接口");
});
