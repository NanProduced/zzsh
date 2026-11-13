import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

/**
 * P2 Notion 式直接编辑组件测试（happy-dom + 离线源码转译 + 合成 fetch）。
 * 覆盖：plate 保存合同、visibleFrom 写入、2s 自动保存（短定时器 seam）、409 冲突横幅与只读、
 * 客服只读渲染、素材库插图（mediaId + mediaUrls 预览）、guide→help / notice→notice / 动态→update 预设。
 * 证据边界：合成 DOM 与 fetch，不等于真实 HTTP/浏览器验收。
 */

const GLOBAL_KEYS = [
  "Window", "Document", "ShadowRoot", "DocumentFragment", "DocumentType", "CharacterData", "ProcessingInstruction",
  "Attr", "DOMImplementation", "XMLSerializer", "DOMParser", "Element", "SVGElement", "HTMLElement", "Node",
  "Text", "Comment", "Range", "Selection", "StaticRange", "AbstractRange", "Event", "EventTarget", "CustomEvent",
  "UIEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "ClipboardEvent", "DragEvent",
  "CompositionEvent", "WheelEvent", "PointerEvent", "TouchEvent", "MutationObserver", "MutationRecord",
  "ResizeObserver", "ResizeObserverEntry", "IntersectionObserver", "Image", "DOMRect", "DOMRectReadOnly",
  "DOMRectList", "DOMPoint", "DOMMatrix", "DataTransfer", "DataTransferItem", "DataTransferItemList",
  "NodeList", "HTMLCollection", "NamedNodeMap", "DOMTokenList", "DOMStringMap", "CSSStyleSheet", "CSSRule",
  "CSSStyleDeclaration", "MediaList", "CSS", "StyleSheet", "FileList", "FileReader",
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

const bootstrap = new Window({ url: "http://127.0.0.1:3101/" });
exposeBrowserGlobals(bootstrap);
const { createRoot } = await import("react-dom/client");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = await createOfflineAdminSource({ root });
const { ItemEditor } = await source.ssrLoadModule("/apps/admin/src/views/content-item-editor.tsx");
const { ContentResourceEditor } = await source.ssrLoadModule("/apps/admin/src/views/content-resource-editor.tsx");
const { ContentResourcesTab } = await source.ssrLoadModule("/apps/admin/src/views/content-resources-tab.tsx");
const { ContentKeywordChips } = await source.ssrLoadModule("/apps/admin/src/views/content-keyword-chips.tsx");
await source.ssrLoadModule("/apps/admin/src/components/plate/plate-editor.tsx");

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const plateDoc = (text = "正文段落", preset = "update") => ({ format: "plate", schemaVersion: 1, preset, value: [{ type: "p", id: "n1", children: [{ text }] }] });

const itemVersion = (over = {}) => ({
  id: "ver_d1", itemId: "item_1", sequence: 1, state: "DRAFT", revision: "rev_d1",
  title: "平台公告标题", summary: "摘要", body: "正文段落", coverMediaId: null,
  payload: plateDoc(),
  updateSettings: { format: "plate" },
  publishedAt: null, updatedAt: "2026-11-11T02:00:00.000Z", createdAt: "2026-11-11T02:00:00.000Z",
  ...over,
});
const itemRow = (over = {}) => {
  const draft = itemVersion();
  return { id: "item_1", type: "ANNOUNCEMENT", gameId: null, gameName: null, sortOrder: 10, revision: "rev_item", createdAt: "2026-11-11T01:00:00.000Z", updatedAt: "2026-11-11T02:00:00.000Z", draft, published: null, latest: draft, ...over };
};

function router(handlers) {
  return (url, init) => {
    const method = init.method ?? "GET";
    const entry = handlers.find((h) => (h.method ?? "GET") === method && (h.match instanceof RegExp ? h.match.test(url.pathname) : url.pathname === h.match));
    if (!entry) throw new Error(`unexpected notion test request ${method} ${url.pathname}${url.search}`);
    return entry.response(url, init);
  };
}

async function mount(t, component, props, handlers = []) {
  const browser = new Window({ url: "http://127.0.0.1:3101/content" });
  browser.Element.prototype.scrollIntoView = function () {};
  exposeBrowserGlobals(browser);
  Object.defineProperty(browser.navigator, "locks", { value: { request: async (_name, _options, callback) => callback({ name: _name }) }, configurable: true });
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    const method = init.method ?? "GET";
    if (method !== "GET") writes.push({ path: url.pathname, method, body: typeof init.body === "string" ? JSON.parse(init.body) : null, key: new Headers(init.headers).get("idempotency-key") });
    return router(handlers)(url, init);
  };
  const el = browser.document.createElement("div");
  el.className = "workspace-root content-management";
  browser.document.body.append(el);
  const reactRoot = createRoot(el);
  const currentProps = { ...props };
  const render = async (overrides = {}) => {
    Object.assign(currentProps, overrides);
    await act(async () => { reactRoot.render(createElement(component, currentProps)); });
    await settle();
  };
  const settle = async (ms = 30) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  await render();
  const click = async (node) => { assert.ok(node, "expected clickable node"); await act(async () => { node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); }); await settle(); };
  const btn = (name, scope = el) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === name);
  const setInput = async (input, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await settle();
  };
  // 只派发输入并 flush React，不等待定时器：用于在自动保存停顿窗口内同步断言 dirty 态。
  const inputOnly = async (input, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
  };
  const waitFor = async (predicate, timeout = 5000) => {
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
  return { browser, el, writes, render, settle, click, btn, setInput, inputOnly, waitFor };
}

const itemProps = (over = {}) => ({
  detail: { item: itemRow(), versions: [itemRow().draft] },
  games: [], canEdit: true, canPublish: true, mediaReadable: true,
  onClose() {}, onChanged: async () => {}, onDirtyChange() {},
  requestMediaOptions: async () => ({ items: [], nextCursor: null, limit: 20 }),
  autosaveDelayMs: 40,
  ...over,
});

test("公告保存发送现行 document 合同，visibleFrom 从北京时间转为 UTC", async (t) => {
  // 手动保存合同：拉长自动保存停顿，确保这一次写入只来自「保存草稿」点击。
  const h = await mount(t, ItemEditor, itemProps({ autosaveDelayMs: 60000 }), [
    { method: "PUT", match: "/api/bff/admin/content/items/item_1/draft", response: () => json({ version: itemVersion({ revision: "rev_d2" }) }) },
  ]);
  await h.waitFor(() => h.el.querySelector(".plate-editor"));
  assert.equal(h.writes.length, 0, "打开公告草稿不会写入");
  await h.click(h.btn("发布设置"));
  const visibleFrom = h.el.querySelector('[data-beijing-datetime-input][aria-label^="定时可见时间"]');
  assert.ok(visibleFrom, "visibleFrom datetime 控件");
  await h.setInput(visibleFrom, "2030-01-02T12:30");
  await h.click(h.btn("应用到草稿"));
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => h.writes.length === 1);
  const body = h.writes[0].body;
  assert.equal(body.versionId, "ver_d1");
  assert.equal(body.expectedRevision, "rev_d1");
  assert.equal(body.payload, undefined, "旧字段会被 API 拒绝");
  assert.equal(body.document.format, "plate");
  assert.equal(body.document.schemaVersion, 1);
  assert.equal(body.document.preset, "update");
  assert.equal(body.document.value[0].children[0].text, "正文段落", "真实接口的直接文档读回后保留正文");
  assert.equal(body.updateSettings.format, "plate");
  assert.equal(body.updateSettings.visibleFrom, "2030-01-02T04:30:00.000Z");
  assert.equal(body.body, undefined, "不再提交 markdown body");
});

test("发布设置取消不写入，应用后随草稿保存", async (t) => {
  const dirtyStates = [];
  const h = await mount(t, ItemEditor, itemProps({ autosaveDelayMs: 60000, onDirtyChange: value => dirtyStates.push(value) }), [
    { method: "PUT", match: "/api/bff/admin/content/items/item_1/draft", response: () => json({ version: itemVersion({ revision: "rev_d2" }) }) },
  ]);
  await h.click(h.btn("发布设置"));
  const summary = () => h.el.querySelector('input[placeholder="一句话说明这条动态"]');
  await h.setInput(summary(), "取消的摘要");
  assert.equal(dirtyStates.at(-1), true, "弹窗内未应用修改也受离开保护");
  await h.click(h.btn("取消"));
  assert.equal(dirtyStates.at(-1), false);
  assert.equal(h.writes.length, 0);
  await h.click(h.btn("发布设置"));
  assert.equal(summary().value, "摘要");
  await h.setInput(summary(), "新的摘要");
  await h.click(h.btn("应用到草稿"));
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => h.writes.length === 1);
  assert.equal(h.writes[0].body.summary, "新的摘要");
});

test("公告自动保存：停顿后自动写草稿，状态文字+图标 aria-live；409 冲突停止自动保存并只读", async (t) => {
  let calls = 0;
  const h = await mount(t, ItemEditor, itemProps(), [
    { method: "PUT", match: "/api/bff/admin/content/items/item_1/draft", response: () => { calls += 1; return calls === 1 ? json({ version: itemVersion({ revision: "rev_d2" }) }) : json({ error: { code: "VERSION_CHANGED" } }, 409); } },
  ]);
  await h.waitFor(() => h.el.querySelector(".plate-editor"));
  const status = h.el.querySelector(".content-save-status");
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.ok(status.querySelector("svg"), "状态带图标");
  await h.inputOnly(h.el.querySelector('input[aria-label="文档标题"]'), "自动保存标题");
  assert.ok(h.el.querySelector('.content-save-status[data-phase="dirty"]'), "未保存态");
  await h.waitFor(() => calls === 1, 3000);
  assert.equal(h.writes[0].body.title, "自动保存标题", "停顿后自动保存，无需点击");
  assert.ok(h.el.querySelector('.content-save-status[data-phase="saved"]'), "已保存态");

  // 第二次自动保存返回 409 → 冲突横幅 + 只读 + 停止自动保存。
  await h.setInput(h.el.querySelector('input[aria-label="文档标题"]'), "冲突前的修改");
  await h.waitFor(() => calls === 2, 3000);
  await h.waitFor(() => h.el.querySelector(".content-conflict-banner"));
  assert.ok(h.el.querySelector(".content-conflict-banner").textContent.includes("别人刚改过，刷新后再改"));
  await h.waitFor(() => h.el.querySelector('.plate-editor[data-readonly="true"]'));
  assert.equal(h.el.querySelector('.content-save-status[data-phase="conflict"]') !== null, true);
  const writesAtConflict = h.writes.length;
  await h.settle(120);
  assert.equal(h.writes.length, writesAtConflict, "冲突后不再自动保存");
  assert.ok(h.btn("保存草稿") === undefined, "冲突态收起保存入口");
});

test("公告保存被 400 拒绝后停止自动重试，手动保存保留并提交当前输入", async (t) => {
  let calls = 0;
  const h = await mount(t, ItemEditor, itemProps(), [
    { method: "PUT", match: "/api/bff/admin/content/items/item_1/draft", response: () => ++calls === 1
      ? json({ error: { code: "INVALID_ARGUMENT" } }, 400)
      : json({ version: itemVersion({ revision: "rev_d2" }) }) },
  ]);
  const title = h.el.querySelector('input[aria-label="文档标题"]');
  await h.inputOnly(title, "保留这次编辑");
  await h.waitFor(() => h.el.querySelector('.content-save-status[data-phase="failed"]'));
  await h.settle(160);
  assert.equal(h.writes.length, 1);
  assert.equal(title.value, "保留这次编辑");
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => h.el.querySelector('.content-save-status[data-phase="saved"]'));
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].body.title, "保留这次编辑");
});

test("平台动态单击发布先保存当前输入，再按保存回执的草稿版本发布", async (t) => {
  let rejectSave = true;
  const h = await mount(t, ItemEditor, itemProps({ embedded: true, autosaveDelayMs: 60000 }), [
    { method: "PUT", match: "/api/bff/admin/content/items/item_1/draft", response: () => rejectSave
      ? json({ error: { code: "INVALID_ARGUMENT" } }, 400)
      : json({ version: itemVersion({ revision: "rev_d2" }) }) },
    { method: "POST", match: "/api/bff/admin/content/items/item_1/publish", response: () => json({ published: true }) },
  ]);
  const title = h.el.querySelector('input[aria-label="文档标题"]');
  await h.inputOnly(title, "要发布的最新版");
  await h.click(h.btn("预览"));
  assert.ok(h.el.querySelector('[aria-label="用户端预览"]').textContent.includes("要发布的最新版"));
  await h.click(h.btn("继续编辑"));
  await h.click(h.btn("发布"));
  assert.deepEqual(h.writes.map(request => request.method), ["PUT"], "保存失败时不发布旧草稿");
  assert.equal(title.value, "要发布的最新版");
  rejectSave = false;
  await h.click(h.btn("发布"));
  assert.deepEqual(h.writes.map(request => request.method), ["PUT", "PUT", "POST"]);
  assert.equal(h.writes[1].body.title, "要发布的最新版");
  assert.deepEqual(h.writes[2].body, { versionId: "ver_d1", expectedRevision: "rev_d2" });
});

test("保存结果未知时重试原幂等键，保留这期间输入的更新内容", async (t) => {
  let attempts = 0;
  const h = await mount(t, ItemEditor, itemProps({ autosaveDelayMs: 60000 }), [
    { method: "PUT", match: "/api/bff/admin/content/items/item_1/draft", response: () => {
      if (++attempts === 1) throw new TypeError("network interrupted");
      return json({ version: itemVersion({ revision: "rev_d2" }) });
    } },
  ]);
  const title = h.el.querySelector('input[aria-label="文档标题"]');
  await h.inputOnly(title, "原请求的内容");
  await h.click(h.btn("保存草稿"));
  assert.ok(h.el.textContent.includes("操作结果待核对"));
  await h.inputOnly(title, "后续修改的内容");
  await h.click(h.btn("保存草稿"));
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[1], h.writes[0], "核对使用原幂等键和原请求内容");
  assert.equal(title.value, "后续修改的内容");
  assert.ok(h.el.querySelector('.content-save-status[data-phase="dirty"]'));
});

test("客服只读：不加载编辑器，PlateDocument 渲染正文，无保存/发布入口", async (t) => {
  const h = await mount(t, ItemEditor, itemProps({ canEdit: false, canPublish: false }));
  await h.waitFor(() => h.el.querySelector('[aria-label="正文只读视图"]'));
  assert.ok(h.el.textContent.includes("正文段落"));
  assert.equal(h.el.querySelector(".plate-editor"), null, "客服不挂载 Plate 编辑器");
  assert.ok(h.btn("保存草稿") === undefined, "客服无保存入口");
  assert.ok(h.el.textContent.includes("只能查看"));
  assert.equal(h.writes.length, 0);
});

test("公告插图：素材库选择注入 mediaId，保存 mediaIds 与预览 mediaUrls 一致", async (t) => {
  // 手动保存合同：拉长自动保存停顿，确保写入只来自点击，mediaIds 断言不被自动保存抢跑。
  const h = await mount(t, ItemEditor, itemProps({ autosaveDelayMs: 60000 }), [
    { method: "PUT", match: "/api/bff/admin/content/items/item_1/draft", response: () => json({ version: itemVersion({ revision: "rev_d2" }) }) },
    { match: "/api/bff/admin/content/media-options", response: () => json({ items: [{ id: "media_opt_1", mime: "image/png", width: 640, height: 320, byteSize: "1024" }], nextCursor: null, limit: 20 }) },
  ]);
  await h.waitFor(() => h.el.querySelector(".plate-editor"));
  await h.click(h.btn("插入图片"));
  await h.waitFor(() => [...h.el.querySelectorAll("button")].some((node) => node.textContent.includes("640 × 320")));
  await h.click([...h.el.querySelectorAll("button")].find((node) => node.textContent.includes("640 × 320")));
  await h.waitFor(() => h.el.querySelector('.plate-editor img[src*="media_opt_1"]'), 5000);
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => h.writes.length === 1);
  const img = h.writes[0].body.document.value.find((node) => node.type === "img");
  assert.equal(img.mediaId, "media_opt_1");
  assert.equal(img.url, undefined, "预览 URL 不进入存储合同");
});

const guideDetail = (over = {}) => {
  const payload = {
    kind: "guide", id: "qa-guide", slug: "qa-guide", title: "帮助标题", summary: "帮助摘要", category: "rental",
    audience: ["all"], keywords: ["租号"], related: [], updatedAt: "2026-11-11", contactCta: true,
    format: "plate", schemaVersion: 1, document: plateDoc("帮助正文", "help"), mediaIds: [],
    anchorAliases: { "旧锚点": "n1" },
    ...over,
  };
  const draft = { id: "draft_g", revision: "2", sequence: 2, state: "DRAFT", title: payload.title, payload, publishedAt: null, updatedAt: "2026-11-11T02:00:00.000Z" };
  return {
    key: `guide:${payload.slug}`, definition: null,
    item: { id: "item_g", resourceKey: `guide:${payload.slug}`, gameId: null, revision: "6" },
    draft, published: null, versions: [draft],
    current: { schema: "content-resource.v1", key: `guide:${payload.slug}`, source: "MANAGED", state: "unpublished", payload: null, media: [] },
    baseline: null,
  };
};

test("帮助文章：guide→help 预设，保存保留元数据与 anchorAliases，自动保存走 draft.save", async (t) => {
  const writes = [];
  const h = await mount(t, ContentResourceEditor, {
    detail: guideDetail(), canEdit: true, canPublish: true, locked: false,
    canBrowseMedia: true, relatedOptions: [],
    onWrite: async (operation, body) => { writes.push({ operation, body }); },
    onClose() {}, onDirtyChange() {}, autosaveDelayMs: 40,
  });
  await h.waitFor(() => h.el.querySelector(".plate-editor"));
  assert.ok(h.el.textContent.includes("帮助正文"));
  assert.equal(h.el.querySelector('input[aria-label="文档标题"]').value, "帮助标题");
  await h.setInput(h.el.querySelector('input[aria-label="文档标题"]'), "帮助标题（改）");
  await h.waitFor(() => writes.length === 1, 3000);
  assert.equal(writes[0].operation, "content.resource.draft.save");
  const payload = writes[0].body.payload;
  assert.equal(payload.kind, "guide");
  assert.equal(payload.format, "plate");
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.document.preset, "help");
  assert.equal(payload.title, "帮助标题（改）");
  assert.equal(payload.slug, "qa-guide");
  assert.equal(payload.summary, "帮助摘要");
  assert.equal(payload.category, "rental");
  assert.deepEqual(payload.audience, ["all"]);
  assert.deepEqual(payload.keywords, ["租号"]);
  assert.equal(payload.contactCta, true);
  assert.deepEqual(payload.anchorAliases, { "旧锚点": "n1" });
  assert.deepEqual(payload.mediaIds, []);
  assert.equal(payload.markdown, undefined);
  assert.equal(payload.sections, undefined);
});

test("场景说明：notice→notice 预设，紧凑正文合同", async (t) => {
  const writes = [];
  const detail = guideDetail();
  detail.key = "notice:PUBLISH_SAFE_BOX";
  detail.item.resourceKey = detail.key;
  detail.draft.payload = { kind: "notice", title: "保险箱说明", format: "plate", schemaVersion: 1, document: plateDoc("说明正文", "notice"), mediaIds: [] };
  detail.current.key = detail.key;
  const h = await mount(t, ContentResourceEditor, {
    detail, canEdit: true, canPublish: true, locked: false,
    onWrite: async (operation, body) => { writes.push({ operation, body }); },
    onClose() {}, onDirtyChange() {}, autosaveDelayMs: 40,
  });
  await h.waitFor(() => h.el.querySelector(".plate-editor"));
  await h.setInput(h.el.querySelector('input[aria-label="文档标题"]'), "保险箱说明（改）");
  await h.waitFor(() => writes.length === 1, 3000);
  const payload = writes[0].body.payload;
  assert.equal(payload.kind, "notice");
  assert.equal(payload.document.preset, "notice");
  assert.equal(payload.title, "保险箱说明（改）");
  assert.equal(payload.category, undefined, "notice 不带 guide 元数据");
});

test("资源冲突：conflict 横幅、编辑器只读保留本地内容、自动保存停止", async (t) => {
  const writes = [];
  const h = await mount(t, ContentResourceEditor, {
    detail: guideDetail(), canEdit: true, canPublish: true, locked: false, conflict: true,
    onReload() {}, onWrite: async (operation, body) => { writes.push({ operation, body }); },
    onClose() {}, onDirtyChange() {}, autosaveDelayMs: 40,
  });
  await h.waitFor(() => h.el.querySelector(".content-conflict-banner"));
  assert.ok(h.el.querySelector(".content-conflict-banner").textContent.includes("别人刚改过，刷新后再改"));
  await h.waitFor(() => h.el.querySelector('.plate-editor[data-readonly="true"]'));
  assert.ok(h.el.textContent.includes("帮助正文"), "冲突后本地内容保留");
  assert.ok(h.btn("保存草稿") === undefined, "无保存入口");
  assert.ok(h.btn("重新读取"), "冲突横幅提供重新读取");
  await h.settle(120);
  assert.equal(writes.length, 0, "冲突态不自动保存");
});

test("资源只读（客服）：PlateDocument 渲染，无编辑/保存入口", async (t) => {
  const h = await mount(t, ContentResourceEditor, {
    detail: guideDetail(), canEdit: false, canPublish: false, locked: false,
    onWrite: async () => { throw new Error("read-only must not write"); },
    onClose() {}, onDirtyChange() {},
  });
  await h.waitFor(() => h.el.querySelector('[aria-label="正文只读视图"]'));
  assert.ok(h.el.textContent.includes("帮助正文"));
  assert.equal(h.el.querySelector(".plate-editor"), null);
  assert.ok(h.btn("保存草稿") === undefined, "无保存入口");
  assert.ok(h.btn("发布到用户页面") === undefined, "无发布入口");
  assert.ok(h.el.textContent.includes("当前账号只能查看，不能保存或发布"));
});

// ---- UX round2：丢弃草稿逃生出口、关键词 chips、保存不重挂载 ----

/** 在 guideDetail（仅草稿）基础上补一个线上版本，用于丢弃草稿＝回到线上。 */
const guideWithPublished = () => {
  const detail = guideDetail();
  const publishedPayload = { ...detail.draft.payload, title: "线上标题" };
  const published = { id: "pub_g", revision: "1", sequence: 1, state: "PUBLISHED", title: "线上标题", payload: publishedPayload, publishedAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" };
  detail.published = published;
  detail.versions = [detail.draft, published];
  detail.current = { ...detail.current, state: "available", payload: publishedPayload, version: { id: "pub_g", sequence: 1, publishedAt: published.publishedAt } };
  return detail;
};

test("帮助文章：草稿/线上状态徽章清晰，丢弃草稿二次确认写明后果，确认丢弃当前草稿、取消不写", async (t) => {
  const writes = [];
  const h = await mount(t, ContentResourceEditor, {
    detail: guideWithPublished(), canEdit: true, canPublish: true, locked: false, canBrowseMedia: true, relatedOptions: [],
    onWrite: async (operation, body) => { writes.push({ operation, body }); },
    onClose() {}, onDirtyChange() {}, autosaveDelayMs: 60000,
  });
  await h.waitFor(() => h.el.querySelector(".plate-editor"));
  const status = h.el.querySelector(".content-doc-status");
  assert.ok(status.textContent.includes("线上 v1"), "线上版本徽章");
  assert.ok(status.textContent.includes("草稿 v2"), "草稿版本徽章");
  assert.equal(h.btn("撤回审批"), undefined, "帮助文章没有审批步骤");

  const trigger = h.btn("丢弃草稿");
  assert.ok(trigger && !trigger.disabled, "有线上版本时丢弃草稿可用");
  await h.click(trigger);
  await h.waitFor(() => h.btn("确认丢弃"));
  assert.ok(h.el.textContent.includes("丢弃草稿，回到线上版本？"));
  assert.ok(h.el.textContent.includes("草稿里的全部修改将永久删除"), "写明丢弃后果");
  // 取消：不写、对话框关闭。
  await h.click(h.btn("继续编辑"));
  await h.settle(40);
  assert.equal(writes.length, 0, "取消不产生写入");
  assert.equal(h.btn("确认丢弃"), undefined, "对话框已关闭");
  // 丢弃提交当前工作副本的身份与并发修订。
  await h.click(h.btn("丢弃草稿"));
  await h.waitFor(() => h.btn("确认丢弃"));
  await h.click(h.btn("确认丢弃"));
  await h.waitFor(() => writes.length === 1);
  assert.equal(writes[0].operation, "content.resource.draft.discard");
  assert.equal(writes[0].body.versionId, "draft_g", "指向被丢弃的草稿");
  assert.equal(writes[0].body.expectedRevision, "6", "携带并发版本");
});

test("帮助文章：无线上版本时丢弃草稿禁用并说明（后端无删除未发布草稿接口）", async (t) => {
  const h = await mount(t, ContentResourceEditor, {
    detail: guideDetail(), canEdit: true, canPublish: true, locked: false, relatedOptions: [],
    onWrite: async () => { throw new Error("must not write"); },
    onClose() {}, onDirtyChange() {}, autosaveDelayMs: 60000,
  });
  await h.waitFor(() => h.el.querySelector(".plate-editor"));
  const trigger = h.btn("丢弃草稿");
  assert.ok(trigger && trigger.disabled, "未发布草稿无法丢弃");
  assert.ok(h.el.textContent.includes("文章还没有线上版本"), "禁用原因可见");
});

test("关键词 chips（组件级）：回车/逗号添加、去重、删除、上限禁用与超长截断", async (t) => {
  function Wrapper() {
    const [value, setValue] = useState(["租号"]);
    return createElement(ContentKeywordChips, { value, onChange: setValue, max: 3, maxLength: 6, "aria-label": "搜索关键词" });
  }
  const h = await mount(t, Wrapper, {});
  const input = h.el.querySelector(".content-chips-input");
  const chips = () => [...h.el.querySelectorAll(".content-chip-text")].map(node => node.textContent);
  const press = async (key) => { await act(async () => { input.dispatchEvent(new h.browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); await h.settle(15); };
  assert.deepEqual(chips(), ["租号"]);
  await h.setInput(input, "人脸");
  await press("Enter");
  assert.deepEqual(chips(), ["租号", "人脸"], "回车添加 chip");
  await h.setInput(input, "认证,租号");
  await h.settle(15);
  assert.deepEqual(chips(), ["租号", "人脸", "认证"], "逗号拆分且去重");
  assert.ok(h.el.querySelector(".content-chips-count").textContent.includes("3 / 3"), "上限计数");
  assert.ok(input.disabled, "达上限禁用输入");
  assert.ok(h.el.textContent.includes("已达上限"), "上限提示");
  await h.click([...h.el.querySelectorAll(".content-chip-remove")].find(node => node.getAttribute("aria-label") === "删除关键词 人脸"));
  assert.deepEqual(chips(), ["租号", "认证"], "chip 可删除");
  assert.equal(input.disabled, false, "删除后恢复输入");
  await h.setInput(input, "超长关键词超过六字");
  await press("Enter");
  assert.deepEqual(chips(), ["租号", "认证", "超长关键词超"], "超长按 maxLength 截断");
  assert.ok(h.el.textContent.includes("超出部分已截断"), "截断提示");
});

test("帮助文章：文档设置默认折叠，关键词改 chips 且 label 关联输入，保存仍写 string[] 合同", async (t) => {
  const writes = [];
  const h = await mount(t, ContentResourceEditor, {
    detail: guideDetail({ keywords: ["租号"] }), canEdit: true, canPublish: true, locked: false, canBrowseMedia: true, relatedOptions: [],
    onWrite: async (operation, body) => { writes.push({ operation, body }); },
    onClose() {}, onDirtyChange() {}, autosaveDelayMs: 60000,
  });
  await h.waitFor(() => h.el.querySelector(".plate-editor"));
  const settings = h.el.querySelector("details.content-doc-settings");
  assert.ok(settings, "文档设置面板存在");
  assert.equal(settings.open, false, "默认折叠");
  assert.ok(h.el.querySelector(".content-notion-meta-grid") === null, "摘要/分类不再散落在正文上方");
  settings.open = true;
  await h.settle(20);
  // 元数据全部收进设置面板，每项带 helper。
  for (const label of ["摘要", "所属分类", "适用对象", "搜索关键词", "相关阅读", "显示联系客服入口"]) {
    assert.ok(settings.textContent.includes(label), `设置面板含 ${label}`);
  }
  assert.ok(settings.textContent.includes("所选文章会显示在正文末尾"), "相关阅读 helper");
  assert.equal(settings.querySelector("textarea[aria-label]") === null || ![...settings.querySelectorAll("textarea")].some(node => (node.value || "").includes("\n")), true, "关键词不再是每行一词的大 textarea");
  // label 关联 chips 输入（与 content-view 既有选择器兼容）。
  const label = [...h.el.querySelectorAll("label")].find(node => node.textContent.startsWith("搜索关键词"));
  const input = h.browser.document.getElementById(label.htmlFor);
  assert.ok(input && input.classList.contains("content-chips-input"), "搜索关键词 label 指向 chips 输入");
  assert.deepEqual([...settings.querySelectorAll(".content-chip-text")].map(node => node.textContent), ["租号"]);
  await h.setInput(input, "人脸");
  await act(async () => { input.dispatchEvent(new h.browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await h.settle(20);
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => writes.length === 1);
  assert.deepEqual(writes[0].body.payload.keywords, ["租号", "人脸"], "底层仍是 string[] 合同");
});

test("帮助文章：保存不重挂载编辑器——busy/locked 周期内 contenteditable 节点身份不变，基线就地推进", async (t) => {
  const writes = [];
  let resolveWrite;
  const h = await mount(t, ContentResourceEditor, {
    detail: guideDetail(), canEdit: true, canPublish: true, locked: false, busy: false, canBrowseMedia: true, relatedOptions: [],
    onWrite: (operation, body) => { writes.push({ operation, body }); return new Promise(resolve => { resolveWrite = resolve; }); },
    onClose() {}, onDirtyChange() {}, autosaveDelayMs: 60000,
  });
  await h.waitFor(() => h.el.querySelector('[contenteditable="true"]'));
  const ceBefore = h.el.querySelector('[contenteditable="true"]');
  await h.setInput(h.el.querySelector('input[aria-label="文档标题"]'), "改标题");
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => writes.length === 1);
  // 写入进行中：父层 locked/busy 置真，编辑器只读态不得随之翻转。
  await h.render({ busy: true, locked: true });
  const ceDuring = h.el.querySelector('[contenteditable="true"]');
  assert.equal(ceDuring, ceBefore, "保存中仍是同一 contenteditable（未重挂载）");
  assert.ok(ceBefore.isConnected, "原编辑器节点仍连接");
  // 写入成功完成：busy/locked 复位，基线就地推进。
  await act(async () => { resolveWrite(); });
  await h.render({ busy: false, locked: false, success: "草稿已保存，线上内容保持不变。" });
  await h.settle(30);
  const ceAfter = h.el.querySelector('[contenteditable="true"]');
  assert.equal(ceAfter, ceBefore, "保存完成后仍是同一 contenteditable 节点");
  assert.ok(h.btn("保存草稿").disabled, "基线推进后无脏态，保存按钮禁用");
});

test("帮助文章（tab 级）：draft.save 不 bump editorGeneration，整条保存链路 contenteditable 身份不变", async (t) => {
  const detail = guideDetail();
  const listItem = {
    current: { schema: "content-resource.v1", key: detail.key, source: "MANAGED", state: "unpublished", payload: detail.draft.payload, media: [], version: null },
    definition: null,
    metadata: { itemId: "item_g", revision: "6", updatedAt: "2026-11-11T02:00:00.000Z", hasDraft: true, title: detail.draft.payload.title },
  };
  const savedDetail = { ...detail, item: { ...detail.item, revision: "7" }, draft: { ...detail.draft, revision: "3", updatedAt: "2026-11-11T03:00:00.000Z" }, versions: [{ ...detail.draft, revision: "3" }] };
  const snapshot = {
    authenticated: true, adminUserId: "admin_ux",
    user: { name: "内容管理员", username: "admin_ux", displayUsername: "内容管理员", twoFactorEnabled: false },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: "sess_ux", locked: false, pinConfigured: false, createdAt: null, expiresAt: null },
    permissions: ["content.platform.read", "content.platform.edit", "content.platform.publish"],
  };
  const detailPath = `/api/bff/admin/content/resources/${encodeURIComponent(detail.key)}`;
  const h = await mount(t, ContentResourcesTab, {
    group: "rules", snapshot, games: [], refreshNonce: 0, onDirtyChange() {}, onWriteLockChange() {}, openResource: detail.key,
  }, [
    { match: "/api/bff/admin/content/resources", response: () => json({ items: [listItem], nextCursor: null, limit: 5 }) },
    { match: detailPath, response: () => json(detail) },
    { method: "PUT", match: `${detailPath}/draft`, response: () => json(savedDetail) },
  ]);
  await h.waitFor(() => h.el.querySelector('[contenteditable="true"]'), 8000);
  const ceBefore = h.el.querySelector('[contenteditable="true"]');
  await h.setInput(h.el.querySelector('input[aria-label="文档标题"]'), "tab 级改标题");
  await h.click(h.btn("保存草稿"));
  await h.waitFor(() => h.writes.some(write => write.method === "PUT" && write.path.endsWith("/draft")), 8000);
  await h.waitFor(() => h.el.querySelector(".content-save-status")?.getAttribute("data-phase") === "saved", 8000);
  await h.settle(60);
  const ceAfter = h.el.querySelector('[contenteditable="true"]');
  assert.equal(ceAfter, ceBefore, "tab 级保存后仍是同一 contenteditable（editorGeneration 未 bump）");
  assert.ok(ceBefore.isConnected, "原节点未被卸载");
});
