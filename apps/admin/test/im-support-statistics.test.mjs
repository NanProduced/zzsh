import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, after } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = new Window({ url: "http://127.0.0.1:3101/workspace/support-mine" });
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = browser.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} };
const { createRoot } = await import("react-dom/client");

const vite = await createServer({
  root: adminRoot,
  plugins: [react()],
  resolve: { alias: { "@": path.join(adminRoot, "src") } },
  server: { middlewareMode: true, hmr: false },
});
const { parseMySupportStatistics, MySupportStatisticsView } = await vite.ssrLoadModule("/src/views/my-support-statistics.tsx");
const { SupportDashboard, SupportRatingBars } = await vite.ssrLoadModule("/src/views/im-support-statistics.tsx");
const reportRange = await vite.ssrLoadModule("/src/views/im-support-report-range.tsx");
const model = await vite.ssrLoadModule("/src/views/im-support-management-model.ts");
const { restoreTabs, persistTabs, tabFromLocation } = await vite.ssrLoadModule("/src/workspace/tab-model.ts");
const { PAGE_SEARCH_KEYWORDS, titleForPath } = await vite.ssrLoadModule("/src/workspace/nav-config.ts");
const { AdminApiError } = await vite.ssrLoadModule("/src/api.ts");
after(async () => { await vite.close(); });

test("custom range calendar keeps a hovered day mounted so mouse clicks can complete the range", async t => {
  const container = browser.document.createElement("div"); browser.document.body.append(container); const root = createRoot(container), changes = [];
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const range = { dateFrom: "2026-11-01", dateTo: "2026-11-01" };
  await act(async () => root.render(createElement(reportRange.SupportReportRangePicker, { value: { preset: "today", range }, displayRange: range, anchorDate: "2026-11-01", onChange: value => changes.push(value) })));
  await act(async () => container.querySelector("[data-range-trigger]").click());
  const button = name => [...browser.document.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === name);
  await act(async () => button("上一个月").click());
  const day = label => [...browser.document.querySelectorAll("button")].find(item => item.getAttribute("aria-label")?.startsWith(label));
  for (const label of ["2026年10月1日 ", "2026年10月2日 "]) {
    const target = day(label); assert.ok(target);
    await act(async () => target.dispatchEvent(new browser.MouseEvent("mouseover", { bubbles: true })));
    assert.equal(target.isConnected, true, "hover preview must not replace the day before its click");
    await act(async () => target.click());
  }
  assert.deepEqual(changes, [{ preset: "custom", range: { dateFrom: "2026-10-01", dateTo: "2026-10-02" } }]);
});

test("SupportDashboard: polling waits for a slow request instead of invalidating it", async t => {
  const originalSet = browser.setInterval.bind(browser), originalClear = browser.clearInterval.bind(browser);
  let tick;
  browser.setInterval = (callback, delay) => delay === 20000 ? (tick = callback, 200001) : originalSet(callback, delay);
  browser.clearInterval = id => id === 200001 ? undefined : originalClear(id);
  const container = browser.document.createElement("div"); browser.document.body.append(container);
  const root = createRoot(container), pending = [], calls = [];
  t.after(async () => { await act(async () => root.unmount()); container.remove(); browser.setInterval = originalSet; browser.clearInterval = originalClear; });
  const request = path => { calls.push(path); return new Promise(resolve => pending.push(resolve)); };
  await act(async () => root.render(createElement(SupportDashboard, { active: true, request })));
  assert.equal(calls.length, 1);
  for (let index = 0; index < 3; index++) await act(async () => tick());
  assert.equal(calls.length, 1, "background ticks cannot supersede the pending read");
  await act(async () => { pending[0](zeroOverview()); await Promise.resolve(); });
  assert.equal(container.querySelector('[data-page="support-overview"]').dataset.state, "ready");
  await act(async () => tick());
  assert.equal(calls.length, 2, "polling resumes after completion");
  await act(async () => tick());
  assert.equal(calls.length, 2);
  await act(async () => { pending[1](zeroOverview()); await Promise.resolve(); });
  assert.equal(container.querySelector('[data-page="support-overview"]').dataset.state, "ready");
});

function createSnapshot(adminUserId = "cs-agent-1", name = "客服小李") {
  return {
    authenticated: true,
    adminUserId,
    user: { name, username: adminUserId, displayUsername: name, twoFactorEnabled: true },
    security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    session: { id: "sess-1", locked: false, pinConfigured: true, createdAt: null, expiresAt: null },
    permissions: ["IM_SUPPORT_CHAT"],
  };
}

test("parseMySupportStatistics: strict validation of schema, dates, and non-negative numbers", () => {
  // Non-object
  assert.throws(() => parseMySupportStatistics(null), /无效的个人接待数据响应/);
  assert.throws(() => parseMySupportStatistics(undefined), /无效的个人接待数据响应/);
  assert.throws(() => parseMySupportStatistics("string"), /无效的个人接待数据响应/);

  const base = {
    reportDate: "2026-11-01",
    serverNow: "2026-11-01T12:00:00.000Z",
    today: { seconds: 3600, sessions: 12, users: 10 },
    current: { consultations: 3, orderGroups: 2, unread: 5, oldestPendingAt: null },
    ratings: { count: 9, average: 4.5, distribution: [7, 0, 0, 0, 2] },
    firstResponse: { sampleCount: 10, averageSeconds: 45 },
  };

  // Valid parses cleanly
  const parsed = parseMySupportStatistics(base);
  assert.equal(parsed.reportDate, "2026-11-01");
  assert.equal(parsed.today.seconds, 3600);
  assert.equal(parsed.current.consultations, 3);
  assert.equal(parsed.ratings.distribution[4], 2);

  // Missing or invalid reportDate
  assert.throws(() => parseMySupportStatistics({ ...base, reportDate: "2026/11/01" }), /缺失或无效的报表日期/);
  assert.throws(() => parseMySupportStatistics({ ...base, reportDate: "" }), /缺失或无效的报表日期/);

  // Missing or invalid serverNow
  assert.throws(() => parseMySupportStatistics({ ...base, serverNow: "not-a-date" }), /缺失或无效的服务器时间/);
  assert.throws(() => parseMySupportStatistics({ ...base, serverNow: "" }), /缺失或无效的服务器时间/);
  assert.throws(() => parseMySupportStatistics({ ...base, serverNow: null }), /缺失或无效的服务器时间/);

  // Missing or invalid today
  assert.throws(() => parseMySupportStatistics({ ...base, today: null }), /缺失所选期间接待数据/);
  assert.throws(() => parseMySupportStatistics({ ...base, today: { ...base.today, seconds: -1 } }), /所选期间接待数据格式错误/);
  assert.throws(() => parseMySupportStatistics({ ...base, today: { ...base.today, sessions: "12" } }), /所选期间接待数据格式错误/);

  // Missing or invalid current
  assert.throws(() => parseMySupportStatistics({ ...base, current: null }), /缺失当前接待数据/);
  assert.throws(() => parseMySupportStatistics({ ...base, current: { ...base.current, unread: -5 } }), /当前接待数据格式错误/);

  // Missing or invalid ratings
  assert.throws(() => parseMySupportStatistics({ ...base, ratings: null }), /缺失评价数据/);
  assert.throws(() => parseMySupportStatistics({ ...base, ratings: { ...base.ratings, count: -1 } }), /评价数格式错误/);
  assert.throws(() => parseMySupportStatistics({ ...base, ratings: { ...base.ratings, average: 6.0 } }), /平均分格式错误/);
  assert.throws(() => parseMySupportStatistics({ ...base, ratings: { ...base.ratings, distribution: [1, 2, 3] } }), /评价星级分布格式错误/);
  assert.throws(() => parseMySupportStatistics({ ...base, ratings: { ...base.ratings, distribution: [1, 2, 3, 4, -1] } }), /评价星级分布格式错误/);

  // Missing or invalid firstResponse
  assert.throws(() => parseMySupportStatistics({ ...base, firstResponse: null }), /缺失首响数据/);
  assert.throws(() => parseMySupportStatistics({ ...base, firstResponse: { ...base.firstResponse, sampleCount: -1 } }), /首响应样本数格式错误/);
  assert.throws(() => parseMySupportStatistics({ ...base, firstResponse: { ...base.firstResponse, averageSeconds: -10 } }), /首响应平均时长格式错误/);
});

const zeroOverview = (overrides = {}) => ({
  reportDate: "2026-11-01",
  serverNow: "2026-11-01T04:00:00.000Z",
  period: { dateFrom: "2026-11-01", dateTo: "2026-11-01", days: 1, timeZone: "Asia/Shanghai", trendFrom: "2026-10-26", trendTo: "2026-11-01" },
  totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 0, todayUsers: 0, transfersToday: 0, handoversToday: 0 },
  onDuty: [],
  trend: [],
  hourly: [],
  ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0], agents: [] },
  quality: { firstResponse: { slaSeconds: 120, averageSeconds: null, sampleCount: 0, askedCount: 0, breached: 0, pending: 0, overdue: 0 }, resolution: { averageSeconds: null, sampleCount: 0 } },
  queue: null,
  ...overrides,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const myPayload = (overrides = {}) => ({
  reportDate: "2026-11-01",
  serverNow: "2026-11-01T12:00:00.000Z",
  period: { dateFrom: "2026-11-01", dateTo: "2026-11-01", days: 1, timeZone: "Asia/Shanghai", trendFrom: "2026-10-26", trendTo: "2026-11-01" },
  today: { seconds: 3600, sessions: 10, users: 8 },
  current: { consultations: 2, orderGroups: 1, unread: 3, oldestPendingAt: null },
  ratings: { count: 1, average: 5, distribution: [0, 0, 0, 0, 1] },
  firstResponse: { sampleCount: 1, averageSeconds: 30 },
  ...overrides,
});

test("support report range helpers: presets, inclusive limits, server anchor and explicit query", () => {
  assert.deepEqual(reportRange.presetRange("today", "2026-11-01"), { dateFrom: "2026-11-01", dateTo: "2026-11-01" });
  assert.deepEqual(reportRange.presetRange("7d", "2026-11-01"), { dateFrom: "2026-10-26", dateTo: "2026-11-01" });
  assert.deepEqual(reportRange.presetRange("30d", "2026-11-01"), { dateFrom: "2026-10-03", dateTo: "2026-11-01" });
  assert.deepEqual(reportRange.presetRange("month", "2026-11-15"), { dateFrom: "2026-11-01", dateTo: "2026-11-15" });
  assert.deepEqual(reportRange.presetRange("lastMonth", "2026-01-15"), { dateFrom: "2025-12-01", dateTo: "2025-12-31" });
  assert.deepEqual(reportRange.presetRange("year", "2026-11-01"), { dateFrom: "2026-01-01", dateTo: "2026-11-01" });
  assert.equal(reportRange.supportRangeDays("2025-01-01", "2026-01-01"), 366);
  assert.equal(reportRange.validateSupportRange("2025-01-01", "2026-01-01").ok, true);
  assert.equal(reportRange.validateSupportRange("2025-01-01", "2026-01-02").ok, false);
  assert.equal(reportRange.validateSupportRange("2026-11-02", "2026-11-01").ok, false);
  assert.equal(reportRange.validateSupportRange("", "2026-11-01").ok, false);
  const resolved = reportRange.resolveSupportRange({ preset: "7d", range: null }, "2026-11-01");
  assert.equal(resolved.query, "?dateFrom=2026-10-26&dateTo=2026-11-01");
  assert.doesNotMatch(resolved.query, /date=/);
  assert.equal(reportRange.resolveSupportRange({ preset: "today", range: null }, null).query, "");
  assert.equal(reportRange.anchorDateOf("2026-10-31T16:30:00.000Z"), "2026-11-01");
  assert.equal(reportRange.rangeScopeWord({ dateFrom: "2026-11-01", dateTo: "2026-11-01" }, "2026-11-01"), "今日");
  assert.equal(reportRange.rangeScopeWord({ dateFrom: "2026-10-01", dateTo: "2026-10-31" }, "2026-11-01"), "期间");
});

test("overview parsing rejects missing required stats and accepts a real all-zero period", () => {
  assert.throws(() => model.parseSupportOverview({}), /客服统计数据不完整/);
  assert.throws(() => model.parseSupportOverview({ ...zeroOverview(), totals: undefined }), /客服统计数据不完整/);
  assert.throws(() => model.parseSupportOverview({ ...zeroOverview(), ratings: undefined }), /客服统计数据不完整/);
  const parsed = model.parseSupportOverview(zeroOverview());
  assert.equal(parsed.totals.todaySessions, 0);
  assert.equal(parsed.ratings.count, 0);
  assert.equal(parsed.period.dateFrom, "2026-11-01");
  assert.equal(parsed.onDuty.length, 0);
});

test("SupportDashboard: period response changes titles away from today", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const payload = zeroOverview({
    reportDate: "2026-10-31",
    period: { dateFrom: "2026-10-01", dateTo: "2026-10-31", days: 31, timeZone: "Asia/Shanghai", trendFrom: "2026-10-01", trendTo: "2026-10-31" },
    totals: { onDutyCount: 1, waitingConsultations: 2, todaySessions: 31, todayUsers: 20, transfersToday: 4, handoversToday: 0 },
    trend: [{ date: "2026-10-01", sessions: 1, users: 1 }, { date: "2026-10-31", sessions: 2, users: 2 }],
  });
  await act(async () => {
    root.render(createElement(SupportDashboard, { active: true, request: async () => payload }));
  });
  const text = container.textContent;
  assert.match(text, /期间接待咨询/);
  assert.match(text, /期间评价/);
  assert.match(text, /期间每小时新咨询/);
  assert.match(text, /期间接待时长/);
  assert.doesNotMatch(text, /今日评价|今日接待时长|今日新建咨询/);
  assert.equal(container.querySelector(".im-wb-mgmt-dashboard").dataset.periodFrom, "2026-10-01");
  root.unmount();
  container.remove();
});

test("SupportDashboard: explicit range request uses dateFrom/dateTo and ignores a late response", async () => {
  const wrapper = browser.document.createElement("div");
  wrapper.className = "workspace-root";
  browser.document.body.appendChild(wrapper);
  const container = browser.document.createElement("div");
  wrapper.appendChild(container);
  const root = createRoot(container);
  const calls = [];
  const pending = [];
  const request = (path) => {
    calls.push(path);
    const call = deferred();
    pending.push({ path, ...call });
    return call.promise;
  };
  await act(async () => {
    root.render(createElement(SupportDashboard, { active: true, request }));
  });
  assert.equal(calls[0], "/im/support-overview");
  await act(async () => {
    pending[0].resolve(zeroOverview({ totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 1, todayUsers: 1, transfersToday: 0, handoversToday: 0 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelector(".im-wb-mgmt-dashboard").dataset.periodFrom, "2026-11-01");

  const openPicker = async () => {
    const trigger = container.querySelector("[data-range-trigger]");
    assert.ok(trigger, "range trigger is present");
    await act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await openPicker();
  const seven = browser.document.querySelector('[data-range-preset="7d"]');
  assert.ok(seven, "quick range preset is available");
  await act(async () => { seven.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(calls[1], "/im/support-overview?dateFrom=2026-10-26&dateTo=2026-11-01");
  assert.doesNotMatch(calls[1], /date=/);
  assert.equal(container.querySelector('[data-panel="on-duty"]'), null, "old period is cleared while the new range is loading");
  assert.match(container.textContent, /正在读取/);

  await openPicker();
  const thirty = browser.document.querySelector('[data-range-preset="30d"]');
  assert.ok(thirty, "second quick range preset is available");
  await act(async () => { thirty.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(calls[2], "/im/support-overview?dateFrom=2026-10-03&dateTo=2026-11-01");

  await act(async () => {
    pending[1].resolve(zeroOverview({
      reportDate: "2026-11-01",
      period: { dateFrom: "2026-10-26", dateTo: "2026-11-01", days: 7, timeZone: "Asia/Shanghai", trendFrom: "2026-10-26", trendTo: "2026-11-01" },
      totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 7, todayUsers: 7, transfersToday: 0, handoversToday: 0 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelector('[data-panel="on-duty"]'), null, "late 7-day result is ignored while the 30-day request is pending");
  assert.match(container.textContent, /正在读取/);

  await act(async () => {
    pending[2].resolve(zeroOverview({
      reportDate: "2026-11-01",
      period: { dateFrom: "2026-10-03", dateTo: "2026-11-01", days: 30, timeZone: "Asia/Shanghai", trendFrom: "2026-10-03", trendTo: "2026-11-01" },
      totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 30, todayUsers: 20, transfersToday: 0, handoversToday: 0 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelector(".im-wb-mgmt-dashboard").dataset.periodFrom, "2026-10-03");
  assert.equal([...container.querySelectorAll(".im-wb-mgmt-metric-value")][2].textContent, "30");

  root.unmount();
  container.remove();
  wrapper.remove();
});

test("SupportDashboard: explicit range without period or unsupported API fails visibly", async () => {
  const wrapper = browser.document.createElement("div");
  wrapper.className = "workspace-root";
  browser.document.body.appendChild(wrapper);
  const container = browser.document.createElement("div");
  wrapper.appendChild(container);
  const root = createRoot(container);
  const calls = [];
  const pending = [];
  const request = (path) => {
    calls.push(path);
    const call = deferred();
    pending.push({ path, ...call });
    return call.promise;
  };
  await act(async () => { root.render(createElement(SupportDashboard, { active: true, request })); });
  await act(async () => {
    pending[0].resolve(zeroOverview({ totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 1, todayUsers: 1, transfersToday: 0, handoversToday: 0 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const openPicker = async () => {
    const trigger = container.querySelector("[data-range-trigger]");
    assert.ok(trigger);
    await act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await openPicker();
  await act(async () => { browser.document.querySelector('[data-range-preset="7d"]').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => {
    pending[1].resolve(zeroOverview({ period: null }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.textContent, /服务端未返回所选区间/);
  assert.equal(container.querySelectorAll(".im-wb-mgmt-metric").length, 0, "no zero fallback when period is missing");

  await openPicker();
  await act(async () => { browser.document.querySelector('[data-range-preset="30d"]').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => {
    pending[2].reject(new AdminApiError(404, "NOT_FOUND"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.textContent, /尚未支持所选时间范围/);
  assert.equal(container.querySelectorAll(".im-wb-mgmt-metric").length, 0, "unsupported range does not fall back to today");

  root.unmount();
  container.remove();
  wrapper.remove();
});

test("SupportDashboard: same-period refresh failure keeps the last result labelled", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  let calls = 0;
  const request = async () => {
    calls += 1;
    if (calls === 1) return zeroOverview({ totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 1, todayUsers: 1, transfersToday: 0, handoversToday: 0 } });
    throw new AdminApiError(500, "INTERNAL_ERROR");
  };
  await act(async () => { root.render(createElement(SupportDashboard, { active: true, request })); });
  assert.equal(container.querySelectorAll(".im-wb-mgmt-metric-value")[2].textContent, "1");
  await act(async () => {
    container.querySelector('[data-action="refresh-dashboard"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelectorAll(".im-wb-mgmt-metric-value")[2].textContent, "1", "old same-period result stays visible");
  assert.match(container.textContent, /刷新失败，以下仍是上次结果/);
  root.unmount();
  container.remove();
});

test("SupportDashboard: a locked session clears the old projection", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  let calls = 0;
  const request = async () => {
    calls += 1;
    if (calls === 1) return zeroOverview({ totals: { onDutyCount: 0, waitingConsultations: 0, todaySessions: 1, todayUsers: 1, transfersToday: 0, handoversToday: 0 } });
    throw new AdminApiError(423, "LOCKED");
  };
  await act(async () => { root.render(createElement(SupportDashboard, { active: true, request })); });
  assert.equal(container.querySelectorAll(".im-wb-mgmt-metric-value")[2].textContent, "1");
  await act(async () => {
    container.querySelector('[data-action="refresh-dashboard"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelectorAll(".im-wb-mgmt-metric-value").length, 0, "locked response clears the old projection");
  assert.match(container.textContent, /本次会话已锁定/);
  root.unmount();
  container.remove();
});

test("SupportDashboard: long ranges use a line chart and never show the old summed legend", async (t) => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const trend = Array.from({ length: 40 }, (_, index) => ({ date: reportRange.addSupportDays("2026-09-01", index), sessions: 1, users: 1 }));
  const payload = zeroOverview({
    reportDate: "2026-10-10",
    period: { dateFrom: "2026-09-01", dateTo: "2026-10-10", days: 40, timeZone: "Asia/Shanghai", trendFrom: "2026-09-01", trendTo: "2026-10-10" },
    trend,
  });
  await act(async () => { root.render(createElement(SupportDashboard, { active: true, request: async () => payload })); });
  const card = container.querySelector('[data-chart="trend"]');
  assert.equal(card.dataset.kind, "line");
  assert.equal(card.dataset.points, "40");
  assert.equal(container.querySelector(".im-wb-mgmt-chart-summary"), null, "summed cross-day legend is removed");
});

test("MySupportStatisticsView: renders star distribution in API order (1星 -> 5星) without inversion", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);

  // distribution: index 0 is 1-star (7 counts), index 4 is 5-star (2 counts)
  const mockPayload = {
    reportDate: "2026-11-01",
    serverNow: "2026-11-01T12:00:00.000Z",
    today: { seconds: 7200, sessions: 20, users: 15 },
    current: { consultations: 4, orderGroups: 1, unread: 2, oldestPendingAt: null },
    ratings: { count: 9, average: 2.1, distribution: [7, 0, 0, 0, 2] },
    firstResponse: { sampleCount: 15, averageSeconds: 30 },
  };

  const requestedPaths = [];
  const request = async (path) => {
    requestedPaths.push(path);
    if (path === "/im/my-support-statistics") return mockPayload;
    throw new Error(`Unexpected request: ${path}`);
  };

  await act(async () => {
    root.render(createElement(MySupportStatisticsView, {
      active: true,
      request,
      snapshot: createSnapshot(),
    }));
  });

  assert.deepEqual(requestedPaths, ["/im/my-support-statistics"], "self-only request has no employee id or browser date");
  const text = container.textContent;
  assert.match(text, /2026-11-01/);
  assert.match(text, /更新于/);
  assert.match(text, /评价星级分布（1 星 → 5 星）/);
  assert.match(text, /仅本人/);
  assert.match(text, /今日接待咨询/);
  assert.match(text, /今日接待用户/);
  assert.doesNotMatch(text, /容量|接待上限|考核/);

  const distribution = container.querySelector('[data-panel="personal-quality"] [data-chart="rating-distribution"]');
  assert.ok(distribution, "one chart presents the real distribution");
  const summary = distribution.getAttribute("aria-label");
  assert.match(summary, /5 星 2 条/);
  assert.match(summary, /1 星 7 条/);
  assert.doesNotMatch(summary, /5 星 7 条/);
  assert.ok(summary.indexOf("1 星 7 条") < summary.indexOf("5 星 2 条"), "1 star precedes 5 stars like the API distribution");
  assert.equal(distribution.tabIndex, 0, "rating chart is keyboard reachable");

  // Also verify oldestPendingAt fallback text
  assert.match(text, /有未读会话的首次留言时间/);
  assert.match(text, /暂无待跟进留言/);

  root.unmount();
  container.remove();
});

test("MySupportStatisticsView: renders oldest pending message timestamp and navigation button", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);

  const mockPayload = {
    reportDate: "2026-11-01",
    serverNow: "2026-11-01T12:00:00.000Z",
    today: { seconds: 3600, sessions: 10, users: 8 },
    current: {
      consultations: 2,
      orderGroups: 1,
      unread: 3,
      oldestPendingAt: "2026-11-01T11:45:00.000Z",
    },
    ratings: { count: 5, average: 5.0, distribution: [0, 0, 0, 0, 5] },
    firstResponse: { sampleCount: 5, averageSeconds: 20 },
  };

  let openedPath = null;
  const request = async () => mockPayload;

  await act(async () => {
    root.render(createElement(MySupportStatisticsView, {
      active: true,
      request,
      snapshot: createSnapshot(),
      onOpenPath: (path) => { openedPath = path; },
    }));
  });

  const text = container.textContent;
  assert.match(text, /有未读会话的首次留言时间/);
  assert.doesNotMatch(text, /暂无待跟进留言/);
  assert.match(text, /19:45|11:45/); // Formatted date string

  // Check navigation button
  const navBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent.includes("前往工作台"));
  assert.ok(navBtn, "Expected '前往工作台' button");
  await act(async () => {
    navBtn.click();
  });
  assert.equal(openedPath, "/support");

  root.unmount();
  container.remove();
});


test("MySupportStatisticsView: zero ratings shows honest empty state without chart", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);

  const mockPayload = {
    reportDate: "2026-11-01",
    serverNow: "2026-11-01T12:00:00.000Z",
    today: { seconds: 0, sessions: 0, users: 0 },
    current: { consultations: 0, orderGroups: 0, unread: 0, oldestPendingAt: null },
    ratings: { count: 0, average: null, distribution: [0, 0, 0, 0, 0] },
    firstResponse: { sampleCount: 0, averageSeconds: null },
  };

  await act(async () => {
    root.render(createElement(MySupportStatisticsView, {
      active: true,
      request: async () => mockPayload,
      snapshot: createSnapshot(),
    }));
  });

  const text = container.textContent;
  assert.match(text, /今日暂无评价/);
  assert.equal(container.querySelector('[data-panel="personal-quality"] [data-chart="rating-distribution"]'), null, "no rating chart when count is 0");

  root.unmount();
  container.remove();
});

test("MySupportStatisticsView: historical period keeps current pending facts", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const requested = [];
  const payload = myPayload({
    reportDate: "2026-10-31",
    period: { dateFrom: "2026-10-01", dateTo: "2026-10-31", days: 31, timeZone: "Asia/Shanghai", trendFrom: "2026-10-01", trendTo: "2026-10-31" },
    today: { seconds: 7200, sessions: 31, users: 20 },
    current: { consultations: 2, orderGroups: 1, unread: 5, oldestPendingAt: "2026-11-01T03:45:00.000Z" },
  });
  await act(async () => {
    root.render(createElement(MySupportStatisticsView, {
      active: true,
      request: async (path) => { requested.push(path); return payload; },
      snapshot: createSnapshot(),
    }));
  });
  assert.deepEqual(requested, ["/im/my-support-statistics"]);
  const text = container.textContent;
  assert.match(text, /期间接待咨询/);
  assert.match(text, /期间接待用户/);
  assert.match(text, /当前未读消息/);
  assert.match(text, /当前负责咨询数/);
  assert.match(text, /当前负责在租订单群数/);
  assert.match(text, /2 条/);
  assert.match(text, /1 组/);
  assert.match(text, /有未读会话的首次留言时间/);
  assert.match(text, /11:45|03:45/);
  assert.doesNotMatch(text, /容量|接待上限|考核/);
  assert.ok(container.querySelector('button[aria-label="我的接待口径"]'));
  root.unmount();
  container.remove();
});

test("MySupportStatisticsView: range selection queries self stats with dateFrom/dateTo only", async () => {
  const wrapper = browser.document.createElement("div");
  wrapper.className = "workspace-root";
  browser.document.body.appendChild(wrapper);
  const container = browser.document.createElement("div");
  wrapper.appendChild(container);
  const root = createRoot(container);
  const calls = [];
  const pending = [];
  const request = (path) => {
    calls.push(path);
    const call = deferred();
    pending.push({ path, ...call });
    return call.promise;
  };
  await act(async () => {
    root.render(createElement(MySupportStatisticsView, { active: true, request, snapshot: createSnapshot() }));
  });
  await act(async () => {
    pending[0].resolve(myPayload());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    container.querySelector("[data-range-trigger]").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    browser.document.querySelector('[data-range-preset="7d"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(calls[1], "/im/my-support-statistics?dateFrom=2026-10-26&dateTo=2026-11-01");
  assert.doesNotMatch(calls[1], /adminUserId|employee|date=/);
  await act(async () => {
    pending[1].resolve(myPayload({
      reportDate: "2026-11-01",
      period: { dateFrom: "2026-10-26", dateTo: "2026-11-01", days: 7, timeZone: "Asia/Shanghai", trendFrom: "2026-10-26", trendTo: "2026-11-01" },
      today: { seconds: 7200, sessions: 7, users: 5 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(container.querySelector(".im-wb-mgmt-dashboard").dataset.periodFrom, "2026-10-26");
  assert.equal(container.querySelectorAll(".im-wb-mgmt-metric-value")[1].textContent, "7");
  root.unmount();
  container.remove();
  wrapper.remove();
});

test("MySupportStatisticsView: explicit range without period is not treated as today", async () => {
  const wrapper = browser.document.createElement("div");
  wrapper.className = "workspace-root";
  browser.document.body.appendChild(wrapper);
  const container = browser.document.createElement("div");
  wrapper.appendChild(container);
  const root = createRoot(container);
  const pending = [];
  const request = () => {
    const call = deferred();
    pending.push(call);
    return call.promise;
  };
  await act(async () => {
    root.render(createElement(MySupportStatisticsView, { active: true, request, snapshot: createSnapshot() }));
  });
  await act(async () => {
    pending[0].resolve(myPayload());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    container.querySelector("[data-range-trigger]").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    browser.document.querySelector('[data-range-preset="7d"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    pending[1].resolve(myPayload({ period: null }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.textContent, /服务端未返回所选区间/);
  assert.equal(container.querySelectorAll(".im-wb-mgmt-metric").length, 0);
  root.unmount();
  container.remove();
  wrapper.remove();
});

test("MySupportStatisticsView: identity changes ignore the previous self's late response", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const pending = [];
  const request = () => {
    const call = deferred();
    pending.push(call);
    return call.promise;
  };
  await act(async () => {
    root.render(createElement(MySupportStatisticsView, { active: true, request, snapshot: createSnapshot("cs-agent-1", "客服甲") }));
  });
  await act(async () => {
    root.render(createElement(MySupportStatisticsView, { active: true, request, snapshot: createSnapshot("cs-agent-2", "客服乙") }));
  });
  assert.equal(pending.length, 2, "identity change starts a new request");
  await act(async () => {
    pending[0].resolve(myPayload({ today: { seconds: 60, sessions: 11, users: 9 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.doesNotMatch(container.textContent, /客服甲/);
  assert.equal([...container.querySelectorAll(".im-wb-mgmt-metric-value")].some((node) => node.textContent === "11"), false);
  await act(async () => {
    pending[1].resolve(myPayload({ today: { seconds: 60, sessions: 22, users: 9 }, current: { consultations: 1, orderGroups: 1, unread: 2, oldestPendingAt: null } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.textContent, /客服乙/);
  assert.equal([...container.querySelectorAll(".im-wb-mgmt-metric-value")].some((node) => node.textContent === "22"), true);
  root.unmount();
  container.remove();
});

test("MySupportStatisticsView: manual refresh replaces self data and forbidden clears it", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const payload = (sessions) => ({
    reportDate: "2026-11-01",
    serverNow: "2026-11-01T12:00:00.000Z",
    today: { seconds: 3600, sessions, users: 8 },
    current: { consultations: 1, orderGroups: 1, unread: 1, oldestPendingAt: null },
    ratings: { count: 1, average: 5, distribution: [0, 0, 0, 0, 1] },
    firstResponse: { sampleCount: 1, averageSeconds: 30 },
  });
  let sessions = 10;
  let forbidden = false;
  const request = async () => {
    if (forbidden) throw new AdminApiError(403, "FORBIDDEN");
    return payload(sessions);
  };

  await act(async () => {
    root.render(createElement(MySupportStatisticsView, { active: true, request, snapshot: createSnapshot() }));
  });
  const metricValue = () => [...container.querySelectorAll(".im-wb-mgmt-metric")]
    .find((card) => card.textContent.includes("今日接待咨询"))
    ?.querySelector(".im-wb-mgmt-metric-value")?.textContent;
  assert.equal(metricValue(), "10");

  sessions = 22;
  await act(async () => {
    container.querySelector('[data-action="refresh-mine"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(metricValue(), "22");

  forbidden = true;
  await act(async () => {
    container.querySelector('[data-action="refresh-mine"]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.textContent, /无权查看个人接待数据/);
  assert.match(container.textContent, /客服接待读取/);
  assert.ok(container.querySelector('.im-wb-mgmt-state[data-state="forbidden"]'), "403 uses the dedicated forbidden state");
  assert.equal(container.querySelector('[data-chart="rating-distribution"]'), null, "forbidden state does not keep the old projection");

  root.unmount();
  container.remove();
});

test("SupportRatingBars: returns status paragraph when count is 0", () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(createElement(SupportRatingBars, { distribution: [0, 0, 0, 0, 0], count: 0 }));
  });

  assert.match(container.textContent, /今日暂无评价/);
  assert.equal(container.querySelector('[data-chart="rating-distribution"]'), null);

  root.unmount();
  container.remove();
});

test("SupportDashboard: renders without sending browser date, respects server reportDate, renders timeliness and agent details", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);

  const requestedUrls = [];
  const mockOverview = {
    reportDate: "2026-11-01",
    serverNow: "2026-11-01T12:34:56.000Z",
    totals: {
      onDutyCount: 2,
      waitingConsultations: 1,
      todaySessions: 15,
      todayUsers: 12,
      transfersToday: 3,
    },
    quality: {
      firstResponse: {
        slaSeconds: 60,
        averageSeconds: 25,
        sampleCount: 14,
        askedCount: 16,
        breached: 1,
        pending: 1,
        overdue: 0,
      },
      resolution: {
        averageSeconds: 480,
        sampleCount: 10,
      },
    },
    ratings: {
      count: 8,
      average: 4.8,
      distribution: [0, 0, 0, 2, 6],
      agents: [
        { adminUserId: "agent-1", name: "客服甲", count: 5, average: 5.0 },
        { adminUserId: "agent-2", name: "客服乙", count: 3, average: 4.3 },
      ],
    },
    trend: [
      { date: "2026-10-31", sessions: 10, users: 8 },
      { date: "2026-11-01", sessions: 15, users: 12 },
    ],
    hourly: [
      { hour: 10, sessions: 5 },
      { hour: 11, sessions: 10 },
    ],
    onDuty: [
      {
        adminUserId: "agent-1",
        name: "客服甲",
        availability: "AVAILABLE",
        connectionState: "CONNECTED",
        activeLoad: 1,
        todaySeconds: 5400,
        todaySessions: 8,
        todayUsers: 6,
        currentOrderGroups: 2,
        capacityLimit: null,
        totalLoad: 3,
        atCapacity: null,
      },
    ],
  };

  const request = async (path) => {
    requestedUrls.push(path);
    if (path.startsWith("/im/support-overview")) return mockOverview;
    throw new Error(`Unexpected request: ${path}`);
  };

  await act(async () => {
    root.render(createElement(SupportDashboard, {
      active: true,
      request,
      demo: true,
    }));
  });

  // Verify URL did not include browser date query parameter
  assert.equal(requestedUrls.length, 1);
  assert.equal(requestedUrls[0], "/im/support-overview");
  assert.doesNotMatch(requestedUrls[0], /date=/);

  const text = container.textContent;
  assert.match(text, /客服统计/);
  assert.match(text, /本地演示数据/);
  assert.match(text, /2026-11-01/);
  assert.ok(container.querySelector('button[aria-label="客服统计口径"]'));
  assert.ok(container.querySelector('button[aria-label="服务时效口径"]'));
  assert.match(text, /当前可接待客服/);
  assert.match(text, /当前排队咨询/);
  assert.match(text, /今日接待咨询/);
  assert.match(text, /今日接待用户/);
  assert.match(text, /服务时效/);
  assert.match(text, /今日转交/);
  assert.match(text, /今日新建咨询/);
  assert.match(text, /客服接待明细/);
  assert.match(text, /负责订单群/);
  assert.match(text, /客服甲/);
  assert.match(text, /1h 30m/);
  const agentCards = container.querySelectorAll("[data-agent-card]");
  assert.equal(agentCards.length, 1, "mobile card view carries the same agent rows");
  assert.match(agentCards[0].textContent, /客服甲/);
  assert.match(agentCards[0].textContent, /1h 30m/);
  assert.match(agentCards[0].textContent, /负责订单群/);

  assert.equal(container.querySelector('[data-chart="trend"] .im-wb-mgmt-chartbox')?.tabIndex, 0, "trend chart is keyboard reachable");

  // Ratings distribution
  const distribution = container.querySelector('[data-panel="ratings"] [data-chart="rating-distribution"]');
  assert.ok(distribution, "distribution chart exists in dashboard");
  const summary = distribution.getAttribute("aria-label");
  assert.match(summary, /5 星 6 条/);
  assert.match(summary, /4 星 2 条/);
  assert.ok(summary.indexOf("4 星 2 条") < summary.indexOf("5 星 6 条"), "distribution is shown 1 star to 5 stars");

  root.unmount();
  container.remove();
});

test("tab-model & nav-config: 运营看板 aliases and restoreTabs normalize to 客服统计", () => {
  // Check search keywords
  const overviewKeywords = PAGE_SEARCH_KEYWORDS["/support/overview"] ?? [];
  assert.ok(overviewKeywords.includes("客服统计"));
  assert.ok(overviewKeywords.includes("运营看板"));

  const managementKeywords = PAGE_SEARCH_KEYWORDS["/support/management"] ?? [];
  assert.ok(managementKeywords.includes("客服统计"));
  assert.ok(managementKeywords.includes("运营看板"));

  // Check tab persistence normalization
  const memory = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };

  const current = tabFromLocation("/support/overview");
  const legacy = tabFromLocation("/support/management");
  assert.equal(titleForPath("/support/overview"), "客服统计");
  assert.equal(titleForPath("/support/management"), "客服统计");
  assert.equal(current.title, "客服统计");
  assert.equal(legacy.title, "客服统计");
  assert.equal(legacy.path, "/support/overview");

  // Restore old tab with title "运营看板"
  persistTabs("test-agent-legacy", {
    tabs: [
      tabFromLocation("/workbench"),
      { ...current, title: "运营看板" },
    ],
    activeId: current.id,
  });

  const nav = { isBoss: true, permissions: [] };
  const restored = restoreTabs("test-agent-legacy", nav);
  assert.ok(restored);
  const restoredTab = restored.tabs.find((t) => t.id === "support-overview");
  assert.ok(restoredTab);
  assert.equal(restoredTab.title, "客服统计", "legacy title '运营看板' must be restored as '客服统计'");

  persistTabs("test-agent-duplicate", {
    tabs: [
      tabFromLocation("/workbench"),
      { ...legacy, id: "support-management", kind: "support-management", path: "/support/management", title: "运营看板" },
      current,
    ],
    activeId: current.id,
  });
  const deduplicated = restoreTabs("test-agent-duplicate", nav);
  assert.ok(deduplicated);
  assert.equal(deduplicated.tabs.filter((tab) => tab.id === "support-overview").length, 1, "legacy + canonical restore to one tab");
  assert.equal(deduplicated.activeId, "support-overview");
});

test("SupportDashboard: Yunxin conversation capacity is read on demand and masks account ids", async () => {
  const container = browser.document.createElement("div");
  browser.document.body.appendChild(container);
  const root = createRoot(container);
  const requests = [];
  const request = async (requestPath) => {
    requests.push(requestPath);
    if (requestPath.startsWith("/im/support-overview")) return zeroOverview();
    if (requestPath === "/im/yunxin-conversations") {
      return {
        available: true,
        sampledAt: "2026-11-01T00:00:00.000Z",
        quota: 5000,
        accounts: [{ adminUserId: "admin-a", name: "客服 A", accountLabel: "zza4…0d4", conversationCount: 4123, stickTopCount: 2, state: "OK" }],
      };
    }
    throw new Error(`unexpected request ${requestPath}`);
  };
  try {
    await act(async () => root.render(createElement(SupportDashboard, { active: true, request })));
    const card = () => container.querySelector('[data-panel="yunxin-conversations"]');
    assert.ok(card(), "capacity card is rendered with the dashboard");
    assert.doesNotMatch(requests.join(","), /yunxin-conversations/, "the expensive read is not polled automatically");
    await act(async () => card().querySelector('[data-action="refresh-yunxin-conversations"]').click());
    for (let attempt = 0; attempt < 50 && !container.textContent.includes("客服 A"); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.match(container.textContent, /客服 A/);
    assert.match(container.textContent, /zza4…0d4/);
    assert.match(container.textContent, /82%/);
    assert.doesNotMatch(container.textContent, /zza4edf95dba41cf1de450e8221dd0d4/, "full NIM account stays out of the DOM");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
