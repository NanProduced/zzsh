import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

/**
 * W3 客服统计（服务时效缺口 + 图表 + 交接班摘要）的定向测试。
 * 只读接口：/im/support-overview 与 /im/handovers；不碰真实网络与数据库。
 */

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:4241/support?preview=1" });
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
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const clipboardWrites = [];
Object.defineProperty(browser.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (value) => { clipboardWrites.push(value); } },
});

browser.matchMedia = (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});

const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { SupportManagementPane } = await vite.ssrLoadModule("/src/views/im-support-management.tsx");
const model = await vite.ssrLoadModule("/src/views/im-support-management-model.ts");
const { adminRequest } = await vite.ssrLoadModule("/src/api.ts");
after(async () => { await vite.close(); });

function json(body, status = 200) {
  return new browser.Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function failure(status) {
  return new browser.Response(JSON.stringify({ error: { code: status === 403 ? "FORBIDDEN" : "INTERNAL_ERROR" } }), { status, headers: { "content-type": "application/json" } });
}

const requests = [];

const now = new Date();
const TODAY = new Date(now.getTime() - 60_000).toISOString();
const YESTERDAY = new Date(now.getTime() - 2 * 86_400_000).toISOString();

function baseFixture(overrides = {}) {
  return {
    overviewStatus: 200,
    handoverStatus: 200,
    overview: {
      onDuty: [
        { adminUserId: "admin-a", name: "客服 A", availability: "AVAILABLE", connectionState: "CONNECTED", activeLoad: 2, todaySeconds: 8100, todaySessions: 12, todayUsers: 9, currentOrderGroups: 3 },
        { adminUserId: "admin-b", name: "客服 B", availability: "PAUSED", connectionState: "DISCONNECTED", activeLoad: 1, todaySeconds: 3600, todaySessions: 4, todayUsers: 3, currentOrderGroups: 0 },
        { adminUserId: "admin-c", name: "客服 C", availability: "AVAILABLE", connectionState: "CONNECTED", activeLoad: 0, todaySeconds: 0, todaySessions: 0, todayUsers: 0, currentOrderGroups: 0 },
      ],
      totals: { onDutyCount: 2, waitingConsultations: 4, todaySessions: 12, todayUsers: 9 },
      trend: [{ date: "2026-10-29", sessions: 5, users: 3 }],
      hourly: [{ hour: 9, sessions: 4 }, { hour: 14, sessions: 7 }],
      ratings: { count: 3, average: 4.6666, distribution: [0, 0, 1, 1, 1], agents: [{ adminUserId: "admin-a", name: "客服 A", count: 3, average: 4.6666 }] },
    },
    handovers: {
      items: [
        { id: "h-1", objectType: "CONSULTATION", objectId: "c-1", display: "用户 A · 平台咨询", fromName: "客服 B", toName: "客服 A", note: "午休交接", createdAt: TODAY },
        { id: "h-2", objectType: "CONSULTATION", objectId: "c-2", display: "用户 B · 投诉", fromName: "客服 A", toName: "客服 C", note: null, createdAt: TODAY },
        { id: "h-3", objectType: "ORDER_GROUP", objectId: "o-1", display: "订单 DD-1", fromName: "客服 A", toName: "客服 B", note: null, createdAt: TODAY },
        { id: "h-4", objectType: "CONSULTATION", objectId: "c-9", display: "旧交接", fromName: "客服 C", toName: "客服 B", note: null, createdAt: YESTERDAY },
      ],
    },
    ...overrides,
  };
}

let fixture = baseFixture();

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), browser.location.href);
  const pathname = url.pathname;
  requests.push(`${pathname}${url.search}`);
  if (pathname.endsWith("/im/support-overview")) return fixture.overviewStatus === 200 ? json(fixture.overview) : failure(fixture.overviewStatus);
  if (pathname.endsWith("/im/handovers")) return fixture.handoverStatus === 200 ? json(fixture.handovers) : failure(fixture.handoverStatus);
  throw new Error(`unexpected test request ${pathname}${url.search}`);
};

async function settle(ms = 25) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function waitFor(predicate, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

async function mount(t) {
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await act(async () => { root.unmount(); });
    rootNode.remove();
  });
  await act(async () => {
    root.render(createElement(SupportManagementPane, {
      active: true, request: adminRequest, canTakeover: true, currentAdminUserId: "admin-a", currentAdminName: "客服 A",
    }));
  });
  await settle();
  await waitFor(() => rootNode.querySelector(".im-wb-mgmt"));
  return { rootNode, root };
}

/* ------------------------------ 纯数据层 ------------------------------ */

test("summarizeDuty 只统计在岗可接待与通道已连接，并把 presence 上报合计分开给", () => {
  const duty = model.summarizeDuty(fixture.overview.onDuty);
  assert.equal(duty.available, 2, "两台 AVAILABLE");
  assert.equal(duty.connected, 2, "两台通道已连接");
  assert.equal(duty.offDutyWithLoad, 1, "暂停但名下仍有接待的客服要被点名");
  assert.equal(duty.activeLoadTotal, 3, "activeLoad 合计 2+1+0");
  assert.deepEqual(duty.names, ["客服 A", "客服 C"]);
});

test("attentionSignals 只用真实事实给异常，容量关注线标注为本页口径", () => {
  const totals = { onDutyCount: 2, waitingConsultations: 4, todaySessions: 12, todayUsers: 9 };
  const signals = model.attentionSignals({ agents: fixture.overview.onDuty, totals });
  const ids = signals.map((item) => item.id);
  assert.ok(ids.includes("backlog"), "排队 4 > 在岗 2 必须报");
  assert.ok(ids.includes("off-duty-load"), "暂停但挂着会话必须报");
  const loaded = model.attentionSignals({
    agents: [{ ...fixture.overview.onDuty[0], activeLoad: model.SUPPORT_ATTENTION_LOAD_LINE }],
    totals: { onDutyCount: 1, waitingConsultations: 0, todaySessions: 0, todayUsers: 0 },
  });
  const loadLine = loaded.find((item) => item.id === "load-line");
  assert.ok(loadLine, "接待量达关注线时必须点名");
  assert.match(loadLine.detail, /本页口径/, "关注线不能冒充服务端容量事实");

  const none = model.attentionSignals({ agents: [], totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 0, todayUsers: 0 } });
  assert.deepEqual(none.map((item) => item.id), ["no-support"], "没人在岗时只报无人在岗");
  assert.equal(none[0].level, "high");

  const channelDown = model.attentionSignals({
    agents: [{ ...fixture.overview.onDuty[0], connectionState: "DISCONNECTED" }],
    totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 0, todayUsers: 0 },
  });
  assert.deepEqual(channelDown.map((item) => item.id), ["channel-down"]);

  const healthy = model.attentionSignals({
    agents: [{ ...fixture.overview.onDuty[0], activeLoad: 1 }],
    totals: { onDutyCount: 1, waitingConsultations: 1, todaySessions: 3, todayUsers: 2 },
  });
  assert.deepEqual(healthy, [], "没有异常时不给任何伪告警");
});

test("handoverStatsToday 带分母：只算最近读到的条数，满 50 条标记可能被截断", () => {
  const stats = model.handoverStatsToday(fixture.handovers.items);
  assert.equal(stats.scanned, 4, "分母是实际读到的条数");
  assert.equal(stats.total, 3, "今天 3 件，昨天那件不算");
  assert.equal(stats.consultation, 2);
  assert.equal(stats.orderGroup, 1);
  assert.equal(stats.truncated, false);

  const many = Array.from({ length: model.SUPPORT_HANDOVER_PAGE_LIMIT }, (_, index) => ({
    id: `h-${index}`, objectType: "CONSULTATION", objectId: "c", display: "d", fromName: "a", toName: "b", note: null, createdAt: TODAY,
  }));
  const capped = model.handoverStatsToday(many);
  assert.equal(capped.scanned, 50);
  assert.equal(capped.truncated, true, "到上限时必须承认可能被截断");
});

test("cumulativeSessions 用服务端 hourly 累加，不改写 0 时段", () => {
  const points = model.cumulativeSessions([{ hour: 9, sessions: 4 }, { hour: 14, sessions: 7 }]);
  assert.equal(points.length, 24);
  assert.equal(points[9].sessions, 4);
  assert.equal(points[9].cumulative, 4);
  assert.equal(points[10].cumulative, 4, "没有数据的时段累计不变");
  assert.equal(points[23].cumulative, 11);
});

test("ratingBuckets 固定 5→1 星且不丢索引", () => {
  const buckets = model.ratingBuckets({ count: 3, average: 4.6, distribution: [0, 0, 1, 1, 1], agents: [] });
  assert.deepEqual(buckets.map((bucket) => bucket.score), [5, 4, 3, 2, 1]);
  assert.deepEqual(buckets.map((bucket) => bucket.count), [1, 1, 1, 0, 0]);
});

test("handoverSummaryText 拼齐值班/待接待/接待中/交接/异常，并写明分母与缺口", () => {
  const text = model.handoverSummaryText({
    totals: fixture.overview.totals,
    agents: fixture.overview.onDuty,
    handovers: fixture.handovers.items,
    ratings: fixture.overview.ratings,
    now,
  });
  assert.match(text, /客服交接班摘要 · /);
  assert.match(text, /值班客服：客服 A、客服 C/);
  assert.match(text, /待接待：4 条（服务端 WAITING 全量）/);
  assert.match(text, /接待中：3 条/);
  assert.match(text, /今日：会话 12 · 用户 9 · 评价 3 条（平均 4.7）/);
  assert.match(text, /交接：今日 3 件（咨询 2 \/ 订单群 1）/);
  assert.match(text, /分母为最近 4 条交接记录/);
  assert.match(text, /异常：/);
  assert.match(text, /口径缺口：首响时长、解决时长、客服取消数/);
  assert.doesNotMatch(text, /售后/, "没有 AFTER_SALES 事实就不造售后指标");

  const withoutHandovers = model.handoverSummaryText({
    totals: fixture.overview.totals, agents: fixture.overview.onDuty, handovers: null, now,
  });
  assert.match(withoutHandovers, /交接：交接记录未读取，本摘要不含交接数/);
  assert.doesNotMatch(withoutHandovers, /今日 0 件/, "没读到记录不能写成 0 件");
});

/* ------------------------------ 看板渲染 ------------------------------ */

test("看板渲染服务时效卡：3 项缺口保留「—」，转交数用真实交接并写清分母", async (t) => {
  fixture = baseFixture();
  const { rootNode } = await mount(t);
  await waitFor(() => rootNode.querySelector('[data-panel="timeliness"]'));
  const panel = rootNode.querySelector('[data-panel="timeliness"]');
  const metrics = [...panel.querySelectorAll("[data-sla-metric]")];
  assert.deepEqual(metrics.map((node) => node.dataset.slaMetric), ["first-response", "resolution", "transfer", "support-cancel"]);
  const missing = metrics.filter((node) => node.dataset.missing === "true").map((node) => node.dataset.slaMetric);
  assert.deepEqual(missing, ["first-response", "resolution", "support-cancel"], "没有服务端事实的三个指标必须挂缺口");
  assert.ok(!missing.includes("transfer"), "转交数有真实交接记录支撑");
  const transfer = metrics.find((node) => node.dataset.slaMetric === "transfer");
  assert.match(transfer.textContent, /2/, "今日咨询交接 2 件");
  assert.match(transfer.textContent, /最近 4 条交接记录/, "分母必须写在卡片上");
  assert.match(transfer.textContent, /不是今日全量/);

  const gaps = [...panel.querySelectorAll("[data-sla-gap]")].map((node) => node.dataset.slaGap);
  assert.deepEqual(gaps, ["first-response", "resolution", "support-cancel"]);
  assert.match(panel.textContent, /首响时长/);
  assert.doesNotMatch(rootNode.textContent, /售后来源/, "没有事实的指标不上看板");
});

test("交接班摘要可复制：文本含值班/待接待/异常，复制成功有回显", async (t) => {
  fixture = baseFixture();
  clipboardWrites.length = 0;
  const { rootNode } = await mount(t);
  await waitFor(() => rootNode.querySelector('[data-panel="handover-summary"]'));
  const panel = rootNode.querySelector('[data-panel="handover-summary"]');
  const text = panel.querySelector("[data-handover-summary]").textContent;
  assert.match(text, /值班客服：客服 A、客服 C/);
  assert.match(text, /待接待：4 条/);
  assert.match(text, /异常：/);
  assert.match(panel.textContent, /项需关注/);

  const button = panel.querySelector('[data-action="copy-handover-summary"]');
  assert.ok(button, "摘要必须给复制按钮");
  await act(async () => button.click());
  await waitFor(() => panel.querySelector('[data-action="copy-handover-summary"]').textContent.includes("已复制"));
  assert.equal(clipboardWrites.length, 1);
  assert.match(clipboardWrites[0], /客服交接班摘要/);
  assert.match(clipboardWrites[0], /分母为最近 4 条交接记录/);
});

test("改图表用 recharts 落地：今日趋势、评分分布、按客服对比三张新图带真实点数", async (t) => {
  fixture = baseFixture();
  const { rootNode } = await mount(t);
  await waitFor(() => rootNode.querySelector('[data-chart="today-trend"]'));

  const trend = rootNode.querySelector('[data-chart="today-trend"]');
  assert.equal(trend.dataset.points, "2", "只有两个有数据的时段");
  assert.match(trend.textContent, /今日会话趋势/);
  assert.match(trend.textContent, /累计 11 次/, "4+7 的累计由 hourly 累加而来");

  const rating = rootNode.querySelector('[data-chart="rating-distribution"]');
  assert.equal(rating.dataset.count, "3");
  assert.match(rating.textContent, /3 条评价 · 平均 4.7/);

  const compare = rootNode.querySelector('[data-chart="agent-compare"]');
  assert.equal(compare.dataset.points, "3", "每名客服一组对比");
  assert.match(compare.textContent, /按客服对比/);

  assert.equal(rootNode.querySelectorAll(".im-wb-mgmt-chartbox").length >= 6, true, "六张图都拿到 SVG 画布");
});

test("交接记录读取失败：转交数保留「—」，摘要明说不含交接数，不写 0 件", async (t) => {
  fixture = baseFixture({ handoverStatus: 500 });
  const { rootNode } = await mount(t);
  await waitFor(() => rootNode.querySelector('[data-panel="timeliness"]'));
  const transfer = rootNode.querySelector('[data-sla-metric="transfer"]');
  assert.match(transfer.textContent, /—/);
  assert.match(transfer.textContent, /交接记录读取失败/);
  const summary = rootNode.querySelector('[data-handover-summary]').textContent;
  assert.match(summary, /交接：交接记录未读取，本摘要不含交接数/);
  assert.match(rootNode.querySelector('[data-panel="handover-summary"]').textContent, /交接记录未就绪/);
});
