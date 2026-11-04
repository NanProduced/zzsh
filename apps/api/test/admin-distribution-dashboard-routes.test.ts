import { test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";
import { handleAdminDistributionDashboard } from "../src/finance/admin-distribution-dashboard-routes";

type Environment = ReturnType<typeof environment>;

function environment(patch: {
  isBoss?: boolean;
  permissions?: string[];
  mode?: "ALL_GAMES" | "SELECTED_GAMES";
  gameIds?: string[];
  legacy?: boolean;
  authenticated?: boolean;
  earnings?: any[];
  participants?: any[];
  revokeAfterRead?: boolean;
  versionError?: string;
} = {}) {
  const state = {
    isBoss: patch.isBoss ?? false,
    permissions: patch.permissions ?? [],
    mode: patch.mode ?? "ALL_GAMES",
    gameIds: patch.gameIds ?? [],
    legacy: patch.legacy ?? true,
    authenticated: patch.authenticated ?? true,
    earnings: patch.earnings ?? [],
    participants: patch.participants ?? [],
    participantRevision: "1",
    calls: [] as { sql: string; values: unknown[] }[],
  };
  const rows = (values: any[] = []) => ({ rows: values, rowCount: values.length });
  const query = async (sql: string, values: unknown[] = []) => {
    state.calls.push({ sql, values });
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/.test(sql) || sql.includes("set_config(")) return rows();
    if (sql.includes('FROM "zzsh_auth_admin"."session" s JOIN')) return rows([{ locked: false, twoFactorEnabled: true, suspended: false }]);
    if (sql.includes('"game_scope_mode" AS "mode"')) return rows([{ mode: state.mode, gameIds: state.gameIds }]);
    if (sql.includes('SELECT "status", "is_boss" AS "isBoss"')) return rows([{ status: "ACTIVE", isBoss: state.isBoss, passwordChangeRequired: false }]);
    if (sql.includes("WITH role_permissions")) return rows(state.permissions.map(permissionCode => ({ permissionCode })));
    if (sql.includes("to_regclass")) return rows([{ native: true, legacy: state.legacy }]);
    if (sql.includes("WITH visible_earnings AS")) {
      if (patch.versionError) throw Object.assign(new Error("PRIVATE SQL AND TOKEN MUST NOT BE LOGGED"), { code: patch.versionError });
      return rows([{ native: "native", events: "events", legacy: "legacy", participants: state.participantRevision, relations: "relations" }]);
    }
    if (sql.includes("clock_timestamp()::text AS at")) return rows([{ at: "2026-11-02T03:00:00.000000Z" }]);
    if (sql.includes("WITH rows AS")) { if (patch.revokeAfterRead) state.permissions = []; return rows(state.earnings); }
    if (sql.includes("/* original distribution qualifications */")) return rows();
    if (sql.includes("FROM dashboard_records WHERE beneficiary_id=ANY")) return rows();
    if (sql.includes("FROM zzsh_order.distribution_participant p")) return rows(state.participants);
    if (sql.includes("WHERE r.child_user_id=$1")) return rows([{ type: "DISTRIBUTION_LEADER", parent_user_id: "parent-1", name: "上级", source_type: "NATIVE", policy_version_id: "policy-1" }]);
    throw new Error("unexpected dashboard route SQL: " + sql.slice(0, 100));
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const options = {
    pool, apiOrigin: "http://api.local", adminOrigin: "http://admin.local", userOrigin: "http://user.local",
    adminAuth: { api: { getSession: async () => state.authenticated ? { user: { id: "admin-1", twoFactorEnabled: true }, session: { id: "session-1", locked: false } } : null } },
    listingCursorKey: { keyId: "test", secret: "k".repeat(32) },
  };
  return { state, options, query };
}

function invoke(env: Environment, method: string, path: string) {
  const result: { status: number; json: any; headers: Record<string, string> } = { status: 0, json: null, headers: {} };
  const response = {
    headersSent: false,
    status(code: number) { result.status = code; return this; },
    setHeader(name: string, value: string | string[]) { result.headers[name] = Array.isArray(value) ? value.join(",") : value; return this; },
    json(body: unknown) { result.json = body; return this; },
    send(body: unknown) { result.json = body; return this; },
    end() {},
    once() {},
  };
  return handleAdminDistributionDashboard(
    { method, url: `/api/v1/admin/distribution${path}`, originalUrl: `/api/v1/admin/distribution${path}`, headers: { origin: "http://admin.local", cookie: "session=test" } } as any,
    response as any,
    env.options as any,
  ).then(() => result);
}

const earning = (total: number) => ({
  id: "earning-1", source: "NATIVE", beneficiary_id: "user-1", beneficiary_name: "受益人", role: "OWNER_REFERRAL",
  order_id: "order-1", order_number: "ZZ-1", amount_cents: "95", recovery_cents: null, state: "SETTLED",
  occurred_at: "2026-10-19T11:51:09.937Z", settled_at: "2026-10-19T11:51:41.130Z", due_at: "2026-10-19T11:51:09.855Z",
  recorded_at: "2026-10-19T11:51:09.937Z", game_id: "game-1", total,
});
const participant = (total: number) => ({
  user_id: "user-1", name: "受益人", eligibility: "ELIGIBLE", commission_frozen: false, level_code: "L1",
  inviter_knowledge: "KNOWN_NONE", leader_knowledge: "KNOWN_PARENT", source_type: "NATIVE", revision: "1",
  leader_children: 0, inviter_children: 0, settled_cents: "95", pending_cents: "0", recovery_cents: "0", total,
});

test("dashboard routes reject unsupported methods, missing page tokens and unauthenticated reads", async () => {
  const env = environment({ isBoss: true });
  assert.equal((await invoke(env, "POST", "/overview")).status, 404);
  assert.equal((await invoke(env, "GET", "/earnings?page=2")).status, 400);
  assert.equal((await invoke(env, "GET", "/earnings?page=2")).json.error.code, "INVALID_ARGUMENT");
  const anonymous = environment({ authenticated: false });
  assert.equal((await invoke(anonymous, "GET", "/overview")).status, 401);
});

test("non-Boss dashboard reads need the dedicated permission and selected-game scope cannot open the global network", async () => {
  const denied = environment({ permissions: [] });
  assert.equal((await invoke(denied, "GET", "/earnings")).status, 403);
  assert.equal((await invoke(denied, "GET", "/earnings")).json.error.code, "FORBIDDEN");

  const scoped = environment({ permissions: ["distribution.dashboard.read"], mode: "SELECTED_GAMES", gameIds: ["game-1"], earnings: [earning(1)] });
  const earnings = await invoke(scoped, "GET", "/earnings?page=1&pageSize=20");
  assert.equal(earnings.status, 200);
  assert.equal(earnings.json.items[0].source, "NATIVE");
  assert.equal(earnings.json.scope.network, "UNAVAILABLE");
  assert.ok(earnings.json.scope.reasonCodes.includes("GLOBAL_RELATION_SCOPE_UNAVAILABLE"));
  const participants = await invoke(scoped, "GET", "/participants");
  assert.equal(participants.status, 403);
  assert.match(participants.json.error.message, /Global distribution network/);
});

test("Boss earnings and participant pagination bind snapshot, exact offsets and participant detail lookup", async () => {
  const env = environment({ isBoss: true, earnings: [earning(41)], participants: [participant(5)] });
  const first = await invoke(env, "GET", "/earnings?page=1&pageSize=20");
  assert.equal(first.status, 200);
  assert.ok(env.state.calls.some(call => call.sql.includes("set_config('max_parallel_workers_per_gather','0',true)")));
  assert.equal(first.json.total, "41");
  assert.equal(first.json.hasMore, true);
  assert.ok(first.json.snapshot);
  const firstList = env.state.calls.filter(call => call.sql.includes("WITH rows AS")).at(-1)!;
  assert.deepEqual(firstList.values.slice(-2), [20, 0]);

  const second = await invoke(env, "GET", `/earnings?page=2&pageSize=20&snapshot=${encodeURIComponent(first.json.snapshot)}`);
  assert.equal(second.status, 200);
  const secondList = env.state.calls.filter(call => call.sql.includes("WITH rows AS")).at(-1)!;
  assert.deepEqual(secondList.values.slice(-2), [20, 20]);
  assert.equal(second.json.items[0].settledAt, "2026-10-19T11:51:41.130Z");

  const participants = await invoke(env, "GET", "/participants?page=1&pageSize=2");
  assert.equal(participants.status, 200);
  assert.equal(participants.json.total, "5");
  assert.ok(participants.json.snapshot);
  const participantPage = env.state.calls.filter(call => call.sql.includes("ORDER BY p.user_id LIMIT")).at(-1)!;
  assert.deepEqual(participantPage.values.slice(-2), [2, 0]);

  const next = await invoke(env, "GET", `/participants?page=2&pageSize=2&snapshot=${encodeURIComponent(participants.json.snapshot)}`);
  assert.equal(next.status, 200);
  const nextPage = env.state.calls.filter(call => call.sql.includes("ORDER BY p.user_id LIMIT")).at(-1)!;
  assert.deepEqual(nextPage.values.slice(-2), [2, 2]);

  const detail = await invoke(env, "GET", "/participants/user-1");
  assert.equal(detail.status, 200);
  assert.equal(detail.json.participant.userId, "user-1");
  assert.equal(detail.json.relations[0].parentName, "上级");
  const exact = env.state.calls.filter(call => call.sql.includes("ORDER BY p.user_id LIMIT")).at(-1)!;
  assert.equal(exact.values[0], "user-1");
  assert.deepEqual(exact.values.slice(-2), [20, 0]);
});

test("participant edits invalidate a previously signed page even when participant count is unchanged", async () => {
  const env = environment({ isBoss: true, participants: [participant(5)] });
  const first = await invoke(env, "GET", "/participants?pageSize=2");
  assert.equal(first.status, 200);
  env.state.participantRevision = "2";
  const next = await invoke(env, "GET", `/participants?page=2&pageSize=2&snapshot=${encodeURIComponent(first.json.snapshot)}`);
  assert.equal(next.status, 409);
});

test("permission removal during a read rejects the response before exposing its already loaded rows", async () => {
  const env = environment({ permissions: ["distribution.dashboard.read"], earnings: [earning(1)], revokeAfterRead: true });
  const response = await invoke(env, "GET", "/earnings");
  assert.equal(response.status, 403);
  assert.equal(response.json.items, undefined);
});

test("capacity and read-budget failures keep safe diagnostics and return retryable reads without exposing SQL", async t => {
  const logs: unknown[] = [];
  t.mock.method(Logger, "warn", (event: unknown) => { logs.push(event); });
  for (const [code, status] of [["53100", 503], ["53200", 503], ["53300", 503], ["57014", 504], ["XX000", 500]] as const) {
    const response = await invoke(environment({ isBoss: true, versionError: code }), "GET", "/earnings");
    assert.equal(response.status, status);
    assert.doesNotMatch(JSON.stringify(response.json), /PRIVATE|SQL AND TOKEN/);
  }
  assert.deepEqual(logs.map((entry: any) => entry.code), ["53100", "53200", "53300", "57014", "XX000"]);
  assert.ok(logs.every((entry: any) => entry.event === "distribution.dashboard.read_failed" && typeof entry.requestId === "string"));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|SQL AND TOKEN/);
});
