import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ensureInitialProfileAvatar } from "../profile/profile-avatar";
import { ADMIN_BOOTSTRAP_LOCK, nextAdminLogin, nextBossLogin } from "./admin-directory";
import { recordAudit, setAuditContext } from "./security-core";

type InitialAccount = { name: string; password: string };
export type InitialAdministratorsInput = { bosses: [InitialAccount, InitialAccount]; operations: [InitialAccount, InitialAccount] };

/** Caller owns the target-identity fence and transaction; never log or return the supplied passwords. */
export async function initializeFirstAdministrators(
  client: PoolClient,
  input: InitialAdministratorsInput,
  hashPassword: (password: string) => Promise<string>,
  requestId: string,
): Promise<Array<{ id: string; username: string; role: "BOSS" | "OPERATIONS" }>> {
  if ((client as PoolClient & { getTransactionStatus?: () => string }).getTransactionStatus?.() !== "T") throw new Error("INITIAL_ADMINS_TRANSACTION_REQUIRED");
  if (!Array.isArray(input?.bosses) || input.bosses.length !== 2 || !Array.isArray(input.operations) || input.operations.length !== 2
      || typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw new Error("INITIAL_ADMINS_INPUT_INVALID");
  const accounts = [...input.bosses, ...input.operations];
  if (accounts.some((a) => !a || typeof a.name !== "string" || !a.name.trim() || a.name.length > 120
      || typeof a.password !== "string" || a.password.length < 12 || a.password.length > 128)
      || new Set(accounts.map((a) => a.password)).size !== 4) throw new Error("INITIAL_ADMINS_INPUT_INVALID");

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
