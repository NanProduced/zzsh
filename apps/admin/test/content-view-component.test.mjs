import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";
import { DEFAULT_GUIDES, DEFAULT_RESOURCES, RESOURCE_DEFINITIONS, RESOURCE_SCHEMA } from "@zzsh/content";

const PLATFORM_PERMS = ["content.platform.read", "content.platform.edit", "content.platform.publish"];

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function router(handlers) {
  return (url, init) => {
    const method = init.method ?? "GET";
    const entry = handlers.find((h) => (h.method ?? "GET") === method && (h.match instanceof RegExp ? h.match.test(url.pathname) : url.pathname === h.match));
    if (!entry) throw new Error(`unexpected test request ${method} ${url.pathname}${url.search}`);
    return entry.response(url, init);
  };
}

const version = (over = {}) => ({
  id: "ver_1",
  itemId: "item_ann_1",
  sequence: 1,
  state: "PUBLISHED",
  revision: "rev_v1",
  title: "十月例行维护公告",
  summary: "例行维护摘要",
  body: "维护正文",
  coverMediaId: null,
  publishedAt: "2026-10-14T02:00:00.000Z",
  updatedAt: "2026-10-14T02:00:00.000Z",
  createdAt: "2026-10-14T02:00:00.000Z",
  ...over,
});

const itemRow = (over = {}) => {
  const published = version({ id: "ver_pub", sequence: 1, state: "PUBLISHED", title: "十月例行维护公告", revision: "rev_pub" });
  return {
    id: "item_ann_1",
    type: "ANNOUNCEMENT",
    gameId: null,
    gameName: null,
    sortOrder: 10,
    revision: "rev_item",
    createdAt: "2026-10-14T01:00:00.000Z",
    updatedAt: "2026-10-14T02:00:00.000Z",
    draft: null,
    published,
    latest: published,
    ...over,
  };
};
const itemsPage = (items, nextCursor = null) => ({ items, nextCursor, limit: 20 });

const draftVersion = version({ id: "ver_d2", itemId: "item_ann_2", sequence: 1, state: "DRAFT", title: "停服扩容草稿", revision: "rev_d2", publishedAt: null });
const draftOnlyItem = itemRow({ id: "item_ann_2", sortOrder: 5, published: null, draft: draftVersion, latest: draftVersion });

const carouselRow = (over = {}) => ({
  id: "car_1",
  slotCode: "HOME_HERO",
  mediaId: "media_c1",
  imageAlt: "国庆主视觉",
  title: "国庆活动",
  description: "活动说明",
  linkUrl: "/accounts",
  enabled: true,
  sortOrder: 1,
  startsAt: null,
  endsAt: null,
  revision: "rev_c1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  mediaReviewState: "APPROVED",
  mediaAccessClass: "PUBLIC_DISPLAY",
  ...over,
});
const carouselPage = (items, nextCursor = null) => ({ items, nextCursor, limit: 20 });

const mediaRow = (over = {}) => ({
  id: "media_m1",
  mime: "image/png",
  byteSize: "2048",
  width: 800,
  height: 450,
  reviewState: "PENDING",
  accessClass: "PRIVATE_REVIEW",
  reviewReason: null,
  updatedAt: "2026-10-15T02:00:00.000Z",
  ...over,
});
const mediaPage = (items, nextCursor = null) => ({ items, nextCursor, limit: 20 });
const mediaOption = (over = {}) => ({ id: "media_opt_1", mime: "image/png", width: 640, height: 320, byteSize: "1024", ...over });
const optionsPage = (items, nextCursor = null) => ({ items, nextCursor, limit: 20 });

const snapshot = (permissions) => ({
  authenticated: true,
  adminUserId: "admin_content",
  user: { name: "内容管理员", username: "admin_content", displayUsername: "内容管理员", twoFactorEnabled: false },
  security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
  session: { id: "sess_1", locked: false, pinConfigured: false, createdAt: null, expiresAt: null },
  permissions,
});

async function mountHarness(t, { fetchImpl, perms }) {
  const browser = new Window({ url: "http://127.0.0.1:3101/content" });
  browser.Element.prototype.scrollIntoView = function () {};
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  });
  for (const key of ["Element", "SVGElement", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement", "DocumentFragment", "MouseEvent", "KeyboardEvent", "FocusEvent", "MutationObserver", "ResizeObserver"]) {
    if (browser[key]) globalThis[key] = browser[key];
  }
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  Object.defineProperty(browser.navigator, "locks", { value: { request: async (name, _options, callback) => callback({ name }) }, configurable: true });
  const originalFetch = globalThis.fetch;
  const writes = [];
  const gets = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      let parsed = null;
      try {
        parsed = typeof init.body === "string" ? JSON.parse(init.body) : null;
      } catch {
        parsed = null;
      }
      writes.push({ path: url.pathname, method, body: parsed, key: new Headers(init.headers).get("idempotency-key") });
    } else {
      gets.push({ path: url.pathname, query: url.search });
    }
    return fetchImpl(url, init, browser);
  };
  const source = await createOfflineAdminSource({ root: fileURLToPath(new URL("../../../", import.meta.url)) });
  const { ContentView } = await source.ssrLoadModule("/apps/admin/src/views/content-view.tsx");
  const el = browser.document.createElement("div");
  el.className = "workspace-root";
  browser.document.body.append(el);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(el);
  const dirtyLog = [];
  const queryLog = [];
  const render = async (nonce = 0, nextPerms = perms, query = { tab: perms.includes("content.platform.read") ? "announcement" : "news" }) =>
    act(async () => {
      root.render(
        createElement(ContentView, {
          key: nextPerms.join(","),
          snapshot: snapshot(nextPerms),
          onDirtyChange: (dirty) => dirtyLog.push(dirty),
          refreshNonce: nonce,
          tab: { id: "content", title: "内容管理", path: "/content", query, closable: true, kind: "content" },
          onQueryChange: (next) => queryLog.push(next),
        }),
      );
    });
  await render();
  const settle = async (ms = 25) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  await settle();
  const click = async (node) => {
    assert.ok(node, "expected clickable node");
    await act(async () => {
      node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const btn = (name, scope = el) => [...scope.querySelectorAll("button")].find((x) => x.textContent.trim() === name);
  const textOf = (scope = el) => scope.textContent;
  const cleanup = async () => {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await source.close();
    await browser.happyDOM.abort();
  };
  t.after(cleanup);
  return { browser, el, root, source, render, settle, click, btn, textOf, gets, writes, dirtyLog, queryLog };
}

async function mountWithdrawalEditor(t, { holdSort = false } = {}) {
  let releaseSort;
  const sortResult = new Promise(resolve => { releaseSort = resolve; });
  const h = await mountHarness(t, {
    perms: PLATFORM_PERMS,
    fetchImpl: router([
      { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
      { method: "POST", match: /^\/api\/bff\/admin\/content\/items\/[^/]+\/withdraw$/, response: () => json({ withdrawn: true }) },
      { method: "PUT", match: "/api/bff/admin/content/items/item_ann_1", response: () => holdSort ? sortResult : json({ saved: true }) },
    ]),
  });
  for (const name of ["alert", "confirm", "prompt"]) h.browser[name] = () => { throw Error("NATIVE_DIALOG_PROHIBITED"); };
  const { ItemEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-item-editor.tsx");
  let changed = 0;
  const item = itemRow(), props = { detail: { item, versions: [item.published] }, games: [], canEdit: true, canPublish: true, mediaReadable: false, onClose() {}, onChanged: async () => { changed++; }, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) };
  const renderEditor = async overrides => { Object.assign(props, overrides); await act(async () => h.root.render(createElement(ItemEditor, props))); await h.settle(); };
  await renderEditor({});
  return { ...h, item, renderEditor, releaseSort: () => releaseSort(json({ saved: true })), get changed() { return changed; } };
}

for (const boundary of ["item", "published", "revision"]) {
  test(`withdraw confirmation is invalidated when ${boundary} changes instead of withdrawing the replacement`, async t => {
    const h = await mountWithdrawalEditor(t); await h.click(h.btn("撤回线上版本")); assert.ok(h.btn("确定撤回"));
    const replacement = boundary === "item" ? itemRow({ id: "item_other", revision: "rev_other", published: version({ id: "ver_other", itemId: "item_other" }) })
      : boundary === "published" ? itemRow({ published: version({ id: "ver_replacement", sequence: 2 }) })
      : itemRow({ revision: "rev_item_changed" });
    await h.renderEditor({ detail: { item: replacement, versions: [replacement.published] } });
    const confirm = h.btn("确定撤回"); if (confirm) await h.click(confirm);
    assert.equal(h.writes.filter(w => w.path.endsWith("/withdraw")).length, 0, "old consent cannot authorize a new target or revision");
  });
}

test("withdraw uses the unified alert dialog, cancel keeps content and normal double confirmation sends one original CAS payload", async t => {
  const h = await mountWithdrawalEditor(t); await h.click(h.btn("撤回线上版本"));
  assert.ok(h.browser.document.querySelector('[role="alertdialog"]'));
  assert.equal(h.browser.document.activeElement?.textContent.trim(), "取消");
  await h.click(h.btn("取消")); assert.equal(h.writes.length, 0);
  await h.click(h.btn("撤回线上版本")); const confirm = h.btn("确定撤回");
  await act(async () => { for (let i = 0; i < 2; i++) confirm.dispatchEvent(new h.browser.MouseEvent("click", { bubbles: true, cancelable: true })); }); await h.settle();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].path, "/api/bff/admin/content/items/item_ann_1/withdraw");
  assert.equal(h.writes[0].method, "POST"); assert.deepEqual(h.writes[0].body, { versionId: "ver_pub", expectedRevision: "rev_item" }); assert.equal(h.changed, 1);
});

test("publish permission loss clears a pending withdrawal before any request", async t => {
  const h = await mountWithdrawalEditor(t); await h.click(h.btn("撤回线上版本"));
  await h.renderEditor({ canPublish: false }); const confirm = h.btn("确定撤回"); if (confirm) await h.click(confirm);
  assert.equal(h.writes.filter(w => w.path.endsWith("/withdraw")).length, 0); assert.equal(h.changed, 0);
});

test("a save becoming busy cancels pending withdrawal rather than running two commands", async t => {
  const h = await mountWithdrawalEditor(t, { holdSort: true }); await h.click(h.btn("撤回线上版本"));
  await h.click(h.btn("保存排序")); const confirm = h.btn("确定撤回"); if (confirm) await h.click(confirm);
  assert.equal(h.writes.filter(w => w.path.endsWith("/withdraw")).length, 0); assert.equal(h.writes.length, 1);
  h.releaseSort(); await h.settle();
});

test("unmounting an editor with pending withdrawal never sends the command", async t => {
  const h = await mountWithdrawalEditor(t); await h.click(h.btn("撤回线上版本"));
  await act(async () => h.root.unmount()); await h.settle(); assert.equal(h.writes.length, 0); assert.equal(h.changed, 0);
});

test("公告 tab：请求 scope=platform&type=ANNOUNCEMENT&limit=20；渲染标题与状态；loading、空态、错误后重试", async (t) => {
  let listCalls = 0;
  let releaseList;
  const listGate = new Promise((resolve) => {
    releaseList = resolve;
  });
  const h = await mountHarness(t, {
    perms: PLATFORM_PERMS,
    fetchImpl: router([
      {
        match: "/api/bff/admin/content/items",
        response: () => {
          listCalls += 1;
          if (listCalls === 1) return listGate.then(() => json(itemsPage([itemRow(), draftOnlyItem])));
          if (listCalls === 2) return json(itemsPage([]));
          if (listCalls === 3) return json({ error: { code: "INTERNAL_ERROR" } }, 500);
          return json(itemsPage([itemRow()]));
        },
      },
    ]),
  });
  assert.ok(h.textOf().includes("加载中…"), "首次渲染显示 loading");
  const first = h.gets.find((g) => g.path === "/api/bff/admin/content/items");
  assert.ok(first, "挂载后请求内容列表");
  const params = new URLSearchParams(first.query);
  assert.equal(params.get("scope"), "platform");
  assert.equal(params.get("type"), "ANNOUNCEMENT");
  assert.equal(params.get("limit"), "20");
  await act(async () => {
    releaseList();
  });
  await h.settle();
  assert.ok(!h.textOf().includes("加载中…"), "加载完成后移除 loading");
  const rows = [...h.el.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 2, "渲染两条公告");
  assert.ok(rows[0].textContent.includes("十月例行维护公告"), "已发布公告标题");
  assert.ok(rows[0].textContent.includes("已发布"), "已发布状态标签");
  assert.ok(rows[0].textContent.includes("平台"), "平台范围列");
  assert.equal(rows[0].querySelector("button").textContent.trim(), "编辑", "有编辑权显示编辑入口");
  assert.ok(rows[1].textContent.includes("停服扩容草稿"), "草稿公告标题");
  assert.ok(rows[1].textContent.includes("草稿"), "草稿状态标签");
  assert.ok(h.btn("下一页").disabled, "无 nextCursor 时下一页禁用");

  await h.render(1);
  await h.settle();
  assert.ok(h.textOf().includes("当前筛选下没有内容。"), "空列表提示");

  await h.render(2);
  await h.settle();
  assert.ok(h.textOf().includes("服务暂时无法完成请求"), "列表错误提示");
  assert.ok(h.el.querySelector('[role="alert"]'), "错误以 alert 呈现");

  await h.render(3);
  await h.settle();
  assert.ok(h.textOf().includes("十月例行维护公告"), "重试后恢复内容");
  assert.ok(!h.textOf().includes("服务暂时无法完成请求"), "重试成功后错误清除");
  assert.equal(h.writes.length, 0, "读取流程无写请求");
});

test("新建公告和资讯标题由可见原生标签关联，读取不发出写请求", async (t) => {
  const h = await mountHarness(t, {
    perms: PLATFORM_PERMS,
    fetchImpl: router([
      { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    ]),
  });
  for (const [tab, title] of [["announcement", "公告"], ["news", "资讯"]]) {
    await h.render(1, PLATFORM_PERMS, { tab });
    await h.settle();
    await h.click(h.btn(`新建${title}`));
    const label = [...h.el.querySelectorAll("label")].find(node => node.textContent.trim() === `新建${title}标题（可留空后编辑）`);
    assert.ok(label, "新建对话框包含标题字段");
    const input = label.control;
    assert.ok(input);
    assert.equal(input.labels.length, 1, "原生 label 隐式关联输入框");
    assert.equal(label.control, input);
    assert.equal(label.closest('[aria-hidden="true"], [hidden]'), null);
    assert.equal(input.disabled, false);
    await h.click(h.btn("取消"));
  }
  assert.equal(h.writes.length, 0);
});

test("详情：点击条目请求 /content/items/:id；渲染版本历史与操作；详情失败显示错误", async (t) => {
  let detailCalls = 0;
  let releaseDetail;
  const detailGate = new Promise((resolve) => {
    releaseDetail = resolve;
  });
  const pub1 = version({ id: "ver_pub", sequence: 1, state: "PUBLISHED", title: "十月例行维护公告", revision: "rev_pub", publishedAt: "2026-10-14T02:00:00.000Z" });
  const dra2 = version({ id: "ver_dra", sequence: 2, state: "DRAFT", title: "十月例行维护公告（更新）", revision: "rev_dra", publishedAt: null });
  const item = itemRow({ draft: dra2, published: pub1, latest: dra2 });
  const detail = { item, versions: [dra2, pub1] };
  const h = await mountHarness(t, {
    perms: PLATFORM_PERMS,
    fetchImpl: router([
      { match: "/api/bff/admin/content/items", response: () => json(itemsPage([item])) },
      {
        match: /^\/api\/bff\/admin\/content\/items\/[^/]+$/,
        response: () => {
          detailCalls += 1;
          if (detailCalls === 1) return detailGate.then(() => json(detail));
          return json({ error: { code: "INTERNAL_ERROR" } }, 500);
        },
      },
    ]),
  });
  assert.ok(h.textOf().includes("十月例行维护公告"));
  await h.click(h.btn("编辑"));
  assert.ok(h.textOf().includes("加载内容详情…"), "详情加载中提示");
  await act(async () => {
    releaseDetail();
  });
  await h.settle();
  const detailGet = h.gets.find((g) => g.path.startsWith("/api/bff/admin/content/items/"));
  assert.equal(detailGet.path, "/api/bff/admin/content/items/item_ann_1", "详情请求路径");
  assert.ok(h.textOf().includes("公告编辑"), "编辑器标题");
  assert.ok(h.textOf().includes("平台级 · item_ann_1"), "编辑器范围与对象");
  assert.ok(h.textOf().includes("线上 v1") && h.textOf().includes("发布"), "线上版本与发布时间");
  assert.ok(h.textOf().includes("草稿 v2"), "草稿版本");
  assert.ok(h.textOf().includes("版本历史（2）"), "版本历史条数");
  const versionRows = [...h.el.querySelectorAll("details tbody tr")];
  assert.equal(versionRows.length, 2, "渲染两条版本");
  assert.ok(versionRows[0].textContent.includes("v2") && versionRows[0].textContent.includes("草稿") && versionRows[0].textContent.includes("十月例行维护公告（更新）"), "草稿版本行");
  assert.ok(versionRows[1].textContent.includes("v1") && versionRows[1].textContent.includes("线上") && versionRows[1].textContent.includes("rev_pub"), "线上版本行");
  assert.ok(h.btn("保存草稿") && h.btn("发布草稿 v2") && h.btn("撤回线上版本"), "草稿与发布操作可用");

  await h.click(h.btn("刷新详情"));
  await h.settle();
  assert.ok(!h.textOf().includes("加载内容详情…"), "详情加载提示已结束");
  assert.ok(h.textOf().includes("服务暂时无法完成请求"), "详情失败显示错误");
  assert.ok(h.textOf().includes("公告编辑"), "失败时保留已打开的编辑器");
  assert.equal(h.writes.length, 0, "查看流程无写请求");
});

test("页面展示按固定位置管理轮播，读取不调用旧轮播写入口", async (t) => {
  let carouselCalls = 0;
  const h = await mountHarness(t, {
    perms: PLATFORM_PERMS,
    fetchImpl: router([
      {
        match: "/api/bff/admin/content/resources",
        response: () => {
          carouselCalls += 1;
          if (carouselCalls === 1) {
            return json({ items: [{ current: { schema: "content-resource.v1", key: "placement:HOME_HERO", source: "LEGACY", state: "available", payload: { kind: "carousel", title: "首页轮播", slides: [] }, media: [] }, definition: { key: "placement:HOME_HERO", label: "首页轮播", kind: "carousel", locations: ["首页 · 中央轮播"], group: "site" }, metadata: null }], nextCursor: null, limit: 10 });
          }
          return json({ items: [], nextCursor: null, limit: 10 });
        },
      },
    ]),
  });
  await h.click(h.btn("图片与二维码"));
  const get = h.gets.find((g) => g.path === "/api/bff/admin/content/resources");
  assert.ok(get, "请求资源位置列表");
  const params = new URLSearchParams(get.query);
  assert.equal(params.get("scope"), "platform");
  assert.equal(params.get("limit"), "5");
  const rows = [...h.el.querySelectorAll(".content-resource-row")];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].textContent.includes("首页轮播") && rows[0].textContent.includes("沿用原轮播"));
  assert.ok(h.btn("更换图片"));

  await h.render(1, PLATFORM_PERMS, { tab: "pages" });
  await h.settle();
  assert.ok(h.textOf().includes("当前范围没有内容"));
  assert.equal(h.writes.length, 0, "轮播查看流程无写请求");
});

test("媒体 tab：请求 limit=20 渲染审核状态；封面选择器请求 /content/media-options 并渲染候选", async (t) => {
  const state = { mediaCalls: 0 };
  const h = await mountHarness(t, {
    perms: PLATFORM_PERMS,
    fetchImpl: router([
      {
        match: "/api/bff/admin/content/media",
        response: () => {
          state.mediaCalls += 1;
          if (state.mediaCalls === 1) {
            return json(mediaPage([mediaRow(), mediaRow({ id: "media_m2", reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY", byteSize: "4096", width: 1200, height: 600 })]));
          }
          return json(mediaPage([]));
        },
      },
      { match: "/api/bff/admin/content/items", response: () => json(itemsPage([itemRow()])) },
      { match: /^\/api\/bff\/admin\/content\/items\/[^/]+$/, response: () => json({ item: itemRow({ draft: version({ id: "picker_draft", state: "DRAFT", publishedAt: null }) }), versions: [] }) },
      { match: "/api/bff/admin/content/media-options", response: () => json(optionsPage([mediaOption(), mediaOption({ id: "media_opt_2" })])) },
    ]),
  });
  await h.click(h.btn("运营素材"));
  const get = h.gets.find((g) => g.path === "/api/bff/admin/content/media");
  assert.ok(get, "请求平台素材列表");
  assert.equal(new URLSearchParams(get.query).get("limit"), "20");
  const rows = [...h.el.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 2, "渲染两条素材");
  assert.ok(rows[0].textContent.includes("800×450 · 2048B"), "尺寸与字节数");
  assert.ok(rows[0].textContent.includes("待审核 · 私有"), "待审核私有状态");
  assert.ok(rows[1].textContent.includes("1200×600 · 4096B"), "第二条尺寸");
  assert.ok(rows[1].textContent.includes("已通过 · 公开"), "已通过公开状态");
  assert.ok(h.btn("处理"), "处理入口");
  assert.ok(h.textOf().includes("2 条"), "本页条数");
  await h.click(h.btn("处理"));
  const reviewDialog = h.browser.document.querySelector('[role="dialog"]');
  assert.ok(reviewDialog, "处理打开弹窗");
  assert.ok(reviewDialog.textContent.includes("处理素材"), "处理弹窗内容");
  const closeReview = [...h.browser.document.querySelectorAll("button")].find((node) => node.textContent.trim() === "关闭");
  await h.click(closeReview);

  await h.render(1, PLATFORM_PERMS, { tab: "media" });
  await h.settle();
  assert.ok(h.textOf().includes("还没有素材"), "空素材提示");
  assert.ok(h.textOf().includes("0 条"), "空态条数");

  await h.click(h.btn("平台公告"));
  await h.click(h.btn("编辑"));
  const optionsBefore = h.gets.filter((g) => g.path === "/api/bff/admin/content/media-options").length;
  await h.click(h.btn("选择封面"));
  const optionGets = h.gets.filter((g) => g.path === "/api/bff/admin/content/media-options");
  assert.equal(optionGets.length, optionsBefore + 1, "打开选择器请求候选素材");
  const optionParams = new URLSearchParams(optionGets.at(-1).query);
  assert.equal(optionParams.get("limit"), "20", "候选素材带 limit");
  assert.equal(optionParams.get("purpose"), null, "当前实现不带 purpose 参数");
  assert.ok(h.btn("media_opt_1") && h.btn("media_opt_2"), "渲染候选素材");
  assert.ok(h.el.querySelector('img[alt="素材 media_opt_1"]'), "候选素材预览图");
  assert.equal(h.writes.length, 0, "素材查看与选择器流程无写请求");
});

test("无 content 读权限：显示受限说明、不渲染 tab、无列表读写请求", async (t) => {
  const h = await mountHarness(t, {
    perms: ["admin.account.read"],
    fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]),
  });
  assert.ok(h.textOf().includes("当前账号没有内容管理权限。"), "受限说明");
  assert.ok(h.textOf().includes("平台级内容与游戏级内容需要不同的动态操作权限。"), "受限说明补充");
  assert.ok(h.el.querySelector('[role="alert"]'), "受限说明以 alert 呈现");
  assert.equal(h.el.querySelectorAll('[role="tab"]').length, 0, "不渲染内容 tab");
  assert.equal(h.writes.length, 0, "无写请求");
  assert.equal(h.gets.filter((g) => g.path === "/api/bff/admin/content/items").length, 0, "无读权限不发出内容列表读");
});

test("仅有 content.read：news 默认游戏范围，切到游戏范围后按 scope=game 与 gameId 请求", async (t) => {
  const newsVersion = version({ id: "ver_news", itemId: "item_news_1", sequence: 1, state: "PUBLISHED", title: "版本更新资讯", revision: "rev_news" });
  const newsItem = itemRow({ id: "item_news_1", type: "NEWS", gameId: "game_1", gameName: "三角洲行动", published: newsVersion, latest: newsVersion });
  const h = await mountHarness(t, {
    perms: ["content.read"],
    fetchImpl: router([
      { match: "/api/bff/admin/content/games", response: () => json({ games: [{ id: "game_1", code: "delta", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/content/items", response: () => json(itemsPage([newsItem])) },
    ]),
  });
  assert.ok(h.btn("资讯"), "仅资讯 tab 可用");
  assert.ok(!h.btn("平台公告") && !h.btn("页面展示") && !h.btn("运营素材"), "平台级 tab 不渲染");
  assert.ok(h.gets.some((g) => g.path === "/api/bff/admin/content/games"), "加载游戏范围");
  const first = h.gets.find((g) => g.path === "/api/bff/admin/content/items");
  assert.ok(first, "游戏范围就绪后请求列表");
  assert.equal(new URLSearchParams(first.query).get("scope"), "game", "仅游戏内容权限时首个请求即游戏范围（ADM-R1-02）");
  assert.equal(new URLSearchParams(first.query).get("type"), "NEWS", "首个请求为资讯");
  assert.equal(new URLSearchParams(first.query).get("gameId"), "game_1", "首个请求带对象范围");
  assert.equal(h.gets.some((g) => g.path === "/api/bff/admin/content/items" && g.query.includes("ANNOUNCEMENT")), false, "不先请求平台公告");
  const scopeSelect = h.el.querySelector('[aria-label="资讯范围"]');
  assert.ok(scopeSelect, "渲染资讯范围选择器");
  assert.ok(scopeSelect.textContent.includes("游戏资讯"), "仅游戏权限默认显示游戏资讯");
  assert.ok(!scopeSelect.textContent.includes("平台资讯"), "无平台资讯选项");
  const get = h.gets.filter((g) => g.path === "/api/bff/admin/content/items").at(-1);
  const params = new URLSearchParams(get.query);
  assert.equal(params.get("scope"), "game");
  assert.equal(params.get("type"), "NEWS");
  assert.equal(params.get("limit"), "20");
  assert.equal(params.get("gameId"), "game_1", "带对象范围 gameId");
  const rows = [...h.el.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 1, "渲染一条资讯");
  assert.ok(rows[0].textContent.includes("版本更新资讯"), "资讯标题");
  assert.ok(rows[0].textContent.includes("三角洲行动"), "范围列显示游戏名");
  assert.equal(rows[0].querySelector("button").textContent.trim(), "查看", "无编辑权显示查看入口");
  assert.equal(h.writes.length, 0, "读取流程无写请求");
});

test("页内分区与资讯范围写入地址栏：刷新恢复分区，秘密与筛选草稿不落 URL", async (t) => {
  const newsVersion = version({ id: "ver_news", itemId: "item_news_1", sequence: 1, state: "PUBLISHED", title: "版本更新资讯", revision: "rev_news" });
  const newsItem = itemRow({ id: "item_news_1", type: "NEWS", gameId: "game_1", gameName: "三角洲行动", published: newsVersion, latest: newsVersion });
  // 同时持有平台与游戏内容读权限，才可能切换到游戏资讯范围（仅平台权限时不提供该范围，见 ADM-R1-02）。
  const BOTH_CONTENT_PERMS = [...PLATFORM_PERMS, "content.read"];
  const h = await mountHarness(t, {
    perms: BOTH_CONTENT_PERMS,
    fetchImpl: router([
      { match: "/api/bff/admin/content/games", response: () => json({ games: [{ id: "game_1", code: "delta", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/content/items", response: () => json(itemsPage([newsItem])) },
    ]),
  });
  // ADM-R1-01：地址无 query 时首屏默认分区最多写一次，之后不得重复回写。
  await h.settle();
  await h.settle();
  assert.deepEqual(h.queryLog, [], "地址已指定分区时不重复回写");
  await h.click(h.btn("资讯"));
  await h.settle();
  assert.deepEqual(h.queryLog.at(-1), { tab: "news", scope: "platform" }, "分区与范围写入地址栏");
  await h.settle();
  assert.equal(h.queryLog.length, 1, "切换分区只产生一次回写");
  assert.ok(!Object.keys(h.queryLog.at(-1)).some((key) => /password|pin|otp|phone|token|secret/i.test(key)), "敏感键不落 URL");
  await h.render(0, BOTH_CONTENT_PERMS, { tab: "media" });
  assert.ok(h.btn("运营素材"), "按地址栏 tab 恢复分区");
  await h.render(0, BOTH_CONTENT_PERMS, { tab: "news", scope: "game", gameId: "game_1" });
  const get = h.gets.filter((g) => g.path === "/api/bff/admin/content/items").at(-1);
  const params = new URLSearchParams(get.query);
  assert.equal(params.get("scope"), "game", "按地址栏恢复资讯范围");
  assert.equal(params.get("gameId"), "game_1", "按地址栏恢复游戏范围");
  assert.equal(h.writes.length, 0, "恢复分区无写请求");
});

test("resource draft keeps its original key after an unknown result and recovers through a read-only receipt", async t => {
  const { format: _format, markdown: _markdown, mediaIds: _mediaIds, anchorAliases: _anchorAliases, ...guideMetadata } = DEFAULT_GUIDES[0];
  const payload = { ...guideMetadata, sections: [{ id: "overview", title: "核对", blocks: [{ type: "paragraph", text: "<script>作为文字</script>" }] }] };
  const resourceId = `guide:${payload.slug}`;
  const current = { schema: RESOURCE_SCHEMA, key: resourceId, source: "BUILTIN", state: "available", payload, media: [] };
  const definition = { key: resourceId, kind: "guide", label: payload.title, group: "help", locations: [`/help/${payload.slug}`] };
  let hasDraft = false;
  const detail = () => ({ key: resourceId, definition, item: hasDraft ? { id: "item_resource", revision: "1", gameId: null } : null, draft: hasDraft ? { id: "draft_resource", revision: "1", sequence: 1, state: "DRAFT", payload } : null, published: null, current, baseline: payload, versions: [] });
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { match: "/api/bff/admin/content/resources", response: () => json({ items: [{ current, definition, metadata: null }], nextCursor: null, limit: 10 }) },
    { match: `/api/bff/admin/content/resources/${encodeURIComponent(resourceId)}`, response: () => json(detail()) },
    { method: "POST", match: `/api/bff/admin/content/resources/${encodeURIComponent(resourceId)}/draft`, response: () => { hasDraft = true; return json({ error: { code: "INTERNAL_ERROR" } }, 503); } },
    { match: "/api/bff/admin/content/operation-result", response: () => json({ receipt: "RECORDED", operation: "content.resource.draft.create", resourceId, responseStatus: 200, result: { itemId: "item_resource" } }) },
  ]) });
  await h.click(h.btn("规则与手册")); await h.click(h.btn("编辑文档"));
  assert.equal(h.btn("创建编辑草稿"), undefined, "working copy does not require an empty draft action");
  const titleLabel = [...h.el.querySelectorAll("label")].find(node => node.textContent === "文档标题");
  assert.ok(titleLabel);
  const titleInput = h.browser.document.getElementById(titleLabel.htmlFor);
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, "value").set; setter.call(titleInput, "核对后修改的标题"); titleInput.dispatchEvent(new h.browser.Event("input", { bubbles: true })); });
  await h.settle();
  await h.click(h.btn("保存草稿")); await h.settle(50);
  assert.ok(h.textOf().includes("请求结果尚未确认"));
  const original = h.writes[0]; assert.match(original.key, /^idem_/);
  const raw = h.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_content");
  assert.equal(JSON.parse(raw).key, original.key); assert.ok(!raw.includes("<script>") && !raw.includes("sections"), "article bodies are not persisted in recovery metadata");
  await h.click(h.btn("核对原操作结果"));
  assert.equal(h.writes.length, 1, "recovery never resubmits the write");
  assert.equal(h.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_content"), null);
  assert.ok(h.textOf().includes("已核实原操作记录"));
  const recoveredTitle = [...h.el.querySelectorAll("label")].find(node => node.textContent === "文档标题");
  assert.equal(h.browser.document.getElementById(recoveredTitle.htmlFor).value, "核对后修改的标题", "draft-create recovery preserves the unsaved working copy");
  assert.ok(h.btn("发布到用户页面").disabled, "unsaved working copy cannot publish the old draft");
  assert.equal(h.el.querySelectorAll("script").length, 0); assert.ok(h.textOf().includes("<script>作为文字</script>"));
});

test("QR replacement cancels before submit, freezes cancel while saving, and publishes only media fields", async t => {
  const key = "placement:FOLLOW", definition = RESOURCE_DEFINITIONS.find(row => row.key === key);
  const before = { ...DEFAULT_RESOURCES[key], qrMediaId: "media_before" }, after = { ...before, qrMediaId: "media_after" };
  let revision = "1", draft = null, publishedPayload = before, finishSave;
  const current = () => ({ schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: "available", payload: publishedPayload, media: [{ id: publishedPayload.qrMediaId, url: "/public-qr" }] });
  const resource = () => ({ key, definition, item: { id: "item_follow", revision, gameId: null }, draft, published: { id: "published_1", sequence: 1, state: "PUBLISHED", payload: publishedPayload }, versions: [], current: current(), baseline: before });
  const saved = new Promise(resolve => { finishSave = resolve; });
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { match: "/api/bff/admin/content/resources", response: () => json({ items: [{ current: current(), definition, metadata: { itemId: "item_follow", revision, updatedAt: "2026-10-28", hasDraft: Boolean(draft) } }], nextCursor: null, limit: 10 }) },
    { match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}`, response: () => json(resource()) },
    { match: "/api/bff/admin/content/media-options", response: () => json(optionsPage([mediaOption({ id: "media_after", width: 512, height: 512 })])) },
    { method: "POST", match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}/draft`, response: () => { draft = { id: "draft_1", sequence: 2, state: "DRAFT", payload: before }; return json(resource()); } },
    { method: "PUT", match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}/media-draft`, response: () => saved },
    { method: "POST", match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}/publish`, response: () => { publishedPayload = after; draft = null; revision = "3"; return json(resource()); } },
  ]) });
  await h.click(h.btn("图片与二维码")); await h.click(h.btn("更换二维码"));
  assert.ok(h.browser.document.querySelector('[role="dialog"]'), "图片替换使用弹窗而非抽屉");
  await h.click(h.btn("选择图片"));
  const choose = () => [...h.el.querySelectorAll("button")].find(node => node.textContent.includes("512 × 512"));
  await h.click(choose()); await h.click(h.btn("取消更换")); await h.click(h.btn("放弃修改并继续"));
  assert.equal(h.writes.length, 0, "cancel before submit does not create or bind anything");
  await h.click(h.btn("更换二维码")); await h.click(h.btn("选择图片")); await h.click(choose());
  await h.click(h.btn("保存图片草稿")); await h.settle(40);
  assert.equal(h.writes.length, 2); assert.ok(h.btn("取消更换").disabled, "sent save cannot be presented as cancelled");
  assert.deepEqual(h.writes[1].body, { media: { qrMediaId: "media_after" }, versionId: "draft_1", expectedRevision: "1" });
  await h.click(h.btn("取消更换")); assert.equal(publishedPayload.qrMediaId, "media_before");
  draft = { id: "draft_1", sequence: 2, state: "DRAFT", payload: after }; revision = "2";
  await act(async () => { finishSave(json(resource())); }); await h.settle(40);
  assert.equal(publishedPayload.qrMediaId, "media_before", "saving draft leaves the public binding unchanged");
  assert.ok(!h.btn("发布图片").disabled); await h.click(h.btn("发布图片"));
  assert.equal(publishedPayload.qrMediaId, "media_after"); assert.equal(h.writes.length, 3);
  assert.equal(publishedPayload.title, before.title); assert.equal(publishedPayload.description, before.description); assert.equal(publishedPayload.imageAlt, before.imageAlt);
});

test("late resource detail cannot reopen an editor after switching sections", async t => {
  const payload = DEFAULT_GUIDES[0], key = `guide:${payload.slug}`;
  const current = { schema: RESOURCE_SCHEMA, key, source: "BUILTIN", state: "available", payload, media: [] };
  let finishDetail;
  const response = new Promise(resolve => { finishDetail = resolve; });
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { match: "/api/bff/admin/content/resources", response: () => json({ items: [{ current, definition: null, metadata: null }], nextCursor: null, limit: 10 }) },
    { match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}`, response: () => response },
  ]) });
  await h.click(h.btn("规则与手册")); await h.click(h.btn("编辑文档")); await h.click(h.btn("图片与二维码"));
  await act(async () => { finishDetail(json({ key, definition: null, item: null, current, baseline: payload, draft: null, published: null, versions: [] })); }); await h.settle();
  assert.equal(h.el.querySelector('[aria-label="内容编辑器"]'), null);
  assert.ok(h.textOf().includes("用户页面图片")); assert.equal(h.writes.length, 0);
});

test("resource restore confirmation is cleared when edit permission is lost", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]) });
  const { ContentResourceEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-resource-editor.tsx");
  const { format: _format, markdown: _markdown, mediaIds: _mediaIds, anchorAliases: _anchorAliases, ...metadata } = DEFAULT_GUIDES[0];
  const payload = { ...metadata, sections: [{ id: "intro", title: "原格式", blocks: [{ type: "paragraph", text: "保留原文" }] }] }, key = `guide:${payload.slug}`;
  const version = { id: "history_1", state: "SUPERSEDED", sequence: 1, title: payload.title, updatedAt: "2026-10-28T00:00:00Z", payload };
  const detail = { key, definition: null, item: { id: "item_1", revision: "3" }, current: { key, payload, media: [] }, draft: null, published: null, baseline: payload, versions: [version] };
  const writes = [], props = { detail, canEdit: true, canPublish: true, locked: false, onWrite: async (...args) => { writes.push(args); }, onDirtyChange() {}, onClose() {} };
  const render = async extra => { Object.assign(props, extra); await act(async () => h.root.render(createElement(ContentResourceEditor, props))); await h.settle(); };
  await render({}); await h.click(h.btn("恢复为草稿")); assert.ok(h.btn("恢复为新草稿"));
  await render({ canEdit: false, canPublish: false });
  const confirm = h.btn("恢复为新草稿"); if (confirm) { assert.ok(confirm.disabled); await h.click(confirm); }
  assert.equal(writes.length, 0);
});

function legacyHelpPayload(overrides = {}) {
  const { format: _format, markdown: _markdown, mediaIds: _mediaIds, anchorAliases: _anchorAliases, ...metadata } = DEFAULT_GUIDES[0];
  return { ...metadata, sections: [{ id: "intro", title: "说明", blocks: [{ type: "paragraph", text: "原正文" }] }], ...overrides };
}

for (const format of ["blocks", "markdown"]) {
  test(`withdrawn ${format} guide reads its original snapshot and restores a separate draft`, async t => {
    const legacy = legacyHelpPayload({ id: "qa-withdrawn", slug: "qa-withdrawn", title: "撤回后仍可恢复的手册" });
    const { sections: _sections, ...metadata } = legacy;
    const payload = format === "blocks" ? legacy : { ...metadata, format: "markdown", schemaVersion: 1, markdown: "## 说明\n\n原正文", mediaIds: [] };
    const key = `guide:${payload.slug}`, path = `/api/bff/admin/content/resources/${encodeURIComponent(key)}`;
    let withdrawn = false, draft = null, revision = "3", snapshotReads = 0;
    const original = () => ({ id: "original_1", revision: "2", sequence: 1, state: withdrawn ? "WITHDRAWN" : "PUBLISHED", title: payload.title, payload, publishedAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" });
    const current = () => ({ schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: withdrawn ? "withdrawn" : "available", payload: withdrawn ? null : payload, media: [] });
    const detail = () => ({ key, definition: null, item: { id: "guide_item", revision, gameId: null }, current: current(), baseline: null, draft, published: withdrawn ? null : original(), versions: [...(draft ? [{ ...draft, payload: null }] : []), { ...original(), payload: null }] });
    const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
      { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
      { match: "/api/bff/admin/content/resources", response: () => json({ items: [{ current: current(), definition: null, metadata: { title: payload.title, hasDraft: Boolean(draft), revision } }], nextCursor: null, limit: 5 }) },
      { match: path, response: () => json(detail()) },
      { match: `${path}/versions/original_1`, response: () => { snapshotReads++; return json({ version: original(), media: [] }); } },
      { method: "POST", match: `${path}/withdraw`, response: () => { withdrawn = true; revision = "4"; return json(detail()); } },
      { method: "POST", match: `${path}/restore`, response: () => { revision = "5"; draft = { ...original(), id: "restored_2", sequence: 2, state: "DRAFT", publishedAt: null }; return json(detail()); } },
    ]) });
    await h.click(h.btn("规则与手册")); await h.click(h.btn("编辑文档"));
    await h.click(h.btn("撤回线上版本")); await h.click(h.btn("确认撤回")); await h.settle(60);
    assert.equal(snapshotReads, 1, "metadata-only history is hydrated through the existing authorized version endpoint");
    assert.ok(h.el.querySelector('[aria-label="内容编辑器"]'));
    assert.ok(h.textOf().includes("线上内容已撤回") && h.textOf().includes("原正文"));
    assert.ok(!h.textOf().includes("未能读取图片位置") && !h.textOf().includes("当前显示用户侧内容"));
    assert.ok(h.btn("发布到用户页面").disabled, "reading a historical version cannot publish it directly");
    assert.equal(Boolean(h.btn("转换为 Markdown 后编辑")), format === "blocks", "original format is retained");
    await h.click(h.btn("恢复为草稿")); await h.click(h.btn("恢复为新草稿"));
    assert.deepEqual(h.writes.at(-1).body, { sourceVersionId: "original_1", expectedRevision: "4" });
    assert.ok(!h.btn("发布到用户页面").disabled);
    assert.equal(withdrawn, true, "restoring a draft keeps the public resource withdrawn");
    assert.equal(h.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_content"), null);
    await h.click(h.btn("返回文档列表")); await h.click(h.btn("编辑文档"));
    assert.equal(snapshotReads, 1, "an active draft needs no historical fallback request");
  });
}

test("withdrawn snapshot read failure keeps the completed withdrawal known and can be reopened", async t => {
  const payload = legacyHelpPayload(), key = `guide:${payload.slug}`, path = `/api/bff/admin/content/resources/${encodeURIComponent(key)}`;
  let withdrawn = false, snapshotReads = 0;
  const version = { id: "source_1", revision: "1", sequence: 1, state: "PUBLISHED", title: payload.title, payload, publishedAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
  const current = () => ({ schema: RESOURCE_SCHEMA, key, state: withdrawn ? "withdrawn" : "available", payload: withdrawn ? null : payload, media: [] });
  const detail = () => ({ key, definition: null, item: { id: "guide_item", revision: "3" }, current: current(), baseline: null, draft: null, published: withdrawn ? null : version, versions: [{ ...version, state: withdrawn ? "WITHDRAWN" : "PUBLISHED", payload: null }] });
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { match: "/api/bff/admin/content/resources", response: () => json({ items: [{ current: current(), definition: null, metadata: { title: payload.title } }], nextCursor: null, limit: 5 }) },
    { match: path, response: () => json(detail()) },
    { match: `${path}/versions/source_1`, response: () => ++snapshotReads === 1 ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : json({ version: { ...version, state: "WITHDRAWN" }, media: [] }) },
    { method: "POST", match: `${path}/withdraw`, response: () => { withdrawn = true; return json(detail()); } },
  ]) });
  await h.click(h.btn("规则与手册")); await h.click(h.btn("编辑文档"));
  await h.click(h.btn("撤回线上版本")); await h.click(h.btn("确认撤回"));
  assert.ok(h.textOf().includes("操作已记录，但正文读取失败"));
  assert.equal(h.writes.length, 1); assert.equal(h.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_content"), null);
  await h.click(h.btn("编辑文档"));
  assert.equal(snapshotReads, 2); assert.ok(h.textOf().includes("原正文"));
  assert.equal(h.writes.length, 1, "retrying a historical read never resends withdrawal");
});

test("read-only withdrawn QR keeps its historical image separate from the public image", async t => {
  const key = "placement:FOLLOW", definition = RESOURCE_DEFINITIONS.find(row => row.key === key);
  const payload = { ...DEFAULT_RESOURCES[key], qrMediaId: "old_qr" }, path = `/api/bff/admin/content/resources/${encodeURIComponent(key)}`;
  const version = { id: "qr_history", revision: "2", sequence: 1, state: "WITHDRAWN", title: payload.title, payload, publishedAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
  const current = { schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: "withdrawn", payload: null, media: [] };
  const detail = { key, definition, item: { id: "qr_item", revision: "3" }, current, baseline: null, draft: null, published: null, versions: [{ ...version, payload: null }] };
  const h = await mountHarness(t, { perms: ["content.platform.read"], fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { match: "/api/bff/admin/content/resources", response: () => json({ items: [{ current, definition, metadata: { title: payload.title } }], nextCursor: null, limit: 5 }) },
    { match: path, response: () => json(detail) },
    { match: `${path}/versions/qr_history`, response: () => json({ version, media: [{ id: "old_qr", url: null }] }) },
  ]) });
  await h.click(h.btn("图片与二维码")); await h.click(h.btn("查看"));
  assert.ok(h.textOf().includes("查看页面图片") && h.textOf().includes("线上图片已撤回"));
  assert.ok(h.textOf().includes("历史版本图片"));
  assert.equal(h.el.querySelector('img[alt="当前用户页面的图片"]'), null);
  assert.equal(h.btn("恢复为草稿"), undefined); assert.equal(h.btn("保存图片草稿"), undefined);
  assert.equal(h.writes.length, 0);
});
async function changeContentTitle(h, value) {
  const label = [...h.el.querySelectorAll("label")].find(node => node.textContent === "文档标题");
  assert.ok(label);
  const input = h.browser.document.getElementById(label.htmlFor);
  await act(async () => { Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new h.browser.Event("input", { bubbles: true })); });
  await h.settle();
}

test("publication settings remain in a draft, use Beijing time and keep ticker independent of pinning", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: '/api/bff/admin/content/items', response: () => json(itemsPage([])) },
    { method: 'PUT', match: '/api/bff/admin/content/items/item_settings/draft', response: () => json({ saved: true }) },
  ]) });
  const { ItemEditor } = await h.source.ssrLoadModule('/apps/admin/src/views/content-item-editor.tsx');
  const draft = version({ id: 'settings_draft', state: 'DRAFT', title: '时效性服务更新', body: '## 更新说明\n\n这里是本地验证正文。', publishedAt: null, updateSettings: { format: 'markdown', tickerEnabled: true } });
  const item = itemRow({ id: 'item_settings', type: 'NEWS', draft, published: null, latest: draft });
  await act(async () => h.root.render(createElement(ItemEditor, { detail: { item, versions: [draft] }, games: [], canEdit: true, canPublish: true, mediaReadable: true, onClose() {}, onChanged: async () => {}, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) })));
  await h.settle(80);
  assert.ok(h.textOf().includes('轮播必须填写结束时间'));
  assert.ok(h.btn('发布草稿 v1').disabled);
  assert.ok(h.textOf().includes('长期指南请用帮助手册'));
  const input = h.el.querySelector('[data-beijing-datetime-input][aria-label^="轮播结束时间"]');
  await act(async () => { Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, 'value').set.call(input, '2030-01-02T12:30'); input.dispatchEvent(new h.browser.Event('input', { bubbles: true })); });
  await h.settle(); await h.click(h.btn('保存草稿'));
  const saved = h.writes.at(-1); assert.equal(saved.method, 'PUT');
  assert.equal(saved.body.updateSettings.tickerUntil, '2030-01-02T04:30:00.000Z');
  assert.equal(saved.body.updateSettings.tickerEnabled, true); assert.equal(saved.body.updateSettings.pinned, false);
  assert.equal(saved.body.versionId, 'settings_draft'); assert.equal(saved.body.expectedRevision, draft.revision);
  assert.equal(h.writes.some(x => x.path.endsWith('/publish')), false);
});

test("a game publisher can save homepage exposure settings but needs platform publication permission to release them", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: '/api/bff/admin/content/items', response: () => json(itemsPage([])) }]) });
  const { ItemEditor } = await h.source.ssrLoadModule('/apps/admin/src/views/content-item-editor.tsx');
  const draft = version({ state: 'DRAFT', publishedAt: null, updateSettings: { format: 'plain', tickerEnabled: true, tickerUntil: '2030-01-01T00:00:00Z' } });
  const item = itemRow({ gameId: 'game_a', type: 'NEWS', draft, published: null, latest: draft });
  const props = { detail: { item, versions: [draft] }, games: [], canEdit: true, canPublish: true, mediaReadable: false, onClose() {}, onChanged: async () => {}, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) };
  await act(async () => h.root.render(createElement(ItemEditor, props))); await h.settle();
  assert.ok(h.textOf().includes('首页曝光需要平台发布权限'));
  assert.ok(h.btn('发布草稿 v1').disabled); assert.ok(!h.btn('保存草稿').disabled);
  await act(async () => h.root.render(createElement(ItemEditor, { ...props, canPublishPlatform: true }))); await h.settle();
  assert.equal(h.textOf().includes('首页曝光需要平台发布权限'), false); assert.ok(!h.btn('发布草稿 v1').disabled);
  assert.equal(h.writes.length, 0);
});

test("unsupported update Markdown can be saved verbatim while the publish action stays unavailable", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: '/api/bff/admin/content/items', response: () => json(itemsPage([])) }, { method: 'PUT', match: '/api/bff/admin/content/items/item_ann_1/draft', response: () => json({ saved: true }) }]) });
  const { ItemEditor } = await h.source.ssrLoadModule('/apps/admin/src/views/content-item-editor.tsx');
  const body = '<div>原文需要保留</div>', draft = version({ state: 'DRAFT', publishedAt: null, body, updateSettings: { format: 'markdown' } }), item = itemRow({ draft, published: null });
  await act(async () => h.root.render(createElement(ItemEditor, { detail: { item, versions: [draft] }, games: [], canEdit: true, canPublish: true, mediaReadable: true, onClose() {}, onChanged: async () => {}, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) })));
  await h.settle(80);
  assert.match(h.textOf(), /HTML/);
  assert.ok(h.btn('发布草稿 v1').disabled); assert.ok(!h.btn('保存草稿').disabled);
  assert.equal(h.el.querySelector('textarea[aria-label="Markdown 正文"]').value, body);
  await h.click(h.btn('保存草稿')); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].body.body, body); assert.ok(h.btn('发布草稿 v1').disabled);
});

test("a published update is read-only until a separate draft is created, so starting edits cannot discard an unsaved working copy", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: '/api/bff/admin/content/items', response: () => json(itemsPage([])) }]) });
  const { ItemEditor } = await h.source.ssrLoadModule('/apps/admin/src/views/content-item-editor.tsx');
  const published = version(), item = itemRow({ published, draft: null });
  await act(async () => h.root.render(createElement(ItemEditor, { detail: { item, versions: [published] }, games: [], canEdit: true, canPublish: true, mediaReadable: true, onClose() {}, onChanged: async () => {}, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) })));
  await h.settle();
  const title = [...h.el.querySelectorAll('label')].find(x => x.textContent.includes('标题（纯文本')).querySelector('input');
  assert.ok(title.disabled); assert.ok(h.el.querySelector('textarea[aria-label="纯文本正文"]').disabled);
  assert.ok(!h.btn('编辑已发布内容（新建草稿）').disabled); assert.ok(!h.btn('保存排序').disabled);
  assert.equal(h.writes.length, 0);
});

test("late game options do not close a platform working copy or strand its save", async t => {
  let finishGames, finishDraft, draft = null, revision = "1";
  const gamesResponse = new Promise(resolve => { finishGames = resolve; }), draftResponse = new Promise(resolve => { finishDraft = resolve; });
  const payload = legacyHelpPayload(), key = `guide:${payload.slug}`;
  const current = { schema: RESOURCE_SCHEMA, key, source: "BUILTIN", state: "available", payload, media: [] };
  const resource = () => ({ key, definition: null, item: draft ? { id: "item_platform", revision, gameId: null } : null, draft, published: null, versions: [], current, baseline: payload });
  const h = await mountHarness(t, { perms: [...PLATFORM_PERMS, "content.read"], fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { match: "/api/bff/admin/content/games", response: () => gamesResponse },
    { match: "/api/bff/admin/content/resources", response: () => json({ items: [{ current, definition: null, metadata: null }], nextCursor: null, limit: 5 }) },
    { match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}`, response: () => json(resource()) },
    { method: "POST", match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}/draft`, response: () => draftResponse },
    { method: "PUT", match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}/draft`, response: (_url, init) => { revision = "2"; draft = { ...draft, revision, payload: JSON.parse(init.body).payload }; return json(resource()); } },
  ]) });
  await h.click(h.btn("规则与手册")); await h.click(h.btn("编辑文档")); await changeContentTitle(h, "保存后的平台标题");
  await h.click(h.btn("保存草稿"));
  const beforeGameResponse = h.gets.filter(row => row.path === "/api/bff/admin/content/resources").length;
  await act(async () => { finishGames(json({ games: [{ id: "game_1", name: "三角洲", code: "delta" }] })); }); await h.settle();
  assert.ok(h.el.querySelector('[aria-label="内容编辑器"]'), "unrelated game options leave the platform editor mounted");
  assert.equal(h.gets.filter(row => row.path === "/api/bff/admin/content/resources").length, beforeGameResponse);
  draft = { id: "draft_platform", revision: "1", sequence: 1, state: "DRAFT", payload };
  await act(async () => { finishDraft(json(resource())); }); await h.settle(60);
  assert.equal(h.writes.length, 2); assert.equal(draft.payload.title, "保存后的平台标题");
  assert.ok(!h.btn("发布到用户页面").disabled);
  assert.equal(h.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_content"), null);
});

test("a completed save releases its own busy token after the selected game changes", async t => {
  let finishSave;
  const saveResponse = new Promise(resolve => { finishSave = resolve; });
  const a = legacyHelpPayload({ id: "QA-A", slug: "qa-scope-a", title: "范围 A" }), b = legacyHelpPayload({ id: "QA-B", slug: "qa-scope-b", title: "范围 B" });
  const publicResource = payload => ({ schema: RESOURCE_SCHEMA, key: `guide:${payload.slug}`, source: "MANAGED", state: "available", payload, media: [] });
  const draft = { id: "draft_a", revision: "1", sequence: 1, state: "DRAFT", payload: a };
  const aDetail = () => ({ key: `guide:${a.slug}`, definition: null, item: { id: "item_a", revision: "1", gameId: "game_a" }, draft, published: null, versions: [], current: publicResource(a), baseline: a });
  const permissions = ["content.read", "content.edit", "content.publish"];
  const h = await mountHarness(t, { perms: permissions, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { match: "/api/bff/admin/content/games", response: () => json({ games: [{ id: "game_a", name: "游戏 A", code: "a" }] }) },
    { match: "/api/bff/admin/content/resources", response: url => json({ items: [{ current: publicResource(url.searchParams.get("gameId") === "game_b" ? b : a), definition: null, metadata: null }], nextCursor: null, limit: 5 }) },
    { match: `/api/bff/admin/content/resources/${encodeURIComponent(`guide:${a.slug}`)}`, response: () => json(aDetail()) },
    { method: "PUT", match: `/api/bff/admin/content/resources/${encodeURIComponent(`guide:${a.slug}`)}/draft`, response: () => saveResponse },
  ]) });
  const { ContentResourcesTab } = await h.source.ssrLoadModule("/apps/admin/src/views/content-resources-tab.tsx");
  const props = { group: "rules", snapshot: snapshot(permissions), games: [{ id: "game_a", name: "游戏 A", code: "a" }], refreshNonce: 0, onDirtyChange() {} };
  const render = async games => { props.games = games; await act(async () => h.root.render(createElement(ContentResourcesTab, props))); await h.settle(); };
  await render(props.games); await h.click(h.btn("编辑文档")); await changeContentTitle(h, "范围 A 的修改"); await h.click(h.btn("保存草稿"));
  await render([{ id: "game_b", name: "游戏 B", code: "b" }]);
  await act(async () => { finishSave(json(aDetail())); }); await h.settle();
  assert.ok(h.textOf().includes("范围 B")); assert.equal(h.el.querySelector('[aria-label="内容编辑器"]'), null);
  assert.ok(!h.btn("编辑文档").disabled, "stale detail is ignored but its completed flow cannot lock the new scope");
  assert.equal(h.writes.length, 1); assert.equal(h.browser.localStorage.getItem("zzsh.admin.content.pending.v1:admin_content"), null);
});

for (const eligibility of ["available", "revoked", "read-failure"]) {
  test(`game publisher checks its own draft media without platform catalog permission: ${eligibility}`, async t => {
    const { sections: _sections, ...metadata } = legacyHelpPayload();
    const payload = { ...metadata, format: "markdown", schemaVersion: 1, markdown: "## 图片说明\n\n![说明](media://qa_media)", mediaIds: ["qa_media"] }, key = `guide:${metadata.slug}`;
    const draft = { id: "draft_game", revision: "7", sequence: 2, state: "DRAFT", payload };
    let versionReads = 0, catalogReads = 0;
    const h = await mountHarness(t, { perms: ["content.read", "content.edit", "content.publish"], fetchImpl: router([
      { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
      { match: "/api/bff/admin/content/games", response: () => json({ games: [{ id: "game_1", name: "三角洲", code: "delta" }] }) },
      { match: "/api/bff/admin/content/media-options", response: () => { catalogReads++; return json({ error: { code: "FORBIDDEN" } }, 403); } },
      { match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}/versions/${draft.id}`, response: () => { versionReads++; return eligibility === "read-failure" && versionReads === 1 ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : json({ version: draft, media: [{ id: "qa_media", url: eligibility === "revoked" ? null : "/api/v1/content/media/qa_media/content" }] }); } },
    ]) });
    const { ContentResourceEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-resource-editor.tsx");
    const current = { schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: "unpublished", payload: null, media: eligibility === "revoked" ? [{ id: "qa_media", url: "/api/v1/content/media/qa_media/content" }] : [] };
    const detail = { key, definition: null, item: { id: "game_item", revision: "3", gameId: "game_1" }, draft, published: null, versions: [], current, baseline: null };
    const writes = [], props = { detail, canEdit: true, canPublish: true, canBrowseMedia: false, locked: false, onWrite: async (...args) => writes.push(args), onClose() {}, onDirtyChange() {} };
    await act(async () => h.root.render(createElement(ContentResourceEditor, props))); await h.settle(70);
    assert.equal(catalogReads, 0); assert.equal(versionReads, 1); assert.equal(h.btn("插入图片"), undefined);
    if (eligibility === "available") {
      assert.ok(!h.btn("发布到用户页面").disabled); await h.click(h.btn("发布到用户页面"));
      assert.deepEqual(writes[0], ["content.resource.publish", { versionId: draft.id, expectedRevision: "3" }]);
    } else {
      assert.ok(h.btn("发布到用户页面").disabled, "revoked or unread media never counts as available");
      assert.equal(writes.length, 0);
      if (eligibility === "read-failure") { await h.click(h.btn("重新检查正文")); assert.equal(versionReads, 2); assert.ok(!h.btn("发布到用户页面").disabled); }
    }
  });
}

test("QR replacement only previews distinct candidates while banner and hero field thumbnails remain", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]) });
  const { ContentMediaEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-media-editor.tsx");
  const before = { ...DEFAULT_RESOURCES["placement:FOLLOW"], qrMediaId: "qr_before" }, after = { ...before, qrMediaId: "qr_after" };
  const makeDetail = (key, publishedPayload, draftPayload = null) => ({
    key, definition: RESOURCE_DEFINITIONS.find(row => row.key === key), item: { id: "media_item", revision: "2", gameId: null },
    draft: draftPayload ? { id: "draft_2", sequence: 2, state: "DRAFT", payload: draftPayload } : null,
    published: { id: "published_1", sequence: 1, state: "PUBLISHED", payload: publishedPayload }, versions: [], baseline: null,
    current: { schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: "available", payload: publishedPayload, media: [publishedPayload.qrMediaId, publishedPayload.mediaId].filter(Boolean).map(id => ({ id, url: `/api/v1/content/media/${id}/content` })) },
  });
  const props = { canEdit: true, canPublish: true, locked: false, onWrite: async () => { throw new Error("preview does not write"); }, onClose() {}, onDirtyChange() {} };
  const render = async (key, detail) => { await act(async () => h.root.render(createElement(ContentMediaEditor, { ...props, key, detail }))); await h.settle(); };
  await render("before", makeDetail("placement:FOLLOW", before));
  assert.equal(h.el.querySelectorAll(".content-media-comparison img").length, 1);
  assert.equal(h.el.querySelectorAll(".content-media-field .content-media-selection").length, 0);
  assert.ok(h.textOf().includes("尚未选择图片"));
  await render("draft", makeDetail("placement:FOLLOW", before, after));
  const comparison = [...h.el.querySelectorAll(".content-media-comparison img")];
  assert.equal(comparison.length, 2); assert.ok(comparison[0].getAttribute("src").includes("qr_before")); assert.ok(comparison[1].getAttribute("src").includes("qr_after"));
  assert.equal(h.el.querySelectorAll(".content-media-field .content-media-selection").length, 0);
  assert.ok(h.btn("保存图片草稿").disabled, "saved draft has no unsaved changes but still shows the different draft image");
  await render("published", makeDetail("placement:FOLLOW", after));
  assert.equal(h.el.querySelectorAll(".content-media-comparison img").length, 1);
  assert.ok(h.el.querySelector(".content-media-comparison img").getAttribute("src").includes("qr_after"));
  const banner = { ...DEFAULT_RESOURCES["placement:MARKET_DELTA_BANNER"], mediaId: "banner_desktop", mobileMediaId: "banner_mobile" };
  await render("banner", makeDetail("placement:MARKET_DELTA_BANNER", banner));
  assert.equal(h.el.querySelectorAll(".content-media-field .content-media-selection img").length, 2, "banner desktop and mobile previews are unchanged");
  const hero = { ...DEFAULT_RESOURCES["placement:HOME_HERO"], slides: DEFAULT_RESOURCES["placement:HOME_HERO"].slides.map((slide, index) => ({ ...slide, mediaId: `hero_${index}`, mobileMediaId: `hero_mobile_${index}` })) };
  await render("hero", makeDetail("placement:HOME_HERO", hero));
  assert.equal(h.el.querySelectorAll(".content-media-field .content-media-selection img").length, hero.slides.length * 2, "each hero field keeps its thumbnail");
  assert.equal(h.writes.length, 0);
});

test("published resource keeps its online snapshot read-only until an explicit draft is created", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]) });
  const { ContentResourceEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-resource-editor.tsx");
  const payload = DEFAULT_GUIDES[0], key = `guide:${payload.slug}`;
  const version = { id: "pub_1", revision: "1", sequence: 1, state: "PUBLISHED", title: payload.title, payload, publishedAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
  const detail = { key, definition: null, item: { id: "guide_item", revision: "4" }, current: { schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: "available", payload, version: { id: "pub_1", sequence: 1, publishedAt: version.publishedAt }, media: [] }, draft: null, published: version, versions: [version], baseline: null };
  const writes = [], relatedOptions = [{ slug: "related-guide", title: "相关说明" }], props = { detail, canEdit: true, canPublish: true, locked: false, relatedOptions, onWrite: async (...args) => { writes.push(args); }, onClose() {}, onDirtyChange() {} };
  await act(async () => h.root.render(createElement(ContentResourceEditor, props))); await h.settle(70);
  assert.ok(h.textOf().includes("线上版本只读"));
  assert.equal(h.btn("保存草稿"), undefined, "no draft means no save action");
  const title = [...h.el.querySelectorAll("label")].find(node => node.textContent === "文档标题");
  assert.ok(title);
  assert.equal(h.browser.document.getElementById(title.htmlFor).closest("fieldset").disabled, true, "online snapshot title is not editable");
  const settingsControl = (id) => h.browser.document.getElementById(id);
  const settingsLocked = (node) => {
    for (let current = node; current; current = current.parentElement) if (current.tagName === "FIELDSET") return current.disabled;
    return false;
  };
  assert.equal(settingsLocked(settingsControl("audience-all")), true, "audience stays locked without a draft");
  assert.equal(settingsLocked(settingsControl("related-related-guide")), true, "related documents stay locked without a draft");
  assert.equal(settingsLocked(settingsControl("guide-contact-cta")), true, "contact CTA stays locked without a draft");
  const settingBoxes = () => [...h.el.querySelectorAll("details.content-detail-secondary fieldset [role=checkbox]")];
  assert.ok(settingBoxes().length >= 3, "test the real custom checkbox roots");
  for (const box of settingBoxes()) { assert.equal(box.getAttribute("aria-disabled"), "true"); assert.equal(box.tabIndex, -1); }
  const keywordControl = () => {
    const label = [...h.el.querySelectorAll("label")].find(node => node.textContent.startsWith("搜索关键词"));
    assert.ok(label);
    return label.htmlFor ? h.browser.document.getElementById(label.htmlFor) : label.querySelector("textarea");
  };
  assert.equal(settingsLocked(keywordControl()), true, "keywords stay locked without a draft");
  await h.click(h.btn("创建草稿后编辑"));
  assert.deepEqual(writes[0], ["content.resource.draft.create", {}]);
  const draftPayload = { ...payload };
  const draftVersion = { id: "draft_1", revision: "1", sequence: 2, state: "DRAFT", title: payload.title, payload: draftPayload, publishedAt: null, updatedAt: "2026-10-29T00:00:00Z" };
  const draftDetail = { ...detail, item: { ...detail.item, revision: "5" }, draft: draftVersion, versions: [draftVersion, ...detail.versions] };
  await act(async () => h.root.render(createElement(ContentResourceEditor, { ...props, key: "drafted", detail: draftDetail })));
  await h.settle(70);
  assert.equal(settingsLocked(settingsControl("audience-all")), false, "a new draft unlocks audience");
  assert.equal(settingsLocked(settingsControl("related-related-guide")), false, "a new draft unlocks related documents");
  assert.equal(settingsLocked(settingsControl("guide-contact-cta")), false, "a new draft unlocks contact CTA");
  for (const box of settingBoxes()) assert.notEqual(box.getAttribute("aria-disabled"), "true");
  assert.equal(settingsLocked(keywordControl()), false, "a new draft unlocks keywords");
});

test("published announcement exposes pinned exposure facts instead of a generic display claim", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]) });
  const { ItemEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-item-editor.tsx");
  const settings = { format: "markdown", tickerEnabled: false, tickerFrom: null, tickerUntil: null, pinned: true, pinnedUntil: "2099-01-01T00:00:00.000Z", validUntil: null, noticeKind: "general", effectiveAt: null, impact: "", surfaces: [], mediaIds: [] };
  const published = version({ id: "pin_pub", state: "PUBLISHED", updateSettings: settings });
  const item = itemRow({ published, draft: null, latest: published });
  await act(async () => h.root.render(createElement(ItemEditor, { detail: { item, versions: [published] }, games: [], canEdit: true, canPublish: true, mediaReadable: false, onClose() {}, onChanged: async () => {}, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) })));
  await h.settle(80);
  assert.ok(h.textOf().includes("置顶中"));
  assert.ok(h.textOf().includes("2099"));
  assert.ok(!h.textOf().includes("常规展示"));
});

test("exposure facts distinguish active, expired, total-expiry and missing pin end", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]) });
  const { updateExposureFacts } = await h.source.ssrLoadModule("/apps/admin/src/views/content-update-settings.tsx");
  const base = { format: "markdown", tickerEnabled: false, tickerFrom: null, tickerUntil: null, pinned: true, pinnedUntil: "2030-01-01T00:00:00.000Z", validUntil: null, noticeKind: "general", effectiveAt: null, impact: "", surfaces: [], mediaIds: [] };
  const labels = (settings, at) => updateExposureFacts(settings, Date.parse(at)).map(fact => fact.label);
  const active = labels(base, "2029-12-31T00:00:00Z");
  assert.ok(active.some(label => label.startsWith("置顶中")), "an unexpired pin is active");
  const expired = labels(base, "2030-01-02T00:00:00Z");
  assert.ok(expired.some(label => label.startsWith("置顶已结束")), "an elapsed pin end is an ordinary expiry");
  assert.ok(!expired.some(label => label.includes("缺结束时间")), "an expired pin is not reported as missing its end");
  const total = labels({ ...base, validUntil: "2029-01-01T00:00:00Z" }, "2030-01-02T00:00:00Z");
  assert.ok(total.some(label => label.startsWith("已过有效期")), "total validity expiry is reported once");
  assert.ok(!total.some(label => label.startsWith("置顶中") || label.startsWith("置顶已结束")), "pin facts stay silent when the content is wholly expired");
  const missing = labels({ ...base, pinnedUntil: null }, "2029-12-31T00:00:00Z");
  assert.ok(missing.some(label => label.includes("缺结束时间")), "a missing pin end remains a configuration warning");
});

test("a pinned-limit 409 keeps the draft and explains why publishing failed", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { method: "POST", match: /^\/api\/bff\/admin\/content\/items\/[^/]+\/publish$/, response: () => json({ error: { code: "CONFLICT" } }, 409) },
  ]) });
  const { ItemEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-item-editor.tsx");
  const draft = version({ id: "pin_draft", state: "DRAFT", publishedAt: null, updateSettings: { format: "markdown", pinned: true, pinnedUntil: "2099-01-01T00:00:00.000Z" } });
  const item = itemRow({ draft, published: null, latest: draft });
  await act(async () => h.root.render(createElement(ItemEditor, { detail: { item, versions: [draft] }, games: [], canEdit: true, canPublish: true, mediaReadable: false, onClose() {}, onChanged: async () => { throw new Error("publish must not report success"); }, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) })));
  await h.settle(80);
  await h.click(h.btn("发布草稿 v1"));
  await h.settle(60);
  assert.ok(h.textOf().includes("可能已有 3 条有效置顶"));
  assert.ok(h.textOf().includes("草稿 v1"), "draft stays visible after rejection");
  assert.ok(h.btn("保存草稿"), "draft actions remain available");
});

test("a bound image without a readable URL is reported as unavailable, not as a valid online image", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]) });
  const { ContentMediaEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-media-editor.tsx");
  const key = "placement:FOLLOW", payload = { ...DEFAULT_RESOURCES[key], qrMediaId: "qr_revoked" };
  const detail = { key, definition: RESOURCE_DEFINITIONS.find(row => row.key === key), item: { id: "qr_item", revision: "2" }, draft: null, published: { id: "qr_pub", sequence: 1, state: "PUBLISHED", payload }, versions: [], baseline: null, current: { schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: "available", payload, media: [{ id: "qr_revoked", url: null }] } };
  await act(async () => h.root.render(createElement(ContentMediaEditor, { detail, canEdit: true, canPublish: true, locked: false, onWrite: async () => { throw new Error("preview does not write"); }, onClose() {}, onDirtyChange() {} })));
  await h.settle();
  assert.ok(h.textOf().includes("已撤权或无法读取"));
  assert.equal(h.el.querySelector('img[alt="当前线上图片"]'), null);
});

test("an empty Markdown draft offers a starting structure without overwriting other drafts", async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]) });
  const { ItemEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-item-editor.tsx");
  const draft = version({ id: "empty_draft", state: "DRAFT", body: "", publishedAt: null, updateSettings: { format: "markdown" } });
  const item = itemRow({ draft, published: null, latest: draft });
  await act(async () => h.root.render(createElement(ItemEditor, { detail: { item, versions: [draft] }, games: [], canEdit: true, canPublish: true, mediaReadable: false, onClose() {}, onChanged: async () => {}, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) })));
  await h.settle(80);
  assert.ok(h.btn("插入示例结构"), "空正文显示起始结构入口");
  await h.click(h.btn("插入示例结构"));
  const area = h.el.querySelector('textarea[aria-label="Markdown 正文"]');
  assert.ok(area.value.includes("## 公告内容"));
});

async function mountAnnouncementDraftEditor(t, { holdSort = false } = {}) {
  let releaseSort;
  const sortResult = new Promise(resolve => { releaseSort = resolve; });
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { method: "PUT", match: "/api/bff/admin/content/items/item_ann_local", response: () => holdSort ? sortResult : json({ saved: true }) },
  ]) });
  const { ItemEditor } = await h.source.ssrLoadModule("/apps/admin/src/views/content-item-editor.tsx");
  const draft = version({ id: "draft_local", state: "DRAFT", title: "原公告标题", publishedAt: null, updateSettings: { format: "markdown" } });
  const item = itemRow({ id: "item_ann_local", draft, published: null, latest: draft });
  let closes = 0, reloads = 0;
  const props = { detail: { item, versions: [draft] }, games: [], canEdit: true, canPublish: true, mediaReadable: false, onClose: () => { closes += 1; }, onReload: () => { reloads += 1; }, onChanged: async () => {}, onDirtyChange() {}, requestMediaOptions: async () => optionsPage([]) };
  await act(async () => h.root.render(createElement(ItemEditor, props)));
  await h.settle(70);
  return { ...h, props, get closes() { return closes; }, get reloads() { return reloads; }, releaseSort: () => releaseSort(json({ saved: true })) };
}

function titleInputOf(h) {
  const label = [...h.el.querySelectorAll("label")].find(node => node.textContent.startsWith("标题（纯文本"));
  assert.ok(label, "title field exists");
  return label.querySelector("input");
}

async function typeTitle(h, value) {
  const input = titleInputOf(h);
  await act(async () => { Object.getOwnPropertyDescriptor(h.browser.HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new h.browser.Event("input", { bubbles: true })); });
  await h.settle();
}

test("dirty return asks before discarding, cancel keeps input, explicit discard closes", async t => {
  const h = await mountAnnouncementDraftEditor(t);
  await typeTitle(h, "本地未保存标题");
  assert.ok(h.textOf().includes("有未保存修改"));
  await h.click(h.btn("返回列表"));
  assert.ok(h.browser.document.querySelector('[role="alertdialog"]'));
  assert.ok(h.textOf().includes("放弃未保存的修改？"));
  assert.equal(h.closes, 0);
  await h.click(h.btn("继续编辑"));
  assert.equal(h.closes, 0);
  assert.equal(titleInputOf(h).value, "本地未保存标题", "cancel keeps the unsaved input");
  await h.click(h.btn("返回列表"));
  await h.click(h.btn("放弃并返回"));
  assert.equal(h.closes, 1);
});

test("return and refresh stay disabled while a write is in flight", async t => {
  const h = await mountAnnouncementDraftEditor(t, { holdSort: true });
  await h.click(h.btn("保存排序"));
  assert.equal(h.btn("返回列表").disabled, true, "cannot unload while writing");
  assert.equal(h.btn("刷新详情").disabled, true, "cannot refresh while writing");
  h.releaseSort();
  await h.settle(60);
  assert.equal(h.btn("返回列表").disabled, false);
  assert.equal(h.btn("刷新详情").disabled, false);
  assert.equal(h.closes, 0);
});

test("refreshing a dirty editor discards after confirmation and reads the higher revision", async t => {
  let detailReads = 0;
  const draft1 = version({ id: "draft_reload", itemId: "item_ann_reload", state: "DRAFT", title: "旧标题", revision: "rev_d1", publishedAt: null });
  const item1 = itemRow({ id: "item_ann_reload", revision: "rev1", draft: draft1, published: null, latest: draft1 });
  const draft2 = { ...draft1, title: "新标题", revision: "rev_d2" };
  const item2 = itemRow({ id: "item_ann_reload", revision: "rev2", draft: draft2, published: null, latest: draft2 });
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([item1])) },
    { match: "/api/bff/admin/content/items/item_ann_reload", response: () => { detailReads += 1; return json({ item: detailReads === 1 ? item1 : item2, versions: [detailReads === 1 ? draft1 : draft2] }); } },
  ]) });
  await h.click(h.btn("编辑"));
  await h.settle(70);
  assert.ok(titleInputOf(h));
  await typeTitle(h, "本地未保存标题");
  await h.click(h.btn("刷新详情"));
  assert.ok(h.textOf().includes("放弃修改并刷新详情？"));
  await h.click(h.btn("放弃并刷新"));
  await h.settle(70);
  assert.equal(detailReads, 2, "refresh reads the latest detail");
  assert.equal(titleInputOf(h).value, "新标题", "higher revision replaces the discarded working copy");
  assert.ok(!h.textOf().includes("有未保存修改"));
});

test("a failed later page stays incomplete across opening and closing a detail until a successful retry", async t => {
  const key = "placement:FOLLOW", definition = RESOURCE_DEFINITIONS.find(row => row.key === key);
  const payload = { ...DEFAULT_RESOURCES[key] };
  const current = { schema: RESOURCE_SCHEMA, key, source: "MANAGED", state: "available", payload, media: [{ id: payload.qrMediaId, url: "/public-qr" }] };
  const detail = { key, definition, item: { id: "qr_item", revision: "2" }, current, baseline: payload, draft: null, published: null, versions: [] };
  let listCalls = 0, failSecond = true;
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([
    { match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) },
    { match: "/api/bff/admin/content/resources", response: (url) => {
      listCalls += 1;
      if (!url.searchParams.get("cursor")) return json({ items: [{ current, definition, metadata: null }], nextCursor: "page2", limit: 5 });
      if (failSecond) return json({ error: { code: "INTERNAL_ERROR" } }, 500);
      return json({ items: [], nextCursor: null, limit: 5 });
    } },
    { match: `/api/bff/admin/content/resources/${encodeURIComponent(key)}`, response: () => json(detail) },
  ]) });
  await h.click(h.btn("图片与二维码"));
  await h.settle(60);
  assert.equal(listCalls, 2, "the first page succeeded and the second failed");
  assert.ok(h.textOf().includes("读取未完成"));
  assert.ok(!h.textOf().includes("已全部加载"));
  await h.click(h.btn("更换二维码"));
  await h.settle(40);
  assert.ok(h.browser.document.querySelector('[role="dialog"]'));
  await h.click(h.btn("关闭"));
  await h.settle(30);
  assert.ok(h.textOf().includes("读取未完成"), "opening a detail does not mark the list complete");
  assert.ok(!h.textOf().includes("已全部加载"));
  failSecond = false;
  await h.click(h.btn("重试读取内容"));
  await h.settle(70);
  assert.ok(h.textOf().includes("已全部加载"), "a successful retry through the last page completes the list");
});

test('pending save cannot be unloaded by a content partition tab',async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);
 const draft=version({id:'draft_pending_nav',itemId:'item_pending_nav',state:'DRAFT',title:'待提交标题',publishedAt:null});
 const item=itemRow({id:'item_pending_nav',draft,published:null,latest:draft});
 const h=await mountHarness(t,{perms:PLATFORM_PERMS,fetchImpl:router([
  {match:'/api/bff/admin/content/items',response:()=>json(itemsPage([item]))},
  {match:'/api/bff/admin/content/items/item_pending_nav',response:()=>json({item,versions:[draft]})},
  {method:'PUT',match:'/api/bff/admin/content/items/item_pending_nav/draft',response:()=>pending},
  {match:'/api/bff/admin/content/storage',response:()=>json({backend:'local',configured:true,readCheck:'NOT_RUN'})},
  {match:'/api/bff/admin/content/media',response:()=>json(mediaPage([]))}
 ])});
 await h.click(h.btn('编辑'));await h.settle(80);await h.click(h.btn('保存草稿'));
 const backDisabled=h.btn('返回列表')?.disabled;await h.click(h.btn('运营素材'));
 const editorUnloaded=!h.el.querySelector('[aria-label="公告编辑器"]'),confirmations=h.browser.document.querySelectorAll('[role="alertdialog"]').length;
 release(json({saved:true}));await h.settle(60);

 assert.equal(editorUnloaded,false,'An in-flight write must not be unloaded through the partition tabs');
});

test('a higher-revision refresh cannot silently drop input typed during the read',async t=>{
 let reads=0,release;const delayed=new Promise(resolve=>release=resolve);
 const draft1=version({id:'draft_refresh_race',itemId:'item_refresh_race',state:'DRAFT',title:'旧存稿',publishedAt:null});
 const item1=itemRow({id:'item_refresh_race',revision:'revision1',draft:draft1,published:null,latest:draft1});
 const draft2={...draft1,revision:'draft_revision2',title:'服务器新存稿'},item2={...item1,revision:'revision2',draft:draft2,latest:draft2};
 const h=await mountHarness(t,{perms:PLATFORM_PERMS,fetchImpl:router([
  {match:'/api/bff/admin/content/items',response:()=>json(itemsPage([item1]))},
  {match:'/api/bff/admin/content/items/item_refresh_race',response:()=>++reads===1?json({item:item1,versions:[draft1]}):delayed}
 ])});
 await h.click(h.btn('编辑'));await h.settle(80);await typeTitle(h,'第一次未保存修改');
 await h.click(h.btn('刷新详情'));await h.click(h.btn('放弃并刷新'));await h.settle(30);
 const labelDuringRead=[...h.el.querySelectorAll('label')].find(x=>x.textContent.startsWith('标题（纯文本'));
 const inputDuringRead=labelDuringRead?.querySelector('input');
 const disabledDuringRead=!inputDuringRead||inputDuringRead.disabled;
 if(!disabledDuringRead)await typeTitle(h,'刷新读取中新增的第二次输入');
 const typedDuringRead=inputDuringRead?.value??null;
 release(json({item:item2,versions:[draft2]}));await h.settle(100);
 const afterRead=titleInputOf(h).value;

 assert.ok(disabledDuringRead||afterRead===typedDuringRead,'The refreshed editor must not allow then silently drop a second working copy');
});


test('read-only update settings disable custom controls and ignore attempted changes', async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: '/api/bff/admin/content/items', response: () => json(itemsPage([])) }]) });
  const { ContentUpdateSettings } = await h.source.ssrLoadModule('/apps/admin/src/views/content-update-settings.tsx');
  const { updateSettings } = await import('@zzsh/content/updates');
  const value = updateSettings({}), changes = [];
  function ControlledSettings({ disabled }) { const [current, setCurrent] = useState(value); return createElement(ContentUpdateSettings, { value: current, announcement: true, disabled, onChange: next => { changes.push(next); setCurrent(next); } }); }
  await act(async () => h.root.render(createElement(ControlledSettings, { disabled: true }))); await h.settle();
  const boxes = [...h.el.querySelectorAll('[role=checkbox]')]; assert.ok(boxes.length >= 5);
  for (const box of boxes) { assert.equal(box.getAttribute('aria-disabled'), 'true'); assert.equal(box.tabIndex, -1); }
  await h.click(boxes[0]); assert.equal(changes.length, 0);
  await act(async () => h.root.render(createElement(ControlledSettings, { disabled: false }))); await h.settle();
  await h.click(h.el.querySelector('[role=checkbox]').closest('label')); assert.ok(changes.length > 0); assert.equal(changes.at(-1).tickerEnabled, true); assert.equal(h.el.querySelector('[role=checkbox]').getAttribute('aria-checked'), 'true');
  assert.equal(h.writes.length, 0);
});


test('publication-only access can review and publish a saved draft without being called read-only', async t => {
  const h = await mountHarness(t, { perms: PLATFORM_PERMS, fetchImpl: router([{ match: '/api/bff/admin/content/items', response: () => json(itemsPage([])) }]) });
  const { ContentResourceEditor } = await h.source.ssrLoadModule('/apps/admin/src/views/content-resource-editor.tsx');
  const key = 'guide:rental-getting-started', payload = { ...DEFAULT_RESOURCES[key], markdown: '## 审阅原稿\n\n保留原稿。', mediaIds: [] };
  const draft = { id: 'publication_only_draft', sequence: 1, revision: '1', state: 'DRAFT', title: payload.title, payload, publishedAt: null, updatedAt: '2026-10-29T00:00:00Z' };
  const current = { schema: RESOURCE_SCHEMA, key, source: 'BUILTIN', state: 'available', payload: DEFAULT_RESOURCES[key], media: [] };
  const detail = { key, definition: null, item: { id: 'publication_only_item', revision: '1' }, draft, published: null, versions: [draft], current, baseline: DEFAULT_RESOURCES[key] }, writes = [];
  const props = { detail, canEdit: false, canPublish: true, locked: false, onWrite: async (...args) => writes.push(args), onClose() {}, onDirtyChange() {} };
  await act(async () => h.root.render(createElement(ContentResourceEditor, props))); await h.settle(100);
  assert.ok(h.textOf().includes('可按发布权限处理已有草稿'));
  assert.ok(!h.textOf().includes('不能保存或发布'));
  assert.ok(!h.btn('发布到用户页面').disabled); await h.click(h.btn('发布到用户页面'));
  assert.equal(writes[0][0], 'content.resource.publish');
  await act(async () => h.root.render(createElement(ContentResourceEditor, { ...props, canPublish: false }))); await h.settle();
  assert.ok(h.textOf().includes('当前账号只能查看，不能保存或发布')); assert.equal(h.btn('发布到用户页面'), undefined);
});
