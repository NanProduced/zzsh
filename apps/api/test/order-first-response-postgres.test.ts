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
import { advanceOrderTeam, OrderTeamLifecycle, scanOrderEscalations, type OrderTeamOptions } from "../src/im/order-team";
import { ImIdentityProvisioner, deriveYunxinAccountId, type ImIdentityKey } from "../src/im/identity-lifecycle";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";
import { BUSINESS_MIGRATIONS_FOLDER, runBusinessMigrations } from "../src/database/business-migrations";
import {
  buildStaffApprovalBasis, mountOrderImEventHandlers, OrderImEventRecoveryLifecycle, recoverOrderFirstResponse, readOrderTeamMessageFact,
} from "../src/im/order-im-events";
import { listJoinedOrderTeams, readOrderTeamAccess } from "../src/im/order-team-access";
import { listAdminOrders } from "../src/order/order";
import { seedAdmin, seedIdentity, seedUser } from "./im-test-fixtures";
import { OrderTeamTransport, fakeIdentityAccounts } from "./order-team-fixtures";
import type { runPaymentAcceptance } from "./order-payment-im-postgres.test";

export const ORDER_IM_EVENT_APP = "oim4b_events_app";
export const ORDER_IM_EVENT_SECRET = "oim4b-synthetic-callback-secret";
const COPY_PATH = "/api/v1/im/order-events/copy";
const PRE_SEND_PATH = "/api/v1/im/order-events/pre-send";
const LEGACY_GROUP_COLUMNS = `order_id,app_id,payment_confirmation_id,provision_state,assigned_admin_id,assigned_at::text,wait_reason,
  team_state,system_identity_id,team_name,members_limit,team_id,team_ready_at::text,team_failure,team_retry_at::text,version,created_at::text`;

function assertLegacyMemberSnapshotUnchanged(actual: any[], expected: any[]): void {
  const ordered = (members: any[]) => [...members].sort((a, b) => {
    const left = `${a.party}\0${a.platform_subject_id ?? ""}\0${a.identity_id}`;
    const right = `${b.party}\0${b.platform_subject_id ?? ""}\0${b.identity_id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  assert.deepEqual(ordered(actual), ordered(expected), "all legacy member columns and stable identity mappings must remain unchanged");
}

function assertLegacyOperationSnapshotUnchanged(actual: any[], expected: any[]): void {
  assert.deepEqual(actual.map(({ round, target_admin_id, ...legacyColumns }) => legacyColumns), expected,
    "all pre-0045 operation columns must remain unchanged");
  assert.ok(actual.every((operation) => operation.round === 0 && operation.target_admin_id === null),
    "only the two 0045 operation columns may take their declared defaults");
}

function assertReadyLegacyGroupContract(group: any, members: any[], operations: any[]): void {
  assert.equal(group.provision_state, "ASSIGNED");
  assert.equal(group.team_state, "READY");
  const requireJoined = (party: string, realm: string, kind: string, subjectId: string) => {
    const matches = members.filter((member) => member.party === party && member.identity_realm === realm
      && member.identity_kind === kind && member.platform_subject_id === subjectId);
    assert.equal(matches.length, 1, `one ${party} member must resolve through its stable identity mapping`);
    const member = matches[0];
    assert.equal(member.order_id, group.order_id);
    assert.equal(member.app_id, group.app_id);
    assert.equal(member.identity_status, "READY");
    assert.equal(member.state, "JOINED");
    assert.ok(member.joined_at, `${party} must retain its joined_at fact`);
  };
  assert.ok(group.renter_user_id && group.owner_user_id && group.assigned_admin_id && group.team_id);
  requireJoined("BUYER", "user", "USER", group.renter_user_id);
  requireJoined("OWNER", "user", "USER", group.owner_user_id);
  requireJoined("STAFF", "admin", "ADMIN", group.assigned_admin_id);
  assert.ok(operations.some((operation) => operation.order_id === group.order_id && operation.app_id === group.app_id
    && operation.kind === "CREATE" && operation.state === "SUCCEEDED" && operation.candidate_team_id === group.team_id),
  "a successful CREATE must bind this order's READY group to the same Team");
}

function verifyT00cOfflineAssertions(): void {
  const group = { order_id: "order_1", app_id: "app_1", provision_state: "ASSIGNED", team_state: "READY",
    team_id: "910000001", assigned_admin_id: "admin_1", renter_user_id: "buyer_1", owner_user_id: "owner_1" };
  const member = (identity_id: string, party: string, identity_realm: string, identity_kind: string,
    platform_subject_id: string, state = "JOINED", joined_at: string | null = "2026-09-21T10:00:00.000Z") => ({
    order_id: group.order_id, app_id: group.app_id, identity_id, party, state, joined_at,
    identity_realm, identity_kind, platform_subject_id, identity_status: "READY",
  });
  const three = [
    member("map_buyer", "BUYER", "user", "USER", "buyer_1"),
    member("map_owner", "OWNER", "user", "USER", "owner_1"),
    member("map_assigned", "STAFF", "admin", "ADMIN", "admin_1"),
  ];
  const fourT07 = [...three, member("map_collab", "STAFF", "admin", "ADMIN", "team_extra_00000001")];
  const fourPlanned = [...three, member("map_planned", "STAFF", "admin", "ADMIN", "history_1", "PLANNED", null)];
  const create = [{ order_id: group.order_id, app_id: group.app_id, kind: "CREATE", state: "SUCCEEDED", candidate_team_id: group.team_id }];

  for (const snapshot of [three, fourT07, fourPlanned]) {
    assertReadyLegacyGroupContract(group, snapshot, create);
    assertLegacyMemberSnapshotUnchanged([...snapshot].reverse(), snapshot);
  }
  assert.equal(three.length, 3);
  assert.equal(fourT07.length, 4);
  assert.throws(() => assertLegacyMemberSnapshotUnchanged(fourT07.slice(1), fourT07), "a missing legacy member must fail");
  assert.throws(() => assertLegacyMemberSnapshotUnchanged([...fourT07, member("map_extra", "STAFF", "admin", "ADMIN", "extra_1")], fourT07),
    "an added legacy member must fail");
  assert.throws(() => assertLegacyMemberSnapshotUnchanged(
    fourT07.map((row) => row.identity_id === "map_collab" ? { ...row, joined_at: "2026-09-21T10:00:01.000Z" } : row), fourT07),
  "a changed legacy member fact must fail");

  const oldOperation = { id: "op_1", order_id: group.order_id, app_id: group.app_id, kind: "CREATE", state: "SUCCEEDED",
    candidate_team_id: group.team_id, version: "2" };
  assertLegacyOperationSnapshotUnchanged([{ ...oldOperation, round: 0, target_admin_id: null }], [oldOperation]);
  assert.throws(() => assertLegacyOperationSnapshotUnchanged([{ ...oldOperation, state: "PENDING", round: 0, target_admin_id: null }], [oldOperation]),
    "an old operation column change must fail");
  assert.throws(() => assertLegacyOperationSnapshotUnchanged([{ ...oldOperation, round: 1, target_admin_id: null }], [oldOperation]),
    "new operation columns must retain their declared defaults");
}

verifyT00cOfflineAssertions();

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
  const makePaid = async (label: string, mode: "inactive" | "active", escalation=false) => {
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
      await advanceOrderTeam({ pool, appId, provider: wire.client, identities, membersLimit: 200, firstResponseEnabled: true,
        ...(escalation?{escalationEnabled:true}:{}) }, fixture.orderId);
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
    status?: "VERIFIED" | "REJECTED"; basis?: unknown; metadata?: unknown;
  }) => {
    await ownerPool.query(`INSERT INTO zzsh_order.im_order_event
      (id,order_id,app_id,team_id,event_key,type,status,actor,message_client_id,message_server_id,sender_account_id,message_type,occurred_at,recorded_at,raw_body_sha256,metadata)
      VALUES ($1,$2,$3,$4,$5,'send_approved',$6,$7,$8,NULL,$7,$9,$10,COALESCE($11,clock_timestamp()),$12,$13::jsonb)`, [
      `im_order_evt_${randomUUID().replaceAll("-", "")}`, input.orderId, appId, input.teamId,
      `send_approved:${input.teamId}:${staffAccount}:${input.clientId}`, input.status ?? "VERIFIED", staffAccount,
      input.clientId, input.msgType ?? "TEXT", input.occurredAt, input.recordedAt ?? null, "0".repeat(64),
      JSON.stringify(input.metadata ?? { reason: "SEEDED", basis: input.basis ?? null, fromClientType: "WEB" }),
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
  const stagedEscalation = o.resourceSet === "oim_escalation_stage";
  if (stagedEscalation) assert.equal(hooks.baselineCount, 43, "the one-time stage must start from the actual 0042 baseline");
  const stagedLegacy = hooks.baselineCount <= 43;
  if (stagedEscalation) assert.equal(stagedLegacy, true, "the one-time stage must seed legacy facts before 0043");
  let legacySnapshot: { legacy: any; waiting: any; waitingOrderId: string } | undefined;
  const captureLegacyFacts = async (orderId: string) => ({
    group: await legacyGroupRow(orderId),
    operations: (await pool.query(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 ORDER BY id`, [orderId])).rows,
    members: (await pool.query(`SELECT * FROM zzsh_order.im_order_member WHERE order_id=$1 ORDER BY party`, [orderId])).rows,
  });
  const assertLegacyFactsPreserved = (actual: any, expected: any) => {
    assert.deepEqual(actual.group, expected.group);
    assert.deepEqual(actual.operations.map(({ round, target_admin_id, ...legacyColumns }: any) => legacyColumns), expected.operations);
    assert.deepEqual(actual.members, expected.members);
  };
  const runRequiredStageTest = async (name: string, runTest: () => Promise<void>) => {
    let failed = false;
    let failure: unknown;
    await t.test(name, async () => {
      try { await runTest(); } catch (error) { failed = true; failure = error; throw error; }
    });
    if (failed) throw failure;
  };
  if (stagedLegacy) {
    const legacy = await makePaid("OIM4B 升级前旧READY群", "inactive");
    const waitingFixture = await o.fixture("OIM4B 升级前WAITING单");
    await pay(waitingFixture.orderId);
    legacySnapshot = { legacy: await captureLegacyFacts(legacy.orderId), waiting: await captureLegacyFacts(waitingFixture.orderId), waitingOrderId: waitingFixture.orderId };
    const readyGroup = await groupRow(legacy.orderId);
    const waitingGroup = await groupRow(waitingFixture.orderId);
    assert.equal(readyGroup.team_state, "READY");
    assert.equal(waitingGroup.provision_state, "WAITING");
    if (stagedEscalation) {
      assert.ok(legacySnapshot.legacy.operations.some((op: any) => op.kind === "CREATE" && op.state === "SUCCEEDED" && op.candidate_team_id === readyGroup.team_id));
      assert.equal(legacySnapshot.legacy.members.length, 3);
      assert.ok(legacySnapshot.legacy.members.every((member: any) => member.state === "JOINED"));
      assert.equal(legacySnapshot.waiting.group.provision_state, "WAITING");
    }

    await runRequiredStageTest("T00a staged 0043 baseline keeps legacy facts and applies additively", async () => {
      const before = Number((await migrationPool.query(`SELECT count(*)::int AS n FROM zzsh_business_meta.migrations`)).rows[0].n);
      assert.equal(before, hooks.baselineCount);
      if (stagedEscalation) assert.equal(before, 43);
      await hooks.upgrade(43);
      const after = (await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
      assert.equal(after.length, 44);
      const journal = JSON.parse(readFileSync(join(BUSINESS_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
      const entry = journal.entries[43];
      assert.equal(after[43].created_at, String(entry.when));
      assert.equal(after[43].hash, createHash("sha256").update(readFileSync(join(BUSINESS_MIGRATIONS_FOLDER, `${entry.tag}.sql`))).digest("hex"));
      assert.deepEqual(await captureLegacyFacts(legacySnapshot!.legacy.group.order_id), legacySnapshot!.legacy);
      assert.deepEqual(await captureLegacyFacts(legacySnapshot!.waitingOrderId), legacySnapshot!.waiting);
      const old = await groupRow(legacySnapshot!.legacy.group.order_id);
      assert.equal(old.first_response_state, "NOT_STARTED");
      assert.equal(old.first_response_event_id, null);
      assert.equal(old.first_response_at, null);
      assert.equal((await pool.query(`SELECT to_regclass('zzsh_order.im_order_event') AS relation`)).rows[0].relation, "zzsh_order.im_order_event");
      // A signed event for the inactive legacy group is ignored, not reduced.
      const ignored = await signedRequest(COPY_PATH, copyBody(staffAccount, "4291065454174143001", old.team_id), { base: hooks.base });
      assert.equal(ignored.status, 200);
      assert.equal((await eventRows(old.order_id)).length, 0);
      assert.equal((await groupRow(old.order_id)).first_response_state, "NOT_STARTED");
      console.log("order migration stage", JSON.stringify({ resourceSet: o.resourceSet, stage: "0043->0044", beforeCount: before,
        afterCount: after.length, migration: { idx: entry.idx, tag: entry.tag, when: after[43].created_at, hash: after[43].hash },
        legacyReadySamples: 1, legacyWaitingSamples: 1,
        legacyCreateSamples: legacySnapshot!.legacy.operations.filter((op: any) => op.kind === "CREATE" && op.state === "SUCCEEDED").length }));
    });
  }

  const captureOrderMembers=async(orderId:string)=>(await pool.query(`SELECT mm.*,m.realm AS identity_realm,m.identity_kind,m.platform_subject_id,m.status AS identity_status
    FROM zzsh_order.im_order_member mm LEFT JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=mm.app_id
    WHERE mm.order_id=$1 ORDER BY mm.party,m.platform_subject_id,mm.identity_id`,[orderId])).rows;
  const captureAssignedGroups=async()=>{
    const groups=(await pool.query<{order_id:string;app_id:string;provision_state:string;renter_user_id:string;owner_user_id:string;version:string;
      assigned_admin_id:string;assigned_at:string;team_id:string|null;team_state:string}>(`SELECT g.order_id,g.app_id,g.provision_state,o.renter_user_id,o.owner_user_id,g.version::text,
      g.assigned_admin_id,g.assigned_at::text,g.team_id,g.team_state FROM zzsh_order.im_order_group g
      JOIN zzsh_order.rental_order o ON o.id=g.order_id WHERE g.provision_state='ASSIGNED' ORDER BY g.order_id`)).rows;
    return Promise.all(groups.map(async group=>({...group,
      operations:(await pool.query(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 ORDER BY id`,[group.order_id])).rows,
      members:await captureOrderMembers(group.order_id),
  })));
  };
  let escalationBackfillSnapshot:Awaited<ReturnType<typeof captureAssignedGroups>>|undefined;
  await runRequiredStageTest("T00b staged 0044 adds the binding guards and both stages replay idempotently", async () => {
    const before = (await migrationPool.query(`SELECT count(*)::int AS n FROM zzsh_business_meta.migrations`)).rows[0].n as number;
    if(before===45)escalationBackfillSnapshot=await captureAssignedGroups();
    const staged0044 = before <= 44;
    if (stagedEscalation) assert.equal(before, 44, "0043 must leave exactly 44 rows before 0044");
    if (staged0044) {
      assert.equal(before, hooks.baselineCount <= 43 ? 44 : hooks.baselineCount);
      await hooks.upgrade(44);
    } else {
      assert.ok(before===45||before===46,"an already-migrated resource must be reused, never dropped");
    }
    if(before===44)escalationBackfillSnapshot=await captureAssignedGroups();
    const journal = JSON.parse(readFileSync(join(BUSINESS_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"));
    const after = (await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
    assert.equal(after.length, Math.max(45,hooks.baselineCount));
    if (stagedEscalation) assert.equal(after.length, 45, "0044 must leave exactly 45 rows before 0045");
    assert.equal(journal.entries.length, 46);
    assert.ok(after.every((row: { hash: string; created_at: string }, index: number) => {
      const entry = journal.entries[index];
      return row.created_at === String(entry.when) && row.hash === createHash("sha256").update(readFileSync(join(BUSINESS_MIGRATIONS_FOLDER, `${entry.tag}.sql`))).digest("hex");
    }));
    await runBusinessMigrations(migrationPool, { runtimeUser: config.database.user,migrationsFolder:preparePartialMigrationsFolder(44) });
    assert.deepEqual((await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows, after);
    const triggers = (await migrationPool.query(`SELECT tgname FROM pg_trigger WHERE tgname IN ('im_order_event_guard','im_order_group_first_response_guard') ORDER BY tgname`)).rows.map((row: { tgname: string }) => row.tgname);
    assert.deepEqual(triggers, ["im_order_event_guard", "im_order_group_first_response_guard"]);
    if (stagedEscalation) {
      assert.ok(escalationBackfillSnapshot && escalationBackfillSnapshot.length > 0, "stage must have assigned rows before 0045");
      assert.ok(escalationBackfillSnapshot.every((group)=>group.assigned_admin_id&&group.assigned_at),
        "stage assignments must carry the legacy administrator and assignment time");
      assert.ok(escalationBackfillSnapshot.some((group) => group.team_state === "READY"), "stage must have a READY assignment before 0045");
      assert.ok(escalationBackfillSnapshot.some((group) => group.operations.some((op: any) => op.kind === "CREATE" && op.state === "SUCCEEDED")),
        "stage must have a successful legacy CREATE before 0045");
      assert.ok(legacySnapshot?.waiting.group.provision_state === "WAITING", "stage must preserve a legacy WAITING sample");
    }
    const entry = journal.entries[44];
    console.log("order migration stage", JSON.stringify({ resourceSet: o.resourceSet, stage: "0044->0045", baselineCount: hooks.baselineCount,
      beforeCount: before, afterCount: after.length, staged0044, migration: { idx: entry.idx, tag: entry.tag,
        when: after[44]?.created_at ?? null, hash: after[44]?.hash ?? null },
      assignedSamples: escalationBackfillSnapshot?.length ?? 0,
      readyAssignedSamples: escalationBackfillSnapshot?.filter((group) => group.team_state === "READY").length ?? 0,
      successfulCreateSamples: escalationBackfillSnapshot?.flatMap((group) => group.operations)
        .filter((op: any) => op.kind === "CREATE" && op.state === "SUCCEEDED").length ?? 0,
      legacyWaitingSamples: legacySnapshot ? 1 : 0 }));
  });

  await runRequiredStageTest("T00c OIM-4C migration 0045 upgrades 45 to 46 and preserves legacy facts",async()=>{
    const beforeCount=Number((await migrationPool.query(`SELECT count(*)::int AS n FROM zzsh_business_meta.migrations`)).rows[0].n);
    if(stagedEscalation)assert.equal(beforeCount,45,"the one-time resource must run the final 45-to-46 increment");
    if(stagedEscalation){
      assert.ok(legacySnapshot&&escalationBackfillSnapshot&&escalationBackfillSnapshot.length>0,"the pre-0045 baseline snapshots must exist");
      const readyGroups=escalationBackfillSnapshot.filter(group=>group.team_state==="READY");
      assert.ok(readyGroups.length>0,"the pre-0045 baseline must include READY groups");
      for(const group of readyGroups)assertReadyLegacyGroupContract(group,group.members,group.operations);

      const basic=escalationBackfillSnapshot.find(group=>group.order_id===legacySnapshot!.legacy.group.order_id);
      assert.ok(basic,"the three-party READY baseline must be present immediately before 0045");
      assert.equal(basic.members.length,3,"the basic READY shape retains BUYER, OWNER and original STAFF");
      const t07Members=escalationBackfillSnapshot.flatMap(group=>group.members
        .filter(member=>member.identity_realm==="admin"&&member.identity_kind==="ADMIN"
          &&typeof member.platform_subject_id==="string"&&member.platform_subject_id.startsWith("team_extra_")));
      assert.equal(t07Members.length,1,"the pre-existing T07 collaborator must resolve by its stable admin identity mapping");
      const t07=escalationBackfillSnapshot.find(group=>group.order_id===t07Members[0].order_id);
      assert.ok(t07,"the T07 collaborator must belong to a captured assigned order");
      assert.equal(t07.members.length,4,"the T07 READY shape includes the three required parties and one collaborator");
      assert.equal(t07Members[0].party,"STAFF");
      assert.equal(t07Members[0].state,"JOINED");
      assert.equal(t07Members[0].identity_status,"READY");
      assertReadyLegacyGroupContract(t07,t07.members,t07.operations);
    }
    try{await hooks.upgrade(45);}catch(error){
      let databaseError:any=error;
      while(databaseError&&typeof databaseError==="object"&&!databaseError.code&&databaseError.cause)databaseError=databaseError.cause;
      console.error("OIM-4C migration database error",JSON.stringify({code:databaseError?.code??null,message:databaseError?.message??null,
        constraint:databaseError?.constraint??null,table:databaseError?.table??null,column:databaseError?.column??null}));
      throw error;
    }
    const migrations=(await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
    const journal=JSON.parse(readFileSync(join(BUSINESS_MIGRATIONS_FOLDER,"meta","_journal.json"),"utf8"));
    assert.equal(migrations.length,46);assert.equal(journal.entries.length,46);
    const staged0045=stagedEscalation&&beforeCount===45&&migrations.length===46;
    if(stagedEscalation)assert.equal(staged0045,true,"hash equality alone is not staged migration evidence");
    assert.ok(migrations.every((row:{hash:string;created_at:string},index:number)=>{
      const entry=journal.entries[index];
      return row.created_at===String(entry.when)&&row.hash===createHash("sha256").update(readFileSync(join(BUSINESS_MIGRATIONS_FOLDER,`${entry.tag}.sql`))).digest("hex");
    }));
    const privilege=(await ownerPool.query(`SELECT has_column_privilege($1,'zzsh_order.im_order_group','remind_due_at','UPDATE') AS due,
        has_column_privilege($1,'zzsh_order.im_order_group','responsible_admin_id','UPDATE') AS responsible`,[config.database.user])).rows[0];
    assert.deepEqual(privilege,{due:true,responsible:true});
    const backfillSnapshot=escalationBackfillSnapshot??[];
    if(stagedEscalation){
      assert.ok(legacySnapshot,"stage must retain its pre-0043 legacy samples through 0045");
      assert.ok(escalationBackfillSnapshot,"stage must capture assigned rows immediately before 0045");
      assert.ok(backfillSnapshot.length>0,"stage must backfill at least one legacy assignment");
      assert.ok(backfillSnapshot.some((group)=>group.team_state==="READY"),"stage must include a READY assignment");
      assert.ok(backfillSnapshot.some((group)=>group.operations.some((op:any)=>op.kind==="CREATE"&&op.state==="SUCCEEDED")),
        "stage must include a successful legacy CREATE operation");
      assert.equal(legacySnapshot.waiting.group.provision_state,"WAITING");
    }
    for(const old of backfillSnapshot){
        const row=(await pool.query(`SELECT g.order_id,g.app_id,g.provision_state,g.version::text,g.assigned_admin_id,g.assigned_at::text,g.team_id,g.team_state,
            g.responsible_admin_id,g.escalation_state,g.remind_due_at::text,g.next_add_due_at::text,o.renter_user_id,o.owner_user_id
          FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id WHERE g.order_id=$1`,[old.order_id])).rows[0];
        assert.equal(row.version,(BigInt(old.version)+1n).toString());
        assert.equal(row.responsible_admin_id,old.assigned_admin_id);assert.equal(row.assigned_admin_id,old.assigned_admin_id);
        assert.equal(row.assigned_at,old.assigned_at);assert.equal(row.team_id,old.team_id);assert.equal(row.team_state,old.team_state);
        assert.equal(row.escalation_state,"NOT_STARTED");assert.equal(row.remind_due_at,null);assert.equal(row.next_add_due_at,null);
        const operations=(await pool.query(`SELECT * FROM zzsh_order.im_order_operation WHERE order_id=$1 ORDER BY id`,[old.order_id])).rows;
        assertLegacyOperationSnapshotUnchanged(operations,old.operations);
        const members=await captureOrderMembers(old.order_id);
        assertLegacyMemberSnapshotUnchanged(members,old.members);
        if(old.team_state==="READY")assertReadyLegacyGroupContract(row,members,operations);
      }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.im_order_group WHERE team_state='READY' AND escalation_state<>'NOT_STARTED'`)).rows[0].n,0);
    if(stagedEscalation){
      assertLegacyFactsPreserved(await captureLegacyFacts(legacySnapshot!.waitingOrderId),legacySnapshot!.waiting);
    }
    await hooks.upgrade(45);
    assert.deepEqual((await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows,migrations,
      "reapplying the final formal migration runner is idempotent");
    console.log("order escalation migration evidence",JSON.stringify({resourceSet:o.resourceSet,baselineCount:hooks.baselineCount,beforeCount,
      afterCount:migrations.length,staged0045,migration:{idx:journal.entries[45].idx,tag:journal.entries[45].tag,
        when:migrations[45].created_at,hash:migrations[45].hash},backfilledAssignedGroups:backfillSnapshot.length,
      preservedReadyGroups:backfillSnapshot.filter(group=>group.team_state==="READY").length,
      preservedCreateOperations:backfillSnapshot.flatMap((group)=>group.operations)
        .filter((op:any)=>op.kind==="CREATE"&&op.state==="SUCCEEDED").length,
      preservedWaitingGroups:legacySnapshot?1:0,replayUnchanged:true,
      assertions:{assignmentFactsUnchanged:true,responsibleAndVersionBackfilled:true,legacyGroupsNotStarted:true,
        createAndMembersPreserved:true,waitingFactsPreserved:true,replayIdempotent:true}}));
  });

  // ------------------------------------------------------------------ ingress positives/negatives
  const order = await makePaid("OIM4B 首响主单", "active");
  const teamId = (await groupRow(order.orderId)).team_id as string;
  const buyerAccount = deriveYunxinAccountId({ provider: "yunxin", appId, realm: "user", kind: "USER", platformSubjectId: order.renter });
  const mainGroup = await groupRow(order.orderId);
  assert.equal(mainGroup.first_response_state, "RUNNING", JSON.stringify({ teamState: mainGroup.team_state, provision: mainGroup.provision_state,
    failure: mainGroup.team_failure, teamId: mainGroup.team_id, creates: wire.creates.length }));
  assert.equal((await pool.query(`SELECT availability FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=$2`, [appId, staff])).rows[0].availability, "OFF_DUTY");

  const escalationStaff=["a","b","c","d","e","f","g"].map(letter=>`oim4c_${letter}_${run}`);
  for(const id of escalationStaff){
    await seedAdmin(pool,id,`${id}_s`,run,false);
    await seedIdentity(pool,identityKey("ADMIN",id),run);
    await grantPermissions(id,["im.support.read","im.support.accept"]);
    await pool.query(`INSERT INTO zzsh_iam.im_support_presence(app_id,admin_user_id,availability,connection_state,last_connected_at)
      VALUES($1,$2,'OFF_DUTY','DISCONNECTED',NULL)`,[appId,id]);
    await pool.query(`INSERT INTO zzsh_supply.admin_supply_scope(admin_user_id,game_id,granted_by_admin_id) VALUES($1,$2,$1)`,[id,gameId]);
  }
  const escalationOptions:OrderTeamOptions={pool,appId,provider:wire.client,identities,membersLimit:200,firstResponseEnabled:true,escalationEnabled:true};
  const setEscalationStaff=async(ids:string[],available:boolean)=>pool.query(`UPDATE zzsh_iam.im_support_presence
    SET availability=$3,connection_state=$4,last_connected_at=CASE WHEN $3='AVAILABLE' THEN clock_timestamp() ELSE NULL END,
      version=version+1,updated_at=clock_timestamp() WHERE app_id=$1 AND admin_user_id=ANY($2::text[])`,
    [appId,ids,available?"AVAILABLE":"OFF_DUTY",available?"CONNECTED":"DISCONNECTED"]);
  const setEscalationDue=async(orderId:string,reminder:boolean,add:boolean)=>pool.query(`UPDATE zzsh_order.im_order_group
    SET remind_due_at=CASE WHEN $2 THEN clock_timestamp()-interval '1 second' ELSE remind_due_at END,
      next_add_due_at=CASE WHEN $3 THEN clock_timestamp()-interval '1 second' ELSE next_add_due_at END,version=version+1
    WHERE order_id=$1`,[orderId,reminder,add]);
  const escalationOps=async(orderId:string)=>(await pool.query(`SELECT id,kind,round,state,target_admin_id,sent_at,candidate_team_id,failure_class,version
    FROM zzsh_order.im_order_operation WHERE order_id=$1 ORDER BY kind,round`,[orderId])).rows;
  const driveEscalation=async(orderId:string,predicate:(group:any,ops:any[])=>boolean,label:string)=>{
    for(let tick=0;tick<50;tick++){
      const group=await groupRow(orderId),ops=await escalationOps(orderId);
      if(predicate(group,ops))return{group,ops};
      await scanOrderEscalations(escalationOptions,1);
    }
    assert.fail(`small-budget escalation did not reach ${label}`);
  };
  const staffActor={realm:"admin" as const,userId:staff,sessionId:`${staff}_s`};

  await t.test("T18 small legal budgets 1-4 eventually process due reminders in PostgreSQL",async()=>{
    for(const limit of [1,2,3,4]){
      const order=await makePaid(`OIM4C 小预算提醒${limit}`,"active",true);
      await setEscalationDue(order.orderId,true,false);
      for(let tick=0;tick<5;tick++)await scanOrderEscalations(escalationOptions,limit);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.im_order_event
        WHERE order_id=$1 AND type='first_response_reminder'`,[order.orderId])).rows[0].n,1,`limit ${limit} must reach the reminder phase`);
    }
  });

  const verifyCancelledUnsentAddReselection=async()=>{
    const [candidateA,candidateB]=escalationStaff;
    const order=await makePaid("OIM4C 取消候选可重选单","active",true),original=await groupRow(order.orderId);
    const team=original.team_id as string,addsBefore=wire.adds.length;
    try{
    await setEscalationStaff([candidateA!],true);await setEscalationDue(order.orderId,false,true);
    const first=await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.kind==="ADD_MEMBER"&&op.round===1&&op.state==="PENDING"),"round 1 plan");
    const add1=first.ops.find((op:any)=>op.kind==="ADD_MEMBER"&&op.round===1);
    assert.equal(add1?.target_admin_id,candidateA);assert.equal(add1?.sent_at,null);
    await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp()+interval '1 day'
      WHERE order_id=$1 AND kind='BOT_NOTICE'`,[order.orderId]);
    await setEscalationStaff([candidateA!],false);
    const cancelled1=await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.id===add1.id&&op.state==="CANCELLED"),"round 1 cancellation");
    const audit1=await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event
      WHERE action='im.order.escalation.add_cancelled' AND object_id=$1 AND request_id=$2`,[order.orderId,add1.id]);
    assert.equal(audit1.rows[0].n,1);assert.equal(add1.round,1);
    assert.equal(cancelled1.ops.find((op:any)=>op.id===add1.id)?.sent_at,null);
    assert.equal((await pool.query(`SELECT state FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=$1 AND mm.party='STAFF' AND m.platform_subject_id=$2`,[order.orderId,candidateA])).rows[0]?.state,"PLANNED");
    assert.equal(wire.adds.length,addsBefore);

    await setEscalationStaff([candidateA!],true);
    const second=await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.kind==="ADD_MEMBER"&&op.round===2&&op.state==="PENDING"),"round 2 replan");
    const add2=second.ops.find((op:any)=>op.kind==="ADD_MEMBER"&&op.round===2);
    assert.equal(add2?.target_admin_id,candidateA);assert.equal(add2?.sent_at,null);
    await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp()+interval '1 day'
      WHERE order_id=$1 AND kind='BOT_NOTICE' AND round=2`,[order.orderId]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=$1 AND mm.party='STAFF' AND m.platform_subject_id=$2`,[order.orderId,candidateA])).rows[0].n,1,
      "a later round reuses the historical PLANNED member row");

    await setEscalationStaff([candidateA!],false);await setEscalationStaff([candidateB!],true);
    await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.id===add2.id&&op.state==="CANCELLED"),"round 2 cancellation");
    const third=await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.kind==="ADD_MEMBER"&&op.round===3&&op.state==="PENDING"),"round 3 alternate candidate");
    const add3=third.ops.find((op:any)=>op.kind==="ADD_MEMBER"&&op.round===3);
    assert.equal(third.group.add_round,3);assert.equal(third.group.team_id,team);
    assert.equal(add3?.target_admin_id,candidateB);assert.equal(add3?.sent_at,null);
    assert.deepEqual(third.ops.filter((op:any)=>op.kind==="ADD_MEMBER").map((op:any)=>[op.round,op.state]),
      [[1,"CANCELLED"],[2,"CANCELLED"],[3,"PENDING"]]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=$1 AND mm.party='STAFF' AND m.platform_subject_id=$2`,[order.orderId,candidateB])).rows[0].n,1);
    const events=(await pool.query(`SELECT event_key FROM zzsh_order.im_order_event WHERE order_id=$1 AND type='add_member' ORDER BY event_key`,[order.orderId])).rows.map((row:any)=>row.event_key);
    assert.deepEqual(events,["add_member:1","add_member:2","add_member:3"]);
    assert.equal(wire.adds.length,addsBefore,"cancelled unsent rounds are never sent");
    }finally{
    await setEscalationStaff([candidateA!,candidateB!],false);
    }
  };

  await t.test("T19 same-Team escalation keeps history, rotates eligible staff, records one reminder, and continues after an unknown notice",async()=>{
    const [candidateA,candidateB]=escalationStaff;
    const order=await makePaid("OIM4C 同群轮值单","active",true);
    await setEscalationStaff([candidateA!,candidateB!],true);
    const original=await groupRow(order.orderId),team=original.team_id as string;
    await setEscalationDue(order.orderId,true,true);
    wire.noticeResponseLoss=true;
    await scanOrderEscalations(escalationOptions,100);
    wire.noticeResponseLoss=false;
    let group=await groupRow(order.orderId),operations=await escalationOps(order.orderId);
    let add=operations.find((op:any)=>op.kind==="ADD_MEMBER"&&op.round===1),notice=operations.find((op:any)=>op.kind==="BOT_NOTICE"&&op.round===1);
    assert.equal(group.add_round,1);assert.equal(group.team_id,team);assert.equal(group.assigned_admin_id,staff);
    assert.equal(group.responsible_admin_id,candidateA);assert.equal(group.escalation_state,"RUNNING");
    assert.equal(add?.state,"SUCCEEDED");assert.equal(add?.candidate_team_id,team);assert.equal(notice?.state,"NEEDS_REVIEW");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.im_order_event WHERE order_id=$1 AND type='first_response_reminder'`,[order.orderId])).rows[0].n,1);
    let joined=(await pool.query(`SELECT m.platform_subject_id FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=$1 AND mm.party='STAFF' AND mm.state='JOINED' ORDER BY m.platform_subject_id`,[order.orderId])).rows.map((row:any)=>row.platform_subject_id);
    assert.ok(joined.includes(staff)&&joined.includes(candidateA));
    let projection=await withTransaction(pool,c=>readOrderTeamAccess(c,staffActor,order.orderId));
    assert.equal((projection.supportEscalation as any).addRound,1);assert.equal((projection.supportEscalation as any).state,"RUNNING");
    assert.equal((projection.members as any[]).find(member=>member.platformId===candidateA)?.responsible,true);
    const directory=await withTransaction(pool,c=>listJoinedOrderTeams(c,staffActor,null,20));
    assert.equal((directory.items as any[]).find(item=>item.id===order.orderId)?.addRound,1);
    await setEscalationDue(order.orderId,false,true);
    await scanOrderEscalations(escalationOptions,100);
    group=await groupRow(order.orderId);operations=await escalationOps(order.orderId);
    add=operations.find((op:any)=>op.kind==="ADD_MEMBER"&&op.round===2);
    assert.equal(group.add_round,2);assert.equal(group.responsible_admin_id,candidateB);
    assert.equal(add?.state,"SUCCEEDED","round-one BOT_NOTICE review must not block the next ADD");
    joined=(await pool.query(`SELECT m.platform_subject_id FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=$1 AND mm.party='STAFF' AND mm.state='JOINED' ORDER BY m.platform_subject_id`,[order.orderId])).rows.map((row:any)=>row.platform_subject_id);
    assert.ok(joined.includes(staff)&&joined.includes(candidateA)&&joined.includes(candidateB));
    await setEscalationDue(order.orderId,false,true);
    await scanOrderEscalations(escalationOptions,100);
    group=await groupRow(order.orderId);assert.equal(group.escalation_state,"EXHAUSTED");
    projection=await withTransaction(pool,c=>readOrderTeamAccess(c,staffActor,order.orderId));
    assert.equal((projection.supportEscalation as any).noEligibleStaff,true);
    assert.equal((projection.supportEscalation as any).needsManualReview,true);
    const adminOrders=await withTransaction(pool,c=>listAdminOrders(c,{adminId:staff,isBoss:false,internalQuote:false},{gameId,limit:100}));
    const adminSummary=(adminOrders.items as any[]).find(item=>item.id===order.orderId);
    assert.equal(adminSummary?.supportEscalation?.state,"EXHAUSTED");
    assert.equal(adminSummary?.supportEscalation?.noEligibleStaff,true);
    assert.deepEqual(Object.keys(adminSummary?.supportEscalation??{}).sort(),["addRound","firstResponseAt","needsManualReview","noEligibleStaff","remindDueAt","state"]);
    await setEscalationStaff([candidateA!,candidateB!],false);
  });

  await t.test("T19b cancelled unsent ADD keeps its audit and member binding while new rounds reselect",verifyCancelledUnsentAddReselection);

  await t.test("T20 verified first response cancels only unsent ADD and BOT operations",async()=>{
    const candidate=escalationStaff[2]!;
    const order=await makePaid("OIM4C 首响取消未发送操作单","active",true),group=await groupRow(order.orderId);
    await setEscalationStaff([candidate],true);
    await setEscalationDue(order.orderId,true,true);
    const {ops:before}=await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.kind==="ADD_MEMBER"&&op.state==="PENDING"),"unsent ADD plan");
    assert.equal(before.find((op:any)=>op.kind==="ADD_MEMBER")?.state,"PENDING");
    assert.equal(before.find((op:any)=>op.kind==="BOT_NOTICE")?.state,"PENDING");
    const addCalls=wire.adds.length;
    await confirmFirstResponse(order.orderId,group.team_id as string,"4291065454174145991");
    const after=await escalationOps(order.orderId),stopped=await groupRow(order.orderId);
    assert.equal(stopped.escalation_state,"STOPPED");assert.equal(stopped.remind_due_at,null);assert.equal(stopped.next_add_due_at,null);
    assert.ok(after.filter((op:any)=>["ADD_MEMBER","BOT_NOTICE"].includes(op.kind)).every((op:any)=>op.state==="CANCELLED"&&op.sent_at===null));
    assert.equal(wire.adds.length,addCalls);
    await setEscalationStaff([candidate],false);
  });

  await t.test("T21 target requalification is checked before ADD and a lost candidate is never sent",async()=>{
    const candidate=escalationStaff[3]!;
    const order=await makePaid("OIM4C 候选失格单","active",true);
    await setEscalationStaff([candidate],true);
    await setEscalationDue(order.orderId,true,true);
    const plannedResult=await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.kind==="ADD_MEMBER"&&op.state==="PENDING"),"candidate ADD plan");
    const planned=plannedResult.ops.find((op:any)=>op.kind==="ADD_MEMBER");
    assert.equal(planned?.target_admin_id,candidate);
    await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp()+interval '1 day'
      WHERE order_id=$1 AND kind='BOT_NOTICE'`,[order.orderId]);
    await setEscalationStaff([candidate],false);
    const addCalls=wire.adds.length;await scanOrderEscalations(escalationOptions,100);
    const after=(await escalationOps(order.orderId)).find((op:any)=>op.id===planned?.id);
    assert.equal(after?.state,"CANCELLED");assert.equal(after?.sent_at,null);assert.equal(wire.adds.length,addCalls);
    assert.ok(new Date((await groupRow(order.orderId)).next_add_due_at).getTime()<=Date.now()+5000);
    await scanOrderEscalations(escalationOptions,100);
    assert.equal((await groupRow(order.orderId)).escalation_state,"EXHAUSTED");
  });

  await t.test("T22 unknown ADD outcome enters review and recovery only reads the same Team",async()=>{
    const candidate=escalationStaff[4]!;
    const order=await makePaid("OIM4C ADD未知结果单","active",true);
    await setEscalationStaff([candidate],true);
    await setEscalationDue(order.orderId,true,true);
    const plannedResult=await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.kind==="ADD_MEMBER"&&op.state==="PENDING"),"unknown-outcome ADD plan");
    await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp()+interval '1 day'
      WHERE order_id=$1 AND kind='BOT_NOTICE'`,[order.orderId]);
    const planned=plannedResult.ops.find((op:any)=>op.kind==="ADD_MEMBER");
    const addCalls=wire.adds.length;wire.rejectAddCode=500;
    await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.id===planned?.id&&op.state==="NEEDS_REVIEW"),"unknown ADD outcome");wire.rejectAddCode=undefined;
    let operation=(await escalationOps(order.orderId)).find((op:any)=>op.id===planned?.id);
    assert.equal(operation?.state,"NEEDS_REVIEW");assert.equal(operation?.failure_class,"ADD_OUTCOME_UNKNOWN");assert.ok(operation?.sent_at);
    assert.equal((await groupRow(order.orderId)).escalation_state,"VERIFY_REQUIRED");
    assert.equal(wire.adds.length,addCalls+1);
    await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[planned?.id]);
    const teamReads=wire.calls.filter(call=>call.startsWith("GET /im/v2.1/teams/")).length;
    for(let tick=0;tick<5;tick++)await scanOrderEscalations(escalationOptions,1);
    operation=(await escalationOps(order.orderId)).find((op:any)=>op.id===planned?.id);
    assert.equal(operation?.state,"NEEDS_REVIEW");assert.equal(wire.adds.length,addCalls+1,"unknown add is never blindly resent");
    assert.ok(wire.calls.filter(call=>call.startsWith("GET /im/v2.1/teams/")).length>teamReads,"small-budget recovery reads the same Team");
    await setEscalationStaff([candidate],false);
  });

  await t.test("T23 concurrent workers share one ADD claim; first response cannot undo an already-sent add",async()=>{
    const candidate=escalationStaff[5]!;
    const order=await makePaid("OIM4C 双worker首响竞态单","active",true),group=await groupRow(order.orderId);
    await setEscalationStaff([candidate],true);
    await setEscalationDue(order.orderId,true,true);
    await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.kind==="ADD_MEMBER"&&op.state==="PENDING"),"concurrent ADD plan");
    await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp()+interval '1 day'
      WHERE order_id=$1 AND kind='BOT_NOTICE'`,[order.orderId]);
    let arrived!:()=>void,release!:()=>void,timedOut=false;
    const reached=new Promise<void>(resolve=>{arrived=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const watchdog=setTimeout(()=>{timedOut=true;arrived();release();},10_000);
    wire.beforeAddResponse=async()=>{arrived();await gate;};
    const addCalls=wire.adds.length;
    const lifecycle=new OrderTeamLifecycle();let workerB:Promise<void>|undefined,shutdown:Promise<void>|undefined,drained=false;
    try{
      lifecycle.start(escalationOptions,60_000,100);
      await reached;assert.equal(timedOut,false,"the lifecycle must reach the controlled provider barrier");
      workerB=scanOrderEscalations(escalationOptions,100);
      shutdown=lifecycle.beforeApplicationShutdown().then(()=>{drained=true;});
      await Promise.resolve();assert.equal(drained,false,"shutdown must wait for the in-flight ADD");
      const running=(await escalationOps(order.orderId)).find((op:any)=>op.kind==="ADD_MEMBER");
      assert.equal(running?.state,"RUNNING");assert.ok(running?.sent_at);
      await confirmFirstResponse(order.orderId,group.team_id as string,"4291065454174145992");
      const stopped=await groupRow(order.orderId);assert.equal(stopped.escalation_state,"STOPPED");
      const during=(await escalationOps(order.orderId)).find((op:any)=>op.kind==="ADD_MEMBER");assert.equal(during?.state,"RUNNING");
    }finally{
      clearTimeout(watchdog);release();wire.beforeAddResponse=undefined;
      await Promise.allSettled([...(workerB?[workerB]:[]),...(shutdown?[shutdown]:[])]);
      if(!shutdown)await lifecycle.beforeApplicationShutdown();
    }
    assert.equal(drained,true,"shutdown drains the completed escalation scan");
    const finalGroup=await groupRow(order.orderId),finalOps=await escalationOps(order.orderId);
    const add=finalOps.find((op:any)=>op.kind==="ADD_MEMBER"),bot=finalOps.find((op:any)=>op.kind==="BOT_NOTICE");
    assert.equal(wire.adds.length,addCalls+1);assert.equal(add?.state,"SUCCEEDED");assert.equal(bot?.state,"CANCELLED");
    assert.equal(finalGroup.responsible_admin_id,staff);assert.equal(finalGroup.next_add_due_at,null);
    assert.equal((await pool.query(`SELECT state FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=$1 AND mm.party='STAFF' AND m.platform_subject_id=$2`,[order.orderId,candidate])).rows[0]?.state,"JOINED");
    await setEscalationStaff([candidate],false);
  });

  await t.test("T24 expired sent ADD lease is quarantined and its recovery remains read-only",async()=>{
    const candidate=escalationStaff[6]!;
    const order=await makePaid("OIM4C 过期租约单","active",true);
    await setEscalationStaff([candidate],true);
    await setEscalationDue(order.orderId,true,true);
    await driveEscalation(order.orderId,(_group,ops)=>ops.some((op:any)=>op.kind==="ADD_MEMBER"&&op.state==="PENDING"),"expired-lease ADD plan");
    await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp()+interval '1 day'
      WHERE order_id=$1 AND kind='BOT_NOTICE'`,[order.orderId]);
    const planned=(await escalationOps(order.orderId)).find((op:any)=>op.kind==="ADD_MEMBER");
    await pool.query(`UPDATE zzsh_order.im_order_operation SET state='RUNNING',version=version+1,attempt_count=attempt_count+1,
        lease_until=clock_timestamp()-interval '1 second',lease_token_hash=repeat('a',64),sent_at=clock_timestamp()
      WHERE id=$1 AND state='PENDING'`,[planned?.id]);
    const addCalls=wire.adds.length;await scanOrderEscalations(escalationOptions,100);
    let operation=(await escalationOps(order.orderId)).find((op:any)=>op.id===planned?.id);
    assert.equal(operation?.state,"NEEDS_REVIEW");assert.equal(operation?.failure_class,"STALE_OPERATION");
    assert.equal((await groupRow(order.orderId)).escalation_state,"VERIFY_REQUIRED");assert.equal(wire.adds.length,addCalls);
    await pool.query(`UPDATE zzsh_order.im_order_operation SET next_retry_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[planned?.id]);
    const teamReads=wire.calls.filter(call=>call.startsWith("GET /im/v2.1/teams/")).length;
    for(let tick=0;tick<5;tick++)await scanOrderEscalations(escalationOptions,1);
    operation=(await escalationOps(order.orderId)).find((op:any)=>op.id===planned?.id);
    assert.equal(operation?.state,"NEEDS_REVIEW");assert.equal(wire.adds.length,addCalls,"expired sent lease may only read the persisted Team");
    assert.ok(wire.calls.filter(call=>call.startsWith("GET /im/v2.1/teams/")).length>teamReads);
    await setEscalationStaff([candidate],false);
  });

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

    // A same-key resend without a trustworthy source quarantines the original pending WEB fact.
    const sourceConflict = await makePaid("OIM4D1 来源冲突待核单", "active");
    const conflictTeam = (await groupRow(sourceConflict.orderId)).team_id as string;
    const conflictServerId = "4291065454174145192";
    const conflictClientId = `sourceconflict_${randomUUID()}`;
    const conflictAt = Date.now();
    const originalWeb = copyBody(staffAccount, conflictServerId, conflictTeam, {
      msgidClient: conflictClientId, msgTimestamp: String(conflictAt),
    });
    assert.equal((await signedRequest(COPY_PATH, originalWeb, { base: hooks.base })).status, 200);
    assert.equal((await deliveryRow(sourceConflict.orderId, conflictServerId))?.status, "WAITING_AUTH");
    assert.equal((await groupRow(sourceConflict.orderId)).first_response_state, "RUNNING");

    const verifyAuditsBefore = await auditCount("im.order.first_response.verify_required");
    const missingSourceRetry = copyBody(staffAccount, conflictServerId, conflictTeam, {
      msgidClient: conflictClientId, msgTimestamp: String(conflictAt), fromClientType: undefined,
    });
    assert.equal((await signedRequest(COPY_PATH, missingSourceRetry, { base: hooks.base })).status, 200);
    assert.equal((await deliveryRow(sourceConflict.orderId, conflictServerId))?.status, "VERIFY_REQUIRED");
    assert.equal((await groupRow(sourceConflict.orderId)).first_response_state, "VERIFY_REQUIRED");
    assert.equal(await verifyMarkerCount(sourceConflict.orderId), 1);
    assert.equal(await auditCount("im.order.first_response.verify_required"), verifyAuditsBefore + 1);

    const illegalSourceRetry = copyBody(staffAccount, conflictServerId, conflictTeam, {
      msgidClient: conflictClientId, msgTimestamp: String(conflictAt), fromClientType: { nested: 8 },
    });
    assert.equal((await signedRequest(COPY_PATH, illegalSourceRetry, { base: hooks.base })).status, 200);
    assert.equal(await verifyMarkerCount(sourceConflict.orderId), 1, "repeated source conflict evidence is idempotent");
    assert.equal(await auditCount("im.order.first_response.verify_required"), verifyAuditsBefore + 1,
      "repeated source conflict does not duplicate its audit");

    const lateApproval = await signedRequest(PRE_SEND_PATH, preSendBody(conflictTeam, staffAccount, {
      msgidClient: conflictClientId, msgTimestamp: String(conflictAt),
    }), { base: hooks.base });
    assert.equal(lateApproval.body?.errCode, 0);
    assert.equal((await eventRows(sourceConflict.orderId)).some((row) => row.type === "send_approved"
      && row.status === "VERIFIED" && row.message_client_id === conflictClientId), true);
    await recoverOrderFirstResponse({ pool, appId, appSecret: ORDER_IM_EVENT_SECRET }, { limit: 20, maxTotal: 200 });
    assert.equal((await deliveryRow(sourceConflict.orderId, conflictServerId))?.status, "VERIFY_REQUIRED");
    const quarantined = await groupRow(sourceConflict.orderId);
    assert.equal(quarantined.first_response_state, "VERIFY_REQUIRED");
    assert.equal(quarantined.first_response_at, null);
    assert.equal(quarantined.first_response_event_id, null);
    assert.equal((await eventRows(sourceConflict.orderId)).filter((row) => row.type === "first_response").length, 0);

    // WEB and its documented numeric alias 16 remain the same duplicate fact and can resolve normally.
    const aliasOrder = await makePaid("OIM4D1 WEB数字别名正常重送单", "active");
    const aliasTeam = (await groupRow(aliasOrder.orderId)).team_id as string;
    const aliasServerId = "4291065454174145191";
    const aliasClientId = `webalias_${randomUUID()}`;
    const aliasAt = Date.now();
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, aliasServerId, aliasTeam, {
      msgidClient: aliasClientId, msgTimestamp: String(aliasAt),
    }), { base: hooks.base })).status, 200);
    assert.equal((await signedRequest(COPY_PATH, copyBody(staffAccount, aliasServerId, aliasTeam, {
      msgidClient: aliasClientId, msgTimestamp: String(aliasAt), fromClientType: 16,
    }), { base: hooks.base })).status, 200);
    assert.equal((await deliveryRow(aliasOrder.orderId, aliasServerId))?.status, "WAITING_AUTH");
    assert.equal(await verifyMarkerCount(aliasOrder.orderId), 0);
    assert.equal((await signedRequest(PRE_SEND_PATH, preSendBody(aliasTeam, staffAccount, {
      msgidClient: aliasClientId, msgTimestamp: String(aliasAt),
    }), { base: hooks.base })).body?.errCode, 0);
    assert.equal((await deliveryRow(aliasOrder.orderId, aliasServerId))?.status, "VERIFIED");
    assert.equal((await groupRow(aliasOrder.orderId)).first_response_state, "STOPPED");
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
