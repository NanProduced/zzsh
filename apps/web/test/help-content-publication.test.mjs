import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GUIDES } from "@zzsh/content";
import { publicHelpArticle } from "../src/lib/help-content.ts";
import { parsePublicContentResource } from "../src/lib/content-public.ts";
import { searchHelpArticles } from "../src/content/help/search.ts";
import { articleToc } from "../src/components/help/nav-data.ts";

function published(version, markdown, mediaId = "m1") {
  const guide = { ...DEFAULT_GUIDES[0], title: `版本${version}标题`, summary: `版本${version}摘要`, format: "markdown", schemaVersion: 1, markdown, mediaIds: [mediaId] };
  delete guide.sections;
  delete guide.anchorAliases;
  return parsePublicContentResource({ schema: "content-resource.v1", key: `guide:${guide.slug}`, source: "MANAGED", state: "available", payload: guide,
    version: { id: `v${version}`, sequence: version, publishedAt: "2026-10-28T00:00:00Z" }, media: [{ id: mediaId, url: `/api/v1/content/media/${mediaId}/content` }] });
}

test("one publication snapshot supplies the title, Markdown, TOC, search text and authorized media", async () => {
  const first = await publicHelpArticle(published(1, "## 旧说明\n\n旧版独有词。\n\n![插图](media://m1)"));
  const second = await publicHelpArticle(published(2, "## 新说明\n\n新版独有词。\n\n![插图](media://m2)", "m2"));
  assert.equal(second.version.id, "v2"); assert.equal(second.title, "版本2标题");
  assert.match(second.markdown, /新版独有词/); assert.equal(articleToc(second)[0].title, "新说明");
  assert.equal(second.mediaUrls.m2, "/api/content/media/m2/content"); assert.equal(second.mediaUrls.m1, undefined);
  assert.equal(searchHelpArticles("新版独有词", [second]).length, 1);
  assert.equal(searchHelpArticles("旧版独有词", [second]).length, 0);
  assert.equal(first.version.id, "v1"); assert.match(first.markdown, /旧版独有词/);
});

test("withdrawal and current media revocation cannot revive builtin content or a formerly public URL", async () => {
  const envelope = published(1, "## 说明\n\n![插图](media://m1)");
  const revoked = await publicHelpArticle({ ...envelope, media: [{ id: "m1", url: null }] });
  assert.equal(revoked.mediaUrls.m1, null);
  assert.equal(await publicHelpArticle({ ...envelope, state: "withdrawn", payload: null, media: [] }), null);
  assert.throws(() => parsePublicContentResource({ ...envelope, version: { ...envelope.version, sequence: -1 } }));
  assert.throws(() => parsePublicContentResource({ ...envelope, version: "v1" }));
});

test("legacy blocks retain their format and anchors when projected for reading and search", async () => {
  const payload = { ...DEFAULT_GUIDES[0], format: "blocks", sections: [{ id: "old-section", title: "原章节", blocks: [{ type: "paragraph", text: "历史原格式独有文本" }] }] };
  delete payload.markdown; delete payload.mediaIds; delete payload.anchorAliases;
  const article = await publicHelpArticle({ schema: "content-resource.v1", key: `guide:${payload.slug}`, source: "MANAGED", state: "available", payload, media: [], version: { id: "old-v1", sequence: 1, publishedAt: null } });
  assert.equal(article.format, "blocks"); assert.equal(article.markdown, undefined);
  assert.equal(articleToc(article)[0].id, "old-section");
  assert.equal(searchHelpArticles("历史原格式独有文本", [article]).length, 1);
});

test("displayed update date uses the publication date in Beijing without changing frozen payload metadata", async () => {
  const resource = published(3, "## 新版\n\n发布说明。\n\n![插图](media://m1)");
  resource.version.publishedAt = "2026-10-28T17:30:00Z";
  const originalDate = resource.payload.updatedAt;
  const article = await publicHelpArticle(resource);
  assert.equal(article.updatedAt, "2026-10-29");
  assert.equal(resource.payload.updatedAt, originalDate);
  const builtin = await publicHelpArticle({ ...resource, source: "BUILTIN", version: null });
  assert.equal(builtin.updatedAt, originalDate);
});
