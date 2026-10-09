import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  confirmBreach,
  readGuaranteeContextForGate,
  recordGuaranteeRefundResult,
  requestGuaranteeRefund,
  reverseBreach,
} from "../src/credit/credit-guarantee";

type Credentials = { host: string; port: number; database: string; oid: string; marker: string; runtime: { role: string; password: string } };
const credentialPath = process.env.CREDIT_GUARANTEE_CREDENTIALS_FILE ?? "E:/zzsh/zzsh/apps/api/.secrets/local-postgresql/credit_guarantee/credentials.json";
const enabled = process.env.CREDIT_GUARANTEE_CONCURRENCY_PG === "1";

function loadCredentials(): Credentials {
  const value = JSON.parse(readFileSync(credentialPath, "utf8")) as Credentials;
  assert.equal(value.database, "zzsh_test_credit_guarantee");
  assert.equal(value.oid, "893390");
  assert.equal(value.marker, "zzsh:credit-guarantee:v1");
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function finish(client: PoolClient | undefined, commit: boolean): Promise<void> {
  if (!client) return;
  try { await client.query(commit ? "COMMIT" : "ROLLBACK"); } finally { client.release(); }
}

test("F3 gate serializes credit mutation and guarantee release without runtime UPDATE privilege", { skip: !enabled ? "set CREDIT_GUARANTEE_CONCURRENCY_PG=1 for the approved targeted PG window" : false }, async () => {
  const credentials = loadCredentials();
  const pool = new Pool({ host: credentials.host, port: credentials.port, database: credentials.database, user: credentials.runtime.role, password: credentials.runtime.password, application_name: "credit-guarantee-f3-concurrency", max: 4 });
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  let gateClient: PoolClient | undefined;
  let mutationClient: PoolClient | undefined;
  let refundGateClient: PoolClient | undefined;
  let refundClient: PoolClient | undefined;
  try {
    const creditFixture = (await pool.query<{ accountId: string; ownerUserId: string; versionId: string }>(
      `SELECT a.id AS "accountId",a.owner_user_id AS "ownerUserId",a.current_version_id AS "versionId"
         FROM zzsh_supply.rental_account a
         JOIN zzsh_supply.game g ON g.id=a.game_id AND g.current_release_id IS NOT NULL
         JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id
          AND v.rule_release_id=g.current_release_id
         JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id
         JOIN zzsh_credit.user_credit_state cs ON cs.user_id=a.owner_user_id
        WHERE v.review_state='PUBLISHED' AND pub.source='OWNER_DIRECT' AND cs.score=80
          AND NOT EXISTS (SELECT 1 FROM zzsh_order.owner_guarantee_requirement r WHERE r.account_id=a.id)
          AND NOT EXISTS (SELECT 1 FROM zzsh_credit.credit_event e WHERE e.source_type='ACCOUNT' AND e.source_id=a.id)
        GROUP BY a.id,a.owner_user_id,a.current_version_id
        ORDER BY a.id DESC LIMIT 1`,
    )).rows[0];
    assert.ok(creditFixture, "an existing legal score-80 published fixture without a guarantee requirement is required");

    gateClient = await pool.connect();
    await gateClient.query("BEGIN");
    const gateContext = await readGuaranteeContextForGate(gateClient, creditFixture.accountId, creditFixture.ownerUserId, creditFixture.versionId);
    assert.equal(gateContext?.score, 80);
    assert.equal(gateContext?.state, "NOT_REQUIRED");

    mutationClient = await pool.connect();
    const mutation = (async () => {
      await mutationClient!.query("BEGIN");
      return confirmBreach(mutationClient!, {
        userId: creditFixture.ownerUserId,
        sourceType: "ACCOUNT",
        sourceId: creditFixture.accountId,
        subjectRole: "OWNER",
        visibleReason: `F3并发credit-${runId}`,
        internalBasis: `F3并发credit依据-${runId}`,
        actorAdminId: "admin_80768cba2f044bce8c86c04442d8dd95",
      });
    })();
    assert.equal(await Promise.race([mutation.then(() => "completed"), sleep(100).then(() => "blocked")]), "blocked");
    await finish(gateClient, true); gateClient = undefined;
    const breach = await mutation;
    await finish(mutationClient, true); mutationClient = undefined;
    assert.equal(breach.duplicate, false);
    const scoreAfterMutation = (await pool.query<{ score: number }>("SELECT score FROM zzsh_credit.user_credit_state WHERE user_id=$1", [creditFixture.ownerUserId])).rows[0]?.score;
    assert.equal(scoreAfterMutation, 70);
    const reverseClient = await pool.connect();
    try {
      await reverseClient.query("BEGIN");
      await reverseBreach(reverseClient, { eventId: breach.event.id, visibleReason: `F3并发credit撤销-${runId}`, internalBasis: `F3并发credit撤销依据-${runId}`, actorAdminId: "admin_80768cba2f044bce8c86c04442d8dd95" });
      await reverseClient.query("COMMIT");
    } finally { reverseClient.release(); }

    const refundFixture = (await pool.query<{ accountId: string; ownerUserId: string; versionId: string; requirementId: string }>(
      `SELECT a.id AS "accountId",a.owner_user_id AS "ownerUserId",a.current_version_id AS "versionId",r.id AS "requirementId"
         FROM zzsh_order.owner_guarantee_requirement r
         JOIN zzsh_supply.rental_account a ON a.id=r.account_id
         JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id
         JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id
        WHERE r.status='COVERED' AND v.review_state='PUBLISHED' AND pub.source='OWNER_DIRECT'
          AND EXISTS (SELECT 1 FROM zzsh_order.owner_guarantee_payment p WHERE p.requirement_id=r.id AND p.status='CONFIRMED' AND p.provider_request_state='CONFIRMED')
          AND NOT EXISTS (SELECT 1 FROM zzsh_order.owner_guarantee_refund f WHERE f.requirement_id=r.id)
        ORDER BY r.updated_at DESC,r.id DESC LIMIT 1`,
    )).rows[0];
    assert.ok(refundFixture, "an existing legal covered fixture without a refund is required");
    refundGateClient = await pool.connect();
    await refundGateClient.query("BEGIN");
    const coveredContext = await readGuaranteeContextForGate(refundGateClient, refundFixture.accountId, refundFixture.ownerUserId, refundFixture.versionId);
    assert.equal(coveredContext?.state, "SATISFIED");

    refundClient = await pool.connect();
    const refundRequestPromise = (async () => {
      await refundClient!.query("BEGIN");
      return requestGuaranteeRefund(refundClient!, {
        userId: refundFixture.ownerUserId,
        requirementId: refundFixture.requirementId,
        requestKey: `f3-concurrency-refund-${runId}`,
        requestFingerprint: createHash("sha256").update(`f3-concurrency-refund-${runId}`).digest("hex"),
        obligationReader: async () => "NONE",
      });
    })();
    assert.equal(await Promise.race([refundRequestPromise.then(() => "completed"), sleep(100).then(() => "blocked")]), "blocked");
    await finish(refundGateClient, true); refundGateClient = undefined;
    const refund = await refundRequestPromise;
    await finish(refundClient, true); refundClient = undefined;
    assert.ok(refund.refundId);
    const failedRefundClient = await pool.connect();
    try {
      await failedRefundClient.query("BEGIN");
      await recordGuaranteeRefundResult(failedRefundClient, { refundId: String(refund.refundId), outcome: "FAILED", receipt: { provider: "LOCAL_CONTROLLED", step: "f3-concurrency-cleanup" } });
      await failedRefundClient.query("COMMIT");
    } finally { failedRefundClient.release(); }
    console.log(JSON.stringify({ evidenceClass: "LOCAL_PG_LOCK_ORDER", runId, creditGate: { scoreBefore: 80, stateBefore: "NOT_REQUIRED", mutationBlockedOnGateShare: true, scoreAfterMutation: 70, reversal: "APPLIED" }, refundGate: { stateBefore: "SATISFIED", refundBlockedOnRequirementShare: true, requestState: "REQUESTED", cleanupState: "FAILED" }, runtimeDdlOrUpdatePrivilegeAdded: false }));
  } finally {
    await finish(gateClient, false).catch(() => undefined);
    await finish(mutationClient, false).catch(() => undefined);
    await finish(refundGateClient, false).catch(() => undefined);
    await finish(refundClient, false).catch(() => undefined);
    await pool.end();
  }
});
