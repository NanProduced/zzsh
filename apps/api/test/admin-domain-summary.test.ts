import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";

import { readAdminDomainSummary, type AdminDomainSummaryRequest } from "../src/auth/admin-domain-summary";
import { listUserDirectory, projectUserAccountStatus, userDirectoryStatusCountQuery, type AdminDirectoryViewer, type UserDirectoryFilter } from "../src/auth/user-directory";
import { adminOrderReadPredicatePlan, queryAdminReadOrders } from "../src/order/admin-order-read";
import { parseAdminOrderPageQuery } from "../src/order/order-routes";
import { handleUserDirectoryAdmin } from "../src/auth/user-directory-routes";
import { DirectorySqlFixture, directorySecurityFixture } from "./user-directory-fixtures";

const AS_OF = "2026-11-03T02:03:04.123456Z";
const CONTEXT = { userId: "admin-fixture", sessionId: "session-fixture" };
const USER_COUNTS = { total: "9007199254740997", ACTIVE: "9007199254740993", RESTRICTED: "1", FROZEN: "1", CANCELLED: "1", UNKNOWN: "1" };
const ORDER_COUNTS = { total: "9", PENDING_PAYMENT: "1", PAID: "2", COMPLETED: "3", CANCELLED: "2", UNKNOWN: "1" };
const isAggregate = (sql: string) => sql.includes('AS "ACTIVE"') || sql.includes('AS "PENDING_PAYMENT"');

// Reuse the existing SQL-boundary auth fixture. Returned counts are driver inputs, not a PG oracle.
class SummaryFixture extends DirectorySqlFixture {
  aggregateRow: Record<string, unknown> = USER_COUNTS;
  aggregateError?: Error;
  continuation = false;
  asOf: unknown = AS_OF;
  abortOnAggregate?: () => void;
  sessionMissing = false;
  releases: Array<boolean | undefined> = [];
  connections = 0;
  override async connect() { this.connections++; return this; }
  override release(destroy?: boolean) { this.releases.push(destroy); }
  override async query(sql: string, values: unknown[] = []): Promise<any> {
    if (sql.includes("to_regclass('zzsh_order.legacy_continuation_version')")) { this.queries.push({ sql, values }); return { rows: [{ ready: this.continuation }] }; }
    if (sql.includes("transaction_timestamp() AT TIME ZONE 'UTC'")) { this.queries.push({ sql, values }); return { rows: [{ asOf: this.asOf }] }; }
    if (this.sessionMissing && sql.includes('FROM "zzsh_auth_admin"."session"')) { this.queries.push({ sql, values }); return { rows: [] }; }
    if (isAggregate(sql)) {
      this.queries.push({ sql, values }); this.abortOnAggregate?.();
      if (this.aggregateError) throw this.aggregateError;
      return { rows: [this.aggregateRow] };
    }
    return super.query(sql, values);
  }
}
const userRequest = (filter: Partial<UserDirectoryFilter> = {}): AdminDomainSummaryRequest => ({ domain: "USERS", filter: { limit: 20, page: 4, ...filter } });
const orderRequest = (query = "page=3&pageSize=20"): AdminDomainSummaryRequest => ({ domain: "ORDERS", filter: parseAdminOrderPageQuery(new URLSearchParams(query)) });
const run = (f: SummaryFixture, request: AdminDomainSummaryRequest, signal = new AbortController().signal) => readAdminDomainSummary(f as unknown as Pool, signal, CONTEXT, request);
const aggregates = (f: SummaryFixture) => f.queries.filter(q => isAggregate(q.sql));

test("real reader uses fresh authorization and one full-set aggregate, preserving counts beyond Number precision", async () => {
  const f = new SummaryFixture(); f.gameScopeMode = "ALL_GAMES";
  const result = await run(f, userRequest());
  assert.equal(result.schema, "admin.domain-summary.v1"); assert.equal(result.state, "KNOWN");
  assert.equal(result.total, USER_COUNTS.total); assert.equal(result.asOf, AS_OF);
  assert.equal(result.coverage, "FULL_AUTHORIZED_FILTER_SET");
  assert.deepEqual(result.statuses?.map(s => s.count), [USER_COUNTS.ACTIVE, "1", "1", "1", "1"]);
  assert.equal(result.membership?.state, "FORBIDDEN"); assert.equal(result.membership?.counts, null);
  assert.equal(f.queries[0]?.sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.match(f.queries[1]!.sql, /statement_timeout','3000'.*lock_timeout','500'/);
  assert.equal(f.queries.at(-1)?.sql, "ROLLBACK"); assert.deepEqual(f.releases, [false]);
  assert.equal(f.connections, 1); assert.equal(aggregates(f).length, 1);
  assert.ok(f.queries.findIndex(q => q.sql.includes('FROM "zzsh_auth_admin"."session"')) < f.queries.findIndex(q => isAggregate(q.sql)));
  assert.doesNotMatch(aggregates(f)[0]!.sql, /\b(?:LIMIT|OFFSET|json_agg|jsonb_agg)\b/);
  assert.doesNotMatch(JSON.stringify(result), /session-fixture|admin-fixture|phoneNumber|email/);
});

test("known empty is precise zero; missing, numeric, negative and inconsistent aggregates remain UNKNOWN", async () => {
  for (const row of [{ total: "0", ACTIVE: "0", RESTRICTED: "0", FROZEN: "0", CANCELLED: "0", UNKNOWN: "0" },
    { ...USER_COUNTS, total: 9007199254740996 }, { ...USER_COUNTS, ACTIVE: undefined },
    { ...USER_COUNTS, UNKNOWN: "-1" }, { ...USER_COUNTS, total: "1" }]) {
    const f = new SummaryFixture(); f.gameScopeMode = "ALL_GAMES"; f.aggregateRow = row;
    const result = await run(f, userRequest());
    assert.equal(result.state, row.total === "0" ? "KNOWN" : "UNKNOWN");
    assert.equal(result.total, row.total === "0" ? "0" : null);
    assert.equal(result.statuses === null, row.total !== "0");
  }
});

test("fresh session rejection and missing domain permission never reach the business aggregate", async () => {
  const expired = new SummaryFixture(); expired.sessionMissing = true;
  await assert.rejects(run(expired, userRequest()), (e: any) => e.status === 401);
  assert.equal(aggregates(expired).length, 0); assert.equal(expired.queries.at(-1)?.sql, "ROLLBACK");
  const f = new SummaryFixture(); f.permissions = [];
  const result = await run(f, userRequest());
  assert.equal(result.state, "FORBIDDEN"); assert.equal(result.total, null); assert.equal(result.statuses, null);
  assert.equal(aggregates(f).length, 0); assert.equal(f.queries.some(q => q.sql.includes('s."game_scope_mode"')), false);
  // Existing auth deliberately grants order.read as an ACTIVE-admin baseline; do not invent a deny fixture.
  f.aggregateRow = ORDER_COUNTS;
  assert.equal((await run(f, orderRequest())).state, "KNOWN");
});

test("selected game users do not become global users; empty scope is distinct from known zero", async () => {
  const selected = new SummaryFixture();
  const result = await run(selected, userRequest());
  assert.equal(result.state, "UNKNOWN"); assert.equal(result.reason, "USER_GAME_SCOPE_AGGREGATE_NOT_SUPPORTED");
  assert.equal(result.total, null); assert.equal(aggregates(selected).length, 0);
  for (const request of [userRequest(), orderRequest()]) {
    const f = new SummaryFixture(); f.gameIds = [];
    assert.equal((await run(f, request)).state, "NO_GAME_SCOPE"); assert.equal(aggregates(f).length, 0);
  }
});

test("field permissions and unavailable membership do not trigger a full membership map or fake distribution", async () => {
  for (const filter of [{ creditMin: 2 }, { membershipTier: "PENDING" as const }, { entitlement: "ANY" as const }, { phone: "+8618800001101" }]) {
    const f = new SummaryFixture(); f.gameScopeMode = "ALL_GAMES";
    if ("phone" in filter) f.permissions = f.permissions.filter(p => p !== "user.phone.lookup");
    const result = await run(f, userRequest(filter));
    assert.equal(result.state, "FORBIDDEN"); assert.equal(result.total, null); assert.equal(aggregates(f).length, 0);
  }
  const f = new SummaryFixture(); f.gameScopeMode = "ALL_GAMES"; f.permissions.push("membership.growth.read.summary");
  const unsupported = await run(f, userRequest({ membershipTier: "PENDING" }));
  assert.equal(unsupported.state, "UNKNOWN"); assert.equal(unsupported.reason, "MEMBERSHIP_TIER_FILTER_AGGREGATE_NOT_SUPPORTED");
  const supported = await run(f, userRequest());
  assert.equal(supported.state, "KNOWN"); assert.equal(supported.membership?.state, "UNKNOWN");
  assert.equal(f.queries.some(q => /membership_candidates|membership_growth/.test(q.sql)), false);
});

test("phone predicate can be authorized without being echoed in response/drilldowns", async () => {
  const f = new SummaryFixture(); f.gameScopeMode = "ALL_GAMES";
  const result = await run(f, userRequest({ phone: "+8618800001101" }));
  assert.equal(result.state, "KNOWN"); assert.equal(result.drilldown, null);
  assert.ok(result.statuses?.every(s => s.drilldown === null));
  assert.deepEqual(aggregates(f)[0]?.values, ["+8618800001101"]);
  assert.doesNotMatch(JSON.stringify(result), /18800001101/);
});

test("shared user status algorithm retains CANCELLED/FROZEN precedence over suspended", () => {
  for (const [state, suspended, expected] of [["CANCELLED", true, "CANCELLED"], ["FROZEN", true, "FROZEN"], ["ACTIVE", true, "RESTRICTED"], ["ACTIVE", false, "ACTIVE"], [null, true, "UNKNOWN"], ["unexpected", false, "UNKNOWN"]] as const) {
    assert.equal(projectUserAccountStatus(state, suspended), expected);
  }
});

test("user aggregate and actual list count share bound predicates, escaping and latest migration source", async () => {
  const f = new SummaryFixture();
  const viewer: AdminDirectoryViewer = { adminId: CONTEXT.userId, isBoss: false, phoneLookup: true, membershipSummaryRead: true, creditRead: true };
  const filter: UserDirectoryFilter = { limit: 20, page: 3, search: "%_\\name", legacyId: "legacy-fixture", accountStatus: "CANCELLED", source: "LOCAL", riskState: "FLAGGED", creditMin: 3,
    registeredFrom: "2026-01-01T00:00:00Z", registeredTo: "2026-11-01T00:00:00Z" };
  await listUserDirectory(f as unknown as PoolClient, viewer, filter);
  const list = f.queries.find(q => q.sql.includes("SELECT count(*)::int AS total FROM zzsh_auth_user"))!;
  const query = await userDirectoryStatusCountQuery(f as unknown as PoolClient, viewer, filter, AS_OF);
  assert.deepEqual(query.values, list.values);
  const where = (sql: string) => sql.slice(sql.lastIndexOf("\n       WHERE ") + "\n       WHERE ".length).trim();
  assert.equal(query.text.slice(query.text.lastIndexOf("\n      WHERE ") + "\n      WHERE ".length).trim(), where(list.sql));
  assert.match(query.text, /SELECT DISTINCT ON \(e.object_id\)/); assert.match(query.text, /ORDER BY e.object_id, e.occurred_at DESC, e.id DESC/);
  assert.doesNotMatch(query.text, /SELECT\s+u\.\*|u\."phoneNumber"\s+AS|LIMIT|OFFSET|json_agg/);
  assert.equal(query.text.indexOf("s.account_status='CANCELLED'") < query.text.indexOf("WHEN u.suspended"), true);
});

test("ORIGINAL registration and entitlement use original fact, inclusive/exclusive bounds and shared server asOf", async () => {
  const f = new SummaryFixture(); f.gameScopeMode = "ALL_GAMES"; f.permissions.push("membership.growth.read.summary");
  await run(f, userRequest({ registrationTime: "ORIGINAL", registeredFrom: "2020-01-01T00:00:00Z", registeredBefore: "2021-01-01T00:00:00Z", entitlement: "ANY" }));
  const aggregate = aggregates(f)[0]!;
  assert.match(aggregate.sql, /FROM zzsh_iam.user_registration_fact fact/);
  assert.match(aggregate.sql, /registration.registered_at >= \$\d+::timestamptz/);
  assert.match(aggregate.sql, /registration.registered_at < \$\d+::timestamptz/);
  assert.match(aggregate.sql, /s.provider_reference='la_user:' \|\| mig.legacy_id/);
  assert.equal(aggregate.values.includes(AS_OF), true);
  assert.equal(aggregate.sql.includes('u."createdAt" >= '), false);
});

test("real order reader/list use identical predicate plan and preserve scope/payment/source identity", async () => {
  const f = new SummaryFixture(); f.aggregateRow = ORDER_COUNTS;
  const request = orderRequest("page=9&pageSize=3&qKind=account&qValue=account-fixture&paymentConfirmedFrom=2026-11-01T00%3A00%3A00Z&paymentConfirmedTo=2026-11-02T00%3A00%3A00Z");
  assert.equal(request.domain, "ORDERS"); if (request.domain !== "ORDERS") return;
  const result = await run(f, request);
  assert.equal(result.state, "KNOWN"); assert.equal(result.total, "9"); assert.equal(result.statuses?.find(s => s.status === "UNKNOWN")?.count, "1");
  const aggregate = aggregates(f)[0]!;
  const plan = adminOrderReadPredicatePlan({ adminId: CONTEXT.userId, isBoss: false, authorizationKey: "unused", internalQuote: false }, request.filter);
  assert.deepEqual(aggregate.values, plan.values); assert.ok(aggregate.sql.endsWith(plan.where.map(p => `(${p})`).join(" AND ")));
  assert.match(aggregate.sql, /admin_supply_scope/); assert.match(aggregate.sql, /p.disposition='APPLIED'/);
  assert.match(aggregate.sql, /paid.paid_at>=/); assert.match(aggregate.sql, /paid.paid_at</);
  assert.match(aggregate.sql, /UNION ALL/); assert.doesNotMatch(aggregate.sql, /COUNT\(DISTINCT x.id\)/i);
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const client = { query: async (sql: string, values: unknown[] = []) => { captured.push({ sql, values }); return { rows: sql.includes("AS ready") ? [{ ready: false }] : sql.includes("AS keys") ? [{ total: "0", keys: [] }] : [] }; } } as unknown as PoolClient;
  await queryAdminReadOrders(client, { adminId: CONTEXT.userId, isBoss: false, internalQuote: false, authorizationKey: "unused" }, request.filter);
  const page = captured.find(q => q.sql.includes("AS keys"))!;
  assert.deepEqual(page.values.slice(0, -2), plan.values); assert.ok(page.sql.includes(plan.where.map(p => `(${p})`).join(" AND ")));
  for (const drilldown of [result.drilldown, ...result.statuses!.map(s => s.drilldown)].filter(d => d !== null)) {
    const parsed = parseAdminOrderPageQuery(new URLSearchParams(drilldown.filters));
    assert.equal(parsed.page, 1); assert.equal(parsed.paymentConfirmedTo, request.filter.paymentConfirmedTo); assert.equal(parsed.qValue, "account-fixture");
  }
  assert.equal(result.statuses!.find(s => s.status === "UNKNOWN")?.drilldown, null);
});

test("status drilldown stays within an existing parent status and all user links pass the actual route parser", async () => {
  const f = new SummaryFixture(); f.gameScopeMode = "ALL_GAMES";
  const result = await run(f, userRequest({ accountStatus: "CANCELLED", registrationTime: "ORIGINAL", registeredBefore: "2026-11-03T00:00:00Z" }));
  assert.equal(result.statuses?.find(s => s.status === "ACTIVE")?.drilldown, null);
  const allStatuses = await run(f, userRequest());
  for (const drilldown of [result.drilldown, ...result.statuses!.map(s => s.drilldown), ...allStatuses.statuses!.map(s => s.drilldown)].filter(d => d !== null)) {
    const routeFixture = new DirectorySqlFixture(); routeFixture.users = [];
    let status = 200;
    const response: any = { setHeader() { return response; }, status(n: number) { status = n; return response; }, json() {} };
    const path = `/api/v1/admin/users?${new URLSearchParams(drilldown.filters)}`;
    await handleUserDirectoryAdmin({ method: "GET", url: path, originalUrl: path, headers: {} }, response, directorySecurityFixture(routeFixture));
    assert.equal(status, 200);
    assert.equal(routeFixture.queries.some(q => q.sql.includes('FROM zzsh_auth_user."user" u') && q.sql.includes("LIMIT")), true);
  }
});

test("continuation summaries reuse current-head status relation and malformed database time fails closed", async () => {
  const f = new SummaryFixture(); f.continuation = true; f.aggregateRow = ORDER_COUNTS;
  assert.equal((await run(f, orderRequest())).state, "KNOWN");
  assert.match(aggregates(f)[0]!.sql, /zzsh_order.legacy_continuation_version/);
  assert.match(aggregates(f)[0]!.sql, /COALESCE\(h.stage,l.source_order_status\)/);
  const broken = new SummaryFixture(); broken.asOf = "2026-11-03T10:03:04.123456+08:00";
  await assert.rejects(run(broken, userRequest()), (e: any) => e.status === 503);
  assert.equal(aggregates(broken).length, 0); assert.equal(broken.queries.at(-1)?.sql, "ROLLBACK");
});

test("budget/abort failures retain real rollback/end and never return success or known zero", async () => {
  const f = new SummaryFixture(); f.gameScopeMode = "ALL_GAMES"; f.aggregateError = Object.assign(new Error("synthetic timeout"), { code: "57014" });
  await assert.rejects(run(f, userRequest()), (e: any) => e.status === 504);
  assert.equal(f.queries.at(-1)?.sql, "ROLLBACK"); assert.deepEqual(f.releases, [false]);
  const aborted = new SummaryFixture(), controller = new AbortController(); controller.abort(new Error("synthetic close"));
  await assert.rejects(run(aborted, userRequest(), controller.signal), /synthetic close/); assert.equal(aborted.connections, 0);
  const during = new SummaryFixture(), active = new AbortController(); during.gameScopeMode = "ALL_GAMES"; during.abortOnAggregate = () => active.abort(new Error("late close"));
  await assert.rejects(run(during, userRequest(), active.signal), /late close/);
  assert.equal(during.queries.at(-1)?.sql, "ROLLBACK"); assert.deepEqual(during.releases, [false]);
});
