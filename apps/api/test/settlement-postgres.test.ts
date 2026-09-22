// TR-B3A: real PostgreSQL, cookie sessions, and controlled payment. No browser page run.
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import type { Pool } from "pg";

import { withTransaction } from "../src/auth/security-core";
import { dispatchPaidOrders } from "../src/im/order-dispatch";
import { advanceOrderTeam, type OrderTeamOptions } from "../src/im/order-team";
import { ImIdentityProvisioner, type ImIdentityKey } from "../src/im/identity-lifecycle";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";
import { confirmOrderPayment, createControlledPaymentSource, type PaymentInput } from "../src/order/payment-confirmation";
import { issuePersonalConfirmation, type ConfirmationFunding } from "../src/order/personal-confirmation";
import { createPersonalReservation } from "../src/order/personal-order";
import { computeSyntheticFullPayout, settlementSurfaceOpen } from "../src/order/settlement-record";
import { readOrderOccupancy } from "../src/order/order";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { seedIdentity } from "./im-test-fixtures";
import { OrderTeamTransport, fakeIdentityAccounts } from "./order-team-fixtures";
import type { runPaymentAcceptance } from "./order-payment-im-postgres.test";

type Base = Parameters<typeof runPaymentAcceptance>[1];
type Jar = { header: () => string; update: (response: Response) => void };
type Staff = { id: string; username: string; jar: Jar };
type RequestFn = (base: string, path: string, body: Record<string, unknown> | undefined, jar: { header: () => string; update: (response: Response) => void }, origin: string, method?: string, headers?: Record<string, string>) => Promise<{ response: Response; body: Record<string, any> | null }>;
const USER_ORIGIN = "http://127.0.0.1:3100";
const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const FUNDING: ConfirmationFunding = {
  version: "fixture:v1", sourceRef: "fixture:isolated-authority", baseDepositCents: "30000", publisherBailRequirementCents: "0",
  fullPayoutSelected: false, fullPayoutPolicyRef: "fixture:none", fullPayoutFeeCents: "0", vipWaiver: false, svipWaiver: false,
};

function hasKeyDeep(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return true;
  return Object.values(value).some((entry) => hasKeyDeep(entry, key));
}

function assertNoSettlementInternals(value: unknown): void {
  for (const field of [
    "platformContribution", "platformContributionCents", "platformHaffSpread", "platformItemSpread", "platformMakeup", "platformFee",
    "ledgerEntries", "accountCode", "debitCents", "creditCents", "counterpartyUserId", "sourcePaymentConfirmationId",
    "fundingSourceRef", "fundingPolicyRef", "paymentConfirmationId", "approvalRequestId", "approval", "requestedBy",
    "approvedBy", "approvalPayloadHash", "approvalExpiresAt",
  ]) assert.equal(hasKeyDeep(value, field), false, `settlement response exposed ${field}`);
}

async function withPostingInsertBarrier<T>(
  pool: Pool,
  action: () => Promise<T>,
  duringInsert: (client: import("pg").PoolClient, postingId: string) => Promise<void>,
): Promise<T> {
  const originalConnect = pool.connect;
  let resolveReached!: (postingId: string) => void;
  let rejectReached!: (error: unknown) => void;
  let armed = true;
  const reached = new Promise<string>((resolve, reject) => { resolveReached = resolve; rejectReached = reject; });
  const watchdog = setTimeout(() => rejectReached(new Error("settlement posting insert barrier was not reached")), 15_000);
  (pool as any).connect = (...args: unknown[]) => {
    if (args.length > 0) return (originalConnect as any).apply(pool, args);
    return (originalConnect as any).call(pool).then((client: import("pg").PoolClient) => new Proxy(client, {
      get(target, property) {
        if (property === "query") return async (...queryArgs: any[]) => {
          const result = await (target.query as any)(...queryArgs);
          const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
          if (armed && typeof sql === "string" && sql.includes("INSERT INTO zzsh_order.settlement_posting (")) {
            armed = false;
            const postingId = String(queryArgs[1]?.[0]);
            try {
              await duringInsert(target, postingId);
              resolveReached(postingId);
            } catch (error) {
              rejectReached(error);
              throw error;
            }
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
  };
  const pending = action();
  void pending.then(() => { if (armed) rejectReached(new Error("settlement action finished before posting insert")); }, rejectReached);
  try {
    await reached;
    return await pending;
  } finally {
    clearTimeout(watchdog);
    (pool as any).connect = originalConnect;
  }
}

export async function runSettlementAcceptance(t: TestContext, o: Base & {
  base: string; buyer: Jar; buyerEmail: string; owner: Jar; boss: Staff; createStaff: (name: string, permissions: string[]) => Promise<Staff>;
  publishApproved: (owner: any, label: string, depositCents: string | null, includeSettlementPiece?: boolean) => Promise<{ accountId: string; versionId: string; releaseId: string }>;
  request: any; runtimeUser: string; staged: boolean; upgrade: () => Promise<void>;
}): Promise<void> {
  const { pool, migrationPool, ownerPool } = o;
  assert.equal(settlementSurfaceOpen(true), true);
  assert.equal(settlementSurfaceOpen(false), false);
  assert.throws(() => computeSyntheticFullPayout("FORMAL_ORDER", { orderId: "x" } as never), /SYNTHETIC_FULL_PAYOUT/);
  assert.equal(computeSyntheticFullPayout("SYNTHETIC_FULL_PAYOUT", { orderId: "synthetic" } as never).ok, false);
  const key = () => ({ "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}` });
  const post = (path: string, body: Record<string, unknown> | undefined, jar: Jar, origin = USER_ORIGIN, headers?: Record<string, string>, method?: string): Promise<{ response: Response; body: Record<string, any> | null }> =>
    o.request(o.base, path, body, jar, origin, method ?? (body === undefined ? "GET" : "POST"), headers ?? (body === undefined ? {} : key()));
  const migrations = async () => (await migrationPool.query(`SELECT hash, created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
  const before = await migrations();
  const retained = (await pool.query(`SELECT o.id, o.status, o.quote_snapshot, o.paid_confirmation_id, p.amount_cents::text AS amount, p.disposition
    FROM zzsh_order.rental_order o JOIN zzsh_order.payment_confirmation p ON p.id = o.paid_confirmation_id
    WHERE o.status = 'PAID' ORDER BY o.created_at LIMIT 1`)).rows[0];
  assert.ok(retained, "a controlled PAID order must already exist before 0046");
  if (o.staged) {
    assert.equal(before.length, 46, "staged run keeps the 0-45 baseline until retained facts exist");
    await o.upgrade();
  }
  await o.upgrade();
  const migrationFileHash = (tag: string) => createHash("sha256").update(readFileSync(resolve(__dirname, "../../migrations/business", `${tag}.sql`))).digest("hex");
  const after = await migrations();
  assert.equal(after.length, 50);
  assert.equal(after[46]!.hash, migrationFileHash("0046_order_settlement_confirmation"));
  assert.equal(after[46]!.created_at, "1789490015000");
  assert.equal(after[47]!.hash, migrationFileHash("0047_order_settlement_intake"));
  assert.equal(after[47]!.created_at, "1789490016000");
  assert.equal(after[48]!.hash, migrationFileHash("0048_order_settlement_posting"));
  assert.equal(after[48]!.created_at, "1789490017000");
  assert.equal(after[49]!.hash, migrationFileHash("0049_order_settlement_posting_guards"));
  assert.equal(after[49]!.created_at, "1789490018000");
  if (o.staged) assert.notDeepEqual(before, after);
  const retainedAfter = (await pool.query(`SELECT o.id, o.status, o.quote_snapshot, o.paid_confirmation_id, p.amount_cents::text AS amount, p.disposition
    FROM zzsh_order.rental_order o JOIN zzsh_order.payment_confirmation p ON p.id = o.paid_confirmation_id WHERE o.id = $1`, [retained.id])).rows[0];
  assert.deepEqual(retainedAfter, retained);
  const privileges = (await pool.query(`SELECT
    has_table_privilege(current_user, 'zzsh_order.settlement_decision', 'DELETE') AS "deleteDecision",
    has_table_privilege(current_user, 'zzsh_order.settlement_version', 'UPDATE') AS "updateVersion",
    has_column_privilege(current_user, 'zzsh_order.settlement_version', 'superseded_at', 'UPDATE') AS "supersede",
    has_column_privilege(current_user, 'zzsh_order.rental_opening', 'lines', 'UPDATE') AS "rewriteLines",
    has_column_privilege(current_user, 'zzsh_order.rental_opening', 'status', 'UPDATE') AS "confirmOpening"`)).rows[0];
  assert.deepEqual(privileges, { deleteDecision: false, updateVersion: false, supersede: true, rewriteLines: false, confirmOpening: true });
  const intakePrivileges = (await pool.query(`SELECT
    has_column_privilege(current_user, 'zzsh_order.settlement_intake', 'lines', 'UPDATE') AS "rewriteIntake",
    has_column_privilege(current_user, 'zzsh_order.settlement_intake', 'status', 'UPDATE') AS "classifyIntake"`)).rows[0];
  assert.deepEqual(intakePrivileges, { rewriteIntake: false, classifyIntake: true });

  const run = randomUUID().replaceAll("-", "").slice(0, 8);
  const appId = `settle_${run}`;
  const staff = await o.createStaff("结算负责客服", ["im.support.read", "im.support.accept", "im.support.presence", "order.settlement.write", "approval.request.create", "supply.quote.internal.read"]);
  const collaborator = await o.createStaff("结算协作客服", ["im.support.read", "order.settlement.write"]);
  const reader = await o.createStaff("结算只读客服", ["im.support.read", "order.read"]);
  const outsider = await o.createStaff("无群结算客服", ["im.support.read", "order.settlement.write"]);
  const ops = await o.createStaff("结算运营", ["approval.request.approve", "approval.request.read", "approval.request.execute"]);
  assert.equal((await post("/api/v1/admin/security/approvals/templates/update", {
    operationCode: "order.settlement.adjust", triggerCondition: "manual-net", candidateUsernames: [ops.username, staff.username],
  }, o.boss.jar, ADMIN_ORIGIN, key())).response.status, 200);
  const gate = async () => ({ publisherBail: "SATISFIED" as const, occupancy: "FREE" as const, reference: "fixture:order-bail" });
  const confirmationKey = { keyId: "trb2test", secret: randomBytes(32).toString("hex") };
  const buyer = (await pool.query<{ id: string; sessionId: string }>(
    `SELECT u.id, s.id AS "sessionId" FROM zzsh_auth_user."user" u JOIN zzsh_auth_user."session" s ON s."userId" = u.id
      WHERE u.email = $1 ORDER BY s."createdAt" DESC LIMIT 1`, [o.buyerEmail])).rows[0]!;
  const membershipPath = `/api/bff/admin/users/${buyer.id}/rental-membership`;
  const membership = await post(membershipPath, undefined, o.boss.jar, ADMIN_ORIGIN, {}, "GET");
  assert.equal(membership.response.status, 200, JSON.stringify(membership.body));
  assert.equal((await post(membershipPath, {
    tier: "STANDARD", expectedVersion: membership.body!.membership.version, sourceRef: "fixture:trb2", reason: "isolated settlement membership",
  }, o.boss.jar, ADMIN_ORIGIN, key(), "PUT")).response.status, 200);
  const makePaid = async (label: string) => {
    const account = await o.publishApproved(o.owner, label, "30000", true);
    const context = { userId: buyer.id, sessionId: buyer.sessionId };
    const options = { key: confirmationKey, gate, fundingReader: async () => FUNDING, holdSeconds: 3600 };
    const issued = await withTransaction(pool, (client) => issuePersonalConfirmation(client, context, account, options));
    const created = await withTransaction(pool, (client) => createPersonalReservation(client, context, issued.confirmationToken, options, `req_${randomUUID()}`));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const orderId = (created.body as { order: { id: string } }).order.id;
    const row = (await pool.query(`SELECT display_no, (rental_amount_cents + deposit_amount_cents)::text AS total FROM zzsh_order.rental_order WHERE id = $1`, [orderId])).rows[0];
    const input: PaymentInput = { orderId, merchantOrderNo: row.display_no, providerTransactionId: `tx_${randomUUID()}`, amountCents: row.total, currency: "CNY", providerPaidAt: new Date().toISOString(), requestId: `req_${randomUUID()}` };
    const fact = createControlledPaymentSource({ config: o.config, resourceSet: o.resourceSet, appId, merchantScopeId: "settle-merchant", allowedOrderIds: [orderId] })(input);
    assert.equal((await withTransaction(pool, (client) => confirmOrderPayment(client, fact))).disposition, "APPLIED");
    return orderId;
  };
  const teamWire = new OrderTeamTransport();
  const teamIdentities = new ImIdentityProvisioner(new YunxinIdentityRepository(pool), fakeIdentityAccounts().api);
  const joinTeam = async (orderId: string) => {
    await dispatchPaidOrders(pool, appId);
    const options: OrderTeamOptions = { pool, appId, provider: teamWire.client, identities: teamIdentities, membersLimit: 200 };
    const teamRow = async () => (await pool.query(`SELECT g.team_state, g.team_failure, op.state, op.failure_class, op.candidate_team_id
      FROM zzsh_order.im_order_group g LEFT JOIN zzsh_order.im_order_operation op ON op.order_id = g.order_id AND op.kind = 'CREATE'
      WHERE g.order_id = $1`, [orderId])).rows[0];
    await advanceOrderTeam(options, orderId);
    if ((await teamRow()).team_state !== "READY") {
      await pool.query(`UPDATE zzsh_iam.im_identity_mapping SET next_retry_at = clock_timestamp() WHERE app_id = $1 AND status = 'PENDING'`, [appId]);
      await advanceOrderTeam(options, orderId);
    }
    const team = await teamRow();
    assert.equal(team.team_state, "READY", JSON.stringify(team));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.rental_opening WHERE order_id = $1`, [orderId])).rows[0].n, 0, "PAID and team creation do not open a rental");
  };
  const addMember = async (orderId: string, adminId: string) => {
    const key: ImIdentityKey = { provider: "yunxin", appId, realm: "admin", kind: "ADMIN", platformSubjectId: adminId };
    if (!(await pool.query(`SELECT 1 FROM zzsh_iam.im_identity_mapping WHERE app_id = $1 AND platform_subject_id = $2 AND identity_kind = 'ADMIN'`, [appId, adminId])).rowCount) {
      await seedIdentity(pool, key, run);
    }
    const mapping = (await pool.query(`SELECT id FROM zzsh_iam.im_identity_mapping WHERE app_id = $1 AND platform_subject_id = $2 AND identity_kind = 'ADMIN'`, [appId, adminId])).rows[0];
    await pool.query(`INSERT INTO zzsh_order.im_order_member(order_id, app_id, identity_id, party, state, joined_at) VALUES ($1,$2,$3,'STAFF','JOINED',clock_timestamp()) ON CONFLICT DO NOTHING`, [orderId, appId, mapping.id]);
  };
  const quoteLines = async (orderId: string) => (await pool.query<{ lines: Array<{ itemId: string; quantity: string }> }>(
    `SELECT quote_snapshot->'lines' AS lines FROM zzsh_order.rental_order WHERE id = $1`, [orderId])).rows[0]!.lines;
  const openingBody = async (orderId: string) => ({ lines: (await quoteLines(orderId)).map((line) => ({ itemId: line.itemId, quantity: line.quantity })) });
  const remainingBody = async (orderId: string, remaining: string) => ({ lines: (await quoteLines(orderId)).map((line) => ({ itemId: line.itemId, remainingQuantity: remaining })) });
  const waiters = async () => Number((await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n);
  const holdOrder = async (orderId: string, start: Array<Promise<unknown>>) => {
    const client = await ownerPool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT id FROM zzsh_order.rental_order WHERE id = $1 FOR UPDATE`, [orderId]);
      const pending = Promise.all(start);
      const requiredWaiters = start.length;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && await waiters() < requiredWaiters) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(await waiters() >= requiredWaiters, "all competing writes must wait on the order lock");
      await client.query("COMMIT");
      committed = true;
      return await pending;
    } finally {
      if (!committed) await client.query("ROLLBACK");
      client.release();
    }
  };

  const gameId = (await pool.query(`SELECT id FROM zzsh_supply.game LIMIT 1`)).rows[0].id;
  for (const adminId of [staff.id, collaborator.id, reader.id, outsider.id]) {
    await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id, game_id, granted_by_admin_id) VALUES ($1,$2,$3) ON CONFLICT (admin_user_id, game_id) DO NOTHING`, [adminId, gameId, o.boss.id]);
  }
  await seedIdentity(pool, { provider: "yunxin", appId, realm: "admin", kind: "ADMIN", platformSubjectId: staff.id }, run);
  await pool.query(`INSERT INTO zzsh_iam.im_support_presence(app_id, admin_user_id, availability, connection_state, last_connected_at) VALUES ($1,$2,'AVAILABLE','CONNECTED',clock_timestamp())`, [appId, staff.id]);

  const successAudits = async (orderId: string, action: string) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = $2 AND outcome = 'SUCCESS'`,
    [orderId, action],
  )).rows[0].n);
  const settlementState = async (orderId: string) => (await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.settlement_intake WHERE order_id = $1) AS intakes,
    (SELECT count(*)::int FROM zzsh_order.settlement_version WHERE order_id = $1) AS versions,
    (SELECT count(*)::int FROM zzsh_order.settlement_decision d JOIN zzsh_order.settlement_version v ON v.id = d.settlement_version_id WHERE v.order_id = $1) AS decisions,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id = $1 AND action LIKE 'order.settlement.%' AND outcome = 'SUCCESS') AS "settlementAudits",
    (SELECT count(*)::int FROM zzsh_iam.approval_request WHERE operation_code = 'order.settlement.adjust') AS "adjustmentApprovals",
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE action = 'approval.request.created' AND details->>'operationCode' = 'order.settlement.adjust' AND outcome = 'SUCCESS') AS "adjustmentAudits",
    (SELECT count(*)::int FROM zzsh_order.settlement_posting WHERE order_id = $1) AS postings,
    (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry e JOIN zzsh_order.settlement_posting p ON p.id = e.posting_id WHERE p.order_id = $1) AS ledgerEntries`, [orderId])).rows[0];
  const normalId = await makePaid("结算正常");
  await joinTeam(normalId);
  const actorGate = await ownerPool.connect();
  let actorGateOpen = false;
  try {
    await actorGate.query("BEGIN");
    await actorGate.query(`SELECT admin_user_id FROM zzsh_iam.admin_security WHERE admin_user_id = $1 FOR UPDATE`, [staff.id]);
    const pendingReview = post(`/api/v1/admin/orders/${normalId}/settlements/settle_missing/review`, { versionHash: "ab".repeat(32) }, staff.jar, ADMIN_ORIGIN, key());
    const actorDeadline = Date.now() + 5_000;
    while (Date.now() < actorDeadline && await waiters() < 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(await waiters() >= 1, "staff review must wait on the admin lock before party user locks");
    await actorGate.query(`SELECT id FROM zzsh_auth_user."user" WHERE id = $1 FOR UPDATE`, [buyer.id]);
    await actorGate.query("COMMIT");
    actorGateOpen = true;
    assert.equal((await pendingReview).response.status, 409);
  } finally {
    if (!actorGateOpen) await actorGate.query("ROLLBACK");
    actorGate.release();
  }
  await addMember(normalId, collaborator.id);
  await addMember(normalId, reader.id);
  const lines = await openingBody(normalId);
  const hidden = process.env.ZZSH_SETTLEMENT_RECORDING;
  delete process.env.ZZSH_SETTLEMENT_RECORDING;
  assert.equal((await post(`/api/v1/admin/orders/${normalId}/openings`, lines, staff.jar, ADMIN_ORIGIN, key())).response.status, 404);
  process.env.ZZSH_SETTLEMENT_RECORDING = hidden;

  assert.equal((await post(`/api/v1/admin/orders/${normalId}/openings`, { lines: lines.lines.map((line) => ({ ...line, quantity: "1" })) }, staff.jar, ADMIN_ORIGIN, key())).body?.reasons?.[0], "OPENING_QUANTITY_MISMATCH");
  assert.equal((await post(`/api/v1/admin/orders/${normalId}/openings`, lines, outsider.jar, ADMIN_ORIGIN, key())).response.status, 403);
  assert.equal((await post(`/api/v1/admin/orders/${normalId}/openings`, lines, reader.jar, ADMIN_ORIGIN, key())).response.status, 403);
  assert.equal((await post(`/api/v1/admin/orders/${normalId}/settlement`, undefined, reader.jar, ADMIN_ORIGIN)).response.status, 200);
  const stranger: Jar = (() => {
    const values = new Map<string, string>();
    return {
      header: () => [...values].map(([name, value]) => `${name}=${value}`).join("; "),
      update(response) {
        for (const raw of response.headers.getSetCookie()) {
          const [pair, ...attributes] = raw.split(";");
          const separator = pair?.indexOf("=") ?? -1;
          if (!pair || separator < 1) continue;
          const name = pair.slice(0, separator).trim();
          if (attributes.some((attribute) => attribute.trim().toLowerCase() === "max-age=0")) values.delete(name);
          else values.set(name, pair.slice(separator + 1).trim());
        }
      },
    };
  })();
  const signed = await o.request(o.base, "/api/auth/user/sign-up/email", { email: `settle-${run}@example.invalid`, password: "Sup3rSecret#Order", name: "无关用户", username: `settle_${run}` }, stranger, USER_ORIGIN, "POST");
  assert.equal(signed.response.status, 200, JSON.stringify(signed.body));
  const unrelated = await post(`/api/v1/orders/${normalId}/settlement`, undefined, stranger);
  assert.equal(unrelated.response.status, 404, JSON.stringify(unrelated.body));

  const first = await post(`/api/v1/admin/orders/${normalId}/openings`, lines, collaborator.jar, ADMIN_ORIGIN, key());
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  const second = await post(`/api/v1/admin/orders/${normalId}/openings`, lines, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(second.response.status, 200, JSON.stringify(second.body));
  const seen = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer);
  const openings = seen.body!.openings as Array<{ id: string; versionNo: number; quoteDigest: string; paymentDigest: string; lines: Array<{ itemId: string; quantity: string; unit: string; pricingKind: string }> }>;
  const stale = openings.find((row) => row.versionNo === 1)!;
  const current = openings.find((row) => row.versionNo === 2)!;
  assert.equal(current.lines.length, lines.lines.length);
  assert.ok(current.lines.every((line) => line.quantity.length > 0 && line.unit.length > 0 && line.pricingKind.length > 0));
  assert.match(current.quoteDigest, /^[0-9a-f]{64}$/);
  assert.match(current.paymentDigest, /^[0-9a-f]{64}$/);
  const sameKey = key();
  const replay = await Promise.all([
    post(`/api/v1/orders/${normalId}/openings/${current.id}/confirm`, { versionNo: 2 }, o.buyer, USER_ORIGIN, sameKey),
    post(`/api/v1/orders/${normalId}/openings/${current.id}/confirm`, { versionNo: 2 }, o.buyer, USER_ORIGIN, sameKey),
  ]);
  assert.equal(replay[0]!.response.status, 200);
  assert.deepEqual(replay[0]!.body, replay[1]!.body);
  assert.equal((await post(`/api/v1/orders/${normalId}/openings/${current.id}/confirm`, { versionNo: 1 }, o.buyer, USER_ORIGIN, sameKey)).body?.error?.code, "IDEMPOTENCY_KEY_REUSED");
  const concurrentOpen = await holdOrder(normalId, [
    post(`/api/v1/orders/${normalId}/openings/${current.id}/confirm`, { versionNo: 2 }, o.owner, USER_ORIGIN, key()),
    post(`/api/v1/orders/${normalId}/openings/${stale.id}/confirm`, { versionNo: 1 }, o.owner, USER_ORIGIN, key()),
  ]);
  assert.equal((concurrentOpen as Array<{ response: { status: number }; body: any }>).filter((row) => row.response.status === 200).length, 1);
  const opened = (await pool.query(`SELECT status, confirmed_at IS NOT NULL AS confirmed FROM zzsh_order.rental_opening WHERE order_id = $1 AND status = 'CONFIRMED'`, [normalId])).rows;
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.confirmed, true);
  assert.equal((await post(`/api/v1/orders/${normalId}/openings/${stale.id}/confirm`, { versionNo: 1 }, o.buyer, USER_ORIGIN, key())).body?.reasons?.[0], "STALE_OPENING");

  const remain = await remainingBody(normalId, "0");
  const preview = await post(`/api/v1/orders/${normalId}/settlement-preview`, remain, o.buyer);
  assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body!.postingAuthorized, false);
  assert.equal(preview.body!.feeDeducted, false);
  assert.equal(preview.body!.early, false);
  assertNoSettlementInternals(preview.body);
  assert.equal(typeof preview.body!.amounts.haffConsumedBuyer, "string");
  assert.equal(typeof preview.body!.amounts.renterRefund, "string");
  const submittedKeys = [key(), key()];
  const submittedPair = await holdOrder(normalId, [
    post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, submittedKeys[0]),
    post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, submittedKeys[1]),
  ]) as Array<{ response: { status: number }; body: any }>;
  const submitted = submittedPair.find((row) => row.response.status === 200);
  assert.ok(submitted, JSON.stringify(submittedPair.map((row) => row.body)));
  const winKey = submittedKeys[submittedPair.findIndex((row) => row.response.status === 200)]!;
  assert.equal(submittedPair.filter((row) => row.response.status === 409).length, 1);
  assert.equal(submittedPair.find((row) => row.response.status === 409)!.body.reasons[0], "SETTLEMENT_HASH_MISMATCH");
  assert.deepEqual((await post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, winKey)).body, submitted.body);
  assert.equal(submitted.body!.ready, false);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_version WHERE order_id = $1 AND superseded_at IS NULL`, [normalId])).rows[0].n, 1);
  const versionId = submitted.body!.settlement.id as string;
  const again = await post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: "0".repeat(64) }, o.buyer, USER_ORIGIN, key());
  assert.equal(again.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
  const noOwnerConfirm = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.owner);
  assert.equal(noOwnerConfirm.body!.ready, false);
  assert.ok(noOwnerConfirm.body!.reasons.includes("OWNER_CONFIRMATION_MISSING"));
  assert.equal((await pool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [normalId])).rows[0].status, "PAID");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.approval_execution e JOIN zzsh_iam.approval_request r ON r.id = e.request_id WHERE r.operation_code = 'order.settlement.adjust'`)).rows[0].n, 0);
  const covered = await post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: preview.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  assert.equal(covered.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
  const afterStalePreview = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer);
  assert.equal(afterStalePreview.body!.ready, false);
  assert.ok(afterStalePreview.body!.reasons.includes("OWNER_CONFIRMATION_MISSING"));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_version WHERE order_id = $1`, [normalId])).rows[0].n, 1);
  const fresh = await post(`/api/v1/orders/${normalId}/settlement-preview`, remain, o.buyer);
  assert.notEqual(fresh.body!.versionHash, preview.body!.versionHash);
  const renewed = await post(`/api/v1/orders/${normalId}/settlements`, { ...remain, acceptedHash: fresh.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  assert.equal(renewed.response.status, 200, JSON.stringify(renewed.body));
  assert.notEqual(renewed.body!.settlement.versionHash, preview.body!.versionHash);
  const rejected = await post(`/api/v1/orders/${normalId}/settlements/${renewed.body!.settlement.id}/decision`, { action: "REJECT", versionHash: renewed.body!.settlement.versionHash, reason: "数量有误" }, o.owner, USER_ORIGIN, key());
  assert.equal(rejected.response.status, 200, JSON.stringify(rejected.body));
  const traced = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.owner);
  const tracedVersions = traced.body!.versions as Array<{ versionNo: number; supersededAt: string | null; decisions: Array<{ action: string }> }>;
  assert.ok(tracedVersions.some((row) => row.versionNo === 1 && row.supersededAt));
  assert.ok(tracedVersions.some((row) => row.decisions.some((decision) => decision.action === "REJECT")));

  const earlyId = await makePaid("结算提前");
  await joinTeam(earlyId);
  await addMember(earlyId, collaborator.id);
  await addMember(earlyId, reader.id);
  const earlyLines = await openingBody(earlyId);
  assert.equal((await post(`/api/v1/admin/orders/${earlyId}/openings`, earlyLines, staff.jar, ADMIN_ORIGIN, key())).response.status, 200);
  const earlySeen = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.owner);
  const earlyOpening = (earlySeen.body!.openings as Array<{ id: string; versionNo: number; lines: Array<{ itemId: string; quantity: string; pricingKind: string }> }>).find((row) => row.versionNo === 1)!;
  await post(`/api/v1/orders/${earlyId}/openings/${earlyOpening.id}/confirm`, { versionNo: earlyOpening.versionNo }, o.buyer, USER_ORIGIN, key());
  await post(`/api/v1/orders/${earlyId}/openings/${earlyOpening.id}/confirm`, { versionNo: earlyOpening.versionNo }, o.owner, USER_ORIGIN, key());
  const earlyRemain = { lines: earlyOpening.lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.quantity })) };
  const haffLine = earlyOpening.lines.find((line) => line.pricingKind === "HAFF_RATIO");
  assert.ok(haffLine);
  assert.ok(BigInt(haffLine.quantity) > 1n);
  const normalRemain = { lines: earlyOpening.lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.itemId === haffLine.itemId ? "0" : line.quantity })) };
  const normalPreviewBeforeIntake = await post(`/api/v1/orders/${earlyId}/settlement-preview`, normalRemain, o.buyer);
  assert.equal(normalPreviewBeforeIntake.body!.early, false);
  assertNoSettlementInternals(normalPreviewBeforeIntake.body);
  const earlyPreview = await post(`/api/v1/orders/${earlyId}/settlement-preview`, earlyRemain, o.owner);
  assert.equal(earlyPreview.body!.reasons?.[0], "EARLY_REASON_REQUIRED");
  assert.match(earlyPreview.body!.versionHash, /^[0-9a-f]{64}$/);
  assertNoSettlementInternals(earlyPreview.body);
  const oldStaffPreview = await post(`/api/v1/admin/orders/${earlyId}/settlement-preview`, { ...earlyRemain, endReason: "TENANT_VOLUNTARY_EARLY" }, staff.jar, ADMIN_ORIGIN);
  assert.equal(oldStaffPreview.response.status, 200, JSON.stringify(oldStaffPreview.body));
  const intakeRequests = [
    { party: "RENTER" as const, jar: o.buyer, requestKey: key() },
    { party: "OWNER" as const, jar: o.owner, requestKey: key() },
  ];
  const competingIntakes = await holdOrder(earlyId, intakeRequests.map(({ jar, requestKey }) =>
    post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: earlyPreview.body!.versionHash }, jar, USER_ORIGIN, requestKey),
  )) as Array<{ response: Response; body: Record<string, any> }>;
  assert.equal(competingIntakes.filter((row) => row.response.status === 200).length, 1);
  assert.equal(competingIntakes.filter((row) => row.response.status === 409).length, 1);
  assert.equal(competingIntakes.find((row) => row.response.status === 409)!.body.reasons[0], "SETTLEMENT_HASH_MISMATCH");
  const intakeWinnerIndex = competingIntakes.findIndex((row) => row.response.status === 200);
  const winningRequest = intakeRequests[intakeWinnerIndex]!;
  const intakeKey = winningRequest.requestKey;
  const intake = competingIntakes[intakeWinnerIndex]!;
  assert.equal(intake.response.status, 200, JSON.stringify(intake.body));
  assert.equal(intake.body!.settlement, null);
  assert.equal(intake.body!.ready, false);
  assert.deepEqual(intake.body!.currentRequest, { kind: "INTAKE", id: intake.body!.intakes.at(-1).id, versionNo: 1, status: "OPEN" });
  assert.equal(intake.body!.intakes.at(-1).status, "OPEN");
  assert.equal(intake.body!.intakes.at(-1).initiatorParty, winningRequest.party);
  const stableEarlyRemain = earlyRemain.lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.remainingQuantity })).sort((a, b) => a.itemId.localeCompare(b.itemId));
  assert.deepEqual(intake.body!.intakes.at(-1).lines, stableEarlyRemain);
  const stateWithOpenIntake = await settlementState(earlyId);
  assert.deepEqual(stateWithOpenIntake, { intakes: 1, versions: 0, decisions: 0, settlementAudits: 1, adjustmentApprovals: 0, adjustmentAudits: 0, postings: 0, ledgerentries: 0 });
  const staleParty = await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: earlyPreview.body!.versionHash }, o.owner, USER_ORIGIN, key());
  const staleNormal = await post(`/api/v1/orders/${earlyId}/settlements`, { ...normalRemain, acceptedHash: normalPreviewBeforeIntake.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  const staleStaff = await post(`/api/v1/admin/orders/${earlyId}/settlements/classify`, { ...earlyRemain, endReason: "TENANT_VOLUNTARY_EARLY", acceptedHash: oldStaffPreview.body!.versionHash }, staff.jar, ADMIN_ORIGIN, key());
  for (const stale of [staleParty, staleNormal, staleStaff]) {
    assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
  }
  assert.deepEqual(await settlementState(earlyId), stateWithOpenIntake);
  assert.deepEqual((await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: earlyPreview.body!.versionHash }, winningRequest.jar, USER_ORIGIN, intakeKey)).body, intake.body);
  const differentBody = { ...earlyRemain, lines: earlyRemain.lines.map((line, index) => index === 0 ? { ...line, remainingQuantity: line.remainingQuantity === "0" ? "1" : "0" } : line) };
  assert.equal((await post(`/api/v1/orders/${earlyId}/settlements`, { ...differentBody, acceptedHash: earlyPreview.body!.versionHash }, winningRequest.jar, USER_ORIGIN, intakeKey)).body!.error.code, "IDEMPOTENCY_KEY_REUSED");

  const sameQuantityPreview = await post(`/api/v1/orders/${earlyId}/settlement-preview`, earlyRemain, o.owner);
  assert.notEqual(sameQuantityPreview.body!.versionHash, earlyPreview.body!.versionHash);
  const replacement = await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: sameQuantityPreview.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.body));
  assert.equal(replacement.body!.intakes[0].status, "SUPERSEDED");
  assert.equal(replacement.body!.intakes[1].status, "OPEN");
  assert.equal(replacement.body!.intakes[0].lines[0].remainingQuantity, replacement.body!.intakes[1].lines[0].remainingQuantity);
  const replacementState = await settlementState(earlyId);
  const staleAba = await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: sameQuantityPreview.body!.versionHash }, o.owner, USER_ORIGIN, key());
  assert.equal(staleAba.response.status, 409);
  assert.deepEqual(await settlementState(earlyId), replacementState);
  assert.deepEqual((await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: earlyPreview.body!.versionHash }, winningRequest.jar, USER_ORIGIN, intakeKey)).body, intake.body);

  const modifiedQuantity = (BigInt(haffLine.quantity) - 1n).toString();
  const modifiedRemain = { lines: earlyRemain.lines.map((line) => ({ ...line, remainingQuantity: line.itemId === haffLine.itemId ? modifiedQuantity : line.remainingQuantity })) };
  const fixedOpeningLine = earlyOpening.lines.find((line) => line.pricingKind === "FIXED_UNIT")!;
  const partialItemRemaining = (BigInt(fixedOpeningLine.quantity) / 2n).toString();
  assert.ok(BigInt(partialItemRemaining) > 0n && BigInt(partialItemRemaining) < BigInt(fixedOpeningLine.quantity));
  const partialRemain = { lines: modifiedRemain.lines.map((line) => ({
    ...line,
    remainingQuantity: line.itemId === fixedOpeningLine.itemId ? partialItemRemaining : line.remainingQuantity,
  })) };
  const staffPreview = await post(`/api/v1/admin/orders/${earlyId}/settlement-preview`, { ...modifiedRemain, endReason: "TENANT_VOLUNTARY_EARLY" }, staff.jar, ADMIN_ORIGIN);
  assert.equal(staffPreview.response.status, 200, JSON.stringify(staffPreview.body));
  const joinedPreview = await post(`/api/v1/admin/orders/${earlyId}/settlement-preview`, { ...modifiedRemain, endReason: "TENANT_VOLUNTARY_EARLY" }, collaborator.jar, ADMIN_ORIGIN);
  assert.equal(joinedPreview.response.status, 200, JSON.stringify(joinedPreview.body));
  assertNoSettlementInternals(joinedPreview.body);
  assert.ok(joinedPreview.body!.amounts.haffConsumedBuyer);
  const classified = await post(`/api/v1/admin/orders/${earlyId}/settlements/classify`, { ...modifiedRemain, endReason: "TENANT_VOLUNTARY_EARLY", acceptedHash: staffPreview.body!.versionHash }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(classified.response.status, 200, JSON.stringify(classified.body));
  const earlyVersion = classified.body!.settlement.id as string;
  const earlyHash = classified.body!.settlement.versionHash as string;
  const classifiedIntake = classified.body!.intakes[1];
  assert.equal(classifiedIntake.status, "CLASSIFIED");
  assert.equal(classifiedIntake.settlementVersionId, earlyVersion);
  assert.deepEqual(classified.body!.currentRequest, { kind: "SETTLEMENT_VERSION", id: earlyVersion, versionNo: 1 });
  const settlementSnapshot = (await pool.query(`SELECT input_snapshot AS snapshot FROM zzsh_order.settlement_version WHERE id = $1`, [earlyVersion])).rows[0].snapshot;
  assert.deepEqual(settlementSnapshot.baseIntake, { id: classifiedIntake.id, versionNo: classifiedIntake.versionNo, status: "OPEN", settlementVersionId: null });
  assert.equal(settlementSnapshot.lines.find((line: any) => line.itemId === haffLine.itemId).remainingQuantity, modifiedQuantity);
  const classificationAudit = (await pool.query(`SELECT details FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.settlement.submitted' AND outcome = 'SUCCESS' ORDER BY occurred_at DESC LIMIT 1`, [earlyId])).rows[0].details;
  assert.equal(classificationAudit.intakeId, classifiedIntake.id);
  assert.equal(classificationAudit.intakeQuantityModified, true);
  assert.deepEqual(classificationAudit.intakeSourceLines, classifiedIntake.lines);
  assert.deepEqual(classificationAudit.classifiedLines, stableEarlyRemain.map((line) => ({ ...line, remainingQuantity: line.itemId === haffLine.itemId ? modifiedQuantity : line.remainingQuantity })));
  const stateAfterClassify = await settlementState(earlyId);
  const staleClassify = await post(`/api/v1/admin/orders/${earlyId}/settlements/classify`, { ...modifiedRemain, endReason: "TENANT_VOLUNTARY_EARLY", acceptedHash: staffPreview.body!.versionHash }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(staleClassify.response.status, 409);
  assert.deepEqual(await settlementState(earlyId), stateAfterClassify);
  const reviewsBefore = await successAudits(earlyId, "order.settlement.reviewed");
  const prematureReview = await post(`/api/v1/admin/orders/${earlyId}/settlements/${earlyVersion}/review`, { versionHash: earlyHash }, collaborator.jar, ADMIN_ORIGIN, key());
  assert.equal(prematureReview.body!.reasons?.[0], "PARTY_CONFIRMATION_MISSING");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND action = 'REVIEW'`, [earlyVersion])).rows[0].n, 0);
  assert.equal(await successAudits(earlyId, "order.settlement.reviewed"), reviewsBefore);
  const both = await holdOrder(earlyId, [
    post(`/api/v1/orders/${earlyId}/settlements/${earlyVersion}/decision`, { action: "CONFIRM", versionHash: earlyHash }, o.buyer, USER_ORIGIN, key()),
    post(`/api/v1/orders/${earlyId}/settlements/${earlyVersion}/decision`, { action: "CONFIRM", versionHash: earlyHash }, o.owner, USER_ORIGIN, key()),
  ]);
  for (const row of both as Array<{ response: { status: number }; body: any }>) assert.equal(row.response.status, 200, JSON.stringify(row.body));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_version WHERE order_id = $1 AND superseded_at IS NULL`, [earlyId])).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND action = 'CONFIRM'`, [earlyVersion])).rows[0].n, 2);
  const beforeReview = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.buyer);
  assert.equal(beforeReview.body!.ready, false);
  assert.ok(beforeReview.body!.reasons.includes("SUPPORT_REVIEW_MISSING"));
  const stateBeforePendingIntake = await settlementState(earlyId);
  const nextIntakePreview = await post(`/api/v1/orders/${earlyId}/settlement-preview`, earlyRemain, o.owner);
  assert.equal(nextIntakePreview.body!.reasons?.[0], "EARLY_REASON_REQUIRED");
  const pendingIntake = await post(`/api/v1/orders/${earlyId}/settlements`, { ...earlyRemain, acceptedHash: nextIntakePreview.body!.versionHash }, o.owner, USER_ORIGIN, key());
  assert.equal(pendingIntake.response.status, 200, JSON.stringify(pendingIntake.body));
  assert.equal(pendingIntake.body!.ready, false);
  assert.ok(pendingIntake.body!.reasons.includes("SETTLEMENT_INTAKE_PENDING"));
  assert.equal(pendingIntake.body!.settlement, null);
  assert.deepEqual(pendingIntake.body!.currentRequest, {
    kind: "INTAKE", id: pendingIntake.body!.intakes.at(-1).id, versionNo: 3, status: "OPEN",
  });
  assert.equal(pendingIntake.body!.orderStatus, "PAID");
  assert.equal(pendingIntake.body!.posting, null);
  assert.equal(pendingIntake.body!.postingAuthorized, false);
  assert.equal(pendingIntake.body!.feeDeducted, false);
  const retainedReadyVersion = pendingIntake.body!.versions.find((version: any) => version.id === earlyVersion);
  assert.equal(retainedReadyVersion.supersededAt, null);
  assert.equal(retainedReadyVersion.decisions.length, 2);
  const stateAfterPendingIntake = await settlementState(earlyId);
  assert.equal(stateAfterPendingIntake.versions, stateBeforePendingIntake.versions);
  assert.equal(stateAfterPendingIntake.decisions, stateBeforePendingIntake.decisions);
  assert.equal(stateAfterPendingIntake.intakes, stateBeforePendingIntake.intakes + 1);
  const blockedReview = await post(`/api/v1/admin/orders/${earlyId}/settlements/${earlyVersion}/review`, { versionHash: earlyHash }, collaborator.jar, ADMIN_ORIGIN, key());
  assert.equal(blockedReview.response.status, 409);
  assert.equal(blockedReview.body!.reasons?.[0], "SETTLEMENT_INTAKE_PENDING");
  assert.deepEqual(await settlementState(earlyId), stateAfterPendingIntake);

  const reclassPreview = await post(`/api/v1/admin/orders/${earlyId}/settlement-preview`, {
    ...partialRemain, endReason: "TENANT_VOLUNTARY_EARLY",
  }, staff.jar, ADMIN_ORIGIN);
  const reclassified = await post(`/api/v1/admin/orders/${earlyId}/settlements/classify`, {
    ...partialRemain, endReason: "TENANT_VOLUNTARY_EARLY", acceptedHash: reclassPreview.body!.versionHash,
  }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(reclassified.response.status, 200, JSON.stringify(reclassified.body));
  const postingVersion = reclassified.body!.settlement.id as string;
  const postingHash = reclassified.body!.settlement.versionHash as string;
  assert.equal(reclassified.body!.settlement.versionNo, 2);
  assert.equal(reclassified.body!.intakes.at(-1).status, "CLASSIFIED");
  assert.equal(reclassified.body!.intakes.at(-1).settlementVersionId, postingVersion);
  assert.ok((await pool.query(`SELECT superseded_at FROM zzsh_order.settlement_version WHERE id = $1`, [earlyVersion])).rows[0].superseded_at);
  const staleReview = await post(`/api/v1/admin/orders/${earlyId}/settlements/${earlyVersion}/review`, { versionHash: earlyHash }, collaborator.jar, ADMIN_ORIGIN, key());
  assert.equal(staleReview.response.status, 409);
  assert.equal(staleReview.body!.reasons?.[0], "STALE_VERSION");
  const postedConfirms = await holdOrder(earlyId, [
    post(`/api/v1/orders/${earlyId}/settlements/${postingVersion}/decision`, { action: "CONFIRM", versionHash: postingHash }, o.buyer, USER_ORIGIN, key()),
    post(`/api/v1/orders/${earlyId}/settlements/${postingVersion}/decision`, { action: "CONFIRM", versionHash: postingHash }, o.owner, USER_ORIGIN, key()),
  ]);
  for (const row of postedConfirms as Array<{ response: { status: number }; body: any }>) assert.equal(row.response.status, 200, JSON.stringify(row.body));
  const afterBothPostedConfirms = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.buyer);
  assert.equal(afterBothPostedConfirms.body!.ready, false);
  assert.ok(afterBothPostedConfirms.body!.reasons.includes("SUPPORT_REVIEW_MISSING"));
  assert.equal(afterBothPostedConfirms.body!.posting, null);
  const reviewStateBeforeFailure = await settlementState(earlyId);
  assert.ok(/^[a-z][a-z0-9_]*$/.test(o.runtimeUser));
  const reviewKey = key();
  await migrationPool.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.runtimeUser}"`);
  const rolledBackReview = await post(`/api/v1/admin/orders/${earlyId}/settlements/${postingVersion}/review`, { versionHash: postingHash }, collaborator.jar, ADMIN_ORIGIN, reviewKey);
  assert.equal(rolledBackReview.response.status, 500);
  assert.deepEqual(await settlementState(earlyId), reviewStateBeforeFailure);
  await migrationPool.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.runtimeUser}"`);
  const reviewed = await post(`/api/v1/admin/orders/${earlyId}/settlements/${postingVersion}/review`, { versionHash: postingHash }, staff.jar, ADMIN_ORIGIN, reviewKey);
  assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body!.ready, true);
  assert.equal(reviewed.body!.orderStatus, "COMPLETED");
  assert.equal(reviewed.body!.postingAuthorized, true);
  assert.equal(reviewed.body!.feeDeducted, false);
  assert.equal(reviewed.body!.posting.early, true);
  assert.ok(BigInt(String(reviewed.body!.posting.amounts.unusedItemRefund).replace(".", "")) > 0n);
  assert.equal((await pool.query(`SELECT extract(epoch FROM (refund_due_at - posted_at))::int AS seconds FROM zzsh_order.settlement_posting WHERE order_id = $1`, [earlyId])).rows[0].seconds, 604800);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1 AND account_code = 'OWNER_AVAILABLE' AND credit_cents > 0`, [reviewed.body!.posting.id])).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_posting WHERE order_id = $1`, [earlyId])).rows[0].n, 1);
  assert.ok(reviewed.body!.posting.ledgerEntries.length > 0);
  assert.equal(typeof reviewed.body!.posting.platformContributionCents, "string");
  assert.equal(reviewed.body!.versions.find((version: any) => version.id === postingVersion).inputSnapshot.fundingSourceRef, FUNDING.sourceRef);
  const internalRead = await post(`/api/v1/admin/orders/${earlyId}/settlement`, undefined, staff.jar, ADMIN_ORIGIN);
  assert.equal(internalRead.response.status, 200);
  assert.ok(internalRead.body!.posting.ledgerEntries.length > 0);
  assert.equal(typeof internalRead.body!.posting.platformContributionCents, "string");
  const privilegedReceiptCounts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.settlement_posting WHERE order_id = $1) AS postings,
    (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $2) AS entries,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.settlement.posted' AND outcome = 'SUCCESS') AS "postedAudits"`, [earlyId, reviewed.body!.posting.id])).rows[0];
  await pool.query(`DELETE FROM zzsh_iam.admin_user_permission WHERE admin_user_id = $1 AND permission_code = 'supply.quote.internal.read'`, [staff.id]);
  const revokedReplay = await post(`/api/v1/admin/orders/${earlyId}/settlements/${postingVersion}/review`, { versionHash: postingHash }, staff.jar, ADMIN_ORIGIN, reviewKey);
  assert.equal(revokedReplay.response.status, 200, JSON.stringify(revokedReplay.body));
  assertNoSettlementInternals(revokedReplay.body);
  assert.deepEqual((await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.settlement_posting WHERE order_id = $1) AS postings,
    (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $2) AS entries,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.settlement.posted' AND outcome = 'SUCCESS') AS "postedAudits"`, [earlyId, reviewed.body!.posting.id])).rows[0], privilegedReceiptCounts);
  const readerView = await post(`/api/v1/admin/orders/${earlyId}/settlement`, undefined, reader.jar, ADMIN_ORIGIN);
  assert.equal(readerView.response.status, 200, JSON.stringify(readerView.body));
  assertNoSettlementInternals(readerView.body);
  assert.equal(typeof readerView.body!.posting.owner.availableCents, "string");
  assert.ok(readerView.body!.versions.some((version: any) => version.inputSnapshot.amounts.renterRefund));
  const buyerView = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.buyer);
  const ownerView = await post(`/api/v1/orders/${earlyId}/settlement`, undefined, o.owner);
  assert.equal(buyerView.response.status, 200);
  assert.equal(ownerView.response.status, 200);
  for (const partyView of [buyerView, ownerView]) {
    assertNoSettlementInternals(partyView.body);
    assert.equal(typeof partyView.body!.posting.owner.availableCents, "string");
    assert.equal(typeof partyView.body!.posting.refund.payableCents, "string");
    assert.ok(partyView.body!.versions.some((version: any) => version.computation.amounts.haffConsumedBuyer));
  }

  const adjustPreview = await post(`/api/v1/admin/orders/${normalId}/settlement-preview`, {
    ...remain, proposedOwnerNet: "1.00", proposedRenterRefund: "1.00", reason: "人工核对差额",
  }, staff.jar, ADMIN_ORIGIN);
  assert.equal(adjustPreview.response.status, 200, JSON.stringify(adjustPreview.body));
  const earlyApplication = { lines: lines.lines.map((line) => ({ itemId: line.itemId, remainingQuantity: line.quantity })) };
  const earlyApplicationPreview = await post(`/api/v1/orders/${normalId}/settlement-preview`, earlyApplication, o.buyer);
  assert.equal(earlyApplicationPreview.body!.reasons?.[0], "EARLY_REASON_REQUIRED");
  const earlyApplicationResult = await post(`/api/v1/orders/${normalId}/settlements`, { ...earlyApplication, acceptedHash: earlyApplicationPreview.body!.versionHash }, o.buyer, USER_ORIGIN, key());
  assert.equal(earlyApplicationResult.response.status, 200, JSON.stringify(earlyApplicationResult.body));
  const adjustmentBaseline = await settlementState(normalId);
  const staleAdjustment = await post(`/api/v1/admin/orders/${normalId}/settlements/adjustments`, {
    ...remain, proposedOwnerNet: "1.00", proposedRenterRefund: "1.00", reason: "人工核对差额", acceptedHash: adjustPreview.body!.versionHash,
  }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(staleAdjustment.response.status, 409);
  assert.equal(staleAdjustment.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
  assert.deepEqual(await settlementState(normalId), adjustmentBaseline);
  const freshAdjustPreview = await post(`/api/v1/admin/orders/${normalId}/settlement-preview`, {
    ...remain, proposedOwnerNet: "1.00", proposedRenterRefund: "1.00", reason: "人工核对差额",
  }, staff.jar, ADMIN_ORIGIN);
  assert.notEqual(freshAdjustPreview.body!.versionHash, adjustPreview.body!.versionHash);
  const tooMuch = await post(`/api/v1/admin/orders/${normalId}/settlements/adjustments`, {
    ...remain, proposedOwnerNet: "999999.00", proposedRenterRefund: "999999.00", reason: "超出实收", acceptedHash: freshAdjustPreview.body!.versionHash,
  }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(tooMuch.body!.reasons?.[0], "FUNDING_SOURCE_REQUIRED");
  const adjusted = await post(`/api/v1/admin/orders/${normalId}/settlements/adjustments`, {
    ...remain, proposedOwnerNet: "1.00", proposedRenterRefund: "1.00", reason: "人工核对差额", acceptedHash: freshAdjustPreview.body!.versionHash,
  }, staff.jar, ADMIN_ORIGIN, key());
  assert.equal(adjusted.response.status, 200, JSON.stringify(adjusted.body));
  assert.equal(adjusted.body!.ready, false);
  assertNoSettlementInternals(adjusted.body);
  const adjustmentRecord = (await pool.query<{ approvalRequestId: string; inputSnapshot: Record<string, any> }>(
    `SELECT approval_request_id AS "approvalRequestId", input_snapshot AS "inputSnapshot"
       FROM zzsh_order.settlement_version WHERE id = $1`, [adjusted.body!.settlement.id],
  )).rows[0]!;
  assert.equal(adjustmentRecord.inputSnapshot.fundingSourceRef, "fixture:isolated-authority");
  const approvalId = adjustmentRecord.approvalRequestId;
  assert.equal(adjustmentRecord.inputSnapshot.baseIntake.id, earlyApplicationResult.body!.intakes.at(-1).id);
  assert.equal(adjusted.body!.intakes.at(-1).status, "CLASSIFIED");
  assert.equal(adjusted.body!.intakes.at(-1).settlementVersionId, adjusted.body!.settlement.id);
  const adjustmentAudit = (await pool.query(`SELECT details FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.settlement.adjusted' AND outcome = 'SUCCESS' ORDER BY occurred_at DESC LIMIT 1`, [normalId])).rows[0].details;
  assert.equal(adjustmentAudit.intakeId, earlyApplicationResult.body!.intakes.at(-1).id);
  assert.equal(adjustmentAudit.intakeQuantityModified, true);
  const adjustedHashEarly = adjusted.body!.settlement.versionHash as string;
  const adjustedIdEarly = adjusted.body!.settlement.id as string;
  const staleOldDecision = await post(`/api/v1/orders/${normalId}/settlements/${renewed.body!.settlement.id}/decision`, {
    action: "CONFIRM", versionHash: renewed.body!.settlement.versionHash,
  }, o.owner, USER_ORIGIN, key());
  assert.equal(staleOldDecision.response.status, 409);
  assert.equal(staleOldDecision.body!.reasons?.[0], "STALE_VERSION");
  await assert.rejects(pool.query(
    `INSERT INTO zzsh_order.settlement_decision(id, settlement_version_id, version_hash, basis_hash, party, action, subject_id)
     VALUES ($1,$2,$3,$3,'RENTER','CONFIRM',$4)`,
    [`sdec_${randomUUID().replaceAll("-", "")}`, renewed.body!.settlement.id, renewed.body!.settlement.versionHash, buyer.id],
  ), (error: { code?: string }) => error.code === "40001");
  const decidesBefore = await successAudits(normalId, "order.settlement.decided");
  const prematureKey = key();
  const prematureConfirm = await post(`/api/v1/orders/${normalId}/settlements/${adjustedIdEarly}/decision`, { action: "CONFIRM", versionHash: adjustedHashEarly }, o.buyer, USER_ORIGIN, prematureKey);
  assert.equal(prematureConfirm.body!.reasons?.[0], "OPS_APPROVAL_MISSING");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1`, [adjustedIdEarly])).rows[0].n, 0);
  assert.equal(await successAudits(normalId, "order.settlement.decided"), decidesBefore);
  assert.equal((await pool.query(`SELECT response_status AS status FROM zzsh_supply.idempotency_record WHERE key = $1`, [prematureKey["idempotency-key"]])).rows[0].status, 409);
  assert.equal((await post(`/api/v1/orders/${normalId}/settlements/${adjustedIdEarly}/decision`, { action: "CONFIRM", versionHash: adjustedHashEarly }, o.buyer, USER_ORIGIN, prematureKey)).body!.reasons?.[0], "OPS_APPROVAL_MISSING");
  assert.equal((await post("/api/v1/admin/security/approvals/requests/decision", { requestId: approvalId, decision: "APPROVE", reason: "自审" }, staff.jar, ADMIN_ORIGIN, key())).response.status, 403);
  assert.equal((await post("/api/v1/admin/security/approvals/requests/decision", { requestId: approvalId, decision: "APPROVE", reason: "同意净额" }, ops.jar, ADMIN_ORIGIN, key())).response.status, 200);
  assert.equal((await post("/api/v1/admin/security/approvals/requests/execute", { requestId: approvalId }, ops.jar, ADMIN_ORIGIN, key())).response.status, 409);
  assert.equal((await pool.query(`SELECT status FROM zzsh_iam.approval_request WHERE id = $1`, [approvalId])).rows[0].status, "APPROVED");
  const adjustedHash = adjusted.body!.settlement.versionHash as string;
  const adjustedId = adjusted.body!.settlement.id as string;
  await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, { action: "CONFIRM", versionHash: adjustedHash }, o.buyer, USER_ORIGIN, key());
  const manualConfirmKey = key();
  // Controlled expiry fixture: IAM status may remain APPROVED until its next action.
  const approvalDeadline = (await pool.query(`SELECT expires_at::text AS deadline FROM zzsh_iam.approval_request WHERE id = $1`, [approvalId])).rows[0].deadline;
  const beforeExpiryPreview = await post(`/api/v1/admin/orders/${normalId}/settlement-preview`, {
    ...remain, proposedOwnerNet: "2.00", proposedRenterRefund: "1.00", reason: "审批有效期回归",
  }, staff.jar, ADMIN_ORIGIN);
  assert.equal(beforeExpiryPreview.response.status, 200);
  const beforeExpiryState = await settlementState(normalId);
  await migrationPool.query(`UPDATE zzsh_iam.approval_request SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [approvalId]);
  try {
    const expiredView = await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer);
    assert.equal(expiredView.body!.ready, false);
    assert.ok(expiredView.body!.reasons.includes("OPS_APPROVAL_EXPIRED"));
    const expiredConfirmKey = key();
    const expiredConfirm = await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, { action: "CONFIRM", versionHash: adjustedHash }, o.owner, USER_ORIGIN, expiredConfirmKey);
    assert.equal(expiredConfirm.response.status, 409);
    assert.equal(expiredConfirm.body!.reasons?.[0], "OPS_APPROVAL_EXPIRED");
    const staleExpiryPreview = await post(`/api/v1/admin/orders/${normalId}/settlements/adjustments`, {
      ...remain, proposedOwnerNet: "2.00", proposedRenterRefund: "1.00", reason: "审批有效期回归", acceptedHash: beforeExpiryPreview.body!.versionHash,
    }, staff.jar, ADMIN_ORIGIN, key());
    assert.equal(staleExpiryPreview.response.status, 409);
    assert.equal(staleExpiryPreview.body!.reasons?.[0], "SETTLEMENT_HASH_MISMATCH");
    assert.deepEqual(await settlementState(normalId), beforeExpiryState);
    assert.equal((await pool.query(`SELECT status FROM zzsh_iam.approval_request WHERE id = $1`, [approvalId])).rows[0].status, "APPROVED");
  } finally {
    await migrationPool.query(`UPDATE zzsh_iam.approval_request SET expires_at = $2::timestamptz WHERE id = $1`, [approvalId, approvalDeadline]);
  }
  assert.equal((await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer)).body!.ready, false);
  const beforePostingState = await settlementState(normalId);
  await migrationPool.query(`REVOKE INSERT ON zzsh_order.settlement_ledger_entry FROM "${o.runtimeUser}"`);
  const failedPost = await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "CONFIRM", versionHash: adjustedHash,
  }, o.owner, USER_ORIGIN, manualConfirmKey);
  assert.equal(failedPost.response.status, 500);
  assert.deepEqual(await settlementState(normalId), beforePostingState);
  assert.equal((await pool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [normalId])).rows[0].status, "PAID");
  await migrationPool.query(`GRANT INSERT ON zzsh_order.settlement_ledger_entry TO "${o.runtimeUser}"`);
  const confirmManual = () => post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "CONFIRM", versionHash: adjustedHash,
  }, o.owner, USER_ORIGIN, manualConfirmKey);
  const insertRuntimeLines = async (client: import("pg").PoolClient, postingId: string, rows: Array<{
    lineNo: number; accountCode: string; debit: string; credit: string; counterparty?: string | null; source?: string | null; details?: Record<string, unknown>;
  }>) => {
    const values = rows.flatMap((row) => [
      `sledger_${randomUUID().replaceAll("-", "")}`, postingId, row.lineNo, row.accountCode, row.debit, row.credit,
      row.counterparty ?? null, row.source ?? null, JSON.stringify(row.details ?? {}),
    ]);
    const tuples = rows.map((_, index) => {
      const first = index * 9 + 1;
      return `($${first},$${first + 1},$${first + 2},$${first + 3},$${first + 4},$${first + 5},$${first + 6},$${first + 7},$${first + 8}::jsonb)`;
    });
    await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry
      (id,posting_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
      VALUES ${tuples.join(",")}`, values);
  };
  const assertAssemblyRejected = async (label: string, expectedCode: string,
    inject: (client: import("pg").PoolClient, postingId: string) => Promise<void>) => {
    let sqlState: string | undefined;
    const failed = await withPostingInsertBarrier(pool, confirmManual, async (client, postingId) => {
      try { await inject(client, postingId); } catch (error) { sqlState = (error as { code?: string }).code; }
    });
    assert.equal(sqlState, expectedCode, `${label} runtime insert SQLSTATE`);
    assert.equal(failed.response.status, 500, `${label} must abort the settlement transaction`);
    assert.deepEqual(await settlementState(normalId), beforePostingState, `${label} must leave no partial settlement effects`);
    assert.equal((await pool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [normalId])).rows[0].status, "PAID");
    console.log("settlement assembly negative", JSON.stringify({ label, sqlState, httpStatus: failed.response.status }));
  };
  const parties = (await pool.query<{ ownerUserId: string; renterUserId: string }>(
    `SELECT owner_user_id AS "ownerUserId", renter_user_id AS "renterUserId" FROM zzsh_order.rental_order WHERE id = $1`, [normalId],
  )).rows[0]!;
  await assertAssemblyRejected("owner counterparty mismatch", "23514", async (client, postingId) => {
    await insertRuntimeLines(client, postingId, [{ lineNo: 900, accountCode: "OWNER_AVAILABLE", debit: "0", credit: "1", counterparty: parties.renterUserId }]);
  });
  await assertAssemblyRejected("owner account debit direction", "23514", async (client, postingId) => {
    await insertRuntimeLines(client, postingId, [{ lineNo: 900, accountCode: "OWNER_AVAILABLE", debit: "1", credit: "0", counterparty: parties.ownerUserId }]);
  });
  const otherPaymentId = (await pool.query<{ paidConfirmationId: string }>(
    `SELECT paid_confirmation_id AS "paidConfirmationId" FROM zzsh_order.rental_order WHERE id = $1`, [earlyId],
  )).rows[0]!.paidConfirmationId;
  await assertAssemblyRejected("source payment belongs to another order", "23514", async (client, postingId) => {
    const batch = (await client.query<{ capturedCents: string }>(`SELECT captured_cents::text AS "capturedCents" FROM zzsh_order.settlement_posting WHERE id = $1`, [postingId])).rows[0]!;
    await insertRuntimeLines(client, postingId, [{ lineNo: 900, accountCode: "CAPTURED_PAYMENT_SOURCE", debit: batch.capturedCents, credit: "0", source: otherPaymentId }]);
  });
  const manualPosted = await withPostingInsertBarrier(pool, confirmManual, async (_client, postingId) => {
    const racingClient = await pool.connect();
    try {
      const raceOutcome = await racingClient.query(`INSERT INTO zzsh_order.settlement_ledger_entry
        (id,posting_id,line_no,account_code,debit_cents,credit_cents,details)
        VALUES ($1,$2,900,'PLATFORM_HAFF_SPREAD',0,1,'{}'::jsonb)`, [`sledger_${randomUUID().replaceAll("-", "")}`, postingId])
        .then(() => ({ inserted: true as const }), (error: { code?: string }) => ({ code: error.code, inserted: false as const }));
      assert.equal(raceOutcome.inserted, false);
      assert.equal(raceOutcome.code, "40001", "an append cannot see or join the uncommitted assembling batch");
    } finally {
      racingClient.release();
    }
  });
  assert.equal(manualPosted.response.status, 200, JSON.stringify(manualPosted.body));
  assert.equal(manualPosted.body!.ready, true);
  assert.equal(manualPosted.body!.orderStatus, "COMPLETED");
  assert.equal(manualPosted.body!.postingAuthorized, true);
  assert.equal(manualPosted.body!.posting.manualAdjustment.reason, "人工核对差额");
  assertNoSettlementInternals(manualPosted.body);
  assert.equal((await pool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [normalId])).rows[0].status, "COMPLETED");
  const normalDue = await pool.query(`SELECT posted_at = refund_due_at AS immediate, captured_cents::text AS captured,
      owner_net_cents::text AS owner, renter_refund_cents::text AS refund, platform_contribution_cents::text AS platform
    FROM zzsh_order.settlement_posting WHERE order_id = $1`, [normalId]);
  assert.equal(normalDue.rows[0]!.immediate, true);
  assert.equal(BigInt(normalDue.rows[0]!.captured), BigInt(normalDue.rows[0]!.owner) + BigInt(normalDue.rows[0]!.refund) + BigInt(normalDue.rows[0]!.platform));
  const batchBalance = await pool.query(`SELECT sum(debit_cents)::text AS debit, sum(credit_cents)::text AS credit
    FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1`, [manualPosted.body!.posting.id]);
  assert.equal(batchBalance.rows[0]!.debit, batchBalance.rows[0]!.credit);
  assert.equal((await pool.query(`SELECT sum(credit_cents)::text AS cents FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1 AND account_code = 'OWNER_AVAILABLE'`, [manualPosted.body!.posting.id])).rows[0]!.cents,
    manualPosted.body!.posting.owner.availableCents);
  assert.equal((await pool.query(`SELECT sum(credit_cents)::text AS cents FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1 AND account_code = 'RENTER_REFUND_PAYABLE'`, [manualPosted.body!.posting.id])).rows[0]!.cents,
    manualPosted.body!.posting.refund.payableCents);
  assert.equal(manualPosted.body!.posting.amounts.depositRefund, "300.00");
  assert.equal(manualPosted.body!.posting.amounts.unusedItemRefund, "0.00");
  assert.equal(manualPosted.body!.posting.amounts.unusedHaffRefund, "0.00");
  const sealedCounts = (await pool.query(`SELECT count(*)::int AS entries FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1`, [manualPosted.body!.posting.id])).rows[0];
  const assertSealedAppend = async (label: string, rows: Array<{
    lineNo: number; accountCode: string; debit: string; credit: string; counterparty?: string | null; source?: string | null;
  }>) => {
    const client = await pool.connect();
    let sqlState: string | undefined;
    try {
      await client.query("BEGIN");
      try {
        await insertRuntimeLines(client, manualPosted.body!.posting.id, rows);
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } catch (error) { sqlState = (error as { code?: string }).code; }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assert.equal(sqlState, "40001", `${label} append must fail at the database seal`);
    assert.equal((await pool.query(`SELECT count(*)::int AS entries FROM zzsh_order.settlement_ledger_entry WHERE posting_id = $1`, [manualPosted.body!.posting.id])).rows[0].entries, sealedCounts.entries);
    console.log("sealed posting append rejected", JSON.stringify({ label, sqlState }));
  };
  await assertSealedAppend("same-category balancing pair", [
    { lineNo: 900, accountCode: "PLATFORM_MANUAL_NET_ADJUSTMENT", debit: "0", credit: "100" },
    { lineNo: 901, accountCode: "PLATFORM_MANUAL_NET_ADJUSTMENT", debit: "100", credit: "0" },
  ]);
  await assertSealedAppend("cross-category balancing pair", [
    { lineNo: 900, accountCode: "PLATFORM_HAFF_SPREAD", debit: "0", credit: "100" },
    { lineNo: 901, accountCode: "PLATFORM_ITEM_SPREAD", debit: "100", credit: "0" },
  ]);
  await assertSealedAppend("owner and renter payable append", [
    { lineNo: 900, accountCode: "OWNER_AVAILABLE", debit: "0", credit: "1", counterparty: parties.ownerUserId },
    { lineNo: 901, accountCode: "RENTER_REFUND_PAYABLE", debit: "0", credit: "1", counterparty: parties.renterUserId },
  ]);
  assert.deepEqual((await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "CONFIRM", versionHash: adjustedHash,
  }, o.owner, USER_ORIGIN, manualConfirmKey)).body, manualPosted.body);
  const otherKeyDuplicate = await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "CONFIRM", versionHash: adjustedHash,
  }, o.owner, USER_ORIGIN, key());
  assert.equal(otherKeyDuplicate.response.status, 409);
  const bodyConflict = await post(`/api/v1/orders/${normalId}/settlements/${adjustedId}/decision`, {
    action: "REJECT", versionHash: adjustedHash, reason: "不同请求体",
  }, o.owner, USER_ORIGIN, manualConfirmKey);
  assert.equal(bodyConflict.response.status, 409);
  assert.equal(bodyConflict.body!.error.code, "IDEMPOTENCY_KEY_REUSED");
  await migrationPool.query(`UPDATE zzsh_iam.approval_request SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [approvalId]);
  try {
    assert.equal((await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer)).body!.ready, true);
    assert.equal((await post(`/api/v1/orders/${normalId}/settlement`, undefined, o.buyer)).body!.postingAuthorized, true);
  } finally {
    await migrationPool.query(`UPDATE zzsh_iam.approval_request SET expires_at = $2::timestamptz WHERE id = $1`, [approvalId, approvalDeadline]);
  }

  await pool.query(`UPDATE zzsh_iam.admin_security SET status = 'FROZEN' WHERE admin_user_id = $1`, [staff.id]);
  assert.equal((await post(`/api/v1/admin/orders/${earlyId}/settlement`, undefined, staff.jar, ADMIN_ORIGIN)).response.status, 401);
  await pool.query(`UPDATE zzsh_iam.admin_security SET status = 'ACTIVE' WHERE admin_user_id = $1`, [staff.id]);
  await pool.query(`UPDATE zzsh_auth_admin."session" SET "expiresAt" = clock_timestamp() - interval '1 minute' WHERE "userId" = $1`, [outsider.id]);
  assert.equal((await post(`/api/v1/admin/orders/${earlyId}/openings`, earlyLines, outsider.jar, ADMIN_ORIGIN, key())).response.status, 401);
  await pool.query(`DELETE FROM zzsh_iam.admin_user_permission WHERE admin_user_id = $1 AND permission_code = 'order.settlement.write'`, [collaborator.id]);
  assert.equal((await post(`/api/v1/admin/orders/${earlyId}/settlements/${earlyVersion}/review`, { versionHash: earlyHash }, collaborator.jar, ADMIN_ORIGIN, key())).response.status, 403);

  const concurrentPostId = await makePaid("正常结算并发过账");
  await joinTeam(concurrentPostId);
  await addMember(concurrentPostId, collaborator.id);
  const concurrentOpeningLines = await openingBody(concurrentPostId);
  assert.equal((await post(`/api/v1/admin/orders/${concurrentPostId}/openings`, concurrentOpeningLines, staff.jar, ADMIN_ORIGIN, key())).response.status, 200);
  const concurrentOpening = (await post(`/api/v1/orders/${concurrentPostId}/settlement`, undefined, o.buyer)).body!.openings[0];
  await post(`/api/v1/orders/${concurrentPostId}/openings/${concurrentOpening.id}/confirm`, { versionNo: concurrentOpening.versionNo }, o.buyer, USER_ORIGIN, key());
  await post(`/api/v1/orders/${concurrentPostId}/openings/${concurrentOpening.id}/confirm`, { versionNo: concurrentOpening.versionNo }, o.owner, USER_ORIGIN, key());
  const concurrentRemain = await remainingBody(concurrentPostId, "0");
  const concurrentPreview = await post(`/api/v1/orders/${concurrentPostId}/settlement-preview`, concurrentRemain, o.buyer);
  assert.equal(concurrentPreview.body!.early, false);
  const concurrentSubmission = await post(`/api/v1/orders/${concurrentPostId}/settlements`, {
    ...concurrentRemain, acceptedHash: concurrentPreview.body!.versionHash,
  }, o.buyer, USER_ORIGIN, key());
  assert.equal(concurrentSubmission.response.status, 200, JSON.stringify(concurrentSubmission.body));
  const concurrentVersionId = concurrentSubmission.body!.settlement.id as string;
  const concurrentVersionHash = concurrentSubmission.body!.settlement.versionHash as string;
  const competingConfirmKeys = [key(), key()];
  const competingConfirms = await holdOrder(concurrentPostId, competingConfirmKeys.map((requestKey) =>
    post(`/api/v1/orders/${concurrentPostId}/settlements/${concurrentVersionId}/decision`, {
      action: "CONFIRM", versionHash: concurrentVersionHash,
    }, o.owner, USER_ORIGIN, requestKey)));
  const competingRows = competingConfirms as Array<{ response: { status: number }; body: any }>;
  assert.equal(competingRows.filter((row) => row.response.status === 200).length, 1);
  assert.equal(competingRows.filter((row) => row.response.status === 409).length, 1);
  const winnerIndex = competingRows.findIndex((row) => row.response.status === 200);
  const winningConfirm = competingRows[winnerIndex]!;
  assert.equal(winningConfirm.body!.orderStatus, "COMPLETED");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_posting WHERE order_id = $1`, [concurrentPostId])).rows[0].n, 1);
  assert.deepEqual((await post(`/api/v1/orders/${concurrentPostId}/settlements/${concurrentVersionId}/decision`, {
    action: "CONFIRM", versionHash: concurrentVersionHash,
  }, o.owner, USER_ORIGIN, competingConfirmKeys[winnerIndex]!)).body, winningConfirm.body);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_decision WHERE settlement_version_id = $1 AND party = 'SUPPORT'`, [concurrentVersionId])).rows[0].n, 0);

  const unpostedId = await makePaid("结算未过账占用保留");
  const occupied = await pool.query<{ accountId: string }>(`SELECT account_id AS "accountId" FROM zzsh_order.rental_order WHERE id = $1`, [unpostedId]);
  const released = await pool.query<{ accountId: string }>(`SELECT account_id AS "accountId" FROM zzsh_order.rental_order WHERE id = $1`, [normalId]);
  assert.equal(await withTransaction(pool, (client) => readOrderOccupancy(client, occupied.rows[0]!.accountId)), true);
  assert.equal(await withTransaction(pool, (client) => readOrderOccupancy(client, released.rows[0]!.accountId)), false);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_posting WHERE order_id IN ($1,$2,$3)`, [normalId, earlyId, concurrentPostId])).rows[0].n, 3);
  assert.equal((await pool.query(`SELECT count(DISTINCT payment_confirmation_id)::int AS n FROM zzsh_order.settlement_posting WHERE order_id IN ($1,$2,$3)`, [normalId, earlyId, concurrentPostId])).rows[0].n, 3);
  const reconciliation = await pool.query(`WITH selected AS (
      SELECT p.id, p.captured_cents, p.owner_net_cents, p.renter_refund_cents, p.platform_contribution_cents, p.payment_confirmation_id,
        sum(e.debit_cents) AS debit, sum(e.credit_cents) AS credit,
        sum(e.credit_cents) FILTER (WHERE e.account_code = 'OWNER_AVAILABLE') AS owner_credits,
        sum(e.credit_cents) FILTER (WHERE e.account_code = 'RENTER_REFUND_PAYABLE') AS refund_credits,
        sum(e.credit_cents - e.debit_cents) FILTER (WHERE e.account_code LIKE 'PLATFORM_%') AS platform_net
      FROM zzsh_order.settlement_posting p JOIN zzsh_order.settlement_ledger_entry e ON e.posting_id = p.id
      WHERE p.order_id IN ($1,$2,$3) GROUP BY p.id
    ) SELECT count(*)::int AS batches,
      bool_and(captured_cents = owner_net_cents + renter_refund_cents + platform_contribution_cents) AS allocation_balanced,
      bool_and(debit = credit) AS ledger_balanced,
      bool_and(owner_credits = owner_net_cents AND refund_credits = renter_refund_cents AND platform_net = platform_contribution_cents) AS accounts_reconciled,
      count(DISTINCT payment_confirmation_id)::int AS unique_payments FROM selected`, [normalId, earlyId, concurrentPostId]);
  assert.deepEqual(reconciliation.rows[0], { batches: 3, allocation_balanced: true, ledger_balanced: true, accounts_reconciled: true, unique_payments: 3 });

  const counts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.rental_order) AS orders,
    (SELECT count(*)::int FROM zzsh_order.payment_confirmation) AS payments,
    (SELECT count(*)::int FROM zzsh_order.settlement_version) AS versions,
    (SELECT count(*)::int FROM zzsh_iam.audit_event) AS audits`)).rows[0];
  const migrationCount = (await migrationPool.query(`SELECT count(*)::int AS n FROM zzsh_business_meta.migrations`)).rows[0].n;
  console.log("trb3a pre-cleanup counts", JSON.stringify({ ...counts, migrations: migrationCount, migrationTail: after.at(-1), staged: o.staged }));
}
