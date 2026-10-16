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

import { applyCreditInitializationBatch, planCreditInitialization, previewCreditInitialization, runCreditInitializationBatch } from "../src/credit/credit-initialization";

type World = { users: Set<string>; scores: Map<string, number>; events: string[]; receipts: Map<string, { fp: string; status: number; body: unknown }>; audits: number; admins: Map<string, { status: string; isBoss: boolean }>; failAudit?: boolean; concurrentFor?: string };
function world(): World {
  return { users: new Set(["u1", "u2", "u3"]), scores: new Map([["u2", 80]]), events: [], receipts: new Map(), audits: 0, admins: new Map([["boss", { status: "ACTIVE", isBoss: true }], ["staff", { status: "ACTIVE", isBoss: false }]]) };
}
function client(w: World) {
  return { query: async (sql: string, params: any[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes(`"zzsh_iam"."admin_security"`)) { const a = w.admins.get(params[0]); return { rows: a ? [{ status: a.status, isBoss: a.isBoss, passwordChangeRequired: false }] : [] }; }
    if (sql.includes("role_permissions")) return { rows: [] };
    if (sql.includes(`FROM "zzsh_supply"."idempotency_record"`)) { const r = w.receipts.get(`${params[0]}|${params[1]}`); return { rows: r ? [{ requestFingerprint: r.fp, responseStatus: r.status, responseBody: r.body, publishRequired: false }] : [] }; }
    if (sql.includes(`INSERT INTO "zzsh_supply"."idempotency_record"`)) { w.receipts.set(`${params[0]}|${params[1]}`, { fp: params[2], status: params[3], body: JSON.parse(params[4]) }); return { rows: [] }; }
    if (sql.includes(`FROM zzsh_auth_user."user" WHERE id=$1`)) { if (w.concurrentFor === params[0]) w.scores.set(params[0], 100); return { rows: [{}], rowCount: w.users.has(params[0]) ? 1 : 0 }; }
    if (sql.includes("INSERT INTO zzsh_credit.user_credit_state")) { if (w.scores.has(params[0])) return { rows: [] }; w.scores.set(params[0], 100); return { rows: [{ userId: params[0], score: 100, revision: "1", initializedAt: "t" }] }; }
    if (sql.includes("INSERT INTO zzsh_credit.credit_event")) { w.events.push(params[1]); return { rows: [] }; }
    if (sql.includes("user_id = ANY")) return { rows: (params[0] as string[]).filter((id) => w.scores.has(id)).map((userId) => ({ userId })) };
    if (sql.includes("audit_event")) { if (w.failAudit) throw new Error("audit unavailable"); w.audits += 1; return { rows: [] }; }
    if (sql.includes("LEFT JOIN zzsh_credit.user_credit_state c")) return { rows: [...w.users].filter((id) => !w.scores.has(id)).map((id) => ({ id, category: id === "u3" ? "RESTRICTED" : "ACTIVE" })) };
    throw new Error(`unexpected query: ${sql}`);
  } } as any;
}
/** Transactional fake pool: snapshot on BEGIN, restore on ROLLBACK. */
function pool(w: World) {
  return { connect: async () => { let saved: string | undefined; const inner = client(w); return { release() {}, query: async (sql: string, params?: any[]) => {
    if (sql === "BEGIN") saved = JSON.stringify({ s: [...w.scores], e: w.events, r: [...w.receipts], a: w.audits });
    if (sql === "ROLLBACK" && saved) { const s = JSON.parse(saved); w.scores = new Map(s.s); w.events = s.e; w.receipts = new Map(s.r); w.audits = s.a; }
    return inner.query(sql, params);
  } }; } } as any;
}
const input = (over: Record<string, unknown> = {}) => ({ actorAdminId: "boss", batchKey: "credit-init:batch-0001", userIds: ["u3", "u1", "u2"], inputDigest: "a".repeat(64), resourceRef: "pg-window-e-001", reason: "decided rule: initial 100", requestId: "req_1", ...over }) as any;

test("credit initialization plan classifies missing users and never lists existing states", async () => {
  const plan = await planCreditInitialization(client(world()), { limit: 10 });
  assert.deepEqual(plan.candidates, [{ userId: "u1", category: "ACTIVE" }, { userId: "u3", category: "RESTRICTED" }]);
  assert.equal(plan.byCategory.RESTRICTED, 1);
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

test("E-R1-02 conflict: same key with a different object set or digest is rejected; non-Boss is rejected", async () => {
  const w = world();
  await applyCreditInitializationBatch(client(w), input({ userIds: ["u1"] }));
  await assert.rejects(() => applyCreditInitializationBatch(client(w), input({ userIds: ["u3"] })), /different request/);
  await assert.rejects(() => applyCreditInitializationBatch(client(w), input({ userIds: ["u1"], inputDigest: "b".repeat(64) })), /different request/);
  assert.equal(w.scores.has("u3"), false);
  await assert.rejects(() => applyCreditInitializationBatch(client(world()), input({ actorAdminId: "staff" })), /Boss/);
  await assert.rejects(() => applyCreditInitializationBatch(client(world()), input({ actorAdminId: "nobody" })), /Access denied/);
});

test("E-R1-02 concurrency: a state created by another transaction is reported alreadyInitialized, not applied", async () => {
  const w = world(); w.concurrentFor = "u1";
  const result = await applyCreditInitializationBatch(client(w), input());
  assert.deepEqual(result.receipt.applied, ["u3"]);
  assert.deepEqual(result.receipt.alreadyInitialized, ["u1", "u2"]);
  assert.deepEqual(w.events, ["u3"]);
});

test("E-R1-02 audit failure rolls back states, events and receipt; dry run writes nothing", async () => {
  const w = world(); w.failAudit = true;
  await assert.rejects(() => runCreditInitializationBatch(pool(w), input()), /audit unavailable/);
  assert.deepEqual([[...w.scores.keys()], w.events, w.receipts.size, w.audits], [["u2"], [], 0, 0]);
  const preview = await previewCreditInitialization(client(world()), input());
  assert.deepEqual([preview.wouldApply, preview.alreadyInitialized], [["u1", "u3"], ["u2"]]);
  for (const bad of [{ batchKey: "x" }, { userIds: [] }, { userIds: ["u1", "u1"] }, { inputDigest: "zz" }, { resourceRef: " " }]) await assert.rejects(() => applyCreditInitializationBatch(client(world()), input(bad)));
});
import { readCreditInitializationRun } from "../src/credit/credit-initialization-cli";
import { createHash as nodeHash } from "node:crypto";

test("credit initialization runner requires opt-in, signed package digest and matching resource; defaults to preview", () => {
  const bytes = Buffer.from(JSON.stringify({ batchKey: "credit-init:batch-0001", userIds: ["u1"], resourceRef: "pg-window-e-001", reason: "decided rule" }));
  const digest = nodeHash("sha256").update(bytes).digest("hex");
  const env = { CREDIT_INIT_ENABLED: "true", CREDIT_INIT_PACKAGE_FILE: "pkg.json", CREDIT_INIT_PACKAGE_SHA256: digest, CREDIT_INIT_ACTOR_ADMIN_ID: "boss", CREDIT_INIT_RESOURCE_REF: "pg-window-e-001" };
  const run = readCreditInitializationRun(env, () => bytes);
  assert.equal(run.mode, "PREVIEW");
  assert.equal(run.input.inputDigest, digest);
  assert.equal(readCreditInitializationRun({ ...env, CREDIT_INIT_MODE: "APPLY" }, () => bytes).mode, "APPLY");
  assert.throws(() => readCreditInitializationRun({ ...env, CREDIT_INIT_ENABLED: "" }, () => bytes), /ENABLED/);
  assert.throws(() => readCreditInitializationRun({ ...env, CREDIT_INIT_PACKAGE_SHA256: "0".repeat(64) }, () => bytes), /digest/);
  assert.throws(() => readCreditInitializationRun({ ...env, CREDIT_INIT_RESOURCE_REF: "default-db" }, () => bytes), /resourceRef/);
});
