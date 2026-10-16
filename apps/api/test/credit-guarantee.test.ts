import assert from "node:assert/strict";
import test from "node:test";

import { createGuaranteePaymentIntent, readGuaranteeTransactions, requiredGuaranteeCents } from "../src/credit/credit-guarantee";

test("credit guarantee uses exact integer HALF_UP and the 100 yuan cap", () => {
  assert.equal(requiredGuaranteeCents("0"), "0");
  assert.equal(requiredGuaranteeCents("1"), "0");
  assert.equal(requiredGuaranteeCents("10"), "1");
  assert.equal(requiredGuaranteeCents("199"), "10");
  assert.equal(requiredGuaranteeCents("200000"), "10000");
  assert.equal(requiredGuaranteeCents("999999"), "10000");
});

test("payment replay resolves the frozen receipt before current credit or release state", async () => {
  const calls: string[] = [];
  const context = { accountId: "account-a", ownerUserId: "user-a", gameId: "game-a", versionId: "version-old", priceVersionId: "price-old", releaseId: "release-old", policy: { policyVersion: "policy-old" }, baseCents: "10000", requiredCents: "500", score: 70, creditRevision: "4", state: "PAYMENT_PENDING", reference: "guarantee:req-old" } as any;
  const client = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.includes("FROM zzsh_supply.rental_account")) return { rows: [{}] };
    if (sql.includes("FROM zzsh_order.owner_guarantee_payment p")) return { rows: [{ id: "payment-old", requestFingerprint: "a".repeat(64), status: "ACCEPTED", providerRequestState: "SUBMITTED", merchantOrderNo: "merchant-old", amountCents: "500", providerTransactionId: null, financeEventId: null, ledgerEntryRef: null, requirementId: "req-old", ownerUserId: "user-a", accountId: "account-a" }] };
    throw new Error(`unexpected query: ${sql}`);
  } } as any;
  const result = await createGuaranteePaymentIntent(client, { context, accountId: "account-a", userId: "user-a", requestKey: "payment-original", requestFingerprint: "a".repeat(64) });
  assert.equal(result.paymentId, "payment-old");
  assert.equal(result.duplicate, true);
  assert.deepEqual(calls.map((sql) => sql.includes("rental_account") ? "authorization" : "receipt"), ["authorization", "receipt"]);
});

test("payment replay rejects changed evidence and a different account", async () => {
  const context = { accountId: "account-a", ownerUserId: "user-a", gameId: "game-a", versionId: "version-old", priceVersionId: "price-old", releaseId: "release-old", policy: { policyVersion: "policy-old" }, baseCents: "10000", requiredCents: "500", score: 70, creditRevision: "4", state: "PAYMENT_PENDING", reference: "guarantee:req-old" } as any;
  const client = (accountId: string) => ({ query: async (sql: string) => {
    if (sql.includes("FROM zzsh_supply.rental_account")) return { rows: [{}] };
    if (sql.includes("FROM zzsh_order.owner_guarantee_payment p")) return { rows: [{ id: "payment-old", requestFingerprint: "a".repeat(64), status: "ACCEPTED", providerRequestState: "SUBMITTED", merchantOrderNo: "merchant-old", amountCents: "500", providerTransactionId: null, financeEventId: null, ledgerEntryRef: null, requirementId: "req-old", ownerUserId: "user-a", accountId }] };
    throw new Error(`unexpected query: ${sql}`);
  } }) as any;
  await assert.rejects(() => createGuaranteePaymentIntent(client("account-a"), { context, accountId: "account-a", userId: "user-a", requestKey: "payment-original", requestFingerprint: "b".repeat(64) }), /different evidence/);
  await assert.rejects(() => createGuaranteePaymentIntent(client("account-a"), { context: { ...context, accountId: "account-b" }, accountId: "account-b", userId: "user-a", requestKey: "payment-original", requestFingerprint: "a".repeat(64) }), /different subject or account/);
});

test("confirmed payment replay survives a changed credit revision and release", async () => {
  const context = { accountId: "account-a", ownerUserId: "user-a", gameId: "game-a", versionId: "version-old", priceVersionId: "price-old", releaseId: "release-new", policy: { policyVersion: "policy-old" }, baseCents: "10000", requiredCents: "500", score: 80, creditRevision: "99", state: "SATISFIED", reference: "guarantee:req-old" } as any;
  const client = { query: async (sql: string) => {
    if (sql.includes("FROM zzsh_supply.rental_account")) return { rows: [{}] };
    if (sql.includes("FROM zzsh_order.owner_guarantee_payment p")) return { rows: [{ id: "payment-confirmed", requestFingerprint: "a".repeat(64), status: "CONFIRMED", providerRequestState: "CONFIRMED", merchantOrderNo: "merchant-confirmed", amountCents: "500", providerTransactionId: "provider-confirmed", financeEventId: "event-confirmed", ledgerEntryRef: "line-confirmed", requirementId: "req-old", ownerUserId: "user-a", accountId: "account-a" }] };
    throw new Error(`unexpected query: ${sql}`);
  } } as any;
  const result = await createGuaranteePaymentIntent(client, { context, accountId: "account-a", userId: "user-a", requestKey: "payment-confirmed-key", requestFingerprint: "a".repeat(64) });
  assert.deepEqual(result, { paymentId: "payment-confirmed", requirementId: "req-old", status: "CONFIRMED", providerRequestState: "CONFIRMED", merchantOrderNo: "merchant-confirmed", amountCents: "500", providerTransactionId: "provider-confirmed", financeEventId: "event-confirmed", ledgerEntryRef: "line-confirmed", duplicate: true, provider: "HUIJU", providerAction: "NOT_AUTHORIZED" });
});

test("guarantee transaction reader keeps every payment and refund attempt", async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => {
    queries.push(sql);
    if (sql.includes("FROM zzsh_order.owner_guarantee_requirement")) return { rows: [{ requirementId: "req-a", accountId: "account-a", baseCents: "10000", requiredCents: "500" }] };
    if (sql.includes("FROM zzsh_order.owner_guarantee_payment")) return { rows: [{ id: "pay-1", requirementId: "req-a", merchantOrderNo: "merchant-1", amountCents: "500", observedAmountCents: null, status: "FAILED", providerRequestState: "FAILED", providerTransactionId: null, financeEventId: null, ledgerEntryRef: null, createdAt: "2026-01-01" }, { id: "pay-2", requirementId: "req-a", merchantOrderNo: "merchant-2", amountCents: "500", observedAmountCents: "500", status: "CONFIRMED", providerRequestState: "CONFIRMED", providerTransactionId: "provider-2", financeEventId: "event-2", ledgerEntryRef: "line-2", createdAt: "2026-01-02" }] };
    if (sql.includes("FROM zzsh_order.owner_guarantee_refund")) return { rows: [{ id: "refund-1", requirementId: "req-a", paymentId: "pay-2", amountCents: "500", status: "FAILED", providerRequestState: "FAILED", providerRefundId: null, releasePolicyState: "APPROVED", financeEventId: null, ledgerEntryRef: null, createdAt: "2026-01-03" }, { id: "refund-2", requirementId: "req-a", paymentId: "pay-2", amountCents: "500", status: "UNKNOWN", providerRequestState: "UNKNOWN", providerRefundId: null, releasePolicyState: "APPROVED", financeEventId: null, ledgerEntryRef: null, createdAt: "2026-01-04" }] };
    throw new Error(`unexpected query: ${sql}`);
  } } as any;
  const rows = await readGuaranteeTransactions(client, "user-a", { userId: "admin-a", isBoss: false });
  assert.match(queries[0]!, /admin_supply_scope/);
  assert.deepEqual(rows[0]?.paymentHistory.map((item: any) => item.id), ["pay-1", "pay-2"]);
  assert.deepEqual(rows[0]?.refundHistory.map((item: any) => item.id), ["refund-1", "refund-2"]);
  assert.equal(rows[0]?.paymentId, "pay-2");
  assert.equal(rows[0]?.refundId, "refund-2");
});

test("actual payment-intent route restores its receipt even when current policy loading would fail", async (t) => {
  const identity = require("../src/auth/user-identity");
  const security = require("../src/auth/security-core");
  const credit = require("../src/credit/credit-guarantee");
  const { mountCreditGuaranteeRoutes } = require("../src/credit/credit-guarantee-routes");
  const { sha256Hex } = require("../src/supply/supply-util");
  const calls:string[]=[];const client={query:async(sql:string)=>{calls.push(sql);if(sql.includes('FROM zzsh_supply.rental_account'))return{rows:[{}]};if(sql.includes('FROM zzsh_order.owner_guarantee_payment p'))return{rows:[{id:'old-payment',ownerUserId:'user-a',accountId:'account-a',requestFingerprint:sha256Hex('{}'),status:'CONFIRMED',requirementId:'old-requirement'}]};throw Error('Unexpected current-policy query');}};
  t.mock.method(identity,'readUserContext',async()=>({userId:'user-a',sessionId:'session-a'}));
  t.mock.method(identity,'assertUserContextInTransaction',async()=>{});
  t.mock.method(security,'withTransaction',async(_pool:unknown,action:(c:unknown)=>unknown)=>action(client));
  t.mock.method(security,'recordAudit',async()=>{});
  const policy=t.mock.method(credit,'readGuaranteeContext',async()=>{throw Error('Malformed current policy');});
  const handlers=new Map<string,Function>();mountCreditGuaranteeRoutes({getHttpAdapter:()=>({getInstance:()=>({use:(prefix:string,handler:Function)=>handlers.set(prefix,handler)})})},{userOrigin:'http://127.0.0.1:4200',apiOrigin:'http://127.0.0.1:4202',pool:{}},true);
  const response={statusCode:0,body:null as any,status(n:number){this.statusCode=n;return this;},setHeader(){return this;},json(body:unknown){this.body=body;return this;}};
  await handlers.get('/api/bff/user/credit')!({method:'POST',originalUrl:'/api/bff/user/credit/accounts/account-a/payment-intents',headers:{origin:'http://127.0.0.1:4200','idempotency-key':'original-intent-key'},body:{}},response);
  assert.equal(response.statusCode,200);assert.equal(response.body.paymentId,'old-payment');assert.equal(response.body.duplicate,true);assert.equal(policy.mock.callCount(),0);assert.equal(calls.length,2);
});

import { applyCreditInitializationBatch, planCreditInitialization, previewCreditInitialization, readCreditInitializationReceipt, runCreditInitializationBatch, CreditInitializationOutcomeError } from "../src/credit/credit-initialization";
import { describeCreditInitializationFailure, readCreditInitializationRun } from "../src/credit/credit-initialization-cli";
import { createHash as nodeHash } from "node:crypto";

type Identity = "ACTIVE" | "CANCELLED" | "DEACTIVATED" | "RESTRICTED" | "MISSING";
type World = { users: Map<string, Identity>; scores: Map<string, number>; events: string[]; receipts: Map<string, { fp: string; status: number; body: unknown }>; audits: number; admins: Map<string, { status: string; isBoss: boolean }>; sessions: Map<string, { userId: string; expiresAt: string; locked: boolean }>; dbNow: string; live: Record<string, unknown>; failAudit?: boolean; concurrentFor?: string; identityReads: number; writesSeen: string[]; failCommit?: "AFTER_DURABLE" };
const RESOURCE = { databaseName: "zzsh_window", databaseOid: "16384", owner: "zzsh_owner", runtimeRole: "zzsh_runtime", markerKey: "credit-init-window", markerTarget: "credit-init", markerVersion: 1 };
function world(): World {
  return { users: new Map([["u1", "ACTIVE"], ["u2", "ACTIVE"], ["u3", "ACTIVE"], ["c1", "CANCELLED"], ["r1", "RESTRICTED"]]), scores: new Map([["u2", 80]]), events: [], receipts: new Map(), audits: 0,
    admins: new Map([["boss", { status: "ACTIVE", isBoss: true }], ["boss2", { status: "ACTIVE", isBoss: true }], ["staff", { status: "ACTIVE", isBoss: false }]]),
    sessions: new Map([["sess-boss", { userId: "boss", expiresAt: "2099-01-01T00:00:00.000Z", locked: false }], ["sess-boss2", { userId: "boss2", expiresAt: "2099-01-01T00:00:00.000Z", locked: false }]]),
    dbNow: "2026-10-20T01:00:00.000000Z", live: { databaseName: RESOURCE.databaseName, databaseOid: RESOURCE.databaseOid, owner: RESOURCE.owner, runtimeRole: RESOURCE.runtimeRole, markerTarget: RESOURCE.markerTarget, markerVersion: 1 }, identityReads: 0, writesSeen: [] };
}
const CATEGORY: Record<Identity, string> = { ACTIVE: "ACTIVE", CANCELLED: "CANCELLED", DEACTIVATED: "DEACTIVATED", RESTRICTED: "RESTRICTED", MISSING: "UNKNOWN" };
function client(w: World) {
  return { query: async (sql: string, params: any[] = []) => {
    if (/^(BEGIN|BEGIN READ ONLY|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql === "COMMIT") { if (w.failCommit === "AFTER_DURABLE") throw new Error("connection terminated during COMMIT"); return { rows: [] }; }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes(`"zzsh_iam"."admin_security"`)) { const a = w.admins.get(params[0]); return { rows: a ? [{ status: a.status, isBoss: a.isBoss, passwordChangeRequired: false }] : [] }; }
    if (sql.includes(`"zzsh_auth_admin"."session"`)) { const s = w.sessions.get(params[0]); return { rows: s && s.userId === params[1] ? [{ locked: s.locked, pinHash: null, pinFailures: 0, expiresAt: new Date(s.expiresAt), suspended: false, twoFactorEnabled: true }] : [] }; }
    if (sql.includes("role_permissions")) return { rows: [] };
    if (sql.includes("credit-init-window")) return { rows: [{ dbNow: w.dbNow }] };
    if (sql.includes("credit-init-resource")) return { rows: [w.live] };
    if (sql.includes("FROM zzsh_iam.user_identity_state WHERE user_id = ANY")) return { rows: [] };
    if (sql.includes("credit-init-category")) { w.identityReads += 1; return { rows: (params[0] as string[]).filter((id) => w.users.has(id)).map((id) => ({ id, category: CATEGORY[w.users.get(id)!] })) }; }
    if (sql.includes("credit-init-recover")) { const r = w.receipts.get(`${params[0]}|${params[1]}`); return { rows: r ? [{ requestFingerprint: r.fp, responseBody: r.body }] : [] }; }
    if (sql.includes(`FROM "zzsh_supply"."idempotency_record"`)) { const r = w.receipts.get(`${params[0]}|${params[1]}`); return { rows: r ? [{ requestFingerprint: r.fp, responseStatus: r.status, responseBody: r.body, publishRequired: false }] : [] }; }
    if (sql.includes(`INSERT INTO "zzsh_supply"."idempotency_record"`)) { w.writesSeen.push("receipt"); w.receipts.set(`${params[0]}|${params[1]}`, { fp: params[2], status: params[3], body: JSON.parse(params[4]) }); return { rows: [] }; }
    if (sql.includes(`FROM zzsh_auth_user."user" WHERE id=$1`)) { if (w.concurrentFor === params[0]) w.scores.set(params[0], 100); return { rows: [{}], rowCount: w.users.has(params[0]) ? 1 : 0 }; }
    if (sql.includes("INSERT INTO zzsh_credit.user_credit_state")) { w.writesSeen.push("state"); if (w.scores.has(params[0])) return { rows: [] }; w.scores.set(params[0], 100); return { rows: [{ userId: params[0], score: 100, revision: "1", initializedAt: "t" }] }; }
    if (sql.includes("INSERT INTO zzsh_credit.credit_event")) { w.events.push(params[1]); return { rows: [] }; }
    if (sql.includes("user_id = ANY")) return { rows: (params[0] as string[]).filter((id) => w.scores.has(id)).map((userId) => ({ userId })) };
    if (sql.includes("audit_event")) { if (w.failAudit) throw new Error("audit unavailable"); w.audits += 1; return { rows: [] }; }
    if (sql.includes("LEFT JOIN zzsh_credit.user_credit_state c")) return { rows: [...w.users.keys()].filter((id) => !w.scores.has(id)).map((id) => ({ id, category: CATEGORY[w.users.get(id)!] })) };
    throw new Error(`unexpected query: ${sql}`);
  } } as any;
}
/** Transactional fake pool: snapshot on BEGIN, restore on ROLLBACK; COMMIT failure can be "after durable". */
function pool(w: World) {
  return { connect: async () => { let saved: string | undefined; const inner = client(w); return { release() {}, query: async (sql: string, params?: any[]) => {
    if (sql === "BEGIN") saved = JSON.stringify({ s: [...w.scores], e: w.events, r: [...w.receipts], a: w.audits });
    if (sql === "ROLLBACK" && saved) { const s = JSON.parse(saved); w.scores = new Map(s.s); w.events = s.e; w.receipts = new Map(s.r); w.audits = s.a; }
    return inner.query(sql, params);
  } }; } } as any;
}
const execution = (over: Record<string, unknown> = {}) => ({ actorAdminId: "boss", actorSessionId: "sess-boss", approvalRef: "approval-credit-001", attempt: 1, approvalDigest: "c".repeat(64), windowStartUtc: "2026-10-20T00:00:00Z", windowEndUtc: "2026-10-20T04:00:00Z", resource: { ...RESOURCE }, ...over });
const input = (over: Record<string, unknown> = {}, exec: Record<string, unknown> = {}) => ({ batchKey: "credit-init:batch-0001", userIds: ["u3", "u1", "u2"], approvedCategory: "ACTIVE", intentDigest: "a".repeat(64), reason: "decided rule: initial 100", requestId: "req_1", execution: execution(exec), ...over }) as any;

test("credit initialization plan classifies missing users and never lists existing states", async () => {
  const plan = await planCreditInitialization(client(world()), { limit: 10 });
  assert.deepEqual(plan.byCategory, { ACTIVE: 2, RESTRICTED: 1, CANCELLED: 1, DEACTIVATED: 0, UNKNOWN: 0 });
  await assert.rejects(() => planCreditInitialization(client(world()), { limit: 501 }), /limit/);
});

test("E-R1-02 replay: same key+body returns the original receipt after current authorization, no second audit or event", async () => {
  const w = world();
  const first = await applyCreditInitializationBatch(client(w), input());
  assert.deepEqual([first.replayed, first.receipt.applied, first.receipt.alreadyInitialized], [false, ["u1", "u3"], ["u2"]]);
  assert.equal(w.scores.get("u2"), 80, "existing score kept");
  const replay = await applyCreditInitializationBatch(client(w), input());
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(w.audits, 1);
  assert.deepEqual(w.events, ["u1", "u3"]);
  w.admins.set("boss", { status: "FROZEN", isBoss: true });
  await assert.rejects(() => applyCreditInitializationBatch(client(w), input()), /Access denied/, "replay re-checks current authorization");
});

test("RUNNER-ACTIVE-RECHECK (original failure: CANCELLED user reported applied, 0 identity reads): fresh apply locks and rechecks the approved ACTIVE set", async () => {
  const w = world();
  await assert.rejects(() => applyCreditInitializationBatch(client(w), input({ userIds: ["u1", "c1"] })), /no longer ACTIVE/);
  assert.equal(w.identityReads, 1);
  assert.deepEqual([w.scores.has("u1"), w.scores.has("c1"), w.receipts.size, w.audits], [false, false, 0, 0], "whole batch rejected before any write");
  await assert.rejects(() => applyCreditInitializationBatch(client(w), input({ userIds: ["u1", "gone"] })), /no longer ACTIVE/, "missing user is drift too");
  // A committed receipt replays even if an object later became CANCELLED: business preconditions are not re-run.
  const ok = await applyCreditInitializationBatch(client(w), input({ userIds: ["u1"] }));
  w.users.set("u1", "CANCELLED");
  const before = w.identityReads;
  const replay = await applyCreditInitializationBatch(client(w), input({ userIds: ["u1"] }));
  assert.deepEqual([replay.replayed, replay.receipt, w.identityReads], [true, ok.receipt, before]);
});

test("RUNNER-APPROVAL-RESOURCE-WINDOW: wrong resource/role/marker, other actor session, expired session, closed window are rejected before any write; replay too", async () => {
  const cases: Array<[string, (w: World) => void, Record<string, unknown>, RegExp]> = [
    ["wrong database OID", (w) => { w.live = { ...w.live, databaseOid: "99999" }; }, {}, /approved resource/],
    ["wrong runtime role", (w) => { w.live = { ...w.live, runtimeRole: "zzsh_admin" }; }, {}, /approved resource/],
    ["marker missing", (w) => { w.live = { ...w.live, markerTarget: null, markerVersion: null }; }, {}, /approved resource/],
    ["session of another admin", () => {}, { actorSessionId: "sess-boss2" }, /Authentication required/],
    ["expired session", (w) => { w.sessions.set("sess-boss", { userId: "boss", expiresAt: "2000-01-01T00:00:00.000Z", locked: false }); }, {}, /Authentication required/],
    ["window not yet open", (w) => { w.dbNow = "2026-10-19T23:59:59.999999Z"; }, {}, /window is not open/],
    ["window expired", (w) => { w.dbNow = "2026-10-20T04:00:00.000000Z"; }, {}, /window is not open/],
    ["non-Boss actor", () => {}, { actorAdminId: "staff", actorSessionId: "sess-boss" }, /Boss/],
  ];
  for (const [name, mutate, exec, pattern] of cases) {
    const w = world(); mutate(w);
    await assert.rejects(() => applyCreditInitializationBatch(client(w), input({}, exec)), pattern, name);
    assert.deepEqual(w.writesSeen, [], name);
  }
  const w = world();
  await applyCreditInitializationBatch(client(w), input());
  w.live = { ...w.live, databaseOid: "99999" };
  await assert.rejects(() => applyCreditInitializationBatch(client(w), input()), /approved resource/, "replay also requires the approved resource");
});

test("E-R1-02 conflict: same key with a different object set or intent is rejected; a new window/attempt keeps the original fingerprint", async () => {
  const w = world();
  const first = await applyCreditInitializationBatch(client(w), input({ userIds: ["u1"] }));
  await assert.rejects(() => applyCreditInitializationBatch(client(w), input({ userIds: ["u3"] })), /different request/);
  await assert.rejects(() => applyCreditInitializationBatch(client(w), input({ userIds: ["u1"], intentDigest: "b".repeat(64) })), /different request/);
  assert.equal(w.scores.has("u3"), false);
  const recovered = await applyCreditInitializationBatch(client(w), input({ userIds: ["u1"] }, { approvalRef: "approval-credit-002", attempt: 2, approvalDigest: "d".repeat(64) }));
  assert.deepEqual([recovered.replayed, recovered.receipt.execution], [true, first.receipt.execution], "recovery window replays the original receipt");
});

test("E-R1-02 concurrency: a state created by another transaction is reported alreadyInitialized, not applied", async () => {
  const w = world(); w.concurrentFor = "u1";
  const result = await applyCreditInitializationBatch(client(w), input());
  assert.deepEqual(result.receipt.applied, ["u2", "u3"].filter((id) => id !== "u2"));
  assert.deepEqual(result.receipt.alreadyInitialized, ["u1", "u2"]);
  assert.deepEqual(w.events, ["u3"]);
});

test("RUNNER-COMMIT-UNKNOWN (original failure: CLI claimed rollback after a committed transaction)", async () => {
  const w = world(); w.failCommit = "AFTER_DURABLE";
  const error = await runCreditInitializationBatch(pool(w), input()).then(() => null, (e) => e);
  assert.ok(error instanceof CreditInitializationOutcomeError);
  assert.equal(error.outcome, "COMMIT_UNKNOWN");
  assert.equal(error.rollbackAcknowledged, false);
  assert.deepEqual([error.preserved.batchKey, error.preserved.approvalRef, error.preserved.attempt, error.preserved.actorAdminId], ["credit-init:batch-0001", "approval-credit-001", 1, "boss"]);
  const text = describeCreditInitializationFailure(error);
  assert.match(text, /COMMIT_UNKNOWN/);
  assert.doesNotMatch(text, /rolled back/);
  // Read-only recovery in a new approved window with the same package and key.
  w.failCommit = undefined;
  const recovery = await readCreditInitializationReceipt(client(w), input({}, { approvalRef: "approval-credit-002", attempt: 2 }));
  assert.equal(recovery.state, "FOUND");
  assert.equal((await readCreditInitializationReceipt(client(w), input({ userIds: ["u1"] }, { approvalRef: "approval-credit-002", attempt: 2 }))).state, "FINGERPRINT_MISMATCH");
  assert.equal((await readCreditInitializationReceipt(client(world()), input())).state, "NOT_FOUND");
  const closed = world(); closed.dbNow = "2026-10-21T00:00:00.000000Z";
  await assert.rejects(() => readCreditInitializationReceipt(client(closed), input()), /window is not open/, "recovery also needs an approved open window");
});

test("E-R1-02 audit failure is NOT_COMMITTED with rollback; dry run writes nothing and reports category drift", async () => {
  const w = world(); w.failAudit = true;
  const error = await runCreditInitializationBatch(pool(w), input()).then(() => null, (e) => e);
  assert.ok(error instanceof CreditInitializationOutcomeError);
  assert.deepEqual([error.outcome, error.rollbackAcknowledged], ["NOT_COMMITTED", true]);
  assert.match(describeCreditInitializationFailure(error), /COMMIT was never sent/);
  assert.deepEqual([[...w.scores.keys()], w.events, w.receipts.size, w.audits], [["u2"], [], 0, 0]);
  const pw = world();
  const preview = await previewCreditInitialization(client(pw), input({ userIds: ["u1", "u2", "c1"] }));
  assert.deepEqual([preview.wouldApply, preview.alreadyInitialized, preview.outsideApprovedCategory], [["c1", "u1"], ["u2"], [{ userId: "c1", category: "CANCELLED" }]]);
  assert.deepEqual(pw.writesSeen, []);
  for (const bad of [{ batchKey: "x" }, { userIds: [] }, { userIds: ["u1", "u1"] }, { intentDigest: "zz" }, { approvedCategory: "CANCELLED" }]) await assert.rejects(() => applyCreditInitializationBatch(client(world()), input(bad)));
  await assert.rejects(() => applyCreditInitializationBatch(client(world()), input({}, { attempt: 0 })));
});

test("runner parser: two signed inputs, strict shapes, approved mode/window/resource checked before connecting", () => {
  const pkg = Buffer.from(JSON.stringify({ schema: "credit-init-package-v1", batchKey: "credit-init:batch-0001", userIds: ["u1"], approvedCategory: "ACTIVE", reason: "decided rule" }));
  const pkgSha = nodeHash("sha256").update(pkg).digest("hex");
  const approvalOf = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ schema: "credit-init-approval-v1", status: "APPROVED", approvalRef: "approval-credit-001", attempt: 1, mode: "APPLY", businessPackageSha256: pkgSha, actor: { adminId: "boss", sessionId: "sess-boss" }, windowStartUtc: "2026-10-20T00:00:00Z", windowEndUtc: "2026-10-20T04:00:00Z", resource: RESOURCE, ...over }));
  const now = Date.parse("2026-10-20T01:00:00Z");
  const runWith = (approval: Buffer, envOver: Record<string, string> = {}, at = now, configured = { databaseName: RESOURCE.databaseName, databaseUser: RESOURCE.runtimeRole }) => {
    const files: Record<string, Buffer> = { "pkg.json": pkg, "approval.json": approval };
    const env = { CREDIT_INIT_ENABLED: "true", CREDIT_INIT_PACKAGE_FILE: "pkg.json", CREDIT_INIT_PACKAGE_SHA256: pkgSha, CREDIT_INIT_APPROVAL_FILE: "approval.json", CREDIT_INIT_APPROVAL_SHA256: nodeHash("sha256").update(approval).digest("hex"), CREDIT_INIT_MODE: "APPLY", ...envOver };
    return readCreditInitializationRun(env, (p) => files[p]!, at, configured);
  };
  const ok = runWith(approvalOf());
  assert.deepEqual([ok.mode, ok.input.intentDigest, ok.input.execution.actorSessionId, ok.input.execution.attempt], ["APPLY", pkgSha, "sess-boss", 1]);
  assert.throws(() => runWith(approvalOf({ expired: true })), /unknown fields/, "an attached expiry/denial field cannot be ignored");
  assert.throws(() => runWith(approvalOf({ status: "REJECTED" })), /APPROVED/);
  assert.throws(() => runWith(approvalOf({ businessPackageSha256: "0".repeat(64) })), /does not approve/);
  assert.throws(() => runWith(approvalOf({ mode: "PREVIEW" })), /approved mode/);
  assert.throws(() => runWith(approvalOf(), {}, Date.parse("2026-10-20T05:00:00Z")), /not open; nothing was connected/);
  assert.throws(() => runWith(approvalOf({ windowEndUtc: "2026-10-22T00:00:00Z" })), /at most 24h/);
  assert.throws(() => runWith(approvalOf(), {}, now, { databaseName: "zzsh", databaseUser: RESOURCE.runtimeRole }), /approved resource; nothing was connected/);
  assert.throws(() => runWith(approvalOf(), { CREDIT_INIT_APPROVAL_SHA256: "0".repeat(64) }), /approval digest/);
  assert.throws(() => runWith(approvalOf(), { CREDIT_INIT_ENABLED: "" }), /ENABLED/);
  assert.match(describeCreditInitializationFailure(new Error("x")), /not executed/);
});
