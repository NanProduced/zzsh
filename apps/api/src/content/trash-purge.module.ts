// Recycle-bin 30-day automatic cleanup worker (internal docs + help center).
// Skeleton mirrors finance/distribution-due.module.ts: an unref'd setInterval that
// always runs, a session-level pg_try_advisory_lock as the only execution right,
// pg_locks re-validation of the live session, and a shutdown hook that awaits the
// in-flight batch before the business pool ends.
//
// ADVISORY LOCK 806009 — provisional, PENDING Master registration (待 Master 报备).
// Master owns the final lock-number / migration / journal allocation.
//
// Retention is fixed at 30 days (not configurable). Every step re-checks "still
// satisfies the condition" so a repeated batch is a zero-write no-op, a restored
// batch is never purged, and an expired worker cannot write back into a newer
// lease. OSS objects are physically deleted only after a cross-version reference
// check: an image still referenced by any other document's current or historical
// version is kept (row + object) and remains signable.
import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { recordAudit } from "../auth/security-core";
import { businessFeatureEnabled, ConfigurationError } from "../config/config";
import type { DocsImageStorage } from "../docs/docs-images";

export const TRASH_PURGE_LOCK_KEY = "806009";
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SYSTEM_ACTOR_ID = "content-trash-purge";

export type TrashPurgeResult = {
  docBatches: number; helpBatches: number; docNodes: number; helpNodes: number;
  imagesDeleted: number; imagesKept: number; pendingImages: number; skipped: number;
};

export type TrashPurgeRunInput = {
  client: PoolClient; batchLimit: number; now: Date; requestId: string;
  storage?: DocsImageStorage; isCancelled: () => boolean;
};

export type TrashPurgeStore = { runOnce(input: TrashPurgeRunInput): Promise<TrashPurgeResult> };

export type TrashPurgeModuleOptions = {
  pool: Pool; intervalMs: number; batchLimit: number; workerId: string;
  storage?: DocsImageStorage; store?: TrashPurgeStore;
};

export function loadTrashPurgeRuntime(
  pool: Pool | undefined, storage: DocsImageStorage | undefined, env: NodeJS.ProcessEnv = process.env,
): TrashPurgeModuleOptions | undefined {
  if (!businessFeatureEnabled(env, "CONTENT_TRASH_PURGE_ENABLED")) return undefined;
  if (!pool) throw new ConfigurationError("CONTENT_TRASH_PURGE_ENABLED=true requires a business database pool");
  const intervalMs = Number(env.CONTENT_TRASH_PURGE_INTERVAL_MS ?? "3600000");
  const batchLimit = Number(env.CONTENT_TRASH_PURGE_BATCH_LIMIT ?? "20");
  const workerId = env.CONTENT_TRASH_PURGE_WORKER_ID?.trim() ?? "main";
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000 || intervalMs > 3600000) throw new ConfigurationError("CONTENT_TRASH_PURGE_INTERVAL_MS must be 60000-3600000");
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) throw new ConfigurationError("CONTENT_TRASH_PURGE_BATCH_LIMIT must be 1-100");
  if (!ID.test(workerId)) throw new ConfigurationError("CONTENT_TRASH_PURGE_WORKER_ID must be a bounded identifier");
  return { pool, intervalMs, batchLimit, workerId, ...(storage ? { storage } : {}), store: createTrashPurgeStore() };
}

/** Pure due decision: a soft-deleted row at or before the cutoff is purgeable.
 *  A restored row (deletedAt null) is never due. Exported for injected-clock tests. */
export function isPurgeDue(deletedAt: Date | null | undefined, cutoff: Date): boolean {
  return deletedAt != null && deletedAt.getTime() <= cutoff.getTime();
}

function emptyResult(): TrashPurgeResult {
  return { docBatches: 0, helpBatches: 0, docNodes: 0, helpNodes: 0, imagesDeleted: 0, imagesKept: 0, pendingImages: 0, skipped: 0 };
}

function log(event: string, fields: Record<string, unknown>): void {
  try { console.log(JSON.stringify({ event: `content.trash.purge.${event}`, ...fields })); } catch { /* logging must never block cleanup */ }
}

// --- due batch selection ----------------------------------------------------
// One root row per delete_batch (the topmost deleted node), mirroring the trash
// listing so a batch is selected exactly once per pass.
export async function selectDueDocBatches(client: PoolClient, cutoff: Date, limit: number): Promise<string[]> {
  const rows = (await client.query<{ batchId: string }>(
    `SELECT root."delete_batch_id" AS "batchId"
       FROM "zzsh_docs"."doc_node" root
      WHERE root."deleted_at" IS NOT NULL AND root."deleted_at" <= $1 AND root."delete_batch_id" IS NOT NULL
        AND (root."parent_id" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "zzsh_docs"."doc_node" p WHERE p."id" = root."parent_id" AND p."delete_batch_id" = root."delete_batch_id"))
      ORDER BY root."delete_batch_id" LIMIT $2`, [cutoff, limit],
  )).rows;
  return rows.map(row => row.batchId);
}

export async function selectDueHelpBatches(client: PoolClient, cutoff: Date, limit: number): Promise<string[]> {
  const rows = (await client.query<{ batchId: string }>(
    `SELECT root."delete_batch_id" AS "batchId"
       FROM "zzsh_content"."help_tree_node" root
      WHERE root."deleted_at" IS NOT NULL AND root."deleted_at" <= $1 AND root."delete_batch_id" IS NOT NULL
        AND (root."parent_id" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "zzsh_content"."help_tree_node" p WHERE p."id" = root."parent_id" AND p."delete_batch_id" = root."delete_batch_id"))
      ORDER BY root."delete_batch_id" LIMIT $2`, [cutoff, limit],
  )).rows;
  return rows.map(row => row.batchId);
}

type BatchNode = { id: string; depth: number };

function descendingDepths(nodes: BatchNode[]): number[] {
  return [...new Set(nodes.map(node => node.depth))].sort((a, b) => b - a);
}

export type DocBatchOutcome = {
  purged: boolean; nodes: number; versions: number; imagesDeleted: number; imagesKept: number; pendingOss: number;
};

/**
 * Purge one internal-doc delete_batch. The NOT NULL doc_image.uploaded_in_node_id
 * foreign key means a node cannot be removed while an image row still points at
 * it, and OSS objects must only be deleted after the reference rows are committed.
 * So a batch runs as: prepare-tx (drop comments/discussions/versions, re-point
 * shared images, mark orphans PURGING) -> post-commit OSS delete + image-row
 * delete -> finalize-tx (remove the now image-free nodes, audit once). On OSS
 * success the batch clears in a single call; a failed object stays PURGING and
 * its node waits for the next pass. An image still referenced by a surviving
 * version is adopted by that referencing node (uploaded_in_node_id re-pointed)
 * so the object and row stay intact and signable. DOC_PURGED is audited exactly
 * once, when the batch is fully cleared.
 */
export async function purgeDocsBatch(
  client: PoolClient, batchId: string, cutoff: Date, storage: DocsImageStorage | undefined, requestId: string,
): Promise<DocBatchOutcome> {
  const outcome: DocBatchOutcome = { purged: false, nodes: 0, versions: 0, imagesDeleted: 0, imagesKept: 0, pendingOss: 0 };
  const pendingOss: { id: string; objectKey: string }[] = [];
  let nodeCount = 0;
  // --- prepare transaction ---
  await client.query("BEGIN");
  try {
    // Re-validate under row locks: a restored or already-purged batch is a no-op.
    const nodes = (await client.query<BatchNode>(
      `SELECT "id", "depth" FROM "zzsh_docs"."doc_node"
        WHERE "delete_batch_id" = $1 AND "deleted_at" IS NOT NULL AND "deleted_at" <= $2
        ORDER BY "depth" DESC, "id" FOR UPDATE`, [batchId, cutoff],
    )).rows;
    if (nodes.length === 0) { await client.query("COMMIT"); return outcome; }
    nodeCount = nodes.length;
    const nodeIds = nodes.map(node => node.id);
    const versionIds = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_docs"."doc_version" WHERE "node_id" = ANY($1::text[])`, [nodeIds],
    )).rows.map(row => row.id);
    const images = (await client.query<{ id: string; objectKey: string }>(
      `SELECT "id", "object_key" AS "objectKey" FROM "zzsh_docs"."doc_image" WHERE "uploaded_in_node_id" = ANY($1::text[])`, [nodeIds],
    )).rows;

    if (!storage && images.length > 0) {
      await client.query("COMMIT");
      log("skip", { phase: "oss-disabled", batchId, reason: "Document image storage is unavailable; batch retained for retry" });
      return outcome;
    }

    await client.query(`DELETE FROM "zzsh_docs"."doc_comment" WHERE "discussion_id" IN (SELECT "id" FROM "zzsh_docs"."doc_discussion" WHERE "node_id" = ANY($1::text[]))`, [nodeIds]);
    await client.query(`DELETE FROM "zzsh_docs"."doc_discussion" WHERE "node_id" = ANY($1::text[])`, [nodeIds]);
    await client.query(`UPDATE "zzsh_docs"."doc_node" SET "current_version_id" = NULL WHERE "id" = ANY($1::text[])`, [nodeIds]);
    if (versionIds.length > 0) {
      await client.query(`DELETE FROM "zzsh_docs"."doc_version_image" WHERE "version_id" = ANY($1::text[])`, [versionIds]);
      await client.query(`DELETE FROM "zzsh_docs"."doc_version" WHERE "node_id" = ANY($1::text[])`, [nodeIds]);
    }

    // Cross-version reference check: after the batch's own references are gone,
    // any surviving doc_version_image row means another document still uses it.
    for (const image of images) {
      const reference = (await client.query<{ nodeId: string }>(
        `SELECT v."node_id" AS "nodeId" FROM "zzsh_docs"."doc_version_image" vi
           JOIN "zzsh_docs"."doc_version" v ON v."id" = vi."version_id"
          WHERE vi."image_id" = $1 ORDER BY v."node_id" LIMIT 1`, [image.id],
      )).rows[0];
      if (reference) {
        // Keep the object and row; adopt it into a surviving referencing node so
        // the purged node's uploaded_in_node_id foreign key no longer blocks.
        await client.query(`UPDATE "zzsh_docs"."doc_image" SET "uploaded_in_node_id" = $2 WHERE "id" = $1`, [image.id, reference.nodeId]);
        outcome.imagesKept += 1;
      } else {
        await client.query(`UPDATE "zzsh_docs"."doc_image" SET "status" = 'PURGING' WHERE "id" = $1`, [image.id]);
        pendingOss.push({ id: image.id, objectKey: image.objectKey });
      }
    }
    outcome.versions = versionIds.length;
    outcome.pendingOss = pendingOss.length;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  // --- post-commit physical OSS cleanup ---
  // A failure leaves the row PURGING for the next pass; the key is only forgotten
  // once the delete succeeds, so no object is orphaned.
  for (const image of pendingOss) {
    try {
      if (!storage) continue;
      await storage.deleteObject(image.objectKey);
      await client.query(`DELETE FROM "zzsh_docs"."doc_image" WHERE "id" = $1 AND "status" = 'PURGING'`, [image.id]);
      outcome.imagesDeleted += 1;
    } catch (error) {
      log("error", { phase: "oss", batchId, imageId: image.id, reason: error instanceof Error ? error.message : String(error), recovery: "RETRY_PURGING" });
    }
  }

  // --- finalize transaction: remove the now image-free nodes, audit once ---
  await client.query("BEGIN");
  try {
    const nodes = (await client.query<BatchNode>(
      `SELECT "id", "depth" FROM "zzsh_docs"."doc_node"
        WHERE "delete_batch_id" = $1 AND "deleted_at" IS NOT NULL AND "deleted_at" <= $2
        ORDER BY "depth" DESC, "id" FOR UPDATE`, [batchId, cutoff],
    )).rows;
    let removed = 0;
    for (const depth of descendingDepths(nodes)) {
      const deleted = await client.query(
        `DELETE FROM "zzsh_docs"."doc_node" n
          WHERE n."delete_batch_id" = $1 AND n."depth" = $2
            AND NOT EXISTS (SELECT 1 FROM "zzsh_docs"."doc_image" i WHERE i."uploaded_in_node_id" = n."id")
            AND NOT EXISTS (SELECT 1 FROM "zzsh_docs"."doc_node" c WHERE c."parent_id" = n."id")`, [batchId, depth],
      );
      removed += deleted.rowCount ?? 0;
    }
    const remaining = (await client.query<{ count: number }>(
      `SELECT count(*)::int AS "count" FROM "zzsh_docs"."doc_node" WHERE "delete_batch_id" = $1`, [batchId],
    )).rows[0]?.count ?? 0;
    if (remaining === 0 && nodeCount > 0) {
      await recordAudit(client, {
        actorType: "system", actorId: SYSTEM_ACTOR_ID, sessionId: "system", action: "DOC_PURGED",
        objectType: "doc_delete_batch", objectId: batchId, outcome: "SUCCESS", requestId, reason: "content.trash.purge",
        details: { batchId, nodeCount, versionCount: outcome.versions, imagesPurged: outcome.imagesDeleted, imagesKept: outcome.imagesKept },
      });
      outcome.purged = true;
    }
    outcome.nodes = removed;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
  return outcome;
}

export type HelpBatchOutcome = { purged: boolean; nodes: number; articles: number; blocked: boolean };

/**
 * Purge one help delete_batch: physically remove the tree nodes and the article
 * content_item / content_version snapshots, and stamp the slug tombstones with
 * purged_at. Tombstone rows are never deleted and deleted_at stays set, so the
 * slug is retired forever (/help/<slug> keeps showing the offline page and the
 * slug can never be reused). Public media is never touched. A foreign-key block
 * rolls the whole batch back and reports it as skipped.
 */
export async function purgeHelpBatch(
  client: PoolClient, batchId: string, cutoff: Date, requestId: string,
): Promise<HelpBatchOutcome> {
  const outcome: HelpBatchOutcome = { purged: false, nodes: 0, articles: 0, blocked: false };
  await client.query("BEGIN");
  try {
    const nodes = (await client.query<BatchNode & { kind: string; resourceKey: string | null }>(
      `SELECT "id", "depth", "kind", "resource_key" AS "resourceKey" FROM "zzsh_content"."help_tree_node"
        WHERE "delete_batch_id" = $1 AND "deleted_at" IS NOT NULL AND "deleted_at" <= $2
        ORDER BY "depth" DESC, "id" FOR UPDATE`, [batchId, cutoff],
    )).rows;
    if (nodes.length === 0) { await client.query("COMMIT"); return outcome; }
    const articleKeys = nodes.filter(node => node.kind === "ARTICLE" && node.resourceKey).map(node => node.resourceKey!);
    if (articleKeys.length > 0) {
      const itemIds = (await client.query<{ id: string }>(
        `SELECT "id" FROM "zzsh_content"."content_item" WHERE "type" = 'RESOURCE' AND "resource_key" = ANY($1::text[])`, [articleKeys],
      )).rows.map(row => row.id);
      if (itemIds.length > 0) {
        await client.query(`DELETE FROM "zzsh_content"."content_version" WHERE "item_id" = ANY($1::text[])`, [itemIds]);
        await client.query(`DELETE FROM "zzsh_content"."content_item" WHERE "id" = ANY($1::text[])`, [itemIds]);
      }
      const slugs = articleKeys.map(key => key.slice(6));
      // Keep the tombstone forever; only stamp purged_at (idempotent).
      await client.query(
        `UPDATE "zzsh_content"."help_slug_tombstone" SET "purged_at" = clock_timestamp() WHERE "slug" = ANY($1::text[]) AND "purged_at" IS NULL`, [slugs],
      );
    }
    let removed = 0;
    for (const depth of descendingDepths(nodes)) {
      const deleted = await client.query(
        `DELETE FROM "zzsh_content"."help_tree_node" n
          WHERE n."delete_batch_id" = $1 AND n."depth" = $2
            AND NOT EXISTS (SELECT 1 FROM "zzsh_content"."help_tree_node" c WHERE c."parent_id" = n."id")`, [batchId, depth],
      );
      removed += deleted.rowCount ?? 0;
    }
    const remaining = (await client.query<{ count: number }>(
      `SELECT count(*)::int AS "count" FROM "zzsh_content"."help_tree_node" WHERE "delete_batch_id" = $1`, [batchId],
    )).rows[0]?.count ?? 0;
    if (remaining === 0) {
      await recordAudit(client, {
        actorType: "system", actorId: SYSTEM_ACTOR_ID, sessionId: "system", action: "HELP_PURGED",
        objectType: "help_delete_batch", objectId: batchId, outcome: "SUCCESS", requestId, reason: "content.trash.purge",
        details: { batchId, nodeCount: nodes.length, articleCount: articleKeys.length },
      });
      outcome.purged = true;
    }
    outcome.nodes = removed;
    outcome.articles = articleKeys.length;
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // A foreign-key block (e.g. a snapshot still referenced elsewhere) keeps the
    // batch in the trash; report it as blocked so the pass logs a skip.
    outcome.blocked = true;
    log("skip", { kind: "help", batchId, reason: error instanceof Error ? error.message : String(error), recovery: "RETRY_BATCH" });
    return outcome;
  }
}

/** Sweep PENDING uploads that expired over 24h ago and were never referenced. */
export async function purgeExpiredPendingImages(
  client: PoolClient, now: Date, storage: DocsImageStorage | undefined,
): Promise<number> {
  if (!storage) return 0;
  const graceCutoff = new Date(now.getTime() - PENDING_IMAGE_GRACE_MS);
  const images = (await client.query<{ id: string; objectKey: string }>(
    `SELECT i."id", i."object_key" AS "objectKey" FROM "zzsh_docs"."doc_image" i
      WHERE i."status" IN ('PENDING', 'PURGING') AND i."completed_at" IS NULL AND i."upload_expires_at" <= $1
        AND NOT EXISTS (SELECT 1 FROM "zzsh_docs"."doc_version_image" vi WHERE vi."image_id" = i."id")`, [graceCutoff],
  )).rows;
  let deleted = 0;
  for (const image of images) {
    await client.query("BEGIN");
    try {
      // Re-check under lock: a concurrent save may have referenced/completed it.
      const still = (await client.query<{ id: string }>(
        `SELECT i."id" FROM "zzsh_docs"."doc_image" i
          WHERE i."id" = $1 AND i."status" IN ('PENDING', 'PURGING') AND i."completed_at" IS NULL AND i."upload_expires_at" <= $2
            AND NOT EXISTS (SELECT 1 FROM "zzsh_docs"."doc_version_image" vi WHERE vi."image_id" = i."id") FOR UPDATE`, [image.id, graceCutoff],
      )).rows[0];
      if (!still) { await client.query("COMMIT"); continue; }
      await client.query(`UPDATE "zzsh_docs"."doc_image" SET "status" = 'PURGING' WHERE "id" = $1`, [image.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      log("error", { phase: "pending", imageId: image.id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    try {
      await storage.deleteObject(image.objectKey);
      await client.query(`DELETE FROM "zzsh_docs"."doc_image" WHERE "id" = $1 AND "status" = 'PURGING'`, [image.id]);
      deleted += 1;
    } catch (error) {
      log("error", { phase: "pending-oss", imageId: image.id, reason: error instanceof Error ? error.message : String(error), recovery: "RETRY_PURGING" });
    }
  }
  return deleted;
}

/** One drive cycle over the live lock session: due doc batches, due help
 *  batches, then expired pending uploads. Cancellation is honoured between
 *  batches so an expired worker never starts new work. */
export async function runTrashPurge(input: TrashPurgeRunInput): Promise<TrashPurgeResult> {
  const { client, batchLimit, now, requestId, storage, isCancelled } = input;
  const result = emptyResult();
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_MS);

  const docBatches = await selectDueDocBatches(client, cutoff, batchLimit);
  for (const batchId of docBatches) {
    if (isCancelled()) break;
    const outcome = await purgeDocsBatch(client, batchId, cutoff, storage, requestId);
    result.docBatches += 1;
    result.docNodes += outcome.nodes;
    result.imagesDeleted += outcome.imagesDeleted;
    result.imagesKept += outcome.imagesKept;
    if (!outcome.purged && outcome.nodes === 0 && outcome.pendingOss === 0) result.skipped += 1;
    log("batch", { kind: "doc", batchId, nodes: outcome.nodes, versions: outcome.versions, imagesDeleted: outcome.imagesDeleted, imagesKept: outcome.imagesKept, purged: outcome.purged });
  }

  const helpBatches = await selectDueHelpBatches(client, cutoff, batchLimit);
  for (const batchId of helpBatches) {
    if (isCancelled()) break;
    const outcome = await purgeHelpBatch(client, batchId, cutoff, requestId);
    result.helpBatches += 1;
    result.helpNodes += outcome.nodes;
    if (outcome.blocked) result.skipped += 1;
    log("batch", { kind: "help", batchId, nodes: outcome.nodes, articles: outcome.articles, purged: outcome.purged, blocked: outcome.blocked });
  }

  if (!isCancelled()) result.pendingImages = await purgeExpiredPendingImages(client, now, storage);
  return result;
}

export function createTrashPurgeStore(): TrashPurgeStore {
  return { runOnce: runTrashPurge };
}

@Injectable()
export class TrashPurgeService implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private locking: PoolClient | null = null;
  private lockLost: (() => void) | null = null;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | null = null;
  private readonly store: TrashPurgeStore;
  constructor(@Inject("TRASH_PURGE_OPTIONS") private readonly options: TrashPurgeModuleOptions) {
    this.store = options.store ?? createTrashPurgeStore();
  }
  onModuleInit(): void {
    // The timer always runs: an instance that lost the lock must be able to take over later.
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref();
  }
  /** Advisory locks die with their session, so the live session holding this exact key is the only execution right.
   *  pg_locks exposes an int8 advisory key as classid=high 32 bits, objid=low 32 bits, objsubid=1. */
  private async ensureLock(): Promise<PoolClient | null> {
    if (this.locking) {
      try {
        const held = await this.locking.query(`SELECT count(*)::int AS held FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND objsubid=1 AND granted
          AND classid=(($1::bigint >> 32) & 4294967295)::int AND objid=($1::bigint & 4294967295)::int`, [TRASH_PURGE_LOCK_KEY]);
        if (Number(held.rows[0]?.held ?? 0) > 0) return this.locking;
      } catch { /* the session is gone */ }
      log("error", { phase: "lock", reason: `the driving session no longer holds ${TRASH_PURGE_LOCK_KEY}` });
      await this.releaseLock();
      return null;
    }
    const client = await this.options.pool.connect();
    try {
      const acquired = (await client.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [TRASH_PURGE_LOCK_KEY])).rows[0]?.acquired === true;
      if (!acquired) { client.release(); return null; }
      const lost = () => { if (this.locking === client) void this.releaseLock(); };
      this.lockLost = lost;
      client.once("error", lost);
      client.once("end", lost);
      this.locking = client;
      return client;
    } catch { client.release(true); return null; }
  }
  private async releaseLock(): Promise<void> {
    const client = this.locking;
    this.locking = null;
    const lost = this.lockLost;
    this.lockLost = null;
    if (!client) return;
    if (lost) { client.removeListener("error", lost); client.removeListener("end", lost); }
    let released = false;
    try { released = (await client.query("SELECT pg_advisory_unlock($1::bigint) AS released", [TRASH_PURGE_LOCK_KEY])).rows[0]?.released === true; } catch { /* drop an unusable session below */ }
    try { client.release(!released); } catch { /* already destroyed sessions have no pool lease */ }
  }
  /** One drive cycle: holding the session lock is the only execution right. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.inFlight = (async () => {
      const startedAt = Date.now();
      try {
        const client = await this.ensureLock();
        if (!client) { log("skip", { reason: "lock-held-by-another-session" }); return; }
        log("start", { workerId: this.options.workerId, batchLimit: this.options.batchLimit });
        const result = await this.store.runOnce({
          client, batchLimit: this.options.batchLimit, now: new Date(), storage: this.options.storage,
          requestId: `purge_${this.options.workerId}_${startedAt}`,
          isCancelled: () => this.stopping || this.locking !== client,
        });
        log("done", { workerId: this.options.workerId, elapsedMs: Date.now() - startedAt, ...result });
      } catch (error) {
        log("error", { phase: "tick", reason: error instanceof Error ? error.message : String(error), recovery: "RETRY_NEXT_TICK" });
        if (this.stopping) await this.releaseLock();
      } finally { this.running = false; }
    })();
    await this.inFlight;
  }
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.inFlight) await this.inFlight.catch(() => {});
    await this.releaseLock();
  }
}

@Module({})
export class TrashPurgeModule {
  static register(options: TrashPurgeModuleOptions): DynamicModule {
    return { module: TrashPurgeModule, providers: [{ provide: "TRASH_PURGE_OPTIONS", useValue: options }, TrashPurgeService] };
  }
}