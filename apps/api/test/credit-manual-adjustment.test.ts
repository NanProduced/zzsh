import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { writeManualCreditAdjustment, recoveryEligibility, type CreditEvent } from "../src/credit/credit-guarantee";
import { mountCreditGuaranteeRoutes } from "../src/credit/credit-guarantee-routes";
import { SecurityApiError } from "../src/auth/security-core";

const subject = "synthetic-user";
const actor = "synthetic-admin";
const initialInput = { kind: "DEDUCT" as const, userId: subject, actorAdminId: actor, expectedRevision: "7", amount: 17, visibleReason: "人工核实扣分说明" };
type StoredEvent = CreditEvent & { payloadHash: string };

function fixture({ initialized = true, score = 70, inScope = true } = {}) {
  const state = { userId: subject, score, revision: "7", initializedAt: "2026-10-22T00:00:00Z" };
  const events = new Map<string, StoredEvent>();
  const receipts = new Map<string, { requestFingerprint: string; responseStatus: number; responseBody: unknown }>();
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  let before: { state: typeof state; events: typeof events; receipts: typeof receipts } | null = null;
  let failAudit = false;
  const rows = (values: unknown[]) => ({ rows: values, rowCount: values.length });
  const query = async (sql: string, args: unknown[] = []) => {
    queries.push({ sql, args });
    if (sql === "BEGIN") { before = { state: { ...state }, events: new Map(events), receipts: new Map(receipts) }; return rows([]); }
    if (sql === "ROLLBACK") {
      if (before) { Object.assign(state, before.state); events.clear(); for (const pair of before.events) events.set(...pair); receipts.clear(); for (const pair of before.receipts) receipts.set(...pair); }
      return rows([]);
    }
    if (sql === "COMMIT" || sql.startsWith("SELECT set_config") || sql.includes("pg_advisory_xact_lock")) return rows([]);
    if (sql.includes('FROM "zzsh_supply"."idempotency_record"')) {
      const receipt = receipts.get(JSON.stringify(args)); return rows(receipt ? [receipt] : []);
    }
    if (sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')) {
      receipts.set(JSON.stringify(args.slice(0, 2)), { requestFingerprint: String(args[2]), responseStatus: Number(args[3]), responseBody: JSON.parse(String(args[4])) }); return rows([]);
    }
    if (sql.includes("FROM zzsh_credit.user_credit_state")) return rows(initialized && args[0] === subject ? [{ ...state }] : []);
    if (sql.includes("FROM zzsh_credit.credit_event e") && sql.includes('AS "appliedDeltaScore"')) {
      const event = events.get(String(args[0]));
      if (!event || event.userId !== args[1] || event.eventType !== "MANUAL_DEDUCTION" || event.sourceType !== "USER_MANUAL") return rows([]);
      return rows([{ appliedDeltaScore: event.appliedDeltaScore, reversed: [...events.values()].some(item => item.reversalOfId === event.id) }]);
    }
    if (sql.includes("INSERT INTO zzsh_credit.credit_event")) {
      assert.doesNotMatch(sql, /'INITIALIZED'/);
      const event: StoredEvent = { id: String(args[0]), userId: String(args[1]), eventKey: String(args[2]), eventType: args[3] as CreditEvent["eventType"], sourceType: "USER_MANUAL", sourceId: String(args[1]), subjectRole: null,
        deltaScore: Number(args[4]), appliedDeltaScore: Number(args[5]), scoreBefore: Number(args[6]), scoreAfter: Number(args[7]), visibleReason: String(args[8]), actorAdminId: String(args[9]), reversalOfId: args[10] as string | null,
        internalBasis: "credit-policy-v1:user-manual", payloadHash: String(args[11]), createdAt: "2026-10-22T01:00:00Z", reversed: false };
      assert.equal(event.scoreBefore, state.score); assert.equal(event.appliedDeltaScore, event.scoreAfter - event.scoreBefore);
      events.set(event.id, event); return rows([event]);
    }
    if (sql.startsWith("UPDATE zzsh_credit.user_credit_state")) { assert.equal(args[0], subject); state.score = Number(args[1]); state.revision = String(BigInt(state.revision) + 1n); return rows([]); }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (failAudit) throw Error("synthetic audit failure"); return rows([]); }
    if (sql.includes('SELECT s."game_scope_mode"')) return rows([{ mode: "SELECTED_GAMES", gameIds: ["synthetic-game"] }]);
    if (sql.includes("SELECT 1 FROM zzsh_supply.rental_account")) return rows(inScope ? [{}] : []);
    throw Error(`Unexpected SQL: ${sql}`);
  };
  const client = { query, release() {} };
  return { state, events, receipts, queries, client, pool: { connect: async () => client }, failAudit() { failAudit = true; } };
}

test("manual deduction binds the existing score and user, without an invented order or initialization", async () => {
  const f = fixture(); const result = await writeManualCreditAdjustment(f.client as never, initialInput, "synthetic-key-1");
  const event = (result.body as { event: CreditEvent }).event;
  assert.equal(result.replayed, false); assert.equal(f.state.score, 53); assert.equal(f.state.revision, "8");
  assert.deepEqual([event.eventType, event.sourceType, event.sourceId, event.subjectRole, event.scoreBefore, event.scoreAfter, event.appliedDeltaScore], ["MANUAL_DEDUCTION", "USER_MANUAL", subject, null, 70, 53, -17]);
  assert.equal(event.visibleReason, initialInput.visibleReason); assert.equal(event.actorAdminId, actor);
  assert.ok(!event.eventKey.includes(actor) && !event.eventKey.includes("synthetic-key-1"), "user-readable event keys must not expose admin or retry identifiers");
  assert.ok(f.queries.some(item => item.sql.includes("FOR UPDATE"))); assert.ok(f.queries.every(item => !item.sql.includes('INSERT INTO zzsh_credit.user_credit_state')));
});

test("accepted replay resolves before CAS and never deducts twice; changed body or stale new command is rejected", async () => {
  const f = fixture(); await writeManualCreditAdjustment(f.client as never, initialInput, "synthetic-key-1");
  const replay = await writeManualCreditAdjustment(f.client as never, initialInput, "synthetic-key-1");
  assert.equal(replay.replayed, true); assert.equal(f.events.size, 1); assert.equal(f.state.score, 53);
  await assert.rejects(() => writeManualCreditAdjustment(f.client as never, { ...initialInput, amount: 18 }, "synthetic-key-1"), /different request/);
  await assert.rejects(() => writeManualCreditAdjustment(f.client as never, initialInput, "synthetic-key-2"), /已变化/);
  assert.equal(f.events.size, 1);
});

test("manual deduction rejects unknown initial state and amounts above the score without silently clipping", async () => {
  for (const f of [fixture({ initialized: false }), fixture({ score: 16 })]) {
    await assert.rejects(() => writeManualCreditAdjustment(f.client as never, initialInput, "synthetic-key-1"), (error: unknown) => error instanceof SecurityApiError && error.status === 409);
    assert.equal(f.events.size, 0); assert.equal(f.receipts.size, 0);
    assert.ok(f.queries.every(item => !item.sql.includes("INSERT INTO")));
  }
  const f = fixture({ score: 17 }); await writeManualCreditAdjustment(f.client as never, initialInput, "synthetic-key-1"); assert.equal(f.state.score, 0);
});

test("manual credit validates score, revision, explanation and original idempotency key before querying", async () => {
  const invalidBodies = [
    ...[0, -1, 101, 0.5, NaN, Infinity, "17", null].map(amount => ({ ...initialInput, amount })),
    ...["", "0", "07", "-7", "7.0", "9223372036854775808", 7, null].map(expectedRevision => ({ ...initialInput, expectedRevision })),
    ...["", " ", "单", "a".repeat(501), null].map(visibleReason => ({ ...initialInput, visibleReason })),
  ];
  for (const body of invalidBodies) {
    const f = fixture(); await assert.rejects(() => writeManualCreditAdjustment(f.client as never, body as never, "synthetic-key-1")); assert.equal(f.queries.length, 0);
  }
  for (const key of ["", "not a token", undefined]) {
    const f = fixture(); await assert.rejects(() => writeManualCreditAdjustment(f.client as never, initialInput, key as never)); assert.equal(f.queries.length, 0);
  }
});

test("manual correction appends the actual reverse delta and replays only its original request", async () => {
  const f = fixture(); const deducted = await writeManualCreditAdjustment(f.client as never, initialInput, "synthetic-key-1");
  const eventId = (deducted.body as { event: CreditEvent }).event.id;
  const correction = { kind: "REVERSE" as const, userId: subject, actorAdminId: actor, expectedRevision: "8", eventId, visibleReason: "复核后更正误扣" };
  const result = await writeManualCreditAdjustment(f.client as never, correction, "synthetic-reverse-1");
  const event = (result.body as { event: CreditEvent }).event;
  assert.equal(event.eventType, "MANUAL_DEDUCTION_REVERSED"); assert.equal(event.reversalOfId, eventId); assert.equal(event.deltaScore, 17); assert.equal(event.appliedDeltaScore, 17); assert.equal(f.state.score, 70); assert.equal(f.events.size, 2);
  assert.equal((await writeManualCreditAdjustment(f.client as never, correction, "synthetic-reverse-1")).replayed, true);
  await assert.rejects(() => writeManualCreditAdjustment(f.client as never, { ...correction, expectedRevision: "9" }, "synthetic-reverse-2"), /已更正/);
  assert.equal(f.events.size, 2);
});

test("manual correction cannot reverse an unrelated event and never mints points above 100", async () => {
  const f = fixture(); const deducted = await writeManualCreditAdjustment(f.client as never, initialInput, "synthetic-key-1"); const eventId = (deducted.body as { event: CreditEvent }).event.id;
  const correction = { kind: "REVERSE" as const, userId: subject, actorAdminId: actor, expectedRevision: "8", eventId, visibleReason: "复核后更正误扣" };
  await assert.rejects(() => writeManualCreditAdjustment(f.client as never, { ...correction, eventId: "synthetic-unrelated" }, "synthetic-reverse-missing"), error => error instanceof SecurityApiError && error.status === 404);
  f.state.score = 95;
  const result = await writeManualCreditAdjustment(f.client as never, correction, "synthetic-reverse-1"); const event = (result.body as { event: CreditEvent }).event;
  assert.equal(event.deltaScore, 17); assert.equal(event.appliedDeltaScore, 5); assert.equal(f.state.score, 100);
});

function response() { return { statusCode: 0, body: null as any, status(value: number) { this.statusCode = value; return this; }, setHeader() { return this; }, json(value: unknown) { this.body = value; return this; } }; }
function handler(f: ReturnType<typeof fixture>, prefix = "/api/bff/admin/credit") {
  const handlers = new Map<string, Function>();
  const options = { pool: f.pool, adminOrigin: "http://127.0.0.1:4201", userOrigin: "http://127.0.0.1:4200", apiOrigin: "http://127.0.0.1:4202" };
  mountCreditGuaranteeRoutes({ getHttpAdapter: () => ({ getInstance: () => ({ use: (path: string, fn: Function) => handlers.set(path, fn) }) }) } as never, options as never, false);
  return handlers.get(prefix)!;
}
function request(path = `/api/bff/admin/credit/users/${subject}/deductions`, body: unknown = { amount: 17, expectedRevision: "7", visibleReason: initialInput.visibleReason }, key: unknown = "synthetic-key-1") {
  return { method: "POST", originalUrl: path, headers: { origin: "http://127.0.0.1:4201", "idempotency-key": key }, body };
}
function mockAdmin(t: TestContext, { permitted = true, boss = false } = {}) {
  const auth = require("../src/auth/auth-security"); const authorization = require("../src/auth/admin-authorization");
  t.mock.method(auth, "readAdminContext", async () => ({ userId: actor, sessionId: "synthetic-admin-session" }));
  t.mock.method(auth, "assertAdminContextInTransaction", async () => {});
  t.mock.method(authorization, "loadEffectiveAdminAccess", async () => ({ status: "ACTIVE", isBoss: boss, permissions: new Set(permitted ? ["credit.decide"] : ["credit.read"]) }));
}

test("exact manual routes work with financial commands off and audit their user-visible reason", async t => {
  mockAdmin(t); const f = fixture(); const res = response(); await handler(f)(request(), res);
  assert.equal(res.statusCode, 200); assert.equal(f.state.score, 53); assert.equal(res.body.event.visibleReason, initialInput.visibleReason);
  assert.equal(res.body.event.internalBasis, undefined); assert.equal(res.body.event.actorAdminId, undefined);
  const audit = f.queries.find(item => item.sql.includes('INSERT INTO "zzsh_iam"."audit_event"'));
  assert.equal(audit?.args[4], "credit.manual.deducted"); assert.equal(audit?.args[9], initialInput.visibleReason); assert.equal(f.queries.at(-1)?.sql, "COMMIT");
  const reverse = response(); await handler(f)(request(`/api/bff/admin/credit/users/${subject}/deductions/${res.body.event.id}/reverse`, { expectedRevision: "8", visibleReason: "复核后更正误扣" }, "synthetic-reverse-1"), reverse);
  assert.equal(reverse.statusCode, 200); assert.equal(f.state.score, 70);
});

test("credit.read cannot write, user scope is rechecked and foreign origins do not reach the database", async t => {
  mockAdmin(t, { permitted: false }); const f = fixture(); const res = response(); await handler(f)(request(), res);
  assert.equal(res.statusCode, 403); assert.equal(f.events.size, 0);
  const foreign = response(); await handler(f)({ ...request(), headers: { origin: "http://foreign.invalid" } }, foreign);
  assert.equal(foreign.statusCode, 403); assert.equal(f.events.size, 0);
});

test("a new manual command cannot target a user outside the operator game scope", async t => {
  mockAdmin(t); const f = fixture({ inScope: false }); const res = response(); await handler(f)(request(), res);
  assert.equal(res.statusCode, 404); assert.equal(f.events.size, 0); assert.ok(f.queries.every(item => !item.sql.includes("zzsh_credit")));
});

test("missing or malformed key, extra fields, query overrides and invalid revision are rejected", async t => {
  mockAdmin(t);
  const missingKey = { ...request(), headers: { origin: "http://127.0.0.1:4201" } };
  for (const req of [missingKey, request(undefined, undefined, "bad key"), request(undefined, { amount: 1, expectedRevision: "7", visibleReason: "扣分说明", sourceType: "ORDER" }), request(`/api/bff/admin/credit/users/${subject}/deductions?userId=other`), request(undefined, { amount: 1, expectedRevision: 7, visibleReason: "扣分说明" })]) {
    const f = fixture(); const res = response();
    await handler(f)(req, res); assert.equal(res.statusCode, 400); assert.equal(f.events.size, 0);
  }
});

test("an audit failure rolls the manual command and its replay receipt back together", async t => {
  mockAdmin(t); const f = fixture(); f.failAudit(); const res = response(); await handler(f)(request(), res);
  assert.equal(res.statusCode, 500); assert.equal(f.events.size, 0); assert.equal(f.receipts.size, 0); assert.equal(f.state.score, 70); assert.equal(f.queries.at(-1)?.sql, "ROLLBACK");
});

test("the new allowlist does not release any old user/admin financial or credit command", async () => {
  for (const [prefix, path] of [["/api/bff/user/credit", "/recovery-requests"], ["/api/bff/user/credit", "/accounts/account/payment-intents"], ["/api/bff/user/credit", "/guarantees/requirement/refund-requests"], ["/api/bff/admin/credit", "/breaches"], ["/api/bff/admin/credit", "/events/event/reverse"], ["/api/bff/admin/credit", "/recovery-requests/request/decision"], ["/api/bff/admin/credit", "/guarantees/refund/release-decision"]] as const) {
    const f = fixture(); const res = response(); const req = request(prefix + path); req.headers.origin = prefix.includes("/user/") ? "http://127.0.0.1:4200" : "http://127.0.0.1:4201";
    await handler(f, prefix)(req, res); assert.equal(res.statusCode, 404); assert.equal(f.queries.length, 0);
  }
});

test("existing recovery cooldown also recognizes an unreversed manual deduction", async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => { queries.push(sql); return { rows: sql.includes("count(*)") ? [{ count: "1" }] : [], rowCount: sql.includes("FROM zzsh_credit.credit_event e") ? 1 : 0 }; } };
  const result = await recoveryEligibility(client as never, subject, async () => "NONE", { userId: subject, score: 70, revision: "7", initializedAt: "2026-10-22T00:00:00Z" });
  assert.ok(result.reasons.includes("RECENT_CONFIRMED_BREACH")); assert.match(queries[0]!, /'BREACH_CONFIRMED','MANUAL_DEDUCTION'/);
});
