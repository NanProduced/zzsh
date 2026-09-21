// OIM-4B acceptance: signed supplier event ingress, minimal approval/delivery facts,
// first-response reducer, unified authorization/conflict decision, DB binding guards and
// bounded recovery on real PostgreSQL. Runs serially inside the existing order suite and
// shares its registered resource, app, migration and cleanup.
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";

import { withTransaction } from "../src/auth/security-core";
import { confirmOrderPayment, createControlledPaymentSource } from "../src/order/payment-confirmation";
import { dispatchPaidOrders } from "../src/im/order-dispatch";
import { advanceOrderTeam } from "../src/im/order-team";
import { ImIdentityProvisioner, deriveYunxinAccountId, type ImIdentityKey } from "../src/im/identity-lifecycle";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";
import { BUSINESS_MIGRATIONS_FOLDER, runBusinessMigrations } from "../src/database/business-migrations";
import {
  buildStaffApprovalBasis, mountOrderImEventHandlers, OrderImEventRecoveryLifecycle, recoverOrderFirstResponse, readOrderTeamMessageFact,
} from "../src/im/order-im-events";
import { seedAdmin, seedIdentity, seedUser } from "./im-test-fixtures";
import { OrderTeamTransport, fakeIdentityAccounts } from "./order-team-fixtures";
import type { runPaymentAcceptance } from "./order-payment-im-postgres.test";

export const ORDER_IM_EVENT_APP = "oim4b_events_app";
export const ORDER_IM_EVENT_SECRET = "oim4b-synthetic-callback-secret";
const COPY_PATH = "/api/v1/im/order-events/copy";
const PRE_SEND_PATH = "/api/v1/im/order-events/pre-send";
const LEGACY_GROUP_COLUMNS = `order_id,app_id,payment_confirmation_id,provision_state,assigned_admin_id,assigned_at::text,wait_reason,
  team_state,system_identity_id,team_name,members_limit,team_id,team_ready_at::text,team_failure,team_retry_at::text,version,created_at::text`;

type Options = Parameters<typeof runPaymentAcceptance>[1];

/** Copy the migrations folder with the journal truncated to the given index (staged upgrade checks). */
export function preparePartialMigrationsFolder(upToIndex: number): string {
  const source = BUSINESS_MIGRATIONS_FOLDER;
  const target = mkdtempSync(join(tmpdir(), "zzsh-oim4b-migrations-"));
  mkdirSync(join(target, "meta"), { recursive: true });
  for (const file of readdirSync(source)) {
    if (file.endsWith(".sql")) cpSync(join(source, file), join(target, file));
  }
  const journal = JSON.parse(readFileSync(join(source, "meta", "_journal.json"), "utf8"));
  const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= upToIndex);
  writeFileSync(join(target, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }, null, 2));
  return target;
}

function signedRequest(path: string, body: Record<string, unknown>, options: {
  base: string; appKey?: string; appSecret?: string; nowMs?: number;
}): Promise<{ status: number; body: Record<string, any> | null }> {
  const raw = JSON.stringify(body);
  const md5 = createHash("md5").update(raw).digest("hex");
  const curTime = String(options.nowMs ?? Date.now());
  const checksum = createHash("sha1").update(`${options.appSecret ?? ORDER_IM_EVENT_SECRET}${md5}${curTime}`).digest("hex");
  return fetch(options.base + path, {
    method: "POST",
    headers: { "content-type": "application/json", appkey: options.appKey ?? ORDER_IM_EVENT_APP, curtime: curTime, md5, checksum },
    body: raw,
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null }));
}

export async function runOrderFirstResponseAcceptance(t: TestContext, o: Options, hooks: { base: string; baselineCount: number; upgrade: (upToIndex: number) => Promise<void> }): Promise<void> {
  const { pool, migrationPool, ownerPool, config } = o;
  if (!o.resourceSet) throw new Error("First-response acceptance requires ORDER_TEST_RESOURCE_SET");
  const run = randomUUID().replaceAll("-", "").slice(0, 8);
  const appId = ORDER_IM_EVENT_APP;
  const identityKey = (kind: "USER" | "ADMIN", id: string): ImIdentityKey => ({ provider: "yunxin", appId, realm: kind.toLowerCase(), kind, platformSubjectId: id });
  const staff = `oim4b_staff_${run}`;
  const stranger = `oim4b_stranger_${run}`;
  const consultAdmin = `oim4b_cadmin_${run}`;
  const consultUser = `oim4b_cuser_${run}`;
  const grantPermissions = async (adminId: string, permissions: string[]) => {
    for (const permission of permissions) {
      await pool.query(`INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES($1,$2,'ALLOW')`, [adminId, permission]);
    }
  };
  await seedAdmin(pool, staff, `${staff}_s`, run, false);
  await seedIdentity(pool, identityKey("ADMIN", staff), run);
  await grantPermissions(staff, ["im.support.read", "im.support.accept"]);
  await pool.query(`INSERT INTO zzsh_iam.im_support_presence(app_id,admin_user_id,availability,connection_state,last_connected_at) VALUES($1,$2,'OFF_DUTY','DISCONNECTED',NULL)`, [appId, staff]);
  await seedAdmin(pool, stranger, `${stranger}_s`, run, false);
  await grantPermissions(stranger, ["im.support.read", "im.support.accept"]);
  await seedAdmin(pool, consultAdmin, `${consultAdmin}_s`, run, false);
  await seedIdentity(pool, identityKey("ADMIN", consultAdmin), run);
  await grantPermissions(consultAdmin, ["im.support.read", "im.support.accept"]);
  await pool.query(`INSERT INTO zzsh_iam.im_support_presence(app_id,admin_user_id,availability,connection_state,last_connected_at) VALUES($1,$2,'AVAILABLE','CONNECTED',clock_timestamp())`, [appId, consultAdmin]);
  await seedUser(pool, consultUser, `${consultUser}_s`, run);
  await seedIdentity(pool, identityKey("USER", consultUser), run);

  const accounts = fakeIdentityAccounts();
  const identities = new ImIdentityProvisioner(new YunxinIdentityRepository(pool), accounts.api);
  const wire = new OrderTeamTransport();
  let gameId = "";
  const setStaffPresence = async (availability: "AVAILABLE" | "OFF_DUTY") => {
    await pool.query(`UPDATE zzsh_iam.im_support_presence SET availability=$3, connection_state=$4, last_connected_at=$5, version=version+1
      WHERE app_id=$1 AND admin_user_id=$2`, [appId, staff, availability, availability === "AVAILABLE" ? "CONNECTED" : "DISCONNECTED",
      availability === "AVAILABLE" ? new Date() : null]);
  };
  const pay = async (orderId: string) => {
    const row = (await pool.query(`SELECT * FROM zzsh_order.rental_order WHERE id=$1`, [orderId])).rows[0];
    const fact = createControlledPaymentSource({ config: o.config, resourceSet: o.resourceSet, appId, merchantScopeId: "oim4b_test", allowedOrderIds: [orderId] })({
      orderId, merchantOrderNo: row.display_no, providerTransactionId: `tx_${randomUUID()}`,
      amountCents: (BigInt(row.rental_amount_cents) + BigInt(row.deposit_amount_cents)).toString(), currency: "CNY",
      providerPaidAt: new Date().toISOString(), requestId: `req_${randomUUID()}`,
    });
    await withTransaction(pool, (client) => confirmOrderPayment(client, fact));
    return row;
  };
  const makePaid = async (label: string, mode: "inactive" | "active") => {
    const fixture = await o.fixture(label);
    const row = await pay(fixture.orderId);
    if (!gameId) {
      gameId = row.game_id;
      await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$1)`, [staff, gameId]);
    }
    await setStaffPresence("AVAILABLE");
    await dispatchPaidOrders(pool, appId);
    await setStaffPresence("OFF_DUTY");
    if (mode === "active") {
      await advanceOrderTeam({ pool, appId, provider: wire.client, identities, membersLimit: 200, firstResponseEnabled: true }, fixture.orderId);
    } else {
      // Historical path: no activation flag, so the new column is never referenced.
      await advanceOrderTeam({ pool, appId, provider: wire.client, identities, membersLimit: 200 }, fixture.orderId);
    }
    return { ...fixture, renter: row.renter_user_id as string, owner: row.owner_user_id as string };
  };
  const groupRow = async (orderId: string) => (await pool.query(`SELECT * FROM zzsh_order.im_order_group WHERE order_id=$1`, [orderId])).rows[0];
  const legacyGroupRow = async (orderId: string) => (await pool.query(`SELECT ${LEGACY_GROUP_COLUMNS} FROM zzsh_order.im_order_group WHERE order_id=$1`, [orderId])).rows[0];
  const eventRows = async (orderId: string) => (await pool.query(`SELECT id,type,status,event_key,message_server_id,message_client_id,sender_account_id,occurred_at::text,metadata
    FROM zzsh_order.im_order_event WHERE order_id=$1 ORDER BY recorded_at,id`, [orderId])).rows;
  const auditCount = async (action: string) => (await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action=$1`, [action])).rows[0].n;
  const staffAccount = deriveYunxinAccountId(identityKey("ADMIN", staff));
  const systemAccount = deriveYunxinAccountId({ provider: "yunxin", appId, realm: "system", kind: "SYSTEM", platformSubjectId: "support-manager" });
  const memberJoinedAt = async (orderId: string): Promise<Date> =>
    (await pool.query(`SELECT joined_at FROM zzsh_order.im_order_member WHERE order_id=$1 AND party='STAFF'`, [orderId])).rows[0].joined_at as Date;
  const staffBasis = async (orderId: string) =>
    buildStaffApprovalBasis({ platformSubjectId: staff, memberJoinedAt: await memberJoinedAt(orderId), scope: gameId });
  const insertApprovalRow = async (input: {
    orderId: string; teamId: string; clientId: string; occurredAt: Date; recordedAt?: Date; msgType?: string;
    status?: "VERIFIED" | "REJECTED"; basis?: unknown;
  }) => {
    await ownerPool.query(`INSERT INTO zzsh_order.im_order_event
      (id,order_id,app_id,team_id,event_key,type,status,actor,message_client_id,message_server_id,sender_account_id,message_type,occurred_at,recorded_at,raw_body_sha256,metadata)
      VALUES ($1,$2,$3,$4,$5,'send_approved',$6,$7,$8,NULL,$7,$9,$10,COALESCE($11,clock_timestamp()),$12,$13::jsonb)`, [
      `im_order_evt_${randomUUID().replaceAll("-", "")}`, input.orderId, appId, input.teamId,
      `send_approved:${input.teamId}:${staffAccount}:${input.clientId}`, input.status ?? "VERIFIED", staffAccount,
      input.clientId, input.msgType ?? "TEXT", input.occurredAt, input.recordedAt ?? null, "0".repeat(64),
      JSON.stringify({ reason: "SEEDED", basis: input.basis ?? null }),
    ]);
  };
  const insertPendingDelivery = async (input: { orderId: string; teamId: string; serverId: string; clientId: string | null; occurredAt: Date; status?: string; metadata?: unknown }) => {
    await ownerPool.query(`INSERT INTO zzsh_order.im_order_event
      (id,order_id,app_id,team_id,event_key,type,status,actor,message_client_id,message_server_id,sender_account_id,message_type,occurred_at,raw_body_sha256,metadata)
      VALUES ($1,$2,$3,$4,$5,'message_delivered',$6,$7,$8,$9,$7,'TEXT',$10,$11,$12::jsonb)`, [
      `im_order_evt_${randomUUID().replaceAll("-", "")}`, input.orderId, appId, input.teamId,
      `message_delivered:${input.teamId}:${input.serverId}`, input.status ?? "WAITING_AUTH", staffAccount, input.clientId,
      input.serverId, input.occurredAt, "0".repeat(64), JSON.stringify(input.metadata ?? { source: "WEB" }),
    ]);
  };
  const deliveryRow = async (orderId: string, serverId: string) => (await pool.query(
    `SELECT id,status,metadata,occurred_at::text AS occurred_at FROM zzsh_order.im_order_event WHERE order_id=$1 AND type='message_delivered' AND message_server_id=$2`,
    [orderId, serverId])).rows[0];
  const verifyMarkerCount = async (orderId: string) => (await pool.query(
    `SELECT count(*)::int AS n FROM zzsh_order.im_order_event WHERE order_id=$1 AND type='verify_required'`, [orderId])).rows[0].n;
  const confirmFirstResponse = async (orderId: string, teamId: string, serverId: string): Promise<Record<string, any>> => {
    const client = `confirm_${randomUUID()}`;
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount, { msgidClient: client }), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, serverId, teamId, { msgidClient: client }), { base: hooks.base })).status, 200);
    const group = await groupRow(orderId);
    assert.equal(group.first_response_state, "STOPPED", JSON.stringify(group));
    return group;
  };
  const expectRejectedSqlState = async (db: Pool, sql: string, params: unknown[], state: string) => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query(sql, params), (error: unknown) => (error as { code?: string }).code === state, `expected SQLSTATE ${state}`);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  };
  const copyBody = (accountId: string, serverId: string, teamId: string, extra: Record<string, unknown> = {}) => ({
    eventType: 1, convType: "TEAM", to: teamId, fromAccount: accountId, fromClientType: "WEB",
    msgType: "TEXT", msgTimestamp: String(Date.now()), msgidServer: serverId, msgidClient: `client_${serverId}`, resendFlag: "0",
    body: "must not be persisted", attach: "must not be persisted", ...extra,
  });
  const preSendBody = (teamId: string, accountId: string, extra: Record<string, unknown> = {}) => ({
    eventType: 2, to: teamId, fromAccount: accountId, fromClientType: "WEB", msgType: "TEXT",
    msgTimestamp: String(Date.now()), msgidClient: `pre_${randomUUID()}`, body: "must not be persisted", ...extra,
  });

  // ------------------------------------------------------------------ staged migrations
  const stagedLegacy = hooks.baselineCount <= 43;
  let legacySnapshot: { legacy: unknown; waiting: unknown; waitingOrderId: string } | undefined;
  if (stagedLegacy) {
    const legacy = await makePaid("OIM4B 升级前旧READY群", "inactive");
    const waitingFixture = await o.fixture("OIM4B 升级前WAITING单");
    await pay(waitingFixture.orderId);
    const snapshot = async (orderId: string) => ({
      group: await legacyGroupRow(orderId),
      operations: (await pool.query(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 ORDER BY id`, [orderId])).rows,
      members: (await pool.query(`SELECT * FROM zzsh_order.im_order_member WHERE order_id=$1 ORDER BY party`, [orderId])).rows,
    });
    legacySnapshot = { legacy: await snapshot(legacy.orderId), waiting: await snapshot(waitingFixture.orderId), waitingOrderId: waitingFixture.orderId };
    assert.equal((await groupRow(legacy.orderId)).team_state, "READY");
    assert.equal((await groupRow(waitingFixture.orderId)).provision_state, "WAITING");

    await t.test("T00a staged 0043 baseline keeps legacy facts and applies additively", async () => {
      assert.equal((await migrationPool.query(`SELECT count(*)::int AS n FROM zzsh_business_meta.migrations`)).rows[0].n, hooks.baselineCount);
      await hooks.upgrade(43);
      const after = (await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
      assert.equal(after.length, 44);
      const snapshot = async (orderId: string) => ({
        group: await legacyGroupRow(orderId),
        operations: (await pool.query(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 ORDER BY id`, [orderId])).rows,
        members: (await pool.query(`SELECT * FROM zzsh_order.im_order_member WHERE order_id=$1 ORDER BY party`, [orderId])).rows,
      });
      assert.deepEqual(await snapshot((legacySnapshot as any).legacy.group.order_id), (legacySnapshot as any).legacy);
      assert.deepEqual(await snapshot((legacySnapshot as any).waitingOrderId), (legacySnapshot as any).waiting);
      const old = await groupRow((legacySnapshot as any).legacy.group.order_id);
      assert.equal(old.first_response_state, "NOT_STARTED");
      assert.equal(old.first_response_event_id, null);
      assert.equal(old.first_response_at, null);
      assert.equal((await pool.query(`SELECT to_regclass('zzsh_order.im_order_event') AS relation`)).rows[0].relation, "zzsh_order.im_order_event");
      // A signed event for the inactive legacy group is ignored, not reduced.
      const ignored = await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143001", old.team_id), { base: hooks.base });
      assert.equal(ignored.status, 200);
      assert.equal((await eventRows(old.order_id)).length, 0);
      assert.equal((await groupRow(old.order_id)).first_response_state, "NOT_STARTED");
    });
  }

  await t.test("T00b staged 0044 adds the binding guards and both stages replay idempotently", async () => {
    const before = (await migrationPool.query(`SELECT count(*)::int AS n FROM zzsh_business_meta.migrations`)).rows[0].n as number;
    const staged0044 = before <= 44;
    if (staged0044) {
      assert.equal(before, hooks.baselineCount <= 43 ? 44 : hooks.baselineCount);
      await hooks.upgrade(44);
    } else {
      assert.equal(before, 45, "an already-migrated resource must be reused, never dropped");
    }
    const journal = JSON.parse(readFileSync(join(BUSINESS_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    const after = (await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
    assert.equal(after.length, 45);
    assert.equal(journal.entries.length, 45);
    assert.ok(after.every((row: { hash: string; created_at: string }, index: number) => {
      const entry = journal.entries[index];
      return row.created_at === String(entry.when) && row.hash === createHash("sha256").update(readFileSync(join(BUSINESS_MIGRATIONS_FOLDER, `${entry.tag}.sql`))).digest("hex");
    }));
    await runBusinessMigrations(migrationPool, { runtimeUser: config.database.user });
    assert.deepEqual((await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows, after);
    const triggers = (await migrationPool.query(`SELECT tgname FROM pg_trigger WHERE tgname IN ('im_order_event_guard','im_order_group_first_response_guard') ORDER BY tgname`)).rows.map((row: { tgname: string }) => row.tgname);
    assert.deepEqual(triggers, ["im_order_event_guard", "im_order_group_first_response_guard"]);
    console.log("order migration evidence", JSON.stringify({ baselineCount: hooks.baselineCount, staged0043: stagedLegacy, staged0044, reusedExisting: !staged0044, afterCount: after.length }));
  });

  // ------------------------------------------------------------------ ingress positives/negatives
  const order = await makePaid("OIM4B 首响主单", "active");
  const teamId = (await groupRow(order.orderId)).team_id as string;
  const buyerAccount = deriveYunxinAccountId({ provider: "yunxin", appId, realm: "user", kind: "USER", platformSubjectId: order.renter });
  const mainGroup = await groupRow(order.orderId);
  assert.equal(mainGroup.first_response_state, "RUNNING", JSON.stringify({ teamState: mainGroup.team_state, provision: mainGroup.provision_state,
    failure: mainGroup.team_failure, teamId: mainGroup.team_id, creates: wire.creates.length }));
  assert.equal((await pool.query(`SELECT availability FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`, [appId, staff])).rows[0].availability, "OFF_DUTY");

  await t.test("T01 pre-send authorizes order parties and JOINED staff without presence, denies strangers", async () => {
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, buyerAccount), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, deriveYunxinAccountId(identityKey("ADMIN", stranger))), { base: hooks.base })).body?.errCode, 1);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount), { base: hooks.base, appKey: "other-app" })).body?.errCode, 1);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody("999999999", staffAccount), { base: hooks.base })).body?.errCode, 1);
    const badSignature = await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount), { base: hooks.base, appSecret: "wrong-secret" });
    assert.equal(badSignature.body?.errCode, 1);
    assert.notEqual(badSignature.body?.responseCode, 200);
    await pool.query(`UPDATE zzsh_auth_admin."user" SET suspended=true WHERE id=$1`, [staff]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_auth_admin."user" SET suspended=false WHERE id=$1`, [staff]);
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`, [staff]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='ALLOW' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`, [staff]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount), { base: hooks.base })).body?.errCode, 0);
    // An unavailable order party is denied even though the account still maps and is a JOINED member.
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, buyerAccount), { base: hooks.base })).body?.errCode, 0);
    await pool.query(`UPDATE zzsh_auth_user."user" SET suspended=true WHERE id=$1`, [order.renter]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, buyerAccount), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_auth_user."user" SET suspended=false WHERE id=$1`, [order.renter]);
    await pool.query(`INSERT INTO zzsh_iam.user_identity_state(user_id,account_status,identity_status,age_status,provider,version,updated_at)
      VALUES($1,'DEACTIVATED','UNVERIFIED','UNKNOWN','none',1,clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE SET account_status='DEACTIVATED',version=zzsh_iam.user_identity_state.version+1,updated_at=clock_timestamp()`, [order.renter]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, buyerAccount), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_iam.user_identity_state SET account_status='ACTIVE',version=version+1,updated_at=clock_timestamp() WHERE user_id=$1`, [order.renter]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, buyerAccount), { base: hooks.base })).body?.errCode, 0);
    // NOT_STARTED disables first-response tracking only: legacy group chat keeps its original contract.
    const legacy = await makePaid("OIM4B 旧群聊天", "inactive");
    const legacyTeam = (await groupRow(legacy.orderId)).team_id as string;
    const legacyBuyer = deriveYunxinAccountId({ provider: "yunxin", appId, realm: "user", kind: "USER", platformSubjectId: legacy.renter });
    assert.equal((await groupRow(legacy.orderId)).first_response_state, "NOT_STARTED");
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(legacyTeam, staffAccount), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(legacyTeam, legacyBuyer), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await eventRows(legacy.orderId)).length, 0);
    assert.equal((await groupRow(legacy.orderId)).first_response_state, "NOT_STARTED");
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143002", legacyTeam), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(legacy.orderId)).length, 0);
    assert.equal((await groupRow(legacy.orderId)).first_response_state, "NOT_STARTED");
  });

  await t.test("T02 consultation scope routes user and assigned admin, rejects outsiders", async () => {
    // Synthetic consultation scope: this suite owns supplier-event routing, while the
    // consultation provisioning path itself is covered by the existing acceptance suites.
    // 979900001 stays clear of the 970000001 consultation fixture used by the order-team suite.
    const consultTeam = "979900001";
    const consultUserAccount = deriveYunxinAccountId(identityKey("USER", consultUser));
    const consultAdminAccount = deriveYunxinAccountId(identityKey("ADMIN", consultAdmin));
    await pool.query(`INSERT INTO zzsh_iam.im_consultation
      (id,user_id,kind,state,user_account_id,peer_account_id,assigned_admin_id,app_id,message_scope_type,message_scope_id,message_scope_state,message_scope_version,version)
      VALUES ($1,$2,'SERVICE','ACTIVE',$3,$4,$5,$6,'TEAM',$7,'READY',1,1)`,
    [`im_consult_oim4b_${run}`, consultUser, consultUserAccount, consultAdminAccount, consultAdmin, appId, consultTeam]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(consultTeam, consultUserAccount), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(consultTeam, consultAdminAccount), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(consultTeam, deriveYunxinAccountId(identityKey("ADMIN", stranger))), { base: hooks.base })).body?.errCode, 1);
    // The consultation user and the assigned admin are both checked against their current account state.
    await pool.query(`UPDATE zzsh_auth_user."user" SET suspended=true WHERE id=$1`, [consultUser]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(consultTeam, consultUserAccount), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_auth_user."user" SET suspended=false WHERE id=$1`, [consultUser]);
    await pool.query(`UPDATE zzsh_auth_admin."user" SET suspended=true WHERE id=$1`, [consultAdmin]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(consultTeam, consultAdminAccount), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_auth_admin."user" SET suspended=false WHERE id=$1`, [consultAdmin]);
    await pool.query(`UPDATE zzsh_iam.admin_security SET status='FROZEN',updated_at=clock_timestamp() WHERE admin_user_id=$1`, [consultAdmin]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(consultTeam, consultAdminAccount), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_iam.admin_security SET status='ACTIVE',updated_at=clock_timestamp() WHERE admin_user_id=$1`, [consultAdmin]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(consultTeam, consultAdminAccount), { base: hooks.base })).body?.errCode, 0);
    // A COMPLAINT scope additionally requires im.support.complaint for the assigned admin.
    const complaintTeam = "979900002";
    await pool.query(`INSERT INTO zzsh_iam.im_consultation
      (id,user_id,kind,state,user_account_id,peer_account_id,assigned_admin_id,app_id,message_scope_type,message_scope_id,message_scope_state,message_scope_version,version)
      VALUES ($1,$2,'COMPLAINT','ACTIVE',$3,$4,$5,$6,'TEAM',$7,'READY',1,1)`,
    [`im_consult_oim4b_c_${run}`, consultUser, consultUserAccount, consultAdminAccount, consultAdmin, appId, complaintTeam]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(complaintTeam, consultAdminAccount), { base: hooks.base })).body?.errCode, 1);
    await grantPermissions(consultAdmin, ["im.support.complaint"]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(complaintTeam, consultAdminAccount), { base: hooks.base })).body?.errCode, 0);
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.complaint'`, [consultAdmin]);
  });

  await t.test("T03 copy-first keeps WAITING_AUTH, approval recovers, duplicates stay idempotent", async () => {
    const before = await auditCount("im.order.first_response.confirmed");
    // A deliberately later occurrence leaves deterministic room for T04's earlier fact.
    const firstMs = Date.now() + 20_000;
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143011", teamId, { msgTimestamp: String(firstMs) }), { base: hooks.base })).status, 200);
    const delivery = (await eventRows(order.orderId)).find((row) => row.type === "message_delivered");
    assert.equal(delivery?.status, "WAITING_AUTH");
    assert.equal((await groupRow(order.orderId)).first_response_state, "RUNNING");
    const approval = await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount, { msgidClient: "client_4291065454174143011", msgTimestamp: String(firstMs) }), { base: hooks.base });
    assert.equal(approval.body?.errCode, 0);
    const group = await groupRow(order.orderId);
    assert.equal(group.first_response_state, "STOPPED");
    assert.ok(group.first_response_event_id);
    assert.equal(new Date(group.first_response_at).getTime(), firstMs);
    assert.equal(await auditCount("im.order.first_response.confirmed"), before + 1);
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143011", teamId, { msgTimestamp: String(firstMs) }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(order.orderId)).filter((row) => row.type === "message_delivered").length, 1);
    assert.equal(await auditCount("im.order.first_response.confirmed"), before + 1);
  });

  await t.test("T04 a later earlier verified fact moves the pointer earlier and never restarts", async () => {
    const current = await groupRow(order.orderId);
    const currentAt = new Date(current.first_response_at).getTime();
    const readyAt = new Date(current.team_ready_at).getTime();
    const earlierMs = Math.max(readyAt + 1_000, currentAt - 15_000);
    assert.ok(earlierMs < currentAt, "need room for an earlier but still valid fact");
    const earlier = new Date(earlierMs);
    const client = `earlier_${randomUUID()}`;
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount, { msgidClient: client, msgTimestamp: String(earlier.getTime()) }), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143012", teamId, { msgidClient: client, msgTimestamp: String(earlier.getTime()) }), { base: hooks.base })).status, 200);
    const earlierDelivery = (await eventRows(order.orderId)).find((row) => row.message_server_id === "4291065454174143012");
    assert.equal(earlierDelivery?.status, "VERIFIED", JSON.stringify(earlierDelivery));
    const moved = await groupRow(order.orderId);
    assert.equal(moved.first_response_state, "STOPPED");
    assert.equal(new Date(moved.first_response_at).getTime(), earlier.getTime());
    assert.notEqual(moved.first_response_event_id, current.first_response_event_id);
    assert.equal((await eventRows(order.orderId)).filter((row) => row.type === "first_response").length, 2);
    const later = new Date(currentAt + 15_000);
    const laterClient = `later_${randomUUID()}`;
    await signedRequest(PRE_SEND_PATH, preSendBody(teamId, staffAccount, { msgidClient: laterClient, msgTimestamp: String(later.getTime()) }), { base: hooks.base });
    await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143013", teamId, { msgidClient: laterClient, msgTimestamp: String(later.getTime()) }), { base: hooks.base });
    const unchanged = await groupRow(order.orderId);
    assert.equal(new Date(unchanged.first_response_at).getTime(), earlier.getTime());
    assert.equal(unchanged.first_response_event_id, moved.first_response_event_id);
  });

  await t.test("T05 rejected, conflicting and non-human facts never confirm a first response", async () => {
    const fresh = await makePaid("OIM4B 异常事实单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const freshBuyer = deriveYunxinAccountId({ provider: "yunxin", appId, realm: "user", kind: "USER", platformSubjectId: fresh.renter });
    assert.equal((await signedRequest(COPY_PATH, copyBody(freshBuyer, "4291065454174143021", freshTeam), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).length, 0);
    assert.equal((await signedRequest(COPY_PATH, copyBody(systemAccount, "4291065454174143022", freshTeam), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).length, 0);
    const noServer = copyBody(staffAccount, "0", freshTeam);
    delete (noServer as Record<string, unknown>).msgidServer;
    assert.equal((await signedRequest(COPY_PATH, noServer, { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).length, 0);
    // A REST/robot send is a non-human source even when the account is a JOINED staff member.
    const restClient = `rest_${randomUUID()}`;
    await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: restClient }), { base: hooks.base });
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143023", freshTeam, { msgidClient: restClient, fromClientType: "32" }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).filter((row) => row.type === "message_delivered").length, 0);
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "RUNNING");
    // Future timestamps quarantine instead of confirming.
    const future = String(Date.now() + 10 * 60_000);
    const futureClient = `future_${randomUUID()}`;
    await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: futureClient, msgTimestamp: future }), { base: hooks.base });
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143024", freshTeam, { msgidClient: futureClient, msgTimestamp: future }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).find((row) => row.message_server_id === "4291065454174143024")?.status, "VERIFY_REQUIRED");
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "VERIFY_REQUIRED");
    assert.equal((await signedRequest(COPY_PATH, { ...copyBody(staffAccount, "4291065454174143025", freshTeam), eventType: 2 }, { base: hooks.base })).status, 400);
    assert.equal((await signedRequest(COPY_PATH, { ...copyBody(staffAccount, "4291065454174143026", freshTeam), convType: "PERSON" }, { base: hooks.base })).status, 400);
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143027", freshTeam), { base: hooks.base, appSecret: "wrong-secret" })).status, 403);
    // A denied pre-send decision is recorded and a later delivery for it is REJECTED.
    const denied = await makePaid("OIM4B 拒绝事实单", "active");
    const deniedTeam = (await groupRow(denied.orderId)).team_id as string;
    const deniedClient = `denied_${randomUUID()}`;
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`, [staff]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(deniedTeam, staffAccount, { msgidClient: deniedClient }), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='ALLOW' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`, [staff]);
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143031", deniedTeam, { msgidClient: deniedClient }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(denied.orderId)).find((row) => row.message_server_id === "4291065454174143031")?.status, "REJECTED");
    assert.equal((await groupRow(denied.orderId)).first_response_at, null);
    // An approval that is later contradicted by a same-key denial is not a permanent pass.
    const conflict = await makePaid("OIM4B 冲突事实单", "active");
    const conflictTeam = (await groupRow(conflict.orderId)).team_id as string;
    const conflictAt = Date.now();
    const conflictClient = `conflict_${randomUUID()}`;
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(conflictTeam, staffAccount, { msgidClient: conflictClient, msgTimestamp: String(conflictAt) }), { base: hooks.base })).body?.errCode, 0);
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`, [staff]);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(conflictTeam, staffAccount, { msgidClient: conflictClient, msgTimestamp: String(conflictAt + 1_000) }), { base: hooks.base })).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='ALLOW' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`, [staff]);
    assert.equal((await groupRow(conflict.orderId)).first_response_state, "VERIFY_REQUIRED");
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143032", conflictTeam, { msgidClient: conflictClient, msgTimestamp: String(conflictAt + 1_000) }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(conflict.orderId)).find((row) => row.message_server_id === "4291065454174143032")?.status, "VERIFY_REQUIRED");
    assert.equal((await groupRow(conflict.orderId)).first_response_at, null);
    // A delivery whose approved message type differs under the same client id is a conflict too.
    const mismatch = await makePaid("OIM4B 类型矛盾单", "active");
    const mismatchTeam = (await groupRow(mismatch.orderId)).team_id as string;
    const mismatchClient = `mismatch_${randomUUID()}`;
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143033", mismatchTeam, { msgidClient: mismatchClient }), { base: hooks.base })).status, 200);
    await signedRequest(PRE_SEND_PATH, preSendBody(mismatchTeam, staffAccount, { msgidClient: mismatchClient, msgType: "PICTURE" }), { base: hooks.base });
    const mismatchDelivery = (await eventRows(mismatch.orderId)).find((row) => row.message_server_id === "4291065454174143033");
    assert.equal(mismatchDelivery?.status, "VERIFY_REQUIRED");
    assert.equal((await groupRow(mismatch.orderId)).first_response_state, "VERIFY_REQUIRED");
    // An approval for a different signed message time under the same client id is a conflict.
    const timeMismatch = await makePaid("OIM4B 时间矛盾单", "active");
    const timeTeam = (await groupRow(timeMismatch.orderId)).team_id as string;
    const timeClient = `timemismatch_${randomUUID()}`;
    const approvalAt = new Date(Date.now() - 30 * 60_000);
    await insertApprovalRow({ orderId: timeMismatch.orderId, teamId: timeTeam, clientId: timeClient, occurredAt: approvalAt, basis: await staffBasis(timeMismatch.orderId) });
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143034", timeTeam, { msgidClient: timeClient }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(timeMismatch.orderId)).find((row) => row.message_server_id === "4291065454174143034")?.status, "VERIFY_REQUIRED");
    assert.equal((await groupRow(timeMismatch.orderId)).first_response_at, null);
  });

  await t.test("T06 approved-first delivery, body secrecy and no forbidden markers persist", async () => {
    const fresh = await makePaid("OIM4B 先批准单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const client = `approved_${randomUUID()}`;
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client }), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143041", freshTeam, { msgidClient: client, body: "OIM4B_SECRET_MARKER" }), { base: hooks.base })).status, 200);
    const delivery = (await eventRows(fresh.orderId)).find((row) => row.message_server_id === "4291065454174143041");
    assert.equal(delivery?.status, "VERIFIED");
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "STOPPED");
    const leak = (await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE details::text LIKE '%OIM4B_SECRET_MARKER%'`)).rows[0].n
      + (await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.im_order_event WHERE metadata::text LIKE '%OIM4B_SECRET_MARKER%'`)).rows[0].n;
    assert.equal(leak, 0);
    assert.match((await pool.query(`SELECT raw_body_sha256 FROM zzsh_order.im_order_event WHERE id=$1`, [delivery!.id])).rows[0].raw_body_sha256 as string, /^[0-9a-f]{64}$/);
  });

  await t.test("T07 reducer blocks on the group row without deadlock, audit failure rolls back whole facts", async () => {
    const fresh = await makePaid("OIM4B 并发与回滚单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const client = `locked_${randomUUID()}`;
    await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client }), { base: hooks.base });
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE`, [fresh.orderId]);
    const pending = signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143051", freshTeam, { msgidClient: client }), { base: hooks.base });
    let waiting = 0;
    for (let attempt = 0; attempt < 20 && waiting === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      waiting = (await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n;
    }
    assert.ok(waiting >= 1, "copy reducer must wait on the locked group row");
    await holder.query("COMMIT");
    holder.release();
    assert.equal((await pending).status, 200);
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "STOPPED");
    const rollbackOrder = await makePaid("OIM4B 审计回滚单", "active");
    const rollbackTeam = (await groupRow(rollbackOrder.orderId)).team_id as string;
    const rollbackClient = `rollback_${randomUUID()}`;
    await signedRequest(PRE_SEND_PATH, preSendBody(rollbackTeam, staffAccount, { msgidClient: rollbackClient }), { base: hooks.base });
    await migrationPool.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${config.database.user}"`);
    try {
      assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143052", rollbackTeam, { msgidClient: rollbackClient }), { base: hooks.base })).status, 503);
    } finally {
      await migrationPool.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${config.database.user}"`);
    }
    assert.equal((await eventRows(rollbackOrder.orderId)).filter((row) => row.type === "message_delivered").length, 0);
    assert.equal((await groupRow(rollbackOrder.orderId)).first_response_state, "RUNNING");
  });

  await t.test("T08 bounded recovery resolves WAITING_AUTH facts and the narrow query adapter trims facts", async () => {
    const fresh = await makePaid("OIM4B 恢复单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const client = `recover_${randomUUID()}`;
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143061", freshTeam, { msgidClient: client }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).find((row) => row.message_server_id === "4291065454174143061")?.status, "WAITING_AUTH");
    // The approval arrived but was never applied; recovery re-reads facts inside the lock.
    await insertApprovalRow({ orderId: fresh.orderId, teamId: freshTeam, clientId: client, occurredAt: new Date(), basis: await staffBasis(fresh.orderId) });
    const summary = await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 10 });
    assert.ok(summary.resolved >= 1, JSON.stringify(summary));
    assert.equal((await eventRows(fresh.orderId)).find((row) => row.message_server_id === "4291065454174143061")?.status, "VERIFIED");
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "STOPPED");
    const calls: Array<{ teamId: string; operatorAccountId: string; messageServerId: string }> = [];
    const fact = await readOrderTeamMessageFact(pool, {
      readTeamMessage: async (input: { teamId: string; operatorAccountId: string; messageServerId: string }) => {
        calls.push(input);
        return { messageServerId: input.messageServerId, messageClientId: "c", senderId: staffAccount, teamId: input.teamId, messageType: 0, createTime: 1 };
      },
    } as unknown as Parameters<typeof readOrderTeamMessageFact>[1], { appId, orderId: fresh.orderId, messageServerId: "4291065454174143061", messageTime: 1 });
    assert.equal(fact?.messageServerId, "4291065454174143061");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.operatorAccountId, systemAccount);
    assert.equal(calls[0]!.teamId, freshTeam);
  });

  await t.test("T09 the default mounted ingress links approvals without explicit windows", async () => {
    const fresh = await makePaid("OIM4B 默认装配单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const handlers = new Map<string, (request: unknown, response: unknown) => Promise<void>>();
    mountOrderImEventHandlers({
      getHttpAdapter: () => ({ getInstance: () => ({ use: (path: string, handler: (request: unknown, response: unknown) => Promise<void>) => handlers.set(path, handler) }) }),
    } as unknown as INestApplication, { pool, appId, appSecret: ORDER_IM_EVENT_SECRET });
    const call = async (path: string, body: Record<string, unknown>) => {
      const raw = JSON.stringify(body);
      const md5 = createHash("md5").update(raw).digest("hex");
      const curTime = String(Date.now());
      const request = { method: "POST", headers: { "content-type": "application/json", appkey: appId, curtime: curTime, md5,
        checksum: createHash("sha1").update(`${ORDER_IM_EVENT_SECRET}${md5}${curTime}`).digest("hex") }, rawBody: Buffer.from(raw) };
      const response = { statusCode: 0, body: null as Record<string, any> | null, headersSent: false,
        setHeader() { return this; }, status(code: number) { this.statusCode = code; return this; }, json(value: Record<string, any>) { this.body = value; this.headersSent = true; } };
      await handlers.get(path)!(request, response);
      return response;
    };
    const client = `default_${randomUUID()}`;
    assert.equal((await call(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client }))).body?.errCode, 0);
    assert.equal((await call(COPY_PATH, copyBody(staffAccount, "4291065454174143071", freshTeam, { msgidClient: client }))).statusCode, 200);
    assert.equal((await eventRows(fresh.orderId)).find((row) => row.message_server_id === "4291065454174143071")?.status, "VERIFIED");
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "STOPPED");
  });

  await t.test("T10 an approval recorded long ago still links a legitimately late delivery", async () => {
    const fresh = await makePaid("OIM4B 迟到单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const client = `late_${randomUUID()}`;
    // The approval row is 11 minutes old by arrival time, i.e. past the old recorded_at window,
    // while the signed message times still agree: arrival age must not expire a signed link.
    const occurred = new Date();
    await insertApprovalRow({ orderId: fresh.orderId, teamId: freshTeam, clientId: client, occurredAt: occurred,
      recordedAt: new Date(occurred.getTime() - 11 * 60_000), basis: await staffBasis(fresh.orderId) });
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143081", freshTeam, { msgidClient: client, msgTimestamp: String(occurred.getTime()) }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).find((row) => row.message_server_id === "4291065454174143081")?.status, "VERIFIED");
    const group = await groupRow(fresh.orderId);
    assert.equal(group.first_response_state, "STOPPED");
    assert.equal(new Date(group.first_response_at).getTime(), occurred.getTime());
  });

  await t.test("T11 stale re-sends dedup and unseen stale facts are quarantined, not rejected", async () => {
    const fresh = await makePaid("OIM4B 重送单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const client = `resend_${randomUUID()}`;
    const originalBody = copyBody(staffAccount, "4291065454174143091", freshTeam, { msgidClient: client });
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client }), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await signedRequest(COPY_PATH, originalBody, { base: hooks.base })).status, 200);
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "STOPPED");
    const eventsBefore = (await eventRows(fresh.orderId)).length;
    // A trusted replay of an already-seen callback is deduplicated, never 403.
    const replay = await signedRequest(COPY_PATH, originalBody, { base: hooks.base, nowMs: Date.now() - 30 * 60_000 });
    assert.equal(replay.status, 200);
    assert.equal((await eventRows(fresh.orderId)).length, eventsBefore);
    // An expired pre-send never replays an old allow: it is denied without touching the recorded facts.
    const seenStalePreSend = await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client }), { base: hooks.base, nowMs: Date.now() - 30 * 60_000 });
    assert.equal(seenStalePreSend.body?.errCode, 1);
    assert.notEqual(seenStalePreSend.body?.responseCode, 200);
    assert.equal((await eventRows(fresh.orderId)).length, eventsBefore);
    // An unseen stale callback is restricted verification: persisted, never a first response.
    const staleClient = `stale_${randomUUID()}`;
    const stale = await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143092", freshTeam, { msgidClient: staleClient }), { base: hooks.base, nowMs: Date.now() - 30 * 60_000 });
    assert.equal(stale.status, 200);
    const staleRow = (await eventRows(fresh.orderId)).find((row) => row.message_server_id === "4291065454174143092");
    assert.equal(staleRow?.status, "VERIFY_REQUIRED");
    // An unseen stale pre-send is denied (never authorized) but is not a signature rejection.
    const unseenPreSend = await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount), { base: hooks.base, nowMs: Date.now() - 30 * 60_000 });
    assert.equal(unseenPreSend.status, 200);
    assert.equal(unseenPreSend.body?.errCode, 1);
    assert.notEqual(unseenPreSend.body?.responseCode, 200);
    // A wrong signature is still a hard rejection.
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143093", freshTeam), { base: hooks.base, appSecret: "wrong-secret" })).status, 403);
  });

  await t.test("T12 the database rejects foreign or mutated first-response evidence", async () => {
    const first = await makePaid("OIM4B 约束单A", "active");
    const firstTeam = (await groupRow(first.orderId)).team_id as string;
    const firstGroup = await confirmFirstResponse(first.orderId, firstTeam, "4291065454174143101");
    const foreign = await makePaid("OIM4B 约束单B", "active");
    const eventA = firstGroup.first_response_event_id as string;
    const timeA = new Date(firstGroup.first_response_at);
    // Another order can never borrow the first-response event, even inside a rolled-back transaction.
    await expectRejectedSqlState(pool, `UPDATE zzsh_order.im_order_group SET first_response_state='STOPPED',first_response_event_id=$2,first_response_at=$3,version=version+1 WHERE order_id=$1`,
      [foreign.orderId, eventA, timeA], "40001");
    // The runtime role cannot rewrite evidence at all: non-status columns are privilege-denied,
    // and an invalid status transition hits the guard.
    await expectRejectedSqlState(pool, `UPDATE zzsh_order.im_order_event SET actor='someone-else' WHERE id=$1`, [eventA], "42501");
    await expectRejectedSqlState(pool, `UPDATE zzsh_order.im_order_event SET recorded_at=clock_timestamp() WHERE id=$1`, [eventA], "42501");
    await expectRejectedSqlState(pool, `UPDATE zzsh_order.im_order_event SET metadata='{"tampered":true}'::jsonb WHERE id=$1`, [eventA], "42501");
    // Even the owning role cannot rewrite binding evidence or reopen a resolved status.
    await expectRejectedSqlState(ownerPool, `UPDATE zzsh_order.im_order_event SET actor='someone-else' WHERE id=$1`, [eventA], "40001");
    await expectRejectedSqlState(ownerPool, `UPDATE zzsh_order.im_order_event SET recorded_at=clock_timestamp() WHERE id=$1`, [eventA], "40001");
    await expectRejectedSqlState(ownerPool, `UPDATE zzsh_order.im_order_event SET metadata='{"tampered":true}'::jsonb WHERE id=$1`, [eventA], "40001");
    const rejectedDelivery = (await pool.query(`SELECT id FROM zzsh_order.im_order_event WHERE type='message_delivered' AND status='REJECTED' LIMIT 1`)).rows[0];
    assert.ok(rejectedDelivery, "T05 must leave a rejected delivery fact behind");
    await expectRejectedSqlState(pool, `UPDATE zzsh_order.im_order_event SET status='VERIFIED' WHERE id=$1`, [rejectedDelivery.id], "40001");
    // The pointer time must equal its event time and can never move later.
    await expectRejectedSqlState(pool, `UPDATE zzsh_order.im_order_group SET first_response_at=$2 WHERE order_id=$1`, [first.orderId, new Date(timeA.getTime() + 60_000)], "40001");
    // A STOPPED fact can neither be cleared nor reopened.
    await expectRejectedSqlState(pool, `UPDATE zzsh_order.im_order_group SET first_response_state='RUNNING',first_response_event_id=NULL,first_response_at=NULL WHERE order_id=$1`, [first.orderId], "40001");
    const unchanged = await groupRow(first.orderId);
    assert.equal(unchanged.first_response_event_id, eventA);
    assert.equal(new Date(unchanged.first_response_at).getTime(), timeA.getTime());
    assert.equal(unchanged.first_response_state, "STOPPED");
  });

  await t.test("T13 bounded recovery pages past a failing head and resolves the rest", async () => {
    const fresh = await makePaid("OIM4B 恢复边界单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const joined = await memberJoinedAt(fresh.orderId);
    const basis = buildStaffApprovalBasis({ platformSubjectId: staff, memberJoinedAt: joined, scope: gameId });
    const seeded: string[] = [];
    for (let index = 0; index < 25; index++) {
      const client = `bulk_${index}_${randomUUID()}`;
      const serverId = `42910654541742${String(4000 + index)}`;
      await insertPendingDelivery({ orderId: fresh.orderId, teamId: freshTeam, serverId, clientId: client, occurredAt: new Date() });
      await insertApprovalRow({ orderId: fresh.orderId, teamId: freshTeam, clientId: client, occurredAt: new Date(), basis });
      seeded.push(serverId);
    }
    const summary = await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 20 });
    assert.ok(summary.scanned >= 25, JSON.stringify(summary));
    assert.equal(summary.resolved, 25, JSON.stringify(summary));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.im_order_event WHERE type='message_delivered' AND status='WAITING_AUTH' AND team_id=$1`, [freshTeam])).rows[0].n, 0);
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "STOPPED");
    // A failing head must not starve the later row: a verified head needs the audit insert,
    // while a rejected row resolves without it.
    const head = await makePaid("OIM4B 恢复坏队首", "active");
    const headTeam = (await groupRow(head.orderId)).team_id as string;
    const headClient = `head_${randomUUID()}`;
    const headServer = "4291065454174244001";
    await insertPendingDelivery({ orderId: head.orderId, teamId: headTeam, serverId: headServer, clientId: headClient, occurredAt: new Date() });
    await insertApprovalRow({ orderId: head.orderId, teamId: headTeam, clientId: headClient, occurredAt: new Date(), basis: await staffBasis(head.orderId) });
    const tailClient = `tail_${randomUUID()}`;
    const tailServer = "4291065454174244002";
    await insertPendingDelivery({ orderId: head.orderId, teamId: headTeam, serverId: tailServer, clientId: tailClient, occurredAt: new Date() });
    await insertApprovalRow({ orderId: head.orderId, teamId: headTeam, clientId: tailClient, occurredAt: new Date(), status: "REJECTED" });
    await migrationPool.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${config.database.user}"`);
    try {
      const partial = await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 20, maxTotal: 50 });
      assert.ok(partial.failed >= 1, JSON.stringify(partial));
      assert.ok((partial.failures.PRIVILEGE ?? 0) >= 1, JSON.stringify(partial));
      assert.ok(partial.resolved >= 1, JSON.stringify(partial));
    } finally {
      await migrationPool.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${config.database.user}"`);
    }
    assert.equal((await eventRows(head.orderId)).find((row) => row.message_server_id === tailServer)?.status, "REJECTED");
    assert.equal((await eventRows(head.orderId)).find((row) => row.message_server_id === headServer)?.status, "WAITING_AUTH");
    assert.equal(seeded.length, 25);
  });

  await t.test("T14 an expired pre-send never replays an old approval", async () => {
    const fresh = await makePaid("OIM4B 过期前置单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const client = `expired_${randomUUID()}`;
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client }), { base: hooks.base })).body?.errCode, 0);
    const eventsBefore = (await eventRows(fresh.orderId)).length;
    const staleReplay = () => signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client }), { base: hooks.base, nowMs: Date.now() - 30 * 60_000 });
    // Permission revoked: the expired request still does not authorize a send.
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='DENY' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`, [staff]);
    const revoked = await staleReplay();
    assert.equal(revoked.body?.errCode, 1);
    assert.notEqual(revoked.body?.responseCode, 200);
    await pool.query(`UPDATE zzsh_iam.admin_user_permission SET effect='ALLOW' WHERE admin_user_id=$1 AND permission_code='im.support.accept'`, [staff]);
    // Subject frozen.
    await pool.query(`UPDATE zzsh_auth_admin."user" SET suspended=true WHERE id=$1`, [staff]);
    assert.equal((await staleReplay()).body?.errCode, 1);
    await pool.query(`UPDATE zzsh_auth_admin."user" SET suspended=false WHERE id=$1`, [staff]);
    // No expired request created a new fact, and the historical approval still verifies a later copy.
    assert.equal((await eventRows(fresh.orderId)).length, eventsBefore);
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174145001", freshTeam, { msgidClient: client }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).find((row) => row.message_server_id === "4291065454174145001")?.status, "VERIFIED");
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "STOPPED");
  });

  await t.test("T15 source normalization and duplicate key fields gate the first response", async () => {
    const fresh = await makePaid("OIM4B 来源重复单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    // The official numeric REST source is normalized, not dropped into a countable human message.
    const restClient = `numrest_${randomUUID()}`;
    await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: restClient }), { base: hooks.base });
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174145101", freshTeam, { msgidClient: restClient, fromClientType: 32 }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).filter((row) => row.type === "message_delivered").length, 0);
    assert.equal((await groupRow(fresh.orderId)).first_response_state, "RUNNING");
    // An illegal source shape is unknown, never silently human.
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174145102", freshTeam, { fromClientType: { nested: 8 } }), { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).filter((row) => row.type === "message_delivered").length, 0);
    // A duplicate delivery that changes the message type conflicts and blocks a later approval.
    const typeClient = `duptype_${randomUUID()}`;
    const typeAt = Date.now();
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174145103", freshTeam, { msgidClient: typeClient, msgTimestamp: String(typeAt) }), { base: hooks.base })).status, 200);
    assert.equal((await deliveryRow(fresh.orderId, "4291065454174145103"))?.status, "WAITING_AUTH");
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174145103", freshTeam, { msgidClient: typeClient, msgTimestamp: String(typeAt), msgType: "PICTURE" }), { base: hooks.base })).status, 200);
    assert.equal(await verifyMarkerCount(fresh.orderId), 1);
    assert.equal((await deliveryRow(fresh.orderId, "4291065454174145103"))?.status, "VERIFY_REQUIRED");
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: typeClient, msgTimestamp: String(typeAt) }), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await deliveryRow(fresh.orderId, "4291065454174145103"))?.status, "VERIFY_REQUIRED");
    assert.equal((await groupRow(fresh.orderId)).first_response_at, null);
    // A duplicate with exactly one changed trusted key field is a conflict too; each variant
    // below changes a single field so no assertion can pass through another field's difference.
    const strangerAccount = deriveYunxinAccountId(identityKey("ADMIN", stranger));
    const variants: Array<{ label: string; change: (base: Record<string, unknown>) => Record<string, unknown> }> = [
      { label: "client", change: () => ({ msgidClient: `dupclient_${randomUUID()}` }) },
      { label: "time", change: (base) => ({ msgTimestamp: String(Number(base.msgTimestamp) + 5_000) }) },
      { label: "source-other", change: () => ({ fromClientType: "1" }) },
      { label: "source-rest", change: () => ({ fromClientType: 32 }) },
      { label: "source-unknown", change: () => ({ fromClientType: { nested: 8 } }) },
      { label: "type-notification", change: () => ({ msgType: "NOTIFICATION" }) },
      { label: "sender-non-staff", change: () => ({ fromAccount: strangerAccount }) },
    ];
    for (const [index, variant] of variants.entries()) {
      const order = await makePaid(`OIM4B 重复${variant.label}单`, "active");
      const team = (await groupRow(order.orderId)).team_id as string;
      const serverId = `42910654541741452${String(10 + index)}`;
      const variantAt = Date.now();
      const first = copyBody(staffAccount, serverId, team, { msgidClient: `dupbase_${randomUUID()}`, msgTimestamp: String(variantAt) });
      assert.equal((await signedRequest(COPY_PATH, first, { base: hooks.base })).status, 200);
      assert.equal((await deliveryRow(order.orderId, serverId))?.status, "WAITING_AUTH");
      assert.equal((await signedRequest(COPY_PATH, { ...first, ...variant.change(first) }, { base: hooks.base })).status, 200);
      assert.equal((await deliveryRow(order.orderId, serverId))?.status, "VERIFY_REQUIRED", variant.label);
      assert.equal(await verifyMarkerCount(order.orderId), 1, variant.label);
      assert.equal((await groupRow(order.orderId)).first_response_state, "VERIFY_REQUIRED", variant.label);
      assert.equal((await groupRow(order.orderId)).first_response_at, null, variant.label);
      if (variant.label === "source-rest") {
        // The Master reproduction: even a later normal approval for the original client id
        // cannot auto-confirm the quarantined fact, and recovery leaves it quarantined.
        const approval = await signedRequest(PRE_SEND_PATH, preSendBody(team, staffAccount, { msgidClient: String(first.msgidClient), msgTimestamp: String(first.msgTimestamp) }), { base: hooks.base });
        assert.equal(approval.body?.errCode, 0);
        await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 20, maxTotal: 200 });
        assert.equal((await deliveryRow(order.orderId, serverId))?.status, "VERIFY_REQUIRED");
        assert.equal((await groupRow(order.orderId)).first_response_state, "VERIFY_REQUIRED");
        assert.equal((await groupRow(order.orderId)).first_response_at, null);
        assert.equal(await verifyMarkerCount(order.orderId), 1);
      }
    }
    // A transport resend of the identical message (resend flag and wrapper only) stays idempotent.
    const resendClient = `resend_${randomUUID()}`;
    const resendBody = copyBody(staffAccount, "4291065454174145301", freshTeam, { msgidClient: resendClient });
    assert.equal((await signedRequest(COPY_PATH, resendBody, { base: hooks.base })).status, 200);
    const markersBefore = await verifyMarkerCount(fresh.orderId);
    assert.equal((await signedRequest(COPY_PATH, { ...resendBody, resendFlag: "1", extraWrapper: { hop: 2 } }, { base: hooks.base })).status, 200);
    assert.equal((await eventRows(fresh.orderId)).filter((row) => row.message_server_id === "4291065454174145301").length, 1);
    assert.equal(await verifyMarkerCount(fresh.orderId), markersBefore);
    // Recovery cannot bypass the stored source rule either.
    const staleSource = await makePaid("OIM4B 恢复来源单", "active");
    const staleSourceTeam = (await groupRow(staleSource.orderId)).team_id as string;
    const staleSourceClient = `recoverysource_${randomUUID()}`;
    await insertPendingDelivery({ orderId: staleSource.orderId, teamId: staleSourceTeam, serverId: "4291065454174145401", clientId: staleSourceClient, occurredAt: new Date(), metadata: { source: "32" } });
    await insertApprovalRow({ orderId: staleSource.orderId, teamId: staleSourceTeam, clientId: staleSourceClient, occurredAt: new Date(), basis: await staffBasis(staleSource.orderId) });
    await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 20, maxTotal: 200 });
    assert.equal((await deliveryRow(staleSource.orderId, "4291065454174145401"))?.status, "VERIFY_REQUIRED");
    assert.equal((await groupRow(staleSource.orderId)).first_response_at, null);
  });

  await t.test("T16 pre-send qualification locks precede the group lock", async () => {
    const fresh = await makePaid("OIM4B 锁序单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const renterAccount = deriveYunxinAccountId({ provider: "yunxin", appId, realm: "user", kind: "USER", platformSubjectId: fresh.renter });
    const holder = await pool.connect();
    let released = false;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [fresh.renter]);
      const pending = signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, renterAccount), { base: hooks.base });
      let waitingUser = 0;
      for (let attempt = 0; attempt < 50 && waitingUser === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waitingUser = (await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%SELECT%suspended%FOR UPDATE%'`)).rows[0].n;
      }
      assert.ok(waitingUser >= 1, "pre-send must wait on the user qualification lock");
      // The callback holds no group lock while it waits, so no user→group cycle can form.
      const nowait = await holder.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE NOWAIT`, [fresh.orderId]);
      assert.equal(nowait.rowCount, 1);
      await holder.query("ROLLBACK");
      holder.release();
      released = true;
      assert.equal((await pending).body?.errCode, 0);
    } finally {
      if (!released) {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
    }
    // The consultation user path takes the same qualification lock and no order group lock.
    const consultTeam = "979900001";
    const consultUserAccount = deriveYunxinAccountId(identityKey("USER", consultUser));
    const consultHolder = await pool.connect();
    let consultReleased = false;
    try {
      await consultHolder.query("BEGIN");
      await consultHolder.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [consultUser]);
      const pending = signedRequest(PRE_SEND_PATH, preSendBody(consultTeam, consultUserAccount), { base: hooks.base });
      let waitingUser = 0;
      for (let attempt = 0; attempt < 50 && waitingUser === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waitingUser = (await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%SELECT%suspended%FOR UPDATE%'`)).rows[0].n;
      }
      assert.ok(waitingUser >= 1, "consultation pre-send must wait on the user qualification lock");
      await consultHolder.query("ROLLBACK");
      consultHolder.release();
      consultReleased = true;
      assert.equal((await pending).body?.errCode, 0);
    } finally {
      if (!consultReleased) {
        await consultHolder.query("ROLLBACK").catch(() => undefined);
        consultHolder.release();
      }
    }
  });

  await t.test("T17 recovery cursors advance across sweeps instead of rescanning a pending prefix", async () => {
    const fresh = await makePaid("OIM4B 游标单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const prefix = ["4291065454174145601", "4291065454174145602"];
    for (const serverId of prefix) {
      await insertPendingDelivery({ orderId: fresh.orderId, teamId: freshTeam, serverId, clientId: `perm_${serverId}_${randomUUID()}`, occurredAt: new Date() });
    }
    const tailServer = "4291065454174145603";
    const tailClient = `tailcursor_${randomUUID()}`;
    await insertPendingDelivery({ orderId: fresh.orderId, teamId: freshTeam, serverId: tailServer, clientId: tailClient, occurredAt: new Date() });
    await insertApprovalRow({ orderId: fresh.orderId, teamId: freshTeam, clientId: tailClient, occurredAt: new Date(), status: "REJECTED" });
    // Head-restarting sweeps with a small budget never reach the tail (the reproduced starvation).
    for (let sweep = 0; sweep < 3; sweep++) {
      const restart = await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 1, maxTotal: 1 });
      assert.ok(restart.scanned <= 1, JSON.stringify(restart));
    }
    assert.equal((await deliveryRow(fresh.orderId, tailServer))?.status, "WAITING_AUTH");
    // Following the returned cursor reaches the tail within a bounded number of sweeps.
    let cursor = null as Awaited<ReturnType<typeof recoverOrderFirstResponse>>["nextCursor"];
    let reached = false;
    for (let sweep = 0; sweep < 8 && !reached; sweep++) {
      const summary = await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 1, maxTotal: 2, cursor });
      assert.ok(summary.scanned <= 2, JSON.stringify(summary));
      cursor = summary.nextCursor;
      reached = (await deliveryRow(fresh.orderId, tailServer))?.status === "REJECTED";
    }
    assert.equal(reached, true, "cursor sweeps must reach the tail");
    assert.equal((await deliveryRow(fresh.orderId, prefix[0]!))?.status, "WAITING_AUTH");
    // A sweep past the last pending fact reports a completed window so the next run may wrap.
    const wrap = await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 20, maxTotal: 20, cursor: { recordedAt: "2999-01-01T00:00:00.000Z", id: "zzzz" } });
    assert.equal(wrap.scanned, 0, JSON.stringify(wrap));
    assert.equal(wrap.nextCursor, null, JSON.stringify(wrap));
    // The scanned count never exceeds the remaining budget even with a larger page.
    const budget = await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 20, maxTotal: 1 });
    assert.equal(budget.scanned, 1, JSON.stringify(budget));
    // The lifecycle carries the cursor across consecutive wakes for the same App.
    const carried = await makePaid("OIM4B 游标生命周期单", "active");
    const carriedTeam = (await groupRow(carried.orderId)).team_id as string;
    for (const serverId of ["4291065454174145701", "4291065454174145702"]) {
      await insertPendingDelivery({ orderId: carried.orderId, teamId: carriedTeam, serverId, clientId: `perm_${serverId}_${randomUUID()}`, occurredAt: new Date() });
    }
    const carriedTailServer = "4291065454174145703";
    const carriedTailClient = `tailcarried_${randomUUID()}`;
    await insertPendingDelivery({ orderId: carried.orderId, teamId: carriedTeam, serverId: carriedTailServer, clientId: carriedTailClient, occurredAt: new Date() });
    await insertApprovalRow({ orderId: carried.orderId, teamId: carriedTeam, clientId: carriedTailClient, occurredAt: new Date(), status: "REJECTED" });
    const lifecycle = new OrderImEventRecoveryLifecycle();
    lifecycle.start({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, 3_600_000, { limit: 1, maxTotal: 2 });
    try {
      for (let attempt = 0; attempt < 100 && (await deliveryRow(carried.orderId, carriedTailServer))?.status === "WAITING_AUTH"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        lifecycle.wake();
      }
      assert.equal((await deliveryRow(carried.orderId, carriedTailServer))?.status, "REJECTED");
    } finally {
      await lifecycle.beforeApplicationShutdown();
    }
  });

  // Terminal by design: disabling an identity mapping is a one-way transition, so this test runs
  // last and deliberately leaves the synthetic staff mapping disabled.
  await t.test("T18 a disabled mapping keeps the approved delivery but never replays or extends it", async () => {
    const fresh = await makePaid("OIM4B 禁用映射单", "active");
    const late = await makePaid("OIM4B 禁用后新消息单", "active");
    const freshTeam = (await groupRow(fresh.orderId)).team_id as string;
    const lateTeam = (await groupRow(late.orderId)).team_id as string;
    const client = `disabled_${randomUUID()}`;
    // The same signed message time is used by the approval and the later copy; DB clock marks
    // the disable and the copy receipt so the ordering is evidenced, not merely described.
    const messageAt = new Date();
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client, msgTimestamp: String(messageAt.getTime()) }), { base: hooks.base })).body?.errCode, 0);
    const disabledAt = (await pool.query(`SELECT clock_timestamp() AS now`)).rows[0].now as Date;
    await pool.query(`UPDATE zzsh_iam.im_identity_mapping SET status='DISABLED',version=version+1 WHERE app_id=$1 AND account_id=$2`, [appId, staffAccount]);
    const copyReceivedAt = (await pool.query(`SELECT clock_timestamp() AS now`)).rows[0].now as Date;
    assert.ok(messageAt.getTime() < disabledAt.getTime(), "the message must occur before the disable");
    assert.ok(disabledAt.getTime() <= copyReceivedAt.getTime(), "the disable must precede the copy receipt");
    console.log("order first-response evidence", JSON.stringify({ orderId: fresh.orderId,
      messageAt: messageAt.toISOString(), disabledAt: disabledAt.toISOString(), copyReceivedAt: copyReceivedAt.toISOString() }));
    // Message occurred and was approved before the disable: the late copy still verifies.
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174145501", freshTeam, { msgidClient: client, msgTimestamp: String(messageAt.getTime()) }), { base: hooks.base })).status, 200);
    assert.equal((await deliveryRow(fresh.orderId, "4291065454174145501"))?.status, "VERIFIED");
    assert.equal(new Date((await deliveryRow(fresh.orderId, "4291065454174145501"))!.occurred_at).getTime(), messageAt.getTime());
    const confirmed = await groupRow(fresh.orderId);
    assert.equal(confirmed.first_response_state, "STOPPED");
    assert.equal(new Date(confirmed.first_response_at).getTime(), messageAt.getTime());
    const eventsBefore = (await eventRows(fresh.orderId)).length;
    // A new pre-send from the disabled identity stays strictly rejected.
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: `disabled_new_${randomUUID()}` }), { base: hooks.base })).body?.errCode, 1);
    // An expired replay of the old approved request is denied too and writes no new fact.
    const stale = await signedRequest(PRE_SEND_PATH, preSendBody(freshTeam, staffAccount, { msgidClient: client }), { base: hooks.base, nowMs: Date.now() - 30 * 60_000 });
    assert.equal(stale.body?.errCode, 1);
    assert.notEqual(stale.body?.responseCode, 200);
    assert.equal((await eventRows(fresh.orderId)).length, eventsBefore);
    // An unapproved message after the disable is kept as pending evidence, never promoted.
    const lateMessageAt = new Date();
    assert.ok(lateMessageAt.getTime() > disabledAt.getTime(), "the unapproved message must occur after the disable");
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174145502", lateTeam, { msgTimestamp: String(lateMessageAt.getTime()) }), { base: hooks.base })).status, 200);
    assert.equal((await deliveryRow(late.orderId, "4291065454174145502"))?.status, "WAITING_AUTH");
    assert.equal((await groupRow(late.orderId)).first_response_state, "RUNNING");
    assert.equal((await groupRow(late.orderId)).first_response_at, null);
  });
}
