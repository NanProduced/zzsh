import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const plate = text => ({ format: "plate", schemaVersion: 1, preset: "legal", value: [{ type: "p", children: [{ text }] }] });

function fixedItem(overrides = {}) {
  return {
    kind: "PLATFORM_PRIVACY", key: "PLATFORM_PRIVACY", draftVersionId: "legal_privacy_v2", baseVersionId: "legal_privacy_v1",
    digest: "e".repeat(64), readAvailable: true, title: "用户隐私政策", bodyFormat: "plate", status: "PENDING",
    digestMatches: true, baseMatches: true,
    preview: { body: "隐私第二版正文", document: plate("隐私第二版正文") },
    base: { versionId: "legal_privacy_v1", title: "用户隐私政策", body: "隐私第一版正文", document: plate("隐私第一版正文"), effectiveAt: "2026-11-01T00:00:00.000Z" },
    blocks: [
      { status: "UNCHANGED", before: "共同条款", after: "共同条款" },
      { status: "CHANGED", before: "隐私第一版正文", after: "隐私第二版正文" },
      { status: "ADDED", before: null, after: "新增的隐私条款" },
    ],
    changes: { added: 1, removed: 0, changed: 1, unchanged: 1 },
    ...overrides,
  };
}

function business(overrides = {}) {
  return {
    requestId: "approval_req_1", businessType: "content", businessTitle: "固定文书发布",
    operationCode: "content.fixed_document.publish", executionMode: "GENERIC_TRANSACTION",
    summaryAvailable: true, detailsAvailable: true, changeSummary: "只更新隐私政策",
    summary: {
      schemaVersion: 1, changeSummary: "只更新隐私政策",
      fixedDocument: { schema: "content-fixed-document-publish.v1", payloadState: "KNOWN", items: [fixedItem()] },
    },
    objectRefs: [{ type: "legal_document_version", id: "legal_privacy_v2" }],
    resultAvailability: "KNOWN",
    executionReceipt: { status: "SUCCEEDED", resultCode: "FIXED_DOC_EFFECTIVE", resultDetail: "2026-11-12T00:00:00.000Z" },
    result: { knowledge: "KNOWN", effectiveAt: "2026-11-12T00:00:00.000Z", versionIds: ["legal_privacy_v2"] },
    ...overrides,
  };
}

async function harness(t) {
  const browser = new Window({ url: "http://127.0.0.1:3101/approvals" });
  const bound = ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"];
  for (const key of ["document", "HTMLElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "navigator", ...bound]) {
    const value = browser[key];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, { value: bound.includes(key) ? value.bind(browser) : value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "window", { value: browser, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected approval summary HTTP request"); };
  const { createRoot } = await import("react-dom/client");
  const source = await createOfflineAdminSource({ root });
  const host = document.createElement("div");
  document.body.append(host);
  const rootNode = createRoot(host);
  const { BusinessSummary } = await source.ssrLoadModule("/src/views/approval/business-summary.tsx");
  t.after(async () => {
    await act(async () => rootNode.unmount());
    host.remove();
    globalThis.fetch = previousFetch;
    await source.close();
    await browser.happyDOM.abort();
  });
  return {
    host,
    render: async props => { await act(async () => rootNode.render(createElement(BusinessSummary, props))); },
  };
}

test("fixed document approval detail leads with the user preview and the live block diff", async t => {
  const h = await harness(t);
  await h.render({ business: business(), operationCode: "content.fixed_document.publish" });
  const text = h.host.textContent;
  const previewAt = text.indexOf("固定文书发布：用户端预览与线上差异");
  const changeAt = text.indexOf("此次申请改变什么");
  assert.ok(previewAt >= 0, "fixed document section must render");
  assert.ok(changeAt > previewAt, "preview and diff must be the most prominent block");
  assert.match(text, /用户隐私政策/);
  assert.match(text, /隐私第二版正文/);
  assert.match(text, /新增的隐私条款/);
  assert.match(text, /修改/);
  assert.match(text, /新增/);
  assert.match(text, /legal_privacy_v1/);
  assert.match(text, /已读到本次执行结果/);
  assert.match(text, /用户只需重新同意变更的那份/);
  assert.equal(h.host.querySelector("[contenteditable]"), null, "审批详情只读，不挂载编辑器");
});

test("restricted or missing fixed document snapshots never substitute the live document", async t => {
  const h = await harness(t);
  await h.render({ business: business({ summaryAvailable: false, detailsAvailable: false, restrictedReasonCodes: ["BUSINESS_PERMISSION_REQUIRED"], summary: undefined }), operationCode: "content.fixed_document.publish" });
  assert.equal(h.host.textContent.includes("隐私第二版正文"), false);
  assert.match(h.host.textContent, /无权查看本次申请的业务摘要/);

  await h.render({ business: business({ summary: { schemaVersion: 1, changeSummary: "只更新隐私政策" } }), operationCode: "content.fixed_document.publish" });
  assert.match(h.host.textContent, /固定文书发布快照未提供/);
  assert.equal(h.host.textContent.includes("隐私第二版正文"), false);
});

test("early settlement item renders as plain text paragraphs, not as a plate document", async t => {
  const h = await harness(t);
  const early = fixedItem({
    kind: "EARLY_SETTLEMENT", key: "EARLY_SETTLEMENT", title: "提前结算告知", bodyFormat: "text",
    draftVersionId: "early-settlement-fees-v2", baseVersionId: "early-settlement-fees-v1",
    preview: { body: "第一段说明\n第二段说明", document: null },
    base: { versionId: "early-settlement-fees-v1", title: "提前结算告知", body: "第一段说明", document: null, effectiveAt: null },
    blocks: [{ status: "ADDED", before: null, after: "第二段说明" }],
    changes: { added: 1, removed: 0, changed: 0, unchanged: 0 },
  });
  await h.render({
    business: business({ summary: { fixedDocument: { schema: "content-fixed-document-publish.v1", payloadState: "KNOWN", items: [early] } }, resultAvailability: "NOT_APPLICABLE", executionReceipt: undefined, result: undefined }),
    operationCode: "content.fixed_document.publish",
  });
  const text = h.host.textContent;
  assert.match(text, /提前结算告知/);
  assert.match(text, /第二段说明/);
  assert.match(text, /尚未生效/);
  assert.equal(h.host.querySelectorAll("[aria-label='用户端预览'] p").length, 2);
});