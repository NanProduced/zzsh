import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ensureInitialProfileAvatar } from "../profile/profile-avatar";
import { ADMIN_BOOTSTRAP_LOCK, nextAdminLogin, nextBossLogin } from "./admin-directory";
import { recordAudit, setAuditContext } from "./security-core";

type InitialAccount = { name: string; password: string };
export type InitialAdministratorsInput = { bosses: [InitialAccount, InitialAccount]; operations: [InitialAccount, InitialAccount] };

function initialAccounts(input: InitialAdministratorsInput, requestId: string): InitialAccount[] {
  if (!Array.isArray(input?.bosses) || input.bosses.length !== 2 || !Array.isArray(input.operations) || input.operations.length !== 2
      || typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw new Error("INITIAL_ADMINS_INPUT_INVALID");
  const accounts = [...input.bosses, ...input.operations];
  if (accounts.some((a) => !a || typeof a.name !== "string" || !a.name.trim() || a.name.length > 120
      || typeof a.password !== "string" || a.password.length < 12 || a.password.length > 128)
      || new Set(accounts.map((a) => a.password)).size !== 4) throw new Error("INITIAL_ADMINS_INPUT_INVALID");
  return accounts;
}

/** Caller owns the target-identity fence and transaction; never log or return the supplied passwords. */
export async function initializeFirstAdministrators(
  client: PoolClient,
  input: InitialAdministratorsInput,
  hashPassword: (password: string) => Promise<string>,
  requestId: string,
): Promise<Array<{ id: string; username: string; role: "BOSS" | "OPERATIONS" }>> {
  if ((client as PoolClient & { getTransactionStatus?: () => string }).getTransactionStatus?.() !== "T") throw new Error("INITIAL_ADMINS_TRANSACTION_REQUIRED");
  const accounts = initialAccounts(input, requestId);

  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ADMIN_BOOTSTRAP_LOCK]);
  const existing = (await client.query<{ occupied: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM "zzsh_auth_admin"."user") OR EXISTS (SELECT 1 FROM "zzsh_auth_admin"."account")
    OR EXISTS (SELECT 1 FROM "zzsh_auth_admin"."session") OR EXISTS (SELECT 1 FROM "zzsh_auth_admin"."twoFactor")
    OR EXISTS (SELECT 1 FROM "zzsh_iam"."admin_security") AS occupied`)).rows[0];
  if (!existing || existing.occupied) throw new Error("INITIAL_ADMINS_TARGET_NOT_EMPTY");
  const role = (await client.query<{ valid: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM "zzsh_iam"."admin_role" WHERE id='role_preset_ops' AND code='ops' AND status='ACTIVE'
  ) AND NOT EXISTS (SELECT 1 FROM "zzsh_iam"."admin_role_permission"
    WHERE role_id='role_preset_ops' AND permission_code='order.compensation.approve') AS valid`)).rows[0];
  if (!role?.valid) throw new Error("INITIAL_ADMINS_OPERATIONS_ROLE_NOT_READY");
  const hashes: string[] = [];
  for (const account of accounts) {
    let hash: string;
    try { hash = await hashPassword(account.password); }
    catch { throw new Error("INITIAL_ADMINS_PASSWORD_HASH_FAILED"); }
    if (typeof hash !== "string" || !hash) throw new Error("INITIAL_ADMINS_PASSWORD_HASH_FAILED");
    hashes.push(hash);
  }
  const result: Array<{ id: string; username: string; role: "BOSS" | "OPERATIONS" }> = [];
  await setAuditContext(client, "system", undefined, undefined, requestId);
  for (const [index, account] of accounts.entries()) {
    const boss = index < 2;
    const login = boss ? nextBossLogin(result.filter((item) => item.role === "BOSS").map((item) => item.username)) : await nextAdminLogin(client);
    const id = `admin_${randomUUID().replaceAll("-", "")}`, now = new Date();
    await client.query(`INSERT INTO "zzsh_auth_admin"."user" ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
      VALUES ($1, $2, $3, $4, $4, $5, $6, false, false)`, [id, account.name.trim(), `${login.username}@admin.zzsh.invalid`, now, login.username, login.displayUsername]);
    await ensureInitialProfileAvatar(client, "admin", id, requestId);
    await client.query(`INSERT INTO "zzsh_auth_admin"."account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
      VALUES ($1, $2, 'credential', $2, $3, $4, $4)`, [`account_${randomUUID().replaceAll("-", "")}`, id, hashes[index], now]);
    await client.query(`INSERT INTO "zzsh_iam"."admin_security" ("admin_user_id", "status", "is_boss", "password_change_required", "bootstrap_expires_at", "game_scope_mode")
      VALUES ($1, 'PENDING_ENROLLMENT', $2, true, CASE WHEN $2 THEN NULL ELSE 'infinity'::timestamptz END, 'ALL_GAMES')`, [id, boss]);
    if (!boss) await client.query(`INSERT INTO "zzsh_iam"."admin_user_role" ("admin_user_id", "role_id") VALUES ($1, 'role_preset_ops')`, [id]);
    await recordAudit(client, { actorType: "system", action: "admin.initialized", objectType: "admin_user", objectId: id,
      outcome: "SUCCESS", requestId, details: { username: login.displayUsername, role: boss ? "BOSS" : "OPERATIONS" } });
    result.push({ id, username: login.displayUsername, role: boss ? "BOSS" : "OPERATIONS" });
  }
  return result;
}

/** A missing audit is UNKNOWN, never permission to create a replacement account. */
export async function readFirstAdministrators(
  client: PoolClient,
  input: InitialAdministratorsInput,
  verifyPassword: (input: { password: string; hash: string }) => Promise<boolean>,
  requestId: string,
): Promise<{ knowledge: "UNKNOWN"; accounts: null } | { knowledge: "KNOWN"; accounts: Array<{ username: string; role: "BOSS" | "OPERATIONS" }> }> {
  if ((client as PoolClient & { getTransactionStatus?: () => string }).getTransactionStatus?.() !== "T") throw new Error("INITIAL_ADMINS_READ_ONLY_REQUIRED");
  const accounts = initialAccounts(input, requestId);
  if (typeof verifyPassword !== "function") throw new Error("INITIAL_ADMINS_INPUT_INVALID");
  const state = (await client.query(`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
    (SELECT count(*)::int FROM "zzsh_auth_admin"."user") AS users,(SELECT count(*)::int FROM "zzsh_auth_admin"."account") AS credentials,
    (SELECT count(*)::int FROM "zzsh_iam"."admin_security") AS security,(SELECT count(*)::int FROM "zzsh_auth_admin"."session") AS sessions,
    (SELECT count(*)::int FROM "zzsh_auth_admin"."twoFactor") AS factors,
    EXISTS(SELECT 1 FROM "zzsh_iam"."admin_role" WHERE id='role_preset_ops' AND code='ops' AND status='ACTIVE')
      AND NOT EXISTS(SELECT 1 FROM "zzsh_iam"."admin_role_permission" WHERE role_id='role_preset_ops' AND permission_code='order.compensation.approve') AS ops_role_ready`)).rows[0];
  if (!state || !["repeatable read", "serializable"].includes(state.isolation) || state.read_only !== "on") throw new Error("INITIAL_ADMINS_READ_ONLY_REQUIRED");
  const rows = (await client.query(`SELECT a.object_id AS id,a.actor_type,a.actor_id,a.session_id,a.outcome,a.details,
    u.name,u.username,u."twoFactorEnabled" AS two_factor,u.suspended,s.status,s.is_boss,s.password_change_required,
    s.first_activated_at,s.bootstrap_used_at,s.bootstrap_expires_at IS NULL AS expiry_null,
    COALESCE(s.bootstrap_expires_at='infinity'::timestamptz,false) AS expiry_infinite,s.game_scope_mode,
    (SELECT count(*)::int FROM "zzsh_auth_admin"."account" c WHERE c."userId"=u.id AND c."providerId"='credential') AS credential_count,
    (SELECT c.password FROM "zzsh_auth_admin"."account" c WHERE c."userId"=u.id AND c."providerId"='credential' LIMIT 1) AS password_hash,
    (SELECT array_agg(role_id ORDER BY role_id) FROM "zzsh_iam"."admin_user_role" WHERE admin_user_id=u.id) AS roles,
    (SELECT count(*)::int FROM "zzsh_iam"."admin_user_permission" WHERE admin_user_id=u.id) AS individual_permissions
    FROM "zzsh_iam"."audit_event" a LEFT JOIN "zzsh_auth_admin"."user" u ON u.id=a.object_id
    LEFT JOIN "zzsh_iam"."admin_security" s ON s.admin_user_id=u.id
    WHERE a.action='admin.initialized' AND a.object_type='admin_user' AND a.request_id=$1`, [requestId])).rows;
  if (!rows.length && [state.users,state.credentials,state.security,state.sessions,state.factors].every(value => value === 0)) return { knowledge: "UNKNOWN", accounts: null };
  if (rows.length !== 4 || new Set(rows.map(row => row.id)).size !== 4 || state.users !== 4 || state.credentials !== 4 || state.security !== 4
      || state.sessions !== 0 || state.factors !== 0 || state.ops_role_ready !== true) throw new Error("INITIAL_ADMINS_READBACK_CONFLICT");
  const bosses = rows.filter(row => row.details?.role === "BOSS").sort((a,b) => String(a.username) < String(b.username) ? -1 : String(a.username) > String(b.username) ? 1 : 0);
  const operations = rows.filter(row => row.details?.role === "OPERATIONS").sort((a,b) => {
    const left = /^zz([0-9]{5,})$/i.exec(String(a.username)), right = /^zz([0-9]{5,})$/i.exec(String(b.username));
    if (!left || !right) return 0;
    return BigInt(left[1]!) < BigInt(right[1]!) ? -1 : BigInt(left[1]!) > BigInt(right[1]!) ? 1 : 0;
  });
  if (bosses.length !== 2 || operations.length !== 2 || bosses.map(row => String(row.username).toUpperCase()).join(",") !== "ZZ00001,ZZ00002")
    throw new Error("INITIAL_ADMINS_READBACK_CONFLICT");
  const result: Array<{ username: string; role: "BOSS" | "OPERATIONS" }> = [];
  for (const [index,row] of [...bosses,...operations].entries()) {
    const boss = index < 2, username = typeof row.username === "string" ? row.username.toUpperCase() : "";
    if (!/^ZZ[0-9]{5,}$/.test(username) || row.details?.username !== username || row.actor_type !== "system" || row.actor_id !== null || row.session_id !== null
      || row.outcome !== "SUCCESS" || row.name !== accounts[index]!.name.trim() || row.two_factor !== false || row.suspended !== false
      || row.status !== "PENDING_ENROLLMENT" || row.is_boss !== boss || row.password_change_required !== true || row.first_activated_at !== null
      || row.bootstrap_used_at !== null || (boss ? row.expiry_null !== true : row.expiry_infinite !== true) || row.game_scope_mode !== "ALL_GAMES"
      || row.credential_count !== 1 || typeof row.password_hash !== "string" || row.individual_permissions !== 0
      || (boss ? row.roles !== null : !Array.isArray(row.roles) || row.roles.length !== 1 || row.roles[0] !== "role_preset_ops"))
      throw new Error("INITIAL_ADMINS_READBACK_CONFLICT");
    let matches: boolean;
    try { matches = await verifyPassword({ password: accounts[index]!.password, hash: row.password_hash }); }
    catch { throw new Error("INITIAL_ADMINS_VERIFY_FAILED"); }
    if (matches !== true) throw new Error("INITIAL_ADMINS_READBACK_CONFLICT");
    result.push({ username, role: boss ? "BOSS" : "OPERATIONS" });
  }
  return { knowledge: "KNOWN", accounts: result };
}
