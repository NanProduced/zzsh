import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createOfflineAdminSource } from "../../../apps/admin/test/offline-admin-source.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const entry = require.resolve("@zzsh/ui/plate-document");
const source = await createOfflineAdminSource({ root });
const { PlateDocument } = await source.ssrLoadModule("/" + path.relative(root, entry).replaceAll("\\", "/"));
after(() => source.close());

const env = (preset, value) => ({ format: "plate", schemaVersion: 1, preset, value });
const p = (text, marks = {}) => ({ type: "p", children: [{ text, ...marks }] });
const render = (doc, props = {}) => renderToStaticMarkup(React.createElement(PlateDocument, { document: doc, ...props }));

const FULL = env("internal", [
  { type: "h2", id: "t1", children: [{ text: "标题" }] },
  { type: "h3", id: "t2", children: [{ text: "小标" }] },
  p("粗斜删下码", { bold: true, italic: true, strikethrough: true, underline: true, code: true }),
  p("红", { color: "red", backgroundColor: "gray" }),
  p("评论", { comment_dsc_9: true }),
  { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "无序" }] },
  { type: "p", listStyleType: "decimal", indent: 1, listStart: 3, children: [{ text: "有序" }] },
  { type: "p", listStyleType: "todo", indent: 1, checked: true, children: [{ text: "待办" }] },
  { type: "blockquote", children: [p("引")] },
  { type: "hr", children: [{ text: "" }] },
  { type: "p", children: [{ type: "a", url: "https://example.com", children: [{ text: "外" }] }, { type: "a", url: "/help/x", children: [{ text: "内" }] }] },
  { type: "table", children: [{ type: "tr", children: [{ type: "th", children: [p("头")] }, { type: "td", children: [p(" cell ")] }] }] },
  { type: "img", imageId: "dimg_1", alt: "私图" , children: [{ text: "" }] },
  { type: "img", imageId: "dimg_missing", alt: "缺图" , children: [{ text: "" }] },
  { type: "code_block", children: [{ type: "code_line", children: [{ text: "x=1" }] }] },
  { type: "callout", variant: "warning", children: [p("警")] },
  { type: "toggle", children: [p("摘要"), p("隐藏 body")] },
  { type: "toc", children: [{ text: "" }] },
  { type: "video", children: [p("未知节点文字")] },
]);

test("renders every whitelisted node with stable structure", () => {
  const html = render(FULL, { imageUrls: { dimg_1: "/api/bff/admin/docs/images/dimg_1/content" } });
  for (const fragment of [
    '<h2 id="content-t1">标题</h2>',
    '<h3 id="content-t2">小标</h3>',
    "<strong>", "<em>", "<s>", "<u>", "<code>",
    'style="color:var(--plate-red);background-color:var(--plate-highlight-gray, var(--plate-gray))"',
    '<mark class="plate-comment">',
    "<ul>", "<ol>", '<li data-indent="1">', '<li data-indent="1" value="3">',
    '<li class="plate-todo" data-checked="true">',
    "<blockquote>", "<hr/>",
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">外</a>',
    '<a href="/help/x">内</a>',
    '<div class="plate-table-scroll" role="region" tabindex="0"',
    "<th>", "<td>",
    '<img src="/api/bff/admin/docs/images/dimg_1/content" alt="私图" loading="lazy"/>',
    '<span class="plate-image-missing">缺图</span>',
    "<pre>", "x=1",
    '<div class="plate-callout" data-variant="warning" role="note">',
    '<details class="plate-toggle"><summary>摘要</summary>',
    '<nav class="plate-toc"',
    '<a href="#content-t1">标题</a>',
    "<p>未知节点文字</p>",
  ]) assert.ok(html.includes(fragment), `missing ${fragment}\n${html}`);
  assert.ok(!html.includes("<video"));
  assert.ok(!html.includes("dangerouslySetInnerHTML"));
});

test("list grouping keeps consecutive items in one list and splits on type change", () => {
  const html = render(env("help", [
    { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "a" }] },
    { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "b" }] },
    { type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "c" }] },
    p("间隔"),
    { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "d" }] },
  ]));
  assert.equal((html.match(/<ul>/g) ?? []).length, 2);
  assert.equal((html.match(/<ol>/g) ?? []).length, 1);
  assert.ok(html.indexOf("<ul>") < html.indexOf("<ol>"));
});

test("anchorPrefix is honoured and missing urls never emit broken img", () => {
  const html = render(env("help", [{ type: "h2", id: "x", children: [{ text: "题" }] }, { type: "img", mediaId: "m1", alt: "图" , children: [{ text: "" }] }]), { anchorPrefix: "help-" });
  assert.ok(html.includes('<h2 id="help-x">'));
  assert.ok(html.includes('<a href="#help-x">'));
  assert.ok(html.includes('<span class="plate-image-missing">图</span>'));
  assert.ok(!html.includes("<img"));
});

test("server render is deterministic and hook-free across repeated calls", () => {
  const a = render(FULL);
  const b = render(FULL);
  assert.equal(a, b);
  assert.ok(a.length > 500);
});

test("hosts may supply their own table of contents without removing document anchors", () => {
  const html = render(FULL, { showTableOfContents: false });
  assert.doesNotMatch(html, /class="plate-toc"/);
  assert.match(html, /<h2 id="content-t1">标题<\/h2>/);
  assert.match(html, /<h3 id="content-t2">小标<\/h3>/);
});

test("image caption appears in the figure separately from alternative text", () => {
  const html = render(env("help", [{ type: "img", mediaId: "m1", alt: "图像替代文字", caption: "图注 <示例>", children: [{ text: "" }] }]), { mediaUrls: { m1: "/media/m1" } });
  assert.ok(html.includes('alt="图像替代文字"'));
  assert.ok(html.includes('<figcaption class="plate-image-caption">图注 &lt;示例&gt;</figcaption>'));
});
