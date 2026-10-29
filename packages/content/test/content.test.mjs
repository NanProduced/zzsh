import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_GUIDES as REGISTERED_GUIDES, DEFAULT_RESOURCES, validateResource, validateResourceKey, validateResourceMedia, safeContentLink, resourceMediaIds, resourceText } from "../index.cjs";
const DEFAULT_GUIDES = JSON.parse(fs.readFileSync(new URL("./fixtures/legacy-guides.json", import.meta.url), "utf8")).map(guide => ({kind: "guide", ...guide}));

test("all existing guides and registered placements preserve their content and identifiers", () => {
  assert.equal(DEFAULT_GUIDES.length, 24);
  assert.equal(REGISTERED_GUIDES.length, 24);
  assert.ok(REGISTERED_GUIDES.every(guide => guide.format === "markdown"));
  const slugs = new Set(DEFAULT_GUIDES.map(article => article.slug));
  assert.equal(slugs.size, 24);
  for (const [key, value] of Object.entries(DEFAULT_RESOURCES)) {
    const before = JSON.stringify(value);
    const normalized = validateResource(key, value);
    assert.equal(JSON.stringify(value), before);
    assert.ok(resourceText(normalized).length > 0);
    if (normalized.kind === "guide") for (const related of normalized.related) assert.ok(slugs.has(related), related);
  }
});

test("unknown or mismatched resources and blocks cannot silently become published content", () => {
  assert.throws(() => validateResourceKey("placement:UNKNOWN"), /尚未接入/);
  assert.throws(() => validateResourceKey("guide:../secret"));
  assert.throws(() => validateResourceKey("guide:updates"), /保留/);
  assert.throws(() => validateResource("placement:FOLLOW", DEFAULT_GUIDES[0]), /类型/);
  const guide = structuredClone(DEFAULT_GUIDES[0]);
  guide.sections[0].blocks = [{ type: "html", text: "<script>run()</script>" }];
  assert.throws(() => validateResource(`guide:${guide.slug}`, guide), /不支持/);
  guide.sections[0].blocks = [{ type: "paragraph", text: "safe", style: "position:fixed" }];
  assert.throws(() => validateResource(`guide:${guide.slug}`, guide), /字段/);
});

test("safe links reject script, protocol-relative, encoded traversal and control characters", () => {
  for (const href of ["javascript:alert(1)", "//evil.test", "/%2fexample.test", "/help/%2e%2e/account", "/help\\secret", "/help\nsecret", "https://example.test", "/unimplemented"]) assert.throws(() => safeContentLink(href), href);
  assert.equal(safeContentLink("/help/fees-overview#answer"), "/help/fees-overview#answer");
});

test("chapters, tables and metadata must be internally consistent", () => {
  const guide = structuredClone(DEFAULT_GUIDES[0]);
  guide.sections[1].id = guide.sections[0].id;
  assert.throws(() => validateResource(`guide:${guide.slug}`, guide), /锚点/);
  guide.sections.pop(); guide.sections = [{ id: "answer", title: "费用", blocks: [{ type: "table", columns: ["A", "B"], rows: [["1"]] }] }];
  assert.throws(() => validateResource(`guide:${guide.slug}`, guide), /列数/);
  guide.sections[0].blocks[0].rows = [["", "1"]];
  assert.ok(validateResource(`guide:${guide.slug}`, guide));
  guide.updatedAt = "2026-02-30";
  assert.throws(() => validateResource(`guide:${guide.slug}`, guide), /日期/);
});

test("empty media falls back to code while actual references are collected once", () => {
  const contact = { ...DEFAULT_RESOURCES["placement:FOLLOW"], enabled: true };
  assert.deepEqual(resourceMediaIds(validateResource("placement:FOLLOW", contact)), []);
  contact.qrMediaId = "asset_1";
  assert.deepEqual(resourceMediaIds(validateResource("placement:FOLLOW", contact)), ["asset_1"]);
  const guide = structuredClone(DEFAULT_GUIDES[0]);
  guide.sections[0].blocks.push({ type: "image", mediaId: "asset_1", alt: "操作图示" }, { type: "image", mediaId: "asset_1", alt: "同一图片" });
  assert.deepEqual(resourceMediaIds(validateResource(`guide:${guide.slug}`, guide)), ["asset_1"]);
});

test("large text is bounded in UTF-8 and unsupported output fields are rejected", () => {
  const guide = structuredClone(DEFAULT_GUIDES[0]);
  guide.sections[0].blocks = Array.from({ length: 10 }, () => ({ type: "paragraph", text: "汉".repeat(10000) }));
  assert.throws(() => validateResource(`guide:${guide.slug}`, guide), /字节/);
  assert.throws(() => validateResource("placement:FOLLOW", { ...DEFAULT_RESOURCES["placement:FOLLOW"], storageKey: "private" }), /字段/);
});

test("slot dimensions are checked at binding without imposing a QR rule on article illustrations", () => {
  const contact = { ...DEFAULT_RESOURCES["placement:FOLLOW"], qrMediaId: "asset_qr" };
  assert.throws(() => validateResourceMedia(contact, [{ id: "asset_qr", width: 800, height: 450 }]), /1:1/);
  assert.throws(() => validateResourceMedia(contact, [{ id: "asset_qr", width: 128, height: 128 }]), /256/);
  assert.doesNotThrow(() => validateResourceMedia(contact, [{ id: "asset_qr", width: 512, height: 512 }]));
  const banner = { ...DEFAULT_RESOURCES["placement:MARKET_DELTA_BANNER"], mediaId: "asset_b" };
  assert.throws(() => validateResourceMedia(banner, [{ id: "asset_b", width: 1620, height: 800 }]), /3:1/);
  assert.doesNotThrow(() => validateResourceMedia(banner, [{ id: "asset_b", width: 1620, height: 540 }]));
  assert.doesNotThrow(() => validateResourceMedia(DEFAULT_GUIDES[0], []));
});

test("carousel dates reject impossible calendar dates and preserve UTC time windows", () => {
  const resource = { kind: "carousel", title: "首页", slides: [{ id: "s1", mediaId: "m1", mobileMediaId: null, imageAlt: "图", mobileImageAlt: "", title: "标题", description: "", linkUrl: null, enabled: true, sortOrder: 0, startsAt: "2026-02-30T10:00:00+08:00", endsAt: null }] };
  assert.throws(() => validateResource("placement:HOME_HERO", resource), /时间/);
  resource.slides[0].startsAt = "2026-10-28T10:00:00+08:00";
  assert.equal(validateResource("placement:HOME_HERO", resource).slides[0].startsAt, "2026-10-28T02:00:00.000Z");
});
