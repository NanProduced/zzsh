import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import type { PoolClient } from "pg";
import * as adminAuthorization from "../src/auth/admin-authorization";
import * as adminScope from "../src/auth/admin-scope";
import * as authSecurity from "../src/auth/auth-security";
import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey } from "../src/im/identity-lifecycle";
import { inviteOrderTeamAdmin, listOrderTeamInviteTargets } from "../src/im/order-team-invite";
import { ORDER_TEAM_CONFIGURATION, YunxinTransportError, type YunxinOrderTeamState } from "../src/im/yunxin-provider";
import * as orderRoutes from "../src/order/order-routes";

const APP = "app_order_invite";
const ORDER = "order_invite_1";
const GAME = "game_invite";
const TEAM_ID = "930000001";
const TEAM_NAME = "三角洲行动|订单:ZZINVITE";
const RENTER = "user_renter_invite";
const OWNER = "user_owner_invite";
const STAFF = "admin_staff_invite";
const TARGET = "admin_target_invite";
const OTHER = "admin_other_invite";
const ACTOR = { userId: STAFF, sessionId: "session_staff_invite" };

function identity(realm: "user" | "admin" | "system", kind: "USER" | "ADMIN" | "SYSTEM", subject: string, appId = APP) {
  const key: ImIdentityKey = { provider: "yunxin", appId, realm, kind, platformSubjectId: subject };
  return { key, accountId: deriveYunxinAccountId(key), marker: buildYunxinIdentityMarker(key) };
}
const system = identity("system", "SYSTEM", "support-manager");
const buyerAccount = identity("user", "USER", RENTER);
const ownerAccount = identity("user", "USER", OWNER);
const staffAccount = identity("admin", "ADMIN", STAFF);
const targetAccount = identity("admin", "ADMIN", TARGET);

function memberRow(party: "BUYER"|"OWNER"|"STAFF", realm: "user"|"admin", kind: "USER"|"ADMIN", subject: string, name: string) {
  const item = identity(realm, kind, subject);
  return { party, state: "JOINED" as const, platform_subject_id: subject, identity_kind: kind, realm,
    account_id: item.accountId, status: "READY", identity_marker: item.marker, name, avatar: null };
}

function team(): YunxinOrderTeamState {
  return {
    teamId: TEAM_ID, ownerAccountId: system.accountId,
    serverExtension: JSON.stringify({ schema: "zzsh.im-order.v1", appId: APP, orderId: ORDER }),
    teamType: 1, name: TEAM_NAME, membersLimit: 10, configuration: { ...ORDER_TEAM_CONFIGURATION },
    members: [
      { accountId: system.accountId, role: 1, chatBanned: false },
      { accountId: buyerAccount.accountId, role: 0, chatBanned: false },
      { accountId: ownerAccount.accountId, role: 0, chatBanned: false },
      { accountId: staffAccount.accountId, role: 0, chatBanned: false },
    ],
  };
}

type Write = { kind: "INSERT"|"UPDATE"; party: string; state: string; identityId: string; subject: string };
type Statement = { sql: string; values: unknown[] };

class InviteDatabase {
  group: Record<string, unknown> | null;
  target: Record<string, unknown> | null = { admin_user_id: TARGET, display_name: "客服二号", suspended: false, security_status: "ACTIVE" };
  targetIdentity: Record<string, unknown> | null = { id: "im_admin_target_invite", account_id: targetAccount.accountId,
    platform_subject_id: TARGET, realm: "admin", identity_kind: "ADMIN", status: "READY", identity_marker: targetAccount.marker };
  existing: Record<string, unknown> | null = null;
  operations: { kind: string; state: string }[] = [];
  readonly members = [
    memberRow("BUYER", "user", "USER", RENTER, "租客"),
    memberRow("OWNER", "user", "USER", OWNER, "号主"),
    memberRow("STAFF", "admin", "ADMIN", STAFF, "客服一号"),
  ];
  readonly admins = [
    { id: TARGET, name: "客服二号" }, { id: OTHER, name: "客服三号" }, { id: STAFF, name: "客服一号" },
    { id: "admin_no_im_invite", name: "未开通云信" },
  ];
  readonly statements: Statement[] = [];
  readonly writes: Write[] = [];
  readonly audits: Record<string, unknown>[] = [];
  constructor(group: Record<string, unknown> | null = {
    order_id: ORDER, app_id: APP, assigned_admin_id: STAFF, responsible_admin_id: STAFF,
    team_state: "READY", team_id: TEAM_ID, team_name: TEAM_NAME, members_limit: 10,
    game_id: GAME, account_id: "account_invite", order_status: "PAID",
    system_account: system.accountId, system_status: "READY", system_marker: system.marker, system_subject: "support-manager",
  }) { this.group = group; }
  readonly query = async (sql: string, values: unknown[] = []): Promise<{ rows: any[]; rowCount?: number }> => {
    this.statements.push({ sql, values: [...values] });
    if (sql.includes("m.account_id AS system_account")) {
      return { rows: this.group && values[0] === ORDER && values[1] === APP ? [this.group] : [] };
    }
    if (sql.includes("s.status AS security_status")) {
      return { rows: this.target && values[0] === this.target.admin_user_id ? [this.target] : [] };
    }
    if (sql.includes("platform_subject_id=$2 FOR SHARE")) {
      return { rows: this.targetIdentity && values[0] === APP && values[1] === TARGET ? [this.targetIdentity] : [] };
    }
    if (sql.includes("SELECT mm.identity_id,mm.party,mm.state,m.platform_subject_id")) {
      return { rows: this.existing ? [this.existing] : [] };
    }
    if (sql.includes('SELECT u.id AS "adminUserId"')) {
      const [orderId, appId, limit, assigned, responsible] = values as [string, string, number, string|null, string|null];
      const joined = new Set(this.members.map(item => item.platform_subject_id));
      const rows = this.admins
        .filter(item => item.id !== "admin_no_im_invite" && item.id !== assigned && item.id !== responsible && !joined.has(item.id))
        .slice(0, limit)
        .map(item => ({ adminUserId: item.id, displayName: item.name }));
      return { rows: orderId === ORDER && appId === APP ? rows : [] };
    }
    if (sql.includes("LEFT JOIN zzsh_auth_user")) return { rows: this.members };
    if (sql.includes("INSERT INTO zzsh_order.im_order_member")) {
      const [, , identityId] = values as [string, string, string];
      if (this.existing) return { rows: [], rowCount: 0 };
      this.existing = { identity_id: identityId, party: "STAFF", state: "JOINED", platform_subject_id: TARGET };
      this.members.push({ ...memberRow("STAFF", "admin", "ADMIN", TARGET, "客服二号"), identity_id: identityId } as never);
      this.writes.push({ kind: "INSERT", party: "STAFF", state: "JOINED", identityId, subject: TARGET });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE zzsh_order.im_order_member")) {
      const [, , identityId] = values as [string, string, string];
      if (!this.existing || this.existing.identity_id !== identityId) return { rows: [], rowCount: 0 };
      this.existing = { ...this.existing, state: "JOINED" };
      const row = this.members.find(item => item.platform_subject_id === TARGET);
      if (row) (row as { state: string }).state = "JOINED";
      else this.members.push({ ...memberRow("STAFF", "admin", "ADMIN", TARGET, "客服二号"), identity_id: identityId } as never);
      this.writes.push({ kind: "UPDATE", party: "STAFF", state: "JOINED", identityId, subject: TARGET });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) {
      this.audits.push({ actorType: values[1], actorId: values[2], sessionId: values[3], action: values[4],
        objectType: values[5], objectId: values[6], outcome: values[7], requestId: values[8], details: JSON.parse(String(values[10])) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("set_config('zzsh.actor_type'")) return { rows: [] };
    if (sql.includes("SELECT id FROM zzsh_order.rental_order WHERE id=$1 FOR UPDATE")) return { rows: [{ id: ORDER }] };
    if (sql.includes("SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE")) return { rows: [{ order_id: ORDER }] };
    if (sql.includes("FROM zzsh_order.im_order_operation")) return { rows: this.operations };
    throw new Error("UNEXPECTED_SQL " + sql);
  };
}

class FakeTeamProvider {
  readonly state = team();
  creates = 0;
  adds: { teamId: string; operator: string; member: string }[] = [];
  reads = 0;
  failRead = false;
  failAdd = false;
  failReadAfterAdd = false;
  async createOrderTeam(): Promise<{ teamId: string; partial: boolean }> { this.creates += 1; return { teamId: "999", partial: false }; }
  async readOrderTeam(id: string): Promise<YunxinOrderTeamState | null> {
    this.reads += 1;
    if (id !== TEAM_ID) return null;
    if (this.failRead || (this.failReadAfterAdd && this.adds.length > 0)) throw new YunxinTransportError("read-order-team");
    return JSON.parse(JSON.stringify(this.state)) as YunxinOrderTeamState;
  }
  async addSupportTeamMember(teamId: string, operator: string, member: string): Promise<void> {
    if (this.failAdd) throw new YunxinTransportError("add-support-team-member");
    this.adds.push({ teamId, operator, member });
    if (!this.state.members.some(item => item.accountId === member)) {
      this.state.members.push({ accountId: member, role: 0, chatBanned: false });
    }
  }
  async sendOrderTeamNotice(): Promise<void> { throw new Error("unexpected notice"); }
}

function mockAccess(t: TestContext, permissions = ["im.support.read"], scope: { mode: "ALL_GAMES"|"SELECTED_GAMES"; gameIds: string[] } = { mode: "ALL_GAMES", gameIds: [] }) {
  t.mock.method(authSecurity, "assertAdminContextInTransaction", async () => {});
  t.mock.method(adminAuthorization, "loadEffectiveAdminAccess", async () => ({ status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(permissions) }));
  t.mock.method(adminScope, "readAdminGameScope", async () => scope);
}

const client = (db: InviteDatabase) => db as unknown as Pick<PoolClient, "query">;
const invoke = (db: InviteDatabase, provider: FakeTeamProvider, target = TARGET) =>
  inviteOrderTeamAdmin(client(db), { appId: APP, provider }, ACTOR, ORDER, target, "req_order_invite");
const statusIs = (status: number) => (error: unknown) => (error as { status?: number }).status === status;

test("invite adds the admin once, audits once and returns the shared member projection", async t => {
  mockAccess(t);
  const db = new InviteDatabase(), provider = new FakeTeamProvider();
  const first = await invoke(db, provider);
  assert.equal(first.status, "JOINED");
  assert.equal(provider.creates, 0, "an invite never creates a second Team");
  assert.deepEqual(provider.adds, [{ teamId: TEAM_ID, operator: system.accountId, member: targetAccount.accountId }]);
  assert.equal(db.writes.length, 1);
  assert.deepEqual(db.writes[0], { kind: "INSERT", party: "STAFF", state: "JOINED", identityId: "im_admin_target_invite", subject: TARGET });
  assert.equal(db.audits.length, 1);
  assert.equal(db.audits[0]!.action, "im.order.team.member.invited");
  assert.equal(db.audits[0]!.objectId, ORDER);
  assert.deepEqual(first.members.map(item => item.platformId).sort(), [RENTER, OWNER, STAFF, TARGET].sort());
  assert.equal(first.members.find(item => item.platformId === STAFF)!.responsible, true);
  assert.equal(first.members.find(item => item.platformId === TARGET)!.party, "STAFF");
  assert.deepEqual(first.members.filter(item => item.party !== "STAFF").map(item => [item.membershipStatus, item.identityStatus]),
    [["UNKNOWN", "UNKNOWN"], ["UNKNOWN", "UNKNOWN"]]);
  assert.equal(JSON.stringify(first.members).includes("im_admin_target_invite"), false, "the response never exposes identity mapping IDs");
  assert.equal(JSON.stringify(first).includes(TEAM_ID), false, "the response never exposes the Team ID");

  const second = await invoke(db, provider);
  assert.equal(second.status, "ALREADY_JOINED");
  assert.equal(provider.adds.length, 1, "a repeated invite does not add the member again");
  assert.equal(provider.creates, 0);
  assert.equal(db.writes.length, 1, "a repeated invite does not write membership again");
  assert.equal(db.audits.length, 1, "a repeated invite does not duplicate its audit");
  assert.deepEqual(second.members.map(item => item.platformId).sort(), [RENTER, OWNER, STAFF, TARGET].sort());
});

test("an unresolved escalation member change blocks a manual invite", async t => {
  mockAccess(t);
  const db = new InviteDatabase(), provider = new FakeTeamProvider();
  db.operations = [{ kind: "ADD_MEMBER", state: "RUNNING" }];
  await assert.rejects(invoke(db, provider), statusIs(409));
  assert.equal(provider.reads, 0);
  assert.equal(db.writes.length, 0);
});

test("invite target validation rejects missing, suspended and identity-pending administrators before the provider", async t => {
  mockAccess(t);
  const cases: Array<[string, (db: InviteDatabase) => void, number]> = [
    ["missing admin", db => { db.target = null; }, 404],
    ["suspended admin", db => { db.target = { ...db.target!, suspended: true }; }, 409],
    ["not active admin", db => { db.target = { ...db.target!, security_status: "PENDING_ENROLLMENT" }; }, 409],
    ["user/renter id", db => { db.target = null; }, 404],
    ["missing IM identity", db => { db.targetIdentity = null; }, 409],
    ["pending IM identity", db => { db.targetIdentity = { ...db.targetIdentity!, status: "PENDING" }; }, 409],
  ];
  for (const [label, mutate, status] of cases) {
    const db = new InviteDatabase(), provider = new FakeTeamProvider();
    mutate(db);
    const target = label === "user/renter id" ? RENTER : TARGET;
    await assert.rejects(invoke(db, provider, target), statusIs(status), label);
    assert.equal(provider.reads, 0, `${label} must fail before reading the remote Team`);
    assert.equal(provider.adds.length, 0, `${label} must not add a member`);
    assert.equal(provider.creates, 0, `${label} must not create a Team`);
    assert.equal(db.writes.length, 0, `${label} must not write membership`);
    assert.equal(db.audits.length, 0, `${label} must not audit a success`);
  }
});

test("object and game scope denial fail closed before any provider or member write", async t => {
  const fixture = () => new InviteDatabase();
  const request = async (db: InviteDatabase, provider: FakeTeamProvider) => invoke(db, provider).catch(error => error);

  mockAccess(t, ["im.support.read"], { mode: "SELECTED_GAMES", gameIds: ["other_game"] });
  let db = fixture(), provider = new FakeTeamProvider();
  assert.equal((await request(db, provider)).status, 403);
  assert.equal(provider.reads, 0);
  assert.equal(db.writes.length, 0);
  t.mock.restoreAll();

  mockAccess(t, []);
  db = fixture(); provider = new FakeTeamProvider();
  assert.equal((await request(db, provider)).status, 403);
  assert.equal(provider.reads, 0);
  assert.equal(db.writes.length, 0);
  t.mock.restoreAll();

  mockAccess(t);
  db = fixture(); db.group = null; provider = new FakeTeamProvider();
  assert.equal((await request(db, provider)).status, 404);
  assert.equal(provider.reads, 0);
  t.mock.restoreAll();

  mockAccess(t);
  db = fixture(); db.group = { ...db.group!, team_state: "CREATING" }; provider = new FakeTeamProvider();
  assert.equal((await request(db, provider)).status, 409);
  assert.equal(provider.reads, 0);
  t.mock.restoreAll();

  mockAccess(t);
  db = fixture(); db.group = { ...db.group!, order_status: "COMPLETED" }; provider = new FakeTeamProvider();
  assert.equal((await request(db, provider)).status, 409);
  assert.equal(provider.reads, 0);
  assert.equal(db.writes.length, 0);
});

test("an invite changes only the target STAFF row and never the buyer, owner or responsible admin", async t => {
  mockAccess(t);
  const db = new InviteDatabase(), provider = new FakeTeamProvider();
  const before = db.members.map(item => ({ ...item }));
  await invoke(db, provider);
  assert.deepEqual(db.writes.map(item => item.party), ["STAFF"]);
  assert.deepEqual(provider.adds.map(item => item.member), [targetAccount.accountId]);
  for (const party of ["BUYER", "OWNER"] as const) {
    assert.deepEqual(db.members.find(item => item.party === party), before.find(item => item.party === party));
    assert.ok(provider.state.members.some(item => item.accountId === (party === "BUYER" ? buyerAccount : ownerAccount).accountId));
  }
  assert.ok(provider.state.members.some(item => item.accountId === staffAccount.accountId && item.role === 0));
  assert.equal(db.group!.responsible_admin_id, STAFF);
  assert.equal(db.statements.some(item => /DELETE FROM zzsh_order\.im_order_member/i.test(item.sql)), false);
});

test("an unavailable provider fails closed without member or audit writes, then repairs on retry", async t => {
  mockAccess(t);
  for (const mode of ["read", "add"] as const) {
    const db = new InviteDatabase(), provider = new FakeTeamProvider();
    if (mode === "read") provider.failRead = true; else provider.failAdd = true;
    await assert.rejects(invoke(db, provider), statusIs(503), mode);
    assert.equal(db.writes.length, 0, `${mode} failure must not write membership`);
    assert.equal(db.audits.length, 0, `${mode} failure must not audit success`);
    assert.equal(provider.creates, 0, `${mode} failure must not create a Team`);
  }

  const db = new InviteDatabase(), provider = new FakeTeamProvider();
  provider.failReadAfterAdd = true;
  await assert.rejects(invoke(db, provider), statusIs(503));
  assert.equal(provider.adds.length, 1);
  assert.equal(db.writes.length, 0);
  assert.equal(db.audits.length, 0);
  provider.failReadAfterAdd = false;
  const repaired = await invoke(db, provider);
  assert.equal(repaired.status, "JOINED");
  assert.equal(provider.adds.length, 1, "the repair read detects the existing remote member and does not add again");
  assert.equal(db.writes.length, 1);
  assert.equal(db.audits.length, 1);
});

test("invite targets are narrow, bounded and exclude existing staff", async t => {
  mockAccess(t);
  const db = new InviteDatabase();
  const result = await listOrderTeamInviteTargets(client(db), ACTOR, APP, ORDER, 10);
  assert.deepEqual(result, { targets: [{ adminUserId: TARGET, displayName: "客服二号" }, { adminUserId: OTHER, displayName: "客服三号" }] });
  assert.deepEqual(Object.keys(result.targets[0]!).sort(), ["adminUserId", "displayName"]);
  for (const item of result.targets) {
    assert.equal(JSON.stringify(item).includes("accountId"), false);
    assert.equal(JSON.stringify(item).includes("teamId"), false);
  }
  const statement = db.statements.find(item => item.sql.includes('SELECT u.id AS "adminUserId"'))!;
  assert.match(statement.sql, /LIMIT \$3/);
  assert.deepEqual(statement.values.slice(0, 3), [ORDER, APP, 10]);

  await assert.rejects(listOrderTeamInviteTargets(client(db), ACTOR, APP, ORDER, 51), statusIs(400));
  t.mock.restoreAll();
  mockAccess(t, ["im.support.read"], { mode: "SELECTED_GAMES", gameIds: ["other_game"] });
  await assert.rejects(listOrderTeamInviteTargets(new InviteDatabase() as unknown as Pick<PoolClient, "query">, ACTOR, APP, ORDER, 10), statusIs(403));
});

const ADMIN_ORIGIN = "http://127.0.0.1:4291";
const API_ORIGIN = "http://127.0.0.1:4292";
function capture() {
  let status = 200, body: unknown;
  const headers: Record<string, unknown> = {};
  const response = {
    setHeader(name: string, value: unknown) { headers[name] = value; return response; },
    status(value: number) { status = value; return response; },
    json(value: unknown) { body = value; return response; },
    send(value: unknown) { body = value; return response; },
  };
  return { response, result: () => ({ status, body, headers }) };
}
function bffOptions(): AdminBffOptions {
  return { adminOrigin: ADMIN_ORIGIN, apiOrigin: API_ORIGIN, adminSecurityOptions: {} as never,
    adminAuthHandler: (() => undefined) as never, supply: {} as never, order: {} as never } as unknown as AdminBffOptions;
}

test("admin BFF forwards only the exact POST member invite path", async t => {
  let forwarded: any;
  t.mock.method(orderRoutes, "handleOrderAdminRoute", async (req: any, res: any) => {
    forwarded = req;
    res.status(200).json({ status: "JOINED", members: [] });
  });
  const output = capture();
  await handleAdminBff({ method: "POST", url: `/orders/${ORDER}/members`, originalUrl: `/orders/${ORDER}/members`,
    headers: { origin: ADMIN_ORIGIN, "idempotency-key": "invite_key_1" }, body: { adminUserId: TARGET } } as never,
  output.response as never, bffOptions());
  assert.equal(output.result().status, 200);
  assert.equal(forwarded.originalUrl, `/api/v1/admin/orders/${ORDER}/members`);
  assert.deepEqual(forwarded.body, { adminUserId: TARGET });
  assert.equal(forwarded.headers["idempotency-key"], "invite_key_1");

  const wrongMethod = capture();
  await handleAdminBff({ method: "PUT", url: `/orders/${ORDER}/members`, originalUrl: `/orders/${ORDER}/members`,
    headers: { origin: ADMIN_ORIGIN }, body: { adminUserId: TARGET } } as never, wrongMethod.response as never, bffOptions());
  assert.equal(wrongMethod.result().status, 404);
  const extra = capture();
  await handleAdminBff({ method: "POST", url: `/orders/${ORDER}/members/extra`, originalUrl: `/orders/${ORDER}/members/extra`,
    headers: { origin: ADMIN_ORIGIN }, body: {} } as never, extra.response as never, bffOptions());
  assert.equal(extra.result().status, 404);
});
