import type { BeforeApplicationShutdown } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { SecurityApiError } from "../auth/security-core";
import type { LegacyPublicAdmission, LegacyPublicAdmissionDetailIndex } from "../legacy-load/legacy-public-admission";
import type { AccountImageCdn, AccountImageDelivery } from "./account-image-cdn";
import type { AccountMediaVariant } from "./account-media-oss";
import { readAccountWatermarkPolicy, resolveAccountImageWatermark } from "./account-image-watermark";
import { inspectImage, loadMediaAsset, logOrphanedMediaObjects, MediaStorageError, recordAccountMediaVariants, type MediaStorage } from "./media";
import { readPublicListingSnapshot, readPublishingAccount, type SupplyGateReader } from "./publishing";
import { newSupplyId } from "./supply-util";
import { synchronizeLegacyImages } from "./legacy-image-cdn-worker";

type QueueItem = { accountId: string; revision: string; nativeCandidate?: boolean; legacyCandidate?: boolean };
type DeliveryRow = AccountImageDelivery & { state: "READY" | "PUBLISHING" | "REVOKING"; removable: boolean };
type CdnWorkerOptions = { pool: Pool; storage: MediaStorage; cdn: AccountImageCdn; gate: SupplyGateReader;
  legacyPublicAdmission?: LegacyPublicAdmission; legacyPublicAdmissionDetail?: LegacyPublicAdmissionDetailIndex };

async function readDesired(client: PoolClient, accountId: string, gate: SupplyGateReader): Promise<string[]> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const account = await readPublishingAccount(client, accountId);
    const listing = await readPublicListingSnapshot(client, account, gate, undefined, false, "DETAIL");
    const media = Array.isArray(listing.media) ? listing.media : [];
    await client.query("COMMIT");
    return media.map((image: { assetId: string }) => image.assetId);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof SecurityApiError && error.status === 404) return [];
    throw error;
  }
}

async function variantsFor(client: PoolClient, assetId: string, storage: MediaStorage): Promise<AccountMediaVariant[]> {
  const stored = (await client.query<AccountMediaVariant>(
    `SELECT max_edge AS "maxEdge", object_key AS "objectKey", sha256, byte_size AS "byteSize", width, height,
        watermark_revision::text AS "watermarkRevision"
       FROM zzsh_supply.account_image_variant WHERE asset_id=$1 ORDER BY max_edge`, [assetId],
  )).rows;
  if (stored.length === 2) return stored;
  if (stored.length || !storage.accountMedia) throw new MediaStorageError("account image variants are incomplete");
  const asset = await loadMediaAsset(client, assetId);
  if (!asset?.publicStorageKey) throw new MediaStorageError("account image source is unavailable");
  const bytes = await storage.read(asset.publicStorageKey);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.publicStorageKey) throw new MediaStorageError("account image source SHA-256 is invalid");
  const dimensions = await inspectImage(bytes);
  const watermark = await resolveAccountImageWatermark(client, await readAccountWatermarkPolicy(client));
  const attempted: string[] = [];
  try {
    const variants = await storage.accountMedia.generateVariants(asset.publicStorageKey, dimensions, watermark, key => attempted.push(key));
    await recordAccountMediaVariants(client, assetId, variants);
    return variants;
  } catch (error) {
    logOrphanedMediaObjects({ intentId: assetId, storageKeys: attempted, phase: "write" });
    throw error;
  }
}

async function synchronizeAccount(client: PoolClient, item: QueueItem, options: CdnWorkerOptions, stopping: () => boolean, readEligible: typeof readDesired): Promise<boolean> {
  const { cdn, gate, storage } = options;
  const desired = cdn.mode === "drain" || item.nativeCandidate === false ? [] : await readEligible(client, item.accountId, gate);
  await client.query(
    `UPDATE zzsh_supply.account_image_cdn_delivery SET state='REVOKING'
      WHERE account_id=$1 AND (state='PUBLISHING' OR (state='READY' AND NOT asset_id=ANY($2::text[])))`, [item.accountId, desired],
  );
  const active = (await client.query<DeliveryRow>(
    `SELECT id, account_id AS "accountId", asset_id AS "assetId", state,
        (published_at IS NOT NULL OR created_at <= clock_timestamp()-interval '2 minutes') AS removable
       FROM zzsh_supply.account_image_cdn_delivery WHERE account_id=$1 AND state<>'REVOKED'`, [item.accountId],
  )).rows;
  const existing = new Map(active.map(row => [row.assetId, row]));
  for (const delivery of active) {
    if (stopping()) return false;
    if (delivery.state !== "REVOKING" || !delivery.removable) continue;
    const taskId = await cdn.revoke(delivery);
    await client.query(`UPDATE zzsh_supply.account_image_cdn_delivery SET state='REVOKED', purge_task_id=$2 WHERE id=$1 AND state='REVOKING'`, [delivery.id, taskId]);
    existing.delete(delivery.assetId);
  }
  let copied = 0;
  for (const assetId of desired) {
    if (stopping() || copied >= 4) return false;
    if (existing.has(assetId)) continue;
    const variants = await variantsFor(client, assetId, storage);
    if (variants.length !== 2 || !(await readEligible(client, item.accountId, gate)).includes(assetId)) return false;
    const id = newSupplyId("cdn");
    const reserved = await client.query(
      `INSERT INTO zzsh_supply.account_image_cdn_delivery(id, account_id, asset_id)
       SELECT $1, account_id, $3 FROM zzsh_supply.account_image_cdn_queue WHERE account_id=$2 AND request_revision=$4 FOR SHARE`,
      [id, item.accountId, assetId, item.revision],
    );
    if (!reserved.rowCount || stopping()) return false;
    const results = await Promise.allSettled(variants.map(variant => cdn.publish({ id, accountId: item.accountId, assetId }, variant)));
    const ready = results.every(result => result.status === "fulfilled")
      && !stopping() && (await readEligible(client, item.accountId, gate)).includes(assetId);
    const completed = ready && (await client.query(
      `WITH q AS MATERIALIZED (SELECT account_id FROM zzsh_supply.account_image_cdn_queue WHERE account_id=$3 AND request_revision=$2 FOR SHARE)
       UPDATE zzsh_supply.account_image_cdn_delivery d SET state='READY', published_at=clock_timestamp()
       FROM q WHERE d.id=$1 AND d.state='PUBLISHING' AND q.account_id=d.account_id`,
      [id, item.revision, item.accountId],
    )).rowCount;
    if (!completed) {
      await client.query(`UPDATE zzsh_supply.account_image_cdn_delivery SET state='REVOKING' WHERE id=$1 AND state='PUBLISHING'`, [id]);
      return false;
    }
    copied++;
  }
  return ![...existing.values()].some(delivery => delivery.state === "REVOKING");
}

export async function runAccountImageCdnBatch(options: CdnWorkerOptions, stopping: () => boolean, readEligible = readDesired): Promise<void> {
  const client = await options.pool.connect();
  const lock = "zzsh-account-image-cdn";
  let acquired = false, broken = false;
  const lost = () => { broken = true; };
  client.on("error", lost);
  try {
    acquired = (await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired`, [lock])).rows[0]?.acquired === true;
    if (!acquired || stopping()) return;
    const items = (await client.query<QueueItem>(
      `SELECT q.account_id AS "accountId", q.request_revision::text AS revision, q.legacy_candidate AS "legacyCandidate",
          EXISTS (SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=q.account_id) AS "nativeCandidate"
         FROM zzsh_supply.account_image_cdn_queue q
         CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM zzsh_supply.account_image_cdn_delivery d WHERE d.account_id=q.account_id AND d.state<>'REVOKED') AS native_active,
           EXISTS (SELECT 1 FROM zzsh_supply.legacy_image_cdn_delivery d WHERE d.account_id=q.account_id AND d.state IN ('PUBLISHING','READY','REVOKING')) AS legacy_active) active
        WHERE CASE WHEN $1 THEN active.native_active OR active.legacy_active
          ELSE q.due_at <= clock_timestamp() AND ($2 OR NOT q.legacy_candidate OR active.native_active OR active.legacy_active OR EXISTS (SELECT 1 FROM zzsh_supply.listing_publication p WHERE p.account_id=q.account_id)) END
        ORDER BY (EXISTS (SELECT 1 FROM zzsh_supply.account_image_cdn_delivery d WHERE d.account_id=q.account_id AND d.state='REVOKING')
          OR EXISTS (SELECT 1 FROM zzsh_supply.legacy_image_cdn_delivery d WHERE d.account_id=q.account_id AND d.state='REVOKING')) DESC,
          (q.request_revision > 1) DESC, q.due_at, q.account_id LIMIT 8`, [options.cdn.mode === "drain", Boolean(options.cdn.legacy?.enabled)],
    )).rows;
    for (const item of items) {
      if (broken || stopping()) return;
      let complete = false;
      try {
        const isStopping = () => broken || stopping();
        const legacy = options.cdn.legacy && item.legacyCandidate
          ? await synchronizeLegacyImages(client, item, options.cdn.legacy, options, isStopping) : true;
        const native = await synchronizeAccount(client, item, options, isStopping, readEligible);
        complete = legacy && native;
      }
      catch { console.error(JSON.stringify({ event: "zzsh_account_image_cdn_sync_failed", accountId: item.accountId })); }
      if (broken) return;
      await client.query(`UPDATE zzsh_supply.account_image_cdn_queue SET due_at=clock_timestamp() + $3::integer * interval '1 second'
        WHERE account_id=$1 AND request_revision=$2`, [item.accountId, item.revision, complete ? 300 : 10]);
    }
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    if (acquired && !broken) {
      try { broken = (await client.query(`SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked`, [lock])).rows[0]?.unlocked !== true; }
      catch { broken = true; }
    }
    client.removeListener("error", lost);
    client.release(broken);
  }
}

export class AccountImageCdnLifecycle implements BeforeApplicationShutdown {
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  start(options: CdnWorkerOptions): void {
    const tick = () => {
      if (this.stopping || this.inFlight) return;
      this.inFlight = runAccountImageCdnBatch(options, () => this.stopping)
        .catch(() => console.error(JSON.stringify({ event: "zzsh_account_image_cdn_worker_failed" })))
        .finally(() => { this.inFlight = undefined; });
    };
    this.timer = setInterval(tick, 5000);
    this.timer.unref();
    tick();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.inFlight;
  }
}
