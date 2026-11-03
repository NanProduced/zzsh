import { strict as assert } from "node:assert";
import { test } from "node:test";
import { handleAdminDomainSummary, mountAdminDomainSummary, parseAdminDomainSummaryQuery } from "../src/auth/admin-domain-summary-routes";
import { parseUserDirectoryFilter } from "../src/auth/user-directory-routes";
import { DirectorySqlFixture, directorySecurityFixture } from "./user-directory-fixtures";

const AS_OF = "2026-11-03T02:03:04.123456Z";
class Fixture extends DirectorySqlFixture {
  afterAggregate?: () => void;
  constructor() { super(); this.gameScopeMode = "ALL_GAMES"; }
  override async query(sql: string, values: unknown[] = []): Promise<any> {
    if (sql.includes("transaction_timestamp() AT TIME ZONE 'UTC'")) { this.queries.push({ sql, values }); return { rows: [{ asOf: AS_OF }] }; }
    if (sql.includes("to_regclass('zzsh_order.legacy_continuation_version')")) { this.queries.push({ sql, values }); return { rows: [{ ready: false }] }; }
    if (sql.includes('AS "ACTIVE"')) {
      this.queries.push({ sql, values }); this.afterAggregate?.();
      return { rows: [{ total: "6", ACTIVE: "1", RESTRICTED: "2", FROZEN: "1", CANCELLED: "1", UNKNOWN: "1" }] };
    }
    if (sql.includes('AS "PENDING_PAYMENT"')) {
      this.queries.push({ sql, values }); this.afterAggregate?.();
      return { rows: [{ total: "7", PENDING_PAYMENT: "1", PAID: "2", COMPLETED: "3", CANCELLED: "1", UNKNOWN: "0" }] };
    }
    return super.query(sql, values);
  }
}
async function call(f: Fixture, path: string, method = "GET", headers: Record<string, string> = {}) {
  let status = 200, body: any;
  const response: any = { setHeader() { return response; }, status(n: number) { status = n; return response; }, json(value: unknown) { body = value; } };
  await handleAdminDomainSummary({ method, url: path, originalUrl: path, headers }, response, directorySecurityFixture(f));
  return { status, body };
}

test("summary HTTP reuses the list parsers and rejects invalid, private and ambiguous query arguments", () => {
  const q = new URLSearchParams("registrationTime=ORIGINAL&accountStatus=RESTRICTED&creditMin=20&registeredBefore=2026-11-03T00%3A00%3A00Z&page=1&pageSize=20");
  assert.deepEqual(parseAdminDomainSummaryQuery("USERS", q).filter, parseUserDirectoryFilter(q, false));
  for (const suffix of ["phone=18800001101", "accountStatus=FROZEN&accountStatus=ACTIVE", "bogus=x", "contextKey=" + "a".repeat(64), "registeredBefore=2026-11-03T00:00:00Z", "creditMin=101"]) {
    assert.throws(() => parseAdminDomainSummaryQuery("USERS", new URLSearchParams(suffix)), (e: any) => e.status === 400);
  }
  for (const suffix of ["cursor=x", "status=NOT_REAL", "qKind=wrong", "pageSize=101"]) assert.throws(() => parseAdminDomainSummaryQuery("ORDERS", new URLSearchParams(suffix)), (e: any) => e.status === 400);
});

test("actual user and order HTTP handlers return fresh bounded read aggregates and server asOf", async () => {
  const users = new Fixture();
  const u = await call(users, "/api/v1/admin/users/overview-stats?registrationTime=ORIGINAL");
  assert.equal(u.status, 200); assert.equal(u.body.state, "KNOWN"); assert.equal(u.body.total, "6"); assert.equal(u.body.asOf, AS_OF);
  assert.equal(users.queries.filter(q => q.sql.includes('AS "ACTIVE"')).length, 1);
  assert.equal(users.queries.filter(q => q.sql === "ROLLBACK").length, 2);
  assert.equal(users.queries.some(q => /^(?:INSERT|UPDATE|DELETE|COMMIT)/.test(q.sql)), false);
  const o = await call(new Fixture(), "/api/v1/admin/orders/overview-stats?status=PAID");
  assert.equal(o.status, 200); assert.equal(o.body.domain, "ORDERS"); assert.equal(o.body.total, "7");
});

test("origin/method/auth and revoked scope reject instead of disclosing a stale summary", async () => {
  assert.equal((await call(new Fixture(), "/api/v1/admin/users/overview-stats", "POST")).status, 404);
  assert.equal((await call(new Fixture(), "/api/v1/admin/users/overview-stats", "GET", { origin: "https://untrusted.example" })).status, 403);
  const f = new Fixture(); f.afterAggregate = () => { f.gameScopeMode = "SELECTED_GAMES"; f.gameIds = []; };
  const revoked = await call(f, "/api/v1/admin/users/overview-stats");
  assert.equal(revoked.status, 403); assert.equal(revoked.body.total, undefined);
});

test("mount only captures exact overview-stats paths and leaves object/list routers untouched", async () => {
  let middleware: any;
  mountAdminDomainSummary({ getHttpAdapter: () => ({ getInstance: () => ({ use(_prefix: string, fn: any) { middleware = fn; } }) }) } as any, directorySecurityFixture(new Fixture()));
  let next = 0;
  for (const path of ["/api/v1/admin/users", "/api/v1/admin/users/person-a", "/api/v1/admin/orders/a/settlement", "/api/v1/admin/users/overview-stats/extra"]) {
    await middleware({ url: path, originalUrl: path }, {}, () => next++);
  }
  assert.equal(next, 4);
});
