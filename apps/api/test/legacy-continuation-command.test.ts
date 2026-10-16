import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { conflict, fingerprintRequest, withIdempotency } from "../src/supply/supply-util";
import { planLegacyContinuation } from "../src/order/legacy-continuation-calc";
import { initialLegacyFacts, sealLegacyFacts, type LegacyContinuationActor, type LegacyDutyRow, type LegacyHeadRow } from "../src/order/legacy-continuation-model";
import { applyLegacyContinuationCommand, applyLegacyDutyCommand, authorizeLegacyMutation, legacyCommandOutcome, parseLegacyMutation } from "../src/order/legacy-continuation-command";
import { legacyBinding, legacyEvidence, legacyQuantities, legacySource } from "./legacy-continuation-fixture";

const evidence: typeof import("../src/order/legacy-continuation-evidence") = require("../src/order/legacy-continuation-evidence");
const userAuth: typeof import("../src/auth/user-identity") = require("../src/auth/user-identity");
const adminAuth: typeof import("../src/auth/auth-security") = require("../src/auth/auth-security");
const access: typeof import("../src/auth/admin-authorization") = require("../src/auth/admin-authorization");
const actor = (realm: "user" | "admin", role: "owner" | "renter" = "renter"): LegacyContinuationActor => ({ realm, userId: realm === "admin" ? "fixture_admin" : role === "owner" ? legacyBinding.ownerUserId : legacyBinding.renterUserId, sessionId: "fixture_session", requestId: "req_fixture" });
const empty = { rows: [], rowCount: 0 };
type Query = { sql: string; values: unknown[] };
function clientFor(handler: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount: number } = () => empty) {
  const calls: Query[] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return handler(sql, values); } } as unknown as PoolClient;
  return { client, calls };
}
function arrange(t: import("node:test").TestContext, source = legacySource(), head: LegacyHeadRow | null = null, duties: LegacyDutyRow[] = []) {
  const facts = initialLegacyFacts(source), row = legacyEvidence(facts);
  t.mock.method(evidence, "readLegacyContinuationBinding", async () => legacyBinding);
  t.mock.method(evidence, "authorizeLegacyContinuation", async () => ({ canOperate: true, canReadCommission: true }));
  t.mock.method(evidence, "readLegacyContinuationUserIds", async () => [legacyBinding.ownerUserId,legacyBinding.renterUserId].sort());
  t.mock.method(evidence, "lockLegacyContinuationOrder", async () => ({ head, duties }));
  t.mock.method(evidence, "readLegacyContinuationEvidence", async () => row);
  const probe = clientFor(sql => sql.includes("maturityAt") && sql.includes("SELECT to_char") ? { rows: [{ at: "2026-10-16T02:03:04.123456Z", maturityAt: "2026-10-23T02:03:04.123456Z" }], rowCount: 1 } : sql.startsWith("UPDATE zzsh_order.legacy_continuation_version") ? { rows: [], rowCount: 1 } : empty);
  return { ...probe, facts, row };
}
function mutation(source: ReturnType<typeof legacySource>, kind: "propose" | "confirm" | "reject" | "hold" | "release" | "confiscate", who: LegacyContinuationActor) {
  const role = who.realm === "admin" ? "admin" : who.userId === legacyBinding.ownerUserId ? "owner" : "renter";
  const quantities = legacyQuantities("0.10"), caller = { role, legacyUserId: role === "owner" ? "22" : role === "renter" ? "11" : "" } as const;
  const plan = planLegacyContinuation(initialLegacyFacts(source).evidence, kind === "propose" ? { kind, caller, quantities } : { kind, caller });
  assert(plan.ok, plan.ok ? "" : plan.code);
  return parseLegacyMutation(kind, { expectedRevision: null, inputEvidenceId: "fixture_evidence", planFingerprint: plan.fingerprint, ...(kind === "propose" ? { quantities } : {}) });
}
test("first imported 8/9 confirms without a head, derives complete facts and creates separate non-financial duties", async t => {
  for (const stage of ["8", "9"]) {
    const source = legacySource({ orderStatus: stage, quantities: legacyQuantities("10.00"), saleEarnings: "13.00", returnOrderMoney: "87.00" });
    const p = arrange(t, source), who = actor("user", stage === "8" ? "owner" : "renter"), input = mutation(source, "confirm", who);
    const result = await applyLegacyContinuationCommand(p.client, who, legacyBinding.id, input);
    assert.equal(result.body.stage, "4");
    const inserted = p.calls.find(q => q.sql.startsWith("INSERT INTO zzsh_order.legacy_continuation_evidence")); assert(inserted);
    const facts = JSON.parse(String(inserted.values[9]));
    assert.equal(facts.evidence.source.returnOrderMoney, "87.00"); assert.equal(facts.amounts.refundNet, "82.00"); assert.equal(facts.evidence.source.detainMoney, "5.00");
    const sealed = sealLegacyFacts(facts); assert.equal(inserted.values[11], sealed.digest);
    const duties = p.calls.filter(q => q.sql.startsWith("INSERT INTO zzsh_order.legacy_order_duty"));
    assert.deepEqual(duties.map(d => [d.values[3], d.values[6]]), [["RENTER_REFUND", "8200"], ["OWNER_CREDIT", "1300"]]);
    assert(!p.calls.some(q => /finance_ledger|ledger_entry|payment_intent|im_order_group|INSERT INTO zzsh_order.rental_order/.test(q.sql)));
    t.mock.restoreAll();
  }
});
test("CAS and exact preview fingerprint reject before mutation; first proposal carries full source and delta", async t => {
  const p = arrange(t), who = actor("user"), input = mutation(legacySource(), "propose", who);
  await assert.rejects(() => applyLegacyContinuationCommand(p.client, who, legacyBinding.id, { ...input, expectedRevision: "1" }), /CONTINUATION_REVISION_CONFLICT/);
  await assert.rejects(() => applyLegacyContinuationCommand(p.client, who, legacyBinding.id, { ...input, planFingerprint: "0".repeat(64) }), /PLAN_FINGERPRINT_MISMATCH/);
  assert(!p.calls.some(q => /INSERT|UPDATE/.test(q.sql)));
  await applyLegacyContinuationCommand(p.client, who, legacyBinding.id, input);
  const version = p.calls.find(q => q.sql.startsWith("INSERT INTO zzsh_order.legacy_continuation_version")); assert(version);
  assert.equal(version.values[7], "8"); assert.equal(version.values[5], "fixture_evidence");
});
test("finance UNKNOWN refuses deposit operations; positive refund blocks, absent resolver cannot imply no payment", async t => {
  const source = legacySource({ orderStatus: "4", isSettle: "2", quantities: legacyQuantities("10.00"), saleEarnings: "13.00", returnOrderMoney: "87.00" });
  const p = arrange(t, source), who = actor("admin"), input = mutation(source, "release", who);
  await assert.rejects(() => applyLegacyContinuationCommand(p.client, who, legacyBinding.id, input), /FINANCE_FACT_UNAVAILABLE/);
  await assert.rejects(() => applyLegacyContinuationCommand(p.client, who, legacyBinding.id, input, async () => "UNKNOWN"), /FINANCE_FACT_UNKNOWN/);
  await assert.rejects(() => applyLegacyContinuationCommand(p.client, who, legacyBinding.id, input, async () => "POSTED_POSITIVE_REFUND"), /DEPOSIT_ALREADY_SETTLED/);
  assert(!p.calls.some(q => /INSERT|UPDATE/.test(q.sql)));
  const result = await applyLegacyContinuationCommand(p.client, who, legacyBinding.id, input, async () => "NONE"); assert.equal(result.body.stage, "4");
  const derived = p.calls.find(q => q.sql.startsWith("INSERT INTO zzsh_order.legacy_continuation_evidence")); assert(derived);
  const facts = JSON.parse(String(derived.values[9])); assert.equal(facts.amounts.returnOrderMoney, "87.00"); assert.equal(facts.amounts.detainMoney, "5.00");
  assert.equal(p.calls.filter(q => q.sql.startsWith("INSERT INTO zzsh_order.legacy_order_duty")).length, 0);
});
test("definitive business refusal rolls all action effects back before retaining same-key rejection; DB failure propagates", async () => {
  const p = clientFor();
  const result = await legacyCommandOutcome(p.client, actor("user"), legacyBinding.id, async () => { await p.client.query("INSERT ACTION_EFFECT"); throw conflict("STALE_FACTS"); });
  assert.equal(result.status, 409);
  assert.deepEqual(p.calls.slice(0, 4).map(q => q.sql), ["SAVEPOINT legacy_continuation_action", "INSERT ACTION_EFFECT", "ROLLBACK TO SAVEPOINT legacy_continuation_action", "RELEASE SAVEPOINT legacy_continuation_action"]);
  assert(p.calls[4]!.sql.includes("audit_event"));
  await assert.rejects(() => legacyCommandOutcome(p.client, actor("user"), legacyBinding.id, async () => { throw new Error("database disconnected"); }), /database disconnected/);
});
test("beneficiary-set drift under common order lock refuses before writes rather than taking a late third-party user lock",async t=>{
 const p=arrange(t),who=actor("user"),input=mutation(legacySource(),"propose",who);let reads=0;
 t.mock.method(evidence,"readLegacyContinuationUserIds",async()=>++reads===1?[legacyBinding.ownerUserId,legacyBinding.renterUserId].sort():[legacyBinding.ownerUserId,legacyBinding.renterUserId,"third-beneficiary"].sort());
 await assert.rejects(()=>applyLegacyContinuationCommand(p.client,who,legacyBinding.id,input),/CONTINUATION_BENEFICIARIES_CHANGED/);assert(!p.calls.some(q=>/INSERT|UPDATE/.test(q.sql)));
});
test("real standard idempotency rechecks current party/session and O permission before success replay, skips only business CAS", async t => {
  const who = actor("admin"), input = { kind: "hold" }, operation = "order.legacy.continuation.hold";
  let session = true, cap = true, sessionCalls = 0, actionCalls = 0;
  t.mock.method(evidence, "readLegacyContinuationBinding", async () => legacyBinding);
  t.mock.method(adminAuth, "assertAdminContextInTransaction", async () => { sessionCalls++; if (!session) throw conflict("SESSION_REVOKED"); });
  t.mock.method(require("../src/auth/admin-scope") as typeof import("../src/auth/admin-scope"), "readAdminGameScope", async () => ({ mode: "SELECTED_GAMES", gameIds: [legacyBinding.gameId] }));
  t.mock.method(access, "loadEffectiveAdminAccess", async () => ({ status: "ACTIVE", isBoss: false, permissions: new Set(cap ? ["order.read", "order.legacy.continue"] : ["order.read"]) }) as Awaited<ReturnType<typeof access.loadEffectiveAdminAccess>>);
  const fp = fingerprintRequest(operation, legacyBinding.id, input);
  const p = clientFor(sql => sql.includes('"request_fingerprint" AS') ? { rows: [{ requestFingerprint: fp, responseStatus: 200, responseBody: { revision: "1" }, publishRequired: false }], rowCount: 1 } : sql.includes("AS valid") ? { rows: [{ valid: true }], rowCount: 1 } : sql.includes("admin_game_scope") ? { rows: [{ game_id: legacyBinding.gameId }], rowCount: 1 } : { rows: [{ allowed: true }], rowCount: 1 });
  const run = () => withIdempotency(p.client, { realm: "admin", principalId: who.userId, operation, resourceId: legacyBinding.id }, "ORIGINAL_KEY", fp, (replay) => authorizeLegacyMutation(p.client, who, legacyBinding.id,!!replay).then(() => undefined), async () => { actionCalls++; return { status: 200, body: {} }; });
  assert.equal((await run()).replayed, true); assert.equal(actionCalls, 0); assert.equal(sessionCalls, 1);
  cap = false; await assert.rejects(run); session = false; await assert.rejects(run, /SESSION_REVOKED/); assert.equal(actionCalls, 0);
  assert(p.calls.some(q => q.sql.includes('zzsh_auth_user."user"') && q.sql.includes("ORDER BY id FOR UPDATE")));
  assert(!p.calls.some(q => /legacy_continuation_version|legacy_order_duty/.test(q.sql)));
});
test("unrelated user is denied before session/resource lookup and no-op settled/matured duty commands remain rejected", async t => {
  t.mock.method(userAuth, "assertUserContextInTransaction", async () => { throw new Error("must not reach"); });
  const p = clientFor(); await assert.rejects(() => evidence.authorizeLegacyContinuation(p.client, { ...actor("user"), userId: "other" }, legacyBinding), (e: unknown) => (e as { status: number }).status === 404); assert.equal(p.calls.length, 0);
  arrange(t);
  await assert.rejects(() => applyLegacyDutyCommand(p.client, actor("user"), legacyBinding.id, { kind: "mature", dutyId: "fixture_duty", expectedRevision: "1" }), /DUTY_NOT_AUTHORIZED/);
});
