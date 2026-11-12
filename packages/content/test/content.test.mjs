import { projectLegacyResource, projectLegacyUpdate } from "../legacy-plate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RESOURCES, NOTICE_PLACEMENT_KEYS, validateResource, validateResourceKey, validateResourceMedia, safeContentLink, resourceMediaIds, resourceText } from "../index.cjs";

const defaultsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../defaults");
const readHelp = slug => JSON.parse(fs.readFileSync(path.join(defaultsDir, "help", `${slug}.json`), "utf8"));
const guidePayload = entry => ({ kind: "guide", ...entry.meta, format: "plate", schemaVersion: 1, document: entry.document, ...(entry.anchorAliases ? { anchorAliases: entry.anchorAliases } : {}) });
const SAMPLE = readHelp("fees-overview");

test("footer configuration validates links, filing identifiers and QR references", () => {
  const key = "placement:FOOTER", base = DEFAULT_RESOURCES[key];
  const configured = { ...base, help: [{ label: "账号", href: "/accounts" }, { label: "外部", href: "https://example.test/path" }], socials: [{ label: "渠道", href: null, qrMediaId: "qr_1" }] };
  assert.deepEqual(resourceMediaIds(validateResource(key, configured)), ["qr_1"]);
  validateResourceMedia(configured, [{ id: "qr_1", width: 512, height: 512 }]);
  assert.throws(() => validateResourceMedia(configured, [{ id: "qr_1", width: 512, height: 256 }]), /图片/);
  for (const href of ["javascript:alert(1)", "//evil.test", "%2Fhelp", "/%2f%2fevil.test", "/%2e%2e/secret", "https://user:pass@example.test", "http://example.test", "https:example.test", "https:///example.test", "https://example.test/%0aevil", "https:\\evil.test"]) {
    assert.throws(() => validateResource(key, { ...base, licenseUrl: href }), href);
  }
  assert.throws(() => validateResource(key, { ...base, policeCode: "123" }), /公安备案/);
  assert.throws(() => validateResource(key, { ...base, icp: "随意备案" }), /ICP备案/);
  assert.throws(() => validateResource(key, { ...base, socials: [{ label: "空渠道", href: null, qrMediaId: null }] }), /链接或二维码/);
  assert.throws(() => validateResource(key, { ...base, help: [{ label: "动态", href: "/updates" }] }), /固定入口/);
  assert.equal(validateResource(key, { ...base, licenseUrl: "https://Example.test" }).licenseUrl, "https://example.test/");
  assert.deepEqual(validateResource(key, { ...base, help: [], support: [], socials: [], icp: "", policeRegion: "", policeCode: "", complaint: false }).help, []);
});

test("guide / notice accept only plate; sections and markdown are rejected", () => {
  const payload = guidePayload(SAMPLE);
  const validated = validateResource(`guide:${SAMPLE.meta.slug}`, payload);
  assert.equal(validated.format, "plate");
  assert.equal(validated.document.preset, "help");
  assert.ok(resourceText(validated).length > 0);
  assert.deepEqual(validated.mediaIds, []);
  const forged = { ...payload, mediaIds: ["forged"] };
  assert.deepEqual(validateResource(`guide:${SAMPLE.meta.slug}`, forged).mediaIds, []);
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, { ...payload, sections: [] }), /plate/);
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, { ...payload, markdown: "# x" }), /plate/);
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, { ...payload, format: "markdown" }), /plate/);
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, { ...payload, format: "blocks" }), /plate/);
  const notice = JSON.parse(fs.readFileSync(path.join(defaultsDir, "notices", "PUBLISH_SAFE_BOX.json"), "utf8"));
  const noticePayload = { kind: "notice", title: notice.meta.title, format: "plate", schemaVersion: 1, document: notice.document };
  assert.equal(validateResource("placement:PUBLISH_SAFE_BOX", noticePayload).format, "plate");
  assert.throws(() => validateResource("placement:PUBLISH_SAFE_BOX", { ...noticePayload, sections: notice.meta.sections }), /plate/);
});

test("plate body whitelist is enforced through the resource contract", () => {
  const payload = guidePayload(SAMPLE);
  const bad = structuredClone(payload);
  bad.document.value.push({ type: "script", children: [{ text: "x" }] });
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, bad), /校验/);
  const link = structuredClone(payload);
  link.document.value.push({ type: "p", children: [{ type: "a", url: "javascript:alert(1)", children: [{ text: "x" }] }] });
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, link), /校验/);
});

test("notice placements keep their keys without runtime code defaults", () => {
  assert.equal(NOTICE_PLACEMENT_KEYS.length, 6);
  for (const key of NOTICE_PLACEMENT_KEYS) {
    assert.equal(DEFAULT_RESOURCES[`placement:${key}`], undefined);
    assert.doesNotThrow(() => validateResourceKey(`placement:${key}`));
  }
  assert.equal(DEFAULT_RESOURCES[`guide:${SAMPLE.meta.slug}`], undefined);
  assert.doesNotThrow(() => validateResourceKey(`guide:${SAMPLE.meta.slug}`));
});

test("unknown or mismatched resources cannot silently become published content", () => {
  assert.throws(() => validateResourceKey("placement:UNKNOWN"), /尚未接入/);
  assert.throws(() => validateResourceKey("guide:../secret"));
  assert.throws(() => validateResourceKey("guide:updates"), /保留/);
  assert.throws(() => validateResource("placement:FOLLOW", guidePayload(SAMPLE)), /类型/);
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, { ...guidePayload(SAMPLE), storageKey: "private" }), /字段/);
});

test("safe links reject script, protocol-relative, encoded traversal and control characters", () => {
  for (const href of ["javascript:alert(1)", "//evil.test", "/%2fexample.test", "/help/%2e%2e/account", "/help\\secret", "/help\nsecret", "https://example.test", "/unimplemented"]) assert.throws(() => safeContentLink(href), href);
  assert.equal(safeContentLink("/help/fees-overview#answer"), "/help/fees-overview#answer");
});

test("guide metadata must be internally consistent", () => {
  const guide = guidePayload(SAMPLE);
  guide.updatedAt = "2026-02-30";
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, guide), /日期/);
  const dup = guidePayload(SAMPLE);
  dup.related = [dup.slug];
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, dup), /相关文章/);
});

test("empty media falls back to code while actual references are collected once", () => {
  const contact = { ...DEFAULT_RESOURCES["placement:FOLLOW"], enabled: true };
  assert.deepEqual(resourceMediaIds(validateResource("placement:FOLLOW", contact)), []);
  contact.qrMediaId = "asset_1";
  assert.deepEqual(resourceMediaIds(validateResource("placement:FOLLOW", contact)), ["asset_1"]);
  const guide = guidePayload(SAMPLE);
  guide.document.value.push({ type: "img", mediaId: "asset_1", alt: "操作图示", children: [{ text: "" }] }, { type: "img", mediaId: "asset_1", alt: "同一图片", children: [{ text: "" }] });
  assert.deepEqual(resourceMediaIds(validateResource(`guide:${SAMPLE.meta.slug}`, guide)), ["asset_1"]);
});

test("large text is bounded in UTF-8 and unsupported output fields are rejected", () => {
  const guide = guidePayload(SAMPLE);
  guide.document.value = Array.from({ length: 30 }, () => ({ type: "p", children: [{ text: "汉".repeat(7000) }] }));
  assert.throws(() => validateResource(`guide:${SAMPLE.meta.slug}`, guide), /字节|校验/);
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
  assert.doesNotThrow(() => validateResourceMedia(guidePayload(SAMPLE), []));
});

test("carousel dates reject impossible calendar dates and preserve UTC time windows", () => {
  const resource = { kind: "carousel", title: "首页", slides: [{ id: "s1", mediaId: "m1", mobileMediaId: null, imageAlt: "图", mobileImageAlt: "", title: "标题", description: "", linkUrl: null, enabled: true, sortOrder: 0, startsAt: "2026-02-30T10:00:00+08:00", endsAt: null }] };
  assert.throws(() => validateResource("placement:HOME_HERO", resource), /时间/);
  resource.slides[0].startsAt = "2026-10-28T10:00:00+08:00";
  assert.equal(validateResource("placement:HOME_HERO", resource).slides[0].startsAt, "2026-10-28T02:00:00.000Z");
});
test("legacy Markdown and blocks are projected from stored snapshots without weakening write validation", () => {
  const markdown = { kind: "guide", title: "旧帮助", format: "markdown",
    markdown: "## 服务范围\n\n**重点** [目录](/help) [锚点](#content-服务范围) [外链](https://example.invalid) [禁用](javascript:alert)\n\n![图](media://asset_a)\n\n| a | b |\n| - | - |\n| c | d |" };
  const before = structuredClone(markdown);
  const help = projectLegacyResource(markdown);
  assert.deepEqual(markdown, before);
  assert.equal(help.document.value[0].id, "服务范围");
  assert.deepEqual(help.mediaIds, ["asset_a"]);
  assert.ok(help.document.value.some(node => node.type === "table"));
  const links = help.document.value.flatMap(node => node.children ?? []).filter(node => node.type === "a").map(node => node.url);
  assert.deepEqual(links, ["/help", "#content-服务范围", "https://example.invalid"]);
  const blocks = projectLegacyResource({ kind: "guide", sections: [{ id: "scope", title: "服务范围", blocks: [{ type: "list", ordered: true, items: ["甲", "乙"] }] }] });
  assert.equal(blocks.anchorAliases.scope, "content-服务范围");
  assert.equal(blocks.document.value[2].listStart, 2);
  const plain = projectLegacyUpdate("*原样*\n<script>文字</script>", "plain");
  assert.deepEqual(plain.value.map(node => node.children[0].text), ["*原样*", "<script>文字</script>"]);
});
