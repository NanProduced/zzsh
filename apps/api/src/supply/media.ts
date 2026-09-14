import sharp from "sharp";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { assertGameScope, conflict, invalid, newSupplyId, notFound } from "./supply-util";

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_SIDE = 8192;
export const MAX_MEDIA_PIXELS = 40_000_000;
export const MEDIA_UPLOAD_TTL_MS = 10 * 60 * 1000;
export const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

export class MediaValidationError extends Error {}
export class MediaStorageError extends Error {}

export type ImageInfo = { mime: ImageMime; width: number; height: number };

export async function decodeImage(bytes: Buffer): Promise<{ info: ImageInfo; publicBytes: Buffer }> {
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new MediaValidationError("Image size is outside the allowed range");
  try {
    const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_MEDIA_PIXELS }).timeout({ seconds: 10 });
    const metadata = await decoder.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new MediaValidationError("Unsupported image or animation");
    const info: ImageInfo = { mime: ("image/" + metadata.format) as ImageMime, width: metadata.width!, height: metadata.height! };
    assertImageWithinBounds(info, bytes.length);
    // Full decode and re-encode; Sharp strips metadata by default. Never publish original evidence.
    const publicBytes = await decoder.toFormat(metadata.format as "jpeg" | "png" | "webp").toBuffer();
    assertImageWithinBounds(info, publicBytes.length);
    return { info, publicBytes };
  } catch {
    throw new MediaValidationError("Image is incomplete, invalid or outside resource limits");
  }
}

export async function inspectImage(bytes: Buffer): Promise<ImageInfo> {
  return (await decodeImage(bytes)).info;
}

export function assertImageWithinBounds(info: ImageInfo, byteSize: number): void {
  if (byteSize <= 0 || byteSize > MAX_MEDIA_BYTES) throw new MediaValidationError("Image size is outside the allowed range");
  if (info.width <= 0 || info.height <= 0 || info.width > MAX_MEDIA_SIDE || info.height > MAX_MEDIA_SIDE) {
    throw new MediaValidationError("Image dimensions are outside the allowed range");
  }
  if (info.width * info.height > MAX_MEDIA_PIXELS) throw new MediaValidationError("Image pixel count is outside the allowed range");
}

export const STORAGE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export type MediaStorage = {
  available: boolean;
  kind: "local" | "oss" | "unavailable";
  write: (bytes: Buffer, contentHash: string) => Promise<{ storageKey: string }>;
  read: (storageKey: string) => Promise<Buffer>;
};

// Content-addressed objects written before the database transaction commits can
// outlive a failed request. They are never deleted automatically: a concurrent
// upload (even with the same intent/token/key but different bytes) may reference
// equal-hash or distinct keys, and the mere existence of an idempotency record
// cannot prove these objects are referenced. Logged entries are PENDING
// candidates, not confirmed orphans: a cleanup sweep must verify actual
// references before deleting anything.
export function logOrphanedMediaObjects(input: { intentId: string; storageKeys: readonly string[]; phase: "write" | "commit" }): void {
  if (input.storageKeys.length === 0) return;
  console.error(JSON.stringify({
    event: "zzsh_supply_media_orphan_candidate",
    intentId: input.intentId,
    storageKeys: [...input.storageKeys],
    phase: input.phase,
  }));
}

export function createLocalMediaStorage(root: string): MediaStorage {
  return {
    available: true,
    kind: "local",
    async write(bytes, contentHash) {
      if (!STORAGE_KEY_PATTERN.test(contentHash)) throw new MediaStorageError("content hash is invalid");
      const directory = join(root, contentHash.slice(0, 2));
      const target = join(directory, contentHash);
      await mkdir(directory, { recursive: true });
      try {
        await stat(target);
        return { storageKey: contentHash };
      } catch {
        // The content-addressed file does not exist yet.
      }
      const temporary = `${target}.tmp-${randomUUID()}`;
      await writeFile(temporary, bytes);
      try {
        await rename(temporary, target);
      } catch (error) {
        try {
          await stat(target);
        } catch {
          throw error;
        }
      }
      return { storageKey: contentHash };
    },
    async read(storageKey) {
      if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new MediaStorageError("storage key is invalid");
      try {
        return await readFile(join(root, storageKey.slice(0, 2), storageKey));
      } catch {
        throw new MediaStorageError("stored media is unavailable");
      }
    },
  };
}

export function createUnavailableMediaStorage(): MediaStorage {
  return {
    available: false,
    kind: "unavailable",
    async write() {
      throw new MediaStorageError("media storage is not configured");
    },
    async read() {
      throw new MediaStorageError("media storage is not configured");
    },
  };
}

export type MediaActor = { realm: "admin" | "user"; userId?: string; adminUserId?: string };

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokensMatch(expectedHash: string, provided: string): boolean {
  const left = Buffer.from(expectedHash, "hex");
  const right = Buffer.from(tokenHash(provided), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createMediaUploadIntent(
  client: PoolClient,
  actor: MediaActor,
  input: { gameId?: string; accountId?: string; purpose: string; mime: string; size: number },
): Promise<{ intentId: string; uploadToken: string; expiresAt: string }> {
  if (!ALLOWED_IMAGE_MIMES.includes(input.mime as ImageMime)) throw invalid("MIME type is not allowed");
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_MEDIA_BYTES) throw invalid("Declared size is outside the allowed range");

  let accountId: string | null = null;
  let ownerUserId: string | null = null;
  let purpose: string;
  if (actor.realm === "admin") {
    purpose = input.purpose;
    if (input.accountId !== undefined) throw invalid("Platform uploads cannot target a rental account");
    if (purpose === "CONTENT_MEDIA") {
      // Platform-level content media has no game affiliation.
      if (input.gameId !== undefined) throw invalid("Content media cannot target a game");
    } else if (["GAME_COVER", "SKIN_MEDIA", "ITEM_MEDIA", "FIREARM_MEDIA"].includes(purpose)) {
      if (!input.gameId) throw invalid("Game is required for catalog media");
      const gameExists = await client.query(`SELECT 1 FROM "zzsh_supply"."game" WHERE "id" = $1`, [input.gameId]);
      if (gameExists.rows.length === 0) throw notFound();
    } else {
      throw invalid("Purpose is not allowed");
    }
  } else {
    if (!input.gameId) throw invalid("Game is required for user uploads");
    if (!input.accountId) throw invalid("Account is required for user uploads");
    const account = await client.query<{ ownerUserId: string; gameId: string }>(
      `SELECT "owner_user_id" AS "ownerUserId", "game_id" AS "gameId" FROM "zzsh_supply"."rental_account" WHERE "id" = $1`,
      [input.accountId],
    );
    const row = account.rows[0];
    if (!row || row.gameId !== input.gameId || row.ownerUserId !== actor.userId) throw notFound();
    purpose = input.purpose;
    if (!["ACCOUNT_EVIDENCE", "ACCOUNT_DISPLAY"].includes(purpose)) throw invalid("Purpose is not allowed");
    accountId = input.accountId;
    ownerUserId = actor.userId!;
  }

  const intentId = newSupplyId("upload");
  const uploadToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MEDIA_UPLOAD_TTL_MS);
  await client.query(
    `INSERT INTO "zzsh_supply"."media_upload_intent"
      ("id", "token_hash", "game_id", "account_id", "purpose", "ownership_kind", "owner_user_id",
       "uploaded_by_realm", "uploaded_by_user_id", "uploaded_by_admin_id", "declared_mime", "declared_size", "expires_at")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      intentId,
      tokenHash(uploadToken),
      input.gameId ?? null,
      accountId,
      purpose,
      actor.realm === "admin" ? (purpose === "CONTENT_MEDIA" ? "PLATFORM_CONTENT" : "PLATFORM_CATALOG") : "USER_SUPPLY",
      ownerUserId,
      actor.realm,
      actor.realm === "user" ? actor.userId : null,
      actor.realm === "admin" ? actor.adminUserId : null,
      input.mime,
      input.size,
      expiresAt,
    ],
  );
  return { intentId, uploadToken, expiresAt: expiresAt.toISOString() };
}

export type UploadedAsset = {
  assetId: string;
  gameId: string | null;
  purpose: string;
  ownershipKind: string;
  reviewState: string;
  accessClass: string;
  mime: string;
  byteSize: number;
  width: number;
  height: number;
  contentHash: string;
};

export type PreparedMediaUpload = {
  intentId: string;
  uploadToken: string;
  image: ImageInfo;
  byteSize: number;
  contentHash: string;
  publicHash: string;
  writtenStorageKeys: string[];
};

type UploadIntentRow = {
  tokenHash: string;
  accountId: string | null;
  gameId: string;
  purpose: string;
  ownershipKind: string;
  ownerUserId: string | null;
  uploadedByRealm: string;
  uploadedByUserId: string | null;
  uploadedByAdminId: string | null;
  declaredMime: ImageMime;
  declaredSize: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

async function loadUploadIntent(client: Pool | PoolClient, intentId: string, forUpdate = false): Promise<UploadIntentRow | null> {
  const result = await client.query<UploadIntentRow>(
    `SELECT "account_id" AS "accountId", "token_hash" AS "tokenHash", "game_id" AS "gameId", "purpose", "ownership_kind" AS "ownershipKind",
            "owner_user_id" AS "ownerUserId", "uploaded_by_realm" AS "uploadedByRealm",
            "uploaded_by_user_id" AS "uploadedByUserId", "uploaded_by_admin_id" AS "uploadedByAdminId",
            "declared_mime" AS "declaredMime", "declared_size"::text AS "declaredSize", "expires_at" AS "expiresAt", "consumed_at" AS "consumedAt"
       FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [intentId],
  );
  return result.rows[0] ?? null;
}

function intentActorMatches(intent: { uploadedByRealm: string; uploadedByUserId: string | null; uploadedByAdminId: string | null }, actor: MediaActor): boolean {
  return intent.uploadedByRealm === actor.realm &&
    (actor.realm === "admin" ? intent.uploadedByAdminId === actor.adminUserId : intent.uploadedByUserId === actor.userId);
}

// Phase one runs outside any database transaction: object storage writes must
// not hold a pooled connection while network calls are in flight. The intent row
// is immutable apart from consumption; expiry and consumption are checked again
// during finalization because they can change while storage writes are running.
export async function prepareMediaUpload(
  pool: Pool,
  storage: MediaStorage,
  actor: MediaActor,
  intentId: string,
  uploadToken: string,
  bytes: Buffer,
): Promise<PreparedMediaUpload> {
  const intent = await loadUploadIntent(pool, intentId);
  if (!intent) throw notFound();
  if (intent.consumedAt) throw conflict("Upload intent was already used");
  if (intent.expiresAt.getTime() < Date.now()) throw conflict("Upload intent has expired");
  if (!intentActorMatches(intent, actor)) throw notFound();
  if (!tokensMatch(intent.tokenHash, uploadToken)) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Upload token is invalid");
  if (bytes.length !== Number(intent.declaredSize)) throw invalid("Uploaded size does not match the declared size");
  let image: ImageInfo;
  let publicBytes: Buffer;
  try {
    const decoded = await decodeImage(bytes);
    image = decoded.info;
    publicBytes = decoded.publicBytes;
    assertImageWithinBounds(image, bytes.length);
  } catch (error) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, error instanceof Error ? error.message : "Image is invalid");
  }
  if (image.mime !== intent.declaredMime) throw invalid("Uploaded bytes do not match the declared image type");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const publicHash = createHash("sha256").update(publicBytes).digest("hex");
  // Keys are recorded before each write attempt: a transport failure after the
  // remote object landed (e.g. a timeout) leaves the outcome unknown, so the
  // attempted key must stay traceable as an orphan candidate.
  const writtenStorageKeys: string[] = [];
  try {
    writtenStorageKeys.push(contentHash);
    await storage.write(bytes, contentHash);
    writtenStorageKeys.push(publicHash);
    await storage.write(publicBytes, publicHash);
  } catch (error) {
    logOrphanedMediaObjects({ intentId, storageKeys: [...new Set(writtenStorageKeys)], phase: "write" });
    throw error;
  }
  return { intentId, uploadToken, image, byteSize: bytes.length, contentHash, publicHash, writtenStorageKeys };
}

// Phase two runs inside the idempotent write transaction: the intent row is
// locked, the single-consumption invariants are re-asserted under that lock and
// the asset row, consumption marker and audit commit atomically.
export async function finalizeMediaUpload(
  client: PoolClient,
  actor: MediaActor,
  prepared: PreparedMediaUpload,
): Promise<UploadedAsset> {
  const intent = await loadUploadIntent(client, prepared.intentId, true);
  if (!intent) throw notFound();
  if (intent.consumedAt) throw conflict("Upload intent was already used");
  if (intent.expiresAt.getTime() < Date.now()) throw conflict("Upload intent has expired");
  if (!intentActorMatches(intent, actor)) throw notFound();
  if (!tokensMatch(intent.tokenHash, prepared.uploadToken)) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Upload token is invalid");

  const assetId = newSupplyId("asset");
  await client.query(
    `INSERT INTO "zzsh_supply"."media_asset"
      ("id", "game_id", "purpose", "ownership_kind", "owner_user_id", "uploaded_by_realm", "uploaded_by_user_id", "uploaded_by_admin_id",
       "storage_key", "content_hash", "mime", "byte_size", "width", "height", "public_storage_key", "account_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      assetId,
      intent.gameId,
      intent.purpose,
      intent.ownershipKind,
      intent.ownerUserId,
      intent.uploadedByRealm,
      intent.uploadedByUserId,
      intent.uploadedByAdminId,
      prepared.contentHash,
      prepared.contentHash,
      prepared.image.mime,
      prepared.byteSize,
      prepared.image.width,
      prepared.image.height,
      prepared.publicHash,
      intent.accountId,
    ],
  );
  await client.query(
    `UPDATE "zzsh_supply"."media_upload_intent" SET "consumed_at" = clock_timestamp(), "consumed_asset_id" = $1 WHERE "id" = $2`,
    [assetId, prepared.intentId],
  );
  return {
    assetId,
    gameId: intent.gameId,
    purpose: intent.purpose,
    ownershipKind: intent.ownershipKind,
    reviewState: "PENDING",
    accessClass: "PRIVATE_REVIEW",
    mime: prepared.image.mime,
    byteSize: prepared.byteSize,
    width: prepared.image.width,
    height: prepared.image.height,
    contentHash: prepared.contentHash,
  };
}

type MediaAssetRow = {
  id: string;
  gameId: string | null;
  purpose: string;
  ownershipKind: string;
  ownerUserId: string | null;
  uploadedByRealm: string;
  uploadedByUserId: string | null;
  uploadedByAdminId: string | null;
  storageKey: string;
  publicStorageKey: string | null;
  contentHash: string;
  mime: ImageMime;
  byteSize: string;
  width: number;
  height: number;
  accessClass: string;
  reviewState: string;
  reviewReason: string | null;
  revision: string;
};

export async function loadMediaAsset(client: Pool | PoolClient, assetId: string): Promise<MediaAssetRow | null> {
  const result = await client.query<MediaAssetRow>(
    `SELECT "id", "game_id" AS "gameId", "purpose", "ownership_kind" AS "ownershipKind", "owner_user_id" AS "ownerUserId",
            "uploaded_by_realm" AS "uploadedByRealm", "uploaded_by_user_id" AS "uploadedByUserId", "uploaded_by_admin_id" AS "uploadedByAdminId",
            "storage_key" AS "storageKey", "public_storage_key" AS "publicStorageKey", "content_hash" AS "contentHash", "mime", "byte_size"::text AS "byteSize",
            "width", "height", "access_class" AS "accessClass", "review_state" AS "reviewState", "review_reason" AS "reviewReason", "revision"::text AS "revision"
       FROM "zzsh_supply"."media_asset" WHERE "id" = $1`,
    [assetId],
  );
  return result.rows[0] ?? null;
}

export async function reviewMediaAsset(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  assetId: string,
  input: { decision: string; reason?: string; visibility?: string },
): Promise<MediaAssetRow> {
  const current = await client.query<MediaAssetRow & { gameId: string }>(
    `SELECT "id", "game_id" AS "gameId", "purpose", "ownership_kind" AS "ownershipKind", "owner_user_id" AS "ownerUserId",
            "storage_key" AS "storageKey", "public_storage_key" AS "publicStorageKey", "content_hash" AS "contentHash", "mime", "byte_size"::text AS "byteSize",
            "width", "height", "access_class" as "accessClass", "review_state" AS "reviewState", "review_reason" AS "reviewReason", "revision"::text AS "revision",
            "uploaded_by_realm" AS "uploadedByRealm", "uploaded_by_user_id" AS "uploadedByUserId", "uploaded_by_admin_id" AS "uploadedByAdminId"
       FROM "zzsh_supply"."media_asset" WHERE "id" = $1 FOR UPDATE`,
    [assetId],
  );
  const asset = current.rows[0];
  if (!asset) throw notFound();
  // Platform content media has no game scope; its authorization is the content
  // permission checked by the route. Catalog/user media keeps the game scope check.
  if (asset.gameId === null) {
    if (asset.ownershipKind !== "PLATFORM_CONTENT" || asset.purpose !== "CONTENT_MEDIA") throw notFound();
  } else {
    await assertGameScope(client, adminUserId, isBoss, asset.gameId);
  }
  if (input.decision !== "APPROVE" && input.decision !== "REJECT" && input.decision !== "QUARANTINE") throw invalid("Review decision is invalid");
  if (input.decision !== "APPROVE" && (!input.reason || input.reason.trim().length < 2 || input.reason.length > 500)) {
    throw invalid("A reason is required for this review decision");
  }
  const nextState = input.decision === "APPROVE" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : "QUARANTINED";
  const visibility = input.visibility ?? "PRIVATE_REVIEW";
  if (visibility !== "PUBLIC_DISPLAY" && visibility !== "PRIVATE_REVIEW") throw invalid("Visibility is invalid");
  if (visibility === "PUBLIC_DISPLAY") {
    if (nextState !== "APPROVED") throw invalid("Only approved media can be public");
    if (asset.ownershipKind !== "PLATFORM_CATALOG" && asset.ownershipKind !== "PLATFORM_CONTENT" && asset.purpose !== "ACCOUNT_DISPLAY") throw invalid("Only display images can be public");
    if (!asset.publicStorageKey) throw conflict("A validated public derivative is required; upload the image again");
  }
  await client.query(
    `UPDATE "zzsh_supply"."media_asset"
        SET "review_state" = $1, "reviewed_by_admin_id" = $2, "reviewed_at" = clock_timestamp(),
            "review_reason" = $3, "access_class" = $4, "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $5`,
    [nextState, adminUserId, input.reason ?? null, visibility, assetId],
  );
  if (visibility === "PRIVATE_REVIEW") await clearMediaBindings(client, assetId);
  return (await loadMediaAsset(client, assetId))!;
}

export async function changeMediaVisibility(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  assetId: string,
  input: { visibility: string; reason?: string },
): Promise<MediaAssetRow> {
  const current = await client.query<MediaAssetRow>(
    `SELECT "id", "game_id" AS "gameId", "purpose", "ownership_kind" AS "ownershipKind", "owner_user_id" AS "ownerUserId",
            "storage_key" AS "storageKey", "public_storage_key" AS "publicStorageKey", "content_hash" AS "contentHash", "mime", "byte_size"::text AS "byteSize",
            "width", "height", "access_class" AS "accessClass", "review_state" AS "reviewState", "review_reason" AS "reviewReason", "revision"::text AS "revision",
            "uploaded_by_realm" AS "uploadedByRealm", "uploaded_by_user_id" AS "uploadedByUserId", "uploaded_by_admin_id" AS "uploadedByAdminId"
       FROM "zzsh_supply"."media_asset" WHERE "id" = $1 FOR UPDATE`,
    [assetId],
  );
  const asset = current.rows[0];
  if (!asset) throw notFound();
  if (asset.gameId === null) {
    if (asset.ownershipKind !== "PLATFORM_CONTENT" || asset.purpose !== "CONTENT_MEDIA") throw notFound();
  } else {
    await assertGameScope(client, adminUserId, isBoss, asset.gameId);
  }
  if (input.visibility !== "PUBLIC_DISPLAY" && input.visibility !== "PRIVATE_REVIEW") throw invalid("Visibility is invalid");
  if (input.visibility === "PUBLIC_DISPLAY") {
    if (asset.reviewState !== "APPROVED") throw conflict("Media must be approved before public display");
    if (asset.ownershipKind !== "PLATFORM_CATALOG" && asset.ownershipKind !== "PLATFORM_CONTENT" && asset.purpose !== "ACCOUNT_DISPLAY") throw invalid("Only display images can be public");
    if (!asset.publicStorageKey) throw conflict("A validated public derivative is required; upload the image again");
  }
  await client.query(
    `UPDATE "zzsh_supply"."media_asset"
        SET "access_class" = $1, "review_reason" = COALESCE($2, "review_reason"), "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $3`,
    [input.visibility, input.reason ?? null, assetId],
  );
  if (input.visibility === "PRIVATE_REVIEW") await clearMediaBindings(client, assetId);
  return (await loadMediaAsset(client, assetId))!;
}

async function clearMediaBindings(client: PoolClient, assetId: string): Promise<void> {
  await client.query(`UPDATE "zzsh_supply"."game" SET "cover_media_id" = NULL, "catalog_revision" = "catalog_revision" + 1, "updated_at" = clock_timestamp() WHERE "cover_media_id" = $1`, [assetId]);
  await client.query(`UPDATE "zzsh_supply"."skin" SET "media_id" = NULL, "updated_at" = clock_timestamp() WHERE "media_id" = $1`, [assetId]);
  await client.query(`UPDATE "zzsh_supply"."billable_item" SET "media_id" = NULL, "updated_at" = clock_timestamp() WHERE "media_id" = $1`, [assetId]);
  await client.query(`UPDATE "zzsh_supply"."firearm" SET "media_id" = NULL, "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "media_id" = $1`, [assetId]);
}
