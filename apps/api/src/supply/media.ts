import sharp from "sharp";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

import { SecurityApiError } from "../auth/security-core";
import { assertGameScopeUsable, gameScopeSql, readAdminGameScope } from "../auth/admin-scope";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import type { AccountMediaVariant, OssAccountMedia } from "./account-media-oss";
import type { AccountImageCdn } from "./account-image-cdn";
import { readAccountWatermarkPolicy, resolveAccountImageWatermark } from "./account-image-watermark";
import { isAccountDisplayPubliclyEligible } from "./listing-query";
import { assertGameScope, bumpCatalogRevision, conflict, ensureOnlyFields, invalid, newSupplyId, notFound } from "./supply-util";

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_SIDE = 8192;
export const MAX_MEDIA_PIXELS = 40_000_000;
export const MEDIA_UPLOAD_TTL_MS = 10 * 60 * 1000;
export const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

export class MediaValidationError extends Error {}
export class MediaStorageError extends Error {
  constructor(message: string, readonly code: "MEDIA_OBJECT_NOT_FOUND" | "MEDIA_STORAGE_UNAVAILABLE" = "MEDIA_STORAGE_UNAVAILABLE") {
    super(message);
  }
}

export type ImageInfo = { mime: ImageMime; width: number; height: number };

async function imageDecoder(bytes: Buffer, pixelLimit = MAX_MEDIA_PIXELS) {
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new MediaValidationError("Image size is outside the allowed range");
  const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: pixelLimit }).timeout({ seconds: 10 });
  const metadata = await decoder.metadata();
  if ((metadata.format !== "jpeg" && metadata.format !== "png" && metadata.format !== "webp") || (metadata.pages ?? 1) !== 1) throw new MediaValidationError("Unsupported image or animation");
  const info: ImageInfo = { mime: `image/${metadata.format}`, width: metadata.width, height: metadata.height };
  assertImageWithinBounds(info, bytes.length);
  return { decoder, metadata, info, format: metadata.format };
}

export async function decodeImage(bytes: Buffer): Promise<{ info: ImageInfo; publicBytes: Buffer }> {
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new MediaValidationError("Image size is outside the allowed range");
  try {
    const { decoder, info, format } = await imageDecoder(bytes);
    // Orient only the derivative; original evidence bytes and their hashes stay intact.
    const output = await decoder.autoOrient().toFormat(format).toBuffer({ resolveWithObject: true });
    const publicBytes = output.data;
    info.width = output.info.width; info.height = output.info.height;
    assertImageWithinBounds(info, publicBytes.length);
    return { info, publicBytes };
  } catch {
    throw new MediaValidationError("Image is incomplete, invalid or outside resource limits");
  }
}

export async function inspectAccountWebp(bytes: Buffer, maxEdge: number): Promise<ImageInfo> {
  const info = await inspectPublicAccountImage(bytes, maxEdge * maxEdge);
  if (info.mime !== "image/webp" || Math.max(info.width, info.height) > maxEdge) throw new MediaValidationError("Invalid OSS account image variant");
  return info;
}

export async function inspectPublicAccountImage(bytes: Buffer, pixelLimit = MAX_MEDIA_PIXELS): Promise<ImageInfo> {
  const { decoder, metadata, info } = await imageDecoder(bytes, pixelLimit);
  if (metadata.exif || metadata.xmp || metadata.iptc || metadata.comments?.length) throw new MediaValidationError("Display image contains private metadata");
  await decoder.raw().toBuffer();
  return info;
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

// Upload intents declare the byte size before any bytes move. Rejecting the
// declared size with the concrete limit (and a stable `size` field path) keeps
// both the user publish form and the admin uploader on the same shared limit.
export function assertDeclaredMediaSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw invalid("Declared image size is invalid", "size");
  if (value > MAX_MEDIA_BYTES) throw invalid(`Declared image size ${value} exceeds the ${MAX_MEDIA_BYTES}-byte limit`, "size");
  return value;
}

export const STORAGE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export type MediaStorage = {
  available: boolean;
  kind: "local" | "oss" | "unavailable";
  readonly accountMedia?: OssAccountMedia;
  readonly accountImageCdn?: AccountImageCdn;
  readonly configuration?: Readonly<{
    target: Readonly<{ bucket: string; region: string; endpoint: string; objectPrefix: string }>;
    credentialMode: "ACCESS_KEY" | "STS";
    automaticCredentialRefresh: boolean;
  }>;
  write: (bytes: Buffer, contentHash: string, mime: ImageMime) => Promise<{ storageKey: string }>;
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
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new MediaStorageError("stored media is unavailable", code === "ENOENT" ? "MEDIA_OBJECT_NOT_FOUND" : "MEDIA_STORAGE_UNAVAILABLE");
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
  input: { gameId?: string; accountId?: string; purpose: string; mime: string; size: number; directOss?: boolean },
): Promise<{ intentId: string; uploadToken: string; expiresAt: string }> {
  if (!ALLOWED_IMAGE_MIMES.includes(input.mime as ImageMime)) throw invalid("MIME type is not allowed", "mime");
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_MEDIA_BYTES) throw invalid("Declared size is outside the allowed range");

  let accountId: string | null = null;
  let ownerUserId: string | null = null;
  let purpose: string;
  let ownershipKind: "PLATFORM_CATALOG" | "PLATFORM_CONTENT" | "USER_SUPPLY" | "USER_AVATAR" | "ADMIN_AVATAR";
  if (input.purpose === "AVATAR") {
    if (input.gameId !== undefined || input.accountId !== undefined) throw invalid("Avatar uploads cannot target a game or rental account");
    purpose = "AVATAR";
    ownershipKind = actor.realm === "admin" ? "ADMIN_AVATAR" : "USER_AVATAR";
    ownerUserId = actor.realm === "user" ? actor.userId! : null;
  } else if (actor.realm === "admin") {
    purpose = input.purpose;
    ownershipKind = purpose === "CONTENT_MEDIA" ? "PLATFORM_CONTENT" : "PLATFORM_CATALOG";
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
    ownershipKind = "USER_SUPPLY";
    if (!["ACCOUNT_EVIDENCE", "ACCOUNT_DISPLAY"].includes(purpose)) throw invalid("Purpose is not allowed");
    accountId = input.accountId;
    ownerUserId = actor.userId!;
  }
  if (input.directOss && ownershipKind !== "USER_SUPPLY") throw invalid("Direct upload requires account media");

  const intentId = newSupplyId("upload");
  const uploadToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MEDIA_UPLOAD_TTL_MS);
  await client.query(
    `INSERT INTO "zzsh_supply"."media_upload_intent"
      ("id", "token_hash", "game_id", "account_id", "purpose", "ownership_kind", "owner_user_id",
       "uploaded_by_realm", "uploaded_by_user_id", "uploaded_by_admin_id", "declared_mime", "declared_size", "expires_at", "direct_oss")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      intentId,
      tokenHash(uploadToken),
      input.gameId ?? null,
      accountId,
      purpose,
      ownershipKind,
      ownerUserId,
      actor.realm,
      actor.realm === "user" ? actor.userId : null,
      actor.realm === "admin" ? actor.adminUserId : null,
      input.mime,
      input.size,
      expiresAt,
      input.directOss === true,
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
  directOss: boolean;
  variants: AccountMediaVariant[];
  writtenStorageKeys: string[];
};

export type LockPublishingAccount = (
  client: PoolClient,
  accountId: string,
) => Promise<unknown>;

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
  directOss: boolean;
};

async function loadUploadIntent(client: Pool | PoolClient, intentId: string, forUpdate = false): Promise<UploadIntentRow | null> {
  const result = await client.query<UploadIntentRow>(
    `SELECT "account_id" AS "accountId", "token_hash" AS "tokenHash", "game_id" AS "gameId", "purpose", "ownership_kind" AS "ownershipKind",
            "owner_user_id" AS "ownerUserId", "uploaded_by_realm" AS "uploadedByRealm",
            "uploaded_by_user_id" AS "uploadedByUserId", "uploaded_by_admin_id" AS "uploadedByAdminId",
            "declared_mime" AS "declaredMime", "declared_size"::text AS "declaredSize", "expires_at" AS "expiresAt", "consumed_at" AS "consumedAt", "direct_oss" AS "directOss"
       FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [intentId],
  );
  return result.rows[0] ?? null;
}

function intentActorMatches(intent: { uploadedByRealm: string; uploadedByUserId: string | null; uploadedByAdminId: string | null }, actor: MediaActor): boolean {
  return intent.uploadedByRealm === actor.realm &&
    (actor.realm === "admin" ? intent.uploadedByAdminId === actor.adminUserId : intent.uploadedByUserId === actor.userId);
}

function assertUploadIntent(intent: UploadIntentRow | null, actor: MediaActor, uploadToken: string, directOss: boolean): asserts intent is UploadIntentRow {
  if (!intent || !intentActorMatches(intent, actor)) throw notFound();
  if (!tokensMatch(intent.tokenHash, uploadToken)) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Upload token is invalid");
  if (intent.consumedAt) throw conflict("Upload intent was already used");
  if (intent.expiresAt.getTime() <= Date.now()) throw conflict("Upload intent has expired");
  if ((intent.directOss === true) !== directOss) throw conflict("Upload transport does not match the intent");
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
  upload: Buffer | { contentHash: string },
): Promise<PreparedMediaUpload> {
  const intent = await loadUploadIntent(pool, intentId);
  const directOss = !Buffer.isBuffer(upload);
  assertUploadIntent(intent, actor, uploadToken, directOss);
  let bytes: Buffer;
  if (Buffer.isBuffer(upload)) bytes = upload;
  else {
    if (!STORAGE_KEY_PATTERN.test(upload.contentHash)) throw invalid("Invalid SHA-256", "contentHash");
    if (!storage.accountMedia) throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Direct media upload is unavailable");
    try {
      bytes = await storage.accountMedia.readUpload(intentId, Number(intent.declaredSize));
    } catch (error) {
      if (error instanceof MediaStorageError && error.code === "MEDIA_OBJECT_NOT_FOUND") throw conflict("Direct upload has not arrived");
      throw error;
    }
  }
  if (bytes.length !== Number(intent.declaredSize)) throw invalid("Uploaded size does not match the declared size");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  if (!Buffer.isBuffer(upload) && contentHash !== upload.contentHash) throw invalid("Uploaded SHA-256 does not match", "contentHash");
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
  const publicHash = createHash("sha256").update(publicBytes).digest("hex");
  // Keys are recorded before each write attempt: a transport failure after the
  // remote object landed (e.g. a timeout) leaves the outcome unknown, so the
  // attempted key must stay traceable as an orphan candidate.
  const writtenStorageKeys: string[] = [];
  let variants: AccountMediaVariant[] = [];
  try {
    writtenStorageKeys.push(contentHash);
    await storage.write(bytes, contentHash, image.mime);
    writtenStorageKeys.push(publicHash);
    await storage.write(publicBytes, publicHash, image.mime);
    if (directOss && intent.purpose === "ACCOUNT_DISPLAY" && storage.accountMedia) {
      const policy = await readAccountWatermarkPolicy(pool);
      const watermark = await resolveAccountImageWatermark(pool, policy);
      variants = await storage.accountMedia.generateVariants(publicHash, image, watermark, objectKey => writtenStorageKeys.push(objectKey));
    }
  } catch (error) {
    logOrphanedMediaObjects({ intentId, storageKeys: [...new Set(writtenStorageKeys)], phase: "write" });
    throw error;
  }
  return { intentId, uploadToken, image, byteSize: bytes.length, contentHash, publicHash, directOss, variants, writtenStorageKeys };
}

// Phase two runs inside the idempotent write transaction: the intent row is
// locked, the single-consumption invariants are re-asserted under that lock and
// the asset row, consumption marker and audit commit atomically.
export async function finalizeMediaUpload(
  client: PoolClient,
  actor: MediaActor,
  prepared: PreparedMediaUpload,
  lockPublishingAccount?: LockPublishingAccount,
): Promise<UploadedAsset> {
  const locatedIntent = await loadUploadIntent(client, prepared.intentId);
  if (!locatedIntent) throw notFound();
  if (locatedIntent.accountId !== null) {
    if (!lockPublishingAccount) throw conflict("Account media lock is required");
    await lockPublishingAccount(client, locatedIntent.accountId);
  }
  const intent = await loadUploadIntent(client, prepared.intentId, true);
  assertUploadIntent(intent, actor, prepared.uploadToken, prepared.directOss);

  const assetId = newSupplyId("asset");
  await client.query(
    `INSERT INTO "zzsh_supply"."media_asset"
      ("id", "game_id", "purpose", "ownership_kind", "owner_user_id", "uploaded_by_realm", "uploaded_by_user_id", "uploaded_by_admin_id",
       "storage_key", "content_hash", "mime", "byte_size", "width", "height", "public_storage_key", "access_class", "technical_state", "technical_checked_at", "account_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CASE WHEN $3='ACCOUNT_DISPLAY' THEN 'PUBLIC_DISPLAY' ELSE 'PRIVATE_REVIEW' END, 'READY', clock_timestamp(), $16)`,
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
  await recordAccountMediaVariants(client, assetId, prepared.variants);
  return {
    assetId,
    gameId: intent.gameId,
    purpose: intent.purpose,
    ownershipKind: intent.ownershipKind,
    reviewState: intent.purpose === "ACCOUNT_DISPLAY" ? "NOT_REQUIRED" : "PENDING",
    accessClass: intent.purpose === "ACCOUNT_DISPLAY" ? "PUBLIC_DISPLAY" : "PRIVATE_REVIEW",
    mime: prepared.image.mime,
    byteSize: prepared.byteSize,
    width: prepared.image.width,
    height: prepared.image.height,
    contentHash: prepared.contentHash,
  };
}

export async function recordAccountMediaVariants(client: PoolClient, assetId: string, variants: readonly AccountMediaVariant[]): Promise<void> {
  if (!variants.length) return;
  await client.query(
    `INSERT INTO zzsh_supply.account_image_variant(asset_id, max_edge, object_key, sha256, byte_size, width, height, watermark_revision)
     SELECT $1, v."maxEdge", v."objectKey", v.sha256, v."byteSize", v.width, v.height, v."watermarkRevision"
       FROM jsonb_to_recordset($2::jsonb) AS v("maxEdge" smallint, "objectKey" text, sha256 text, "byteSize" integer,
         width smallint, height smallint, "watermarkRevision" bigint)`,
    [assetId, JSON.stringify(variants)],
  );
}

type MediaAssetRow = {
  id: string;
  gameId: string | null;
  accountId: string | null;
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
  technicalState: string;
  reviewReason: string | null;
  avatarPolicyRevision?: string | null;
  reviewedByAdminId?: string | null;
  revision: string;
  createdAt: Date;
};

export async function loadMediaAsset(
  client: Pool | PoolClient,
  assetId: string,
  forUpdate = false,
): Promise<MediaAssetRow | null> {
  const result = await client.query<MediaAssetRow>(
    `SELECT "id", "game_id" AS "gameId", "account_id" AS "accountId", "purpose", "ownership_kind" AS "ownershipKind", "owner_user_id" AS "ownerUserId",
            "uploaded_by_realm" AS "uploadedByRealm", "uploaded_by_user_id" AS "uploadedByUserId", "uploaded_by_admin_id" AS "uploadedByAdminId",
            "storage_key" AS "storageKey", "public_storage_key" AS "publicStorageKey", "content_hash" AS "contentHash", "mime", "byte_size"::text AS "byteSize",
            "width", "height", "access_class" AS "accessClass", "review_state" AS "reviewState", "technical_state" AS "technicalState", "review_reason" AS "reviewReason", "avatar_policy_revision"::text AS "avatarPolicyRevision", "reviewed_by_admin_id" AS "reviewedByAdminId", "revision"::text AS "revision", "created_at" AS "createdAt"
       FROM "zzsh_supply"."media_asset" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [assetId],
  );
  return result.rows[0] ?? null;
}

/**
 * Page-batched binding counts.  Only the relations the review panel already
 * consumes are counted, and the existing game scope predicate is reused per
 * object so an out-of-scope binding cannot leak even as a number.  Counts are
 * deliberately split into current versus historical version references.
 */
async function bindingSummaryBatch(client: PoolClient, assetIds: string[], adminId: string, isBoss: boolean) {
  const result = new Map<string, { state: "KNOWN"; current: Record<string, number>; historical: Record<string, number> }>();
  if (!assetIds.length) return result;
  // Same convention as the queue itself: Boss carries no scope subquery.
  const scope = isBoss ? "" : ` AND ${gameScopeSql('o."gameId"', "$2", "false")}`;
  const rows = await client.query<{ assetId: string; objectType: string; current: boolean }>(
    `SELECT o."assetId", o."objectType", o."current" FROM (
       SELECT c."cover_media_id" AS "assetId", c."id" AS "gameId", 'game' AS "objectType", true AS "current" FROM "zzsh_supply"."game" c
         UNION ALL SELECT s."media_id", s."game_id", 'skin', true FROM "zzsh_supply"."skin" s
         UNION ALL SELECT b."media_id", b."game_id", 'billable_item', true FROM "zzsh_supply"."billable_item" b
         UNION ALL SELECT f."media_id", f."game_id", 'firearm', true FROM "zzsh_supply"."firearm" f
         UNION ALL SELECT m."asset_id", a."game_id", 'listing_version', v."id" = a."current_version_id"
           FROM "zzsh_supply"."listing_media" m
           JOIN "zzsh_supply"."listing_version" v ON v."id" = m."version_id"
           JOIN "zzsh_supply"."rental_account" a ON a."id" = v."account_id"
     ) o
      WHERE o."assetId" = ANY($1::text[]) AND o."assetId" IS NOT NULL${scope}`,
    isBoss ? [assetIds] : [assetIds, adminId],
  );
  for (const assetId of assetIds) result.set(assetId, { state: "KNOWN", current: {}, historical: {} });
  for (const row of rows.rows) {
    const summary = result.get(row.assetId);
    if (!summary) continue;
    const bucket = row.current ? summary.current : summary.historical;
    bucket[row.objectType] = (bucket[row.objectType] ?? 0) + 1;
  }
  return result;
}

/**
 * Admin media review collection. Selected administrators with an explicit but
 * empty game scope get NO_GAME_SCOPE here (collection entry), while a scoped
 * administrator without a matching game simply gets an empty page.
 */
export async function listAdminMediaReviews(
  client: PoolClient,
  query: {
    adminId: string;
    isBoss: boolean;
    state: string;
    ownershipKind: string | null;
    cursor: { createdAt: string; id: string } | null;
    limit: number;
  },
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null; limit: number }> {
  assertGameScopeUsable(await readAdminGameScope(client, query.adminId), query.isBoss);
  const parameters: unknown[] = [query.state];
  const conditions = [`a."review_state" = $1`, `a."purpose" <> 'AVATAR'`];
  if (query.ownershipKind) {
    parameters.push(query.ownershipKind);
    conditions.push(`a."ownership_kind" = $${parameters.length}`);
  }
  if (!query.isBoss) {
    parameters.push(query.adminId);
    conditions.push(gameScopeSql(`a."game_id"`, `$${parameters.length}`, "false"));
  }
  if (query.cursor) {
    parameters.push(query.cursor.createdAt);
    conditions.push(`(a."created_at", a."id") < ($${parameters.length}::timestamptz, $${parameters.length + 1})`);
    parameters.push(query.cursor.id);
  }
  parameters.push(query.limit + 1);
  const rows = await client.query(
    `SELECT a."id", a."account_id" AS "accountId", a."game_id" AS "gameId", a."purpose", a."ownership_kind" AS "ownershipKind", a."owner_user_id" AS "ownerUserId",
            a."uploaded_by_realm" AS "uploadedByRealm", a."uploaded_by_user_id" AS "uploadedByUserId", a."uploaded_by_admin_id" AS "uploadedByAdminId",
            a."content_hash" AS "contentHash", a."mime", a."byte_size"::text AS "byteSize", a."width", a."height",
            a."access_class" AS "accessClass", a."review_state" AS "reviewState", a."review_reason" AS "reviewReason",
            a."technical_state" AS "technicalState", a."technical_checked_at" AS "technicalCheckedAt", a."revision"::text AS "revision", a."created_at" AS "createdAt"
       FROM "zzsh_supply"."media_asset" a
      WHERE ${conditions.join(" AND ")}
      ORDER BY a."created_at" DESC, a."id" DESC
      LIMIT $${parameters.length}`,
    parameters,
  );
  const hasMore = rows.rows.length > query.limit;
  const items = hasMore ? rows.rows.slice(0, query.limit) : rows.rows;
  const bindings = await bindingSummaryBatch(client, items.map(item => item.id), query.adminId, query.isBoss);
  for (const item of items) item.binding = bindings.get(item.id) ?? { state: "UNAVAILABLE" };
  const last = items[items.length - 1] as { createdAt: string; id: string } | undefined;
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ v: 1, state: query.state, ownershipKind: query.ownershipKind, createdAt: last.createdAt, id: last.id })).toString("base64url")
    : null;
  return { items, nextCursor, limit: query.limit };
}

async function lockMediaAsset(
  client: PoolClient,
  assetId: string,
  lockPublishingAccount?: LockPublishingAccount,
): Promise<MediaAssetRow> {
  const located = await loadMediaAsset(client, assetId);
  if (!located) throw notFound();
  if (located.accountId !== null) {
    if (!lockPublishingAccount) throw conflict("Account media lock is required");
    await lockPublishingAccount(client, located.accountId);
  }
  const asset = await loadMediaAsset(client, assetId, true);
  if (!asset) throw notFound();
  return asset;
}

export type MediaReviewBinding = { accountId: string; accountRevision: string; versionId: string; assetRevision: string; byteHash: string };
export function parseMediaReviewBinding(value: unknown): MediaReviewBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid media account context");
  const body = value as Record<string, unknown>;
  ensureOnlyFields(body, ["accountId", "accountRevision", "versionId", "assetRevision", "byteHash"]);
  for (const key of ["accountId", "versionId"]) if (typeof body[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body[key])) throw invalid("Invalid media account context", key);
  for (const key of ["accountRevision", "assetRevision"]) if (typeof body[key] !== "string" || !/^[1-9]\d{0,18}$/.test(body[key])) throw invalid("Invalid media revision", key);
  if (typeof body.byteHash !== "string" || !/^[0-9a-f]{64}$/.test(body.byteHash)) throw invalid("Invalid media byte hash");
  return body as MediaReviewBinding;
}
export function assertMediaReviewBinding(asset: Pick<MediaAssetRow, "accountId" | "ownerUserId" | "purpose" | "ownershipKind" | "revision" | "contentHash">, account: { revision: string; current_version_id: string | null; owner_user_id: string } | undefined, binding: MediaReviewBinding): void {
  if (asset.accountId !== binding.accountId || asset.ownershipKind !== "USER_SUPPLY" || asset.purpose !== "ACCOUNT_DISPLAY") throw notFound();
  if (!account || account.revision !== binding.accountRevision || account.current_version_id !== binding.versionId || account.owner_user_id !== asset.ownerUserId || asset.revision !== binding.assetRevision || asset.contentHash !== binding.byteHash) throw conflict("Account, listing version or image changed; review again");
}
async function assertLockedAccountMediaContext(client: PoolClient, asset: MediaAssetRow, input: { accountContext?: MediaReviewBinding; reason?: string }): Promise<void> {
  if (asset.ownershipKind === "USER_SUPPLY" && asset.purpose === "ACCOUNT_DISPLAY" && !input.accountContext) throw conflict("Account image confirmation context is required; recheck in account supervision");
  if (!input.accountContext) return;
  const binding = parseMediaReviewBinding(input.accountContext)!;
  const account = (await client.query<{ revision: string; current_version_id: string | null; owner_user_id: string }>("SELECT revision::text,current_version_id,owner_user_id FROM zzsh_supply.rental_account WHERE id=$1", [binding.accountId])).rows[0];
  assertMediaReviewBinding(asset, account, binding);
  if (!(await client.query("SELECT 1 FROM zzsh_supply.listing_media WHERE version_id=$1 AND asset_id=$2", [binding.versionId, asset.id])).rowCount) throw conflict("Image is no longer bound to this listing version");
  if (!input.reason || input.reason.trim().length < 2 || input.reason.length > 500) throw invalid("A reason is required for account image disposition");
}
export async function reviewMediaAsset(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  assetId: string,
  input: { decision: string; reason?: string; visibility?: string; accountContext?: MediaReviewBinding },
  lockPublishingAccount?: LockPublishingAccount,
): Promise<MediaAssetRow> {
  const asset = await lockMediaAsset(client, assetId, lockPublishingAccount);
  await assertLockedAccountMediaContext(client, asset, input);
  // Platform content media has no game scope; its authorization is the content
  // permission checked by the route. Avatar media has no game scope either and
  // is authorized by the separate profile.avatar.review permission there.
  if (asset.gameId === null) {
    const avatar = asset.purpose === "AVATAR" && (asset.ownershipKind === "USER_AVATAR" || asset.ownershipKind === "ADMIN_AVATAR");
    if (!avatar && (asset.ownershipKind !== "PLATFORM_CONTENT" || asset.purpose !== "CONTENT_MEDIA")) throw notFound();
  } else {
    await assertGameScope(client, adminUserId, isBoss, asset.gameId);
  }
  if (input.decision !== "APPROVE" && input.decision !== "REJECT" && input.decision !== "QUARANTINE") throw invalid("Review decision is invalid");
  const needsReason = input.decision !== "APPROVE" || asset.reviewState === "REJECTED" || asset.reviewState === "QUARANTINED";
  if (needsReason && (!input.reason || input.reason.trim().length < 2 || input.reason.length > 500)) {
    throw invalid("A reason is required for this review decision");
  }
  if (input.decision === "APPROVE" && asset.ownershipKind === "USER_SUPPLY" && asset.purpose === "ACCOUNT_DISPLAY" && asset.technicalState !== "READY") {
    throw conflict("Media must pass technical validation before recovery");
  }
  if (input.decision === "APPROVE" && asset.purpose === "AVATAR" && asset.technicalState !== "READY") {
    throw conflict("Media must pass technical validation before approval");
  }
  const nextState = input.decision === "APPROVE" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : "QUARANTINED";
  const visibility = input.visibility ?? "PRIVATE_REVIEW";
  if (visibility !== "PUBLIC_DISPLAY" && visibility !== "PRIVATE_REVIEW") throw invalid("Visibility is invalid");
  if (visibility === "PUBLIC_DISPLAY") {
    if (nextState !== "APPROVED") throw invalid("Only approved media can be public");
    if (asset.ownershipKind !== "PLATFORM_CATALOG" && asset.ownershipKind !== "PLATFORM_CONTENT" && asset.purpose !== "ACCOUNT_DISPLAY" && asset.purpose !== "AVATAR") throw invalid("Only display images can be public");
    if (asset.ownershipKind === "USER_SUPPLY" && asset.purpose === "ACCOUNT_DISPLAY" && asset.technicalState !== "READY") throw conflict("Media is not technically ready for public display");
    if (!asset.publicStorageKey) throw conflict("A validated public derivative is required; upload the image again");
    if (asset.purpose === "AVATAR" && asset.technicalState !== "READY") throw conflict("Media is not technically ready for public display");
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
  input: { visibility: string; reason?: string; accountContext?: MediaReviewBinding },
  lockPublishingAccount?: LockPublishingAccount,
): Promise<MediaAssetRow> {
  const asset = await lockMediaAsset(client, assetId, lockPublishingAccount);
  await assertLockedAccountMediaContext(client, asset, input);
  if (asset.gameId === null) {
    if (asset.ownershipKind !== "PLATFORM_CONTENT" || asset.purpose !== "CONTENT_MEDIA") throw notFound();
  } else {
    await assertGameScope(client, adminUserId, isBoss, asset.gameId);
  }
  if (input.visibility !== "PUBLIC_DISPLAY" && input.visibility !== "PRIVATE_REVIEW") throw invalid("Visibility is invalid");
  if (input.visibility === "PUBLIC_DISPLAY") {
    const accountDisplayReady = asset.ownershipKind === "USER_SUPPLY" &&
      isAccountDisplayPubliclyEligible(asset, input.visibility);
    const platformMediaReady = asset.reviewState === "APPROVED" &&
      (asset.ownershipKind === "PLATFORM_CATALOG" || asset.ownershipKind === "PLATFORM_CONTENT") &&
      Boolean(asset.publicStorageKey);
    if (!((asset.ownershipKind === "USER_SUPPLY" && accountDisplayReady) || platformMediaReady)) throw conflict("Media is not technically ready for public display");
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
  const cover = await client.query<{gameId:string}>(`UPDATE "zzsh_supply"."game" SET "cover_media_id" = NULL, "updated_at" = clock_timestamp() WHERE "cover_media_id" = $1 RETURNING id AS "gameId"`, [assetId]);
  const skins = await client.query<{gameId:string}>(`UPDATE "zzsh_supply"."skin" SET "media_id" = NULL WHERE "media_id" = $1 RETURNING game_id AS "gameId"`, [assetId]);
  const items = await client.query<{gameId:string}>(`UPDATE "zzsh_supply"."billable_item" SET "media_id" = NULL, "updated_at" = clock_timestamp() WHERE "media_id" = $1 RETURNING game_id AS "gameId"`, [assetId]);
  const firearms = await client.query<{gameId:string}>(`UPDATE "zzsh_supply"."firearm" SET "media_id" = NULL, "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "media_id" = $1 RETURNING game_id AS "gameId"`, [assetId]);
  const games = new Set([...cover.rows,...skins.rows,...items.rows,...firearms.rows].map(row=>row.gameId));
  for(const gameId of [...games].sort())await bumpCatalogRevision(client,gameId);
}
