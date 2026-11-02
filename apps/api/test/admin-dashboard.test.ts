import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION, ADMIN_PERMISSION_CODES, type EffectiveAdminAccess } from "../src/auth/admin-authorization";
import { deriveDashboardPreset } from "../src/auth/admin-dashboard-preset";
import { handleAdminDashboard, parseDashboardRange, readAdminDashboard } from "../src/auth/admin-dashboard";
import { getAdminSessionSnapshot } from "../src/auth/auth-security";
import { projectTenantMoney } from "../src/supply/tenant-price-projection";

const access = (permissions: string[], isBoss = false): EffectiveAdminAccess => ({
  status: "ACTIVE",
  isBoss,
  passwordChangeRequired: false,
  permissions: new Set(permissions),
});

test("dashboard presets derive from effective capabilities, not role names", () => {
  assert.equal(deriveDashboardPreset(access([], true)), "BOSS");
  assert.equal(deriveDashboardPreset(access([ADMIN_PERMISSION.financeRead])), "OPS");
  assert.equal(deriveDashboardPreset(access([ADMIN_PERMISSION.imSupportRead])), "SUPPORT");
  assert.equal(deriveDashboardPreset(access([ADMIN_PERMISSION.orderRead])), "OPS");
  assert.equal(deriveDashboardPreset(access([ADMIN_PERMISSION.imSupportRead, ADMIN_PERMISSION.financeRead])), "OPS");
});

test("dashboard range defaults to 30d and rejects unsupported keys", () => {
  assert.equal(parseDashboardRange(new URLSearchParams()), "30d");
  assert.equal(parseDashboardRange(new URLSearchParams({ range: "7d" })), "7d");
  assert.throws(() => parseDashboardRange(new URLSearchParams({ range: "90d" })));
});

test("boss dashboard keeps receipts, quoted spread, settled contribution and paid orders separate", async () => {
  const client = { async query(sql: string) {
    if (sql.includes("WITH clock AS")) return { rows: [{
      observed_at: "2026-11-02T09:00:00.000000Z",
      starts_at: "2026-10-03T16:00:00.000000Z",
      exclusive_end: "2026-11-02T09:00:00.000001Z",
      previous_starts_at: "2026-09-03T16:00:00.000000Z",
      previous_observed_at: "2026-10-03T15:59:59.999999Z",
      previous_exclusive_end: "2026-10-03T16:00:00.000000Z",
    }] };
    if (sql.includes('FROM zzsh_auth_user."user"')) return { rows: [{ total: "155182", recent: "0" }] };
    if (sql.includes("LEFT JOIN zzsh_supply.listing_version")) return { rows: [{ total: "40853", published: "5" }] };
    if (sql.includes("v.review_state='SUBMITTED'")) return { rows: [{ count: "0" }] };
    if (sql.includes("WITH orders AS")) return { rows: [{ created: "4", pending: "0", paid: "3", legacy: "31898", payments: "6", cents: "1379935" }] };
    if (sql.includes("WITH days AS")) return { rows: [{ date: "2026-10-31", orders: "4", payments: "6", confirmedCents: "1379935" }] };
    if (sql.includes("zzsh_iam.im_consultation")) return { rows: [{ waiting: "1", mine: "3" }] };
    if (sql.includes("WITH paid AS")) return { rows: [{ total: "6", known: "6", cents: "321165" }] };
    if (sql.includes("settlement_posting p")) return { rows: [{ cents: "42118" }] };
    if (sql.includes("LEFT JOIN LATERAL")) return { rows: [{
      id: "order_1", displayNo: "ZZ1", status: "PAID", paidAt: "2026-10-31T00:00:00.000000Z",
      confirmedCents: "100", contributionCents: "10", contributionState: "QUOTED",
    }] };
    if (sql.includes("approval_request")) return { rows: [{ count: "1", age: "60" }] };
    if (sql.includes("min(paid_at)")) return { rows: [{ age: "3600" }] };
    throw new Error(`Unexpected dashboard query: ${sql.slice(0, 80)}`);
  } } as unknown as PoolClient;

  const result = await readAdminDashboard(client, {
    adminId: "boss",
    access: access(ADMIN_PERMISSION_CODES, true),
    scope: { mode: "ALL_GAMES", gameIds: [] },
    imAppId: "review-app",
  }, "30d");

  assert.equal(result.preset, "BOSS");
  assert.equal(result.period.range, "30d");
  assert.equal(result.metrics.find((metric) => metric.id === "confirmedCents")?.value, "1379935");
  assert.equal(result.metrics.find((metric) => metric.id === "quotedSpread")?.value, "321165");
  assert.equal(result.metrics.find((metric) => metric.id === "settledContribution")?.value, "42118");
  assert.equal(result.metrics.find((metric) => metric.id === "paidOrders")?.value, "6");
  assert.equal(result.recentOrders[0]?.contributionState, "QUOTED");
  assert.equal(result.queues.find((queue) => queue.id === "paid-awaiting")?.count, 3);
  assert.equal(result.queues.find((queue) => queue.id === "pending-approvals")?.count, 1);
  assert.ok(result.metrics.every((metric) => metric.state === "KNOWN"));
});

const operatingPermissions = [ADMIN_PERMISSION.orderRead, ADMIN_PERMISSION.financeRead, ADMIN_PERMISSION.supplyQuoteInternalRead];
const clock = {
  observed_at: "2026-11-02T09:00:00.123456Z", starts_at: "2026-10-03T16:00:00.000000Z",
  exclusive_end: "2026-11-02T09:00:00.123457Z", previous_starts_at: "2026-09-03T22:59:59.876544Z",
  previous_observed_at: "2026-10-03T15:59:59.999999Z", previous_exclusive_end: "2026-10-03T16:00:00.000000Z",
};
type ReadPatch = { currentCents?: string; previousCents?: string; quote?: { total: string; known: string; cents: string }; quoteValues?: unknown[] };

// Only the narrow money CASE contract is evaluated here. This is not a PostgreSQL emulator or PG evidence.
// Every expression comes from the SQL emitted by the real reader, not an exported test-only helper.
function quoteCase(sql: string, value: any): string | null {
  assert.match(sql, /jsonb_typeof\(o\.quote_snapshot->'platformFullProfit'->'amount'\) = 'string'/);
  assert.match(sql, /jsonb_typeof\(o\.quote_snapshot->'platformFullProfit'->'scale'\) = 'number'/);
  assert.match(sql, /->'scale' = '2'::jsonb/);
  const pattern = sql.match(/->>'amount' ~ '([^']+)'/)?.[1];
  assert.ok(pattern, "the real CASE has an amount precision predicate before its cast");
  if (!value || Array.isArray(value) || typeof value !== "object" || value.currency !== "CNY" || value.unit !== "yuan"
    || typeof value.scale !== "number" || value.scale !== 2 || typeof value.amount !== "string" || !new RegExp(pattern).test(value.amount)) return null;
  const [whole, fraction = ""] = value.amount.split(".");
  assert.ok(whole.length <= 22, "numeric(24,2) must never receive an overflowing 23-integer-digit quote");
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
}

function domainProbe(patch: ReadPatch = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    const current = values[2] === clock.starts_at, cents = current ? patch.currentCents ?? "1000" : patch.previousCents ?? "900";
    if (sql.includes("WITH clock AS")) return { rows: [clock] };
    if (sql.includes('FROM zzsh_auth_user."user"')) return { rows: [{ total: "20", recent: "2" }] };
    if (sql.includes("LEFT JOIN zzsh_supply.listing_version")) return { rows: [{ total: "8", published: "5" }] };
    if (sql.includes("v.review_state='SUBMITTED'")) return { rows: [{ count: "2", age: "100" }] };
    if (sql.includes("WITH orders AS")) return { rows: [{ created: current ? "4" : "1", pending: "2", paid: "3", legacy: "10", payments: current ? "6" : "2", cents }] };
    if (sql.includes("WITH days AS")) return { rows: [{ date: "2026-11-02", orders: "4", payments: "6", confirmedCents: sql.includes('NULL::text AS "confirmedCents"') ? null : cents }] };
    if (sql.includes("WITH paid AS")) {
      const money = patch.quoteValues?.map(v => quoteCase(sql, v));
      return { rows: [money ? { total: String(money.length), known: String(money.filter(v => v !== null).length), cents: money.reduce<bigint>((n, v) => n + BigInt(v ?? "0"), 0n).toString() }
        : current && patch.quote ? patch.quote : { total: "6", known: "6", cents }] };
    }
    if (sql.includes("settlement_posting p")) return { rows: [{ cents }] };
    if (sql.includes("LEFT JOIN LATERAL")) return { rows: [{ id: "order-1", displayNo: "ZZ1", status: "PAID", paidAt: clock.observed_at, confirmedCents: cents,
      contributionCents: sql.includes('NULL::text AS "contributionCents"') ? null : "95", contributionState: sql.includes("'UNAVAILABLE' AS") ? "UNAVAILABLE" : "QUOTED" }] };
    if (sql.includes("zzsh_iam.im_consultation")) return { rows: [{ waiting: "1", mine: "2", age: "60" }] };
    if (sql.includes("approval_request")) return { rows: [{ count: "1", age: "60" }] };
    if (sql.includes("min(")) return { rows: [{ age: "90" }] };
    throw new Error("Unexpected real dashboard SQL: " + sql.slice(0, 100));
  };
  return { query, calls, client: { query } as unknown as PoolClient };
}

test("authorized Ops receives the same four economic metrics as Boss without gaining a permission", async () => {
  const probe = domainProbe(), result = await readAdminDashboard(probe.client, { adminId: "operator", access: access(operatingPermissions), scope: { mode: "SELECTED_GAMES", gameIds: ["delta"] } }, "30d");
  assert.equal(result.preset, "OPS");
  assert.deepEqual(result.metrics.map(m => m.id), ["confirmedCents", "quotedSpread", "settledContribution", "paidOrders"]);
  assert.ok(result.metrics.every(m => m.state === "KNOWN"));
  assert.deepEqual(result.scope, { mode: "SELECTED_GAMES", gameIds: ["delta"] });
  const scoped = probe.calls.filter(q => q.sql.includes("WITH orders AS") || q.sql.includes("WITH paid AS") || q.sql.includes("settlement_posting p") || q.sql.includes("LEFT JOIN LATERAL"));
  assert.ok(scoped.length >= 7);for (const q of scoped) { assert.deepEqual(q.values.slice(0, 2), ["operator", false]);assert.match(q.sql, /admin_supply_scope/); }
  assert.equal(result.recentOrdersState, "KNOWN");
});

test("Ops pending-review age uses the original submitted time when supply review is actually authorized", async () => {
  const probe = domainProbe(), result = await readAdminDashboard(probe.client, { adminId: "review-operator", access: access([...operatingPermissions, ADMIN_PERMISSION.supplyReviewRead]), scope: { mode: "SELECTED_GAMES", gameIds: ["delta"] } }, "30d");
  assert.equal(result.preset, "OPS");assert.equal(result.queues.find(q => q.id === "pending-review")?.count, 2);
  const age = probe.calls.filter(q => q.sql.includes("clock_timestamp()-min(v."));assert.equal(age.length, 1, "the real Ops queue must execute its oldest-age query");
  assert.match(age[0]!.sql, /min\(v\.submitted_at\)/);assert.doesNotMatch(age[0]!.sql, /updated_at/);assert.match(age[0]!.sql, /v\.review_state='SUBMITTED'/);assert.deepEqual(age[0]!.values, ["review-operator", false]);
});

test("each missing capability and an empty selected scope keep denied values out of the unified Ops panel", async () => {
  for (const omitted of operatingPermissions) {
    const probe = domainProbe(), result = await readAdminDashboard(probe.client, { adminId: "operator", access: access(operatingPermissions.filter(p => p !== omitted)), scope: { mode: "ALL_GAMES", gameIds: [] } }, "7d");
    const metric = (id: string) => result.metrics.find(m => m.id === id)!;
    assert.equal(result.metrics.length, 4);
    if (omitted === ADMIN_PERMISSION.orderRead) { assert.equal(metric("confirmedCents").state, "FORBIDDEN");assert.equal(metric("paidOrders").value, null);assert.equal(result.period.paymentConfirmedTo, null);assert.equal(result.recentOrdersState, "FORBIDDEN");assert.deepEqual(result.recentOrders, []); }
    if (omitted === ADMIN_PERMISSION.financeRead) { for (const id of ["confirmedCents", "quotedSpread", "settledContribution"]) assert.equal(metric(id).state, "FORBIDDEN");assert.equal(metric("paidOrders").state, "KNOWN");assert.equal(result.recentOrders[0]?.contributionCents, null); }
    if (omitted === ADMIN_PERMISSION.supplyQuoteInternalRead) { assert.equal(metric("quotedSpread").value, null);assert.equal(metric("quotedSpread").state, "FORBIDDEN");assert.equal(metric("settledContribution").state, "KNOWN"); }
    if (omitted !== ADMIN_PERMISSION.orderRead) assert.ok(!probe.calls.some(q => q.sql.includes("WITH paid AS")), "denied quote facts must not be queried");
  }
  const empty = domainProbe(), result = await readAdminDashboard(empty.client, { adminId: "operator", access: access(operatingPermissions), scope: { mode: "SELECTED_GAMES", gameIds: [] } }, "30d");
  assert.ok(result.metrics.every(m => m.state === "NO_GAME_SCOPE" && m.value === null && m.delta === null));assert.deepEqual(result.queues, []);
  assert.equal(result.period.paymentConfirmedTo, null);assert.equal(result.recentOrdersState, "NO_GAME_SCOPE");assert.deepEqual(result.recentOrders, []);
  assert.ok(!empty.calls.some(q => /WITH orders AS|WITH paid AS|settlement_posting p|LEFT JOIN LATERAL/.test(q.sql)));
});

test("partial quote coverage never produces a performance delta; current stock never gains a historical comparison", async () => {
  const probe = domainProbe({ quote: { total: "10", known: "1", cents: "100" } }), result = await readAdminDashboard(probe.client, { adminId: "operator", access: access(operatingPermissions), scope: { mode: "ALL_GAMES", gameIds: [] } }, "30d");
  const quote = result.metrics.find(m => m.id === "quotedSpread")!;assert.equal(quote.state, "PARTIAL");assert.equal(quote.value, "100");assert.deepEqual(quote.coverage, { knownCount: 1, totalCount: 10 });assert.equal(quote.delta, null);
  const support = await readAdminDashboard(domainProbe().client, { adminId: "support", access: access([ADMIN_PERMISSION.imSupportRead, ADMIN_PERMISSION.orderRead]), scope: { mode: "ALL_GAMES", gameIds: [] }, imAppId: "local" }, "7d");
  assert.equal(support.preset, "SUPPORT");assert.equal(support.metrics.find(m => m.id === "ordersPaid")?.value, "3");assert.ok(support.metrics.every(m => m.delta === null));
  assert.equal(support.metrics.find(m => m.id === "supportMine")?.value, "2");
});

test("payment drilldowns retain the exact exclusive microsecond bound and long cents stay integer text", async () => {
  const current = "900719925474099312345678", previous = "900719925474099312345677", probe = domainProbe({ currentCents: current, previousCents: previous });
  const result = await readAdminDashboard(probe.client, { adminId: "operator", access: access(operatingPermissions), scope: { mode: "ALL_GAMES", gameIds: [] } }, "30d");
  assert.equal(result.period.to, clock.observed_at);assert.equal(result.period.paymentConfirmedTo, clock.exclusive_end);assert.equal(result.recentOrdersState, "KNOWN");
  for (const id of ["confirmedCents", "quotedSpread"]) {
    const m = result.metrics.find(m => m.id === id)!;assert.equal(m.value, current);assert.equal(m.delta?.value, "1");
    const query = new URL(m.drilldown!, "http://admin.local").searchParams;assert.equal(query.get("paymentConfirmedFrom"), clock.starts_at);assert.equal(query.get("paymentConfirmedTo"), clock.exclusive_end);
  }
  assert.equal(result.trend[0]?.confirmedCents, current);
  for (const q of probe.calls.filter(q => q.sql.includes("WITH orders AS") || q.sql.includes("WITH paid AS") || q.sql.includes("settlement_posting p"))) assert.ok(q.values[3] === clock.observed_at || q.values[3] === clock.previous_observed_at);
});

test("real reader SQL rejects wrong JSON types and cast overflow without turning unavailable quotes into zero", async () => {
  const good = { currency: "CNY", unit: "yuan", scale: 2, amount: "9999999999999999999999.99" };
  const bad = [{ ...good, amount: 123 }, { ...good, scale: "2" }, { ...good, scale: null }, { ...good, amount: "10000000000000000000000" }, { ...good, amount: "1.234" }, { ...good, amount: "1e3" }, { ...good, currency: "USD" }];
  for (const value of bad.slice(0, 3)) assert.throws(() => projectTenantMoney(value));
  const probe = domainProbe({ quoteValues: [good, ...bad] }), result = await readAdminDashboard(probe.client, { adminId: "operator", access: access(operatingPermissions), scope: { mode: "ALL_GAMES", gameIds: [] } }, "30d");
  const quote = result.metrics.find(m => m.id === "quotedSpread")!;assert.equal(quote.state, "PARTIAL");assert.equal(quote.value, "999999999999999999999999");assert.deepEqual(quote.coverage, { knownCount: 1, totalCount: 8 });assert.equal(quote.delta, null);
  const none = await readAdminDashboard(domainProbe({ quoteValues: bad }).client, { adminId: "operator", access: access(operatingPermissions), scope: { mode: "ALL_GAMES", gameIds: [] } }, "30d");
  assert.equal(none.metrics.find(m => m.id === "quotedSpread")?.value, null);assert.equal(none.metrics.find(m => m.id === "quotedSpread")?.state, "PARTIAL");
});

type RoutePatch = { permissions?: string[]; isBoss?: boolean; scope?: { mode: "ALL_GAMES" | "SELECTED_GAMES"; gameIds: string[] }; freshPermissions?: string[]; freshBoss?: boolean; freshScope?: { mode: "ALL_GAMES" | "SELECTED_GAMES"; gameIds: string[] }; sdkLocked?: boolean; lockedTransaction?: number; abortAt?: "read" | "fresh" | "after-fresh-rollback" };
function routeProbe(patch: RoutePatch = {}) {
  const request = Object.assign(new EventEmitter(), { method: "GET", url: "/api/v1/admin/dashboard?range=30d", headers: { origin: "http://admin.local", cookie: "session=synthetic" }, aborted: false });
  const result = { status: 0, body: null as any, sends: 0, connects: 0, releases: 0, sdkReads: 0 };
  const response = Object.assign(new EventEmitter(), { headersSent: false, writableFinished: false, destroyed: false,
    setHeader() { return this; }, status(n: number) { result.status = n;return this; }, json(body: unknown) { result.sends++;result.body = body;this.headersSent = true;this.writableFinished = true; } });
  const domain = domainProbe(), calls: { sql: string; transaction: number; values: unknown[] }[] = [];
  const abort = () => { request.aborted = true;request.emit("aborted"); };
  const query = async (sql: string, values: unknown[] = [], transaction = 0): Promise<any> => {
    calls.push({ sql, transaction, values });const fresh = transaction === 2;
    if (sql.startsWith("BEGIN") || sql.includes("set_config(")) return { rows: [] };
    if (sql === "ROLLBACK") { if (fresh && patch.abortAt === "after-fresh-rollback") abort();return { rows: [] }; }
    if (sql.includes('FROM "zzsh_auth_admin"."session" s JOIN')) return { rows: [{ locked: patch.lockedTransaction === transaction, twoFactorEnabled: true, suspended: false }] };
    if (sql.includes('SELECT "status", "is_boss" AS "isBoss"')) return { rows: [{ status: "ACTIVE", isBoss: fresh ? patch.freshBoss ?? patch.isBoss ?? false : patch.isBoss ?? false, passwordChangeRequired: false }] };
    if (sql.includes("WITH role_permissions")) return { rows: (fresh ? patch.freshPermissions ?? patch.permissions ?? operatingPermissions : patch.permissions ?? operatingPermissions).map(permissionCode => ({ permissionCode })) };
    if (sql.includes('"game_scope_mode" AS "mode"')) { if (fresh && patch.abortAt === "fresh") abort();return { rows: [fresh ? patch.freshScope ?? patch.scope ?? { mode: "ALL_GAMES", gameIds: [] } : patch.scope ?? { mode: "ALL_GAMES", gameIds: [] }] }; }
    if (sql.includes('AS "pinConfigured"')) return { rows: [{ pinConfigured: true }] };
    if (sql.startsWith('UPDATE "zzsh_auth_admin"."session"')) return { rows: [] };
    if (sql.includes('AS "required"')) return { rows: [{ required: true }] };
    const rows = await domain.query(sql, values);if (transaction === 1 && patch.abortAt === "read" && sql.includes("WITH paid AS")) abort();return rows;
  };
  const pool = { query: (sql: string, values?: unknown[]) => query(sql, values), connect: async () => {
    const transaction = ++result.connects, client = new EventEmitter();let status = "I";
    return Object.assign(client, { getTransactionStatus: () => status, release() { result.releases++; }, query: async (sql: string, values?: unknown[]) => { if (sql.startsWith("BEGIN")) status = "T";const r = await query(sql, values, transaction);if (sql === "ROLLBACK") status = "I";return r; } });
  } };
  const options = { pool, apiOrigin: "http://api.local", adminOrigin: "http://admin.local", userOrigin: "http://user.local",
    adminAuth: { api: { getSession: async () => { result.sdkReads++;return { user: { id: "admin-1", twoFactorEnabled: true }, session: { id: "session-1", locked: patch.sdkLocked ?? false } }; } } } };
  return { request, response, result, calls, options, run: () => handleAdminDashboard(request as any, response as any, options as any) };
}

test("formal dashboard handler runs data and fresh authorization in two bounded read-only RR leases", async () => {
  const env = routeProbe();await env.run();assert.equal(env.result.status, 200);assert.equal(env.result.sends, 1);assert.equal(env.result.connects, 2);assert.equal(env.result.releases, 2);assert.equal(env.result.sdkReads, 1);
  assert.equal(env.result.body.preset, "OPS");assert.equal(env.result.body.metrics.length, 4);
  for (const n of [1, 2]) {
    const calls = env.calls.filter(q => q.transaction === n);assert.equal(calls[0]?.sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");assert.match(calls[1]!.sql, /statement_timeout','3000'.*lock_timeout','500'/);assert.equal(calls.at(-1)?.sql, "ROLLBACK");
    assert.ok(calls.some(q => q.sql.includes('FROM "zzsh_auth_admin"."session" s JOIN')));assert.ok(calls.some(q => q.sql.includes('"game_scope_mode" AS "mode"')));
  }
  assert.ok(!env.calls.some(q => /^(COMMIT|INSERT|DELETE)/.test(q.sql)));
});

test("formal handler refuses each fresh permission loss, Boss change or effective game scope change", async () => {
  for (const omitted of [ADMIN_PERMISSION.financeRead, ADMIN_PERMISSION.supplyQuoteInternalRead]) {
    const env = routeProbe({ freshPermissions: operatingPermissions.filter(p => p !== omitted) });await env.run();assert.equal(env.result.status, 403);assert.equal(env.result.body.version, undefined);assert.equal(env.result.releases, 2);
  }
  for (const patch of [{ freshScope: { mode: "SELECTED_GAMES" as const, gameIds: ["delta"] } }, { isBoss: true, freshBoss: false, freshPermissions: [...ADMIN_PERMISSION_CODES] }]) {
    const env = routeProbe(patch);await env.run();assert.equal(env.result.status, 403);assert.equal(env.result.body.recentOrders, undefined);
  }
});

test("unchanged Boss raw selected scope and reordered selected scope are compared by effective authorization", async () => {
  const boss = routeProbe({ isBoss: true, scope: { mode: "SELECTED_GAMES", gameIds: ["delta"] } });await boss.run();assert.equal(boss.result.status, 200);assert.deepEqual(boss.result.body.scope, { mode: "ALL_GAMES", gameIds: [] });
  const selected = routeProbe({ scope: { mode: "SELECTED_GAMES", gameIds: ["b", "a"] }, freshScope: { mode: "SELECTED_GAMES", gameIds: ["a", "b"] } });await selected.run();assert.equal(selected.result.status, 200);
});

test("abort during data, during fresh check or after its final rollback cannot send the collected DTO", async () => {
  for (const abortAt of ["read", "fresh", "after-fresh-rollback"] as const) {
    const env = routeProbe({ abortAt });await env.run();assert.equal(env.result.sends, 0, abortAt);assert.equal(env.result.body, null);assert.equal(env.result.releases, env.result.connects);
    assert.equal(env.result.connects, abortAt === "read" ? 1 : 2);assert.equal(env.request.listenerCount("aborted"), 0);assert.equal(env.response.listenerCount("close"), 0);
  }
});

test("SDK-locked, newly locked snapshot and newly locked fresh sessions never disclose a dashboard", async () => {
  for (const patch of [{ sdkLocked: true }, { lockedTransaction: 1 }, { lockedTransaction: 2 }]) {
    const env = routeProbe(patch);await env.run();assert.equal(env.result.status, 423);assert.equal(env.result.body.metrics, undefined);assert.equal(env.result.releases, env.result.connects);
  }
});

test("session snapshot keeps permissions and adds effective game scope without guessing Boss selected rows", async () => {
  for (const isBoss of [false, true]) {
    const env = routeProbe({ isBoss, scope: { mode: "SELECTED_GAMES", gameIds: ["delta"] } }), snapshot = await getAdminSessionSnapshot(new Headers({ cookie: "session=synthetic" }), env.options as any);
    assert.equal(snapshot.authenticated, true);if (!snapshot.authenticated) throw new Error("synthetic active session missing");
    assert.deepEqual(snapshot.gameScope, isBoss ? { mode: "ALL_GAMES", gameIds: [] } : { mode: "SELECTED_GAMES", gameIds: ["delta"] });assert.equal(snapshot.dashboardPreset, isBoss ? "BOSS" : "OPS");assert.ok(snapshot.permissions.includes(ADMIN_PERMISSION.financeRead));
  }
});
