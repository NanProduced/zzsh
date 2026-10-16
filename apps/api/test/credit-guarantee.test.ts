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

import { applyCreditInitializationBatch, planCreditInitialization } from "../src/credit/credit-initialization";

function initClient(state: Set<string>, users: string[], log: string[]) {
  return { query: async (sql: string, params: unknown[] = []) => {
    log.push(sql.replace(/\s+/g, " ").trim().slice(0, 40));
    if (sql.includes(`LEFT JOIN zzsh_credit.user_credit_state`)) { const after = params[0] as string | null; return { rows: users.filter((id) => !state.has(id) && (after === null || id > after)).slice(0, params[1] as number).map((id) => ({ id })) }; }
    if (sql.includes("user_id = ANY")) return { rows: (params[0] as string[]).filter((id) => state.has(id)).map((userId) => ({ userId })) };
    if (sql.startsWith("SELECT 1 FROM zzsh_credit.user_credit_state")) return { rows: [], rowCount: state.has(params[0] as string) ? 1 : 0 };
    if (sql.includes(`FROM zzsh_auth_user."user" WHERE id=$1`)) return { rows: [{}], rowCount: users.includes(params[0] as string) ? 1 : 0 };
    if (sql.includes("INSERT INTO zzsh_credit.user_credit_state")) { const id = params[0] as string; if (state.has(id)) return { rows: [] }; state.add(id); return { rows: [{ userId: id, score: 100, revision: "1", initializedAt: "t" }] }; }
    if (sql.includes("INSERT INTO zzsh_credit.credit_event")) return { rows: [] };
    if (sql.includes("FOR UPDATE")) return { rows: [{ userId: params[0], score: 90, revision: "3", initializedAt: "t" }] };
    if (sql.includes("audit_event")) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } } as any;
}

test("credit initialization plan pages only users without state and never touches existing scores", async () => {
  const state = new Set(["u2"]); const log: string[] = [];
  const client = initClient(state, ["u1", "u2", "u3", "u4"], log);
  assert.deepEqual(await planCreditInitialization(client, { limit: 2 }), { candidates: ["u1", "u3"], nextAfter: "u3" });
  assert.deepEqual(await planCreditInitialization(client, { afterUserId: "u3", limit: 2 }), { candidates: ["u4"], nextAfter: null });
  await assert.rejects(() => planCreditInitialization(client, { limit: 0 }), /limit/);
  await assert.rejects(() => planCreditInitialization(client, { limit: 501 }), /limit/);
});

test("credit initialization dry-run writes nothing; apply is idempotent, audited once and reports existing users", async () => {
  const state = new Set(["u2"]); const log: string[] = [];
  const client = initClient(state, ["u1", "u2", "u3"], log);
  const base = { batchKey: "credit-init:batch-0001", actorId: "operator", requestId: "req_1", reason: "decided rule: initial 100" };
  const dry = await applyCreditInitializationBatch(client, { ...base, userIds: ["u1", "u2", "u3"], dryRun: true });
  assert.deepEqual([dry.applied, dry.alreadyInitialized], [["u1", "u3"], ["u2"]]);
  assert.equal(log.some((sql) => sql.startsWith("INSERT")), false);
  const first = await applyCreditInitializationBatch(client, { ...base, userIds: ["u1", "u2", "u3"], dryRun: false });
  assert.deepEqual([first.applied, first.alreadyInitialized], [["u1", "u3"], ["u2"]]);
  assert.equal(log.filter((sql) => sql.includes("audit_event")).length, 1);
  const replay = await applyCreditInitializationBatch(client, { ...base, userIds: ["u1", "u3"], dryRun: false });
  assert.deepEqual([replay.applied, replay.alreadyInitialized], [[], ["u1", "u3"]]);
  for (const bad of [{ batchKey: "x" }, { userIds: [] }, { userIds: ["u1", "u1"] }, { reason: " " }]) await assert.rejects(() => applyCreditInitializationBatch(client, { ...base, userIds: ["u1"], dryRun: false, ...bad } as any));
});
