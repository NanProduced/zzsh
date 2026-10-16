import type { PoolClient } from "pg";

import { createCarouselItem, createContentItem, isCarouselSlot, publishContentVersion } from "./content";
import { invalid, sha256Hex } from "../supply/supply-util";

// Offline seed writer for the zzsh_content foundation (announcements, news,
// carousel entries). Idempotency comes from deterministic ids derived from a
// stable seedKey: a re-run finds the existing row and records it as skipped
// instead of inserting a duplicate. The writer is only executed when an
// operator explicitly invokes it with a PoolClient inside a transaction; it is
// not wired to any route or startup path. Media references are passed through
// to the regular content writers, which enforce the CONTENT_MEDIA purpose and
// (on publish) the approved/public-display requirement, so the caller must
// guarantee seeded media ids are already reviewed assets.
//
// 真实执行需 Q 侧迁移/ACL 与 Owner 运行窗口；本次实现仅离线交付，NOT_RUN。
const SEED_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function contentSeedItemId(seedKey: string): string {
  return "cnt_" + sha256Hex(`zzsh-content-seed:item:${seedKey}`).slice(0, 32);
}

export function contentSeedVersionId(seedKey: string): string {
  return "cntv_" + sha256Hex(`zzsh-content-seed:version:${seedKey}`).slice(0, 32);
}

export function contentSeedCarouselId(seedKey: string): string {
  return "crl_" + sha256Hex(`zzsh-content-seed:carousel:${seedKey}`).slice(0, 32);
}

export type ContentSeedArticle = {
  seedKey: string;
  title: string;
  summary?: string;
  body?: string;
  coverMediaId?: string | null;
  gameId?: string | null;
  publish?: boolean;
};

export type ContentSeedCarousel = {
  seedKey: string;
  slot: string;
  mediaId: string;
  title: string;
  imageAlt: string;
  description?: string;
  linkUrl?: string | null;
  enabled?: boolean;
  sortOrder?: number;
  startsAt?: string | null;
  endsAt?: string | null;
};

export type ContentSeed = {
  announcements?: ContentSeedArticle[];
  news?: ContentSeedArticle[];
  carousel?: ContentSeedCarousel[];
};

export type ContentSeedContext = {
  adminUserId: string;
};

export type ContentSeedResult = {
  created: Array<{ seedKey: string; kind: string; id: string }>;
  skipped: Array<{ seedKey: string; kind: string; reason: string }>;
};

function checkedSeedKey(seedKey: unknown): string {
  if (typeof seedKey !== "string" || !SEED_KEY_PATTERN.test(seedKey)) throw invalid("Seed key is invalid", "seedKey");
  return seedKey;
}

async function seedRowExists(client: PoolClient, table: "content_item" | "carousel_item", id: string): Promise<boolean> {
  const result = await client.query(`SELECT "id" FROM "zzsh_content"."${table}" WHERE "id" = $1`, [id]);
  return result.rows.length > 0;
}

export async function seedContentFoundation(client: PoolClient, seed: ContentSeed, ctx: ContentSeedContext): Promise<ContentSeedResult> {
  if (!ctx || typeof ctx.adminUserId !== "string" || ctx.adminUserId.length === 0) throw invalid("An explicit admin actor is required to run the content seed", "adminUserId");
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) throw invalid("Seed input is invalid");
  const result: ContentSeedResult = { created: [], skipped: [] };

  const articles: Array<{ kind: "ANNOUNCEMENT" | "NEWS"; entry: ContentSeedArticle }> = [
    ...(seed.announcements ?? []).map((entry) => ({ kind: "ANNOUNCEMENT" as const, entry })),
    ...(seed.news ?? []).map((entry) => ({ kind: "NEWS" as const, entry })),
  ];
  for (const { kind, entry } of articles) {
    const seedKey = checkedSeedKey(entry.seedKey);
    const itemId = contentSeedItemId(seedKey);
    if (await seedRowExists(client, "content_item", itemId)) {
      result.skipped.push({ seedKey, kind, reason: "ALREADY_EXISTS" });
      continue;
    }
    const { version } = await createContentItem(client, ctx.adminUserId, {
      type: kind,
      gameId: entry.gameId ?? null,
      title: entry.title,
      summary: entry.summary,
      body: entry.body,
      coverMediaId: entry.coverMediaId ?? null,
      ids: { itemId, versionId: contentSeedVersionId(seedKey) },
    });
    if (entry.publish) await publishContentVersion(client, ctx.adminUserId, itemId, version.id, version.revision);
    result.created.push({ seedKey, kind, id: itemId });
  }

  for (const entry of seed.carousel ?? []) {
    const seedKey = checkedSeedKey(entry.seedKey);
    const id = contentSeedCarouselId(seedKey);
    if (await seedRowExists(client, "carousel_item", id)) {
      result.skipped.push({ seedKey, kind: "CAROUSEL", reason: "ALREADY_EXISTS" });
      continue;
    }
    if (!isCarouselSlot(entry.slot)) throw invalid("Carousel slot is invalid", "slot");
    const row = await createCarouselItem(client, ctx.adminUserId, entry.slot, {
      mediaId: entry.mediaId,
      title: entry.title,
      imageAlt: entry.imageAlt,
      description: entry.description,
      linkUrl: entry.linkUrl ?? null,
      enabled: entry.enabled ?? false,
      sortOrder: entry.sortOrder,
      startsAt: entry.startsAt ?? null,
      endsAt: entry.endsAt ?? null,
    }, id);
    result.created.push({ seedKey, kind: "CAROUSEL", id: row.id });
  }

  return result;
}
