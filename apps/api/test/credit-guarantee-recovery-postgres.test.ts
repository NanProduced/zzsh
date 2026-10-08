import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool, type PoolClient } from "pg";

import {
  decideRecovery,
  readCreditSnapshot,
  requestRecovery,
} from "../src/credit/credit-guarantee";
import { canonicalize } from "../src/supply/content-hash";

const DATABASE = "zzsh_test_credit_guarantee";
const RUNTIME_ROLE = "zzsh_credit_guarantee_r";
const OWNER_ROLE = "zzsh";
const CREDENTIAL_FILE = process.env.CREDIT_GUARANTEE_CREDENTIALS_FILE
  ?? "E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/credit_guarantee/credentials.json";
const BOSS_ID = "admin_80768cba2f044bce8c86c04442d8dd95";

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function money(cents: string): string {
  const value = BigInt(cents);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function amount(cents: string): Record<string, unknown> {
  return { currency: "CNY", unit: "yuan", scale: 2, amount: money(cents) };
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test("credit recovery positive 7-day fixture, decision idempotency and rate limit", {
  skip: !process.env.CREDIT_GUARANTEE_RUN_RECOVERY ? "set CREDIT_GUARANTEE_RUN_RECOVERY=1 for the approved recovery fixture window" : false,
}, async () => {
  const credentials = JSON.parse(readFileSync(CREDENTIAL_FILE, "utf8")) as any;
  assert.equal(credentials.database, DATABASE);
  assert.equal(credentials.oid, "893390");
  assert.equal(credentials.owner, OWNER_ROLE);
  assert.equal(credentials.runtime.role, RUNTIME_ROLE);
  const maintenancePassword = readFileSync(credentials.maintenance.passwordFile, "utf8").trim();
  const runtimePool = new Pool({ host: credentials.host, port: credentials.port, database: DATABASE, user: credentials.runtime.role, password: credentials.runtime.password, application_name: "credit-guarantee-recovery-runtime", max: 2 });
  const maintenancePool = new Pool({ host: credentials.host, port: credentials.port, database: DATABASE, user: credentials.maintenance.role, password: maintenancePassword, application_name: "credit-guarantee-recovery-fixture", max: 2 });
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  try {
    const candidate = (await maintenancePool.query<{
      orderId: string; userId: string; ownerUserId: string; displayNo: string; status: string;
      rentalCents: string; depositCents: string; currency: string; holdUntil: string;
      eventCount: string; stateCount: string;
    }>(`
      SELECT o.id AS "orderId",o.renter_user_id AS "userId",o.owner_user_id AS "ownerUserId",
             o.display_no AS "displayNo",o.status,o.rental_amount_cents::text AS "rentalCents",
             o.deposit_amount_cents::text AS "depositCents",o.currency,o.hold_until::text AS "holdUntil",
             (SELECT count(*)::text FROM zzsh_credit.credit_event e WHERE e.user_id=o.renter_user_id) AS "eventCount",
             (SELECT count(*)::text FROM zzsh_credit.user_credit_state s WHERE s.user_id=o.renter_user_id) AS "stateCount"
        FROM zzsh_order.rental_order o
       WHERE o.owner_user_id LIKE 'credit_business_%_owner'
         AND o.renter_user_id LIKE 'credit_business_%_renter'
         AND o.status='PENDING_PAYMENT'
         AND NOT EXISTS (SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.order_id=o.id)
       ORDER BY o.created_at DESC,o.id DESC LIMIT 1
    `)).rows[0];
    assert.ok(candidate, "a fresh task-owned pending order is required for the recovery fixture");
    assert.equal(candidate!.eventCount, "0");
    assert.equal(candidate!.stateCount, "0");
    assert.equal(candidate!.currency, "CNY");
    assert.ok(Date.parse(candidate!.holdUntil) > Date.now(), "fixture order hold must still be open");
    const capturedCents = (BigInt(candidate!.rentalCents) + BigInt(candidate!.depositCents)).toString();
    const paymentId = `recovery_fixture_payment_${runId}`;
    const appId = `credit-recovery-fixture-${runId}`;
    const paymentTransactionId = `recovery-fixture-tx-${runId}`;
    const paymentRequestId = `recovery-fixture-request-${runId}`;
    const paymentAt = new Date();

    // Maintenance fixture only: create a valid local controlled APPLIED payment
    // and the smallest guarded settlement posting; all credit mutations below use runtime.
    await transaction(maintenancePool, async (client) => {
      await client.query(`
        INSERT INTO zzsh_order.payment_confirmation
          (id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,amount_cents,currency,
           provider_paid_at,accepted_at,disposition,reason_code,request_id)
        VALUES ($1,'CONTROLLED',$2,$3,$4,$5,$6,'CNY',$7,$7,'APPLIED',NULL,$8)
      `, [paymentId, appId, paymentTransactionId, candidate!.displayNo, candidate!.orderId, capturedCents, paymentAt, paymentRequestId]);
      await client.query(`
        UPDATE zzsh_order.rental_order
           SET status='PAID',paid_confirmation_id=$2,paid_at=$3,revision=revision+1,updated_at=$3
         WHERE id=$1 AND status='PENDING_PAYMENT'
      `, [candidate!.orderId, paymentId, paymentAt]);
      await client.query(`
        INSERT INTO zzsh_order.im_order_group(order_id,payment_confirmation_id,app_id)
        VALUES ($1,$2,$3)
      `, [candidate!.orderId, paymentId, appId]);
    });

    const versionHash = hash(["recovery-fixture", candidate!.orderId, runId]);
    const openingId = `recovery_fixture_opening_${runId}`;
    const settlementVersionId = `recovery_fixture_settlement_${runId}`;
    const postingId = `recovery_fixture_posting_${runId}`;
    const fixtureFundingSourceRef = `recovery-fixture-source-${runId}`;
    const snapshot = {
      kind: "SYSTEM",
      early: false,
      capturedAmount: money(capturedCents),
      fundingSourceRef: fixtureFundingSourceRef,
      endReason: "NORMAL",
      amounts: {
        ownerGross: money(capturedCents), ownerNet: money(capturedCents), renterRefund: "0.00",
        platformContribution: "0.00", feeAmount: "0.00", haffSpread: "0.00", itemSpread: "0.00",
        earlyMakeup: "0.00", depositRefund: "0.00", unusedItemRefund: "0.00", unusedHaffRefund: "0.00",
        feeBase: "0.00", feeRate: "0.00", feePayer: "NONE",
      },
    };
    const ownerDetails = {
      settlementVersionId, versionHash, systemGross: amount(capturedCents), systemNet: money(capturedCents),
      postedNet: money(capturedCents), feePayer: "NONE", compensationFee: amount("0"),
    };
    await transaction(maintenancePool, async (client) => {
      const quoteDigest = hash(["recovery-fixture-quote", candidate!.orderId]);
      const paymentDigest = hash(["recovery-fixture-payment", paymentId]);
      await client.query(`
        INSERT INTO zzsh_order.rental_opening
          (id,order_id,version_no,quote_digest,payment_digest,lines,status,created_by_admin_id,confirmed_at)
        VALUES ($1,$2,1,$3,$4,'[]'::jsonb,'CONFIRMED',$5,clock_timestamp())
      `, [openingId, candidate!.orderId, quoteDigest, paymentDigest, BOSS_ID]);
      await client.query(`
        INSERT INTO zzsh_order.settlement_version
          (id,order_id,opening_id,version_no,kind,end_reason,early,initiator_party,initiator_subject_id,
           basis_hash,version_hash,input_snapshot,computation,system_owner_net_cents,system_renter_refund_cents,
           proposed_owner_net_cents,proposed_renter_refund_cents)
        VALUES ($1,$2,$3,1,'SYSTEM','NORMAL',false,'RENTER',$4,$5,$5,$6::jsonb,'{}'::jsonb,$7,0,NULL,NULL)
      `, [settlementVersionId, candidate!.orderId, openingId, candidate!.userId, versionHash, JSON.stringify(snapshot), capturedCents]);
      await client.query(`
        INSERT INTO zzsh_order.settlement_decision
          (id,settlement_version_id,version_hash,basis_hash,party,action,subject_id)
        VALUES ($1,$2,$3,$3,'RENTER','CONFIRM',$4),($5,$2,$3,$3,'OWNER','CONFIRM',$6)
      `, [`recovery_fixture_decision_r_${runId}`, settlementVersionId, versionHash, candidate!.userId, `recovery_fixture_decision_o_${runId}`, candidate!.ownerUserId]);
      await client.query(`
        INSERT INTO zzsh_order.settlement_posting
          (id,order_id,settlement_version_id,payment_confirmation_id,version_hash,early,captured_cents,
           system_owner_net_cents,owner_net_cents,system_renter_refund_cents,renter_refund_cents,
           platform_contribution_cents,compensation_fee_cents,posted_at,refund_due_at)
        VALUES ($1,$2,$3,$4,$5,false,$6,$6,$6,0,0,0,0,clock_timestamp(),NULL)
      `, [postingId, candidate!.orderId, settlementVersionId, paymentId, versionHash, capturedCents]);
      await client.query(`
        INSERT INTO zzsh_order.settlement_ledger_entry
          (id,posting_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
        VALUES
          ($1,$2,1,'CAPTURED_PAYMENT_SOURCE',$3,0,NULL,$4,$5::jsonb),
          ($6,$2,2,'OWNER_AVAILABLE',0,$3,$7,NULL,$8::jsonb)
      `, [
        `recovery_fixture_ledger_source_${runId}`, postingId, capturedCents, paymentId,
        JSON.stringify({ paymentConfirmationId: paymentId, disposition: "APPLIED", fundingSourceRef: fixtureFundingSourceRef }),
        `recovery_fixture_ledger_owner_${runId}`, candidate!.ownerUserId, JSON.stringify(ownerDetails),
      ]);
      const completed = await client.query(`
        UPDATE zzsh_order.rental_order SET status='COMPLETED',updated_at=clock_timestamp(),revision=revision+1
         WHERE id=$1 AND status='PAID'
      `, [candidate!.orderId]);
      assert.equal(completed.rowCount, 1);
    });

    const initialized = await transaction(runtimePool, (client) => readCreditSnapshot(client, candidate!.userId, true));
    assert.equal(initialized?.score, 100);
    assert.equal(initialized?.revision, "1");
    const historicalEventId = `recovery_fixture_breach_${runId}`;
    const historicalEventKey = `breach:ORDER:${candidate!.orderId}:${candidate!.userId}:RENTER`;
    const visibleReason = "业务测试历史受控违约";
    const internalBasis = "TEST_ONLY historical fixture for seven-day recovery";
    const historicalCreatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await transaction(maintenancePool, async (client) => {
      await client.query(`SET LOCAL zzsh.credit_mutation='1'`);
      await client.query(`
        INSERT INTO zzsh_credit.credit_event
          (id,user_id,event_key,event_type,source_type,source_id,subject_role,delta_score,applied_delta_score,
           score_before,score_after,visible_reason,internal_basis,actor_admin_id,payload_hash,created_at)
        VALUES ($1,$2,$3,'BREACH_CONFIRMED','ORDER',$4,'RENTER',-10,-10,100,90,$5,$6,$7,$8,$9)
      `, [historicalEventId, candidate!.userId, historicalEventKey, candidate!.orderId, visibleReason, internalBasis, BOSS_ID, hash([historicalEventKey, visibleReason, internalBasis]), historicalCreatedAt]);
      const updated = await client.query(`UPDATE zzsh_credit.user_credit_state SET score=90,revision=2,updated_at=clock_timestamp() WHERE user_id=$1`, [candidate!.userId]);
      assert.equal(updated.rowCount, 1);
    });

    const recoveryKey = `recovery-positive-${runId}`;
    const recoveryFingerprint = hash([recoveryKey, "申请恢复"]);
    await assert.rejects(
      () => transaction(runtimePool, (client) => requestRecovery(client, {
        userId: candidate!.userId, requestKey: `recovery-unknown-${runId}`, requestFingerprint: hash(["unknown", runId]),
        reason: "责任未知时不得恢复", obligationReader: async () => "UNKNOWN",
      })),
      /OBLIGATION_UNKNOWN/,
    );
    const pending = await transaction(runtimePool, (client) => requestRecovery(client, {
      userId: candidate!.userId, requestKey: recoveryKey, requestFingerprint: recoveryFingerprint,
      reason: "七天无新违约且存在有效完成订单的业务恢复测试", obligationReader: async () => "NONE",
    }));
    assert.equal(pending.duplicate, false);
    assert.equal((pending.eligibility as any)?.eligible, true);
    assert.equal((pending.eligibility as any)?.score, 90);
    assert.equal((pending.eligibility as any)?.completedOrders, "1");
    assert.deepEqual((await transaction(runtimePool, (client) => requestRecovery(client, {
      userId: candidate!.userId, requestKey: recoveryKey, requestFingerprint: recoveryFingerprint,
      reason: "七天无新违约且存在有效完成订单的业务恢复测试", obligationReader: async () => "NONE",
    }))) .duplicate, true);
    await assert.rejects(
      () => transaction(runtimePool, (client) => requestRecovery(client, { userId: candidate!.userId, requestKey: recoveryKey, requestFingerprint: hash([recoveryKey, "changed"]), reason: "不同正文", obligationReader: async () => "NONE" })),
      /already bound to different evidence/,
    );
    const approved = await transaction(runtimePool, (client) => decideRecovery(client, { requestId: String(pending.requestId), actorAdminId: BOSS_ID, decision: "APPROVE", reason: "恢复条件已核实", obligationReader: async () => "NONE" }));
    assert.equal(approved.duplicate, false);
    assert.equal(approved.status, "APPROVED");
    assert.equal((await transaction(runtimePool, (client) => decideRecovery(client, { requestId: String(pending.requestId), actorAdminId: BOSS_ID, decision: "APPROVE", reason: "恢复条件已核实", obligationReader: async () => "NONE" }))).duplicate, true);
    await assert.rejects(
      () => transaction(runtimePool, (client) => decideRecovery(client, { requestId: String(pending.requestId), actorAdminId: BOSS_ID, decision: "REJECT", reason: "相反决定", obligationReader: async () => "NONE" })),
      /different decision or reason/,
    );
    const after = await transaction(runtimePool, (client) => readCreditSnapshot(client, candidate!.userId));
    assert.equal(after?.score, 100);
    assert.equal(after?.revision, "3");
    assert.equal(after?.events.filter((event) => event.eventType === "RECOVERY_APPROVED").length, 1);
    await assert.rejects(
      () => transaction(runtimePool, (client) => requestRecovery(client, { userId: candidate!.userId, requestKey: `recovery-rate-${runId}`, requestFingerprint: hash(["rate", runId]), reason: "七天限流测试", obligationReader: async () => "NONE" })),
      /RECOVERY_RATE_LIMITED/,
    );
    console.log(JSON.stringify({ evidenceClass: "LOCAL_PG_RUNTIME_RECOVERY", runId, orderId: candidate!.orderId, userId: candidate!.userId, paymentId, postingId, historicalEventId, requestId: pending.requestId, beforeScore: 90, afterScore: after?.score, afterRevision: after?.revision, completedOrders: (pending.eligibility as any)?.completedOrders }));
  } finally {
    await runtimePool.end();
    await maintenancePool.end();
  }
});
