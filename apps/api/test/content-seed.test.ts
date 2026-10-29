import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";

import {
  contentSeedCarouselId,
  contentSeedItemId,
  contentSeedVersionId,
  seedContentFoundation,
  type ContentSeed,
} from "../src/content/content-seed";

type ItemRow = { id: string; type: string; gameId: string | null; revision: string; sortOrder: number };
type VersionRow = { id: string; itemId: string; sequence: number; state: string; title: string; summary: string; body: string; coverMediaId: string | null; revision: string; publishedAt: Date | null; publishedByAdminId: string | null };
type CarouselRow = { id: string; slotCode: string; mediaId: string; imageAlt: string; title: string; description: string; linkUrl: string | null; enabled: boolean; sortOrder: number; startsAt: Date | null; endsAt: Date | null; createdByAdminId: string };

class Stub {
  items = new Map<string, ItemRow>();
  versions = new Map<string, VersionRow>();
  carousels = new Map<string, CarouselRow>();
  games = new Set<string>();
  media = new Set<string>();
  publicMedia = new Set<string>();
  statements: string[] = [];
  managedCarousel = false;

  query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount?: number }> => {
    this.statements.push(text);
    if (text.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (text.startsWith('SELECT 1 FROM "zzsh_content"."content_item"') && text.includes('"resource_key"')) return { rows: this.managedCarousel ? [{ "?column?": 1 }] : [] };
    if (text.startsWith(`SELECT "id" FROM "zzsh_content"."content_item" WHERE "id" = $1`)) {
      return { rows: this.items.has(String(values[0])) ? [{ id: values[0] }] : [] };
    }
    if (text.startsWith(`SELECT "id" FROM "zzsh_content"."carousel_item" WHERE "id" = $1`)) {
      return { rows: this.carousels.has(String(values[0])) ? [{ id: values[0] }] : [] };
    }
    if (text.startsWith(`SELECT 1 FROM "zzsh_supply"."game"`)) {
      return { rows: this.games.has(String(values[0])) ? [{ "?column?": 1 }] : [] };
    }
    if (text.startsWith(`SELECT 1 FROM "zzsh_supply"."media_asset"`)) {
      const id = String(values[0]);
      if (text.includes("'APPROVED'")) return { rows: this.publicMedia.has(id) ? [{ "?column?": 1 }] : [] };
      return { rows: this.media.has(id) ? [{ "?column?": 1 }] : [] };
    }
    if (text.startsWith(`INSERT INTO "zzsh_content"."content_item"`)) {
      this.items.set(String(values[0]), { id: String(values[0]), type: String(values[1]), gameId: values[2] as string | null, revision: "1", sortOrder: 0 });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith(`INSERT INTO "zzsh_content"."content_version"`)) {
      // The insert keeps sequence as a SQL literal; parameters start at id.
      this.versions.set(String(values[0]), {
        id: String(values[0]), itemId: String(values[1]), sequence: 1, state: "DRAFT",
        title: String(values[2]), summary: String(values[3]), body: String(values[4]), coverMediaId: values[5] as string | null,
        revision: "1", publishedAt: null, publishedByAdminId: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith(`INSERT INTO "zzsh_content"."carousel_item"`)) {
      this.carousels.set(String(values[0]), {
        id: String(values[0]), slotCode: String(values[1]), mediaId: String(values[2]), imageAlt: String(values[3]),
        title: String(values[4]), description: String(values[5]), linkUrl: values[6] as string | null, enabled: Boolean(values[7]),
        sortOrder: Number(values[8]), startsAt: values[9] as Date | null, endsAt: values[10] as Date | null, createdByAdminId: String(values[11]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith(`UPDATE "zzsh_content"."content_version" SET "state" = 'SUPERSEDED'`)) {
      for (const version of this.versions.values()) if (version.itemId === String(values[0]) && version.state === "PUBLISHED") version.state = "SUPERSEDED";
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith(`UPDATE "zzsh_content"."content_version" SET "state" = 'PUBLISHED'`)) {
      const version = this.versions.get(String(values[0]))!;
      version.state = "PUBLISHED";
      version.publishedAt = new Date("2026-10-16T00:00:00Z");
      version.publishedByAdminId = String(values[1]);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith(`UPDATE "zzsh_content"."content_item" SET "revision" = "revision" + 1`)) {
      const item = this.items.get(String(values[0]))!;
      item.revision = String(Number(item.revision) + 1);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith(`SELECT i."id", i."type"`)) {
      const item = this.items.get(String(values[0]));
      return { rows: item ? [{ ...item, gameName: null, createdByAdminId: "admin_seed", createdAt: new Date(), updatedAt: new Date() }] : [] };
    }
    if (text.startsWith(`SELECT v."id", v."item_id"`)) {
      const version = this.versions.get(String(values[0]));
      return { rows: version ? [{ ...version, createdAt: new Date(), updatedAt: new Date() }] : [] };
    }
    if (text.startsWith(`SELECT c."id", c."slot_code"`)) {
      const carousel = this.carousels.get(String(values[0]));
      return { rows: carousel ? [{ ...carousel, revision: "1", createdAt: new Date(), updatedAt: new Date() }] : [] };
    }
    throw new Error("unexpected query: " + text);
  };
}

const client = (stub: Stub) => stub as unknown as PoolClient;
const SEED: ContentSeed = {
  announcements: [{ seedKey: "ann-launch", title: "平台上线公告", body: "正文", publish: true }],
  news: [{ seedKey: "news-weekly", gameId: "game_1", title: "每周资讯", coverMediaId: "asset_1" }],
  carousel: [{ seedKey: "hero-launch", slot: "HOME_HERO", mediaId: "asset_pub", title: "轮播标题", imageAlt: "轮播配图", enabled: true, linkUrl: "/help" }],
};

function freshStub(): Stub {
  const stub = new Stub();
  stub.games.add("game_1");
  stub.media.add("asset_1").add("asset_pub");
  stub.publicMedia.add("asset_pub");
  return stub;
}

test("seed creates each entry once with deterministic ids, then replays as skipped", async () => {
  const stub = freshStub();
  const first = await seedContentFoundation(client(stub), SEED, { adminUserId: "admin_seed" });
  assert.deepEqual(first.created.map((entry) => [entry.seedKey, entry.kind]).sort(), [["ann-launch", "ANNOUNCEMENT"], ["hero-launch", "CAROUSEL"], ["news-weekly", "NEWS"]].sort());
  assert.deepEqual(first.skipped, []);

  const annItemId = contentSeedItemId("ann-launch");
  assert.equal(first.created.find((entry) => entry.seedKey === "ann-launch")!.id, annItemId);
  assert.ok(stub.items.has(annItemId), "announcement inserted under the deterministic id");
  assert.ok(stub.items.has(contentSeedItemId("news-weekly")));
  assert.ok(stub.carousels.has(contentSeedCarouselId("hero-launch")));
  const annVersion = [...stub.versions.values()].find((version) => version.itemId === annItemId)!;
  assert.equal(annVersion.id, contentSeedVersionId("ann-launch"));
  assert.equal(annVersion.state, "PUBLISHED", "publish:true publishes the seeded draft");
  assert.ok(annVersion.publishedAt);
  const newsVersion = [...stub.versions.values()].find((version) => version.itemId === contentSeedItemId("news-weekly"))!;
  assert.equal(newsVersion.state, "DRAFT");
  assert.equal(newsVersion.coverMediaId, "asset_1");
  assert.equal(stub.items.get(contentSeedItemId("news-weekly"))!.gameId, "game_1");
  assert.equal(stub.carousels.get(contentSeedCarouselId("hero-launch"))!.enabled, true);

  const statementCount = stub.statements.length;
  const second = await seedContentFoundation(client(stub), SEED, { adminUserId: "admin_seed" });
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.skipped.map((entry) => entry.seedKey).sort(), ["ann-launch", "hero-launch", "news-weekly"]);
  assert.ok(second.skipped.every((entry) => entry.reason === "ALREADY_EXISTS"));
  const replayStatements = stub.statements.slice(statementCount);
  assert.ok(replayStatements.length > 0, "a replay re-checks existence per entry");
  assert.ok(
    replayStatements.every((text) => text.startsWith(`SELECT "id" FROM "zzsh_content".`)),
    "a replay issues only existence checks and no writes",
  );
  assert.equal(stub.items.size, 2);
  assert.equal(stub.versions.size, 2);
  assert.equal(stub.carousels.size, 1);
});

test("seed id derivation is stable per key, distinct across keys and matches id shapes", () => {
  assert.equal(contentSeedItemId("ann-launch"), contentSeedItemId("ann-launch"));
  assert.notEqual(contentSeedItemId("ann-launch"), contentSeedItemId("ann-launch-2"));
  assert.match(contentSeedItemId("ann-launch"), /^cnt_[0-9a-f]{32}$/);
  assert.match(contentSeedVersionId("ann-launch"), /^cntv_[0-9a-f]{32}$/);
  assert.match(contentSeedCarouselId("hero-launch"), /^crl_[0-9a-f]{32}$/);
  assert.notEqual(contentSeedItemId("same-key"), contentSeedCarouselId("same-key"));
});

test("seed rejects invalid input before writing", async () => {
  const badKey = freshStub();
  await assert.rejects(() => seedContentFoundation(client(badKey), { announcements: [{ seedKey: "-bad", title: "x" }] }, { adminUserId: "admin_seed" }), /seed key is invalid/i);
  assert.deepEqual(badKey.statements, []);

  const annWithGame = freshStub();
  await assert.rejects(() => seedContentFoundation(client(annWithGame), { announcements: [{ seedKey: "ann-x", title: "x", gameId: "game_1" }] }, { adminUserId: "admin_seed" }), /cannot belong to a game/i);
  assert.ok(!annWithGame.statements.some((text) => text.startsWith("INSERT")), "invalid announcement writes nothing");

  const badSlot = freshStub();
  await assert.rejects(() => seedContentFoundation(client(badSlot), { carousel: [{ seedKey: "hero-x", slot: "SIDE_BAR", mediaId: "asset_pub", title: "t", imageAlt: "a" }] }, { adminUserId: "admin_seed" }), /slot is invalid/i);

  const noMedia = freshStub();
  await assert.rejects(() => seedContentFoundation(client(noMedia), { carousel: [{ seedKey: "hero-y", slot: "HOME_HERO", mediaId: "", title: "t", imageAlt: "a" }] }, { adminUserId: "admin_seed" }), /mediaId is required/i);

  const emptyTitlePublish = freshStub();
  await assert.rejects(() => seedContentFoundation(client(emptyTitlePublish), { announcements: [{ seedKey: "ann-empty", title: "", publish: true }] }, { adminUserId: "admin_seed" }), /title is required to publish/i);
  assert.equal([...emptyTitlePublish.versions.values()][0]!.state, "DRAFT", "failed publish leaves the seeded draft in place");

  const noActor = freshStub();
  await assert.rejects(() => seedContentFoundation(client(noActor), SEED, { adminUserId: "" }), /admin actor is required/i);
  assert.deepEqual(noActor.statements, []);
});

test("seed delegates game and media existence checks to the content writers", async () => {
  const unknownGame = freshStub();
  await assert.rejects(() => seedContentFoundation(client(unknownGame), { news: [{ seedKey: "news-x", gameId: "game_x", title: "t" }] }, { adminUserId: "admin_seed" }), /not found/i);

  const unknownMedia = freshStub();
  await assert.rejects(() => seedContentFoundation(client(unknownMedia), { news: [{ seedKey: "news-y", title: "t", coverMediaId: "asset_missing" }] }, { adminUserId: "admin_seed" }), /existing content media asset/i);

  const unpublishedMedia = freshStub();
  await assert.rejects(
    () => seedContentFoundation(client(unpublishedMedia), { carousel: [{ seedKey: "hero-z", slot: "HOME_HERO", mediaId: "asset_1", title: "t", imageAlt: "a", enabled: true }] }, { adminUserId: "admin_seed" }),
    /approved and publicly displayable/i,
    "enabling a carousel entry requires reviewed public media",
  );
});
