import sharp from "sharp";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

import { decodeImage } from "../src/supply/media";

// Failure-injection, duplicate and ITEM_MEDIA binding checks for the two-phase
// media upload flow. Runs against the isolated supply test app with a
// fault-injecting wrapper around the local content-addressed storage; the
// storage contract is identical for the OSS adapter.

export type MediaCookieJar = { header: () => string; update: (response: Response) => void };

export type MediaStorageFaults = {
  // Queue of outcomes consumed one per storage write call; empty means success.
  // "land-then-timeout" lands the object in storage and then throws, leaving the
  // write outcome unknown to the caller.
  writeOutcomes: Array<"ok" | "fail" | "slow-fail" | "land-then-timeout">;
  writeCalls: number;
  // Optional hook invoked after each completed storage write (including the
  // landed object of a land-then-timeout), receiving the write's stable
  // sequence number captured at increment time. Used to inject mid-upload
  // state changes such as a permission revocation between the two phases, or
  // to barrier concurrent uploads.
  afterWrite?: (writeCall: number) => Promise<void>;
};

export type MediaOssChecksContext = {
  base: string;
  pool: Pool;
  maintenance: Pool;
  operator: { jar: MediaCookieJar; id: string };
  boss: { jar: MediaCookieJar; id: string };
  gameId: string;
  itemId: string;
  mediaDir: string;
  faults: MediaStorageFaults;
};

const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const ROLLBACK_REQUEST_ID = "req_media_rollback_probe";

let distinctColor = 0;
async function distinctBytes(): Promise<Buffer> {
  distinctColor += 1;
  return sharp({ create: { width: 48, height: 48, channels: 3, background: { r: distinctColor % 256, g: (distinctColor * 37) % 256, b: (distinctColor * 73) % 256 } } })
    .withExif({ IFD0: { Artist: `media-oss-checks-${distinctColor}` } })
    .png()
    .toBuffer();
}

function key(prefix: string): Record<string, string> {
  return { "idempotency-key": `idem_media_${prefix}_${randomUUID().replaceAll("-", "")}` };
}

async function jsonRequest(
  base: string,
  path: string,
  jar: MediaCookieJar,
  body: Record<string, unknown>,
  idempotencyKey: Record<string, string>,
): Promise<{ status: number; body: Record<string, any> | null }> {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { origin: ADMIN_ORIGIN, "content-type": "application/json", cookie: jar.header(), ...idempotencyKey },
    body: JSON.stringify(body),
  });
  jar.update(response);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function putJson(
  base: string,
  path: string,
  jar: MediaCookieJar,
  body: Record<string, unknown>,
  idempotencyKey: Record<string, string>,
): Promise<{ status: number; body: Record<string, any> | null }> {
  const response = await fetch(base + path, {
    method: "PUT",
    headers: { origin: ADMIN_ORIGIN, "content-type": "application/json", cookie: jar.header(), ...idempotencyKey },
    body: JSON.stringify(body),
  });
  jar.update(response);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function uploadBytes(
  base: string,
  path: string,
  jar: MediaCookieJar,
  token: string,
  bytes: Buffer,
  idempotencyKey: Record<string, string>,
  requestId?: string,
): Promise<{ status: number; body: Record<string, any> | null }> {
  const response = await fetch(base + path, {
    method: "PUT",
    headers: {
      origin: ADMIN_ORIGIN,
      "content-type": "image/png",
      "x-upload-token": token,
      cookie: jar.header(),
      ...(requestId ? { "x-request-id": requestId } : {}),
      ...idempotencyKey,
    },
    body: new Uint8Array(bytes),
  });
  jar.update(response);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function countMediaFiles(mediaDir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(mediaDir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += (await readdir(join(mediaDir, entry.name))).length;
  }
  return total;
}

async function withOrphanLog<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = ((message: unknown) => {
    if (typeof message === "string" && message.includes("zzsh_supply_media_orphan_candidate")) lines.push(message);
  }) as typeof console.error;
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

export async function runMediaOssChecks(context: MediaOssChecksContext): Promise<void> {
  const { base, pool, maintenance, operator, boss, gameId, itemId, mediaDir, faults } = context;
  const createIntent = (size: number) =>
    jsonRequest(base, "/api/bff/admin/supply/media/upload-intents", operator.jar, { gameId, purpose: "ITEM_MEDIA", mime: "image/png", size }, key("intent"));
  const review = (assetId: string, body: Record<string, unknown>) =>
    jsonRequest(base, `/api/bff/admin/supply/media/${assetId}/review`, operator.jar, body, key("review"));
  const bindItemMedia = (jar: MediaCookieJar, targetItem: string, mediaId: string | null) =>
    putJson(base, `/api/bff/admin/supply/items/${targetItem}`, jar, { mediaId }, key("bind"));

  // ---------- ITEM_MEDIA 绑定与公开投影 ----------
  const itemBytes = await distinctBytes();
  const itemIntent = await createIntent(itemBytes.length);
  assert.equal(itemIntent.status, 200, JSON.stringify(itemIntent.body));
  const itemUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${itemIntent.body?.intentId}`, operator.jar, itemIntent.body?.uploadToken as string, itemBytes, key("upload"));
  assert.equal(itemUpload.status, 200, JSON.stringify(itemUpload.body));
  assert.equal(itemUpload.body?.purpose, "ITEM_MEDIA");
  const itemAssetId = itemUpload.body?.assetId as string;

  const bindPending = await bindItemMedia(operator.jar, itemId, itemAssetId);
  assert.equal(bindPending.status, 400, "unreviewed media must not bind to an item");
  const approvedPrivate = await review(itemAssetId, { decision: "APPROVE" });
  assert.equal(approvedPrivate.status, 200);
  const bindPrivate = await bindItemMedia(operator.jar, itemId, itemAssetId);
  assert.equal(bindPrivate.status, 400, "private media must not bind to an item");
  const approvedPublic = await review(itemAssetId, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" });
  assert.equal(approvedPublic.status, 200);
  const bindOk = await bindItemMedia(operator.jar, itemId, itemAssetId);
  assert.equal(bindOk.status, 200, JSON.stringify(bindOk.body));
  const itemRow = await pool.query<{ mediaId: string | null }>(`SELECT "media_id" AS "mediaId" FROM "zzsh_supply"."billable_item" WHERE "id" = $1`, [itemId]);
  assert.equal(itemRow.rows[0]?.mediaId, itemAssetId);

  const publicCatalog = await (await fetch(`${base}/api/v1/supply/games/${gameId}/catalog`)).json();
  const publicItem = publicCatalog.items.find((entry: { id: string }) => entry.id === itemId);
  assert.equal(publicItem?.mediaId, itemAssetId, "approved public ITEM_MEDIA must be projected to the public catalog");

  const itemContent = await fetch(`${base}/api/v1/supply/media/${itemAssetId}/content`);
  assert.equal(itemContent.status, 200);
  assert.equal((await sharp(Buffer.from(await itemContent.arrayBuffer())).metadata()).exif, undefined, "public item media must be the metadata-clean derivative");

  // Purpose mismatch and cross-game binding are rejected.
  const coverBytes = await distinctBytes();
  const coverIntent = await jsonRequest(base, "/api/bff/admin/supply/media/upload-intents", operator.jar, { gameId, purpose: "GAME_COVER", mime: "image/png", size: coverBytes.length }, key("intent"));
  assert.equal(coverIntent.status, 200, JSON.stringify(coverIntent.body));
  const coverUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${coverIntent.body?.intentId}`, operator.jar, coverIntent.body?.uploadToken as string, coverBytes, key("upload"));
  assert.equal(coverUpload.status, 200);
  await review(coverUpload.body?.assetId as string, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" });
  const bindWrongPurpose = await bindItemMedia(operator.jar, itemId, coverUpload.body?.assetId as string);
  assert.equal(bindWrongPurpose.status, 400, "media purpose must match the binding");

  const secondGame = await jsonRequest(base, "/api/bff/admin/supply/games", boss.jar, { code: "media_oss_game", name: "媒体隔离游戏" }, key("game"));
  assert.equal(secondGame.status, 200, JSON.stringify(secondGame.body));
  const secondGameId = secondGame.body?.game?.id as string;
  const secondItem = await jsonRequest(base, `/api/bff/admin/supply/games/${secondGameId}/items`, boss.jar, { code: "media_item", name: "隔离物品", unit: "PIECE" }, key("item"));
  assert.equal(secondItem.status, 200, JSON.stringify(secondItem.body));
  const bindCrossGame = await bindItemMedia(boss.jar, secondItem.body?.id as string, itemAssetId);
  assert.equal(bindCrossGame.status, 400, "media from another game must not bind");
  const operatorCrossGame = await bindItemMedia(operator.jar, secondItem.body?.id as string, itemAssetId);
  assert.equal(operatorCrossGame.status, 404, "unscoped operators must not touch another game's items");

  // Revoking visibility clears the binding in the same transaction and hides the projection.
  const revoked = await jsonRequest(base, `/api/bff/admin/supply/media/${itemAssetId}/visibility`, operator.jar, { visibility: "PRIVATE_REVIEW", reason: "撤销物品图" }, key("visibility"));
  assert.equal(revoked.status, 200);
  const itemAfterRevoke = await pool.query<{ mediaId: string | null }>(`SELECT "media_id" AS "mediaId" FROM "zzsh_supply"."billable_item" WHERE "id" = $1`, [itemId]);
  assert.equal(itemAfterRevoke.rows[0]?.mediaId, null, "revoking media visibility must clear item bindings");
  const catalogAfterRevoke = await (await fetch(`${base}/api/v1/supply/games/${gameId}/catalog`)).json();
  const publicItemAfterRevoke = catalogAfterRevoke.items.find((entry: { id: string }) => entry.id === itemId);
  assert.equal(publicItemAfterRevoke?.mediaId, null, "revoked item media must not be projected");
  const unbindNull = await bindItemMedia(operator.jar, itemId, null);
  assert.equal(unbindNull.status, 200, "explicit null must clear the binding");

  // ---------- 存储写失败：部分成功、超时与重试 ----------
  const partialBytes = await distinctBytes();
  const partialIntent = await createIntent(partialBytes.length);
  faults.writeOutcomes.push("ok", "fail");
  const partialUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${partialIntent.body?.intentId}`, operator.jar, partialIntent.body?.uploadToken as string, partialBytes, key("upload"));
  assert.equal(partialUpload.status, 500, "a failed public derivative write must fail the request");
  let partialState = await pool.query<{ consumed: string | null }>(`SELECT "consumed_at" AS consumed FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`, [partialIntent.body?.intentId]);
  assert.equal(partialState.rows[0]?.consumed, null, "a failed upload must leave the intent consumable");
  const partialAssets = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_supply"."media_asset" WHERE "content_hash" = $1`, [
    createHash("sha256").update(partialBytes).digest("hex"),
  ]);
  assert.equal(partialAssets.rows[0]?.count, "0", "a failed upload must not persist an asset");

  const retryKey = key("retry");
  const retryUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${partialIntent.body?.intentId}`, operator.jar, partialIntent.body?.uploadToken as string, partialBytes, retryKey);
  assert.equal(retryUpload.status, 200, JSON.stringify(retryUpload.body));
  partialState = await pool.query<{ consumed: string | null }>(`SELECT "consumed_at" AS consumed FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`, [partialIntent.body?.intentId]);
  assert.ok(partialState.rows[0]?.consumed, "the retried upload must consume the intent");

  const timeoutBytes = await distinctBytes();
  const timeoutIntent = await createIntent(timeoutBytes.length);
  faults.writeOutcomes.push("slow-fail");
  const timeoutUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${timeoutIntent.body?.intentId}`, operator.jar, timeoutIntent.body?.uploadToken as string, timeoutBytes, key("upload"));
  assert.equal(timeoutUpload.status, 500, "an unknown-outcome storage timeout must fail the request");
  const timeoutRetry = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${timeoutIntent.body?.intentId}`, operator.jar, timeoutIntent.body?.uploadToken as string, timeoutBytes, key("upload"));
  assert.equal(timeoutRetry.status, 200, "retry after an unknown-outcome timeout must succeed with the same content-addressed keys");

  // ---------- 数据库回滚后对象保留与可追溯补偿 ----------
  const rollbackBytes = await distinctBytes();
  const rollbackIntent = await createIntent(rollbackBytes.length);
  const rollbackKey = key("rollback");
  await maintenance.query(`CREATE OR REPLACE FUNCTION zzsh_supply.fail_media_probe() RETURNS trigger LANGUAGE plpgsql AS $probe$ BEGIN IF NEW."request_id" = '${ROLLBACK_REQUEST_ID}' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $probe$`);
  await maintenance.query(`DROP TRIGGER IF EXISTS media_audit_rollback_probe ON "zzsh_iam"."audit_event"`);
  await maintenance.query(`CREATE TRIGGER media_audit_rollback_probe BEFORE INSERT ON "zzsh_iam"."audit_event" FOR EACH ROW EXECUTE FUNCTION zzsh_supply.fail_media_probe()`);
  const filesBeforeRollback = await countMediaFiles(mediaDir);
  let rollbackResult: { status: number; body: Record<string, any> | null };
  let orphanLines: string[] = [];
  try {
    const captured = await withOrphanLog(() => uploadBytes(base, `/api/bff/admin/supply/media/uploads/${rollbackIntent.body?.intentId}`, operator.jar, rollbackIntent.body?.uploadToken as string, rollbackBytes, rollbackKey, ROLLBACK_REQUEST_ID));
    rollbackResult = captured.result;
    orphanLines = captured.lines;
  } finally {
    await maintenance.query(`DROP TRIGGER IF EXISTS media_audit_rollback_probe ON "zzsh_iam"."audit_event"`);
    await maintenance.query(`DROP FUNCTION IF EXISTS zzsh_supply.fail_media_probe()`);
  }
  assert.equal(rollbackResult!.status, 400, "the injected database failure must roll the upload back");
  assert.equal(orphanLines.length, 1, "the failed commit must record one traceable orphan-candidate entry");
  const orphanEntry = JSON.parse(orphanLines[0]!) as { intentId: string; storageKeys: string[]; phase: string };
  assert.equal(orphanEntry.intentId, rollbackIntent.body?.intentId);
  assert.equal(orphanEntry.phase, "commit");
  assert.equal(orphanEntry.storageKeys.length, 2);
  const rollbackState = await pool.query<{ consumed: string | null }>(`SELECT "consumed_at" AS consumed FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`, [rollbackIntent.body?.intentId]);
  assert.equal(rollbackState.rows[0]?.consumed, null, "the rolled-back upload must leave the intent consumable");
  assert.equal(await countMediaFiles(mediaDir), filesBeforeRollback + 2, "rolled-back objects must be kept, not deleted");
  for (const storageKey of orphanEntry.storageKeys) {
    assert.ok((await readFile(join(mediaDir, storageKey.slice(0, 2), storageKey))).length > 0, "orphan-candidate objects must remain readable for the retry");
  }
  const rollbackRetry = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${rollbackIntent.body?.intentId}`, operator.jar, rollbackIntent.body?.uploadToken as string, rollbackBytes, rollbackKey);
  assert.equal(rollbackRetry.status, 200, JSON.stringify(rollbackRetry.body));
  assert.equal(await countMediaFiles(mediaDir), filesBeforeRollback + 2, "the retry must reuse the existing objects instead of duplicating them");

  // ---------- 重复请求、重放与去重 ----------
  const duplicateBytes = await distinctBytes();
  const duplicateIntent = await createIntent(duplicateBytes.length);
  const duplicateKey = key("duplicate");
  const duplicateUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${duplicateIntent.body?.intentId}`, operator.jar, duplicateIntent.body?.uploadToken as string, duplicateBytes, duplicateKey);
  assert.equal(duplicateUpload.status, 200);
  const duplicateAssetId = duplicateUpload.body?.assetId as string;
  const writesAfterFirst = faults.writeCalls;
  const replayUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${duplicateIntent.body?.intentId}`, operator.jar, duplicateIntent.body?.uploadToken as string, duplicateBytes, duplicateKey);
  assert.equal(replayUpload.status, 200);
  assert.equal(replayUpload.body?.assetId, duplicateAssetId, "an idempotent replay must return the original asset");
  assert.equal(faults.writeCalls, writesAfterFirst, "replays must not touch object storage");
  const conflictUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${duplicateIntent.body?.intentId}`, operator.jar, duplicateIntent.body?.uploadToken as string, duplicateBytes, key("conflict"));
  assert.equal(conflictUpload.status, 409, "a consumed intent must not be reused with a new key");

  const sameContentIntent = await createIntent(duplicateBytes.length);
  const filesBeforeSameContent = await countMediaFiles(mediaDir);
  const sameContentUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${sameContentIntent.body?.intentId}`, operator.jar, sameContentIntent.body?.uploadToken as string, duplicateBytes, key("samecontent"));
  assert.equal(sameContentUpload.status, 200);
  assert.notEqual(sameContentUpload.body?.assetId, duplicateAssetId, "a new intent must create a distinct auditable asset");
  assert.equal(await countMediaFiles(mediaDir), filesBeforeSameContent, "identical content must not duplicate stored objects");

  // ---------- 过期意图在写入对象前拒绝 ----------
  const expiredBytes = await distinctBytes();
  const expiredIntent = await createIntent(expiredBytes.length);
  await pool.query(`UPDATE "zzsh_supply"."media_upload_intent" SET "expires_at" = clock_timestamp() - interval '1 second' WHERE "id" = $1`, [expiredIntent.body?.intentId]);
  const writesBeforeExpired = faults.writeCalls;
  const expiredUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${expiredIntent.body?.intentId}`, operator.jar, expiredIntent.body?.uploadToken as string, expiredBytes, key("upload"));
  assert.equal(expiredUpload.status, 409, "expired intents must be rejected");
  assert.equal(faults.writeCalls, writesBeforeExpired, "expired intents must be rejected before any object write");

  // ---------- R1：对象写入前复核当前上传权限，已撤权请求零写入 ----------
  // Revocations are injected through the maintenance pool: the runtime role
  // intentionally lacks DELETE on zzsh_supply tables.
  const revokedScopeBytes = await distinctBytes();
  const revokedScopeIntent = await createIntent(revokedScopeBytes.length);
  await maintenance.query(`DELETE FROM "zzsh_supply"."admin_supply_scope" WHERE "admin_user_id" = $1 AND "game_id" = $2`, [operator.id, gameId]);
  const writesBeforeRevokedScope = faults.writeCalls;
  const revokedScopeUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${revokedScopeIntent.body?.intentId}`, operator.jar, revokedScopeIntent.body?.uploadToken as string, revokedScopeBytes, key("upload"));
  assert.equal(revokedScopeUpload.status, 404, "a revoked game scope must be rejected before any object write");
  assert.equal(faults.writeCalls, writesBeforeRevokedScope, "a revoked-scope request must perform zero storage writes");
  await maintenance.query(`INSERT INTO "zzsh_supply"."admin_supply_scope" ("admin_user_id", "game_id", "granted_by_admin_id") VALUES ($1, $2, $3)`, [operator.id, gameId, boss.id]);

  const revokedPermissionIntent = await createIntent(revokedScopeBytes.length);
  await maintenance.query(`DELETE FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = $1 AND "permission_code" = 'supply.catalog.manage'`, [operator.id]);
  const writesBeforeRevokedPermission = faults.writeCalls;
  const revokedPermissionUpload = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${revokedPermissionIntent.body?.intentId}`, operator.jar, revokedPermissionIntent.body?.uploadToken as string, revokedScopeBytes, key("upload"));
  assert.equal(revokedPermissionUpload.status, 403, "a revoked upload permission must be rejected before any object write");
  assert.equal(faults.writeCalls, writesBeforeRevokedPermission, "a revoked-permission request must perform zero storage writes");
  await maintenance.query(`INSERT INTO "zzsh_iam"."admin_user_permission" ("admin_user_id", "permission_code", "effect") VALUES ($1, 'supply.catalog.manage', 'ALLOW')`, [operator.id]);

  // ---------- R1：两阶段之间撤权——不落库，候选对象可追溯 ----------
  const midRevocationBytes = await distinctBytes();
  const midRevocationIntent = await createIntent(midRevocationBytes.length);
  faults.afterWrite = async () => {
    faults.afterWrite = undefined;
    await maintenance.query(`DELETE FROM "zzsh_supply"."admin_supply_scope" WHERE "admin_user_id" = $1 AND "game_id" = $2`, [operator.id, gameId]);
  };
  const filesBeforeMidRevocation = await countMediaFiles(mediaDir);
  let midRevocationResult: { status: number; body: Record<string, any> | null };
  let midRevocationOrphans: string[] = [];
  try {
    const captured = await withOrphanLog(() => uploadBytes(base, `/api/bff/admin/supply/media/uploads/${midRevocationIntent.body?.intentId}`, operator.jar, midRevocationIntent.body?.uploadToken as string, midRevocationBytes, key("upload")));
    midRevocationResult = captured.result;
    midRevocationOrphans = captured.lines;
  } finally {
    faults.afterWrite = undefined;
    await maintenance.query(`INSERT INTO "zzsh_supply"."admin_supply_scope" ("admin_user_id", "game_id", "granted_by_admin_id") VALUES ($1, $2, $3)`, [operator.id, gameId, boss.id]);
  }
  assert.equal(midRevocationResult!.status, 404, "a revocation between the two phases must stop the final transaction");
  const midRevocationEntry = JSON.parse(midRevocationOrphans[0] ?? "null") as { intentId: string; storageKeys: string[]; phase: string } | null;
  assert.ok(midRevocationEntry, "the mid-revocation failure must record orphan candidates");
  assert.equal(midRevocationEntry!.intentId, midRevocationIntent.body?.intentId);
  assert.equal(midRevocationEntry!.phase, "commit");
  assert.equal(midRevocationEntry!.storageKeys.length, 2);
  const midRevocationState = await pool.query<{ consumed: string | null }>(`SELECT "consumed_at" AS consumed FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`, [midRevocationIntent.body?.intentId]);
  assert.equal(midRevocationState.rows[0]?.consumed, null, "the mid-revocation upload must not be persisted");
  assert.equal(await countMediaFiles(mediaDir), filesBeforeMidRevocation + 2, "mid-revocation objects must be kept for the retry");
  const midRevocationRetry = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${midRevocationIntent.body?.intentId}`, operator.jar, midRevocationIntent.body?.uploadToken as string, midRevocationBytes, key("retry"));
  assert.equal(midRevocationRetry.status, 200, JSON.stringify(midRevocationRetry.body));
  assert.equal(await countMediaFiles(mediaDir), filesBeforeMidRevocation + 2, "the retry after scope restore must reuse the existing objects");

  // ---------- R2：对象已落盘但传输超时——候选键不丢失，重试复用 ----------
  const originalTimeoutBytes = await distinctBytes();
  const originalTimeoutIntent = await createIntent(originalTimeoutBytes.length);
  faults.writeOutcomes.push("land-then-timeout");
  const filesBeforeOriginalTimeout = await countMediaFiles(mediaDir);
  let originalTimeoutResult: { status: number; body: Record<string, any> | null };
  let originalTimeoutOrphans: string[] = [];
  {
    const captured = await withOrphanLog(() => uploadBytes(base, `/api/bff/admin/supply/media/uploads/${originalTimeoutIntent.body?.intentId}`, operator.jar, originalTimeoutIntent.body?.uploadToken as string, originalTimeoutBytes, key("upload")));
    originalTimeoutResult = captured.result;
    originalTimeoutOrphans = captured.lines;
  }
  assert.equal(originalTimeoutResult!.status, 500, "an unknown-outcome original write must fail the request");
  assert.equal(await countMediaFiles(mediaDir), filesBeforeOriginalTimeout + 1, "the landed original object must be kept");
  const originalTimeoutEntry = JSON.parse(originalTimeoutOrphans[0] ?? "null") as { storageKeys: string[]; phase: string } | null;
  assert.ok(originalTimeoutEntry, "the unknown-outcome write must record an orphan candidate");
  assert.equal(originalTimeoutEntry!.phase, "write");
  assert.deepEqual(originalTimeoutEntry!.storageKeys, [createHash("sha256").update(originalTimeoutBytes).digest("hex")], "the attempted original key must be traceable even though the write result is unknown");
  const originalTimeoutState = await pool.query<{ consumed: string | null }>(`SELECT "consumed_at" AS consumed FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`, [originalTimeoutIntent.body?.intentId]);
  assert.equal(originalTimeoutState.rows[0]?.consumed, null, "the failed upload must leave the intent consumable");
  const originalTimeoutRetry = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${originalTimeoutIntent.body?.intentId}`, operator.jar, originalTimeoutIntent.body?.uploadToken as string, originalTimeoutBytes, key("retry"));
  assert.equal(originalTimeoutRetry.status, 200, JSON.stringify(originalTimeoutRetry.body));
  assert.equal(await countMediaFiles(mediaDir), filesBeforeOriginalTimeout + 2, "the retry must reuse the landed original object and only add the derivative");

  const derivativeTimeoutBytes = await distinctBytes();
  const derivativeTimeoutIntent = await createIntent(derivativeTimeoutBytes.length);
  faults.writeOutcomes.push("ok", "land-then-timeout");
  const filesBeforeDerivativeTimeout = await countMediaFiles(mediaDir);
  let derivativeTimeoutOrphans: string[] = [];
  {
    const captured = await withOrphanLog(() => uploadBytes(base, `/api/bff/admin/supply/media/uploads/${derivativeTimeoutIntent.body?.intentId}`, operator.jar, derivativeTimeoutIntent.body?.uploadToken as string, derivativeTimeoutBytes, key("upload"), "req_media_derivative_timeout_probe"));
    assert.equal(captured.result.status, 500, "an unknown-outcome derivative write must fail the request");
    derivativeTimeoutOrphans = captured.lines;
  }
  assert.equal(await countMediaFiles(mediaDir), filesBeforeDerivativeTimeout + 2, "both landed objects must be kept");
  const derivativeTimeoutEntry = JSON.parse(derivativeTimeoutOrphans[0] ?? "null") as { storageKeys: string[]; phase: string } | null;
  assert.ok(derivativeTimeoutEntry, "the unknown-outcome derivative write must record orphan candidates");
  assert.equal(derivativeTimeoutEntry!.phase, "write");
  assert.equal(derivativeTimeoutEntry!.storageKeys.length, 2, "both the original and the attempted derivative key must be traceable");
  const derivativeTimeoutState = await pool.query<{ consumed: string | null }>(`SELECT "consumed_at" AS consumed FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`, [derivativeTimeoutIntent.body?.intentId]);
  assert.equal(derivativeTimeoutState.rows[0]?.consumed, null, "the failed upload must leave the intent consumable");
  const derivativeTimeoutRetry = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${derivativeTimeoutIntent.body?.intentId}`, operator.jar, derivativeTimeoutIntent.body?.uploadToken as string, derivativeTimeoutBytes, key("retry"));
  assert.equal(derivativeTimeoutRetry.status, 200, JSON.stringify(derivativeTimeoutRetry.body));
  assert.equal(await countMediaFiles(mediaDir), filesBeforeDerivativeTimeout + 2, "the retry must reuse both existing objects without duplication");

  // ---------- R2：同 intent/token/key 并发不同等长内容——失败请求候选不漏记 ----------
  // Two different but equal-length valid PNGs race with the same intent, token
  // and idempotency key. A storage-write barrier (no fixed sleeps) guarantees
  // both requests finish ALL object writes before either final transaction
  // runs, so the 409 loser's objects are guaranteed written and unreferenced.
  const concurrentA = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 40, b: 40 } } }).withExif({ IFD0: { Artist: "a".repeat(24) } }).png().toBuffer();
  const concurrentB = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 40, g: 40, b: 200 } } }).withExif({ IFD0: { Artist: "b".repeat(24) } }).png().toBuffer();
  assert.equal(concurrentA.length, concurrentB.length, "the two racing images must be equal-length to share one declared size");
  const hashOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const keysA = [hashOf(concurrentA), hashOf((await decodeImage(concurrentA)).publicBytes)];
  const keysB = [hashOf(concurrentB), hashOf((await decodeImage(concurrentB)).publicBytes)];
  assert.notDeepEqual(keysA, keysB);

  const concurrentIntent = await createIntent(concurrentA.length);
  const concurrentToken = concurrentIntent.body?.uploadToken as string;
  const concurrentPath = `/api/bff/admin/supply/media/uploads/${concurrentIntent.body?.intentId}`;
  const concurrentKey = key("concurrent");
  assert.equal(faults.writeOutcomes.length, 0, "the concurrent scenario needs an empty fault queue");
  faults.afterWrite = undefined;

  // Barrier: writes 1–2 (each request's first write) gate until both requests
  // have landed a write — proving both passed the permission pre-check and are
  // inside prepare. Writes 3–4 gate until all four objects have landed. Only
  // then do the two final transactions race. A watchdog rejects the gates so a
  // broken barrier fails the test instead of hanging it.
  const writesBeforeConcurrent = faults.writeCalls;
  const makeGate = (): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } => {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const firstWritesGate = makeGate();
  const allWritesGate = makeGate();
  const barrierWatchdog = setTimeout(() => {
    firstWritesGate.reject(new Error("concurrent upload barrier timed out"));
    allWritesGate.reject(new Error("concurrent upload barrier timed out"));
  }, 20_000);
  faults.afterWrite = async (call) => {
    const relative = call - writesBeforeConcurrent;
    const gate = relative <= 2 ? firstWritesGate : allWritesGate;
    const target = relative <= 2 ? 2 : 4;
    if (faults.writeCalls - writesBeforeConcurrent >= target) gate.resolve();
    await gate.promise;
  };
  const filesBeforeConcurrent = await countMediaFiles(mediaDir);
  let concurrentResults: Array<{ status: number; body: Record<string, any> | null }>;
  let concurrentOrphans: string[] = [];
  try {
    const captured = await withOrphanLog(() => Promise.all([
      uploadBytes(base, concurrentPath, operator.jar, concurrentToken, concurrentA, concurrentKey, "req_media_concurrent_a"),
      uploadBytes(base, concurrentPath, operator.jar, concurrentToken, concurrentB, concurrentKey, "req_media_concurrent_b"),
    ]));
    concurrentResults = captured.result;
    concurrentOrphans = captured.lines;
  } finally {
    clearTimeout(barrierWatchdog);
    faults.afterWrite = undefined;
  }
  const statuses = concurrentResults.map((result) => result.status).sort((left, right) => left - right);
  assert.deepEqual(statuses, [200, 409], JSON.stringify(concurrentResults.map((result) => result.body)));
  const winner = concurrentResults.find((result) => result.status === 200)!;
  const loser = concurrentResults.find((result) => result.status === 409)!;
  assert.equal(loser.body?.error?.code, "IDEMPOTENCY_KEY_REUSED");
  const winnerIsA = winner.body?.contentHash === keysA[0];
  const winnerKeys = winnerIsA ? keysA : keysB;
  const loserKeys = winnerIsA ? keysB : keysA;

  // No duplicated business rows: one consumed intent, one asset (the winner's),
  // one success audit, one idempotency record.
  const consumedRow = await pool.query<{ consumedAssetId: string | null }>(`SELECT "consumed_asset_id" AS "consumedAssetId" FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`, [concurrentIntent.body?.intentId]);
  assert.equal(consumedRow.rows[0]?.consumedAssetId, winner.body?.assetId);
  const assetCounts = await pool.query<{ hash: string; count: string }>(`SELECT "content_hash" AS "hash", count(*)::text AS "count" FROM "zzsh_supply"."media_asset" WHERE "content_hash" = ANY($1) GROUP BY "content_hash"`, [[winnerKeys[0], loserKeys[0]]]);
  assert.equal(assetCounts.rows.find((row) => row.hash === winnerKeys[0])?.count ?? "0", "1", "the winning content must be persisted exactly once");
  assert.equal(assetCounts.rows.find((row) => row.hash === loserKeys[0])?.count ?? "0", "0", "the losing content must not be persisted");
  const uploadAudits = await pool.query<{ count: string }>(`SELECT count(*)::text AS "count" FROM "zzsh_iam"."audit_event" WHERE "action" = 'supply.media.uploaded' AND "object_id" = $1`, [winner.body?.assetId]);
  assert.equal(uploadAudits.rows[0]?.count, "1", "the winning upload must be audited exactly once");
  const recordCount = await pool.query<{ count: string }>(`SELECT count(*)::text AS "count" FROM "zzsh_supply"."idempotency_record" WHERE "scope_key" = $1 AND "key" = $2`, [JSON.stringify(["admin", operator.id, "supply.media.upload", concurrentIntent.body?.intentId]), concurrentKey["idempotency-key"]]);
  assert.equal(recordCount.rows[0]?.count, "1", "exactly one idempotency record must exist for the shared key");

  // The losing request's pending candidates must be fully traceable.
  assert.equal(concurrentOrphans.length, 1, "the losing request must record its pending candidate keys");
  const concurrentEntry = JSON.parse(concurrentOrphans[0]!) as { intentId: string; storageKeys: string[]; phase: string };
  assert.equal(concurrentEntry.intentId, concurrentIntent.body?.intentId);
  assert.equal(concurrentEntry.phase, "commit");
  assert.deepEqual([...concurrentEntry.storageKeys].sort(), [...loserKeys].sort(), "the failed request must record its own original and derivative keys");

  // Nothing is auto-deleted: all four objects remain, and the winning asset
  // stays readable through the review path with its original bytes.
  assert.equal(await countMediaFiles(mediaDir), filesBeforeConcurrent + 4, "all four written objects must be kept");
  for (const storageKey of [...keysA, ...keysB]) {
    assert.ok((await readFile(join(mediaDir, storageKey.slice(0, 2), storageKey))).length > 0, "written objects must remain readable");
  }
  const winnerContent = await fetch(`${base}/api/bff/admin/supply/media/${winner.body?.assetId}/content`, { headers: { origin: ADMIN_ORIGIN, cookie: operator.jar.header() } });
  assert.equal(winnerContent.status, 200, "the winning asset must remain readable via the review path");
  assert.deepEqual(Buffer.from(await winnerContent.arrayBuffer()), winnerIsA ? concurrentA : concurrentB);
}
