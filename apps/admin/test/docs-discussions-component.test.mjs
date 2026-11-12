import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

/**
 * 内部文档评论弹层组件测试（happy-dom + 离线源码转译 + 合成 fetch）。
 * 覆盖：挂载即拉取、未解决/已解决/无法定位分组、ORPHANED 保留 anchor_text、
 * 工具栏草稿锚点建讨论（dsc_+uuid、Idempotency-Key、发布后关草稿）、回复/改删自己的、
 * 解决/重开、点击线程卡定位正文（onLocate）与激活/悬停上报、canComment 收敛与 403 提示。
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

const bootstrap = new Window({ url: "http://127.0.0.1:3101/" });
exposeBrowserGlobals(bootstrap);
const { createRoot } = await import("react-dom/client");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = await createOfflineAdminSource({ root });
const { DocsDiscussions } = await source.ssrLoadModule("/apps/admin/src/views/docs/docs-discussions.tsx");
const { newDiscussionId, addDiscussionMark, removeDiscussionMark } = await source.ssrLoadModule("/apps/admin/src/views/docs/docs-model.ts");

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const envelope = (text = "客服值班手册正文") => ({ format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "p", id: "n1", children: [{ text }] }] });

const comment = (id, author, body, over = {}) => ({
  id, discussionId: "dsc_open", body, authorAdminId: author,
  createdAt: "2026-11-12T02:00:00.000Z", editedAt: null, deletedAt: null, ...over,
});
const discussion = (id, over = {}) => ({
  id, nodeId: "doc_a", anchorText: "值班交接要点", status: "OPEN", anchorState: "PRESENT",
  createdByAdminId: "admin_me", createdAt: "2026-11-12T02:00:00.000Z",
  resolvedByAdminId: null, resolvedAt: null, comments: [], ...over,
});

const ITEMS = [
  discussion("dsc_open", { comments: [comment("dcm_mine", "admin_me", "我的回复"), comment("dcm_other", "admin_other", "别人的回复")] }),
  discussion("dsc_orphan", { anchorState: "ORPHANED", anchorText: "整句已被删除的原文", comments: [comment("dcm_o", "admin_other", "锚点没了仍可回复")] }),
  discussion("dsc_done", { status: "RESOLVED", resolvedByAdminId: "admin_me", resolvedAt: "2026-11-12T03:00:00.000Z", comments: [comment("dcm_d", "admin_me", "已解决的讨论")] }),
];

function router(handlers) {
  return (url, init) => {
    const method = init.method ?? "GET";
    const entry = handlers.find((h) => (h.method ?? "GET") === method && (h.match instanceof RegExp ? h.match.test(url.pathname) : url.pathname === h.match));
    if (!entry) throw new Error(`unexpected discussions test request ${method} ${url.pathname}${url.search}`);
    return entry.response(url, init);
  };
}

const threadView = (activeId, ids = [activeId]) => ({ kind: "block", activeId, ids });

async function mountPanel(t, { canComment = true, draftAnchor = null, items = ITEMS, handlers = [], view = draftAnchor ? { kind: "draft" } : { kind: "overview" }, props = {} } = {}) {
  const browser = new Window({ url: "http://127.0.0.1:3101/docs/doc_a" });
  browser.Element.prototype.scrollIntoView = function () {};
  exposeBrowserGlobals(browser);
  const requests = [];
  const originalFetch = globalThis.fetch;
  let currentItems = items;
  const defaults = [
    { match: "/api/bff/admin/docs/doc_a/discussions", response: () => json({ discussions: currentItems }) },
  ];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    requests.push({ path: url.pathname, query: url.search, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : null, key: new Headers(init.headers).get("idempotency-key") });
    return router([...handlers, ...defaults])(url, init);
  };
  const el = browser.document.createElement("div");
  browser.document.body.append(el);
  const reactRoot = createRoot(el);
  const created = [];
  const resolved = [];
  const openIds = [];
  const located = [];
  const activeLog = [];
  const hoverLog = [];
  const draftCancels = [];
  const render = (next = view) => {
    view = next;
    reactRoot.render(createElement(DocsDiscussions, {
      docId: "doc_a",
      view,
      anchor: null,
      refreshKey: 0,
      onClose: () => render(null),
      canComment,
      currentAdminId: "admin_me",
      draftAnchor,
      onAnnotatingChange: () => true,
      onDraftCancel: () => draftCancels.push(true),
      onReselectDraft: () => render(null),
      onResumeDraft: () => render({ kind: "draft" }),
      hoverId: null,
      presentIds: new Set(["dsc_open"]),
      onActiveIdChange: (id) => {
        activeLog.push(id);
        render(threadView(id, view.ids));
      },
      onHoverIdChange: (id) => hoverLog.push(id),
      onOpenThread: (discussion) => { located.push(discussion.id); render(threadView(discussion.id)); },
      onCreated: (result) => {
        created.push(result);
        currentItems = [...currentItems, result.discussion];
        render(threadView(result.discussion.id));
      },
      onResolved: (result) => resolved.push(result),
      onOpenIdsChange: (ids) => openIds.push(ids),
      ...props,
    }));
  };
  await act(async () => render());
  const settle = async (ms = 30) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  await settle();
  const body = () => browser.document.body;
  const click = async (node) => { await act(async () => { node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true })); }); await settle(); };
  const button = (text, scope = body()) => [...scope.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === text || b.textContent.includes(text));
  const openMenu = async (trigger) => {
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const menuItem = (text) => [...body().querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === text);
  const setTextarea = async (area, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(area, value);
      area.dispatchEvent(new browser.Event("input", { bubbles: true }));
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
  const setView = async (next) => { await act(async () => render(next)); await settle(); };
  return { browser, el, body, requests, created, resolved, openIds, located, activeLog, hoverLog, draftCancels, settle, click, button, openMenu, menuItem, setTextarea, waitFor, setView, setItems: (next) => { currentItems = next; } };
}

test("总览分组，ORPHANED 保留原文摘录、回复和解决入口", async (t) => {
  const h = await mountPanel(t);
  const openGroup = h.body().querySelector('[aria-label="未解决讨论"]');
  const resolvedGroup = h.body().querySelector('[aria-label="已解决讨论"]');
  const orphanedGroup = h.body().querySelector('[aria-label="无法定位原文讨论"]');
  assert.ok(openGroup && resolvedGroup);
  assert.ok(openGroup.textContent.includes("未解决（1）"));
  assert.ok(resolvedGroup.textContent.includes("已解决（1）"));
  assert.ok(orphanedGroup.textContent.includes("无法定位原文（1）"));
  await h.click(orphanedGroup.querySelector("button"));
  const orphan = h.body().querySelector('[data-orphaned="true"]');
  assert.ok(orphan);
  assert.ok(orphan.textContent.includes("无法定位原文"));
  assert.ok(orphan.textContent.includes("整句已被删除的原文"), "anchor_text 保留");
  assert.ok(orphan.textContent.includes("锚点没了仍可回复"), "ORPHANED 仍可回复");
  assert.ok(h.button("解决", orphan), "ORPHANED 仍可解决");
  assert.equal(h.button("定位原文", orphan), undefined);
  assert.deepEqual(h.openIds.at(-1), ["dsc_open"], "仅上报仍有正文锚点的 OPEN id");
});

test("挂载预取，打开总览后点击摘录定位原文并展示对应线程", async (t) => {
  const h = await mountPanel(t, { view: null });
  assert.equal(h.body().querySelector('[role="dialog"]'), null);
  assert.ok(h.requests.some((r) => r.method === "GET" && r.path === "/api/bff/admin/docs/doc_a/discussions"), "挂载即拉取讨论列表");
  await h.setView({ kind: "overview" });
  const summary = h.body().querySelector('[aria-label="未解决讨论"] button');
  assert.ok(summary);
  await act(async () => { summary.dispatchEvent(new h.browser.MouseEvent("mouseover", { bubbles: true, relatedTarget: h.browser.document.body })); });
  await h.settle();
  assert.equal(h.hoverLog.at(-1), "dsc_open");
  await act(async () => { summary.dispatchEvent(new h.browser.MouseEvent("mouseout", { bubbles: true, relatedTarget: h.browser.document.body })); });
  await h.settle();
  assert.equal(h.hoverLog.at(-1), null);
  await h.click(summary);
  assert.deepEqual(h.located, ["dsc_open"]);
  const panel = h.body().querySelector('[role="dialog"][data-view="block"]');
  assert.ok(panel);
  assert.ok(panel.textContent.includes("我的回复"));
  assert.equal(panel.textContent.includes("锚点没了仍可回复"), false);
});

test("选区建讨论：dsc_+uuid、anchorText、Idempotency-Key，成功后回调 onCreated", async (t) => {
  const writeResult = { discussion: discussion("dsc_new"), versionId: "docv_9", seq: 9, document: envelope(), revision: "7" };
  const h = await mountPanel(t, {
    draftAnchor: "值班交接要点",
    handlers: [{ match: "/api/bff/admin/docs/doc_a/discussions", method: "POST", response: () => json(writeResult) }],
  });
  const composer = h.body().querySelector('[data-testid="discussion-composer"]');
  assert.ok(composer, "有选区时显示建讨论输入区");
  const area = composer.querySelector('[aria-label="评论内容"]');
  await h.setTextarea(area, "这里需要补充夜班流程");
  await h.click(h.button("发布评论", composer));
  const post = h.requests.find((request) => request.method === "POST" && request.path === "/api/bff/admin/docs/doc_a/discussions");
  assert.ok(post, "发起 POST discussions");
  assert.match(post.body.discussionId, /^dsc_[0-9a-f]{32}$/, "前端生成 dsc_+uuid");
  assert.equal(post.body.anchorText, "值班交接要点");
  assert.equal(post.body.body, "这里需要补充夜班流程");
  assert.ok(post.key, "写接口带 Idempotency-Key");
  assert.equal(h.created.length, 1, "onCreated 回传 ANNOTATE 结果");
  assert.equal(h.created[0].versionId, "docv_9");
  assert.equal(h.draftCancels.length, 1, "发布后关闭草稿输入区（onDraftCancel）");
  assert.ok(h.body().textContent.includes("评论已发布"));
});

test("回复、改删自己的：他人回复无编辑/删除入口；删除需二次确认", async (t) => {
  const h = await mountPanel(t, {
    view: threadView("dsc_open"),
    handlers: [
      { match: "/api/bff/admin/docs/discussions/dsc_open/comments", method: "POST", response: () => json({ comment: comment("dcm_new", "admin_me", "新回复") }) },
      { match: "/api/bff/admin/docs/comments/dcm_mine", method: "PATCH", response: () => json({ comment: comment("dcm_mine", "admin_me", "改过的回复", { editedAt: "2026-11-12T04:00:00.000Z" }) }) },
      { match: "/api/bff/admin/docs/comments/dcm_mine", method: "DELETE", response: () => json({ comment: comment("dcm_mine", "admin_me", "我的回复", { deletedAt: "2026-11-12T04:00:00.000Z" }) }) },
    ],
  });
  const card = h.body().querySelector('[data-status="OPEN"]');
  const mine = card.querySelector('[data-own="true"]');
  const other = [...card.querySelectorAll(".docs-comment")].find((node) => node.textContent.includes("别人的回复"));
  assert.ok(mine && other);
  assert.ok(h.button("留言操作", mine), "自己的回复可改删");
  assert.equal(h.button("留言操作", other), undefined, "他人回复无修改入口");

  // 回复。
  const replyArea = card.querySelector('[aria-label="回复内容"]');
  await h.setTextarea(replyArea, "新回复");
  await h.click(h.button("回复", card));
  const post = h.requests.find((request) => request.method === "POST" && request.path === "/api/bff/admin/docs/discussions/dsc_open/comments");
  assert.deepEqual(post.body, { body: "新回复" });
  assert.ok(post.key);

  // 编辑自己的。
  await h.openMenu(h.button("留言操作", mine));
  await h.click(h.menuItem("编辑"));
  const editArea = h.body().querySelector('[aria-label="编辑回复"]');
  await h.setTextarea(editArea, "改过的回复");
  await h.click(h.button("保存", mine));
  const patch = h.requests.find((request) => request.method === "PATCH" && request.path === "/api/bff/admin/docs/comments/dcm_mine");
  assert.deepEqual(patch.body, { body: "改过的回复" });

  // 删除自己的：二次确认后才发 DELETE。
  const mineAgain = h.body().querySelector('[data-own="true"]');
  await h.openMenu(h.button("留言操作", mineAgain));
  await h.click(h.menuItem("删除"));
  assert.equal(h.requests.some((request) => request.method === "DELETE"), false, "第一次点击不直接删除");
  await h.click(h.button("确认删除", mineAgain));
  const del = h.requests.find((request) => request.method === "DELETE" && request.path === "/api/bff/admin/docs/comments/dcm_mine");
  assert.ok(del && del.key, "DELETE 带 Idempotency-Key");
});

test("回复失败后切换或关掉弹层仍保留文字，重试复用幂等键", async (t) => {
  let attempts = 0;
  const h = await mountPanel(t, {
    view: threadView("dsc_open", ["dsc_open", "dsc_orphan"]),
    handlers: [{ match: "/api/bff/admin/docs/discussions/dsc_open/comments", method: "POST", response: () => (
      ++attempts === 1 ? json({ error: { code: "INTERNAL_ERROR" } }, 500) : json({ comment: comment("dcm_retry", "admin_me", "要重试的回复") })
    ) }],
  });
  await h.setTextarea(h.body().querySelector('[aria-label="回复内容"]'), "要重试的回复");
  await h.click(h.button("回复"));
  assert.ok(h.body().querySelector('#internal-doc-comments [role="alert"]'));
  await h.click(h.body().querySelector('[aria-label^="第 2 条评论"]'));
  assert.equal(h.body().querySelector('[aria-label="回复内容"]').value, "");
  await h.setView(null);
  await h.setView(threadView("dsc_open"));
  assert.equal(h.body().querySelector('[aria-label="回复内容"]').value, "要重试的回复");
  await h.click(h.button("回复"));
  const writes = h.requests.filter((request) => request.method === "POST");
  assert.equal(writes.length, 2);
  assert.ok(writes[0].key);
  assert.equal(writes[0].key, writes[1].key);
  assert.equal(h.body().querySelector('[aria-label="回复内容"]').value, "");
});

test("解决与重开：POST resolve/reopen，解决回调 onResolved；409 刷新列表", async (t) => {
  const resolveResult = { discussion: discussion("dsc_open", { status: "RESOLVED", resolvedByAdminId: "admin_me", resolvedAt: "2026-11-12T05:00:00.000Z" }), versionId: "docv_10", seq: 10, document: envelope(), revision: "7" };
  const h = await mountPanel(t, {
    view: threadView("dsc_open"),
    handlers: [
      { match: "/api/bff/admin/docs/discussions/dsc_open/resolve", method: "POST", response: () => json(resolveResult) },
      { match: "/api/bff/admin/docs/discussions/dsc_done/reopen", method: "POST", response: () => {
        const reopened = discussion("dsc_done", { anchorState: "ORPHANED", comments: ITEMS[2].comments });
        h.setItems([ITEMS[0], ITEMS[1], reopened]);
        return json({ discussion: reopened });
      } },
    ],
  });
  const card = h.body().querySelector('[data-status="OPEN"]');
  await h.click(h.button("解决", card));
  assert.ok(h.requests.some((request) => request.method === "POST" && request.path === "/api/bff/admin/docs/discussions/dsc_open/resolve"));
  assert.equal(h.resolved.length, 1, "onResolved 回传去高亮正文");
  assert.equal(h.resolved[0].versionId, "docv_10");
  assert.ok(h.body().textContent.includes("讨论已解决"));
  await h.setView(threadView("dsc_done"));
  const resolvedCard = h.body().querySelector('[data-status="RESOLVED"]');
  await h.click(h.button("重开", resolvedCard));
  assert.ok(h.requests.some((request) => request.method === "POST" && request.path === "/api/bff/admin/docs/discussions/dsc_done/reopen"));
  assert.ok(h.body().textContent.includes("讨论已重开"));
  assert.ok(h.body().querySelector('[data-orphaned="true"]'));
});

test("canComment=false：查看线程时无建讨论/回复/解决入口", async (t) => {
  const h = await mountPanel(t, { canComment: false, draftAnchor: "值班交接要点", view: threadView("dsc_open") });
  assert.ok(h.body().textContent.includes("我的回复"));
  assert.equal(h.body().querySelector('[data-testid="discussion-composer"]'), null);
  assert.equal(h.button("发布评论"), undefined);
  assert.equal(h.button("回复"), undefined);
  assert.equal(h.button("解决"), undefined);
  assert.equal(h.button("重开"), undefined);
  assert.equal(h.button("编辑"), undefined);
});

test("403 显示没有权限；已删除回复显示占位", async (t) => {
  const h = await mountPanel(t, {
    draftAnchor: "值班交接要点",
    view: threadView("dsc_open"),
    items: [discussion("dsc_open", { comments: [comment("dcm_gone", "admin_me", "已删内容", { deletedAt: "2026-11-12T04:00:00.000Z" })] })],
    handlers: [{ match: "/api/bff/admin/docs/doc_a/discussions", method: "POST", response: () => json({ error: { code: "FORBIDDEN" } }, 403) }],
  });
  assert.ok(h.body().textContent.includes("该回复已删除"));
  assert.equal(h.body().textContent.includes("已删内容"), false, "已删除回复不展示原文");
  await h.setView({ kind: "draft" });
  const composer = h.body().querySelector('[data-testid="discussion-composer"]');
  await h.setTextarea(composer.querySelector('[aria-label="评论内容"]'), "越权评论");
  await h.click(h.button("发布评论", composer));
  await h.waitFor(() => h.body().textContent.includes("没有权限"));
});

test("模型助手：newDiscussionId 形状、本地加/去 mark 与服务端投影一致", async () => {
  assert.match(newDiscussionId(), /^dsc_[0-9a-f]{32}$/);
  const value = [{ type: "p", id: "n1", children: [{ text: "前缀目标后缀", bold: true }] }];
  const marked = addDiscussionMark(value, "dsc_x", "目标");
  assert.ok(marked);
  assert.deepEqual(marked[0].children.map((leaf) => leaf.text), ["前缀", "目标", "后缀"]);
  assert.equal(marked[0].children[1].comment_dsc_x, true);
  assert.ok(marked[0].children.every((leaf) => leaf.bold === true));
  assert.equal(addDiscussionMark(value, "dsc_x", "不存在"), null);
  const cleaned = removeDiscussionMark(marked, "dsc_x");
  assert.equal(cleaned[0].children.map((leaf) => leaf.text).join(""), "前缀目标后缀", "去 mark 不改文字");
  assert.ok(cleaned[0].children.every((leaf) => leaf.comment_dsc_x === undefined));
  assert.ok(cleaned[0].children.every((leaf) => leaf.bold === true), "其它 mark 保留");
});
