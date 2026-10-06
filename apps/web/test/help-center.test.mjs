import { test } from "node:test";
import assert from "node:assert/strict";
import { allHelpArticles, getHelpArticle, listFeaturedArticles, listHelpArticlesByCategory, resolveRelated } from "../src/content/help/index.ts";
import { searchHelpArticles } from "../src/content/help/search.ts";
import { legacyHelpHashMap, legacySiteUrlMap, resolveLegacyHash } from "../src/content/help/legacy-links.ts";
import { helpAuxCategories, helpCategories } from "../src/content/help/types.ts";
import { buildHelpNavData, toArticleCard } from "../src/components/help/nav-data.ts";
import { stripHelpSearchQuery } from "../src/components/help/help-url.ts";

test("slugs are unique and every article has required metadata", () => {
  const slugs = new Set(allHelpArticles.map((a) => a.slug));
  assert.equal(slugs.size, allHelpArticles.length);
  const categories = new Set([...helpCategories, ...helpAuxCategories].map((c) => c.id));
  for (const article of allHelpArticles) {
    assert.ok(article.id && article.title && article.summary, article.slug);
    assert.ok(categories.has(article.category), `${article.slug} category`);
    assert.ok(article.audience.length > 0, article.slug);
    assert.match(article.updatedAt, /^\d{4}-\d{2}-\d{2}$/, article.slug);
    assert.ok(article.sections.length > 0, article.slug);
    const sectionIds = new Set(article.sections.map((s) => s.id));
    assert.equal(sectionIds.size, article.sections.length, `${article.slug} section anchor uniqueness`);
    for (const section of article.sections) assert.ok(section.blocks.length > 0, `${article.slug}#${section.id}`);
  }
});

test("related and featured references resolve to real articles", () => {
  for (const article of allHelpArticles) {
    const related = resolveRelated(article);
    assert.equal(related.length, article.related.length, `${article.slug} related must all resolve`);
    assert.ok(!article.related.includes(article.slug), `${article.slug} must not relate to itself`);
  }
  assert.ok(listFeaturedArticles().length > 0);
  for (const category of [...helpCategories, ...helpAuxCategories]) {
    assert.ok(listHelpArticlesByCategory(category.id).length > 0, `category ${category.id} must not be empty`);
  }
});

test("nav data groups every article exactly once", () => {
  const nav = buildHelpNavData(allHelpArticles);
  const grouped = [...nav.categories, ...nav.aux].flatMap((c) => c.articles.map((a) => a.slug));
  assert.equal(grouped.length, allHelpArticles.length);
  assert.equal(new Set(grouped).size, allHelpArticles.length);
  for (const group of [...nav.categories, ...nav.aux]) assert.ok(group.articles.length > 0, group.id);
});

test("legacy /help anchors map to real articles", () => {
  assert.deepEqual(Object.keys(legacyHelpHashMap).sort(), ["billing-guide", "protection", "publish-guide", "rental-guide"]);
  for (const slug of Object.values(legacyHelpHashMap)) assert.ok(getHelpArticle(slug), slug);
  assert.equal(resolveLegacyHash("#rental-guide"), "rental-getting-started");
  assert.equal(resolveLegacyHash("billing-guide"), "fees-overview");
  assert.equal(resolveLegacyHash("#unknown"), null);
});

test("legacy site url map targets real articles", () => {
  assert.equal(legacySiteUrlMap.length, 7);
  for (const entry of legacySiteUrlMap) assert.ok(getHelpArticle(entry.slug), `${entry.source} -> ${entry.slug}`);
});

test("search: refund and withdrawal stay distinct", () => {
  const refund = searchHelpArticles("退款");
  assert.equal(refund[0]?.article.slug, "fees-refund-status");
  const refundSlugs = refund.map((h) => h.article.slug);
  assert.ok(refundSlugs.indexOf("fees-refund-status") < refundSlugs.indexOf("withdraw-status") || !refundSlugs.includes("withdraw-status"));
  const withdraw = searchHelpArticles("提现");
  assert.equal(withdraw[0]?.article.slug, "withdraw-status");
});

test("search: common aliases hit the right scope", () => {
  assert.ok(searchHelpArticles("哈弗").some((h) => h.article.slug === "fees-early-end"));
  assert.equal(searchHelpArticles("上架")[0]?.article.slug, "publish-prepare");
  assert.equal(searchHelpArticles("防骗")[0]?.article.slug, "anti-fraud-guide");
  assert.ok(searchHelpArticles("人脸").some((h) => h.article.slug === "account-realname-vs-face"));
});

test("search: empty and unknown queries return nothing", () => {
  assert.deepEqual(searchHelpArticles(""), []);
  assert.deepEqual(searchHelpArticles("   "), []);
  assert.deepEqual(searchHelpArticles("完全不存在的词xyz123"), []);
});

test("clearing search strips q but keeps other view params", () => {
  assert.equal(stripHelpSearchQuery("/help?q=%E6%8A%BC%E9%87%91"), "/help");
  assert.equal(stripHelpSearchQuery("/help?q=x&category=fees"), "/help?category=fees");
  assert.equal(stripHelpSearchQuery("/help?category=fees&q=x"), "/help?category=fees");
  assert.equal(stripHelpSearchQuery("/help"), null);
  assert.equal(stripHelpSearchQuery("/help/fees-early-end"), null);
});

test("article cards keep public fields only", () => {
  for (const article of allHelpArticles) {
    const card = toArticleCard(article);
    assert.deepEqual(Object.keys(card).sort(), ["audience", "category", "game", "slug", "summary", "title"]);
    if (!article.game) assert.equal(card.game, undefined);
  }
});
