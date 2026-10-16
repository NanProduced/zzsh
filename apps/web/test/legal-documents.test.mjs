import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getLegalDocument, isLegalDocId, legalDocuments, listLegalDocuments } from "../src/content/legal/documents.ts";

const require = createRequire(import.meta.url);

const pageCode = ts.transpileModule(
  readFileSync(new URL("../src/app/legal/[doc]/page.tsx", import.meta.url), "utf8"),
  { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
).outputText;

function loadPage(registry) {
  const exports = {};
  new Function("require", "exports", pageCode)(name => {
    if (name === "next/navigation") return { notFound() { throw Object.assign(new Error("Not found"), { status: 404 }); } };
    if (name === "next/link") return (props) => React.createElement("a", props);
    if (name === "@/components/brand/brand-logo") return { BrandLogo: () => null };
    if (name === "@/content/legal/documents") return registry;
    return require(name);
  }, exports);
  return exports;
}

async function renderDoc(page, doc) {
  const element = await page.default({ params: Promise.resolve({ doc }) });
  return renderToStaticMarkup(element);
}

test("registry holds exactly terms and privacy as versioned records", () => {
  assert.equal(legalDocuments.length, 2);
  assert.deepEqual(listLegalDocuments().map((r) => r.doc).sort(), ["privacy", "terms"]);
  for (const record of legalDocuments) {
    assert.equal(typeof record.title, "string");
    assert.ok(record.title.length > 0, record.doc);
    assert.equal(typeof record.note, "string");
    assert.ok(record.note.length > 0, `${record.doc} note`);
    assert.ok(record.status === "PENDING" || record.status === "PUBLISHED", record.doc);
    if (record.version !== null) assert.equal(typeof record.version, "string", `${record.doc}.version`);
    if (record.effectiveAt !== null) assert.match(record.effectiveAt, /^\d{4}-\d{2}-\d{2}$/, `${record.doc}.effectiveAt`);
    if (record.body !== null) assert.ok(Array.isArray(record.body), `${record.doc}.body`);
    if (record.status === "PENDING") {
      assert.equal(record.version, null, `${record.doc} must not fabricate a version`);
      assert.equal(record.effectiveAt, null, `${record.doc} must not fabricate an effective date`);
      assert.equal(record.body, null, `${record.doc} must not fabricate a body`);
    } else {
      assert.ok(Array.isArray(record.body) && record.body.length > 0, `${record.doc} published without body`);
      assert.match(record.version, /.+/, `${record.doc} published without version`);
      assert.match(record.effectiveAt, /^\d{4}-\d{2}-\d{2}$/, `${record.doc} published without effective date`);
    }
  }
});

test("registry lookup is hardened against prototype keys", () => {
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "missing"]) {
    assert.equal(getLegalDocument(key), undefined, key);
    assert.equal(isLegalDocId(key), false, key);
  }
  assert.equal(getLegalDocument("terms")?.title, "平台服务协议");
  assert.equal(getLegalDocument("privacy")?.title, "用户隐私政策");
  assert.ok(isLegalDocId("terms") && isLegalDocId("privacy"));
});

test("PENDING pages render the registry note without fabricated version or body", async () => {
  const page = loadPage({ getLegalDocument, getLegalDocumentSibling: (doc) => legalDocuments.find((r) => r.doc !== doc), isLegalDocId, listLegalDocuments });
  assert.deepEqual(page.generateStaticParams(), [{ doc: "terms" }, { doc: "privacy" }]);
  for (const doc of ["terms", "privacy"]) {
    const html = await renderDoc(page, doc);
    const record = getLegalDocument(doc);
    assert.ok(html.includes(`《${record.title}》`), doc);
    assert.ok(html.includes(record.note), `${doc} shows the registry status note`);
    assert.ok(html.includes("不是正式协议文本"), `${doc} keeps the honest status semantics`);
    assert.ok(html.includes('role="status"'), `${doc} exposes the status landmark`);
    assert.ok(!/版本\s*[0-9vV.]/.test(html), `${doc} must not show a fabricated version`);
    assert.ok(!/生效/.test(html), `${doc} must not show an effective date while pending`);
  }
  const terms = await renderDoc(page, "terms");
  assert.ok(terms.includes('href="/legal/privacy"'), "terms links to privacy sibling");
  const privacy = await renderDoc(page, "privacy");
  assert.ok(privacy.includes('href="/legal/terms"'), "privacy links to terms sibling");
  const termsMeta = await page.generateMetadata({ params: Promise.resolve({ doc: "terms" }) });
  assert.match(termsMeta.title, /《平台服务协议》 · 洲洲商行/);
});

test("PUBLISHED records render version, effective date, body and sibling link", async () => {
  const publishedTerms = {
    ...getLegalDocument("terms"),
    version: "1.0",
    effectiveAt: "2026-11-01",
    status: "PUBLISHED",
    body: [
      { type: "heading", text: "第一条 服务范围" },
      { type: "paragraph", text: "正式条款正文段落。" },
      { type: "list", ordered: true, items: ["第一项", "第二项"] },
    ],
  };
  const registry = {
    getLegalDocument: (doc) => (doc === "terms" ? publishedTerms : getLegalDocument(doc)),
    getLegalDocumentSibling: (doc) => (doc === "terms" ? getLegalDocument("privacy") : publishedTerms),
    isLegalDocId,
    listLegalDocuments,
  };
  const page = loadPage(registry);
  const html = await renderDoc(page, "terms");
  assert.ok(html.includes("版本 1.0"), "shows the registered version");
  assert.ok(html.includes("2026-11-01"), "shows the registered effective date");
  assert.ok(html.includes("第一条 服务范围") && html.includes("<h2"), "renders heading blocks");
  assert.ok(html.includes("正式条款正文段落。"), "renders paragraph blocks");
  assert.ok(html.includes("<ol") && html.includes("第一项") && html.includes("第二项"), "renders ordered lists");
  assert.ok(!html.includes("不是正式协议文本"), "published page drops the pending disclaimer");
  assert.ok(html.includes('href="/legal/privacy"'), "keeps the sibling link");
});

test("unknown and prototype doc ids go through notFound", async () => {
  const page = loadPage({ getLegalDocument, getLegalDocumentSibling: (doc) => legalDocuments.find((r) => r.doc !== doc), isLegalDocId, listLegalDocuments });
  for (const doc of ["missing", "toString", "constructor", "__proto__", "terms?x=1"]) {
    await assert.rejects(() => page.default({ params: Promise.resolve({ doc }) }), (e) => e.status === 404, doc);
    await assert.rejects(() => page.generateMetadata({ params: Promise.resolve({ doc }) }), (e) => e.status === 404, doc);
  }
});
