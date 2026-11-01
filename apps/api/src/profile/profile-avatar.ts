import type { PoolClient } from "pg";

import { recordAudit } from "../auth/security-core";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { loadMediaAsset } from "../supply/media";
import {
  deterministicPresetId,
  isProfileAvatarPresetId,
  presetContentPath,
  profileAvatarPreset,
  randomPresetId,
  type ProfileAvatarPresetId,
  type ProfileAvatarRealm,
} from "./profile-avatar-presets";

export type ProfileAvatarActor = { realm: ProfileAvatarRealm; id: string; sessionId?: string };
export type ProfileAvatarDecision = "APPROVE" | "REJECT" | "QUARANTINE" | "WITHDRAW";

type ProfileAvatarRow = {
  realm: ProfileAvatarRealm;
  subjectId: string;
  defaultPresetId: ProfileAvatarPresetId;
  currentKind: "DEFAULT" | "CUSTOM";
  currentPresetId: ProfileAvatarPresetId | null;
  currentAssetId: string | null;
  pendingAssetId: string | null;
  revision: string;
  currentVersion: string;
  lastReviewAssetId: string | null;
  lastReviewState: "APPROVED" | "REJECTED" | "QUARANTINED" | "WITHDRAWN" | null;
  lastReviewReason: string | null;
  lastReviewedAt: Date | null;
  lastReviewApplied: boolean;
  updatedAt: Date;
};

type AvatarAssetRow = Awaited<ReturnType<typeof loadMediaAsset>>;

const PROFILE_AVATAR_COLUMNS = `
  "realm", "subject_id" AS "subjectId", "default_preset_id" AS "defaultPresetId",
  "current_kind" AS "currentKind", "current_preset_id" AS "currentPresetId",
  "current_asset_id" AS "currentAssetId", "pending_asset_id" AS "pendingAssetId",
  "revision"::text AS "revision", "current_version"::text AS "currentVersion",
  "last_review_asset_id" AS "lastReviewAssetId", "last_review_state" AS "lastReviewState",
  "last_review_reason" AS "lastReviewReason", "last_reviewed_at" AS "lastReviewedAt",
  "last_review_applied" AS "lastReviewApplied", "updated_at" AS "updatedAt"`;

export function ownershipForAvatarRealm(realm: ProfileAvatarRealm): "USER_AVATAR" | "ADMIN_AVATAR" {
  return realm === "user" ? "USER_AVATAR" : "ADMIN_AVATAR";
}

export function avatarSubjectOfAsset(asset: Pick<NonNullable<AvatarAssetRow>, "ownershipKind" | "ownerUserId" | "uploadedByAdminId">): { realm: ProfileAvatarRealm; subjectId: string } | null {
  if (asset.ownershipKind === "USER_AVATAR" && asset.ownerUserId) return { realm: "user", subjectId: asset.ownerUserId };
  if (asset.ownershipKind === "ADMIN_AVATAR" && asset.uploadedByAdminId) return { realm: "admin", subjectId: asset.uploadedByAdminId };
  return null;
}

export function isAvatarAsset(asset: Pick<NonNullable<AvatarAssetRow>, "purpose" | "ownershipKind">): boolean {
  return asset.purpose === "AVATAR" && (asset.ownershipKind === "USER_AVATAR" || asset.ownershipKind === "ADMIN_AVATAR");
}

/** Public read requires the approved, technically ready derivative and the current binding. */
export function isAvatarAssetPubliclyEligible(asset: Pick<NonNullable<AvatarAssetRow>, "purpose" | "ownershipKind" | "reviewState" | "accessClass" | "technicalState" | "publicStorageKey">): boolean {
  return isAvatarAsset(asset) && asset.reviewState === "APPROVED" && asset.accessClass === "PUBLIC_DISPLAY"
    && asset.technicalState === "READY" && typeof asset.publicStorageKey === "string" && /^[0-9a-f]{64}$/.test(asset.publicStorageKey);
}

export function avatarImagePath(realm: ProfileAvatarRealm, subjectId: string, version: string): string {
  return `/api/v1/profile/avatars/${realm}/${encodeURIComponent(subjectId)}/${version}`;
}

/** Only server-managed avatar paths are exposed; legacy external URLs are never fetched. */
export function managedProfileImagePath(value: string | null | undefined): string | null {
  return typeof value === "string" && value.startsWith("/api/v1/profile/avatars/") ? value : null;
}

export async function loadProfileAvatar(client: PoolClient, realm: ProfileAvatarRealm, subjectId: string, forUpdate = false): Promise<ProfileAvatarRow | null> {
  const result = await client.query<ProfileAvatarRow>(
    `SELECT ${PROFILE_AVATAR_COLUMNS} FROM "zzsh_supply"."profile_avatar" WHERE "realm" = $1 AND "subject_id" = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [realm, subjectId],
  );
  return result.rows[0] ?? null;
}

function presetView(presetId: ProfileAvatarPresetId) {
  const preset = profileAvatarPreset(presetId);
  return { presetId: preset.presetId, version: preset.version, url: presetContentPath(preset), width: preset.width, height: preset.height };
}

export function profileAvatarStateView(row: ProfileAvatarRow | null, realm: ProfileAvatarRealm, subjectId: string) {
  const defaultPresetId = row?.defaultPresetId ?? deterministicPresetId(realm, subjectId);
  const revision = row?.revision ?? "0";
  const currentVersion = row?.currentVersion ?? "0";
  const current = row
    ? row.currentKind === "CUSTOM"
      ? { kind: "CUSTOM" as const, assetId: row.currentAssetId, presetId: null, url: avatarImagePath(realm, subjectId, currentVersion) }
      : { kind: "DEFAULT" as const, assetId: null, presetId: row.currentPresetId ?? defaultPresetId, url: avatarImagePath(realm, subjectId, currentVersion) }
    : { kind: "DEFAULT" as const, assetId: null, presetId: defaultPresetId, url: avatarImagePath(realm, subjectId, "0") };
  return {
    revision,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    current: { ...current, currentVersion },
    defaultPresetId,
    presets: allPresets(),
  };
}

function allPresets() {
  return [presetView("avatar-strike"), presetView("avatar-night"), presetView("avatar-frost"), presetView("avatar-aurora")];
}

export type ProfileAvatarPending = { assetId: string; submittedAt: string | null; reviewState: string; width: number; height: number; byteSize: string };
export type ProfileAvatarLastReview = { assetId: string; state: "APPROVED" | "REJECTED" | "QUARANTINED" | "WITHDRAWN"; reason: string | null; reviewedAt: string; applied: boolean };
export type ProfileAvatarState = ReturnType<typeof profileAvatarStateView> & { pending: ProfileAvatarPending | null; lastReview: ProfileAvatarLastReview | null };

async function updateSubjectImage(client: PoolClient, realm: ProfileAvatarRealm, subjectId: string, image: string | null): Promise<void> {
  if (realm === "user") {
    await client.query(`UPDATE "zzsh_auth_user"."user" SET "image" = $2, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [subjectId, image]);
  } else {
    await client.query(`UPDATE "zzsh_auth_admin"."user" SET "image" = $2, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [subjectId, image]);
  }
}

async function insertProfileAvatar(
  client: PoolClient,
  realm: ProfileAvatarRealm,
  subjectId: string,
  defaultPresetId: ProfileAvatarPresetId,
  currentPresetId: ProfileAvatarPresetId,
  options: { actor?: ProfileAvatarActor; requestId?: string } = {},
): Promise<ProfileAvatarRow | null> {
  const inserted = await client.query<ProfileAvatarRow>(
    `INSERT INTO "zzsh_supply"."profile_avatar"
       ("realm", "subject_id", "default_preset_id", "current_kind", "current_preset_id", "revision", "current_version")
     VALUES ($1, $2, $3, 'DEFAULT', $4, 1, 1)
     ON CONFLICT ("realm", "subject_id") DO NOTHING
     RETURNING ${PROFILE_AVATAR_COLUMNS}`,
    [realm, subjectId, defaultPresetId, currentPresetId],
  );
  const row = inserted.rows[0];
  if (!row) return null;
  await updateSubjectImage(client, realm, subjectId, avatarImagePath(realm, subjectId, row.currentVersion));
  if (options.actor) {
    await recordAudit(client, {
      actorType: options.actor.realm,
      actorId: options.actor.id,
      sessionId: options.actor.sessionId,
      action: "profile.avatar.initialized",
      objectType: "profile_avatar",
      objectId: subjectId,
      outcome: "SUCCESS",
      requestId: options.requestId ?? "profile-avatar-initialized",
      reason: "profile.avatar.initialize",
      details: { realm, presetId: currentPresetId, revision: row.revision, result: "CREATED" },
    });
  }
  return row;
}

/** New user/admin/legacy subject: one random default persisted in the same transaction. */
export async function ensureInitialProfileAvatar(
  client: PoolClient,
  realm: ProfileAvatarRealm,
  subjectId: string,
  requestId: string,
  presetId: ProfileAvatarPresetId = randomPresetId(),
): Promise<{ created: boolean; presetId: ProfileAvatarPresetId }> {
  const row = await insertProfileAvatar(client, realm, subjectId, presetId, presetId, {
    actor: { realm, id: subjectId },
    requestId,
  });
  if (!row) {
    const existing = await loadProfileAvatar(client, realm, subjectId);
    return { created: false, presetId: existing?.currentPresetId ?? presetId };
  }
  return { created: true, presetId: row.currentPresetId ?? presetId };
}

async function ensureProfileRow(
  client: PoolClient,
  realm: ProfileAvatarRealm,
  subjectId: string,
  presetId: ProfileAvatarPresetId,
  options: { actor?: ProfileAvatarActor; requestId?: string } = {},
): Promise<ProfileAvatarRow> {
  const existing = await loadProfileAvatar(client, realm, subjectId, true);
  if (existing) return existing;
  const inserted = await insertProfileAvatar(client, realm, subjectId, presetId, presetId, options);
  const row = inserted ?? await loadProfileAvatar(client, realm, subjectId, true);
  if (!row) throw conflict("Profile avatar state is unavailable");
  return row;
}

function assertRevision(row: { revision: string }, expectedRevision: string): void {
  if (expectedRevision !== row.revision) throw conflict("Avatar changed; reload before saving");
}

function auditAvatarChange(
  client: PoolClient,
  actor: ProfileAvatarActor,
  requestId: string,
  action: string,
  subjectId: string,
  details: Record<string, unknown>,
): Promise<void> {
  return recordAudit(client, {
    actorType: actor.realm,
    actorId: actor.id,
    sessionId: actor.sessionId,
    action,
    objectType: "profile_avatar",
    objectId: subjectId,
    outcome: "SUCCESS",
    requestId,
    reason: action,
    details,
  });
}

export async function selectDefaultAvatar(
  client: PoolClient,
  realm: ProfileAvatarRealm,
  subjectId: string,
  input: { presetId: unknown; expectedRevision: string },
  actor: ProfileAvatarActor,
  requestId: string,
): Promise<{ changed: boolean; state: ProfileAvatarState }> {
  if (!isProfileAvatarPresetId(input.presetId)) throw invalid("Avatar preset is invalid", "presetId");
  const presetId = input.presetId;
  let row = await loadProfileAvatar(client, realm, subjectId, true);
  if (!row) {
    if (input.expectedRevision !== "0") throw conflict("Avatar changed; reload before saving");
    row = await ensureProfileRow(client, realm, subjectId, presetId, { actor, requestId });
    return { changed: true, state: { ...profileAvatarStateView(row, realm, subjectId), pending: null, lastReview: lastReviewView(row) } };
  }
  assertRevision(row, input.expectedRevision);
  const nextVersion = (BigInt(row.currentVersion) + 1n).toString();
  const nextRevision = (BigInt(row.revision) + 1n).toString();
  if (row.currentKind === "DEFAULT" && row.currentPresetId === presetId && row.pendingAssetId === null) {
    return { changed: false, state: { ...profileAvatarStateView(row, realm, subjectId), pending: null, lastReview: lastReviewView(row) } };
  }
  const updated = await client.query<ProfileAvatarRow>(
    `UPDATE "zzsh_supply"."profile_avatar"
        SET "current_kind" = 'DEFAULT', "current_preset_id" = $3, "current_asset_id" = NULL,
            "pending_asset_id" = NULL, "current_version" = $4, "revision" = $5, "updated_at" = clock_timestamp()
      WHERE "realm" = $1 AND "subject_id" = $2
      RETURNING ${PROFILE_AVATAR_COLUMNS}`,
    [realm, subjectId, presetId, nextVersion, nextRevision],
  );
  const next = updated.rows[0]!;
  await updateSubjectImage(client, realm, subjectId, avatarImagePath(realm, subjectId, next.currentVersion));
  await auditAvatarChange(client, actor, requestId, "profile.avatar.default.selected", subjectId, {
    realm,
    before: { kind: row.currentKind, presetId: row.currentPresetId, assetId: row.currentAssetId, revision: row.revision },
    after: { kind: "DEFAULT", presetId, revision: next.revision },
    result: "APPLIED",
  });
  return { changed: true, state: { ...profileAvatarStateView(next, realm, subjectId), pending: null, lastReview: lastReviewView(next) } };
}

export function avatarReviewDisposition(input: {
  pendingAssetId: string | null;
  currentAssetId: string | null;
  assetId: string;
  decision: ProfileAvatarDecision;
}): { apply: boolean; clearPending: boolean; fallback: boolean } {
  const pending = input.pendingAssetId === input.assetId;
  const current = input.currentAssetId === input.assetId;
  if (input.decision === "APPROVE") return { apply: pending, clearPending: pending, fallback: false };
  return { apply: false, clearPending: pending, fallback: current };
}

export async function bindPendingAvatar(
  client: PoolClient,
  realm: ProfileAvatarRealm,
  subjectId: string,
  assetId: string,
  actor: ProfileAvatarActor,
  requestId: string,
): Promise<void> {
  const asset = await loadMediaAsset(client, assetId);
  if (!asset || !isAvatarAsset(asset) || asset.ownershipKind !== ownershipForAvatarRealm(realm) || avatarSubjectOfAsset(asset)?.subjectId !== subjectId) throw notFound();
  const row = await ensureProfileRow(client, realm, subjectId, deterministicPresetId(realm, subjectId), { actor, requestId });
  if (row.currentAssetId === assetId) throw conflict("Avatar is already current");
  if (row.pendingAssetId === assetId) return;
  await client.query(
    `UPDATE "zzsh_supply"."profile_avatar"
        SET "pending_asset_id" = $3, "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "realm" = $1 AND "subject_id" = $2`,
    [realm, subjectId, assetId],
  );
  await auditAvatarChange(client, actor, requestId, "profile.avatar.upload.submitted", subjectId, {
    realm,
    assetId,
    before: { pendingAssetId: row.pendingAssetId, revision: row.revision },
    after: { pendingAssetId: assetId },
    result: "PENDING_REVIEW",
  });
}

export function lastReviewView(row: ProfileAvatarRow | null) {
  if (!row?.lastReviewAssetId || !row.lastReviewState || !row.lastReviewedAt) return null;
  return {
    assetId: row.lastReviewAssetId,
    state: row.lastReviewState,
    reason: row.lastReviewReason,
    reviewedAt: row.lastReviewedAt.toISOString(),
    applied: row.lastReviewApplied,
  };
}

export async function applyAvatarReview(
  client: PoolClient,
  realm: ProfileAvatarRealm,
  subjectId: string,
  assetId: string,
  decision: ProfileAvatarDecision,
  reason: string | null,
  reviewer: ProfileAvatarActor,
  requestId: string,
): Promise<{ applied: boolean; fallback: boolean; revision: string }> {
  const row = await loadProfileAvatar(client, realm, subjectId, true);
  if (!row) {
    await auditAvatarReviewWithoutState(client, reviewer, requestId, subjectId, assetId, decision, reason, false, false);
    return { applied: false, fallback: false, revision: "0" };
  }
  const disposition = avatarReviewDisposition({ pendingAssetId: row.pendingAssetId, currentAssetId: row.currentAssetId, assetId, decision });
  const nextRevision = (BigInt(row.revision) + 1n).toString();
  if (disposition.apply) {
    const nextVersion = (BigInt(row.currentVersion) + 1n).toString();
    const asset = await loadMediaAsset(client, assetId);
    if (!asset || !isAvatarAssetPubliclyEligible(asset)) throw conflict("Approved avatar is not publicly eligible");
    await client.query(
      `UPDATE "zzsh_supply"."profile_avatar"
          SET "current_kind" = 'CUSTOM', "current_preset_id" = NULL, "current_asset_id" = $3,
              "pending_asset_id" = NULL, "current_version" = $4, "revision" = $5,
              "last_review_asset_id" = $3, "last_review_state" = 'APPROVED', "last_review_reason" = $6,
              "last_reviewed_at" = clock_timestamp(), "last_review_applied" = true, "updated_at" = clock_timestamp()
        WHERE "realm" = $1 AND "subject_id" = $2`,
      [realm, subjectId, assetId, nextVersion, nextRevision, reason],
    );
    await updateSubjectImage(client, realm, subjectId, avatarImagePath(realm, subjectId, nextVersion));
  } else if (disposition.fallback) {
    const nextVersion = (BigInt(row.currentVersion) + 1n).toString();
    await client.query(
      `UPDATE "zzsh_supply"."profile_avatar"
          SET "current_kind" = 'DEFAULT', "current_preset_id" = "default_preset_id", "current_asset_id" = NULL,
              "pending_asset_id" = CASE WHEN "pending_asset_id" = $3 THEN NULL ELSE "pending_asset_id" END,
              "current_version" = $4, "revision" = $5,
              "last_review_asset_id" = $3, "last_review_state" = $6, "last_review_reason" = $7,
              "last_reviewed_at" = clock_timestamp(), "last_review_applied" = false, "updated_at" = clock_timestamp()
        WHERE "realm" = $1 AND "subject_id" = $2`,
      [realm, subjectId, assetId, nextVersion, nextRevision, decision === "WITHDRAW" ? "WITHDRAWN" : decision === "REJECT" ? "REJECTED" : "QUARANTINED", reason],
    );
    await updateSubjectImage(client, realm, subjectId, avatarImagePath(realm, subjectId, nextVersion));
  } else {
    await client.query(
      `UPDATE "zzsh_supply"."profile_avatar"
          SET "pending_asset_id" = CASE WHEN "pending_asset_id" = $3 THEN NULL ELSE "pending_asset_id" END,
              "revision" = "revision" + 1,
              "last_review_asset_id" = $3, "last_review_state" = $4, "last_review_reason" = $5,
              "last_reviewed_at" = clock_timestamp(), "last_review_applied" = false, "updated_at" = clock_timestamp()
        WHERE "realm" = $1 AND "subject_id" = $2`,
      [realm, subjectId, assetId, decision === "WITHDRAW" ? "WITHDRAWN" : decision === "REJECT" ? "REJECTED" : decision === "QUARANTINE" ? "QUARANTINED" : "APPROVED", reason],
    );
  }
  await auditAvatarReview(client, reviewer, requestId, subjectId, assetId, decision, reason, disposition.apply, disposition.fallback);
  return { applied: disposition.apply, fallback: disposition.fallback, revision: nextRevision };
}

async function auditAvatarReview(client: PoolClient, reviewer: ProfileAvatarActor, requestId: string, subjectId: string, assetId: string, decision: ProfileAvatarDecision, reason: string | null, applied: boolean, fallback: boolean): Promise<void> {
  await recordAudit(client, {
    actorType: "admin",
    actorId: reviewer.id,
    sessionId: reviewer.sessionId,
    action: decision === "WITHDRAW" ? "profile.avatar.withdrawn" : "profile.avatar.reviewed",
    objectType: "profile_avatar",
    objectId: subjectId,
    outcome: "SUCCESS",
    requestId,
    ...(reason ? { reason } : {}),
    details: { assetId, decision, applied, fallback, result: applied ? "APPLIED" : fallback ? "FALLBACK" : "RECORDED" },
  });
}

async function auditAvatarReviewWithoutState(client: PoolClient, reviewer: ProfileAvatarActor, requestId: string, subjectId: string, assetId: string, decision: ProfileAvatarDecision, reason: string | null, applied: boolean, fallback: boolean): Promise<void> {
  await auditAvatarReview(client, reviewer, requestId, subjectId, assetId, decision, reason, applied, fallback);
}

export async function profileAvatarWithPending(
  client: PoolClient,
  realm: ProfileAvatarRealm,
  subjectId: string,
): Promise<ProfileAvatarState> {
  const row = await loadProfileAvatar(client, realm, subjectId);
  const pending = row?.pendingAssetId ? await loadMediaAsset(client, row.pendingAssetId) : null;
  return {
    ...profileAvatarStateView(row, realm, subjectId),
    pending: pending && isAvatarAsset(pending)
      ? {
          assetId: pending.id,
          submittedAt: pending.createdAt?.toISOString?.() ?? null,
          reviewState: pending.reviewState,
          width: pending.width,
          height: pending.height,
          byteSize: pending.byteSize,
        }
      : null,
    lastReview: lastReviewView(row),
  };
}

export async function resetAvatarOnCancellation(client: PoolClient, userId: string, requestId: string): Promise<void> {
  const row = await loadProfileAvatar(client, "user", userId, true);
  if (!row) return;
  const nextVersion = (BigInt(row.currentVersion) + 1n).toString();
  await client.query(
    `UPDATE "zzsh_supply"."profile_avatar"
        SET "current_kind" = 'DEFAULT', "current_preset_id" = "default_preset_id", "current_asset_id" = NULL,
            "pending_asset_id" = NULL, "current_version" = $2, "revision" = "revision" + 1,
            "last_review_asset_id" = NULL, "last_review_state" = NULL, "last_review_reason" = NULL,
            "last_reviewed_at" = NULL, "last_review_applied" = false, "updated_at" = clock_timestamp()
      WHERE "realm" = 'user' AND "subject_id" = $1`,
    [userId, nextVersion],
  );
  await updateSubjectImage(client, "user", userId, null);
  await recordAudit(client, {
    actorType: "user",
    actorId: userId,
    action: "profile.avatar.reset_on_cancellation",
    objectType: "profile_avatar",
    objectId: userId,
    outcome: "SUCCESS",
    requestId,
    details: { realm: "user", result: "RESET" },
  });
}

export async function listAvatarReviews(
  client: PoolClient,
  query: { state: string; cursor: { createdAt: string; id: string } | null; limit: number },
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null; limit: number }> {
  const parameters: unknown[] = [query.state];
  const conditions = [`a."purpose" = 'AVATAR'`, `a."review_state" = $1`];
  if (query.cursor) {
    parameters.push(query.cursor.createdAt, query.cursor.id);
    conditions.push(`(a."created_at", a."id") < ($${parameters.length - 1}::timestamptz, $${parameters.length})`);
  }
  parameters.push(query.limit + 1);
  const rows = await client.query<{
    assetId: string; realm: ProfileAvatarRealm; subjectId: string; subjectName: string | null;
    createdAt: Date; width: number; height: number; byteSize: string; mime: string; reviewState: string;
    accessClass: string; reviewReason: string | null; revision: string;
  }>(
    `SELECT a."id" AS "assetId",
            CASE WHEN a."ownership_kind" = 'USER_AVATAR' THEN 'user' ELSE 'admin' END AS "realm",
            COALESCE(a."owner_user_id", a."uploaded_by_admin_id") AS "subjectId",
            COALESCE(u."name", au."name") AS "subjectName",
            a."created_at" AS "createdAt", a."width", a."height", a."byte_size"::text AS "byteSize", a."mime",
            a."review_state" AS "reviewState", a."access_class" AS "accessClass", a."review_reason" AS "reviewReason", a."revision"::text AS "revision"
       FROM "zzsh_supply"."media_asset" a
       LEFT JOIN "zzsh_auth_user"."user" u ON a."ownership_kind" = 'USER_AVATAR' AND u."id" = a."owner_user_id"
       LEFT JOIN "zzsh_auth_admin"."user" au ON a."ownership_kind" = 'ADMIN_AVATAR' AND au."id" = a."uploaded_by_admin_id"
      WHERE ${conditions.join(" AND ")}
      ORDER BY a."created_at" DESC, a."id" DESC
      LIMIT $${parameters.length}`,
    parameters,
  );
  const hasMore = rows.rows.length > query.limit;
  const page = hasMore ? rows.rows.slice(0, query.limit) : rows.rows;
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      assetId: row.assetId,
      realm: row.realm,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      submittedAt: row.createdAt.toISOString(),
      width: row.width,
      height: row.height,
      byteSize: row.byteSize,
      mime: row.mime,
      reviewState: row.reviewState,
      accessClass: row.accessClass,
      reviewReason: row.reviewReason,
      revision: row.revision,
    })),
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({ v: 1, state: query.state, createdAt: last.createdAt.toISOString(), id: last.assetId })).toString("base64url")
      : null,
    limit: query.limit,
  };
}

export async function readAvatarOperationReceipt(
  client: PoolClient,
  actor: ProfileAvatarActor,
  operation: string,
  resourceId: string | null,
  fingerprint: string,
  key: string,
): Promise<{ receipt: "UNRESOLVED" } | { receipt: "RECORDED"; responseStatus: number; result: unknown }> {
  const row = (await client.query<{ requestFingerprint: string; responseStatus: number; responseBody: unknown }>(
    `SELECT "request_fingerprint" AS "requestFingerprint", "response_status" AS "responseStatus", "response_body" AS "responseBody"
       FROM "zzsh_supply"."idempotency_record" WHERE "scope_key" = $1 AND "key" = $2`,
    [JSON.stringify([actor.realm, actor.id, operation, resourceId]), key],
  )).rows[0];
  if (!row) return { receipt: "UNRESOLVED" };
  if (row.requestFingerprint !== fingerprint) throw conflict("Original request does not match the recorded operation");
  return { receipt: "RECORDED", responseStatus: row.responseStatus, result: row.responseBody };
}
