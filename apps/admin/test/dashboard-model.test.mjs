import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatAge,
  formatCents,
  formatDelta,
  formatCount,
  formatDashboardPeriod,
  dashboardOrdersPath,
  businessDashboardMetrics,
  metricNote,
  metricValue,
  parseDashboardPayload,
} from "../src/components/dashboard/model.ts";

const metric = (overrides = {}) => ({
  id: "confirmedCents",
  label: "确认收款（含押金）",
  value: "1379935",
  unit: "CNY_CENTS",
  state: "KNOWN",
  definition: "含押金",
  coverage: null,
  delta: { value: "1379935", direction: "UP", percent: null },
  sparkline: ["0", "1379935"],
  drilldown: "/orders?origin=NATIVE",
  ...overrides,
});

const payload = (overrides = {}) => ({
  version: "admin.dashboard.v1",
  preset: "BOSS",
  observedAt: "2026-11-02T09:00:00.000Z",
  period: { range: "30d", from: "2026-10-03T16:00:00.000Z", to: "2026-11-02T09:00:00.000Z", timeZone: "Asia/Shanghai" },
  comparison: { from: "2026-09-03T16:00:00.000Z", to: "2026-10-03T15:59:59.999999Z" },
  scope: { mode: "ALL_GAMES", gameIds: [] },
  metrics: [metric()],
  trend: [{ date: "2026-10-31", confirmedCents: "1379935", paidOrders: "6", quotedSpreadCents: null, settledContributionCents: null }],
  queues: [{ id: "paid-awaiting", label: "已付款待完单", count: 3, oldestAgeSeconds: 3600, severity: "WARN", drilldown: "/orders?origin=NATIVE&status=PAID" }],
  recentOrders: [{ id: "o1", displayNo: "ZZ1", status: "PAID", paidAt: "2026-10-31T00:00:00.000Z", confirmedCents: "100", contributionCents: "10", contributionState: "QUOTED", currency: "CNY" }],
  ...overrides,
});

test("dashboard payload accepts the current contract", () => {
  const parsed = parseDashboardPayload(payload());
  assert.equal(parsed.preset, "BOSS");
  assert.equal(parsed.metrics[0].value, "1379935");
});

test("dashboard payload rejects malformed money, period and preset", () => {
  for (const bad of [
    payload({ preset: "ROOT" }),
    payload({ period: { ...payload().period, timeZone: "UTC" } }),
    payload({ metrics: [metric({ value: "1.5" })] }),
    payload({ metrics: [metric({ state: "PARTIAL", coverage: null })] }),
    payload({ trend: "not-array" }),
    payload({ period: { ...payload().period, from: 'invalid' } }),
    payload({ period: { ...payload().period, paymentConfirmedTo: 'invalid' } }),
    payload({ scope: { mode:'EVERYTHING',gameIds:[] } }),
  ]) {
    assert.throws(() => parseDashboardPayload(bad), /工作台数据格式异常/);
  }
});

test("dashboard formatting keeps exact cents and never turns unknown into zero", () => {
  assert.equal(formatCents("1379935"), "¥13,799.35");
  assert.equal(formatCents("-100"), "-¥1.00");
  assert.equal(formatCents(null), "—");
  assert.equal(formatCents(123), "—");
  assert.equal(formatAge(3600), "1 小时");
  assert.equal(metricValue(metric({ state: "FORBIDDEN", value: null })), "—");
  assert.equal(metricNote(metric({ state: "FORBIDDEN", value: null })), "无读取权限");
  assert.equal(metricNote(metric({ state: "PARTIAL", value: "100", coverage: { knownCount: 1, totalCount: 2 } })), "已覆盖 1/2 单");
});

test("negative count deltas keep their sign instead of becoming unavailable", () => {
  const value = metric({ id: "paidOrders", unit: "COUNT", delta: { value: "-3", direction: "DOWN", percent: "-10.0" } });
  assert.equal(formatDelta(value), "-3");
});
test('dashboard period displays Beijing calendar dates but drilldown preserves exact server payment boundaries',()=>{
 const period={...payload().period,paymentConfirmedTo:'2026-11-02T09:00:00.000001Z'};
 assert.equal(formatDashboardPeriod(period),'2026-10-04 至 2026-11-02 · 北京时间');
 const query=new URL(dashboardOrdersPath(period),'http://fixture').searchParams;assert.equal(query.get('origin'),'NATIVE');assert.equal(query.get('paymentConfirmedFrom'),period.from);assert.equal(query.get('paymentConfirmedTo'),period.paymentConfirmedTo);
 assert.equal(dashboardOrdersPath(payload().period),null,'observedAt is not an exclusive order boundary');assert.equal(dashboardOrdersPath({...period,paymentConfirmedTo:null}),null);assert.equal(formatDashboardPeriod({...period,from:'invalid'}),'期间尚未核定');
 const original=dashboardOrdersPath(period);assert.equal(dashboardOrdersPath(payload().period,original),original,'reuse the API metric predicate without new metadata');
 for(const path of ['/orders?origin=NATIVE','//evil.test/orders?origin=NATIVE',original+'&status=PAID',original+'&paymentConfirmedTo=duplicate',original.replace(encodeURIComponent(period.from),'wrong-from')])assert.equal(dashboardOrdersPath(payload().period,path),null);
});
test('unknown and forbidden knowledge take priority over a zero coverage count',()=>{
 for(const [state,note] of [['FORBIDDEN','无读取权限'],['NO_GAME_SCOPE','不在当前游戏范围'],['UNAVAILABLE','暂不可用'],['PARTIAL','已覆盖 0/0 单']])assert.equal(metricNote(metric({state,value:null,coverage:{knownCount:0,totalCount:0}})),note);
 assert.equal(metricNote(metric({coverage:{knownCount:0,totalCount:0}})),'本期暂无数据');
 assert.equal(formatCount('9007199254740993'),'9,007,199,254,740,993');assert.equal(formatCount(9007199254740992),'—');
});
test('OPS and Boss use the same ordered API business metrics without relabelling an OPS payload',()=>{
 const data=payload({preset:'OPS',metrics:[metric({id:'ordersPaid'}),metric({id:'paidOrders'}),metric({id:'confirmedCents'}),metric({id:'settledContribution'}),metric({id:'quotedSpread'})]});
 assert.deepEqual(businessDashboardMetrics(data).map(m=>m.id),['confirmedCents','quotedSpread','settledContribution','paidOrders']);assert.equal(data.preset,'OPS');
});
test('API signed monetary facts remain exact while negative counts are rejected',()=>{
 const value=metric({id:'settledContribution',value:'-9007199254740993'});assert.equal(metricValue(parseDashboardPayload(payload({metrics:[value]})).metrics[0]),'-¥90,071,992,547,409.93');assert.throws(()=>parseDashboardPayload(payload({metrics:[metric({id:'paidOrders',unit:'COUNT',value:'-1'})]})));
});
