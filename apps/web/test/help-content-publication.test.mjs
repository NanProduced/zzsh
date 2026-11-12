import { test } from "node:test";
import assert from "node:assert/strict";
import { publicHelpArticle } from "../src/lib/help-content.ts";
import { parsePublicContentResource } from "../src/lib/content-public.ts";
import { searchHelpArticles } from "../src/content/help/search.ts";
import { articleToc } from "../src/components/help/nav-data.ts";

// P2：帮助正文唯一格式 plate；投影（标题/目录/搜索文本/素材）来自同一份发布快照。
const META = { id: "R01", slug: "rental-getting-started", title: "租号入门", summary: "摘要", category: "rental", audience: ["renter"], keywords: ["租号"], updatedAt: "2026-10-06", related: [], contactCta: true };
const doc = (value) => ({ format: "plate", schemaVersion: 1, preset: "help", value });
const p = (text) => ({ type: "p", children: [{ text }] });
const h2 = (id, text) => ({ type: "h2", id, children: [{ text }] });
const img = (mediaId) => ({ type: "img", mediaId, alt: "插图", children: [{ text: "" }] });

function published(version, value, mediaId = "m1") {
  const guide = { kind: "guide", ...META, title: `版本${version}标题`, summary: `版本${version}摘要`, format: "plate", schemaVersion: 1, document: doc(value), mediaIds: [mediaId] };
  return parsePublicContentResource({ schema: "content-resource.v1", key: `guide:${guide.slug}`, source: "MANAGED", state: "available", payload: guide,
    version: { id: `v${version}`, sequence: version, publishedAt: "2026-10-28T00:00:00Z" }, media: [{ id: mediaId, url: `/api/v1/content/media/${mediaId}/content` }] });
}

test("one publication snapshot supplies the title, plate document, TOC, search text and authorized media", async () => {
  const first = await publicHelpArticle(published(1, [h2("old", "旧说明"), p("旧版独有词。"), img("m1")]));
  const second = await publicHelpArticle(published(2, [h2("new", "新说明"), p("新版独有词。"), img("m2")], "m2"));
  assert.equal(second.version.id, "v2"); assert.equal(second.title, "版本2标题");
  assert.match(second.plainText, /新版独有词/); assert.equal(articleToc(second)[0].title, "新说明");
  assert.equal(second.mediaUrls.m2, "/api/content/media/m2/content"); assert.equal(second.mediaUrls.m1, undefined);
  assert.equal(searchHelpArticles("新版独有词", [second]).length, 1);
  assert.equal(searchHelpArticles("旧版独有词", [second]).length, 0);
  assert.equal(first.version.id, "v1"); assert.match(first.plainText, /旧版独有词/);
});

test("withdrawal and current media revocation cannot revive a formerly public URL", async () => {
  const envelope = published(1, [h2("s", "说明"), img("m1")]);
  const revoked = await publicHelpArticle({ ...envelope, media: [{ id: "m1", url: null }] });
  assert.equal(revoked.mediaUrls.m1, null);
  assert.equal(await publicHelpArticle({ ...envelope, state: "withdrawn", payload: null, media: [] }), null);
  assert.throws(() => parsePublicContentResource({ ...envelope, version: { ...envelope.version, sequence: -1 } }));
  assert.throws(() => parsePublicContentResource({ ...envelope, version: "v1" }));
});

test("plate anchors and aliases project for reading and search", async () => {
  const payload = { kind: "guide", ...META, format: "plate", schemaVersion: 1, document: doc([h2("old-section", "原章节"), p("历史原格式独有文本")]), mediaIds: [], anchorAliases: { legacy: "content-old-section" } };
  const article = await publicHelpArticle({ schema: "content-resource.v1", key: `guide:${payload.slug}`, source: "MANAGED", state: "available", payload, media: [], version: { id: "old-v1", sequence: 1, publishedAt: null } });
  assert.equal(article.format, "plate");
  assert.equal(articleToc(article)[0].id, "content-old-section");
  assert.equal(searchHelpArticles("历史原格式独有文本", [article]).length, 1);
});

test("displayed update date uses the publication date in Beijing without changing frozen payload metadata", async () => {
  const resource = published(3, [h2("new", "新版"), p("发布说明。"), img("m1")]);
  resource.version.publishedAt = "2026-10-28T17:30:00Z";
  const originalDate = resource.payload.updatedAt;
  const article = await publicHelpArticle(resource);
  assert.equal(article.updatedAt, "2026-10-29");
  assert.equal(resource.payload.updatedAt, originalDate);
  const builtin = await publicHelpArticle({ ...resource, source: "BUILTIN", version: null });
  assert.equal(builtin.updatedAt, originalDate);
});