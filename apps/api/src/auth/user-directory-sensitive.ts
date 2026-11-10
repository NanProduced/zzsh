import type { PoolClient } from "pg";

import { invalid, notFound } from "../supply/supply-util";
import { requirePermission, type EffectiveAdminAccess } from "./admin-authorization";
import { recordAudit } from "./security-core";
import { readLegacyIdentityForAdmin } from "./legacy-identity-profile";

/** Local-only disclosure. The route must revalidate the admin session, use a transaction and send no-store. */
export async function readUserSensitiveProfile(
  client: PoolClient,
  actor: { adminId: string; sessionId: string; requestId: string },
  access: EffectiveAdminAccess,
  userId: string,
  keys?: { profileKey?: Buffer; subjectKey?: Buffer },
) {
  requirePermission(access, "user.directory.read");
  requirePermission(access, "user.identity.sensitive.read");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId) || !actor.adminId || !actor.sessionId || !actor.requestId) throw invalid("Sensitive profile subject is invalid");
  const row = (await client.query<{ phoneNumber: string | null }>(
    `SELECT "phoneNumber" FROM zzsh_auth_user."user" WHERE id=$1 FOR SHARE`, [userId],
  )).rows[0];
  if (!row) throw notFound();
  const phoneNumber = row.phoneNumber?.trim() || null;
  const ready=(await client.query<{ready:boolean}>(`SELECT to_regclass('zzsh_iam.user_legacy_identity_profile') IS NOT NULL AS ready`)).rows[0]?.ready===true;
  const identity=ready?await readLegacyIdentityForAdmin(client,userId,keys?.profileKey,keys?.subjectKey):null;
  await recordAudit(client, { actorType: "admin", actorId: actor.adminId, sessionId: actor.sessionId, requestId: actor.requestId,
    action: "user.identity.sensitive.read", objectType: "user", objectId: userId, outcome: "SUCCESS",
    details: { fields: [...(phoneNumber === null ? [] : ["phoneNumber"]), ...(identity ? ["realName", "identityNumber"] : [])] } });
  return {
    userId, phoneNumber,
    realName: identity?.realName ?? null, identityNumber: identity?.idCardNo ?? null,
    availability: { phoneNumber: phoneNumber === null ? "NOT_RECORDED" as const : "AVAILABLE" as const,
      realName: identity ? "AVAILABLE" as const : "NOT_RECORDED" as const, identityNumber: identity ? "AVAILABLE" as const : "NOT_RECORDED" as const },
  };
}
