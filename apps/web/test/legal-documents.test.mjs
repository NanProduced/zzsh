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

function loadPage(reading) {
  const exports = {};
  new Function("require", "exports", pageCode)(name => {
    if (name === "next/navigation") return { notFound() { throw Object.assign(new Error("Not found"), { status: 404 }); } };
    if (name === "next/link") return (props) => React.createElement("a", props);
    if (name === "@/components/brand/brand-logo") return { BrandLogo: () => null };
    if (name === "@/content/legal/documents") return { getLegalDocument, getLegalDocumentSibling: (doc) => legalDocuments.find((record) => record.doc !== doc), isLegalDocId, listLegalDocuments };
    if (name === "@/lib/legal-server") return { readLegalDocument: async (doc) => reading(doc) };
    return require(name);
  }, exports);
  return exports;
}

async function renderDoc(page, doc) {
  const element = await page.default({ params: Promise.resolve({ doc }) });
  return renderToStaticMarkup(element);
}

const publishedTerms = {
  state: "PUBLISHED",
  document: {
    id: "legal_terms_1",
    docType: "PLATFORM_TERMS",
    title: "平台服务协议",
    body: "第一条 服务范围\n\n正式条款正文段落。",
    digest: "a".repeat(64),
    effectiveAt: "2026-11-01T00:00:00.000Z",
  },
};

test("registry holds exactly terms and privacy as non-fabricated records", () => {
  assert.equal(legalDocuments.length, 2);
  assert.deepEqual(listLegalDocuments().map((record) => record.doc).sort(), ["privacy", "terms"]);
  for (const record of legalDocuments) {
    assert.equal(typeof record.title, "string");
    assert.ok(record.title.length > 0, record.doc);
    assert.equal(record.status, "PENDING");
    assert.equal(record.version, null, `${record.doc} must not fabricate a version`);
    assert.equal(record.effectiveAt, null, `${record.doc} must not fabricate an effective date`);
    assert.equal(record.body, null, `${record.doc} must not fabricate a body`);
    assert.ok(record.note.length > 0, `${record.doc} note`);
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

test("pending and unavailable pages state the truth without a fabricated version or body", async () => {
  for (const state of ["PENDING", "UNAVAILABLE"]) {
    const page = loadPage(() => state === "PENDING" ? { state: "PENDING", title: "平台服务协议" } : { state: "UNAVAILABLE" });
    assert.deepEqual(page.generateStaticParams(), [{ doc: "terms" }, { doc: "privacy" }]);
    for (const doc of ["terms", "privacy"]) {
      const html = await renderDoc(page, doc);
      assert.ok(html.includes(`《${getLegalDocument(doc).title}》`), doc);
      assert.ok(html.includes("不是正式协议文本"), `${state} ${doc} keeps honest status semantics`);
      assert.ok(html.includes('role="status"'), `${state} ${doc} exposes the status landmark`);
      assert.ok(!/版本\s*[0-9a-zA-Z_]/.test(html), `${state} ${doc} must not show a fabricated version`);
      assert.ok(!/于 .* 生效/.test(html), `${state} ${doc} must not show an effective date`);
    }
    const terms = await renderDoc(page, "terms");
    assert.ok(terms.includes('href="/legal/privacy"'), "terms links to privacy sibling");
    const privacy = await renderDoc(page, "privacy");
    assert.ok(privacy.includes('href="/legal/terms"'), "privacy links to terms sibling");
  }
});

test("published page renders the API version, effective date, body and sibling link", async () => {
  const page = loadPage((doc) => doc === "terms" ? publishedTerms : { state: "PENDING", title: "用户隐私政策" });
  const html = await renderDoc(page, "terms");
  assert.ok(html.includes("版本 legal_terms_1"), "shows the API version id");
  assert.ok(html.includes("2026-11-01T00:00:00.000Z"), "shows the API effective time");
  assert.ok(html.includes("第一条 服务范围") && html.includes("正式条款正文段落。"), "renders the API body text");
  assert.ok(html.includes(publishedTerms.document.digest.slice(0, 16)), "shows the bound digest prefix");
  assert.ok(!html.includes("不是正式协议文本"), "published page drops the pending disclaimer");
  assert.ok(html.includes('href="/legal/privacy"'), "keeps the sibling link");
});

test("unknown and prototype doc ids go through notFound", async () => {
  const page = loadPage(() => ({ state: "UNAVAILABLE" }));
  for (const doc of ["missing", "toString", "constructor", "__proto__", "terms?x=1"]) {
    await assert.rejects(() => page.default({ params: Promise.resolve({ doc }) }), (error) => error.status === 404, doc);
    await assert.rejects(() => page.generateMetadata({ params: Promise.resolve({ doc }) }), (error) => error.status === 404, doc);
  }
});
