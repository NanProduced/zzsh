import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, hasPermission, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { orderDispatchLockKey } from "../order/payment-confirmation";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "./identity-lifecycle";

export type SupportCandidate = { adminUserId: string; adminName: string; accountId: string; allGames: boolean; gameIds: string[]; complaint: boolean };
/** Transaction-local lock coverage, carried explicitly to every candidate read. */
export type LockedSupportRoster = Readonly<{ client: PoolClient; appId: string; ids: readonly string[];
  scopes: readonly { admin_user_id: string; game_id: string }[] }>;

export async function lockDispatchGate(client: PoolClient, appId: string): Promise<void> {
  await client.query(`SET LOCAL lock_timeout = '750ms'`);
  await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [orderDispatchLockKey(appId)]);
}

/** Shared by assignment AND consultation close/transfer/recovery before object locks.
 * ponytail: lock the App's staff set in short transactions; narrow batches if its size becomes material.
 * NOWAIT aborts the entire attempt (never skips a staff member). It also prevents
 * cycles with IAM's actor -> role -> target ordering, without rewriting IAM.
 */
export async function lockSupportMutation(client: PoolClient, appId: string, userIds: string[] = [], adminIds: string[] = []): Promise<LockedSupportRoster> {
  await lockDispatchGate(client, appId);
  if (userIds.length) await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [userIds]);
  const ids = (await client.query<{ id: string }>(`SELECT admin_user_id AS id FROM zzsh_iam.im_support_presence WHERE app_id=$1
    UNION SELECT unnest($2::text[])`, [appId, adminIds])).rows.map((r) => r.id);
  const security = await client.query<{ admin_user_id: string }>(`SELECT admin_user_id FROM zzsh_iam.admin_security WHERE admin_user_id=ANY($1::text[]) ORDER BY admin_user_id FOR SHARE NOWAIT`, [ids]);
  // IAM profile/freeze writes and assignment FKs share these subject rows.
  await client.query(`SELECT id FROM zzsh_auth_admin."user" WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE NOWAIT`, [ids]);
  await client.query(`SELECT r.id FROM zzsh_iam.admin_role r WHERE EXISTS
    (SELECT 1 FROM zzsh_iam.admin_user_role ur WHERE ur.role_id=r.id AND ur.admin_user_id=ANY($1::text[]))
    ORDER BY r.id FOR SHARE NOWAIT`, [ids]);
  const presence = await client.query<{ admin_user_id: string }>(`SELECT admin_user_id FROM zzsh_iam.im_support_presence WHERE app_id=$1 AND admin_user_id=ANY($2::text[])
    ORDER BY admin_user_id FOR UPDATE NOWAIT`, [appId, ids]);
  const mappings = await client.query<{ platform_subject_id: string }>(`SELECT id,platform_subject_id FROM zzsh_iam.im_identity_mapping WHERE provider='yunxin' AND app_id=$1 AND realm='admin' AND identity_kind='ADMIN' AND platform_subject_id=ANY($2::text[])
    ORDER BY id FOR SHARE NOWAIT`, [appId, ids]);
  const scopes = await client.query<{ admin_user_id: string; game_id: string }>(`SELECT admin_user_id,game_id FROM zzsh_supply.admin_supply_scope WHERE admin_user_id=ANY($1::text[])
    ORDER BY admin_user_id,game_id FOR SHARE NOWAIT`, [ids]);
  const secured = new Set(security.rows.map((r) => r.admin_user_id));
  const mapped = new Set(mappings.rows.map((r) => r.platform_subject_id));
  return { client, appId, ids: presence.rows.map((r) => r.admin_user_id).filter((id) => secured.has(id) && mapped.has(id)), scopes: scopes.rows };
}

/** Read only after lockSupportMutation. Mapping ownership is checked, not merely its status. */
export async function readEligibleSupport(client: PoolClient, appId: string, locked: LockedSupportRoster): Promise<SupportCandidate[]> {
  if (!locked || locked.client !== client || locked.appId !== appId) throw new Error("Candidate read requires this transaction's locked roster");
  const rows = (await client.query<{ adminUserId: string; adminName: string; accountId: string; identityMarker: string }>(
    `SELECT p.admin_user_id AS "adminUserId",u.name AS "adminName",m.account_id AS "accountId",m.identity_marker AS "identityMarker"
     FROM zzsh_iam.im_support_presence p JOIN zzsh_iam.admin_security s ON s.admin_user_id=p.admin_user_id
     JOIN zzsh_auth_admin."user" u ON u.id=p.admin_user_id
     JOIN zzsh_iam.im_identity_mapping m ON m.provider='yunxin' AND m.app_id=p.app_id AND m.realm='admin'
       AND m.identity_kind='ADMIN' AND m.platform_subject_id=p.admin_user_id AND m.status='READY'
     WHERE p.app_id=$1 AND p.admin_user_id=ANY($2::text[]) AND s.status='ACTIVE' AND NOT u.suspended AND p.availability='AVAILABLE'
       AND p.connection_state='CONNECTED' AND p.last_connected_at>clock_timestamp()-interval '2 minutes'`, [appId, locked.ids])).rows;
  const result: SupportCandidate[] = [];
  for (const row of rows) {
    const key = { provider: "yunxin" as const, appId, realm: "admin", kind: "ADMIN" as const, platformSubjectId: row.adminUserId };
    if (row.accountId !== deriveYunxinAccountId(key) || row.identityMarker !== buildYunxinIdentityMarker(key)) continue;
    const access = await loadEffectiveAdminAccess(client, row.adminUserId);
    if (![ADMIN_PERMISSION.imSupportRead, ADMIN_PERMISSION.imSupportAccept].every((p) => hasPermission(access, p))) continue;
    const scopes = locked.scopes.filter((s) => s.admin_user_id === row.adminUserId);
    result.push({ ...row, allGames: access!.isBoss, gameIds: scopes.map((s) => s.game_id), complaint: hasPermission(access, ADMIN_PERMISSION.imSupportComplaint) });
  }
  return result;
}

export async function reserveSupportCandidate(client: PoolClient, appId: string, kind: "ORDER" | "SERVICE" | "COMPLAINT",
  candidates: SupportCandidate[], targetAdminId?: string, excludedIds: string[] = []): Promise<SupportCandidate | null> {
  const eligible = candidates.filter((c) => (!targetAdminId || c.adminUserId === targetAdminId)
    && (kind !== "COMPLAINT" || c.complaint) && !excludedIds.includes(c.adminUserId));
  const field = kind === "ORDER" ? "last_order_assigned_at" : "last_consultation_assigned_at";
  const selected = (await client.query<{ admin_user_id: string }>(`SELECT admin_user_id FROM zzsh_iam.im_support_presence
    WHERE app_id=$1 AND admin_user_id=ANY($2::text[]) AND availability='AVAILABLE' AND connection_state='CONNECTED'
      AND last_connected_at>clock_timestamp()-interval '2 minutes'
    ORDER BY ${field} ASC NULLS FIRST,admin_user_id LIMIT 1`, [appId, eligible.map((c) => c.adminUserId)])).rows[0];
  if (!selected) return null;
  await client.query(`UPDATE zzsh_iam.im_support_presence SET ${field}=clock_timestamp(),updated_at=clock_timestamp()
    ${kind === "ORDER" ? "" : ",active_load=active_load+1"} WHERE app_id=$1 AND admin_user_id=$2`, [appId, selected.admin_user_id]);
  return eligible.find((c) => c.adminUserId === selected.admin_user_id)!;
}
