import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 服务端 SLA / 容量 / 排队事实接上后再看一遍：能拿到事实就换成事实，
 * 拿不到就继续挂缺口（不估算、不补 0）。fixture 形状按 cs-dispatch 的契约。
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
browser.matchMedia = (query) => ({
  matches: false, media: query, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
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

const json = (body) => new browser.Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
let fixture = null;
globalThis.fetch = async (input) => {
  const pathname = new URL(String(input), browser.location.href).pathname;
  if (pathname.endsWith("/im/support-overview")) return json(fixture.overview);
  if (pathname.endsWith("/im/handovers")) return json({ items: [] });
  throw new Error(`unexpected test request ${pathname}`);
};

async function settle(ms = 20) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function waitFor(predicate, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("component condition timed out");
    await settle();
  }
}

const agent = (overrides = {}) => ({
  adminUserId: "admin-a", name: "客服 A", availability: "AVAILABLE", connectionState: "CONNECTED",
  activeLoad: 2, todaySeconds: 8100, todaySessions: 12, todayUsers: 9, currentOrderGroups: 3,
  capacityLimit: 3, totalLoad: 3, atCapacity: true, ...overrides,
});

const fullOverview = (overrides = {}) => ({
  reportDate: "2026-10-31",
  serverNow: "2026-10-31T04:00:00.000Z",
  onDuty: [agent()],
  totals: { onDutyCount: 1, waitingConsultations: 3, todaySessions: 12, todayUsers: 9, transfersToday: 4, handoversToday: 6 },
  trend: [],
  hourly: [{ hour: 9, sessions: 2 }],
  ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0], agents: [] },
  quality: {
    firstResponse: { slaSeconds: 120, averageSeconds: 47, sampleCount: 12, breached: 2, pending: 3, overdue: 1 },
    resolution: { averageSeconds: 1830, sampleCount: 9 },
  },
  queue: { queued: 3, oldestQueuedAt: "2026-10-31T03:00:00.000Z", oldestWaitSeconds: 640, onDuty: 1, withFreeSlot: 0, atCapacity: 1, capacityLimit: 3, reason: "ALL_AT_CAPACITY" },
  ...overrides,
});

/* ------------------------------ 解析 ------------------------------ */

test("quality / totals / capacity / queue 按契约解析；缺失保持 null 而不是 0", () => {
  const parsed = model.parseSupportOverview(fullOverview());
  assert.equal(parsed.quality.firstResponse.averageSeconds, 47);
  assert.equal(parsed.quality.firstResponse.sampleCount, 12);
  assert.equal(parsed.quality.firstResponse.overdue, 1);
  assert.equal(parsed.quality.resolution.averageSeconds, 1830);
  assert.equal(parsed.totals.transfersToday, 4);
  assert.equal(parsed.totals.handoversToday, 6);
  assert.equal(parsed.onDuty[0].capacityLimit, 3);
  assert.equal(parsed.onDuty[0].atCapacity, true);
  assert.equal(parsed.queue.reason, "ALL_AT_CAPACITY");
  assert.equal(parsed.queue.oldestWaitSeconds, 640);

  const sparse = model.parseSupportOverview({
    reportDate: "2026-10-31",
    serverNow: "2026-10-31T04:00:00.000Z",
    onDuty: [{ adminUserId: "admin-b", name: "客服 B", activeLoad: 1, todaySeconds: 0, todaySessions: 0, todayUsers: 0, currentOrderGroups: 0 }],
    totals: { onDutyCount: 0, waitilngConsultations: 0, waitingConsultations: 2, todaySessions: 1, todayUsers: 1 },
    trend: [],
    hourly: [],
    ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0], agents: [] },
  });
  assert.equal(sparse.quality, null, "整段缺失 → null，UI 才挂缺口");
  assert.equal(sparse.queue, null);
  assert.equal(sparse.totals.transfersToday, null, "未提供不是 0");
  assert.equal(sparse.totals.handoversToday, null);
  assert.equal(sparse.onDuty[0].capacityLimit, null);
  assert.equal(sparse.onDuty[0].atCapacity, null);
  assert.equal(sparse.onDuty[0].totalLoad, 1, "没有 totalLoad 时回退 activeLoad");
});

test("0 秒均值是真样本：有无样本看 sampleCount，不看 averageSeconds 是否为 0", () => {
  const parsed = model.parseSupportOverview(fullOverview({
    quality: { firstResponse: { slaSeconds: 120, averageSeconds: 0, sampleCount: 5, breached: 0, pending: 1, overdue: 0 }, resolution: { averageSeconds: 0, sampleCount: 2 } },
    ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0], agents: [] },
  }));
  assert.equal(parsed.quality.firstResponse.averageSeconds, 0, "0 秒是四舍五入后的真样本，不能当缺失");
  assert.equal(parsed.quality.firstResponse.sampleCount, 5);
  assert.equal(parsed.quality.resolution.averageSeconds, 0);
  assert.equal(model.formatSlaDuration(0), "<1 秒", "0 秒显示成 <1 秒，不显示 0 秒");
  assert.equal(parsed.ratings.average, null);
  assert.throws(() => model.parseSupportOverview(fullOverview({
    ratings: { count: 0, average: 0, distribution: [0, 0, 0, 0, 0], agents: [] },
  })), /客服统计数据不完整/, "评分均值 0 分不是合法值");

  const noSample = model.parseSupportOverview(fullOverview({
    quality: { firstResponse: { slaSeconds: 120, averageSeconds: null, sampleCount: 0, breached: 0, pending: 4, overdue: 2 }, resolution: { averageSeconds: null, sampleCount: 0 } },
  }));
  assert.equal(noSample.quality.firstResponse.averageSeconds, null);
  assert.equal(noSample.quality.firstResponse.sampleCount, 0);
  assert.equal(noSample.quality.firstResponse.overdue, 2, "未回但已超阈值的计数仍要保留");
});

test("formatSlaDuration 用秒/分表达，不把 47 秒写成 0h 0m", () => {
  assert.equal(model.formatSlaDuration(47), "47 秒");
  assert.equal(model.formatSlaDuration(1830), "30 分 30 秒");
  assert.equal(model.formatSlaDuration(120), "2 分");
  assert.equal(model.formatSlaDuration(null), "—");
  assert.equal(model.formatSlaDuration(-1), "—");
});

/* ------------------------------ 异常信号 ------------------------------ */

test("服务端给了排队原因就按原因报，不再用本页关注线冒充满载", () => {
  const totals = { onDutyCount: 1, waitingConsultations: 3, todaySessions: 12, todayUsers: 9, transfersToday: 4, handoversToday: 6 };
  const atCapacity = model.attentionSignals({ agents: [agent()], totals, queue: fullOverview().queue });
  const ids = atCapacity.map((item) => item.id);
  assert.ok(ids.includes("at-capacity"), "ALL_AT_CAPACITY 必须报");
  assert.equal(atCapacity.find((item) => item.id === "at-capacity").level, "high");
  assert.ok(ids.includes("queue-oldest"), "最久等待 640 秒要单独点名");
  assert.equal(atCapacity.find((item) => item.id === "queue-oldest").level, "high", "超过 5 分钟按严重报");
  assert.ok(ids.includes("at-capacity-agent"), "服务端 atCapacity=true 时点名到人");
  assert.ok(!ids.includes("load-line"), "有服务端容量事实时不再用本页关注线");

  const noStaff = model.attentionSignals({
    agents: [agent({ availability: "OFF_DUTY", activeLoad: 0, atCapacity: false, totalLoad: 0 })], totals,
    queue: { ...fullOverview().queue, reason: "NO_ONLINE_STAFF", withFreeSlot: 0 },
  });
  assert.ok(noStaff.some((item) => item.id === "no-support" && item.level === "high"));

  const free = model.attentionSignals({
    agents: [agent({ atCapacity: false, totalLoad: 1 })], totals,
    queue: { ...fullOverview().queue, reason: "CAPACITY_AVAILABLE", queued: 2, withFreeSlot: 1, atCapacity: 0 },
  });
  assert.ok(free.some((item) => item.id === "queue-undigested" && item.level === "watch"));

  const idle = model.attentionSignals({
    agents: [agent({ atCapacity: false, totalLoad: 1 })], totals: { ...totals, waitingConsultations: 0 },
    queue: { ...fullOverview().queue, reason: "CAPACITY_AVAILABLE", queued: 0, oldestWaitSeconds: null, atCapacity: 0 },
  });
  assert.deepEqual(idle, [], "没有排队、没有满载、通道正常时不给伪告警");
});

/* ------------------------------ 摘要 ------------------------------ */

test("摘要用服务端事实：首响/解决/转交/排队都是真数，缺口只剩客服取消", () => {
  const parsed = model.parseSupportOverview(fullOverview());
  const text = model.handoverSummaryText({
    totals: parsed.totals, agents: parsed.onDuty, handovers: [], ratings: parsed.ratings, quality: parsed.quality, queue: parsed.queue,
  });
  assert.match(text, /首响：平均 47 秒（样本 12 · 阈值 120 秒 · 超阈值 2 · 未回 3，其中已超 1）/);
  assert.match(text, /解决：平均 30 分 30 秒（样本 9）/);
  assert.match(text, /交接：转交 4 件 · 交接记录 6 件（服务端全量计数）/);
  assert.match(text, /排队：3 条（最久 10 分 40 秒） · 在岗 1 · 可接单 0 · 满载 1 · 上限 3 条\/人 · 原因 全部满载/);
  assert.match(text, /口径缺口：客服取消数/);
  assert.doesNotMatch(text, /最近 0 条交接记录/, "有服务端全量计数时不再用列表分母");
});

test("没有 quality 时摘要明说未提供，不编一个平均时长", () => {
  const parsed = model.parseSupportOverview({
    reportDate: "2026-10-31",
    serverNow: "2026-10-31T04:00:00.000Z",
    onDuty: [],
    totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 0, todayUsers: 0 },
    trend: [],
    hourly: [],
    ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0], agents: [] },
  });
  const text = model.handoverSummaryText({ totals: parsed.totals, agents: [], handovers: [], quality: parsed.quality, queue: parsed.queue });
  assert.match(text, /首响：服务端未提供聚合事实/);
  assert.match(text, /解决：服务端未提供聚合事实/);
  assert.match(text, /口径缺口：首响时长、解决时长、客服取消数/);
});

/* ------------------------------ 渲染 ------------------------------ */

test("看板把服务端事实换成数字：首响 47 秒、解决 30 分 30 秒、转交 4（全量）", async (t) => {
  fixture = { overview: fullOverview() };
  const rootNode = browser.document.createElement("div");
  browser.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => { await act(async () => { root.unmount(); }); rootNode.remove(); });
  await act(async () => {
    root.render(createElement(SupportManagementPane, { active: true, request: adminRequest, canTakeover: true, currentAdminUserId: "admin-a", currentAdminName: "客服 A" }));
  });
  await waitFor(() => rootNode.querySelector('[data-panel="timeliness"]'));

  const panel = rootNode.querySelector('[data-panel="timeliness"]');
  const metrics = Object.fromEntries([...panel.querySelectorAll("[data-sla-metric]")].map((node) => [node.dataset.slaMetric, node]));
  assert.match(metrics["first-response"].textContent, /47 秒/);
  assert.match(metrics["first-response"].textContent, /样本 12/);
  assert.equal(metrics["first-response"].dataset.missing, undefined, "有事实就不挂缺口徽标");
  assert.match(metrics.resolution.textContent, /30 分 30 秒/);
  assert.equal(metrics.resolution.dataset.missing, undefined);
  assert.match(metrics.transfer.textContent, /4/);
  assert.match(metrics.transfer.textContent, /今日转交/);
  assert.equal(metrics["support-cancel"], undefined, "简化统计页不再展示客服取消指标");
  assert.deepEqual([...panel.querySelectorAll("[data-sla-gap]")], []);
  assert.equal(rootNode.querySelector("[data-queue]"), null, "简化统计页把排队事实放在当前排队指标，不重复画队列面板");
  assert.equal(rootNode.querySelector('[data-panel="handover-summary"]'), null, "简化统计页不重复画交接摘要");
});
