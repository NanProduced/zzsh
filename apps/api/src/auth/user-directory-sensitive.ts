import type { PoolClient } from "pg";

import { invalid, notFound } from "../supply/supply-util";
import { requirePermission, type EffectiveAdminAccess } from "./admin-authorization";
import { recordAudit } from "./security-core";

/** Local-only disclosure. The route must revalidate the admin session, use a transaction and send no-store. */
export async function readUserSensitiveProfile(
  client: PoolClient,
  actor: { adminId: string; sessionId: string; requestId: string },
  access: EffectiveAdminAccess,
  userId: string,
) {
  requirePermission(access, "user.directory.read");
  requirePermission(access, "user.identity.sensitive.read");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId) || !actor.adminId || !actor.sessionId || !actor.requestId) throw invalid("Sensitive profile subject is invalid");
  const row = (await client.query<{ phoneNumber: string | null }>(
    `SELECT "phoneNumber" FROM zzsh_auth_user."user" WHERE id=$1 FOR SHARE`, [userId],
  )).rows[0];
  if (!row) throw notFound();
  const phoneNumber = row.phoneNumber?.trim() || null;
  await recordAudit(client, { actorType: "admin", actorId: actor.adminId, sessionId: actor.sessionId, requestId: actor.requestId,
    action: "user.identity.sensitive.read", objectType: "user", objectId: userId, outcome: "SUCCESS",
    details: { fields: phoneNumber === null ? [] : ["phoneNumber"] } });
  return {
    userId, phoneNumber,
    // Authentication status is not a stored legal name or document-number fact.
    realName: null, identityNumber: null,
    availability: { phoneNumber: phoneNumber === null ? "NOT_RECORDED" as const : "AVAILABLE" as const, realName: "NOT_RECORDED" as const, identityNumber: "NOT_RECORDED" as const },
  };
}
