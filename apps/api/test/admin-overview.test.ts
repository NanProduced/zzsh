import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION, type EffectiveAdminAccess } from "../src/auth/admin-authorization";
import { parseOverviewRange, readAdminOverview } from "../src/auth/admin-overview";

function fixture(permissions: string[], global = true) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const access: EffectiveAdminAccess = { status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(permissions) };
  let invalidCount = false;
  const client = { async query(sql: string, values: unknown[] = []) {
    queries.push({ sql, values });
    if (sql.includes("AS observed_at")) return { rows: [{ observed_at: "2026-11-01T17:30:00.123456Z", starts_at: "2026-10-25T16:00:00.000000Z", exclusive_end: "2026-11-01T17:30:00.123457Z" }] };
    if (sql.includes('FROM zzsh_auth_user."user"')) return { rows: [{ total: "155182", recent: "17" }] };
    if (sql.includes("LEFT JOIN zzsh_supply.listing_version")) return { rows: [{ total: "40853", published: "28" }] };
    if (sql.includes("v.review_state='SUBMITTED'")) return { rows: [{ count: "2" }] };
    if (sql.includes("WITH orders AS")) return { rows: [{ created: invalidCount ? null : "4", pending: "1", paid: "3", legacy: "31898", payments: "2", cents: "12345678901234567" }] };
    if (sql.includes("WITH days AS")) return { rows: [{ date: "2026-11-02", orders: "4", payments: "2", confirmedCents: permissions.includes(ADMIN_PERMISSION.financeRead) ? "12345678901234567" : null }] };
    if (sql.includes("zzsh_iam.im_consultation")) return { rows: [{ waiting: "3", mine: "1" }] };
    throw new Error("Unexpected aggregate query");
  } } as unknown as PoolClient;
  const viewer = { adminId: "operator", access, scope: { mode: global ? "ALL_GAMES" as const : "SELECTED_GAMES" as const, gameIds: global ? [] : ["delta"] }, imAppId: "review-app" };
  return { client, viewer, queries, corrupt: () => { invalidCount = true; } };
}

test("overview ranges reject ambiguous or arbitrary query input", () => {
  assert.equal(parseOverviewRange(new URLSearchParams()), "7d");
  for (const range of ["today", "7d", "30d"] as const) assert.equal(parseOverviewRange(new URLSearchParams({ range })), range);
  for (const query of ["range=all", "range=7d&range=30d", "scope=ALL_GAMES", "range="]) assert.throws(() => parseOverviewRange(new URLSearchParams(query)));
});

test("overview does not query denied domains and never replaces forbidden with zero", async () => {
  const f = fixture([]), result = await readAdminOverview(f.client, f.viewer, "7d");
  assert.equal(f.queries.length, 1);
  assert.ok(result.metrics.every(metric => metric.state === "FORBIDDEN" && metric.value === null));
  assert.deepEqual(result.trend, []);
});

test("overview exposes exact integer cents only with finance permission and shares a fixed time window", async () => {
  const f = fixture(Object.values(ADMIN_PERMISSION)), result = await readAdminOverview(f.client, f.viewer, "30d");
  assert.equal(result.metrics.find(metric => metric.id === "confirmedCents")?.value, "12345678901234567");
  assert.equal(result.metrics.find(metric => metric.id === "confirmedCents")?.unit, "CNY_CENTS");
  assert.equal(result.metrics.find(metric => metric.id === "accountsPublished")?.value, "28");
  assert.equal(result.metrics.find(metric => metric.id === "supportMine")?.value, "1");
  assert.equal(result.period.timeZone, "Asia/Shanghai");
  assert.equal(result.period.to, result.observedAt);
  assert.equal(f.queries[0]!.values[0], 30);
  for (const query of f.queries.filter(query => query.sql.includes("FROM orders") || query.sql.includes("WITH days AS"))) {
    assert.match(query.sql, /admin_supply_scope/);
    assert.match(query.sql, /paid_confirmation_id=p\.id/);
    assert.match(query.sql, /disposition='APPLIED'/);
    assert.deepEqual(query.values.slice(2), ["2026-10-25T16:00:00.000000Z", "2026-11-01T17:30:00.123456Z"]);
  }
  assert.ok(f.queries.every(query => !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/.test(query.sql)));
});

test("order reads never expose aggregate money without finance.read, including trend", async () => {
  const f = fixture([ADMIN_PERMISSION.orderRead]), result = await readAdminOverview(f.client, f.viewer, "today");
  assert.equal(result.metrics.find(metric => metric.id === "ordersCreated")?.value, "4");
  assert.deepEqual(result.metrics.find(metric => metric.id === "confirmedCents"), { id: "confirmedCents", value: null, unit: "CNY_CENTS", state: "FORBIDDEN", drilldown: null });
  assert.ok(result.trend.every(day => day.confirmedCents === null));
  assert.ok(f.queries.every(query => !query.sql.includes("sum(p.amount_cents)")));
});

test("selected game scopes never expose global user or consultation totals", async () => {
  const f = fixture(Object.values(ADMIN_PERMISSION), false), result = await readAdminOverview(f.client, f.viewer, "7d");
  for (const id of ["usersTotal", "usersNew", "supportWaiting"]) {
    const metric = result.metrics.find(metric => metric.id === id)!;
    assert.equal(metric.value, null); assert.equal(metric.state, "NO_GAME_SCOPE");
  }
  assert.equal(result.metrics.find(metric => metric.id === "supportMine")?.value, "1");
  assert.equal(f.queries.some(query => query.sql.includes('FROM zzsh_auth_user."user"')), false);
  const support = f.queries.find(query => query.sql.includes("zzsh_iam.im_consultation"))!;
  assert.doesNotMatch(support.sql, /OR state='WAITING'/);
  assert.deepEqual(support.values, ["review-app", "operator"]);
  assert.deepEqual(result.scope, { mode: "SELECTED_GAMES", gameIds: ["delta"] });
});

test("empty game scope suppresses all business queries; missing IM assembly is not zero", async () => {
  const f = fixture([ADMIN_PERMISSION.orderRead, ADMIN_PERMISSION.supplyRentalAccountRead, ADMIN_PERMISSION.imSupportRead], false);
  f.viewer.scope.gameIds = [];
  const result = await readAdminOverview(f.client, { ...f.viewer, imAppId: undefined }, "7d");
  for (const id of ["ordersPaid", "accountsTotal"]) assert.equal(result.metrics.find(metric => metric.id === id)?.state, "NO_GAME_SCOPE");
  assert.equal(result.metrics.find(metric => metric.id === "supportMine")?.state, "UNAVAILABLE");
  assert.equal(f.queries.length, 1);
});

test("malformed aggregate facts fail rather than becoming an apparent zero", async () => {
  const f = fixture([ADMIN_PERMISSION.orderRead]); f.corrupt();
  await assert.rejects(() => readAdminOverview(f.client, f.viewer, "7d"), /aggregate is invalid/);
});

test("drilldowns preserve original source and exact event-window semantics", async () => {
  const f = fixture(Object.values(ADMIN_PERMISSION)), result = await readAdminOverview(f.client, f.viewer, "7d");
  const url = (id: string) => new URL(result.metrics.find(metric => metric.id === id)!.drilldown!, "https://admin.invalid");
  assert.equal(url("ordersCreated").pathname, "/orders");
  assert.equal(url("ordersCreated").searchParams.get("origin"), "NATIVE");
  assert.equal(url("ordersCreated").searchParams.get("createdTo"), "2026-11-01T17:30:00.123457Z");
  assert.equal(url("confirmedCents").searchParams.get("paymentConfirmedFrom"), result.period.from);
  assert.equal(url("ordersPendingPayment").searchParams.get("paymentOpen"), "true");
  assert.equal(url("usersNew").searchParams.get("registrationTime"), "LOCAL");
  assert.equal(url("usersNew").searchParams.get("registeredTo"), "2026-11-01T17:30:00.123456Z");
  assert.equal(result.metrics.find(metric => metric.id === "accountsPublished")?.drilldown, null, "publication status must not link to a differently scoped availability list");
});
