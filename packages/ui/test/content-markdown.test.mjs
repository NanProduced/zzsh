import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { inspectMarkdown } from "@zzsh/content/markdown";
import { createOfflineAdminSource } from "../../../apps/admin/test/offline-admin-source.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const entry = require.resolve("@zzsh/ui/content-markdown");
const source = await createOfflineAdminSource({ root });
const { MarkdownDocument } = await source.ssrLoadModule("/" + path.relative(root, entry).replaceAll("\\", "/"));
after(() => source.close());

test("document spacing survives consumer resets in either stylesheet order", async () => {
  const css = readFileSync(require.resolve("@zzsh/ui/content-markdown.css"), "utf8").replace(/^@import[^;]+;/m, "");
  const reset = ".portal-home p,.portal-home h2{margin:0}";
  for (const styles of [[css, reset], [reset, css]]) {
    const browser = new Window();
    browser.document.head.innerHTML = `<style>${styles.join("\n")}</style>`;
    browser.document.body.innerHTML = `<div class="portal-home">${renderToStaticMarkup(React.createElement(MarkdownDocument, { markdown: "开头。\n\n## 标题\n\n中间第一段。\n\n中间第二段。\n\n结尾。" }))}</div>`;
    const document = browser.document.querySelector(".content-markdown"), paragraphs = document.querySelectorAll("p");
    assert.notEqual(browser.getComputedStyle(paragraphs[1]).marginBottom, "0px", "consumer paragraph resets must not flatten document flow");
    assert.notEqual(browser.getComputedStyle(document.querySelector("h2")).marginBottom, "0px", "consumer heading resets must not flatten document flow");
    assert.equal(browser.getComputedStyle(paragraphs[0]).marginTop, "0px");
    assert.equal(browser.getComputedStyle(paragraphs[paragraphs.length - 1]).marginBottom, "0px");
    browser.document.body.innerHTML = `<div class="portal-home">${renderToStaticMarkup(React.createElement(MarkdownDocument, { markdown: "## 简短说明\n\n第一段。\n\n第二段。", compact: true }))}</div>`;
    const compact = browser.document.querySelector(".content-markdown");
    assert.equal(browser.getComputedStyle(compact).getPropertyValue("--typeset-size").trim(), ".875rem");
    assert.equal(browser.getComputedStyle(compact.firstElementChild).marginTop, "0px");
    assert.notEqual(browser.getComputedStyle(compact.querySelector("p")).marginBottom, "0px");
    await browser.happyDOM.abort();
  }
});

function render(markdown, mediaUrls = {}) {
  const html = renderToStaticMarkup(React.createElement(MarkdownDocument, { markdown, mediaUrls }));
  const window = new Window();
  const host = window.document.createElement("div");
  host.innerHTML = html;
  return { html, host };
}

test("actual Markdown renderer keeps reference-link and raw-HTML attack inputs inert", () => {
  const { host } = render("[领取][unsafe]\n\n[unsafe]: javascript:alert(1)\n\n[站外说明](https://example.invalid/guide)\n\n![外链图](https://example.invalid/image.png)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<iframe src=javascript:alert(3)></iframe>");
  assert.equal(host.querySelectorAll("script, iframe, [onerror], [onclick]").length, 0);
  assert.equal(host.querySelectorAll('a[href^="javascript:"], img[src^="https:"]').length, 0);
  const external = host.querySelector('a[href="https://example.invalid/guide"]');
  assert.ok(external); assert.equal(external.target, "_blank");
  assert.ok(external.rel.includes("noopener") && external.rel.includes("noreferrer"));
  assert.match(host.textContent, /领取/);
  assert.match(host.textContent, /图片暂不可用/);
});

test("only eligibility-filtered API media mappings produce images; revoked, missing and arbitrary URLs do not", () => {
  const markdown = "![公开图][image]\n\n[image]: media://public\n\n![原API](media://api)\n\n![后台预览](media://admin)\n\n![撤权图](media://revoked)\n\n![外链映射](media://external)\n\n![私有路径](media://private)\n\n![未知图](media://missing)";
  const { host } = render(markdown, {
    public: "/api/content/media/public/content",
    api: "/api/v1/content/media/api/content",
    admin: "/api/bff/admin/content/media/admin/content",
    revoked: null,
    external: "https://example.invalid/private.png",
    private: "/api/media/private/original",
  });
  assert.deepEqual([...host.querySelectorAll("img")].map(image => image.getAttribute("src")), [
    "/api/content/media/public/content", "/api/v1/content/media/api/content", "/api/bff/admin/content/media/admin/content",
  ]);
  assert.equal(host.querySelectorAll('[role="status"]').length, 4);
  const revoked = render("![公开图](media://public)", { public: null });
  assert.equal(revoked.host.querySelectorAll("img").length, 0);
  assert.match(revoked.host.textContent, /图片暂不可用/);
});

test("actual heading IDs match the shared TOC and inline media keeps valid paragraph HTML", async () => {
  const markdown = "## a\n\n前文 ![图](media://image) 后文。\n\n### a-2\n\n## a\n\n## 中文标题\n\n## 中文标题\n\n|列一|列二|\n|---|---|\n|值一|值二|";
  const inspection = await inspectMarkdown(markdown, { media: { image: { available: true } } });
  const { html, host } = render(markdown, { image: "/api/content/media/image/content" });
  const ids = [...host.querySelectorAll("h2,h3")].map(heading => heading.id);
  assert.deepEqual(ids, inspection.toc.map(item => item.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.startsWith("content-")));
  assert.equal(host.querySelectorAll("p figure, p div").length, 0);
  assert.doesNotMatch(html, /<p[^>]*>\s*<(?:figure|div)\b/);
  assert.equal(host.querySelector("p")?.querySelector("img")?.getAttribute("src"), "/api/content/media/image/content");
  assert.match(host.querySelector("p").textContent, /前文.*后文/);
  assert.ok(host.querySelector('.content-markdown-table[role="region"][tabindex="0"] table'));
});

test("production renderer entry bundles independently of editor, docs shell, server code and async serializer", async () => {
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const result = await build({ configFile: false, plugins: [react()], logLevel: "silent", build: {
    write: false, minify: false, lib: { entry, formats: ["es"], fileName: "content-markdown-test" },
    rollupOptions: { external: ["react", "react-dom", "react/jsx-runtime"] },
  } });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(result => result.output).filter(item => item.type === "chunk");
  assert.ok(chunks.some(chunk => chunk.isEntry));
  const modules = [...new Set(chunks.flatMap(chunk => Object.keys(chunk.modules)))].map(id => id.replaceAll("\\", "/"));
  assert.ok(modules.some(id => id.endsWith("/packages/ui/src/content-markdown.tsx")));
  assert.ok(modules.some(id => id.includes("/react-markdown/")));
  assert.ok(modules.some(id => id.endsWith("/packages/content/markdown-policy.mjs")));
  const forbidden = modules.filter(id => /\/node_modules\/(?:@uiw\/|fumadocs[^/]*\/|next\/|@nestjs\/|remark-stringify\/)|\/packages\/content\/(?:markdown\.mjs|api-markdown\.)|\/apps\/(?:api|admin|web)\/src\//.test(id));
  assert.deepEqual(forbidden, []);
  assert.deepEqual(modules.filter(id => id.includes("browser-external") || id.startsWith("node:")), []);
  assert.deepEqual(chunks.flatMap(chunk => chunk.imports).filter(id => id.startsWith("node:") || id.startsWith("next/")), []);
  assert.ok(chunks.every(chunk => chunk.dynamicImports.length === 0), "renderer must not emit a deferred serializer or editor chunk");
  assert.ok(require.resolve("@zzsh/ui/content-markdown.css").endsWith("content-markdown.css"));
});
