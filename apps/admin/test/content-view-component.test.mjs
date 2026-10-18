import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

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
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  });
  for (const key of ["Element", "SVGElement", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement", "DocumentFragment", "MouseEvent", "KeyboardEvent", "FocusEvent"]) {
    if (browser[key]) globalThis[key] = browser[key];
  }
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
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
  const render = async (nonce = 0, nextPerms = perms, query = {}) =>
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
  return { browser, el, root, render, settle, click, btn, textOf, gets, writes, dirtyLog, queryLog };
}

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
    const input = h.el.querySelector("input");
    assert.ok(input);
    assert.equal(input.labels.length, 1, "原生 label 隐式关联输入框");
    const label = input.labels[0];
    assert.equal(label.control, input);
    assert.equal(label.textContent.trim(), `新建${title}标题（可留空后编辑）`);
    assert.equal(label.closest('[aria-hidden="true"], [hidden]'), null);
    assert.equal(input.disabled, false);
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
  assert.ok(h.textOf().includes("当前状态：已发布 · 线上版本 v1 · 草稿 v2"), "状态摘要");
  assert.ok(h.textOf().includes("版本历史（2）"), "版本历史条数");
  const versionRows = [...h.el.querySelectorAll("details tbody tr")];
  assert.equal(versionRows.length, 2, "渲染两条版本");
  assert.ok(versionRows[0].textContent.includes("v2") && versionRows[0].textContent.includes("草稿") && versionRows[0].textContent.includes("十月例行维护公告（更新）"), "草稿版本行");
  assert.ok(versionRows[1].textContent.includes("v1") && versionRows[1].textContent.includes("线上") && versionRows[1].textContent.includes("rev_pub"), "线上版本行");
  assert.ok(h.btn("保存草稿") && h.btn("发布草稿 v2") && h.btn("撤回线上版本"), "草稿与发布操作可用");

  await h.click(h.btn("编辑"));
  await h.settle();
  assert.ok(!h.textOf().includes("加载内容详情…"), "详情加载提示已结束");
  assert.ok(h.textOf().includes("服务暂时无法完成请求"), "详情失败显示错误");
  assert.ok(h.textOf().includes("公告编辑"), "失败时保留已打开的编辑器");
  assert.equal(h.writes.length, 0, "查看流程无写请求");
});

test("轮播 tab：请求 slot=HOME_HERO&limit=20；渲染条目与公开状态；空槽位提示", async (t) => {
  let carouselCalls = 0;
  const h = await mountHarness(t, {
    perms: PLATFORM_PERMS,
    fetchImpl: router([
      {
        match: "/api/bff/admin/content/carousel",
        response: () => {
          carouselCalls += 1;
          if (carouselCalls === 1) {
            return json(
              carouselPage([
                carouselRow(),
                carouselRow({ id: "car_2", mediaId: "media_c2", title: "旧版活动", imageAlt: "旧版主视觉", linkUrl: null, enabled: false, sortOrder: 2, mediaReviewState: "REJECTED", mediaAccessClass: "PRIVATE_REVIEW" }),
              ]),
            );
          }
          return json(carouselPage([]));
        },
      },
    ]),
  });
  await h.click(h.btn("首页轮播"));
  assert.ok(h.textOf().includes("首页固定槽位轮播"));
  const get = h.gets.find((g) => g.path === "/api/bff/admin/content/carousel");
  assert.ok(get, "请求轮播列表");
  const params = new URLSearchParams(get.query);
  assert.equal(params.get("slot"), "HOME_HERO");
  assert.equal(params.get("limit"), "20");
  const rows = [...h.el.querySelectorAll("tbody tr")];
  assert.equal(rows.length, 2, "渲染两条轮播");
  assert.ok(rows[0].textContent.includes("国庆活动") && rows[0].textContent.includes("国庆主视觉"), "启用条目标题与无障碍文本");
  assert.ok(rows[0].textContent.includes("启用") && rows[0].textContent.includes("素材公开"), "启用与素材公开状态");
  assert.ok(rows[1].textContent.includes("旧版活动") && rows[1].textContent.includes("无跳转"), "停用条目与空跳转");
  assert.ok(rows[1].textContent.includes("停用") && rows[1].textContent.includes("素材不可公开"), "停用与素材不可公开状态");
  assert.ok(h.el.querySelector('img[src="/api/bff/admin/content/media/media_c1/content"]'), "预览图地址");
  assert.ok(h.btn("新建轮播条目"), "有编辑权提供新建入口");

  await h.render(1);
  await h.settle();
  assert.ok(h.textOf().includes("当前槽位没有轮播条目。"), "空槽位提示");
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
      { match: /^\/api\/bff\/admin\/content\/items\/[^/]+$/, response: () => json({ item: itemRow(), versions: [] }) },
      { match: "/api/bff/admin/content/media-options", response: () => json(optionsPage([mediaOption(), mediaOption({ id: "media_opt_2" })])) },
    ]),
  });
  await h.click(h.btn("平台素材"));
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

  await h.render(1);
  await h.settle();
  assert.ok(h.textOf().includes("还没有平台内容素材。"), "空素材提示");
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

test("无 content 读权限：显示受限说明、不渲染 tab、无写请求", async (t) => {
  const h = await mountHarness(t, {
    perms: ["admin.account.read"],
    fetchImpl: router([{ match: "/api/bff/admin/content/items", response: () => json(itemsPage([])) }]),
  });
  assert.ok(h.textOf().includes("当前账号没有内容管理权限。"), "受限说明");
  assert.ok(h.textOf().includes("平台级内容与游戏级内容需要不同的动态操作权限。"), "受限说明补充");
  assert.ok(h.el.querySelector('[role="alert"]'), "受限说明以 alert 呈现");
  assert.equal(h.el.querySelectorAll('[role="tab"]').length, 0, "不渲染内容 tab");
  assert.equal(h.writes.length, 0, "无写请求");
  assert.equal(h.gets.filter((g) => g.path === "/api/bff/admin/content/items").length, 1, "现状：仍发出一次内容列表读，由服务端拒绝");
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
  assert.ok(!h.btn("平台公告") && !h.btn("首页轮播") && !h.btn("平台素材"), "平台级 tab 不渲染");
  assert.ok(h.gets.some((g) => g.path === "/api/bff/admin/content/games"), "加载游戏范围");
  const first = h.gets.find((g) => g.path === "/api/bff/admin/content/items");
  assert.ok(first, "游戏范围就绪后请求列表");
  assert.equal(new URLSearchParams(first.query).get("scope"), "game", "仅游戏内容权限时首个请求即游戏范围（ADM-R1-02）");
  assert.equal(new URLSearchParams(first.query).get("type"), "NEWS", "首个请求为资讯");
  assert.equal(new URLSearchParams(first.query).get("gameId"), "game_1", "首个请求带对象范围");
  assert.equal(h.gets.some((g) => g.path === "/api/bff/admin/content/items" && g.query.includes("ANNOUNCEMENT")), false, "不先请求平台公告");
  const scopeSelect = h.el.querySelector("select");
  assert.ok(scopeSelect, "渲染资讯范围选择器");
  assert.ok(![...scopeSelect.querySelectorAll("option")].some((option) => option.value === "platform"), "无平台资讯选项");
  // 切到游戏范围：请求带对象范围，分区/范围/对象写入地址栏
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(h.browser.HTMLSelectElement.prototype, "value").set;
    setValue.call(scopeSelect, "game");
    scopeSelect.dispatchEvent(new h.browser.Event("change", { bubbles: true }));
  });
  await h.settle();
  const get = h.gets.filter((g) => g.path === "/api/bff/admin/content/items").at(-1);
  const params = new URLSearchParams(get.query);
  assert.equal(params.get("scope"), "game");
  assert.equal(params.get("type"), "NEWS");
  assert.equal(params.get("limit"), "20");
  assert.equal(params.get("gameId"), "game_1", "带对象范围 gameId");
  assert.deepEqual(h.queryLog.at(-1), { tab: "news", scope: "game", gameId: "game_1" }, "分区/范围/对象写入地址栏");
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
  assert.deepEqual(h.queryLog, [{ tab: "announcement" }], "首屏默认分区只写一次（不再 21 次）");
  await h.click(h.btn("资讯"));
  await h.settle();
  assert.deepEqual(h.queryLog.at(-1), { tab: "news", scope: "platform" }, "分区与范围写入地址栏");
  await h.settle();
  assert.equal(h.queryLog.length, 2, "切换分区只再产生一次回写");
  assert.ok(!Object.keys(h.queryLog.at(-1)).some((key) => /password|pin|otp|phone|token|secret/i.test(key)), "敏感键不落 URL");
  await h.render(0, BOTH_CONTENT_PERMS, { tab: "media" });
  assert.ok(h.btn("平台素材"), "按地址栏 tab 恢复分区");
  await h.render(0, BOTH_CONTENT_PERMS, { tab: "news", scope: "game", gameId: "game_1" });
  const get = h.gets.filter((g) => g.path === "/api/bff/admin/content/items").at(-1);
  const params = new URLSearchParams(get.query);
  assert.equal(params.get("scope"), "game", "按地址栏恢复资讯范围");
  assert.equal(params.get("gameId"), "game_1", "按地址栏恢复游戏范围");
  assert.equal(h.writes.length, 0, "恢复分区无写请求");
});
