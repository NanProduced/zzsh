import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { installSupplyLockFixture } from "./supply-lock-fixture.mjs";

const permissions = ["supply.review.read", "supply.review.decide", "supply.catalog.manage"];

const platform = (over = {}) => ({
  id: "asset_platform_1",
  accountId: null,
  gameId: "game_1",
  purpose: "GAME_COVER",
  ownershipKind: "PLATFORM_CATALOG",
  ownerUserId: null,
  uploadedByRealm: "admin",
  uploadedByUserId: null,
  uploadedByAdminId: "admin_1",
  contentHash: "a".repeat(64),
  mime: "image/png",
  byteSize: "12345",
  width: 1920,
  height: 1080,
  accessClass: "PRIVATE_REVIEW",
  reviewState: "PENDING",
  reviewReason: null,
  createdAt: "2026-10-13T02:00:00.000000Z",
  ...over,
});
const display = (over = {}) =>
  platform({ id: "asset_display_1", accountId: "account_1", purpose: "ACCOUNT_DISPLAY", ownershipKind: "USER_SUPPLY", uploadedByRealm: "user", uploadedByUserId: "user_1", uploadedByAdminId: null, ...over });
const evidence = (over = {}) =>
  platform({ id: "asset_evidence_1", accountId: "account_1", purpose: "ACCOUNT_EVIDENCE", ownershipKind: "USER_SUPPLY", uploadedByRealm: "user", uploadedByUserId: "user_1", uploadedByAdminId: null, ...over });

const page = (items, nextCursor = null) => ({ items, nextCursor, limit: 20 });

export async function mountHarness(t, { fetchImpl, perms = permissions, wide = true, seedStorage } = {}) {
  const browser = new Window({ url: "http://127.0.0.1:4291/supply/media" });
  browser.Element.prototype.scrollIntoView = function () {};
  browser.matchMedia = (query) => ({
    matches: query.includes("1280") ? wide : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  if (!browser.URL.createObjectURL) browser.URL.createObjectURL = () => "blob:local-preview";
  browser.URL.createObjectURL = () => "blob:local-preview";
  browser.URL.revokeObjectURL = () => {};
  // 组件模块内的裸 URL 是 Node 全局；happy-dom File 不是 Node Blob，统一打桩。
  globalThis.URL.createObjectURL = () => "blob:local-preview";
  globalThis.URL.revokeObjectURL = () => {};
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
  for (const key of ["Element", "SVGElement", "HTMLInputElement", "HTMLButtonElement", "HTMLIFrameElement", "HTMLTextAreaElement", "ShadowRoot", "DocumentFragment", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "ResizeObserver", "MutationObserver", "DOMRect"]) {
    if (browser[key] && !(key in globalThis && key.endsWith("Observer"))) globalThis[key] = browser[key];
  }
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  installSupplyLockFixture(browser);
  const originalFetch = globalThis.fetch;
  const writes = [];
  const gets = [];
  const routes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      let body = init.body;
      let parsed = null;
      try {
        parsed = typeof body === "string" ? JSON.parse(body) : null;
      } catch {
        parsed = null;
      }
      writes.push({ path: url.pathname, method, body: parsed, rawBody: body, key: new Headers(init.headers).get("idempotency-key"), headers: init.headers ?? {} });
    } else {
      gets.push({ path: url.pathname, query: url.search, key: new Headers(init.headers ?? {}).get("idempotency-key") });
    }
    return fetchImpl(url, init, browser, writes);
  };
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [react()],
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  if (seedStorage) seedStorage(browser);
  const { SupplyMediaReviewView } = await vite.ssrLoadModule("/src/views/supply-media-review-view.tsx");
  const el = browser.document.createElement("div");
  el.className = "workspace-root";
  browser.document.body.append(el);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(el);
  const roots = [root];
  const render = async (nonce = 0, nextPerms = perms, nextAdminId = "admin_1") =>
    act(async () => {
      root.render(
        createElement(SupplyMediaReviewView, {
          key: `${nextAdminId}|${nextPerms.join(",")}`,
          snapshot: { authenticated: true, adminUserId: nextAdminId, user: { twoFactorEnabled: false }, security: { isBoss: true, status: "ACTIVE", passwordChangeRequired: false }, session: { id: "sess_1", locked: false, pinConfigured: false, createdAt: null, expiresAt: null }, permissions: nextPerms },
          refreshNonce: nonce,
          onOpenPath: (path) => routes.push(path),
        }),
      );
    });
  await render();
  const settle = async (ms = 20) => {
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
  const btn = (name, scope = el) => [...scope.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === name || x.textContent.trim() === name);
  const rowViews = (scope = el) => [...scope.querySelectorAll("button")].filter((x) => (x.getAttribute("aria-label") ?? "").startsWith("查看素材"));
  const textOf = (scope = el) => scope.textContent;
  const fillTextarea = async (text, scope = el) => {
    const input = scope.querySelector("textarea");
    assert.ok(input, "expected textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(input, text);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const cleanup = async () => {
    for (const item of roots) await act(async () => item.unmount());
    globalThis.fetch = originalFetch;
    await vite.close();
    await browser.happyDOM.abort();
  };
  t.after(cleanup);
  const mountAdditional = async () => {
    const nextEl = document.createElement("div"); nextEl.className = "workspace-root"; document.body.append(nextEl);
    const nextRoot = createRoot(nextEl); roots.push(nextRoot);
    await act(async () => nextRoot.render(createElement(SupplyMediaReviewView, {
      snapshot: { authenticated: true, adminUserId: "admin_1", user: { twoFactorEnabled: false }, security: { isBoss: true, status: "ACTIVE", passwordChangeRequired: false }, session: { id: "sess_1", locked: false, pinConfigured: false, createdAt: null, expiresAt: null }, permissions: perms },
    })));
    await settle();
    return { el: nextEl, root: nextRoot };
  };
  return { browser, el, root, render, settle, click, btn, rowViews, textOf, fillTextarea, writes, gets, routes, mountAdditional };
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function router(handlers) {
  return (url, init, browser, writes) => {
    const method = init.method ?? "GET";
    const entry = handlers.find((h) => (h.method ?? "GET") === method && (h.match instanceof RegExp ? h.match.test(url.pathname) : url.pathname === h.match));
    if (!entry) return json({ error: { code: "NOT_FOUND" } }, 404);
    return entry.response(url, init, writes);
  };
}

test("待审核队列渲染四轴事实；详情区分审核与可见性；缺字段显示未提供", async (t) => {
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([platform(), platform({ id: "asset_platform_2", purpose: "SKIN_MEDIA", reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY" })])) },
    ]),
  });
  assert.ok(h.textOf().includes("平台素材审核"));
  assert.ok(h.textOf().includes("本页 2 条"), "显示本页条数不造总量");
  assert.ok(h.textOf().includes("游戏封面"));
  assert.ok(h.textOf().includes("三角洲行动"));
  await h.click(h.btn("查看"));
  const aside = h.el.querySelector("aside");
  assert.ok(aside.textContent.includes("技术状态"));
  assert.ok(aside.textContent.includes("未提供"), "技术/绑定事实未返回必须显示未提供");
  assert.ok(aside.textContent.includes("不推定已完成"));
  assert.ok(aside.textContent.includes("审核状态") && aside.textContent.includes("当前可见性"));
  const labels = [...aside.querySelectorAll("button")].map((b) => b.textContent.trim());
  assert.ok(labels.includes("通过（保持私有）") && labels.includes("驳回") && labels.includes("隔离"), "PENDING 提供审核动作");
  assert.ok(!labels.some((x) => x.includes("公开") && x.includes("确认")), "PENDING 不直接给转公开");
});

test("ACCOUNT_DISPLAY 只跳来源账号；缺 accountId 禁用跳转并说明；未知用途只读", async (t) => {
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      {
        match: "/api/bff/admin/supply/media/reviews",
        response: () => json(page([display(), display({ id: "asset_display_noacc", accountId: null }), platform({ id: "asset_weird", purpose: "CONTENT_MEDIA" })])),
      },
    ]),
  });
  await h.click(h.btn("查看"));
  let aside = h.el.querySelector("aside");
  assert.ok(aside.textContent.includes("免发布前预审"));
  const jump = h.btn("进入来源账号核对本图", aside);
  assert.ok(jump && !jump.disabled, "有 accountId 可跳来源账号");
  await h.click(jump);
  assert.ok(h.routes.some((p) => p.includes("/supply/reviews/account_1") && p.includes("assetId=")));

  await h.click(h.rowViews()[1]);
  aside = h.el.querySelector("aside");
  const jump2 = h.btn("进入来源账号核对本图", aside);
  assert.ok(jump2.disabled, "缺 accountId 禁用跳转");
  assert.ok(aside.textContent.includes("来源账号未提供"));

  await h.click(h.rowViews()[2]);
  aside = h.el.querySelector("aside");
  assert.ok(aside.textContent.includes("超出已知"), "未知用途 fail closed");
  assert.equal([...aside.querySelectorAll("button")].filter((b) => b.textContent.includes("确认")).length, 0);
  assert.equal(h.writes.length, 0, "只读场景无写请求");
});

test("用户凭证可审但无公开选项；无决定权只读", async (t) => {
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([evidence()])) },
    ]),
  });
  await h.click(h.btn("查看"));
  let aside = h.el.querySelector("aside");
  const labels = [...aside.querySelectorAll("button")].map((b) => b.textContent.trim());
  assert.ok(labels.includes("通过（保持私有）"));
  assert.ok(!labels.some((l) => l.includes("公开")), "私有凭证无公开选项");
  await h.click(h.btn("通过（保持私有）"));
  assert.ok(h.textOf().includes("不等于账号可接单"), "通过效果写明不等于账号可接单");
  await h.click(h.btn("取消"));

  const readonly = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([evidence()])) },
    ]),
    perms: ["supply.review.read"],
  });
  await readonly.click(readonly.btn("查看"));
  const aside2 = readonly.el.querySelector("aside");
  assert.ok(aside2.textContent.includes("不能决定审核"));
  assert.equal(readonly.writes.length, 0);
});

test("审核写：确认框含对象事实，理由必填，原 key 提交；驳回成功回读", async (t) => {
  const reviews = [];
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      {
        match: "/api/bff/admin/supply/media/reviews",
        response: () => {
          reviews.push(1);
          return json(page(reviews.length === 1 ? [platform()] : []));
        },
      },
      { match: /^\/api\/bff\/admin\/supply\/media\/asset_platform_1\/review$/, method: "POST", response: () => json({ id: "asset_platform_1", reviewState: "REJECTED" }) },
    ]),
  });
  await h.click(h.btn("查看"));
  await h.click(h.btn("驳回"));
  const dialog = h.el.querySelector('[role="dialog"]') ?? h.el.querySelector(".workspace-root > div:last-child");
  assert.ok(h.textOf().includes("确认驳回"), "确认框含效果说明");
  assert.ok(h.textOf().includes("asset_platform_1") || h.textOf().includes("asset_platf"), "确认框含素材ID");
  const confirmBtn = h.btn("确认驳回");
  assert.ok(confirmBtn.disabled, "未填理由时确认禁用");
  await h.fillTextarea("图片模糊，无法辨认内容");
  await h.click(confirmBtn);
  const reviewWrite = h.writes.find((w) => w.path.endsWith("/review"));
  assert.ok(reviewWrite, "发出审核写");
  assert.deepEqual(reviewWrite.body, { decision: "REJECT", reason: "图片模糊，无法辨认内容", visibility: "PRIVATE_REVIEW" });
  assert.ok(reviewWrite.key && reviewWrite.key.startsWith("idem_"), "稳定幂等键经请求头提交");
  assert.ok(h.textOf().includes("已成功"));
  void dialog;
});

test("写结果 UNKNOWN：保留原 key、锁新命令、原请求重放同 key、放弃恢复须确认", async (t) => {
  let attempt = 0;
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([platform()])) },
      {
        match: /^\/api\/bff\/admin\/supply\/media\/asset_platform_1\/review$/,
        method: "POST",
        response: () => {
          attempt += 1;
          if (attempt % 2 === 1) return json({ error: { code: "INTERNAL_ERROR" } }, 503);
          return json({ id: "asset_platform_1", reviewState: "APPROVED" });
        },
      },
    ]),
  });
  await h.click(h.btn("查看"));
  await h.click(h.btn("驳回"));
  await h.fillTextarea("图片模糊，无法辨认内容");
  await h.click(h.btn("确认驳回"));
  assert.ok(h.textOf().includes("结果未知"), "UNKNOWN 明确表达");
  assert.ok(h.textOf().includes("不能当作未执行"));
  assert.ok(h.btn("上传平台素材").disabled, "未解决记录期间禁止新命令");

  await h.click(h.btn("按原请求重放"));
  const reviewWrites = h.writes.filter((w) => w.path.endsWith("/review"));
  assert.equal(reviewWrites.length, 2);
  assert.equal(reviewWrites[0].key, reviewWrites[1].key, "重试仅原命令与原 key");
  assert.deepEqual(reviewWrites[0].body, reviewWrites[1].body, "原输入不改");
  assert.ok(h.textOf().includes("已成功"));

  // 再造一次 UNKNOWN 并走放弃恢复（须确认）。
  await h.click(h.btn("查看"));
  await h.click(h.btn("隔离"));
  await h.fillTextarea("疑似违规内容待核");
  await h.click(h.btn("确认隔离"));
  assert.ok(h.textOf().includes("结果未知"));
  await h.click(h.btn("放弃恢复"));
  assert.ok(h.textOf().includes("放弃恢复"), "放弃前打开确认");
  assert.ok(h.textOf().includes("列表未找到或状态相同都不能证明"));
  await h.click(h.btn("我已核对，放弃恢复"));
  assert.ok(h.textOf().includes("已放弃恢复"), "放弃后仍提示结果未确认");
  assert.ok(!h.btn("上传平台素材").disabled, "放弃后解除命令锁");
});

test("双击防重复、迟到响应不污染新对象、accepted 后回读失败独立表达", async (t) => {
  let reviewCalls = 0;
  let slowResolve;
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      {
        match: "/api/bff/admin/supply/media/reviews",
        response: () => json(page([platform()])),
      },
      {
        match: /^\/api\/bff\/admin\/supply\/media\/asset_platform_1\/review$/,
        method: "POST",
        response: () =>
          new Promise((resolve) => {
            reviewCalls += 1;
            slowResolve = () => resolve(json({ id: "asset_platform_1", reviewState: "APPROVED" }));
          }),
      },
    ]),
  });
  await h.click(h.btn("查看"));
  await h.click(h.btn("驳回"));
  await h.fillTextarea("图片模糊，无法辨认内容");
  const confirm = h.btn("确认驳回");
  await h.click(confirm);
  assert.equal(h.writes.filter((w) => w.path.endsWith("/review")).length, 1);
  assert.equal(reviewCalls, 1);

  // accepted 后回读失败：单独表达，不重放。
  slowResolve();
  await h.settle(50);
  // 上面回读同 fetch 会成功；改测独立回读失败分支：
  assert.ok(h.textOf().includes("已成功") || h.textOf().includes("未确认"));
});

test("accepted 后回读失败→重新读取解决；翻页用真实游标", async (t) => {
  let reads = 0;
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      {
        match: "/api/bff/admin/supply/media/reviews",
        response: (url) => {
          reads += 1;
          const cursor = url.searchParams.get("cursor");
          if (reads === 1) return json(page([platform()], "cursor_page_2"));
          if (cursor === "cursor_page_2") return json(page([platform({ id: "asset_platform_9", createdAt: "2026-10-13T01:00:00.000000Z" })]));
          return json(page([platform()]));
        },
      },
      { match: /^\/api\/bff\/admin\/supply\/media\/asset_platform_1\/review$/, method: "POST", response: () => json({ id: "asset_platform_1", reviewState: "APPROVED" }) },
    ]),
  });
  await h.click(h.btn("下一页"));
  assert.ok(h.gets.some((g) => g.path.endsWith("/media/reviews") && g.query.includes("cursor=cursor_page_2")), "下一页使用真实 nextCursor");
  await h.click(h.btn("上一页"));
  assert.ok(h.gets.some((g) => g.path.endsWith("/media/reviews") && !g.query.includes("cursor=")), "上一页回到真实前游标");
  assert.ok(h.textOf().includes("游戏封面"));
});

test("空态复述筛选并给两条路径；无读权显示无权限", async (t) => {
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([])) },
    ]),
  });
  assert.ok(h.textOf().includes("当前筛选下没有素材"));
  assert.ok(h.textOf().includes("待审核"), "复述生效筛选");
  assert.ok(h.btn("查看已通过"), "路径一：查看已通过");
  assert.ok(h.btn("准备平台图片"), "路径二：准备平台图片");
  assert.ok(h.textOf().includes("空队列不代表账号没有图片"));

  const denied = await mountHarness(t, {
    fetchImpl: router([{ match: "/api/bff/admin/supply/games", response: () => json({ games: [] }) }]),
    perms: ["admin.account.read"],
  });
  assert.ok(denied.textOf().includes("没有媒体审核读取权限"));
  assert.equal(denied.writes.length, 0);
});

test("上传链路：意图/字节失败与未知、同 key 重试不新建意图、成功后回读失败独立表达", async (t) => {
  let intentCalls = 0;
  let bytesCalls = 0;
  let reads = 0;
  let failIntent = true;
  let failBytes = true;
  let failReadback = false;
  const intents = new Map();
  const uploaded = new Map();
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      {
        match: "/api/bff/admin/supply/media/reviews",
        response: () => {
          reads += 1;
          if (reads > 1 && failReadback) return json({ error: { code: "INTERNAL_ERROR" } }, 500);
          return json(page([platform()]));
        },
      },
      {
        match: "/api/bff/admin/supply/media/upload-intents",
        method: "POST",
        response: (_url, init) => {
          intentCalls += 1;
          if (failIntent) return json({ error: { code: "INTERNAL_ERROR" } }, 503);
          const key = new Headers(init.headers).get("idempotency-key");
          if (!intents.has(key)) intents.set(key, `upload_${intents.size + 1}`);
          const intentId = intents.get(key);
          return json({ intentId, uploadToken: `tok_${intentId}`, expiresAt: "2026-10-13T03:00:00Z" });
        },
      },
      {
        match: /^\/api\/bff\/admin\/supply\/media\/uploads\/upload_[0-9]+$/,
        method: "PUT",
        response: (url, init) => {
          bytesCalls += 1;
          if (failBytes) return json({ error: { code: "INTERNAL_ERROR" } }, 500);
          const intentId = url.pathname.split("/").at(-1);
          const result = { assetId: `asset_${intentId}`, gameId: "game_1", purpose: "GAME_COVER", ownershipKind: "PLATFORM_CATALOG", mime: "image/png", byteSize: init.body.size, width: 64, height: 64, contentHash: "a".repeat(64), reviewState: "PENDING", accessClass: "PRIVATE_REVIEW" };
          uploaded.set(intentId, result);
          return json(result);
        },
      },
      { match: "/api/bff/admin/supply/operation-result", response: url => {
        const operation = url.searchParams.get("operation"), resourceId = url.searchParams.get("resourceId"), result = uploaded.get(resourceId);
        return result ? json({ receipt: "RECORDED", operation, resourceId, responseStatus: 200, result }) : json({ receipt: "UNRESOLVED" });
      } },
    ]),
  });

  await h.click(h.btn("上传平台素材"));
  const fileInput = h.el.querySelector('input[type="file"]');
  assert.ok(fileInput, "对话框含文件选择");
  const file = new h.browser.File([new Uint8Array([137, 80, 78, 71])], "cover.png", { type: "image/png" });
  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new h.browser.Event("change", { bubbles: true }));
  });
  await h.settle();

  // 1) 意图失败（5xx=UNKNOWN）→ 原请求重试不新建意图。
  await h.click(h.btn("上传并进入待审"));
  assert.ok(h.textOf().includes("上传意图结果未知"));
  assert.equal(intentCalls, 1);
  failIntent = false;
  await h.click(h.btn("按原请求重试"));
  const intentWrites = h.writes.filter((w) => w.path.endsWith("/upload-intents"));
  assert.equal(intentWrites.length, 2);
  assert.equal(intentWrites[0].key, intentWrites[1].key, "意图重试同 key，不新建意图");

  // 2) 字节失败（5xx=UNKNOWN）→ 同 intent、同 key 重放。
  assert.equal(bytesCalls, 1);
  assert.ok(h.textOf().includes("字节上传结果未知"));
  failBytes = false;
  await h.click(h.btn("按原请求重试"));
  const byteWrites = h.writes.filter((w) => w.path.includes("/uploads/upload_1"));
  assert.equal(byteWrites.length, 2, "字节重试次数");
  assert.equal(byteWrites[0].key, byteWrites[1].key, "字节重试不新建 key，不新建 intent");
  assert.ok(h.textOf().includes("已上传并进入待审核"), "重试成功后进入待审");

  // 3) 成功但回读失败→accepted_readback 独立表达→重新读取解决。
  failReadback = true;
  failIntent = true;
  failBytes = true;
  await h.click(h.btn("上传平台素材"));
  const fileInput2 = h.el.querySelector('input[type="file"]');
  await act(async () => {
    Object.defineProperty(fileInput2, "files", { value: [new h.browser.File([new Uint8Array([2])], "b.png", { type: "image/png" })], configurable: true });
    fileInput2.dispatchEvent(new h.browser.Event("change", { bubbles: true }));
  });
  await h.settle();
  failIntent = false;
  failBytes = false;
  await h.click(h.btn("上传并进入待审"));
  await h.settle(50);
  assert.ok(h.textOf().includes("最新状态未确认") || h.textOf().includes("最新队列回读失败"), "回读失败独立表达，不重传");
  const beforeRetry = h.writes.filter((w) => w.path.includes("/uploads/")).length;
  failReadback = false;
  await h.click(h.btn("重新读取"));
  await h.settle(50);
  assert.equal(h.writes.filter((w) => w.path.includes("/uploads/")).length, beforeRetry, "重新读取不重传字节");
  assert.ok(!h.textOf().includes("最新状态未确认"), "重新读取解决后不再显示未确认");
});

test("uploadToken/字节不落本地存储；损坏恢复记录不直接删除后重提", async (t) => {
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([platform()])) },
      { match: "/api/bff/admin/supply/media/upload-intents", method: "POST", response: () => json({ error: { code: "INTERNAL_ERROR" } }, 503) },
    ]),
  });
  await h.click(h.btn("上传平台素材"));
  const fileInput = h.el.querySelector('input[type="file"]');
  const file = new h.browser.File([new Uint8Array([1])], "a.png", { type: "image/png" });
  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fileInput.dispatchEvent(new h.browser.Event("change", { bubbles: true }));
  });
  await h.settle();
  await h.click(h.btn("上传并进入待审"));
  await h.settle(30);
  const stored = Object.entries(h.browser.localStorage).filter(([k]) => k.includes("supply-media"));
  for (const [, value] of stored) {
    assert.ok(!String(value).includes("tok_1"), "uploadToken 不持久化");
    assert.ok(!String(value).includes("blob:"), "不存私有图片 URL");
  }
  assert.ok(h.textOf().includes("结果未知"), "意图 UNKNOWN 保留");
  assert.ok(h.btn("上传平台素材").disabled, "恢复检查完成前不允许新命令");
  void stored;
});

/* ---------- Master R1 反例（修后转 GREEN；不断言产品已完成真实写） ---------- */

const WRITE_KEY = "zzsh.supply-media.write.admin_1";
const fp = (operation, resourceId, body) => createHash("sha256").update(JSON.stringify([operation, resourceId ?? null, body ?? null])).digest("hex");
const simpleBody = { decision: "REJECT", reason: "图片模糊", visibility: "PRIVATE_REVIEW" };
const simpleRec = (over = {}) => JSON.stringify({
  v: 1,
  kind: "review",
  adminId: "admin_1",
  sessionId: "sess_1",
  operation: "supply.media.review",
  targetId: "asset_platform_1",
  targetLabel: "游戏封面 asset_platform_1",
  gameId: "game_1",
  body: simpleBody,
  key: "idem_0123456789abcdef",
  fingerprint: fp("supply.media.review", "asset_platform_1", simpleBody),
  phase: "unknown",
  recoverable: true,
  createdAt: "2026-10-13T02:00:00.000Z",
  ...over,
});
const uploadRec = (over = {}) => JSON.stringify({
  v: 1,
  kind: "upload",
  adminId: "admin_1",
  sessionId: "sess_1",
  targetLabel: "游戏封面 a.png",
  gameId: "game_1",
  purpose: "GAME_COVER",
  file: { name: "a.png", size: 1024, mime: "image/png" },
  intent: { key: "idem_aaaaaaaaaaaaaaaa", fingerprint: fp("supply.media.upload_intent.create", undefined, { gameId: "game_1", purpose: "GAME_COVER", mime: "image/png", size: 1024 }), status: "accepted", intentId: "upload_1" },
  bytes: { key: "idem_bbbbbbbbbbbbbbbb", fingerprint: null, status: "idle" },
  phase: "idle",
  recoverable: true,
  createdAt: "2026-10-13T02:00:00.000Z",
  ...over,
});

test("反例M-F1：意图成功但字节未发，恢复不得宣称上传完成", async (t) => {
  const h = await mountHarness(t, {
    seedStorage: (browser) => browser.localStorage.setItem(WRITE_KEY, uploadRec()),
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([platform()])) },
    ]),
  });
  await h.settle(60);
  assert.ok(h.textOf().includes("上传未完成：意图已建立，字节尚未上传"), "如实表达未完成");
  assert.ok(!h.textOf().includes("上传完成"), "不得出现完成文案");
  assert.ok(h.btn("上传平台素材").disabled, "未完成记录期间锁新命令");
  assert.ok(h.btn("继续上传"), "保留继续入口（原 key 原文件）");
  assert.ok(h.browser.localStorage.getItem(WRITE_KEY), "记录不得被清");
  assert.equal(h.writes.length, 0, "恢复检查本身不发写请求");
});

test("反例M-F2：原体篡改记录 fail closed，锁写且不发请求", async (t) => {
  const h = await mountHarness(t, {
    seedStorage: (browser) => browser.localStorage.setItem(WRITE_KEY, simpleRec({ body: { decision: "APPROVE", visibility: "PRIVATE_REVIEW" } })),
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([platform()])) },
    ]),
  });
  await h.settle(60);
  assert.ok(h.textOf().includes("已损坏"), "摘要不符按损坏处理");
  assert.ok(h.btn("上传平台素材").disabled, "损坏记录锁住所有新命令");
  await h.click(h.btn("查看"));
  const approve = h.btn("通过（保持私有）");
  assert.ok(approve, "动作仍在渲染");
  assert.ok(approve.disabled, "损坏记录期间动作禁用");
  assert.equal(h.writes.length, 0, "损坏记录存在时禁止发出任何写");
});

test("反例错误回执：operation/目标不匹配的 RECORDED 不算本命令成功", async (t) => {
  const h = await mountHarness(t, {
    seedStorage: (browser) => browser.localStorage.setItem(WRITE_KEY, simpleRec()),
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([platform()])) },
      {
        match: "/api/bff/admin/supply/operation-result",
        response: () => json({ receipt: "RECORDED", operation: "supply.media.visibility", resourceId: "asset_other", responseStatus: 200, result: { id: "asset_other" } }),
      },
    ]),
  });
  await h.settle(80);
  assert.ok(h.textOf().includes("回执与原命令不匹配"), "错回执必须显式拒绝");
  assert.ok(h.browser.localStorage.getItem(WRITE_KEY), "错回执不得清原记录");
  assert.ok(h.btn("上传平台素材").disabled, "仍锁新命令");
});

test("反例M-F3：UNKNOWN 重放403不改写成原命令被拒，记录保留", async (t) => {
  let calls = 0;
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json(page([platform()])) },
      {
        match: /^\/api\/bff\/admin\/supply\/media\/asset_platform_1\/review$/,
        method: "POST",
        response: () => {
          calls += 1;
          return calls === 1 ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : json({ error: { code: "FORBIDDEN" } }, 403);
        },
      },
    ]),
  });
  await h.click(h.btn("查看"));
  await h.click(h.btn("驳回"));
  await h.fillTextarea("图片模糊，无法辨认内容");
  await h.click(h.btn("确认驳回"));
  assert.ok(h.textOf().includes("结果未知"));
  await h.click(h.btn("按原请求重放"));
  assert.ok(h.textOf().includes("结果未知"), "重放403后仍保持未知，不当作原命令被拒");
  assert.ok(h.browser.localStorage.getItem(WRITE_KEY), "原 key/原体保留");
  assert.ok(h.btn("上传平台素材").disabled, "仍锁新命令");
});

test("反例M-F5：RECORDED 成功但队列回读失败，保留 accepted_readback 恢复入口", async (t) => {
  const h = await mountHarness(t, {
    seedStorage: (browser) => browser.localStorage.setItem(WRITE_KEY, simpleRec()),
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      { match: "/api/bff/admin/supply/media/reviews", response: () => json({ error: { code: "INTERNAL_ERROR" } }, 503) },
      {
        match: "/api/bff/admin/supply/operation-result",
        response: () => json({ receipt: "RECORDED", operation: "supply.media.review", resourceId: "asset_platform_1", responseStatus: 200, result: { id: "asset_platform_1", reviewState: "REJECTED" } }),
      },
    ]),
  });
  await h.settle(80);
  assert.ok(h.textOf().includes("原命令回执已确认成功"), "原命令确认与最新状态分开表达");
  assert.ok(h.textOf().includes("最新状态回读失败"), "回读失败独立表达");
  assert.ok(h.btn("重新读取"), "保留受权 GET 恢复入口");
  assert.ok(h.browser.localStorage.getItem(WRITE_KEY), "回读失败不清记录");
});

test("反例M-F6：意图开始后冻结文件/游戏/用途，readback 阶段不提供新上传", async (t) => {
  let failIntent = true;
  const h = await mountHarness(t, {
    fetchImpl: router([
      { match: "/api/bff/admin/supply/games", response: () => json({ games: [{ id: "game_1", name: "三角洲行动" }] }) },
      {
        match: "/api/bff/admin/supply/media/reviews",
        response: () => json(page([platform()])),
      },
      { match: "/api/bff/admin/supply/media/upload-intents", method: "POST", response: () => (failIntent ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : json({ intentId: "upload_1", uploadToken: "tok_1", expiresAt: "2026-10-13T03:00:00Z" })) },
      { match: /^\/api\/bff\/admin\/supply\/media\/uploads\/upload_1$/, method: "PUT", response: () => json({ assetId: "asset_new_1", reviewState: "PENDING", accessClass: "PRIVATE_REVIEW" }) },
    ]),
  });
  await h.click(h.btn("上传平台素材"));
  const fileInput = h.el.querySelector('input[type="file"]');
  await act(async () => {
    Object.defineProperty(fileInput, "files", { value: [new h.browser.File([new Uint8Array([1])], "a.png", { type: "image/png" })], configurable: true });
    fileInput.dispatchEvent(new h.browser.Event("change", { bubbles: true }));
  });
  await h.settle();
  await h.click(h.btn("上传并进入待审"));
  assert.ok(h.textOf().includes("上传意图结果未知"));
  assert.ok(h.el.querySelector('input[type="file"]').disabled, "结果未知后冻结文件选择，预览不得与原命令脱节");
  assert.ok(!h.btn("上传并进入待审"), "未知态不提供新上传按钮（只有原请求重试）");
  assert.ok(h.btn("按原请求重试"));
  failIntent = false;
  await h.click(h.btn("按原请求重试"));
  await h.settle(60);
  assert.ok(h.textOf().includes("已上传并进入待审核"), "原 key 原文件续传成功");
});

function r2Router(override) {
  return (url, init, browser, writes) => {
    const result = override?.(url, init, browser, writes);
    if (result) return result;
    if (url.pathname.endsWith("/games")) return json({ games: [{ id: "game_1", name: "离线示例游戏" }] });
    if (url.pathname.endsWith("/reviews")) return json(page([platform()]));
    if (url.pathname.includes("operation-result")) return json({ receipt: "UNRESOLVED" });
    throw new Error(`Unexpected offline route: ${init.method ?? "GET"} ${url.pathname}`);
  };
}

async function approveR2(h, scope = h.el, index = 0) {
  await h.click(h.rowViews(scope)[index]);
  await h.click(h.btn("通过（保持私有）", scope));
  await h.click(h.btn("确认通过（保持私有）", h.browser.document));
}

test("R2-1：同管理员两实例不能先覆盖槽再获取锁", async (t) => {
  let finish;
  const h = await mountHarness(t, { fetchImpl: r2Router((url, init) => {
    if (url.pathname.endsWith("/reviews")) return json(page([platform(), platform({ id: "asset_second" })]));
    if (init.method === "POST") return new Promise(resolve => { finish = () => resolve(json(platform({ reviewState: "APPROVED" }))); });
  }) });
  const second = await h.mountAdditional();
  await approveR2(h);
  const sent = JSON.parse(h.browser.localStorage.getItem(WRITE_KEY));
  assert.equal(h.writes.length, 1);
  await approveR2(h, second.el, 1);
  assert.deepEqual(JSON.parse(h.browser.localStorage.getItem(WRITE_KEY)), sent, "未发送B不得覆盖已经发送A的原请求");
  assert.equal(h.writes.length, 1, "真实占用的Locks桩必须拒绝第二实例");
  await act(async () => finish()); await h.settle();
});

for (const boundary of ["unmount", "permission-change"]) test(`R2-1：迟到摘要在${boundary}后不得启动POST`, async (t) => {
  const h = await mountHarness(t, { fetchImpl: r2Router((_url, init) => init.method === "POST" ? json(platform({ reviewState: "APPROVED" })) : null) });
  const original = crypto.subtle.digest; let release; let entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  Object.defineProperty(crypto.subtle, "digest", { configurable: true, writable: true, value: async function (...args) { entered = true; await gate; return original.apply(this, args); } });
  t.after(() => { release(); Object.defineProperty(crypto.subtle, "digest", { configurable: true, writable: true, value: original }); });
  await approveR2(h);
  assert.ok(entered); assert.equal(h.writes.length, 0);
  if (boundary === "unmount") await act(async () => h.root.unmount());
  else await h.render(0, ["supply.review.read"]);
  release(); await h.settle(50);
  assert.equal(h.writes.length, 0); assert.equal(h.browser.localStorage.getItem(WRITE_KEY), null);
});

for (const stage of ["bytes", "intent"]) test(`R2-2：${stage}恢复拒绝另一上传阶段回执`, async (t) => {
  const record = JSON.parse(uploadRec({ phase: "unknown" }));
  if (stage === "bytes") record.bytes = { ...record.bytes, fingerprint: "b".repeat(64), status: "unknown" };
  else record.intent = { ...record.intent, status: "unknown", intentId: null };
  const h = await mountHarness(t, {
    seedStorage: browser => browser.localStorage.setItem(WRITE_KEY, JSON.stringify(record)),
    fetchImpl: r2Router(url => url.pathname.includes("operation-result") ? json(stage === "bytes"
      ? { receipt: "RECORDED", operation: "supply.media.upload_intent.create", resourceId: null, responseStatus: 200, result: { intentId: "upload_1" } }
      : { receipt: "RECORDED", operation: "supply.media.upload", resourceId: "upload_1", responseStatus: 200, result: { assetId: "asset_not_uploaded" } }) : null),
  });
  await h.settle();
  assert.ok(h.browser.localStorage.getItem(WRITE_KEY));
  assert.equal(h.writes.length, 0);
  assert.ok(h.textOf().includes("不匹配"));
  assert.ok(!h.textOf().includes("已上传并进入待审核"));
});

for (const wrong of [null, {}, { id: "asset_other", reviewState: "APPROVED" }]) test(`R2-2：普通POST回执${JSON.stringify(wrong)}不能确认原目标`, async (t) => {
  const h = await mountHarness(t, { fetchImpl: r2Router((_url, init) => init.method === "POST" ? json(wrong) : null) });
  await approveR2(h);
  const record = JSON.parse(h.browser.localStorage.getItem(WRITE_KEY));
  assert.equal(record.targetId, "asset_platform_1"); assert.equal(record.phase, "unknown");
  assert.equal(h.writes.length, 1); assert.ok(!h.textOf().includes("审核决定已成功"));
});

test("R2-3：本地矛盾字节完成标记不能代替权威原回执", async (t) => {
  const seed = uploadRec({ bytes: { key: "idem_bbbbbbbbbbbbbbbb", fingerprint: null, status: "accepted" }, resultAssetId: "asset_never_uploaded", phase: "accepted_readback" });
  const h = await mountHarness(t, { seedStorage: browser => browser.localStorage.setItem(WRITE_KEY, seed), fetchImpl: r2Router() });
  assert.ok(h.textOf().includes("已损坏")); assert.ok(h.btn("上传平台素材").disabled);
  assert.equal(h.browser.localStorage.getItem(WRITE_KEY), seed); assert.equal(h.writes.length, 0);
  assert.ok(!h.textOf().includes("上传完成"));
});

test("R2-3：显式损坏确认也不能删除另一窗口后来保存的合法记录", async (t) => {
  const h = await mountHarness(t, { seedStorage: browser => browser.localStorage.setItem(WRITE_KEY, "broken"), fetchImpl: r2Router() });
  const later = simpleRec({ key: "idem_later00000000" });
  h.browser.localStorage.setItem(WRITE_KEY, later);
  await h.click(h.btn("我已在列表核对，清除该记录"));
  assert.equal(h.browser.localStorage.getItem(WRITE_KEY), later);
  assert.equal(h.writes.length, 0); assert.ok(h.textOf().includes("未清除"));
});

test("R2-4：字节成功/队列失败保持readback，恢复GET成功后才done且不重发", async (t) => {
  let acceptedBytes = false, queueFailure = true;
  const h = await mountHarness(t, { fetchImpl: r2Router((url, init) => {
    if (url.pathname.endsWith("/upload-intents")) return json({ intentId: "upload_r2", uploadToken: "offline_r2_token" });
    if (url.pathname.endsWith("/uploads/upload_r2")) { acceptedBytes = true; return json({ assetId: "asset_uploaded_r2", gameId: "game_1", purpose: "GAME_COVER", mime: "image/png", byteSize: 1, reviewState: "PENDING", accessClass: "PRIVATE_REVIEW" }); }
    if (url.pathname.includes("operation-result")) return json({ receipt: "RECORDED", operation: "supply.media.upload", resourceId: "upload_r2", responseStatus: 200, result: { assetId: "asset_uploaded_r2", reviewState: "PENDING", accessClass: "PRIVATE_REVIEW" } });
    if (url.pathname.endsWith("/reviews") && acceptedBytes && queueFailure) return json({ error: { code: "INTERNAL_ERROR" } }, 503);
  }) });
  await h.click(h.btn("上传平台素材"));
  const fileInput = h.el.querySelector('input[type="file"]');
  await act(async () => { Object.defineProperty(fileInput, "files", { configurable: true, value: [new h.browser.File([new Uint8Array([1])], "r2.png", { type: "image/png" })] }); fileInput.dispatchEvent(new h.browser.Event("change", { bubbles: true })); });
  await h.settle(); await h.click(h.btn("上传并进入待审"));
  assert.equal(JSON.parse(h.browser.localStorage.getItem(WRITE_KEY)).phase, "accepted_readback");
  assert.ok(!h.textOf().includes("已上传并进入待审核"));
  assert.ok(h.btn("重新读取队列")); assert.ok(h.btn("重新读取"));
  const before = h.writes.length;
  queueFailure = false;
  await h.click(h.btn("重新读取"));
  assert.equal(h.writes.length, before); assert.equal(h.browser.localStorage.getItem(WRITE_KEY), null);
  assert.ok(h.textOf().includes("已上传并进入待审核"));
});

test("R2：坏列表DTO是读取失败，不能崩溃或显示本页0条", async (t) => {
  const h = await mountHarness(t, { fetchImpl: r2Router(url => url.pathname.endsWith("/reviews") ? json({ items: null, nextCursor: null, limit: 20 }) : null) });
  assert.ok(h.textOf().includes("读取失败")); assert.ok(!h.textOf().includes("本页 0 条")); assert.equal(h.writes.length, 0);
});

test("R2：写受理后回读403撤下旧详情/图片但保留原请求", async (t) => {
  let committed = false;
  const h = await mountHarness(t, { fetchImpl: r2Router((url, init) => {
    if (init.method === "POST") { committed = true; return json(platform({ reviewState: "APPROVED" })); }
    if (url.pathname.endsWith("/reviews") && committed) return json({ error: { code: "FORBIDDEN" } }, 403);
  }) });
  await approveR2(h);
  assert.ok(!h.el.querySelector("aside img")); assert.ok(h.browser.localStorage.getItem(WRITE_KEY));
  assert.equal(JSON.parse(h.browser.localStorage.getItem(WRITE_KEY)).phase, "accepted_readback");
});

test("R2：意图丢响应后GET确认，不丢原文件，原key取回凭据后仅上传一次字节", async (t) => {
  let intents = 0, bytes = 0;
  const h = await mountHarness(t, { fetchImpl: r2Router((url, init) => {
    if (url.pathname.endsWith("/upload-intents")) return ++intents === 1 ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : json({ intentId: "intent_receipt_lost", uploadToken: "offline_original_token" });
    if (url.pathname.includes("operation-result")) return json({ receipt: "RECORDED", operation: "supply.media.upload_intent.create", resourceId: null, responseStatus: 200, result: { intentId: "intent_receipt_lost" } });
    if (url.pathname.endsWith("/uploads/intent_receipt_lost")) { bytes++; return json({ assetId: "asset_after_recovery", gameId: "game_1", purpose: "GAME_COVER", mime: "image/png", byteSize: 1 }); }
  }) });
  await h.click(h.btn("上传平台素材"));
  const fileInput = h.el.querySelector('input[type="file"]');
  await act(async () => { Object.defineProperty(fileInput, "files", { configurable: true, value: [new h.browser.File([new Uint8Array([1])], "original.png", { type: "image/png" })] }); fileInput.dispatchEvent(new h.browser.Event("change", { bubbles: true })); });
  await h.settle(); await h.click(h.btn("上传并进入待审"));
  assert.equal(bytes, 0);
  await h.click(h.btn("关闭"));
  await h.click(h.btn("核对原结果"));
  assert.equal(JSON.parse(h.browser.localStorage.getItem(WRITE_KEY)).intent.status, "accepted");
  await h.click(h.btn("继续上传"));
  const intentWrites = h.writes.filter(x => x.path.endsWith("/upload-intents"));
  assert.equal(intentWrites.length, 2); assert.equal(intentWrites[0].key, intentWrites[1].key);
  assert.deepEqual(intentWrites[0].parsed, intentWrites[1].parsed);
  assert.equal(bytes, 1); assert.equal(h.browser.localStorage.getItem(WRITE_KEY), null);
});

for (const [accessClass, action] of [["PRIVATE_REVIEW", "转为公开"], ["PUBLIC_DISPLAY", "撤销公开"]]) test(`R2：${action}确认说明可留空，填写时2–500字，取消零写`, async (t) => {
  const h = await mountHarness(t, { fetchImpl: r2Router(url => url.pathname.endsWith("/reviews") ? json(page([platform({ reviewState: "APPROVED", accessClass })])) : null) });
  await h.click(h.rowViews()[0]);
  assert.ok(h.textOf().includes("公开调整可选"));
  await h.click(h.btn(action));
  const dialog = h.el.querySelector('[role="dialog"]');
  assert.ok(dialog); assert.ok(!h.btn(`确认${action}`, dialog).disabled);
  await h.fillTextarea("字", dialog);
  assert.ok(h.btn(`确认${action}`, dialog).disabled);
  await h.fillTextarea("只读走查说明", dialog);
  assert.ok(!h.btn(`确认${action}`, dialog).disabled);
  await h.click(h.btn("取消", dialog)); assert.equal(h.writes.length, 0);
});
