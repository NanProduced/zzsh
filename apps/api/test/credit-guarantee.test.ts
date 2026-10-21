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

// I (P-Q6): the owner page batch reader must project the same contexts as the per-account reader and
// keep its SQL count flat in the number of held accounts, including the reused owner credit row.
// I-R1-01: the batch binding read must be matched against the frozen (account, owner, price, version)
// tuples of the first contexts read; the test double enforces those match conditions instead of
// returning every binding when it merely sees DISTINCT ON.
import { readGuaranteeContext, readGuaranteeContextsBatch } from "../src/credit/credit-guarantee";
import { fundingPolicyFixture } from "./funding-authority-fixtures";

const guaranteeRow = (accountId: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  accountId, ownerUserId: "user-a", gameId: "game-a", currentVersionId: `version-${accountId}`, versionId: `version-${accountId}`,
  priceVersionId: "price-1", releaseId: "release-1", policy: { ...fundingPolicyFixture("NOT_REQUIRED"), policyVersion: "policy-1" },
  policyStatus: "SEALED", priceStatus: "SEALED", payload, ...overrides,
});
const quotePayload = (amount: string | null) => (amount === null ? { quoteValues: {} } : { quoteValues: { resourceTotal: { currency: "CNY", unit: "yuan", scale: 2, amount } } });
const bindingRow = (requirementId = "req-1", overrides: Record<string, unknown> = {}) => ({
  requirementId, requirementStatus: "ACTIVE", bindingBaseCents: "10000", bindingRequiredCents: "500",
  paymentId: `pay-${requirementId}`, paymentState: "CONFIRMED", paymentProviderState: "CONFIRMED", paymentAmountCents: "500",
  paymentObservedAmountCents: "500", paymentFinanceEventId: "event-1", paymentLedgerEntryRef: "line-1",
  confirmedCents: "500", unrecognizedPayment: false,
  refundId: null, refundState: null, refundProviderState: null, refundAmountCents: null, refundPolicyState: null,
  refundFinanceEventId: null, refundLedgerEntryRef: null, succeededRefundCents: "0", activeRefund: false,
  updatedAt: "2026-10-20T00:00:00.000000Z", ...overrides,
});
type BindingFacts = { accountId: string; ownerUserId: string; priceVersionId: string; listingVersionId: string | null; createdAt: string; row: Record<string, unknown> };
const bindingFacts = (accountId: string, row: Record<string, unknown>, overrides: Partial<BindingFacts> = {}): BindingFacts => ({
  accountId, ownerUserId: "user-a", priceVersionId: "price-1", listingVersionId: `version-${accountId}`, createdAt: "2026-10-20T00:00:00.000000Z", row, ...overrides,
});
/** The reader picks the newest requirement record per account: ORDER BY created_at DESC, id DESC. */
const newestPerAccount = (rows: BindingFacts[], accountIds?: Set<string>) => {
  const best = new Map<string, BindingFacts>();
  for (const facts of rows) {
    if (accountIds && !accountIds.has(facts.accountId)) continue;
    const current = best.get(facts.accountId);
    const id = String(facts.row.requirementId);
    if (!current || facts.createdAt > current.createdAt || facts.createdAt === current.createdAt && id > String(current.row.requirementId)) best.set(facts.accountId, facts);
  }
  return best;
};
function guaranteeWorld(input: { credit?: { score: number; revision: string } | null; rows: Record<string, Record<string, unknown>>; bindings?: BindingFacts[] }) {
  const queries: string[] = [];
  const client = { query: async (sql: string, args: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes("FROM zzsh_credit.user_credit_state")) return { rows: input.credit ? [{ score: input.credit.score, revision: input.credit.revision }] : [] };
    if (sql.includes("DISTINCT ON (r.account_id)")) {
      assert.doesNotMatch(sql, /current_release_id|current_version_id/, "the batch binding read must not re-derive the mutable current pointers");
      assert.match(sql, /IS NOT DISTINCT FROM/, "nullable frozen version keeps the NULL-safe match");
      assert.match(sql, /ORDER BY r\.account_id,r\.created_at DESC,r\.id DESC/, "latest binding record per account stays the selection rule");
      assert.match(sql, /ORDER BY created_at DESC,id DESC LIMIT 1/, "latest payment/refund records stay the selection rule");
      const [accounts, owners, prices, versions] = args as [string[], string[], string[], (string | null)[]];
      assert.ok(Array.isArray(accounts) && Array.isArray(owners) && Array.isArray(prices) && Array.isArray(versions), "the batch binding read takes the frozen (account, owner, priceVersion, version) tuples");
      assert.equal(accounts.length, owners.length); assert.equal(accounts.length, prices.length); assert.equal(accounts.length, versions.length);
      const frozen = accounts.map((accountId, index) => ({ accountId, ownerUserId: owners[index]!, priceVersionId: prices[index]!, listingVersionId: versions[index] ?? null }));
      const matches = (facts: BindingFacts) => frozen.some((entry) => entry.accountId === facts.accountId && entry.ownerUserId === facts.ownerUserId
        && entry.priceVersionId === facts.priceVersionId && (facts.listingVersionId === null ? entry.listingVersionId === null : facts.listingVersionId === entry.listingVersionId));
      return { rows: [...newestPerAccount((input.bindings ?? []).filter(matches), new Set(frozen.map((entry) => entry.accountId))).values()].map((facts) => ({ ...facts.row, accountId: facts.accountId })) };
    }
    if (sql.includes("a.id=ANY($1::text[])")) return { rows: Object.entries(input.rows).map(([, row]) => row) };
    if (sql.includes("FROM zzsh_order.owner_guarantee_requirement")) {
      // The per-account reader binds the exact tuple from its first read; the fake holds the same facts.
      const [accountId, ownerUserId, priceVersionId, versionId] = args as [string, string, string, string | null];
      const matched = (input.bindings ?? []).filter((facts) => facts.accountId === accountId && facts.ownerUserId === ownerUserId
        && facts.priceVersionId === priceVersionId && (facts.listingVersionId === null ? versionId === null : facts.listingVersionId === versionId));
      return { rows: [...newestPerAccount(matched).values()].map((facts) => facts.row) };
    }
    if (sql.includes('WHERE a.id=$1 AND a.owner_user_id=$2')) return { rows: input.rows[String(args[0])] ? [input.rows[String(args[0])]] : [] };
    throw new Error(`unexpected read: ${sql}`);
  } } as never;
  return { client, queries };
}

test("batch owner-guarantee contexts equal the per-account reader while SQL stays flat in account count", async () => {
  const world = guaranteeWorld({
    credit: { score: 70, revision: "4" },
    rows: {
      "account-satisfied": guaranteeRow("account-satisfied", quotePayload("100.00")),
      "account-required": guaranteeRow("account-required", quotePayload("100.00")),
      "account-no-quote": guaranteeRow("account-no-quote", quotePayload(null)),
    },
    bindings: [bindingFacts("account-satisfied", bindingRow())],
  });
  const ids = ["account-satisfied", "account-required", "account-no-quote", "account-missing"];
  const before = world.queries.length;
  const batch = await readGuaranteeContextsBatch(world.client as never, "user-a", ids);
  const batchSql = world.queries.slice(before);
  assert.deepEqual([...batch.keys()].sort(), ["account-no-quote", "account-required", "account-satisfied"]);
  for (const accountId of ids) {
    const single = await readGuaranteeContext(world.client as never, accountId, "user-a");
    assert.deepEqual(batch.get(accountId) ?? null, single, `batch must match the single reader for ${accountId}`);
  }
  assert.equal(batch.get("account-satisfied")!.state, "SATISFIED");
  assert.equal(batch.get("account-required")!.state, "REQUIRED");
  assert.equal(batch.get("account-required")!.reference, null);
  assert.deepEqual({ state: batch.get("account-no-quote")!.state, reasonCode: batch.get("account-no-quote")!.reasonCode }, { state: "UNKNOWN", reasonCode: "STANDARD_QUOTE_UNAVAILABLE" });
  assert.equal(batch.get("account-satisfied")!.creditRevision, "4");
  // One context read, one owner credit read and one binding read, whatever the account count is.
  assert.equal(batchSql.length, 3, JSON.stringify(batchSql.map((sql) => sql.slice(0, 40))));
  assert.equal(batchSql.filter((sql) => sql.includes("zzsh_credit.user_credit_state")).length, 1, "owner credit is read once per page");
  assert.equal(batchSql.filter((sql) => sql.includes("DISTINCT ON (r.account_id)")).length, 1);
});

test("the batch credit-row seam neither re-reads owner credit nor invents an initialized state", async () => {
  const rows = { "account-satisfied": guaranteeRow("account-satisfied", quotePayload("100.00")) };
  const reuse = guaranteeWorld({ credit: null, rows, bindings: [bindingFacts("account-satisfied", bindingRow())] });
  const reused = await readGuaranteeContextsBatch(reuse.client as never, "user-a", ["account-satisfied"], { score: 70, revision: "4" });
  assert.equal(reused.get("account-satisfied")!.state, "SATISFIED");
  assert.equal(reuse.queries.some((sql) => sql.includes("zzsh_credit.user_credit_state")), false, "an already read credit row must not be re-read");
  const missing = guaranteeWorld({ credit: null, rows, bindings: [bindingFacts("account-satisfied", bindingRow())] });
  const absent = await readGuaranteeContextsBatch(missing.client as never, "user-a", ["account-satisfied"], null);
  assert.deepEqual({ state: absent.get("account-satisfied")!.state, reasonCode: absent.get("account-satisfied")!.reasonCode }, { state: "UNKNOWN", reasonCode: "CREDIT_UNINITIALIZED" });
  assert.equal(missing.queries.some((sql) => sql.includes("zzsh_credit.user_credit_state")), false);
});

test("batch bindings match the frozen first-read version tuples instead of the mutable current pointers", async () => {
  // The first contexts read selects version-A/price-1; version-B carries its own satisfied requirement.
  // A binding read that re-derives current pointers would return B's payment against A's context.
  const rows = {
    "account-a": guaranteeRow("account-a", quotePayload("100.00")),
    "account-null-version": guaranteeRow("account-null-version", quotePayload("100.00"), { currentVersionId: null, versionId: null }),
    "account-satisfied": guaranteeRow("account-satisfied", quotePayload("100.00")),
  };
  const world = guaranteeWorld({
    credit: { score: 70, revision: "4" },
    rows,
    bindings: [
      bindingFacts("account-a", bindingRow("req-a")),
      bindingFacts("account-a", bindingRow("req-a-newer"), { createdAt: "2026-10-21T00:00:00.000000Z" }),
      bindingFacts("account-a", bindingRow("req-b", { bindingBaseCents: "20000", bindingRequiredCents: "1000", confirmedCents: "1000" }), { priceVersionId: "price-2", listingVersionId: "version-b" }),
      bindingFacts("account-a", bindingRow("req-other-owner"), { ownerUserId: "user-b" }),
      bindingFacts("account-null-version", bindingRow("req-null"), { listingVersionId: null }),
      bindingFacts("account-null-version", bindingRow("req-not-null", { bindingBaseCents: "20000", bindingRequiredCents: "1000" }), { listingVersionId: "version-stale" }),
      bindingFacts("account-satisfied", bindingRow("req-not-in-page"), { priceVersionId: "price-2", listingVersionId: "version-b" }),
    ],
  });
  const batch = await readGuaranteeContextsBatch(world.client as never, "user-a", ["account-a", "account-null-version", "account-satisfied"]);
  for (const accountId of ["account-a", "account-null-version", "account-satisfied"]) {
    const single = await readGuaranteeContext(world.client as never, accountId, "user-a");
    assert.deepEqual(batch.get(accountId) ?? null, single, `frozen version binding must match the single reader for ${accountId}`);
  }
  assert.equal(batch.get("account-a")!.requirementId, "req-a-newer", "the latest record of the frozen version wins over older and other-version requirements");
  assert.equal(batch.get("account-a")!.state, "SATISFIED");
  assert.equal(batch.get("account-null-version")!.requirementId, "req-null", "a NULL frozen version only matches NULL requirement versions");
  assert.equal(batch.get("account-satisfied")!.requirementId, undefined, "requirements of other versions stay unmatched without a frozen tuple");
  assert.equal(batch.get("account-satisfied")!.state, "REQUIRED");
  // The batch binding arguments are exactly the frozen tuples of the accounts that need binding.
  const bindingQuery = world.queries.find((sql) => sql.includes("DISTINCT ON (r.account_id)"))!;
  assert.ok(bindingQuery);
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

import { applyCreditInitializationBatch, planCreditInitialization, previewCreditInitialization, readCreditInitializationReceipt, runCreditInitializationBatch, CreditInitializationOutcomeError, withReadOnlyTransaction, creditInitializationFingerprint }  from "../src/credit/credit-initialization";
import { describeCreditInitializationFailure, readCreditInitializationRun } from "../src/credit/credit-initialization-cli";
import { createHash as nodeHash } from "node:crypto";

type Identity = "ACTIVE" | "CANCELLED" | "DEACTIVATED" | "RESTRICTED" | "MISSING";
type World = { users: Map<string, Identity>; scores: Map<string, number>; events: string[]; receipts: Map<string, { fp: string; status: number; body: unknown }>; audits: number; admins: Map<string, { status: string; isBoss: boolean }>; sessions: Map<string, { userId: string; expiresAt: string; locked: boolean; suspended?: boolean; twoFactor?: boolean }>; dbNow: string; live: Record<string, unknown>; failAudit?: boolean; concurrentFor?: string; identityReads: number; writesSeen: string[]; failCommit?: "AFTER_DURABLE"; txStart?: string; clock?: string[]; commits?: number; sql?: string[] };
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
    w.sql?.push(sql);
    if (sql === "COMMIT") { w.commits = (w.commits ?? 0) + 1; if (w.failCommit === "AFTER_DURABLE") throw new Error("connection terminated during COMMIT"); return { rows: [] }; }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes(`"zzsh_iam"."admin_security"`)) { const a = w.admins.get(params[0]); return { rows: a ? [{ status: a.status, isBoss: a.isBoss, passwordChangeRequired: false }] : [] }; }
    if (sql.includes(`"zzsh_auth_admin"."session"`)) { const s = w.sessions.get(params[0]); const live = s && s.userId === params[1] && (!sql.includes("clock_timestamp()") || Date.parse(s.expiresAt) > Date.parse(w.dbNow)); return { rows: live ? [{ locked: s!.locked, pinHash: null, pinFailures: 0, expiresAt: new Date(s!.expiresAt), suspended: s!.suspended ?? false, twoFactorEnabled: s!.twoFactor ?? true }] : [] }; }
    if (sql.includes("role_permissions")) return { rows: [] };
    // PG semantics: now() is the transaction start, clock_timestamp() the actual current time.
    if (sql.includes("credit-init-window")) return { rows: [{ dbNow: sql.includes("clock_timestamp()") ? (w.clock?.length ? w.clock.shift()! : w.dbNow) : (w.txStart ?? w.dbNow) }] };
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

const COMMENT_RESOURCE = { databaseName: "zzsh_window", databaseOid: "16384", owner: "zzsh_owner", runtimeRole: "zzsh_runtime", bindingKind: "DATABASE_COMMENT", databaseComment: "synthetic:credit-resource:v1" } as const;
function commentWorld(): World {
  const w = world();
  // Actual catalog row is independent of the expected approval descriptor.
  w.live = { databaseName: "zzsh_window", databaseOid: "16384", owner: "zzsh_owner", runtimeRole: "zzsh_runtime", databaseComment: "synthetic:credit-resource:v1" };
  w.sql = [];
  return w;
}
function commentClient(w: World) {
  const inner = client(w);
  return { query: async (sql: string, params: any[] = []) => {
    if (sql.includes('"zzsh_meta"."database_marker"')) throw Object.assign(new Error("synthetic marker table absent"), { code: "42P01" });
    if (sql.includes("credit-init-resource-comment")) {
      assert.match(sql, /shobj_description\(d\.oid, 'pg_database'\)/);
      assert.match(sql, /current_user AS "runtimeRole"/);
      assert.deepEqual(params, []);
    }
    return inner.query(sql, params);
  } } as any;
}

test("COMMENT authority reads the catalog without a test marker table; legacy v1 never falls back", async () => {
  const w = commentWorld(), preview = await previewCreditInitialization(commentClient(w), input({}, { resource: COMMENT_RESOURCE }));
  assert.deepEqual([preview.wouldApply, preview.alreadyInitialized], [["u1", "u3"], ["u2"]]);
  assert.equal(preview.fingerprint, creditInitializationFingerprint(input()));
  assert(!w.sql!.some(sql => sql.includes("zzsh_meta")));
  assert.deepEqual(w.writesSeen, []);
  await assert.rejects(() => previewCreditInitialization(commentClient(w), input()), (e: any) => e.code === "42P01");
});

test("COMMENT authority rejects every actual identity/marker drift, missing row and query error", async () => {
  for (const patch of [{ databaseName: "other" }, { databaseOid: "16385" }, { owner: "other_owner" }, { runtimeRole: "other_role", session_user: "zzsh_runtime" }, { databaseComment: null }, { databaseComment: "" }, { databaseComment: "synthetic:credit-resource:v1-extra" }, { databaseComment: "synthetic:credit-resource:v1 " }, { databaseComment: "SYNTHETIC:credit-resource:v1" }]) {
    const w = commentWorld(); Object.assign(w.live, patch);
    await assert.rejects(() => previewCreditInitialization(commentClient(w), input({}, { resource: COMMENT_RESOURCE })), /approved resource/);
    assert.deepEqual(w.writesSeen, []);
  }
  for (const code of [null, "42501"]) {
    const w = commentWorld(), inner = commentClient(w);
    const c = { query: (sql: string, params: any[]) => sql.includes("credit-init-resource-comment") ? code ? Promise.reject(Object.assign(new Error("synthetic catalog denial"), { code })) : Promise.resolve({ rows: [] }) : inner.query(sql, params) } as any;
    await assert.rejects(() => previewCreditInitialization(c, input({}, { resource: COMMENT_RESOURCE })), code ? (e: any) => e.code === code : /approved resource/);
  }
});

test("COMMENT PREVIEW, WRITE and RECOVER keep Boss/session/DB-clock guards", async () => {
  const operations = [previewCreditInitialization, applyCreditInitializationBatch, readCreditInitializationReceipt];
  for (const operation of operations) for (const deny of ["non-boss", "frozen", "suspended", "locked", "totp", "expired", "db-clock"] as const) {
    const w = commentWorld();
    if (deny === "non-boss") w.admins.get("boss")!.isBoss = false;
    if (deny === "frozen") w.admins.get("boss")!.status = "FROZEN";
    if (deny === "suspended") w.sessions.get("sess-boss")!.suspended = true;
    if (deny === "locked") w.sessions.get("sess-boss")!.locked = true;
    if (deny === "totp") w.sessions.get("sess-boss")!.twoFactor = false;
    if (deny === "expired") w.sessions.get("sess-boss")!.expiresAt = "2000-01-01T00:00:00Z";
    if (deny === "db-clock") w.dbNow = "2026-10-20T04:00:00.000000Z";
    await assert.rejects(() => operation(commentClient(w), input({ userIds: ["u1"] }, { resource: COMMENT_RESOURCE })));
    assert.deepEqual(w.writesSeen, []);
  }
});

test("COMMENT COMMIT_UNKNOWN recovers and replays the original key/body under current authority", async () => {
  const w = commentWorld(); w.failCommit = "AFTER_DURABLE";
  const original = input({ userIds: ["u1"] }, { resource: COMMENT_RESOURCE });
  await assert.rejects(() => runCreditInitializationBatch(pool(w), original), (e: any) => e instanceof CreditInitializationOutcomeError && e.outcome === "COMMIT_UNKNOWN" && !e.rollbackAcknowledged);
  const audits = w.audits, later = input({ userIds: ["u1"] }, { resource: COMMENT_RESOURCE, approvalRef: "approval-new-window", attempt: 2 });
  const recovered = await readCreditInitializationReceipt(commentClient(w), later); assert.equal(recovered.state, "FOUND");
  const replay = await applyCreditInitializationBatch(commentClient(w), later); assert.equal(replay.replayed, true); assert.equal(w.audits, audits);
  if (recovered.state === "FOUND") assert.deepEqual(replay.receipt, recovered.receipt);
  await assert.rejects(() => applyCreditInitializationBatch(commentClient(w), input({ userIds: ["u3"] }, { resource: COMMENT_RESOURCE })), /different request/);
  w.live.databaseComment = "changed-after-success";
  await assert.rejects(() => readCreditInitializationReceipt(commentClient(w), later), /approved resource/);
  assert(!w.sql!.some(sql => sql.includes("zzsh_meta")));
});

test("credit CLI v2 explicitly binds COMMENT; malformed/version-mixed resources reject before connecting", () => {
  const bytes = Buffer.from(JSON.stringify({ schema: "credit-init-package-v1", batchKey: "credit-init:resource-0001", userIds: ["u1"], approvedCategory: "ACTIVE", reason: "synthetic resource approval" }));
  const digest = (b: Buffer) => nodeHash("sha256").update(b).digest("hex"), packageSha = digest(bytes);
  const parse = (over: Record<string, unknown> = {}, configured = { databaseName: "zzsh_window", databaseUser: "zzsh_runtime" }) => {
    const approval = Buffer.from(JSON.stringify({ schema: "credit-init-approval-v2", status: "APPROVED", approvalRef: "synthetic-credit-comment", attempt: 1, mode: "PREVIEW", businessPackageSha256: packageSha, actor: { adminId: "boss", sessionId: "sess-boss" }, windowStartUtc: "2026-10-20T00:00:00Z", windowEndUtc: "2026-10-20T04:00:00Z", resource: COMMENT_RESOURCE, ...over }));
    return readCreditInitializationRun({ CREDIT_INIT_ENABLED: "true", CREDIT_INIT_PACKAGE_FILE: "business", CREDIT_INIT_PACKAGE_SHA256: packageSha, CREDIT_INIT_APPROVAL_FILE: "approval", CREDIT_INIT_APPROVAL_SHA256: digest(approval), CREDIT_INIT_MODE: "PREVIEW" }, p => p === "business" ? bytes : approval, Date.parse("2026-10-20T01:00:00Z"), configured);
  };
  const fresh = parse(), legacy = parse({ schema: "credit-init-approval-v1", resource: RESOURCE });
  assert.equal(creditInitializationFingerprint(fresh.input), creditInitializationFingerprint(legacy.input));
  assert.equal(fresh.input.intentDigest, legacy.input.intentDigest); assert.notEqual(fresh.input.execution.approvalDigest, legacy.input.execution.approvalDigest);
  for (const patch of [{ schema: "credit-init-approval-v1" }, { schema: "credit-init-approval-v3" }, { resource: RESOURCE }, { status: "DRAFT_NOT_APPROVED" }, { businessPackageSha256: "f".repeat(64) }, ...[undefined, false, 0, "", "TEST_METADATA"].map(bindingKind => ({ resource: { ...COMMENT_RESOURCE, bindingKind } })), { resource: { ...COMMENT_RESOURCE, markerKey: "hidden-metadata" } }, { resource: { ...COMMENT_RESOURCE, databaseComment: "" } }, { resource: { ...COMMENT_RESOURCE, databaseOid: "0" } }]) assert.throws(() => parse(patch));
  assert.throws(() => parse({}, { databaseName: "other", databaseUser: "zzsh_runtime" }), /nothing was connected/);
  assert.throws(() => parse({}, { databaseName: "zzsh_window", databaseUser: "other" }), /nothing was connected/);
});

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

/** Strict PostgreSQL READ ONLY fixture: row locks and writes are rejected exactly as PG does; reads pass through. */
function readOnlyPool(w: World) {
  return { connect: async () => { let readOnly = false; const inner = client(w); return { release() {}, query: async (sql: string, params?: any[]) => {
    if (sql === "BEGIN READ ONLY") { readOnly = true; return { rows: [] }; }
    if (readOnly && /\bFOR\s+(UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/i.test(sql)) throw new Error("cannot execute SELECT FOR UPDATE in a read-only transaction");
    if (readOnly && /^\s*(INSERT|UPDATE|DELETE)\b|\bINSERT INTO\b/i.test(sql)) throw new Error("cannot execute INSERT in a read-only transaction");
    return inner.query(sql, params);
  } }; } } as any;
}

test("E-R3-03 PREVIEW/RECOVER_READ run in a real READ ONLY shape with non-locking current-identity authorization", async () => {
  const w = world();
  await runCreditInitializationBatch(pool(w), input());
  const ro = (target: World, over: Record<string, unknown> = {}, exec: Record<string, unknown> = {}) => withReadOnlyTransaction(readOnlyPool(target), (c) => readCreditInitializationReceipt(c, input(over, exec)));
  assert.equal((await ro(w, {}, { approvalRef: "approval-credit-002", attempt: 2 })).state, "FOUND");
  assert.equal((await ro(w, { userIds: ["u1"] })).state, "FINGERPRINT_MISMATCH");
  assert.equal((await ro(world())).state, "NOT_FOUND");
  const pw = world();
  const preview = await withReadOnlyTransaction(readOnlyPool(pw), (c) => previewCreditInitialization(c, input({ userIds: ["u1", "c1"] })));
  assert.deepEqual(preview.outsideApprovedCategory, [{ userId: "c1", category: "CANCELLED" }]);
  assert.deepEqual(pw.writesSeen, []);
  // Identity gates still apply on the read path.
  const gates: Array<[string, (x: World) => void, RegExp]> = [
    ["frozen admin", (x) => { x.admins.set("boss", { status: "FROZEN", isBoss: true }); }, /Access denied|unavailable/],
    ["not boss", (x) => { x.admins.set("boss", { status: "ACTIVE", isBoss: false }); }, /active Boss/],
    ["suspended", (x) => { x.sessions.get("sess-boss")!.suspended = true; }, /Authentication required/],
    ["expired session", (x) => { x.sessions.get("sess-boss")!.expiresAt = "2026-10-20T00:59:59.000Z"; }, /Authentication required/],
    ["no TOTP", (x) => { x.sessions.get("sess-boss")!.twoFactor = false; }, /Additional verification/],
    ["locked session", (x) => { x.sessions.get("sess-boss")!.locked = true; }, /locked/i],
    ["other actor session", (x) => { x.sessions.set("sess-boss", { userId: "boss2", expiresAt: "2099-01-01T00:00:00.000Z", locked: false }); }, /Authentication required/],
  ];
  for (const [label, mutate, pattern] of gates) {
    const g = world(); mutate(g);
    await assert.rejects(() => ro(g), pattern, label);
    await assert.rejects(() => withReadOnlyTransaction(readOnlyPool(g), (c) => previewCreditInitialization(c, input())), pattern, label);
  }
  // APPLY keeps the locking write guard.
  const aw = world(); aw.sql = [];
  await runCreditInitializationBatch(pool(aw), input());
  assert.ok(aw.sql.some((q) => q.includes('"admin_security"') && /FOR UPDATE/.test(q)), "APPLY still locks admin_security");
  assert.ok(aw.sql.some((q) => q.includes('"session"') && /FOR UPDATE OF s/.test(q)), "APPLY still locks the session");
});

test("E-R3-04 the permit window uses the DB actual clock after locks and before COMMIT; an expired permit never sends COMMIT", async () => {
  // Reviewer counterexample: transaction started inside the window, actual DB time already past it.
  const late = world(); late.txStart = "2026-10-20T03:59:59.900000Z"; late.dbNow = "2026-10-20T04:00:02.000000Z";
  await assert.rejects(() => runCreditInitializationBatch(pool(late), input()), (e: any) => e instanceof CreditInitializationOutcomeError && e.outcome === "NOT_COMMITTED" && /window is not open/.test(String((e.cause as any)?.message)));
  assert.deepEqual([late.commits ?? 0, late.scores.size, late.receipts.size, late.audits], [0, 1, 0, 0]);
  // Window open at authorization, closes while waiting for the object locks: no writes at all.
  const lockWait = world(); lockWait.clock = ["2026-10-20T03:59:59.000000Z", "2026-10-20T04:00:00.000000Z"];
  await assert.rejects(() => runCreditInitializationBatch(pool(lockWait), input()), (e: any) => e.outcome === "NOT_COMMITTED");
  assert.deepEqual([lockWait.commits ?? 0, lockWait.writesSeen], [0, []]);
  // Window closes during the batch: rolled back, COMMIT never sent, original key/body preserved for a new window.
  const longBatch = world(); longBatch.clock = ["2026-10-20T03:59:58.000000Z", "2026-10-20T03:59:59.000000Z", "2026-10-20T04:00:00.000001Z"];
  const error = await runCreditInitializationBatch(pool(longBatch), input()).then(() => null, (e) => e);
  assert.ok(error instanceof CreditInitializationOutcomeError);
  assert.deepEqual([error.outcome, error.rollbackAcknowledged, longBatch.commits ?? 0], ["NOT_COMMITTED", true, 0]);
  assert.deepEqual([[...longBatch.scores.keys()], longBatch.receipts.size, longBatch.audits], [["u2"], 0, 0]);
  assert.deepEqual([error.preserved.batchKey, error.preserved.fingerprint], ["credit-init:batch-0001", creditInitializationFingerprint(input())]);
  // The same key/body applies in a newly approved window.
  const again = await runCreditInitializationBatch(pool(longBatch), input({}, { approvalRef: "approval-credit-002", attempt: 2 }));
  assert.equal(again.replayed, false);
  // Inside the window throughout: one COMMIT, as before.
  const ok = world(); await runCreditInitializationBatch(pool(ok), input()); assert.equal(ok.commits, 1);
});
