import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { conflict, fingerprintRequest, withIdempotency,sha256Hex } from "../src/supply/supply-util";
import { planLegacyContinuation } from "../src/order/legacy-continuation-calc";
import { initialLegacyFacts, sealLegacyFacts, type LegacyContinuationActor, type LegacyDutyRow, type LegacyHeadRow } from "../src/order/legacy-continuation-model";
import { applyLegacyContinuationCommand, applyLegacyDutyCommand, authorizeLegacyMutation, legacyCommandOutcome, parseLegacyMutation } from "../src/order/legacy-continuation-command";
import { legacyBinding, legacyEvidence, legacyQuantities, legacySource } from "./legacy-continuation-fixture";
import { canonicalize } from "../src/supply/content-hash";

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

type VoidAudit = { id: string; actorType: string; actorId: string; sessionId: string; requestId: string; action: string; objectType: string; objectId: string; outcome: string; details: Record<string, unknown> };
type ReviewedVoid = { sourceDigest: string; decisionEvidenceRef: string | null; decidedBy: LegacyContinuationActor | null; decisionReason: string | null; factAudit: VoidAudit | null; voidAudit: VoidAudit | null };
function reviewedCommissionFixture(t: import("node:test").TestContext, stage: "8" | "9", mutate?: (proof: ReviewedVoid) => void) {
  const commission = { id: "41", beneficiaryId: "11", status: "1", ratio: "10", storedEarnings: "0.50", level: "1" };
  const source = legacySource({ orderStatus: stage, quantities: legacyQuantities("10.00"), saleEarnings: "13.00", returnOrderMoney: "80.00", commissions: [commission] });
  const duty: LegacyDutyRow = { id: "fixture_commission", orderId: legacyBinding.id, continuationVersionId: null, kind: "COMMISSION", sourceRecordId: "41", counterpartyUserId: legacyBinding.renterUserId, amountCents: "50", currency: "CNY", status: "PENDING", source: "LEGACY_IMPORT", sourceStatus: "1", level: "1", ratio: "10", maturityAt: null, revision: "1", settledBy: null, settledRefType: null, settledRefId: null, settledRefDigest: null };
  arrange(t, source, null, [duty]);
  t.mock.method(evidence, "lockLegacyContinuationOrder", async () => ({ head: null, duties: [structuredClone(duty)] }));
  t.mock.method(evidence, "legacyBeneficiaryUserId", async (_client: PoolClient, id: string) => id === "11" ? legacyBinding.renterUserId : null);
  const canonical = canonicalize({ id: "41", order_id: "7", user_id: "11", status: "3", level: "1", ratio: "10", earnings: "0.50" });
  const fact: VoidAudit = { id: "fixture_review", actorType: "admin", actorId: "fixture_reviewer", sessionId: "review_session", requestId: "req_review", action: "order.legacy.duty.source_fact_reviewed", objectType: "rental_order", objectId: legacyBinding.id, outcome: "SUCCESS", details: { sourceRecordId: "41", parentSourceDigest: legacyBinding.sourceDigest, sourceStatus: "3", parentCancelledNotPayable: false, sourceRecord: { canonical, digest: sha256Hex(canonical) }, parentCancellation: null, evidenceRef: "fixture:reviewed-status3" } };
  const proof: ReviewedVoid = { sourceDigest: legacyBinding.sourceDigest, decisionEvidenceRef: null, decidedBy: null, decisionReason: null, factAudit: fact, voidAudit: null };
  const audits: VoidAudit[] = [];
  let duplicateProof = false;
  const p = clientFor((sql, values) => {
    if (sql.includes(' AS "voidAudit"')) { const current = structuredClone(proof); mutate?.(current); return { rows: duplicateProof ? [current, current] : [current], rowCount: duplicateProof ? 2 : 1 }; }
    if (sql.includes("SELECT 1 FROM zzsh_iam.audit_event")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("maturityAt") && sql.includes("SELECT to_char")) return { rows: [{ at: "2026-10-16T02:03:04.123456Z", maturityAt: "2026-10-23T02:03:04.123456Z" }], rowCount: 1 };
    if (sql.startsWith("UPDATE zzsh_order.legacy_order_duty SET amount_cents")) { duty.amountCents = String(values[2]); duty.maturityAt = String(values[3]); duty.revision = (BigInt(duty.revision) + 1n).toString(); return { rows: [{ revision: duty.revision }], rowCount: 1 }; }
    if (sql.startsWith("UPDATE zzsh_order.legacy_order_duty SET status")) { duty.status = values[2] as LegacyDutyRow["status"]; duty.revision = (BigInt(duty.revision) + 1n).toString(); proof.decidedBy = JSON.parse(String(values[3])); proof.decisionReason = String(values[4]); proof.decisionEvidenceRef = values[5] as string; return { rows: [{ ...duty }], rowCount: 1 }; }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { const audit: VoidAudit = { id: String(values[0]), actorType: String(values[1]), actorId: String(values[2]), sessionId: String(values[3]), action: String(values[4]), objectType: String(values[5]), objectId: String(values[6]), outcome: String(values[7]), requestId: String(values[8]), details: JSON.parse(String(values[10])) }; audits.push(audit); if (audit.action === "order.legacy.duty.void") proof.voidAudit = audit; }
    return sql.startsWith("INSERT INTO zzsh_iam.membership_growth_contribution") ? { rows: [], rowCount: 1 } : empty;
  });
  const who = actor("user", stage === "8" ? "owner" : "renter"), input = mutation(source, "confirm", who);
  const confirm = () => applyLegacyContinuationCommand(p.client, who, legacyBinding.id, input);
  const voidDuty = () => applyLegacyDutyCommand(p.client, actor("admin"), legacyBinding.id, { kind: "void", dutyId: duty.id, expectedRevision: duty.revision, sourceFactAuditId: fact.id, reason: "经核原佣金已作废" });
  return { ...p, source, duty, proof, audits, confirm, voidDuty, who, input, duplicate: () => { duplicateProof = true; } };
}

test("reviewed VOID before/after CONFIRM has equal payable results without rewriting the terminal commission or sealed plan", async t => {
  for (const stage of ["8", "9"] as const) {
    const outcomes: unknown[] = [];
    for (const first of ["confirm", "void"] as const) {
      const p = reviewedCommissionFixture(t, stage);
      if (first === "void") await p.voidDuty();
      const terminal = first === "void" ? structuredClone(p.duty) : null;
      const updatesBefore = p.calls.filter(q => q.sql.startsWith("UPDATE zzsh_order.legacy_order_duty")).length;
      assert.equal((await p.confirm()).body.stage, "4");
      if (terminal) { assert.deepEqual(p.duty, terminal); assert.equal(p.calls.filter(q => q.sql.startsWith("UPDATE zzsh_order.legacy_order_duty")).length, updatesBefore); }
      else await p.voidDuty();
      assert.equal(p.duty.status, "VOID"); assert.equal(p.duty.amountCents, first === "void" ? "50" : "70");
      const version = p.calls.find(q => q.sql.startsWith("INSERT INTO zzsh_order.legacy_continuation_version"))!;
      const commissions = JSON.parse(String(version.values[11])); assert.equal(commissions[0].legalEarnings, "0.70"); assert.equal(commissions[0].recalculable, true);
      assert.equal(p.calls.filter(q => q.sql.startsWith("INSERT INTO zzsh_order.legacy_order_duty(") && q.values[3] === "COMMISSION").length, 0);
      const finalized = p.calls.filter(q => q.sql.startsWith("INSERT INTO zzsh_order.legacy_order_duty(")).map(q => [q.values[3], q.values[6]]);
      assert.deepEqual(finalized, [["RENTER_REFUND", "7500"], ["OWNER_CREDIT", "1300"]]);
      outcomes.push({ amounts: version.values[10], commissions: version.values[11], payable: p.duty.status === "VOID" ? "0" : p.duty.amountCents });
      const audit = p.audits.find(a => a.action === "order.legacy.continuation.confirm")!;
      if (first === "void") assert.deepEqual(audit.details.reviewedVoidCommissions, [{ dutyId: p.duty.id, sourceRecordId: "41", revision: "2", sourceFactAuditId: "fixture_review" }]);
      else assert(!Object.hasOwn(audit.details, "reviewedVoidCommissions"));
      t.mock.restoreAll();
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
  }
});

test("VOID status alone cannot bypass exact reviewed fact, actor, source, beneficiary, reference or unambiguous audit binding", async t => {
  const invalid: Array<[string, (x: ReviewedVoid) => void]> = [
    ["missing fact", x => { x.factAudit = null; }], ["missing void", x => { x.voidAudit = null; }],
    ["wrong parent digest", x => { x.sourceDigest = "d".repeat(64); }], ["wrong ref", x => { x.decisionEvidenceRef = "other_review"; }],
    ["fact actor", x => { x.factAudit!.actorType = "user"; }], ["fact order", x => { x.factAudit!.objectId = "other_order"; }],
    ["fact failure", x => { x.factAudit!.outcome = "FAILURE"; }], ["fact source", x => { x.factAudit!.details.sourceRecordId = "42"; }],
    ["fact parent", x => { x.factAudit!.details.parentSourceDigest = "d".repeat(64); }], ["fact status", x => { x.factAudit!.details.sourceStatus = "1"; }],
    ["source digest", x => { (x.factAudit!.details.sourceRecord as { digest: string }).digest = "d".repeat(64); }],
    ["source beneficiary", x => { const source = x.factAudit!.details.sourceRecord as { canonical: string; digest: string }; const r = JSON.parse(source.canonical); r.user_id = "22"; source.canonical = canonicalize(r); source.digest = sha256Hex(source.canonical); }],
    ["void actor", x => { x.voidAudit!.actorId = "other_admin"; }], ["void reference", x => { x.voidAudit!.details.sourceFactAuditId = "other_review"; }],
    ["void revision", x => { x.voidAudit!.details.afterRevision = "3"; }], ["decision actor", x => { x.decidedBy!.realm = "user"; }],
  ];
  for (const [label, mutate] of invalid) {
    const p = reviewedCommissionFixture(t, "8", mutate); await p.voidDuty(); const before = structuredClone(p.duty), offset = p.calls.length;
    const result = await legacyCommandOutcome(p.client, p.who, legacyBinding.id, p.confirm);
    assert.equal(result.status, 409, label); assert.match(JSON.stringify(result.body), /VOID_SOURCE_FACT_REQUIRED/, label); assert.deepEqual(p.duty, before, label);
    assert(p.calls.slice(offset).some(q => q.sql === "ROLLBACK TO SAVEPOINT legacy_continuation_action"), label);
    assert(!p.calls.slice(offset).some(q => /^(INSERT INTO zzsh_(order|iam\.membership)|UPDATE zzsh_order)/.test(q.sql)), label);
    t.mock.restoreAll();
  }
  const p = reviewedCommissionFixture(t, "9"); await p.voidDuty(); p.duplicate(); await assert.rejects(p.confirm, /VOID_SOURCE_FACT_REQUIRED/); t.mock.restoreAll();
});

test("ordinary PENDING commission still revises; MATURED, SETTLED and settled provenance remain rejected", async t => {
  for (const status of ["PENDING", "MATURED", "SETTLED"] as const) {
    const p = reviewedCommissionFixture(t, "8"); p.duty.status = status;
    if (status === "PENDING") { await p.confirm(); assert.equal(p.duty.amountCents, "70"); assert.equal(p.duty.revision, "2"); }
    else await assert.rejects(p.confirm, /DUTY_REVISION_CONFLICT/);
    t.mock.restoreAll();
  }
  const p = reviewedCommissionFixture(t, "8"); await p.voidDuty(); p.duty.settledBy = "FINANCE"; await assert.rejects(p.confirm, /DUTY_REVISION_CONFLICT/);
});

test("reviewed parent cancellation must carry its exact canonical not-payable decision; VOID beneficiary terms remain bound", async t => {
  const cancellation = (p: ReturnType<typeof reviewedCommissionFixture>) => {
    const fact = p.proof.factAudit!, raw = JSON.parse((fact.details.sourceRecord as { canonical: string }).canonical); raw.status = "1";
    const canonical = canonicalize(raw), digest = sha256Hex(canonical), parentCanonical = canonicalize({ id: "7", order_status: "5", user_id: "11", sale_user_id: "22", accounts_id: "33" }), parentDigest = sha256Hex(parentCanonical);
    const notPayableCanonical = canonicalize({ parentCancellationDigest: parentDigest, sourceRecordDigest: digest, decision: "NOT_PAYABLE", sourceRuleEvidenceRef: "fixture:reviewed-parent-rule" });
    Object.assign(fact.details, { sourceStatus: "1", parentCancelledNotPayable: true, sourceRecord: { canonical, digest }, parentCancellation: { canonical: parentCanonical, digest: parentDigest, notPayableCanonical, notPayableDigest: sha256Hex(notPayableCanonical) } });
  };
  const valid = reviewedCommissionFixture(t, "8"); cancellation(valid); await valid.voidDuty(); assert.equal((await valid.confirm()).body.stage, "4"); t.mock.restoreAll();
  const invalid = reviewedCommissionFixture(t, "8"); cancellation(invalid); (invalid.proof.factAudit!.details.parentCancellation as { notPayableDigest: string }).notPayableDigest = "f".repeat(64); await invalid.voidDuty(); await assert.rejects(invalid.confirm, /VOID_SOURCE_FACT_REQUIRED/); t.mock.restoreAll();
  for (const field of ["counterpartyUserId", "level", "ratio"] as const) {
    const p = reviewedCommissionFixture(t, "9"); await p.voidDuty(); p.duty[field] = field === "counterpartyUserId" ? legacyBinding.ownerUserId : "2";
    const offset = p.calls.length; await assert.rejects(p.confirm, /DUTY_SOURCE_BINDING_MISMATCH/);
    assert(!p.calls.slice(offset).some(q => /^(INSERT|UPDATE)/.test(q.sql))); t.mock.restoreAll();
  }
});
