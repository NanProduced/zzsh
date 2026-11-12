import test from "node:test";
import assert from "node:assert/strict";
import { PRESETS, validatePlateDocument, extractPlate, plateDigest, canonicalize, toPlateEnvelope } from "../plate-schema.mjs";

const env = (preset, value) => ({ format: "plate", schemaVersion: 1, preset, value });
const p = (text, marks = {}, extra = {}) => ({ type: "p", ...extra, children: [{ text, ...marks }] });
const ok = (doc, preset, mode) => {
  const r = validatePlateDocument(doc, { preset, mode });
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.equal(r.ok, true);
};
const bad = (doc, preset, code, path, mode) => {
  const r = validatePlateDocument(doc, { preset, mode });
  assert.equal(r.ok, false);
  const hit = r.errors.find((e) => e.code === code && (path === undefined || e.path === path));
  assert.ok(hit, `expected ${code} at ${path}, got ${JSON.stringify(r.errors)}`);
};

const SAMPLES = {
  help: [
    { type: "h2", id: "a1", children: [{ text: "标题" }] },
    p("正文", { bold: true, underline: true, code: true }),
    { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "项" }] },
    { type: "p", listStyleType: "decimal", indent: 1, listStart: 2, children: [{ text: "二" }] },
    { type: "callout", variant: "warning", children: [p("提示")] },
    { type: "toggle", children: [p("折叠")] },
    { type: "code_block", children: [{ type: "code_line", children: [{ text: "x=1" }] }] },
    { type: "table", children: [{ type: "tr", children: [{ type: "th", children: [p("列")] }, { type: "td", children: [p("值")] }] }] },
    { type: "img", mediaId: "media_1", alt: "图" , children: [{ text: "" }] },
    { type: "blockquote", children: [p("引")] },
    { type: "hr", children: [{ text: "" }] },
    { type: "p", children: [{ type: "a", url: "https://example.com", children: [{ text: "外" }] }, { type: "a", url: "/help/x", children: [{ text: "内" }] }] },
  ],
  update: [p("公告"), { type: "img", mediaId: "media_2", alt: "" , children: [{ text: "" }] }, { type: "h3", id: "u1", children: [{ text: "小标" }] }],
  notice: [p("场景说明"), { type: "callout", variant: "info", children: [p("注意")] }],
  legal: [
    { type: "h2", id: "l1", children: [{ text: "一、总则" }] },
    p("重点", { color: "red", backgroundColor: "red" }),
    { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "条" }] },
    { type: "table", children: [{ type: "tr", children: [{ type: "td", children: [p("甲")] }] }] },
  ],
  internal: [
    p("内部", { comment: true, comment_dsc_1: true, color: "blue", backgroundColor: "gray" }),
    { type: "p", listStyleType: "todo", indent: 1, checked: false, children: [{ text: "待办" }] },
    { type: "img", imageId: "dimg_1", alt: "私图" , children: [{ text: "" }] },
    { type: "toc", children: [{ text: "" }] },
    { type: "h4", id: "i1", children: [{ text: "四级" }] },
    { type: "p", children: [{ type: "a", url: "doc:doc_1", children: [{ text: "文档" }] }] },
  ],
};

test("every preset accepts its legal sample in draft and publish", () => {
  for (const preset of PRESETS) {
    ok(env(preset, SAMPLES[preset]), preset, "draft");
    ok(env(preset, SAMPLES[preset]), preset, "publish");
  }
});

test("notice rejects table, h2 and hr", () => {
  bad(env("notice", [{ type: "table", children: [] }]), "notice", "UNKNOWN_NODE", "$.value[0]");
  bad(env("notice", [{ type: "h2", id: "n", children: [{ text: "x" }] }]), "notice", "UNKNOWN_NODE", "$.value[0]");
  bad(env("notice", [{ type: "hr", children: [{ text: "" }] }]), "notice", "UNKNOWN_NODE", "$.value[0]");
});

test("UNKNOWN_NODE for foreign node and bad leaf", () => {
  bad(env("help", [{ type: "video" }]), "help", "UNKNOWN_NODE", "$.value[0]");
  bad(env("help", [{ type: "p", children: [{ type: "h2", children: [] }] }]), "help", "UNKNOWN_NODE", "$.value[0].children[0]");
  bad(env("help", [{ type: "code_block", children: [p("x")] }]), "help", "UNKNOWN_NODE", "$.value[0].children[0]");
});

test("MARK_NOT_ALLOWED for comment outside internal, foreign mark, bad color token", () => {
  bad(env("help", [p("x", { comment_dsc_1: true })]), "help", "MARK_NOT_ALLOWED", "$.value[0].children[0].comment_dsc_1");
  bad(env("update", [p("x", { underline: true })]), "update", "MARK_NOT_ALLOWED", "$.value[0].children[0].underline");
  bad(env("internal", [p("x", { color: "#ff0000" })]), "internal", "MARK_NOT_ALLOWED", "$.value[0].children[0].color");
  bad(env("legal", [p("x", { color: "blue" })]), "legal", "MARK_NOT_ALLOWED", "$.value[0].children[0].color");
  bad(env("help", [p("x", { bold: "yes" })]), "help", "MARK_NOT_ALLOWED", "$.value[0].children[0].bold");
});

test("ATTR_NOT_ALLOWED for style/class/align and misplaced attrs", () => {
  bad(env("help", [{ type: "p", style: "color:red", children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].style");
  bad(env("help", [{ type: "p", align: "center", children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].align");
  bad(env("help", [{ type: "p", listStyleType: "disc", indent: 0, children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].indent");
  bad(env("help", [{ type: "p", listStyleType: "disc", indent: 4, children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].indent");
  bad(env("help", [{ type: "p", listStyleType: "disc", listStart: 2, children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].listStart");
  bad(env("help", [{ type: "p", listStyleType: "disc", checked: true, children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].checked");
  bad(env("help", [{ type: "p", variant: "info", children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].variant");
  bad(env("help", [{ type: "p", listStyleType: "todo", indent: 1, checked: true, children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].listStyleType");
  bad(env("legal", [{ type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "1. x" }] }]), "legal", "ATTR_NOT_ALLOWED", "$.value[0].listStyleType");
  bad(env("help", [{ type: "img", mediaId: "m", url: "https://x/y.png" , children: [{ text: "" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].url");
  bad(env("help", [{ type: "p", indent: 1.5, children: [{ text: "x" }] }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].indent");
});

test("LINK_PROTOCOL rejects javascript, data, protocol-relative; internal doc: only internal", () => {
  const a = (url) => ({ type: "p", children: [{ type: "a", url, children: [{ text: "x" }] }] });
  bad(env("help", [a("javascript:alert(1)")]), "help", "LINK_PROTOCOL", "$.value[0].children[0].url");
  bad(env("help", [a("data:text/html,x")]), "help", "LINK_PROTOCOL", "$.value[0].children[0].url");
  bad(env("help", [a("//evil.example")]), "help", "LINK_PROTOCOL", "$.value[0].children[0].url");
  bad(env("help", [a("http://example.com")]), "help", "LINK_PROTOCOL", "$.value[0].children[0].url");
  bad(env("help", [a("doc:doc_1")]), "help", "LINK_PROTOCOL", "$.value[0].children[0].url");
  ok(env("internal", [a("doc:doc_1")]), "internal");
});

test("MEDIA_NOT_ALLOWED for wrong id kind and over 300 images", () => {
  bad(env("internal", [{ type: "img", mediaId: "m" , children: [{ text: "" }] }]), "internal", "MEDIA_NOT_ALLOWED", "$.value[0].mediaId");
  bad(env("help", [{ type: "img", imageId: "dimg_1" , children: [{ text: "" }] }]), "help", "MEDIA_NOT_ALLOWED", "$.value[0].imageId");
  bad(env("notice", [{ type: "img", mediaId: "m" , children: [{ text: "" }] }]), "notice", "UNKNOWN_NODE", "$.value[0]");
  const many = Array.from({ length: 301 }, (_, i) => ({ type: "img", mediaId: `m${i}`, children: [{ text: "" }] }));
  bad(env("update", many), "update", "MEDIA_NOT_ALLOWED", "$.value[300]");
  ok(env("update", many.slice(0, 300)), "update");
});

test("DEPTH_EXCEEDED at nesting 9", () => {
  let node = p("x");
  for (let i = 0; i < 8; i++) node = { type: "blockquote", children: [node] };
  bad(env("help", [node]), "help", "DEPTH_EXCEEDED");
  let shallow = p("x");
  for (let i = 0; i < 7; i++) shallow = { type: "blockquote", children: [shallow] };
  ok(env("help", [shallow]), "help");
});

test("TOO_LARGE for envelope bytes and table shape", () => {
  const big = env("help", [p("x".repeat(200001))]);
  bad(big, "help", "TOO_LARGE", "$");
  const cols = (n) => ({ type: "table", children: [{ type: "tr", children: Array.from({ length: n }, () => ({ type: "td", children: [p("c")] })) }] });
  bad(env("help", [cols(13)]), "help", "TOO_LARGE", "$.value[0].children[0]");
  ok(env("help", [cols(12)]), "help");
  const rows = (n) => ({ type: "table", children: Array.from({ length: n }, () => ({ type: "tr", children: [{ type: "td", children: [p("c")] }] })) });
  bad(env("help", [rows(101)]), "help", "TOO_LARGE", "$.value[0]");
  ok(env("help", [rows(100)]), "help");
});

test("TEXT_TOO_LONG for notice chars and legal/update projection bytes", () => {
  bad(env("notice", [p("字".repeat(1201))]), "notice", "TEXT_TOO_LONG", "$");
  ok(env("notice", [p("字".repeat(1200))]), "notice");
  bad(env("legal", [p("法".repeat(6667))]), "legal", "TEXT_TOO_LONG", "$");
  bad(env("update", [p("u".repeat(20001))]), "update", "TEXT_TOO_LONG", "$");
});

test("PLACEHOLDER_FOUND only in publish mode", () => {
  for (const text of ["【1】", "【待补】", "UNKNOWN", "待确认", "TODO", "TBD"]) {
    ok(env("help", [p(text)]), "help", "draft");
    bad(env("help", [p(text)]), "help", "PLACEHOLDER_FOUND", "$.value[0].children[0]", "publish");
  }
  ok(env("internal", [p("【草稿】")]), "internal", "publish");
});

test("extractPlate projects text, toc anchors, ids and links", () => {
  const doc = env("internal", SAMPLES.internal);
  const x = extractPlate(doc);
  assert.equal(x.plainText, "内部\n待办\n私图\n\n四级\n文档");
  assert.deepEqual(x.toc, []);
  assert.deepEqual(x.imageIds, ["dimg_1"]);
  assert.deepEqual(x.commentIds, ["dsc_1"]);
  assert.deepEqual(x.links, ["doc:doc_1"]);
  const h = extractPlate(env("help", SAMPLES.help));
  assert.deepEqual(h.toc, [{ id: "content-a1", text: "标题", level: 2 }]);
  assert.deepEqual(h.mediaIds, ["media_1"]);
  assert.ok(h.plainText.includes("x=1"));
  assert.ok(h.plainText.includes("列\t值"));
});

test("plateDigest is key-order invariant, content and preset sensitive", async () => {
  const a = env("help", [p("x", { bold: true, italic: true })]);
  const b = env("help", [{ type: "p", children: [{ italic: true, text: "x", bold: true }] }]);
  assert.equal(await plateDigest(a), await plateDigest(b));
  const c = env("help", [p("y")]);
  assert.notEqual(await plateDigest(a), await plateDigest(c));
  const d = env("update", [p("x", { bold: true, italic: true })]);
  assert.notEqual(await plateDigest(a), await plateDigest(d));
  assert.match(await plateDigest(a), /^[0-9a-f]{64}$/);
});

test("canonicalize matches supply implementation golden vectors", () => {
  const goldens = [
    [{ b: 1, a: "x" }, '{"a":"x","b":1}'],
    [{ a: [1, 2, { z: null, y: true }] }, '{"a":[1,2,{"y":true,"z":null}]}'],
    [{ n: 0, m: -3 }, '{"m":-3,"n":0}'],
    [{ s: 'a"b\\c' }, '{"s":"a\\"b\\\\c"}'],
    [{ u: undefined, v: 1 }, '{"v":1}'],
    [["x", { a: 1 }, [2]], '["x",{"a":1},[2]]'],
  ];
  for (const [input, expected] of goldens) assert.equal(canonicalize(input), expected);
  assert.equal(canonicalize({ k: "é".normalize("NFD") }), '{"k":"' + "é".normalize("NFD") + '"}');
  assert.equal(canonicalize({ ["é".normalize("NFD")]: 1 }), '{"' + "é" + '":1}');
  let deep = { v: 1 };
  for (const k of "utsrqponmlkjihgfedcba".split("")) deep = { [k]: deep };
  assert.equal(canonicalize({ deep }).length, JSON.stringify({ deep }).length);
  assert.throws(() => canonicalize({ x: 1.5 }), /safe integers/);
  assert.throws(() => canonicalize({ contentHash: "x" }), /contentHash/);
  let over = { v: 1 };
  for (let i = 0; i < 25; i++) over = { [i]: over };
  assert.throws(() => canonicalize(over), /too deep/);
});
test("toPlateEnvelope strips foreign nodes, marks, attrs and img urls into a valid envelope", () => {
  const dirty = [
    { type: "p", style: "x", children: [{ text: "keep", bold: true, underline: true, backgroundColor: "gray", color: "#fff", comment_dsc_1: true }] },
    { type: "video", children: [{ type: "p", children: [{ text: "unwrapped" }] }] },
    { type: "img", mediaId: "m1", url: "https://evil/x.png", alt: "a", caption: "说明", children: [{ text: "" }] },
    { type: "h2", children: [{ text: "no id" }] },
    { type: "p", listStyleType: "todo", indent: 9, checked: "yes", children: [{ text: "t" }] },
    { type: "p", children: [{ type: "a", url: "javascript:x", children: [{ text: "link text" }] }] },
  ];
  const envHelp = toPlateEnvelope(dirty, "help");
  ok(envHelp, "help", "publish");
  assert.equal(envHelp.value[0].children[0].backgroundColor, undefined);
  assert.equal(envHelp.value[0].children[0].color, undefined);
  assert.equal(envHelp.value[0].children[0].comment_dsc_1, undefined);
  assert.equal(envHelp.value[0].style, undefined);
  assert.equal(envHelp.value[1].type, "p");
  assert.equal(envHelp.value[2].url, undefined);
  assert.equal(envHelp.value[2].caption, "说明");
  bad(env("help", [{ ...envHelp.value[2], caption: "字".repeat(501) }]), "help", "ATTR_NOT_ALLOWED", "$.value[0].caption");
  assert.match(envHelp.value[3].id, /^[0-9a-f]{12}$/);
  assert.equal(envHelp.value[4].listStyleType, undefined);
  assert.equal(envHelp.value[5].children[0].type, undefined);
  const envInternal = toPlateEnvelope(dirty, "internal");
  ok(envInternal, "internal", "publish");
  assert.equal(envInternal.value[0].children[0].comment_dsc_1, true);
  assert.equal(envInternal.value[0].children[0].underline, true);
  assert.equal(envInternal.value[0].children[0].backgroundColor, "gray");
  assert.ok(envInternal.value.every((n) => n.type !== "img"));
  assert.equal(envInternal.value[3].listStyleType, "todo");
  assert.equal(envInternal.value[3].indent, 1);
  assert.equal(envInternal.value[3].checked, false);
  const round = toPlateEnvelope(envHelp.value, "help");
  assert.deepEqual(round, envHelp);
});
