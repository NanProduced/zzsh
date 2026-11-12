import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { DEFAULT_RESOURCES, MAX_RESOURCE_BYTES, validateResource, type ContentResource } from "@zzsh/content";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import {
  prepareResourceDraft, replaceResourceMedia, requireResourceMedia, restoreContentDraft, saveContentDraft, saveContentMediaDraft,
  type ContentItemRow, type ContentVersionRow,
} from "../src/content/content";
import { listResourceKeys, readPublicResource } from "../src/content/managed-content";
import { resourcePage } from "../src/content/content-routes";

const KEY = "guide:rental-getting-started";
const MEDIA_ID = `med_${"a".repeat(32)}`;
const OTHER_MEDIA = `med_${"b".repeat(32)}`;
const NOW = new Date("2026-10-28T00:00:00Z");

// guide / notice 正文唯一格式 plate；测试夹具直接构造合法 Plate 文档。
const GUIDE_META = { id: "R01", slug: "rental-getting-started", title: "租号入门", summary: "摘要", category: "rental", audience: ["renter"], keywords: ["租号"], updatedAt: "2026-10-06", related: [], contactCta: true };
const pNode = (text: string) => ({ type: "p", children: [{ text }] });
const imgNode = (mediaId: string) => ({ type: "img", mediaId, alt: "插图", children: [{ text: "" }] });
const helpDocument = (value: unknown[]): PlateDocumentEnvelope => ({ format: "plate", schemaVersion: 1, preset: "help", value }) as PlateDocumentEnvelope;
function guideResource(value: unknown[], mediaIds: string[] = []): ContentResource {
  return validateResource(KEY, { kind: "guide", ...GUIDE_META, format: "plate", schemaVersion: 1, document: helpDocument(value), mediaIds });
}
function noticeDocument(text: string): PlateDocumentEnvelope {
  return { format: "plate", schemaVersion: 1, preset: "notice", value: [pNode(text)] } as PlateDocumentEnvelope;
}
/** 这些用例只操作 RESOURCE 版本，payload 必为带 kind 的内容资源。 */
function resourcePayload(version: ContentVersionRow): ContentResource {
  if (!version.payload || !("kind" in version.payload)) throw new Error("expected a resource payload");
  return version.payload;
}

class ContentStore {
  item: ContentItemRow = { id: "cnt_test", type: "RESOURCE", resourceKey: KEY, gameId: null, gameName: null, sortOrder: 0, revision: "2", createdByAdminId: "admin", createdAt: NOW, updatedAt: NOW };
  versions: ContentVersionRow[] = [];
  media = [{ id: MEDIA_ID, reviewState: "APPROVED", accessClass: "PUBLIC_DISPLAY", publicStorageKey: "public/derivative", width: 512, height: 512 }];
  statements: string[] = [];

  version(id: string, payload: ContentResource, state: string, sequence: number): ContentVersionRow {
    return { id, itemId: this.item.id, sequence, state, title: payload.title, summary: payload.kind === "guide" ? payload.summary : "", body: "", payload,
      coverMediaId: null, revision: "1", publishedAt: state === "PUBLISHED" ? NOW : null, publishedByAdminId: state === "PUBLISHED" ? "admin" : null, createdAt: NOW, updatedAt: NOW };
  }

  client(): PoolClient { return { query: this.query } as unknown as PoolClient; }

  query = async (sql: string, parameters: unknown[] = []) => {
    this.statements.push(sql);
    const rows = (data: unknown[]) => ({ rows: structuredClone(data), rowCount: data.length });
    if (sql.includes('FROM "zzsh_content"."content_item" WHERE "type"')) return rows(this.item.resourceKey === parameters[0] ? [{ id: this.item.id }] : []);
    if (sql.includes('WHERE i."id" = $1')) return rows(parameters[0] === this.item.id ? [this.item] : []);
    if (sql.includes('FROM "zzsh_content"."content_version" v')) {
      const found = sql.includes('v."id" = $1') ? this.versions.filter(v => v.id === parameters[0]) : this.versions.filter(v => v.itemId === parameters[0]);
      const ordered = found.filter(v => !sql.includes('v."state" <> \'DRAFT\'') || v.state !== "DRAFT").sort((a, b) => b.sequence - a.sequence);
      return rows(sql.includes("LIMIT 1") ? ordered.slice(0, 1) : ordered);
    }
    if (sql.startsWith('SELECT 1 FROM "zzsh_content"."content_version"')) return rows(this.versions.filter(v => v.itemId === parameters[0] && v.state === "DRAFT").map(() => ({ value: 1 })));
    if (sql.includes('FROM "zzsh_supply"."media_asset"')) {
      const ids = parameters[0] as string[];
      return rows(this.media.filter(m => ids.includes(m.id) && (!sql.includes("'APPROVED'") || (m.reviewState === "APPROVED" && m.accessClass === "PUBLIC_DISPLAY" && m.publicStorageKey))));
    }
    if (sql.startsWith('UPDATE "zzsh_content"."content_version" SET "payload"')) {
      const v = this.versions.find(value => value.id === parameters[parameters.length - 2])!;
      v.payload = JSON.parse(parameters[0] as string); v.title = parameters[1] as string; v.summary = parameters[2] as string; v.revision = String(Number(v.revision) + 1);
      return rows([]);
    }
    if (sql.startsWith('UPDATE "zzsh_content"."content_item"')) { this.item.revision = String(Number(this.item.revision) + 1); return rows([]); }
    if (sql.startsWith('UPDATE "zzsh_content"."content_version" SET "state" = \'SUPERSEDED\'')) {
      for (const v of this.versions) if (v.itemId === parameters[0] && v.state === "DRAFT") v.state = "SUPERSEDED";
      return rows([]);
    }
    if (sql.startsWith('INSERT INTO "zzsh_content"."content_version"')) {
      const payload = JSON.parse(parameters[8] as string) as ContentResource;
      const v = this.version(parameters[0] as string, payload, "DRAFT", parameters[2] as number);
      v.title = parameters[3] as string; v.summary = parameters[4] as string; v.body = parameters[5] as string;
      this.versions.push(v); return rows([]);
    }
    throw new Error(`Unexpected content test query: ${sql.slice(0, 100)}`);
  };
}

test("plate draft keeps the document and derives image references from it, ignoring a forged list", async () => {
  const prepared = await prepareResourceDraft(KEY, guideResource([pNode("原文必须保留"), imgNode(MEDIA_ID)], [OTHER_MEDIA]));
  assert.equal(prepared.kind, "guide");
  assert.deepEqual(prepared.mediaIds, [MEDIA_ID], "mediaIds are recomputed from the document, not trusted from the caller");
  const store = new ContentStore();
  await requireResourceMedia(store.client(), prepared, false);
  assert.equal(store.statements.length, 0, "saving a draft does not resolve or expose media");
  await requireResourceMedia(store.client(), prepared, true, KEY);
  assert.ok(store.statements.some(sql => sql.includes("FOR SHARE")), "public eligibility is locked until publishing commits");
});

test("sections / markdown payloads are rejected; only plate is accepted", () => {
  const base = { kind: "guide", ...GUIDE_META, format: "plate", schemaVersion: 1, document: helpDocument([pNode("正文")]), mediaIds: [] };
  assert.throws(() => validateResource(KEY, { ...base, sections: [{ id: "x", title: "t", blocks: [] }] }), /sections|markdown|plate/);
  assert.throws(() => validateResource(KEY, { ...base, markdown: "# 标题" }), /sections|markdown|plate/);
  assert.throws(() => validateResource(KEY, { ...base, format: "markdown" }), /plate/);
  assert.throws(() => guideResource([{ type: "p", children: [{ type: "a", url: "javascript:alert(1)", children: [{ text: "领取" }] }] }]), /正文未通过校验/);
});

test("publishing rechecks referenced/unknown/revoked media with a locked qualification map", async () => {
  const store = new ContentStore();
  const unknown = guideResource([imgNode(OTHER_MEDIA)]);
  await assert.rejects(() => requireResourceMedia(store.client(), unknown, true, KEY), /Only platform content media/);
  const valid = guideResource([imgNode(MEDIA_ID)]);
  await requireResourceMedia(store.client(), valid, true, KEY);
  assert.ok(store.statements.some(sql => sql.includes("FOR SHARE")));
  store.media[0]!.accessClass = "PRIVATE_REVIEW";
  await assert.rejects(() => requireResourceMedia(store.client(), valid, true, KEY), /approved and publicly displayable/);
});

test("compact notice text is accepted while an oversized notice fails validation", async () => {
  const key = "placement:PUBLISH_SAFE_BOX";
  const oversized = { kind: "notice", title: "安全箱说明", format: "plate", schemaVersion: 1, document: noticeDocument("简短说明".repeat(400)), mediaIds: [] };
  assert.throws(() => validateResource(key, oversized), /TEXT_TOO_LONG/);
  const draft = await prepareResourceDraft(key, { kind: "notice", title: "安全箱说明", format: "plate", schemaVersion: 1, document: noticeDocument("简短说明"), mediaIds: [] });
  assert.equal(draft.kind, "notice");
  const store = new ContentStore();
  await requireResourceMedia(store.client(), draft, false, key);
  await requireResourceMedia(store.client(), draft, true, key);
});

test("media-only replacements preserve fixed metadata and reject added fields or changed positions", () => {
  const contact = DEFAULT_RESOURCES["placement:FOLLOW"]!;
  const replaced = replaceResourceMedia("placement:FOLLOW", contact, { qrMediaId: MEDIA_ID });
  assert.deepEqual(replaced, { ...contact, qrMediaId: MEDIA_ID });
  if (contact.kind === "contact") {
    const configured = { ...contact, enabled: true, qrMediaId: MEDIA_ID };
    assert.deepEqual(replaceResourceMedia("placement:FOLLOW", configured, { qrMediaId: null }), { ...configured, qrMediaId: null }, "clearing images does not rewrite legacy enabled metadata");
  }
  assert.throws(() => replaceResourceMedia("placement:FOLLOW", contact, { qrMediaId: MEDIA_ID, title: "篡改文案" }), /unsupported fields/);
  const carousel = DEFAULT_RESOURCES["placement:HOME_HERO"]!;
  assert.equal(carousel.kind, "carousel");
  if (carousel.kind !== "carousel") return;
  const slides = carousel.slides.map(slide => ({ id: slide.id, mediaId: MEDIA_ID, mobileMediaId: null }));
  assert.equal(replaceResourceMedia("placement:HOME_HERO", carousel, { slides }).kind, "carousel");
  assert.throws(() => replaceResourceMedia("placement:HOME_HERO", carousel, { slides: [...slides].reverse() }), /positions and order/);
  assert.throws(() => replaceResourceMedia("placement:HOME_HERO", carousel, { slides: slides.slice(1) }), /added or removed/);
});

test("media draft saves require the current item revision and generic payload saves are rejected", async () => {
  const store = new ContentStore(); store.item.resourceKey = "placement:FOLLOW";
  store.versions = [store.version("draft", DEFAULT_RESOURCES["placement:FOLLOW"]!, "DRAFT", 1)];
  await assert.rejects(() => saveContentMediaDraft(store.client(), store.item.id, "draft", "1", { qrMediaId: MEDIA_ID }), /Content changed/);
  assert.equal(store.statements.filter(sql => sql.startsWith("UPDATE")).length, 0);
  await assert.rejects(() => saveContentDraft(store.client(), store.item.id, "draft", "2", { payload: DEFAULT_RESOURCES["placement:FOLLOW"]! }), /media-only/);
  const saved = await saveContentMediaDraft(store.client(), store.item.id, "draft", "2", { qrMediaId: MEDIA_ID });
  assert.equal(saved.item.revision, "3");
  const payload = resourcePayload(saved.version);
  assert.equal(payload.kind, "contact");
  if (payload.kind === "contact") assert.equal(payload.qrMediaId, MEDIA_ID);
});

test("restore retains a replaced draft as history and copies the selected plate snapshot without conversion", async () => {
  const store = new ContentStore();
  const original = guideResource([pNode("旧版本的原始规则，不能自动改写。")]);
  const source = store.version("published", original, "PUBLISHED", 1);
  source.body = "旧兼容列中的副本，历史不能被改写。";
  const draft = store.version("draft", guideResource([pNode("未发布但应保留的原稿")]), "DRAFT", 2);
  store.versions = [source, draft];
  const before = JSON.stringify(source);
  await assert.rejects(() => restoreContentDraft(store.client(), "admin", store.item.id, "published", "1"), /Content changed/);
  assert.equal(store.versions[1]!.state, "DRAFT");
  const restored = await restoreContentDraft(store.client(), "admin", store.item.id, "published", "2");
  assert.equal(store.versions.find(v => v.id === "draft")!.state, "SUPERSEDED");
  assert.equal(JSON.stringify(store.versions.find(v => v.id === "published")), before);
  assert.deepEqual(restored.version.payload, original);
  assert.equal(restored.version.body, source.body, "restoration preserves the source compatibility fields without deriving or truncating canonical payload text");
  assert.equal(resourcePayload(restored.version).kind, "guide");
  assert.equal(restored.version.sequence, 3);
});

test("public payload and metadata are selected from the same published version, never the newer draft", async () => {
  const store = new ContentStore();
  const published = store.version("published", { ...guideResource([pNode("公开正文")]), title: "公开标题" }, "PUBLISHED", 1);
  const draft = store.version("draft", guideResource([pNode("新的未公开正文")]), "DRAFT", 2);
  store.versions = [published, draft];
  const resource = await readPublicResource(store.client(), KEY);
  assert.equal(resource.version?.id, "published");
  assert.equal(resource.version?.sequence, 1);
  assert.equal(resource.payload?.title, "公开标题");
  assert.equal(JSON.stringify(resource).includes("新的未公开正文"), false);
});

test("footer draft stays private and public media qualification is checked again", async () => {
  const key = "placement:FOOTER", base = DEFAULT_RESOURCES[key]!;
  assert.equal(base.kind, "footer");
  if (base.kind !== "footer") return;
  const store = new ContentStore(); store.item.resourceKey = key;
  const published = { ...base, copyright: "线上主体", socials: [{ label: "公开渠道", href: null, qrMediaId: MEDIA_ID }] };
  const draft = { ...base, copyright: "未发布主体", socials: [] };
  store.versions = [store.version("published", published, "PUBLISHED", 1), store.version("draft", draft, "DRAFT", 2)];
  await requireResourceMedia(store.client(), published, true, key);
  assert.ok(store.statements.some(sql => sql.includes("FOR SHARE")));
  let resource = await readPublicResource(store.client(), key);
  assert.equal(resource.payload?.kind === "footer" && resource.payload.copyright, "线上主体");
  assert.equal(resource.media[0]?.url, `/api/v1/content/media/${MEDIA_ID}/content`);
  assert.doesNotMatch(JSON.stringify(resource), /未发布主体/);
  store.media[0]!.accessClass = "PRIVATE_REVIEW";
  await assert.rejects(() => requireResourceMedia(store.client(), published, true, key), /approved and publicly displayable/);
  resource = await readPublicResource(store.client(), key);
  assert.equal(resource.media[0]?.url, null);
  store.versions = [store.version("draft-only", draft, "DRAFT", 1)];
  resource = await readPublicResource(store.client(), key);
  assert.equal(resource.source, "BUILTIN");
  assert.equal(resource.payload?.kind === "footer" && resource.payload.copyright, base.copyright);
});

test("an explicit CAS restore of the saved legacy carousel draft rebuilds fixed slots without guessing media mappings", async () => {
  const store = new ContentStore(); store.item.resourceKey = "placement:HOME_HERO";
  const template = DEFAULT_RESOURCES["placement:HOME_HERO"]!;
  assert.equal(template.kind, "carousel");
  if (template.kind !== "carousel") return;
  const legacy = { ...template, slides: [{ ...template.slides[0]!, id: "old_random_slot", mediaId: MEDIA_ID }] };
  const draft = store.version("legacy-draft", legacy, "DRAFT", 1);
  const foreign = { ...store.version("foreign-version", guideResource([pNode("外部版本")]), "SUPERSEDED", 1), itemId: "cnt_other" };
  store.versions = [draft, foreign];
  const images = { slides: template.slides.map(slide => ({ id: slide.id, mediaId: MEDIA_ID, mobileMediaId: null })) };
  await assert.rejects(() => saveContentMediaDraft(store.client(), store.item.id, draft.id, "2", images), /not automatically mapped/);
  await assert.rejects(() => restoreContentDraft(store.client(), "admin", store.item.id, foreign.id, "2"), /Resource not found/);
  assert.equal(draft.state, "DRAFT");
  const restored = await restoreContentDraft(store.client(), "admin", store.item.id, draft.id, "2");
  assert.equal(store.versions.find(version => version.id === draft.id)?.state, "SUPERSEDED");
  assert.deepEqual(store.versions.find(version => version.id === draft.id)?.payload, legacy, "unmapped legacy media remains in history");
  const restoredPayload = resourcePayload(restored.version);
  assert.equal(restoredPayload.kind, "carousel");
  if (restoredPayload.kind !== "carousel") return;
  assert.deepEqual(restoredPayload.slides.map(slide => slide.id), ["delta", "protection", "accounts"]);
  assert.ok(restoredPayload.slides.every(slide => slide.mediaId === null), "no guessed mapping from random legacy IDs");
  const publicResource = await readPublicResource(store.client(), "placement:HOME_HERO");
  assert.equal(publicResource.version, null);
  assert.equal(publicResource.state, "available", "archived unpublished drafts do not mark builtin content withdrawn");
  const saved = await saveContentMediaDraft(store.client(), store.item.id, restored.version.id, store.item.revision, images);
  assert.equal(resourcePayload(saved.version).kind, "carousel");
});

test("resource pages cap both scopes at five, bind cursors to that limit and fit the Web BFF byte ceiling", () => {
  assert.equal(resourcePage(new URLSearchParams()).limit, 5);
  assert.equal(resourcePage(new URLSearchParams(), { scope: "platform" }).limit, 5);
  for (const limit of [6, 10]) {
    assert.throws(() => resourcePage(new URLSearchParams({ limit: String(limit) })), /at most 5/);
    assert.throws(() => resourcePage(new URLSearchParams({ limit: String(limit) }), { scope: "platform" }), /at most 5/);
  }
  const cursor = Buffer.from(JSON.stringify({ v: 1, after: KEY, kind: null, limit: 5, scope: null, gameId: null })).toString("base64url");
  assert.equal(resourcePage(new URLSearchParams({ cursor })).after, KEY);
  assert.throws(() => resourcePage(new URLSearchParams({ cursor, limit: "4" })), /Cursor/);

  const ids = Array.from({ length: 300 }, (_, i) => `med_${i.toString(16).padStart(32, "0")}`);
  const images = ids.map(imgNode);
  const base = guideResource([pNode("正文"), ...images]);
  const padding = "x".repeat(MAX_RESOURCE_BYTES - Buffer.byteLength(JSON.stringify(base)) - 128);
  const payload = validateResource(KEY, guideResource([pNode(padding), ...images]));
  assert.equal(payload.kind === "guide" && payload.mediaIds.length, 300);
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(payloadBytes > MAX_RESOURCE_BYTES - 512 && payloadBytes <= MAX_RESOURCE_BYTES);
  const item = { schema: "content-resource.v1", key: KEY, source: "MANAGED", state: "available", version: { id: "published", sequence: 1, publishedAt: NOW.toISOString() }, payload,
    media: ids.map(id => ({ id, url: `/api/v1/content/media/${encodeURIComponent(id)}/content` })) };
  const bytes = Buffer.byteLength(JSON.stringify({ items: Array.from({ length: 5 }, () => item), limit: 5, nextCursor: null }));
  assert.ok(bytes < 2 * 1024 * 1024, `${bytes} exceeds the Web response limit`);
});

test("footer capability is opt-in for platform admin lists and bound to the cursor", async () => {
  const scope = { scope: "platform" as const }, queries: { sql: string; params: unknown[] }[] = [];
  const client = { query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rows: [] }; } } as unknown as PoolClient;
  const old = resourcePage(new URLSearchParams(), scope);
  const current = resourcePage(new URLSearchParams({ includeFooter: "1" }), scope);
  await listResourceKeys(client, { ...old, scope });
  await listResourceKeys(client, { ...current, scope });
  await listResourceKeys(client, { limit: 5 });
  assert.deepEqual(queries.map(query => query.params[7]), [false, true, false]);
  assert.ok(queries.every(query => query.sql.includes("key <> 'placement:FOOTER'")));
  const oldCursor = Buffer.from(JSON.stringify({ v: 1, after: KEY, kind: null, limit: 5, scope: "platform", gameId: null })).toString("base64url");
  const newCursor = Buffer.from(JSON.stringify({ v: 1, after: KEY, kind: null, limit: 5, scope: "platform", gameId: null, footer: true })).toString("base64url");
  assert.equal(resourcePage(new URLSearchParams({ cursor: oldCursor }), scope).after, KEY);
  assert.equal(resourcePage(new URLSearchParams({ cursor: newCursor, includeFooter: "1" }), scope).after, KEY);
  assert.throws(() => resourcePage(new URLSearchParams({ cursor: oldCursor, includeFooter: "1" }), scope), /Cursor/);
  assert.throws(() => resourcePage(new URLSearchParams({ includeFooter: "1" })), /capability/);
});

// Source registration only; real schema/ACL upgrade still needs a dedicated PostgreSQL run.
test('canonical content migrations preserve the accepted prefix and original SQL bytes',async()=>{
 const fs=await import('node:fs'),path=await import('node:path'),crypto=await import('node:crypto');
 const folder=path.resolve('migrations/business'),j=JSON.parse(fs.readFileSync(path.join(folder,'meta/_journal.json'),'utf8'));
 const digest=(value:string|Buffer)=>crypto.createHash('sha256').update(value).digest('hex');
 assert.equal(digest(JSON.stringify(j.entries.slice(0,109))),'9e4190f0bab9324a6133941c8f34127798558195a6697819266e064b4d510de6');
 const expected=[['0109_content_management','d9620735b56c7dc63f000290d42b19761eb6f08f949d06e548fec4499fd00981'],['0110_content_draft_history_shape','59413870b9647510e893f3533706ff1e58ffb6232ecb318924b61ee303dbf11b'],['0111_platform_updates','99c1cd0acad4223fc9bcceacc4cb8348cfb452984ea5af091837a14fa55501f1']];
 for(let i=0;i<expected.length;i++){const [tag,sha]=expected[i]!,entry=j.entries[109+i];assert.equal(entry.idx,109+i);assert.equal(entry.tag,tag);assert(entry.when>j.entries[108+i].when);assert.equal(digest(fs.readFileSync(path.join(folder,tag+'.sql'))),sha);}
 assert.equal((fs.readFileSync(path.join(folder,'0111_platform_updates.sql'),'utf8').match(/\r\n/g)||[]).length,16);
});
