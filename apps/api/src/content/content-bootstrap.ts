import { setSystemInitialSource } from "../database/system-initial-source";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { PoolClient } from "pg";
import { extractPlate, plateDigest, validatePlateDocument, type PlateDocumentEnvelope } from "@zzsh/content/plate";
import { validateResource, type ContentResource } from "@zzsh/content";

import { recordAudit } from "../auth/security-core";
import { invalid } from "../supply/supply-util";
import { createContentItem, loadContentItem, publishContentVersion } from "./content";
import { contentSeedItemId, contentSeedVersionId } from "./content-seed";
import { loadResourceItem } from "./managed-content";
import { newHelpId } from "./help-tree";

// First-deploy initialization of the confirmed default content (P2: help, scene
// notices and the default announcement). Every one of the 34 manifest entries is
// verified against its recomputed digest before any row is written; a single
// missing / mismatched / invalid entry fails the whole run. Legal documents and
// the early-settlement disclosure are verified here but written by P3a.
//
// The caller (Master's first-deploy script) runs this inside one transaction
// after initializeFirstAdministrators, with actorAdminId = the real first BOSS.
// No approval request or decision is ever created.

const nodeRequire = createRequire(__filename);
const DEFAULTS_DIR = path.join(path.dirname(nodeRequire.resolve("@zzsh/content")), "defaults");

const CATEGORY_FOLDERS: ReadonlyArray<{ id: string; title: string }> = [
  { id: "rental", title: "租号与使用" },
  { id: "publish", title: "出租与管理" },
  { id: "fees", title: "费用与资金" },
  { id: "account", title: "账号与安全" },
  { id: "after-sale", title: "售后与保障" },
  { id: "membership", title: "会员与邀请" },
  { id: "agreement", title: "协议与规则" },
];

type ManifestItem = { key: string; kind: "help" | "notice" | "update" | "legal"; file: string; digest: string };
type Manifest = { schemaVersion: number; confirmationSource: string; items: ManifestItem[] };

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const strip = (value: string): string => value.replace(/\s+/g, "");
const presetFor = (kind: ManifestItem["kind"]): "help" | "notice" | "update" | "legal" => kind === "legal" ? "legal" : kind;

function readDefault(file: string): Buffer {
  return readFileSync(path.join(DEFAULTS_DIR, file));
}

export type BootstrapProblem = { key: string; reason: "MISSING" | "DIGEST_MISMATCH" | "INVALID"; detail?: string };

/** Verify all 34 confirmed entries. Returns the parsed plate documents keyed by manifest key. */
async function verifyManifest(manifest: Manifest): Promise<{ problems: BootstrapProblem[]; documents: Map<string, PlateDocumentEnvelope>; entries: Map<string, Record<string, unknown>> }> {
  const problems: BootstrapProblem[] = [];
  const documents = new Map<string, PlateDocumentEnvelope>();
  const entries = new Map<string, Record<string, unknown>>();
  for (const item of manifest.items) {
    const absolute = path.join(DEFAULTS_DIR, item.file);
    if (!existsSync(absolute)) { problems.push({ key: item.key, reason: "MISSING", detail: item.file }); continue; }
    const bytes = readDefault(item.file);
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
    catch { problems.push({ key: item.key, reason: "INVALID", detail: "json parse" }); continue; }
    entries.set(item.key, entry);
    const document = entry.document as PlateDocumentEnvelope;
    const digest = await plateDigest(document);
    if (digest !== item.digest) { problems.push({ key: item.key, reason: "DIGEST_MISMATCH", detail: "plateDigest" }); continue; }
    const checked = validatePlateDocument(document, { preset: presetFor(item.kind), mode: "publish" });
    if (!checked.ok) { problems.push({ key: item.key, reason: "INVALID", detail: checked.errors.slice(0, 3).map(e => `${e.path} ${e.code}`).join(";") }); continue; }
    documents.set(item.key, document);
    if (item.kind === "legal" && typeof entry.source === "string") {
      // Legal verbatim: stripped projection equals the source text; sourceSha256 binds the source file.
      const sourceBytes = readDefault(entry.source);
      if (sha256(sourceBytes) !== entry.sourceSha256) { problems.push({ key: item.key, reason: "DIGEST_MISMATCH", detail: "sourceSha256" }); continue; }
      if (strip(extractPlate(document).plainText) !== strip(sourceBytes.toString("utf8"))) {
        problems.push({ key: item.key, reason: "INVALID", detail: "legal verbatim mismatch" });
      }
    }
  }
  return { problems, documents, entries };
}

function guidePayload(entry: Record<string, unknown>, document: PlateDocumentEnvelope): ContentResource {
  const meta = entry.meta as Record<string, unknown>;
  const anchorAliases = entry.anchorAliases as Record<string, string> | undefined;
  return validateResource(`guide:${meta.slug}`, {
    kind: "guide", ...meta, format: "plate", schemaVersion: 1, document,
    ...(anchorAliases && Object.keys(anchorAliases).length ? { anchorAliases } : {}),
  });
}

function noticePayload(entry: Record<string, unknown>, document: PlateDocumentEnvelope): ContentResource {
  const meta = entry.meta as { title: string };
  return validateResource("placement:PUBLISH_NOTICE", { kind: "notice", title: meta.title, format: "plate", schemaVersion: 1, document });
}

export type BootstrapResult = { status: "CREATED" | "ALREADY_INITIALIZED"; created: number; manifestDigest: string };

/** First deployment may reference an initial Boss before that person signs in. */
export async function assertContentBootstrapBoss(client: PoolClient, adminId: string): Promise<void> {
  const boss = (await client.query<{ isBoss: boolean; status: string; firstActivatedAt: Date | null; username: string | null; suspended: boolean }>(
    `SELECT s."is_boss" AS "isBoss",s."status",s."first_activated_at" AS "firstActivatedAt",u."username",u."suspended"
    FROM "zzsh_iam"."admin_security" s
    JOIN "zzsh_auth_admin"."user" u ON u."id"=s."admin_user_id"
    WHERE s."admin_user_id"=$1 FOR SHARE OF s,u`, [adminId])).rows[0];
  const initial = boss?.status === "PENDING_ENROLLMENT" && boss.firstActivatedAt === null
    && typeof boss.username === "string" && ["zz00001", "zz00002"].includes(boss.username.toLowerCase());
  if (!boss || boss.isBoss !== true || boss.suspended !== false || !(boss.status === "ACTIVE" || initial))
    throw invalid("Content bootstrap requires an active Boss or an unactivated initial Boss");
}

export async function bootstrapDefaultContent(
  client: PoolClient,
  input: { actorAdminId: string; requestId: string },
): Promise<BootstrapResult> {
  const actorAdminId = input.actorAdminId;
  if (typeof actorAdminId !== "string" || !actorAdminId) throw invalid("A real first BOSS admin id is required");
  const manifestBytes = readDefault("manifest.confirmed.json");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  const manifestDigest = sha256(manifestBytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.items) || manifest.items.length !== 34) {
    throw invalid("Confirmed manifest must contain exactly 34 entries");
  }
  const { problems, documents, entries } = await verifyManifest(manifest);
  if (problems.length) {
    throw invalid(`默认内容初始化失败：${problems.map(p => `${p.key}(${p.reason}${p.detail ? `:${p.detail}` : ""})`).join("、")}`);
  }

  // P2 write targets: 24 help + 6 notice + 1 update. Legal targets are P3a.
  const helpItems = manifest.items.filter(item => item.kind === "help");
  const noticeItems = manifest.items.filter(item => item.kind === "notice");
  const updateItem = manifest.items.find(item => item.kind === "update")!;
  const updateItemId = contentSeedItemId("default-update:platform-upgrade");

  // Determine current state of every write target.
  const existing = new Map<string, { itemId: string; digest: string | null }>();
  for (const item of [...helpItems, ...noticeItems]) {
    const key = item.kind === "help" ? `guide:${item.key}` : `placement:${item.key}`;
    const row = await loadResourceItem(client, key);
    if (row) {
      const published = (await client.query<{ payload: { document?: PlateDocumentEnvelope } | null }>(
        `SELECT "payload" FROM "zzsh_content"."content_version" WHERE "item_id" = $1 AND "state" = 'PUBLISHED'`, [row.id],
      )).rows[0];
      const digest = published?.payload?.document ? await plateDigest(published.payload.document) : null;
      existing.set(item.key, { itemId: row.id, digest });
    }
  }
  const updateRow = await loadContentItem(client, updateItemId);
  if (updateRow) {
    const published = (await client.query<{ payload: PlateDocumentEnvelope | null }>(
      `SELECT "payload" FROM "zzsh_content"."content_version" WHERE "item_id" = $1 AND "state" = 'PUBLISHED'`, [updateItemId],
    )).rows[0];
    existing.set(updateItem.key, { itemId: updateItemId, digest: published?.payload ? await plateDigest(published.payload) : null });
  }

  const targets = [...helpItems, ...noticeItems, updateItem];
  if (existing.size > 0) {
    // All present and identical to the confirmed defaults → idempotent success.
    const allMatch = targets.every(item => existing.get(item.key)?.digest === item.digest);
    const folders = (await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_content"."help_tree_node" WHERE "kind" = 'FOLDER' AND "deleted_at" IS NULL`,
    )).rows[0];
    if (existing.size === targets.length && allMatch && Number(folders!.count) >= CATEGORY_FOLDERS.length) {
      return { status: "ALREADY_INITIALIZED", created: 0, manifestDigest };
    }
    const status = targets.map(item => `${item.key}:${existing.has(item.key) ? (existing.get(item.key)!.digest === item.digest ? "present" : "digest-differs") : "absent"}`);
    throw invalid(`默认内容初始化失败：目标非空且不一致（${status.join("、")}）`);
  }

  // Empty targets: write everything in this transaction.
  await setSystemInitialSource(client, manifestDigest);
  let created = 0;
  const sortKey = (index: number): string => String((index + 1) * 1_000_000).padStart(16, "0");
  for (const [index, folder] of CATEGORY_FOLDERS.entries()) {
    await client.query(
      `INSERT INTO "zzsh_content"."help_tree_node" ("id", "parent_id", "kind", "title", "sort_key", "created_by_admin_id", "updated_by_admin_id", "system_initial_sha256")
       VALUES ($1, NULL, 'FOLDER', $2, $3, $4, $4, $5)`,
      [folder.id, folder.title, sortKey(index), actorAdminId, manifestDigest],
    );
  }
  const articleSort = new Map<string, number>();
  for (const item of helpItems) {
    const entry = entries.get(item.key)!;
    const document = documents.get(item.key)!;
    const payload = guidePayload(entry, document);
    const meta = entry.meta as { slug: string; category: string };
    const itemId = contentSeedItemId(`default-help:${meta.slug}`);
    const versionId = contentSeedVersionId(`default-help:${meta.slug}`);
    const result = await createContentItem(client, actorAdminId, { type: "RESOURCE", resourceKey: `guide:${meta.slug}`, gameId: null, payload, ids: { itemId, versionId } });
    await publishContentVersion(client, actorAdminId, itemId, versionId, result.item.revision);
    const order = articleSort.get(meta.category) ?? 0;
    articleSort.set(meta.category, order + 1);
    await client.query(
      `INSERT INTO "zzsh_content"."help_tree_node" ("id", "parent_id", "kind", "resource_key", "sort_key", "created_by_admin_id", "updated_by_admin_id", "system_initial_sha256")
       VALUES ($1, $2, 'ARTICLE', $3, $4, $5, $5, $6)`,
      [newHelpId("htn"), meta.category, `guide:${meta.slug}`, sortKey(order), actorAdminId, manifestDigest],
    );
    created += 1;
  }
  for (const item of noticeItems) {
    const entry = entries.get(item.key)!;
    const document = documents.get(item.key)!;
    const payload = noticePayload(entry, document);
    const itemId = contentSeedItemId(`default-notice:${item.key}`);
    const versionId = contentSeedVersionId(`default-notice:${item.key}`);
    const result = await createContentItem(client, actorAdminId, { type: "RESOURCE", resourceKey: `placement:${item.key}`, gameId: null, payload, ids: { itemId, versionId } });
    await publishContentVersion(client, actorAdminId, itemId, versionId, result.item.revision);
    created += 1;
  }
  {
    const entry = entries.get(updateItem.key)!;
    const document = documents.get(updateItem.key)!;
    const meta = entry.meta as { title: string; summary: string; pinned: boolean; tickerEnabled: boolean; validUntil: string | null; visibleFrom: string | null };
    const versionId = contentSeedVersionId("default-update:platform-upgrade");
    const result = await createContentItem(client, actorAdminId, {
      type: "ANNOUNCEMENT", gameId: null, title: meta.title, summary: meta.summary, document,
      updateSettings: { format: "plate", pinned: meta.pinned, tickerEnabled: meta.tickerEnabled, validUntil: meta.validUntil, visibleFrom: meta.visibleFrom } as never,
      ids: { itemId: updateItemId, versionId },
    });
    await publishContentVersion(client, actorAdminId, updateItemId, versionId, result.item.revision);
    created += 1;
  }

  await setSystemInitialSource(client, null);
  await recordAudit(client, {
    actorType: "system", action: "CONTENT_BOOTSTRAPPED",
    objectType: "content_bootstrap", objectId: manifestDigest, outcome: "SUCCESS", requestId: input.requestId,
    reason: "first-deploy default content",
    details: { manifestDigest, confirmationSource: manifest.confirmationSource, compatibilityBossRef: actorAdminId, created, help: helpItems.length, notice: noticeItems.length, update: 1 },
  });
  return { status: "CREATED", created, manifestDigest };
}
