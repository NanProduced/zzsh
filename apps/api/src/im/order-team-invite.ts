import type { PoolClient } from "pg";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { noGameScopeError, readAdminGameScope, scopeAllowsGame, scopeIsEmpty } from "../auth/admin-scope";
import { recordAudit, setAuditContext, SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { buildYunxinIdentityMarker, deriveYunxinAccountId, type ImIdentityKey } from "./identity-lifecycle";
import { readOrderTeamMemberRows, projectOrderTeamMembers, type OrderTeamMemberView } from "./order-team-access";
import { ORDER_TEAM_CONFIGURATION, type YunxinOrderTeamApi, type YunxinOrderTeamState } from "./yunxin-provider";

export type OrderTeamInviteActor = { userId: string; sessionId: string };
export type OrderTeamInviteOptions = {
  appId: string;
  provider: Pick<YunxinOrderTeamApi, "readOrderTeam" | "addSupportTeamMember">;
};
export type OrderTeamInviteResult = { status: "JOINED"|"ALREADY_JOINED"; members: OrderTeamMemberView[] };
export type OrderTeamInviteTargets = { targets: { adminUserId: string; displayName: string }[] };

type SettingsScope = {
  order_id: string; app_id: string; game_id: string; account_id: string; order_status: string;
  assigned_admin_id: string | null; responsible_admin_id: string | null;
  team_state: string; team_id: string | null; team_name: string | null; members_limit: number | null;
  system_account: string | null; system_status: string | null; system_marker: string | null; system_subject: string | null;
};
type TargetAdmin = { admin_user_id: string; display_name: string; suspended: boolean; security_status: string };
type TargetIdentity = { id: string; account_id: string; platform_subject_id: string; realm: string; identity_kind: string; status: string; identity_marker: string };
type ExistingMember = { identity_id: string; party: string; state: string; platform_subject_id: string };

const forbidden = () => new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Order Team access denied");
const conflict = (message: string) => new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, message);
const notFound = () => new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Order Team unavailable");
const unavailable = () => new SecurityApiError(503, API_V1_ERROR_CODES.IM_UNAVAILABLE, "IM service is temporarily unavailable");
const mismatch = () => conflict("Order Team is inconsistent; refresh and retry");

function key(appId: string, kind: "SYSTEM" | "ADMIN", subject: string): ImIdentityKey {
  return { provider: "yunxin", appId, realm: kind === "SYSTEM" ? "system" : "admin", kind, platformSubjectId: subject };
}

async function readScope(c: Pick<PoolClient, "query">, appId: string, orderId: string): Promise<SettingsScope | null> {
  return (await c.query<SettingsScope>(`SELECT g.order_id,g.app_id,g.assigned_admin_id,g.responsible_admin_id,g.team_state,g.team_id,
      g.team_name,g.members_limit,o.game_id,o.account_id,o.status AS order_status,
      m.account_id AS system_account,m.status AS system_status,m.identity_marker AS system_marker,m.platform_subject_id AS system_subject
    FROM zzsh_order.im_order_group g JOIN zzsh_order.rental_order o ON o.id=g.order_id
    LEFT JOIN zzsh_iam.im_identity_mapping m ON m.id=g.system_identity_id AND m.app_id=g.app_id
    WHERE g.order_id=$1 AND g.app_id=$2`,[orderId,appId])).rows[0] ?? null;
}

async function assertAccess(c: Pick<PoolClient, "query">, actor: OrderTeamInviteActor, appId: string, orderId: string): Promise<SettingsScope> {
  await assertAdminContextInTransaction(c as PoolClient, actor);
  const access = await loadEffectiveAdminAccess(c as PoolClient, actor.userId);
  if (!hasPermission(access, ADMIN_PERMISSION.imSupportRead)) throw forbidden();
  const scope = await readScope(c, appId, orderId);
  if (!scope) throw notFound();
  if (!access?.isBoss) {
    const gameScope = await readAdminGameScope(c as PoolClient, actor.userId);
    if (scopeIsEmpty(gameScope, false)) throw noGameScopeError();
    if (!scopeAllowsGame(gameScope, false, scope.game_id)) throw forbidden();
  }
  if (scope.order_status !== "PAID") throw conflict("Order is not active");
  if (scope.team_state !== "READY" || !scope.team_id || !scope.team_name || !scope.members_limit) throw conflict("Order Team is not ready");
  return scope;
}

/** Re-authorizes the current session, support read capability and this order's game scope. */
export async function assertOrderTeamInviteAccess(c: Pick<PoolClient, "query">, actor: OrderTeamInviteActor, appId: string, orderId: string): Promise<void> {
  await assertAccess(c, actor, appId, orderId);
}

async function readTarget(c: Pick<PoolClient, "query">, targetAdminId: string): Promise<TargetAdmin> {
  const row = (await c.query<TargetAdmin>(`SELECT u.id AS admin_user_id,u.name AS display_name,u.suspended,s.status AS security_status
    FROM zzsh_auth_admin."user" u JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id WHERE u.id=$1 FOR SHARE`,[targetAdminId])).rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
  if (row.suspended || row.security_status !== "ACTIVE") throw conflict("Administrator is unavailable");
  return row;
}

async function readIdentity(c: Pick<PoolClient, "query">, appId: string, targetAdminId: string): Promise<TargetIdentity> {
  const row = (await c.query<TargetIdentity>(`SELECT id,account_id,platform_subject_id,realm,identity_kind,status,identity_marker
    FROM zzsh_iam.im_identity_mapping WHERE provider='yunxin' AND app_id=$1 AND realm='admin' AND identity_kind='ADMIN'
      AND platform_subject_id=$2 FOR SHARE`,[appId,targetAdminId])).rows[0];
  const expected = key(appId, "ADMIN", targetAdminId);
  if (!row || row.status !== "READY" || row.realm !== "admin" || row.identity_kind !== "ADMIN"
    || row.platform_subject_id !== targetAdminId || row.account_id !== deriveYunxinAccountId(expected)
    || row.identity_marker !== buildYunxinIdentityMarker(expected)) throw conflict("Administrator IM identity is not ready");
  return row;
}

function assertSystemOwner(scope: SettingsScope): string {
  const expected = key(scope.app_id, "SYSTEM", "support-manager");
  const account = scope.system_account;
  if (!account || scope.system_status !== "READY" || scope.system_subject !== "support-manager"
    || account !== deriveYunxinAccountId(expected) || scope.system_marker !== buildYunxinIdentityMarker(expected)) {
    throw conflict("Order Team owner identity is not ready");
  }
  return account;
}

function markerMatches(team: YunxinOrderTeamState, scope: SettingsScope): boolean {
  try {
    const marker = JSON.parse(team.serverExtension ?? "null") as { schema?: unknown; appId?: unknown; orderId?: unknown } | null;
    return marker?.schema === "zzsh.im-order.v1" && marker.appId === scope.app_id && marker.orderId === scope.order_id;
  } catch {
    return false;
  }
}

/** Verifies the exact persisted Team binding; it never accepts a different Team. */
function assertTeam(scope: SettingsScope, team: YunxinOrderTeamState | null, systemAccount: string): YunxinOrderTeamState {
  if (!team || team.teamId !== scope.team_id || team.ownerAccountId !== systemAccount || team.teamType !== 1
    || team.name !== scope.team_name || team.membersLimit !== scope.members_limit || !markerMatches(team, scope)
    || Object.entries(ORDER_TEAM_CONFIGURATION).some(([name, value]) => team.configuration[name as keyof typeof ORDER_TEAM_CONFIGURATION] !== value)
    || team.members.length > team.membersLimit
    || team.members.some(member => member.chatBanned !== false || member.role !== (member.accountId === systemAccount ? 1 : 0))
    || !team.members.some(member => member.accountId === systemAccount && member.role === 1)) throw mismatch();
  return team;
}

async function readTeam(options: OrderTeamInviteOptions, teamId: string): Promise<YunxinOrderTeamState | null> {
  try { return await options.provider.readOrderTeam(teamId); }
  catch (error) { if (error instanceof SecurityApiError) throw error; throw unavailable(); }
}

async function addTeamMember(options: OrderTeamInviteOptions, teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void> {
  try { await options.provider.addSupportTeamMember(teamId, operatorAccountId, memberAccountId); }
  catch (error) { if (error instanceof SecurityApiError) throw error; throw unavailable(); }
}

async function readExistingMember(c: Pick<PoolClient, "query">, appId: string, orderId: string, targetAdminId: string): Promise<ExistingMember | null> {
  return (await c.query<ExistingMember>(`SELECT mm.identity_id,mm.party,mm.state,m.platform_subject_id
    FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=mm.app_id
    WHERE mm.order_id=$1 AND mm.app_id=$2 AND m.realm='admin' AND m.identity_kind='ADMIN' AND m.platform_subject_id=$3`,
  [orderId,appId,targetAdminId])).rows[0] ?? null;
}

async function lockOrderTeam(c: Pick<PoolClient, "query">, orderId: string): Promise<void> {
  await c.query(`SELECT id FROM zzsh_order.rental_order WHERE id=$1 FOR UPDATE`,[orderId]);
  await c.query(`SELECT order_id FROM zzsh_order.im_order_group WHERE order_id=$1 FOR UPDATE`,[orderId]);
  // A pending escalation ADD and this endpoint must not both reach the provider.
  const operations = (await c.query<{ kind: string; state: string }>(`SELECT id,kind,state FROM zzsh_order.im_order_operation
    WHERE order_id=$1 ORDER BY id FOR UPDATE`,[orderId])).rows;
  if (operations.some(operation => operation.kind === "ADD_MEMBER" && ["PENDING","RUNNING","NEEDS_REVIEW"].includes(operation.state))) {
    throw conflict("A member change is already in progress");
  }
}

/**
 * Adds an existing administrator to the already-bound support-manager-owned
 * order Team. The caller owns the transaction; every provider failure rolls it
 * back. It never creates a Team, changes responsibility or removes a member.
 */
export async function inviteOrderTeamAdmin(
  c: Pick<PoolClient, "query">,
  options: OrderTeamInviteOptions,
  actor: OrderTeamInviteActor,
  orderId: string,
  targetAdminId: string,
  requestId: string,
): Promise<OrderTeamInviteResult> {
  await assertAccess(c, actor, options.appId, orderId);
  await lockOrderTeam(c, orderId);
  const scope = await readScope(c, options.appId, orderId);
  if (!scope || scope.team_state !== "READY" || !scope.team_id || scope.order_status !== "PAID") throw conflict("Order Team is not ready");
  const target = await readTarget(c, targetAdminId);
  const identity = await readIdentity(c, options.appId, target.admin_user_id);
  const systemAccount = assertSystemOwner(scope);
  let existing = await readExistingMember(c, options.appId, orderId, target.admin_user_id);
  if (existing && (existing.party !== "STAFF" || existing.platform_subject_id !== target.admin_user_id)) throw mismatch();
  if (existing && existing.identity_id !== identity.id) throw mismatch();

  let before = await readTeam(options, scope.team_id);
  assertTeam(scope, before, systemAccount);
  const targetPresent = before!.members.some(member => member.accountId === identity.account_id);
  let repairedOnly = false;
  if (!targetPresent) {
    if (before!.members.length >= before!.membersLimit) throw conflict("Order Team is full");
    await addTeamMember(options, scope.team_id, systemAccount, identity.account_id);
    const after = await readTeam(options, scope.team_id);
    const verified = assertTeam(scope, after, systemAccount);
    if (verified.members.length !== before!.members.length + 1
      || before!.members.some(member => !verified.members.some(item => item.accountId === member.accountId))
      || !verified.members.some(member => member.accountId === identity.account_id)) throw mismatch();
  } else if (existing?.state === "JOINED") {
    return { status: "ALREADY_JOINED", members: projectOrderTeamMembers(await readOrderTeamMemberRows(c as PoolClient, orderId, scope.app_id),
      scope.responsible_admin_id ?? scope.assigned_admin_id, "admin") };
  } else {
    repairedOnly = true;
  }

  if (!existing) {
    const inserted = await c.query(`INSERT INTO zzsh_order.im_order_member(order_id,app_id,identity_id,party,state,joined_at)
      VALUES($1,$2,$3,'STAFF','JOINED',clock_timestamp()) ON CONFLICT(order_id,identity_id) DO NOTHING`,
    [orderId,options.appId,identity.id]);
    if (inserted.rowCount !== 1) {
      existing = await readExistingMember(c, options.appId, orderId, target.admin_user_id);
      if (!existing || existing.state !== "JOINED" || existing.identity_id !== identity.id) throw mismatch();
      return { status: "ALREADY_JOINED", members: projectOrderTeamMembers(await readOrderTeamMemberRows(c as PoolClient, orderId, scope.app_id),
        scope.responsible_admin_id ?? scope.assigned_admin_id, "admin") };
    }
  } else if (existing.state !== "JOINED") {
    const updated = await c.query(`UPDATE zzsh_order.im_order_member SET state='JOINED',joined_at=clock_timestamp()
      WHERE order_id=$1 AND app_id=$2 AND identity_id=$3 AND party='STAFF' AND state='PLANNED'`,
    [orderId,options.appId,identity.id]);
    if (updated.rowCount !== 1) throw mismatch();
  }

  await setAuditContext(c as PoolClient, "admin", actor.userId, actor.sessionId, requestId);
  await recordAudit(c as PoolClient, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId,
    action: "im.order.team.member.invited", objectType: "rental_order", objectId: orderId, outcome: "SUCCESS", requestId,
    details: { appId: scope.app_id, teamId: scope.team_id, targetAdminId: target.admin_user_id, repairedProviderBinding: repairedOnly } });
  return { status: "JOINED", members: projectOrderTeamMembers(await readOrderTeamMemberRows(c as PoolClient, orderId, scope.app_id),
    scope.responsible_admin_id ?? scope.assigned_admin_id, "admin") };
}

/**
 * Narrow admin-only selection list. It returns no identity mappings, Team IDs
 * or account IDs and is bounded by the caller-supplied limit.
 */
export async function listOrderTeamInviteTargets(
  c: Pick<PoolClient, "query">,
  actor: OrderTeamInviteActor,
  appId: string,
  orderId: string,
  limit: number,
): Promise<OrderTeamInviteTargets> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Limit is invalid");
  const scope = await assertAccess(c, actor, appId, orderId);
  const rows = (await c.query<{ adminUserId: string; displayName: string }>(`SELECT u.id AS "adminUserId",u.name AS "displayName"
    FROM zzsh_auth_admin."user" u
    JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id AND s.status='ACTIVE'
    JOIN zzsh_iam.im_identity_mapping m ON m.provider='yunxin' AND m.app_id=$2 AND m.realm='admin'
      AND m.identity_kind='ADMIN' AND m.platform_subject_id=u.id AND m.status='READY'
    WHERE NOT u.suspended AND ($4::text IS NULL OR u.id<>$4) AND ($5::text IS NULL OR u.id<>$5)
      AND NOT EXISTS (SELECT 1 FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping mmi ON mmi.id=mm.identity_id
        WHERE mm.order_id=$1 AND mm.app_id=$2 AND mm.state='JOINED' AND mmi.realm='admin'
          AND mmi.identity_kind='ADMIN' AND mmi.platform_subject_id=u.id)
    ORDER BY u.name,u.id LIMIT $3`,[orderId,appId,limit,scope.assigned_admin_id,scope.responsible_admin_id])).rows;
  return { targets: rows };
}
