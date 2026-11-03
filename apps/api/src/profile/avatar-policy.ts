import type { PoolClient } from "pg";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { recordAudit, SecurityApiError } from "../auth/security-core";

export const AVATAR_POLICY_PERMISSION = "profile.avatar.policy.manage";
export type AvatarUploadPolicy = { requiresReview: boolean; revision: string; available: boolean };
const unavailable = () => new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Avatar upload policy is not installed");

/** Missing old-schema configuration can only require review, never silently auto-publish. */
export async function readAvatarUploadPolicy(client: Pick<PoolClient,"query">, forSubmission = false): Promise<AvatarUploadPolicy> {
  const exists = (await client.query("SELECT to_regclass('zzsh_supply.profile_avatar_policy') IS NOT NULL AS available")).rows[0]?.available;
  if (exists !== true) return { requiresReview: true, revision: "0", available: false };
  const row = (await client.query<{ requiresReview: boolean; revision: string }>(
    `SELECT requires_review AS "requiresReview",revision::text FROM zzsh_supply.profile_avatar_policy WHERE singleton=true${forSubmission ? " FOR SHARE" : ""}`,
  )).rows[0];
  if (!row || typeof row.requiresReview !== "boolean" || !/^[1-9]\d{0,18}$/.test(row.revision)) throw unavailable();
  return { ...row, available: true };
}

export async function updateAvatarUploadPolicy(client: PoolClient, actor: { id: string; sessionId: string }, input: { requiresReview: boolean; expectedRevision: string }, requestId: string) {
  if (typeof input.requiresReview !== "boolean" || !/^[1-9]\d{0,18}$/.test(input.expectedRevision)) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Avatar policy input is invalid");
  const available = (await client.query("SELECT to_regclass('zzsh_supply.profile_avatar_policy') IS NOT NULL AS available")).rows[0]?.available;
  if (available !== true) throw unavailable();
  const before = (await client.query<{ requiresReview: boolean; revision: string }>(
    'SELECT requires_review AS "requiresReview",revision::text FROM zzsh_supply.profile_avatar_policy WHERE singleton=true FOR UPDATE',
  )).rows[0];
  if (!before) throw unavailable();
  if (before.revision !== input.expectedRevision) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Avatar policy changed; reload before saving");
  if (before.requiresReview === input.requiresReview) return { policy: { ...before, available: true }, changed: false };
  const policy = (await client.query<{ requiresReview: boolean; revision: string }>(
    `UPDATE zzsh_supply.profile_avatar_policy SET requires_review=$1,revision=revision+1,updated_by_admin_id=$2,updated_at=clock_timestamp()
     WHERE singleton=true RETURNING requires_review AS "requiresReview",revision::text`, [input.requiresReview, actor.id],
  )).rows[0]!;
  await recordAudit(client, { actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, requestId,
    action: "profile.avatar.policy.updated", objectType: "profile_avatar_policy", objectId: "global", outcome: "SUCCESS",
    details: { before, after: policy, onlyNewFinalizations: true, pendingAssetsAutomaticallyApproved: false } });
  return { policy: { ...policy, available: true }, changed: true };
}
