import type { PoolClient } from "pg";
import { recordAudit } from "../auth/security-core";
import { conflict, notFound } from "../supply/supply-util";
import { loadMediaAsset, type UploadedAsset } from "../supply/media";
import { readAvatarUploadPolicy } from "./avatar-policy";
import { applyAvatarReview, avatarSubjectOfAsset, bindPendingAvatar, isAvatarAsset, isAvatarAssetPubliclyEligible, type ProfileAvatarActor } from "./profile-avatar";
import type { ProfileAvatarRealm } from "./profile-avatar-presets";

/** Only the current upload finalizer calls this, after bytes/ownership/intent validation. */
export async function finalizeAvatarSubmission(client: PoolClient, realm: ProfileAvatarRealm, subjectId: string, asset: UploadedAsset, intentId: string, actor: ProfileAvatarActor, requestId: string) {
  const policy = await readAvatarUploadPolicy(client, true);
  await bindPendingAvatar(client, realm, subjectId, asset.assetId, intentId, actor, requestId, policy.requiresReview ? "PENDING_REVIEW" : "SUBMITTED");
  const avatarSubmission = { disposition: policy.requiresReview ? "PENDING_REVIEW" as const : "APPLIED_BY_POLICY" as const,
    requiresReview: policy.requiresReview, policyRevision: policy.revision,
    approvalSource: policy.requiresReview ? "MANUAL_REVIEW_REQUIRED" as const : "SYSTEM_POLICY" as const };
  if (policy.requiresReview) {
    await recordAudit(client, { actorType: "system", action: "profile.avatar.submission.policy_decided", objectType: "media_asset", objectId: asset.assetId,
      outcome: "SUCCESS", requestId, details: { realm, subjectId, ...avatarSubmission } });
    return { ...asset, avatarSubmission };
  }
  if (!policy.available || policy.revision === "0") throw conflict("Avatar policy approval is not available");
  const current = await loadMediaAsset(client, asset.assetId, true), subject = current ? avatarSubjectOfAsset(current) : null;
  if (!current || !isAvatarAsset(current) || subject?.realm !== realm || subject.subjectId !== subjectId) throw notFound();
  if (current.reviewState !== "PENDING" || !isAvatarAssetPubliclyEligible({ ...current, reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY" })) throw conflict("The new avatar is not eligible for policy approval");
  await client.query(`UPDATE zzsh_supply.media_asset SET review_state='APPROVED',reviewed_by_admin_id=NULL,reviewed_at=clock_timestamp(),
    review_reason='头像上传政策免人工审核',avatar_policy_revision=$2,access_class='PUBLIC_DISPLAY',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [asset.assetId, policy.revision]);
  const approved = await loadMediaAsset(client, asset.assetId);
  if (!approved || !isAvatarAssetPubliclyEligible(approved)) throw conflict("Policy-approved avatar is not publicly eligible");
  const activation = await applyAvatarReview(client, realm, subjectId, asset.assetId, "APPROVE", "头像上传政策免人工审核", { realm: "system", policyRevision: policy.revision }, requestId);
  if (!activation.applied) throw conflict("Avatar upload was superseded before activation");
  return { ...asset, reviewState: approved.reviewState, accessClass: approved.accessClass, avatarSubmission };
}
