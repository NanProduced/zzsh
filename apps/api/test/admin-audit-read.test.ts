import { strict as assert } from "node:assert";
import { test } from "node:test";

import { handleAdminAuditRoute } from "../src/auth/admin-audit";

function harness(isBoss: boolean, permissions = ["admin.audit.read"]) {
  const auditQueries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes('FROM "zzsh_iam"."admin_security"')) {
        return { rows: [{ status: "ACTIVE", isBoss, passwordChangeRequired: false }] };
      }
      if (sql.includes('FROM "zzsh_iam"."audit_event"')) {
        auditQueries.push({ sql, values });
        return { rows: [{
          id: "scope-event", actorUsername: "zz00001", actorDisplayUsername: "ZZ00001", actorName: "操作者",
          action: "admin.game_scope.assigned", objectType: "admin_user", objectId: "admin-self",
          outcome: "SUCCESS", reason: null, requestId: "scope-request", occurredAt: "2026-10-11T00:00:00Z",
          details: { before: { mode: "ALL_GAMES" }, after: { mode: "SELECTED_GAMES", gameIds: [] }, secret: "fixture-only" },
        }] };
      }
      return { rows: permissions.map((permissionCode) => ({ permissionCode })) };
    },
  };
  let body: Record<string, unknown> = {};
  const response = {
    headersSent: false,
    statusCode: 0,
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; },
    json(value: Record<string, unknown>) { body = value; },
  };
  return {
    auditQueries,
    response,
    body: () => body,
    read: (query = "action=admin.game_scope.assigned&objectType=admin_user&objectId=admin-self") => handleAdminAuditRoute(
      { originalUrl: `/api/v1/admin/security/audit/events?${query}`, method: "GET" } as never,
      response as never,
      "fixture-request",
      { pool } as never,
      async () => ({ userId: "admin-self", sessionId: "fixture-session" }),
    ),
  };
}

test("scope changes are read through the existing audit route and sanitized", async () => {
  const view = harness(true);
  await view.read();
  assert.equal(view.response.statusCode, 200);
  const events = view.body().events as { eventId: string; action: string; details: Record<string, unknown> }[];
  const event = events[0];
  const query = view.auditQueries[0];
  assert.ok(event);
  assert.ok(query);
  assert.equal(event.eventId, "scope-event");
  assert.equal(event.action, "admin.game_scope.assigned");
  assert.deepEqual(event.details.after, { mode: "SELECTED_GAMES", gameIds: [] });
  assert.equal("secret" in event.details, false);
  assert.ok((query.values[1] as string[]).includes("admin.game_scope.assigned"), "unfiltered SQL whitelist must retain scope events too");
});

test("scope audit reads retain the current staff target restriction", async () => {
  const view = harness(false);
  await view.read();
  assert.equal(view.body().scope, "SELF_TARGET_AND_ROLE_ACTIONS");
  const query = view.auditQueries[0];
  assert.ok(query);
  assert.match(query.sql, /e\."object_id" = \$4 OR/);
  assert.equal(query.values[3], "admin-self");
});

test("new audit action does not waive permission or allow unrelated domain events", async () => {
  const denied = harness(false, []);
  await assert.rejects(denied.read(), { status: 403 });
  assert.equal(denied.auditQueries.length, 0);
  const boss = harness(true);
  await assert.rejects(boss.read("action=approval.request.created"), { status: 400 });
  assert.equal(boss.auditQueries.length, 0);
});

test("all-audit and purge reads reject a Boss whose fresh security state is frozen or requires a password change", async () => {
  for (const security of [
    { status: "FROZEN", isBoss: true, passwordChangeRequired: false },
    { status: "ACTIVE", isBoss: true, passwordChangeRequired: true },
  ]) for (const route of ["/audit/operations", "/audit/purge/preview"]) {
    let protectedQueries = 0;
    const pool = { async query(sql: string) {
      if (sql.includes('FROM "zzsh_iam"."admin_security"')) return { rows: [security] };
      protectedQueries++; return { rows: [] };
    } };
    await assert.rejects(handleAdminAuditRoute(
      { method: "GET", originalUrl: "/api/v1/admin/security" + route } as never,
      {} as never, "dynamic-boss", { pool } as never,
      async () => ({ userId: "boss-actor", sessionId: "fixture-session" }),
    ), (error: any) => error.status === 403);
    assert.equal(protectedQueries, 0, "initial readContext success does not bypass the fresh actor state");
  }
});

// Step-up is enforced by the outer security handler; this checks the purge route's own transaction/actor gate.
test("audit purge locks and rechecks its actor before calling the definer on that same client", async () => {
  for (const inside of [
    { status: "FROZEN", isBoss: true, passwordChangeRequired: false },
    { status: "ACTIVE", isBoss: true, passwordChangeRequired: true },
    { status: "ACTIVE", isBoss: false, passwordChangeRequired: false },
    { status: "ACTIVE", isBoss: true, passwordChangeRequired: false },
  ]) {
    const statements: string[] = []; let locked = false, purgeCalls = 0, released = 0, body: any;
    const client = { release() { released++; }, async query(sql: string, args: unknown[] = []) {
      statements.push(sql);
      if (sql.includes('FROM "zzsh_iam"."admin_security"')) {
        if (sql.includes("FOR UPDATE")) locked = true;
        return { rows: [inside], rowCount: 1 };
      }
      if (sql.includes("purge_admin_audit_events")) {
        assert.equal(locked, true);
        assert.deepEqual(args, [180, "boss-actor", "fixture-session", "purge-lock", false]);
        purgeCalls++; return { rows: [{ deleted: "2", cutoff: "2026-01-01T00:00:00Z" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    } };
    const pool = { connect: async () => client, async query(sql: string) {
      assert(sql.includes('FROM "zzsh_iam"."admin_security"'), "the purge function must run on the transaction client");
      return { rows: [{ status: "ACTIVE", isBoss: true, passwordChangeRequired: false }] };
    } };
    const response = { headersSent: false, status() { return this; }, setHeader() { return this; }, json(value: unknown) { body = value; } };
    const run = () => handleAdminAuditRoute(
      { method: "POST", originalUrl: "/api/v1/admin/security/audit/purge", body: { retentionDays: 180, confirmText: "删除180天前的日志" } } as never,
      response as never, "purge-lock", { pool } as never, async () => ({ userId: "boss-actor", sessionId: "fixture-session" }),
    );
    const allowed = inside.status === "ACTIVE" && inside.isBoss && !inside.passwordChangeRequired;
    if (allowed) { await run(); assert.equal(body.deletedCount, 2); assert.equal(purgeCalls, 1); assert(statements.includes("COMMIT")); }
    else { await assert.rejects(run(), (error: any) => error.status === 403); assert.equal(purgeCalls, 0); assert(statements.includes("ROLLBACK")); }
    assert.equal(released, 1);
  }
});
