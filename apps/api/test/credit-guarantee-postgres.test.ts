import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

import { confirmBreach, createGuaranteePaymentIntent, decideGuaranteeRefund, readCreditSnapshot, readGuaranteeTransactions, recordGuaranteePaymentResult, recordGuaranteeRefundResult, requestGuaranteeRefund, reverseBreach } from "../src/credit/credit-guarantee";
import { requiredGuaranteeCents } from "../src/credit/credit-guarantee";
import { validateFundingPolicy } from "../src/supply/funding-policy";
import { parseNonNegativeDecimal } from "../src/supply/decimal";
import { canonicalize } from "../src/supply/content-hash";

const database = process.env.CREDIT_GUARANTEE_DATABASE ?? "zzsh_test_credit_guarantee";
const runtimeUser = process.env.CREDIT_GUARANTEE_USER ?? "zzsh_credit_guarantee_r";
const password = process.env.CREDIT_GUARANTEE_PASSWORD?.trim();
const pool = password ? new Pool({ host: "127.0.0.1", port: 55432, user: runtimeUser, password, database, application_name: "credit-guarantee-r1-pg" }) : null;
const runId = randomUUID().replaceAll("-", "").slice(0, 16);
const userId = `credit_pg_user_${runId}`;
const adminId = `credit_pg_admin_${runId}`;
const gameId = `credit_pg_game_${runId}`;
const accountId = `credit_pg_account_${runId}`;

async function tx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("CREDIT_GUARANTEE_PASSWORD is required for the registered runtime role");
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

test("credit PG concurrency, recovery, controlled guarantee ledger and DB guard", { skip: !password ? "runtime-role credential not supplied; no superuser fallback" : false }, async () => {
  if (!pool) return;
  const lockKey = BigInt("0x" + createHash("sha256").update("credit-guarantee:credit_guarantee").digest("hex").slice(0, 15)) + 4_000_000n;
  const guard = await pool.connect();
  try {
    const meta = (await guard.query(`SELECT current_database() AS name,current_user AS role,shobj_description(d.oid,'pg_database') AS marker,r.rolsuper,r.rolbypassrls,d.oid::text AS oid FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
    assert.equal(meta?.name, database); assert.equal(meta?.role, runtimeUser); assert.equal(meta?.marker, "zzsh:credit-guarantee:v1"); assert.equal(meta?.rolsuper, false); assert.equal(meta?.rolbypassrls, false); assert.equal(meta?.oid, "893390");
    assert.equal((await guard.query(`SELECT pg_try_advisory_lock($1::bigint) AS acquired`, [lockKey])).rows[0]?.acquired, true);
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES($1,'信用PG用户',$2,$3,$3)`, [userId, `${userId}@example.invalid`, now]);
    await pool.query(`INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt") VALUES($1,'信用PG管理员',$2,$3,$3)`, [adminId, `${adminId}@example.invalid`, now]);
    const authority = (await pool.query(`SELECT g.id AS "gameId",r.id AS "releaseId",p.id AS "priceVersionId",p.funding_policy AS policy,v.payload FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id AND r.game_id=g.id JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.status='SEALED' JOIN zzsh_supply.listing_version v ON v.rule_release_id=r.id AND v.review_state='PUBLISHED' WHERE p.funding_policy->'guaranteeRequirement'->>'mode'='FIXED_CENTS' AND v.payload#>>'{quoteValues,pricingInputs,compatibility,customerTier}'='STANDARD' LIMIT 1`)).rows[0];
    assert.ok(authority, "an existing sealed STANDARD FIXED_CENTS authority is required; do not fabricate a policy fixture");
    const policy = validateFundingPolicy(authority.policy);
    const quoteAmount = authority.payload?.quoteValues?.resourceTotal?.amount;
    const baseCents = (parseNonNegativeDecimal(String(quoteAmount), 2, "resourceTotal").value * 1n).toString();
    const requiredCents = requiredGuaranteeCents(baseCents);
    assert.notEqual(requiredCents, "0", "real STANDARD quote must produce a positive controlled test amount");
    const gameId = authority.gameId as string;
    await pool.query(`INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id,display_no) VALUES($1,$2,$3,'CREDIT-PG-1')`, [accountId, userId, gameId]);

    const input = { userId, sourceType: "ACCOUNT", sourceId: accountId, subjectRole: "OWNER" as const, visibleReason: "PG并发测试违约", internalBasis: "PG并发测试依据", actorAdminId: adminId };
    const first = tx(client => confirmBreach(client, input));
    const second = tx(client => confirmBreach(client, input));
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
    const snapshot = await tx(client => readCreditSnapshot(client, userId));
    assert.equal(snapshot?.score, 90);
    assert.equal(snapshot?.events.filter(event => event.eventType === "BREACH_CONFIRMED").length, 1);

    await assert.rejects(() => tx(client => confirmBreach(client, { ...input, visibleReason: "不同依据" })), /different evidence/);
    const reversed = await Promise.all([tx(client => reverseBreach(client, { eventId: snapshot!.events.find(event => event.eventType === "BREACH_CONFIRMED")!.id, visibleReason: "撤销误判", internalBasis: "PG反向测试依据", actorAdminId: adminId })), tx(client => reverseBreach(client, { eventId: snapshot!.events.find(event => event.eventType === "BREACH_CONFIRMED")!.id, visibleReason: "撤销误判", internalBasis: "PG反向测试依据", actorAdminId: adminId }))]);
    assert.deepEqual(reversed.map(result => result.duplicate).sort(), [false, true]);
    const restored = await tx(client => readCreditSnapshot(client, userId));
    assert.equal(restored?.score, 100);
    assert.equal(restored?.events.filter(event => event.eventType === "BREACH_REVERSED").length, 1);
    await assert.rejects(() => guard.query(`UPDATE zzsh_credit.user_credit_state SET score=0 WHERE user_id=$1`, [userId]), /credit state is changed only by the credit mutation path/);

    const context = { accountId, ownerUserId: userId, gameId, versionId: null, priceVersionId: authority.priceVersionId, releaseId: authority.releaseId, policy, baseCents, requiredCents, score: 70, creditRevision: "1", state: "REQUIRED", reference: null } as never;
    const payment = await tx(client => createGuaranteePaymentIntent(client, { context, userId, requestKey: `payment-${runId}`, requestFingerprint: "a".repeat(64) }));
    await tx(client => recordGuaranteePaymentResult(client, { paymentId: String(payment.paymentId), outcome: "UNKNOWN", receipt: { provider: "LOCAL_CONTROLLED", step: "unknown" } }));
    const captured = await tx(client => recordGuaranteePaymentResult(client, { paymentId: String(payment.paymentId), outcome: "CONFIRMED", receivedAmountCents: requiredCents, providerTransactionId: `pg-tx-${runId}`, receipt: { provider: "LOCAL_CONTROLLED", step: "confirmed" } }));
    assert.ok(captured.financeEventId && captured.ledgerEntryRef);
    const replayedCapture = await tx(client => recordGuaranteePaymentResult(client, { paymentId: String(payment.paymentId), outcome: "CONFIRMED", receivedAmountCents: requiredCents, providerTransactionId: `pg-tx-${runId}`, receipt: { provider: "LOCAL_CONTROLLED", step: "confirmed" } }));
    assert.equal(replayedCapture.duplicate, true);
    await assert.rejects(() => tx(client => recordGuaranteePaymentResult(client, { paymentId: String(payment.paymentId), outcome: "CONFIRMED", receivedAmountCents: requiredCents, providerTransactionId: `pg-tx-other-${runId}`, receipt: { provider: "LOCAL_CONTROLLED", step: "changed" } })), /differs from the original transaction/);
    const rows = await tx(client => readGuaranteeTransactions(client, userId));
    assert.equal(rows.some((row: any) => row.paymentFinanceEventId === captured.financeEventId && row.paymentLedgerEntryRef === captured.ledgerEntryRef), true);
    const ledger = await tx(client => client.query(`SELECT line_no,account_code,debit_cents::text AS debit,credit_cents::text AS credit,counterparty_user_id,details FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1 ORDER BY line_no`, [captured.financeEventId]));
    assert.deepEqual(ledger.rows.map((row: any) => [row.line_no, row.account_code, row.debit, row.credit, row.counterparty_user_id]), [[1, "GUARANTEE_CASH", requiredCents, "0", null], [2, "GUARANTEE_HELD", "0", requiredCents, userId]]);
    assert.equal(createHash("sha256").update(canonicalize(ledger.rows[0].details)).digest("hex"), String((await tx(client => client.query(`SELECT payload_digest FROM zzsh_order.owner_guarantee_reconciliation WHERE payment_id=$1`, [payment.paymentId]))).rows[0].payload_digest));
    const refund = await tx(client => requestGuaranteeRefund(client, { userId, requirementId: String(payment.requirementId), requestKey: `refund-${runId}`, requestFingerprint: "b".repeat(64), obligationReader: async () => "NONE" }));
    await tx(client => recordGuaranteeRefundResult(client, { refundId: String(refund.refundId), outcome: "PROCESSING", receipt: { provider: "LOCAL_CONTROLLED", step: "processing" } }));
    await tx(client => recordGuaranteeRefundResult(client, { refundId: String(refund.refundId), outcome: "UNKNOWN", receipt: { provider: "LOCAL_CONTROLLED", step: "unknown" } }));
    await tx(client => recordGuaranteeRefundResult(client, { refundId: String(refund.refundId), outcome: "FAILED", receipt: { provider: "LOCAL_CONTROLLED", step: "failed" } }));
    await tx(client => decideGuaranteeRefund(client, { refundId: String(refund.refundId), actorAdminId: adminId, decision: "APPROVE", reason: "PG受控退款责任核对" }));
    const refunded = await tx(client => recordGuaranteeRefundResult(client, { refundId: String(refund.refundId), outcome: "SUCCEEDED", providerRefundId: `pg-rf-${runId}`, refundedAmountCents: requiredCents, receipt: { provider: "LOCAL_CONTROLLED", step: "succeeded" } }));
    assert.ok(refunded.financeEventId && refunded.ledgerEntryRef);
    assert.equal((await tx(client => recordGuaranteeRefundResult(client, { refundId: String(refund.refundId), outcome: "SUCCEEDED", providerRefundId: `pg-rf-${runId}`, refundedAmountCents: requiredCents, receipt: { provider: "LOCAL_CONTROLLED", step: "succeeded" } }))).duplicate, true);
    const finalRows = await tx(client => readGuaranteeTransactions(client, userId));
    assert.equal(finalRows.some((row: any) => row.refundFinanceEventId === refunded.financeEventId && row.refundLedgerEntryRef === refunded.ledgerEntryRef && row.refundStatus === "SUCCEEDED"), true);
  } finally {
    await guard.query(`SELECT pg_advisory_unlock($1::bigint)`, [lockKey]).catch(() => undefined); guard.release(); await pool.end();
  }
});
