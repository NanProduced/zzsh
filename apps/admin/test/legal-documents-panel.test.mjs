import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { plateDigest } from "@zzsh/content/plate";
import { act, createElement, StrictMode } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function exposeBrowser(browser) {
  const bound = ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia"];
  const keys = ["document", "Document", "ShadowRoot", "HTMLCollection", "NodeList", "SVGElement", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "Text",
    "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "MutationObserver", "ResizeObserver", "IntersectionObserver",
    "DOMRect", "Range", "Selection", "DocumentFragment", "CSSStyleSheet", "Image", "FileList", "FileReader", "DataTransfer",
    "localStorage", "sessionStorage", "history", "location", "screen", "navigator", ...bound];
  for (const key of keys) {
    const value = browser[key];
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, { value: bound.includes(key) ? value.bind(browser) : value, configurable: true, writable: true });
  }
  if (!browser.matchMedia) globalThis.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Object.defineProperty(globalThis, "window", { value: browser, configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const plate = text => ({ format: "plate", schemaVersion: 1, preset: "legal", value: [{ type: "p", children: [{ text }] }] });

function version(overrides) {
  const document = plate(overrides.body ?? "合成正文");
  return {
    id: "legal_1", docType: "PLATFORM_TERMS", title: "平台服务协议", body: overrides.body ?? "合成正文",
    bodyFormat: "plate", bodyDocument: document, digest: "d".repeat(64), status: "DRAFT", revision: "1",
    effectiveAt: null, sealedAt: null, approvalRequestId: null, createdAt: "2026-11-01T00:00:00.000Z", ...overrides,
  };
}

async function harness(t, { versions, current, permissions, diff, writes = [], notices = [], resources = {}, writeResponse, readResponse, strict = false }) {
  const browser = new Window({ url: "http://127.0.0.1:3101/content" });
  exposeBrowser(browser);
  const previousFetch = globalThis.fetch;
  const reads = [];
  const dirty = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    const method = init.method ?? "GET";
    if (method !== "GET") {
      writes.push({ path, body: JSON.parse(init.body ?? "{}"), key: new Headers(init.headers).get("idempotency-key") });
      const handled = writeResponse?.(writes.at(-1), writes.length);
      if (handled) return handled;
      if (path.includes("/fixed-document-submissions")) return Response.json({ approvalRequestId: "approval_req_new", items: [] });
      if (path.includes("/return")) return Response.json({ ...versions.find(row => path.endsWith(`/drafts/${row.id}/return`)), status: "DRAFT", approvalRequestId: null });
      return Response.json(versions[0]);
    }
    reads.push(path);
    const handled = readResponse?.(path);
    if (handled) return handled;
    if (path.includes("/diff")) return Response.json(diff ?? { draft: versions[0], current: null, blocks: [], changes: { added: 0, removed: 0, changed: 0, unchanged: 0 } });
    if (path.startsWith("/api/bff/admin/content/resources?")) {
      assert.equal(new URLSearchParams(path.split("?")[1]).get("limit"), "5", "adhere to the resource API page cap");
      return Response.json({ items: notices, nextCursor: null, limit: 5 });
    }
    if (path.includes("/content/resources/")) {
      const [encodedKey, encodedVersion] = path.split("/content/resources/")[1].split("/versions/");
      const detail = resources[decodeURIComponent(encodedKey)];
      if (encodedVersion) return Response.json({ version: detail?.versions.find(row => row.id === decodeURIComponent(encodedVersion)), media: [] });
      return Response.json(detail ?? { draft: null, published: null });
    }
    return Response.json({ versions, current });
  };
  const { createRoot } = await import("react-dom/client");
  const source = await createOfflineAdminSource({ root });
  const host = document.createElement("div");
  document.body.append(host);
  const rootNode = createRoot(host);
  const { LegalDocumentsPanel } = await source.ssrLoadModule("/src/views/legal-documents-panel.tsx");
  const props = {
    snapshot: { authenticated: true, adminUserId: "admin_1", session: { id: "session_1" }, security: { isBoss: false }, permissions },
    onDirtyChange: value => dirty.push(value),
    refreshNonce: 0,
  };
  const render = () => {
    const panel = createElement(LegalDocumentsPanel, props);
    rootNode.render(strict ? createElement(StrictMode, null, panel) : panel);
  };
  await act(async () => render());
  const button = text => {
    const buttons = [...document.body.querySelectorAll("button")];
    return buttons.find(node => node.textContent.trim() === text) ?? buttons.find(node => node.textContent.includes(text));
  };
  const click = async text => { const target = button(text); assert.ok(target, `missing button ${text}: ${document.body.textContent.slice(0, 400)}`); await act(async () => target.click()); };
  const type = async (node, value) => act(async () => {
    const proto = node.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(new browser.Event("input", { bubbles: true }));
    node.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  t.after(async () => {
    await act(async () => rootNode.unmount());
    host.remove();
    globalThis.fetch = previousFetch;
    await source.close();
    await browser.happyDOM.abort();
  });
  const selectVersion = async (label, index = 0) => {
    const rows = [...host.querySelectorAll(".fixed-doc-version")].filter(row => row.firstElementChild.textContent === label);
    assert.ok(rows[index], `missing version ${label} at ${index}`);
    await act(async () => rows[index].click());
  };
  const refresh = async () => { props.refreshNonce++; await act(async () => render()); };
  return { host, browser, button, click, type, writes, reads, dirty, selectVersion, refresh, text: () => document.body.textContent };
}

test("opens the authoritative live version and highlights only changed clauses in comparison", async t => {
  const sealed = version({ id: "legal_sealed", status: "SEALED", body: "线上协议正文", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const draft = version({ id: "legal_draft", body: "草稿协议正文" });
  const h = await harness(t, {
    versions: [draft],
    current: [sealed],
    permissions: ["content.platform.read"],
    diff: {
      draft, current: sealed,
      blocks: [
        { status: "UNCHANGED", before: "共同条款", after: "共同条款" },
        { status: "CHANGED", before: "可以查看旧条款", after: "可以查看新条款" },
        { status: "ADDED", before: null, after: "新增条款" },
      ],
    },
  });
  assert.match(h.host.querySelector("[aria-label='用户端预览']").textContent, /线上协议正文/);
  await h.click("版本对比");
  assert.match(h.host.textContent, /在左侧选择草稿、审批稿或其他版本，与当前生效版本对比/);
  assert.equal(h.reads.some(path => path.includes("/diff")), false);
  await h.selectVersion("草稿");
  await h.click("版本对比");
  assert.match(h.host.textContent, /新增条款/);
  assert.match(h.host.textContent, /2 处正文变更/);
  assert.doesNotMatch(h.host.textContent, /共同条款/);
  assert.equal(h.host.querySelector("del").textContent, "旧");
  assert.equal(h.host.querySelector("ins").textContent, "新");
  await act(async () => h.host.querySelector(".fixed-doc-diff-header input[type='checkbox']").click());
  assert.match(h.host.textContent, /共同条款/);
  assert.equal(h.host.querySelector("[contenteditable]"), null);
  assert.equal(h.button("保存草稿"), undefined);
  assert.equal(h.button("提交发布审批"), undefined);
});

test("first effect submits both platform drafts in one approval request and never seals directly", async t => {
  const terms = version({ id: "legal_terms", docType: "PLATFORM_TERMS", body: "协议草稿正文" });
  const privacy = version({ id: "legal_privacy", docType: "PLATFORM_PRIVACY", body: "隐私草稿正文" });
  const h = await harness(t, { versions: [terms, privacy], permissions: ["content.platform.read", "content.fixed.submit", "approval.request.create"], writes: [] });
  assert.equal(h.button("提交发布审批").disabled, false);
  await h.click("提交发布审批");
  assert.match(document.body.textContent, /提交固定文书发布审批/);
  assert.match(document.body.textContent, /平台服务协议与用户隐私政策首次生效时会一并提交/);
  // 理由不足 3 字不能提交。
  assert.equal(h.button("提交审批").disabled, true);
  await h.type(document.body.querySelector("textarea"), "首次发布两份平台文书");
  assert.equal(h.button("提交审批").disabled, false);
  await h.click("提交审批");
  const submission = h.writes.find(write => write.path.includes("/fixed-document-submissions"));
  assert.ok(submission, `expected a submission write, got ${JSON.stringify(h.writes)}`);
  assert.equal(submission.body.reason, "首次发布两份平台文书");
  assert.deepEqual(submission.body.items.map(item => item.kind), ["PLATFORM_TERMS", "PLATFORM_PRIVACY"]);
  assert.deepEqual(submission.body.items.map(item => item.baseVersionId), [null, null]);
  assert.equal(h.writes.some(write => write.path.includes("/seal")), false, "直接封存入口已下线");
  assert.match(h.host.textContent, /已提交固定文书发布审批/);
});

test("single update keeps the live base version and pending drafts can only return after the decision", async t => {
  const live = version({ id: "legal_live", status: "SEALED", body: "线上协议", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const draft = version({ id: "legal_draft", body: "协议修订稿", revision: "3" });
  const pending = version({ id: "legal_pending", status: "PENDING", body: "待审批稿", approvalRequestId: "approval_req_1", revision: "4" });
  const privacyLive = version({ id: "legal_privacy_live", docType: "PLATFORM_PRIVACY", status: "SEALED", body: "线上隐私", effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z" });
  const h = await harness(t, { versions: [draft, live, pending, privacyLive], permissions: ["content.platform.read", "content.fixed.submit", "approval.request.create"], writes: [] });
  await h.selectVersion("草稿");
  await h.click("提交发布审批");
  await h.type(document.body.querySelector("textarea"), "只更新平台服务协议");
  await h.click("提交审批");
  const submission = h.writes.find(write => write.path.includes("/fixed-document-submissions"));
  assert.deepEqual(submission.body.items, [{ kind: "PLATFORM_TERMS", key: "PLATFORM_TERMS", draftVersionId: "legal_draft", digest: "d".repeat(64), baseVersionId: "legal_live" }]);

  // 已提交审批的版本在审批结束后可以退回草稿。
  await h.selectVersion("已提交审批", 1);
  assert.match(h.host.textContent, /已提交审批/);
  assert.ok(h.button("查看审批"));
  assert.equal(h.button("提交发布审批"), undefined);
  await h.click("退回草稿");
  assert.ok(h.writes.some(write => write.path.includes("/legal-documents/drafts/legal_pending/return")));
});

test("keeps a dirty draft on navigation and retries an unknown save with the original key", async t => {
  const draft = version({
    id: "early_draft", docType: "EARLY_SETTLEMENT", title: "提前结算告知", body: "原告知正文",
    bodyFormat: "text", bodyDocument: null,
  });
  const h = await harness(t, {
    versions: [draft], permissions: ["content.platform.read", "content.platform.edit"],
    writeResponse: (write, count) => count === 1 ? Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 503 })
      : Response.json({ ...draft, body: write.body.body, revision: "2" }),
  });
  await h.click("提前结算告知");
  await h.click("编辑");
  await h.type(h.host.querySelector("textarea"), "修改后的告知正文");
  assert.equal(h.dirty.at(-1), true);
  await h.click("出租上架须知");
  assert.match(h.text(), /放弃未保存的修改/);
  assert.equal(h.reads.some(path => path.includes("placement%3APUBLISH_NOTICE")), false);
  await h.click("继续编辑");
  await h.click("平台服务协议");
  assert.match(h.text(), /放弃未保存的修改/);
  await h.click("继续编辑");
  assert.equal(h.host.querySelector("textarea").value, "修改后的告知正文");
  await h.click("保存草稿");
  assert.equal(h.host.querySelector("textarea").value, "修改后的告知正文");
  await h.click("重试原请求");
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.writes[0], h.writes[1]);
  assert.match(h.writes[0].key, /^idem_/);
  assert.equal(h.dirty.at(-1), false);
});

test("autosave acknowledges the sent draft without rewriting the editor, and reload keeps that version selected", async t => {
  const draft = version({
    id: "early_draft", docType: "EARLY_SETTLEMENT", title: "提前结算告知", body: "测试草稿正文",
    bodyFormat: "text", bodyDocument: null,
  });
  const live = version({
    ...draft, id: "early_live", status: "SEALED", body: "测试生效正文",
    effectiveAt: "2026-11-01T00:00:00.000Z", sealedAt: "2026-11-01T00:00:00.000Z",
  });
  const versions = [draft, live];
  let acknowledge;
  const h = await harness(t, {
    versions, current: [live], permissions: ["content.platform.read", "content.platform.edit"],
    writeResponse: write => new Promise(resolve => {
      acknowledge = () => {
        versions[0] = { ...draft, revision: "2", body: write.body.body.trim() };
        resolve(Response.json(versions[0]));
      };
    }),
  });
  await h.click("提前结算告知");
  await h.selectVersion("草稿");
  const input = h.host.querySelector("textarea");
  assert.ok(input, "草稿直接进入编辑");
  const typed = "修改后的测试正文   ";
  await h.type(input, typed);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].body.expectedRevision, "1");
  assert.equal(h.host.querySelector("textarea"), input);
  await act(async () => acknowledge());
  assert.equal(h.host.querySelector("textarea"), input);
  assert.equal(input.value, typed);
  assert.equal(h.dirty.at(-1), false);
  await h.click("重新读取");
  assert.equal(h.host.querySelector(".fixed-doc-version[aria-pressed='true'] span").textContent, "草稿");
  assert.equal(h.host.querySelector("textarea").value, typed.trim());
});

test("submits the saved scenario explanation through fixed document approval", async t => {
  const terms = version({ id: "terms_live", status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z" });
  const privacy = version({ id: "privacy_live", docType: "PLATFORM_PRIVACY", status: "SEALED", effectiveAt: "2026-11-01T00:00:00.000Z" });
  const key = "placement:PUBLISH_NOTICE";
  const noticeDocument = { ...plate("场景说明更新"), preset: "notice" };
  const payload = { kind: "notice", title: "上架说明", format: "plate", schemaVersion: 1, document: noticeDocument, mediaIds: [] };
  const current = { key, payload, kind: "notice", media: [], state: "available", source: "MANAGED", version: null };
  const draft = { id: "notice_draft", sequence: 2, state: "DRAFT", revision: "1", title: "上架说明", payload, updatedAt: "2026-11-01T00:00:00.000Z" };
  const published = { ...draft, id: "notice_live", sequence: 1, state: "PUBLISHED", publishedAt: "2026-11-01T00:00:00.000Z" };
  const h = await harness(t, {
    versions: [terms, privacy], current: [terms, privacy], strict: true,
    permissions: ["content.platform.read", "content.fixed.submit", "approval.request.create"],
    notices: [{ key, current, definition: null, metadata: { hasDraft: true, title: "上架说明" } }],
    resources: { [key]: { key, definition: null, item: { id: "notice_item", resourceKey: key, revision: "2" },
      current, baseline: null, draft, published, versions: [draft, published] } },
  });
  const nav = h.host.querySelector("nav[aria-label='协议条款目录']");
  assert.match(nav.textContent, /协议与告知/);
  assert.match(nav.textContent, /页面说明/);
  assert.match(nav.textContent, /上架出租/);
  assert.match(nav.textContent, /账号详情/);
  for (const label of ["出租上架须知", "安全箱填写说明", "库存申报说明", "日耗与租期说明", "租用费用说明"]) assert.ok(h.button(label), label);
  assert.equal(h.button("租号流程说明"), undefined, "无用户站入口的说明不参与发布");
  await h.click("出租上架须知");
  assert.ok(h.reads.filter(path => path.includes("placement%3APUBLISH_NOTICE")).length >= 2, "StrictMode 重放后仍应读取当前说明");
  assert.equal(h.host.querySelector("[aria-label='搜索场景说明']"), null);
  assert.equal(h.button("返回文档列表"), undefined);
  assert.ok(h.host.querySelector("[aria-label='内容编辑器']"));
  const readsBeforeSubmission = h.reads.filter(path => path.includes("placement%3APUBLISH_NOTICE")).length;
  await h.click("提交发布审批");
  await h.type(document.body.querySelector("[role='dialog'] textarea"), "更新上架场景说明");
  await h.click("提交审批");
  assert.deepEqual(h.writes.map(write => write.path), ["/api/bff/admin/legal-documents/fixed-document-submissions"]);
  assert.deepEqual(h.writes[0].body.items, [{
    kind: "NOTICE", key, draftVersionId: draft.id, baseVersionId: published.id, digest: await plateDigest(noticeDocument),
  }]);
  assert.ok(h.reads.filter(path => path.includes("placement%3APUBLISH_NOTICE")).length > readsBeforeSubmission, "审批提交后应重新读取当前说明");
});

test("page explanation navigation remains platform-scoped", async t => {
  const h = await harness(t, { versions: [version({})], permissions: ["content.read"] });
  assert.equal(h.button("出租上架须知"), undefined);
  assert.equal(h.button("租号流程说明"), undefined);
  assert.equal(h.reads.some(path => path.includes("/content/resources")), false);
});

test("direct page explanation can retry a failed read", async t => {
  const key = "placement:PUBLISH_NOTICE";
  const document = { ...plate("上架说明正文"), preset: "notice" };
  const payload = { kind: "notice", title: "上架说明", format: "plate", schemaVersion: 1, document, mediaIds: [] };
  const draft = { id: "notice_draft", sequence: 1, state: "DRAFT", revision: "1", title: payload.title, payload, updatedAt: "2026-11-01T00:00:00.000Z" };
  const current = { key, payload, kind: "notice", media: [], state: "available", source: "MANAGED", version: null };
  let fail = true;
  const h = await harness(t, {
    versions: [version({})], permissions: ["content.platform.read"],
    resources: { [key]: { key, definition: null, item: { id: "notice_item", resourceKey: key, revision: "1" }, current, baseline: null, draft, published: null, versions: [draft] } },
    readResponse: path => path.includes("placement%3APUBLISH_NOTICE") && fail ? (fail = false, Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 503 })) : null,
  });
  await h.click("出租上架须知");
  assert.ok(h.button("重试读取内容"));
  assert.equal(h.host.querySelector("[aria-label='搜索场景说明']"), null);
  await h.click("重试读取内容");
  assert.ok(h.host.querySelector("[aria-label='内容编辑器']"));
});

test("direct page explanation can still read an archived version", async t => {
  const key = "placement:PUBLISH_NOTICE";
  const payload = text => ({ kind: "notice", title: "上架说明", format: "plate", schemaVersion: 1, document: { ...plate(text), preset: "notice" }, mediaIds: [] });
  const live = { id: "notice_live", sequence: 2, state: "PUBLISHED", revision: "2", title: "上架说明", payload: payload("当前正文"), publishedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
  const archived = { ...live, id: "notice_archived", sequence: 1, state: "SUPERSEDED", payload: payload("历史说明正文") };
  const current = { key, payload: live.payload, kind: "notice", media: [], state: "available", source: "MANAGED", version: null };
  const h = await harness(t, {
    versions: [version({})], permissions: ["content.platform.read"],
    resources: { [key]: { key, definition: null, item: { id: "notice_item", resourceKey: key, revision: "2" }, current, baseline: null, draft: null, published: live, versions: [live, archived] } },
  });
  await h.click("出租上架须知");
  const history = [...h.host.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "版本历史");
  assert.ok(history);
  await act(async () => history.querySelector("summary").click());
  const row = [...history.querySelectorAll("tr")].find(node => node.textContent.includes("历史"));
  assert.ok(row);
  await act(async () => row.querySelector("button").click());
  assert.match(document.body.querySelector("[role='dialog']").textContent, /历史说明正文/);
  assert.ok(h.reads.some(path => path.includes("/versions/notice_archived")));
});

test("initial release batches both agreements and optional page explanations", async t => {
  const terms = version({ id: "terms_draft", docType: "PLATFORM_TERMS" });
  const privacy = version({ id: "privacy_draft", docType: "PLATFORM_PRIVACY" });
  const key = "placement:PUBLISH_NOTICE";
  const noticeDocument = { ...plate("首次发布的说明正文"), preset: "notice" };
  const payload = { kind: "notice", title: "上架说明", format: "plate", schemaVersion: 1, document: noticeDocument, mediaIds: [] };
  const draft = { id: "notice_initial", sequence: 1, state: "DRAFT", revision: "1", title: payload.title, payload, updatedAt: "2026-11-01T00:00:00.000Z" };
  const current = { key, payload, kind: "notice", media: [], state: "available", source: "MANAGED", version: null };
  const h = await harness(t, {
    versions: [terms, privacy], current: [], permissions: ["content.platform.read", "content.fixed.submit", "approval.request.create"],
    notices: [{ key, current, definition: null, metadata: { hasDraft: true, title: payload.title } }],
    resources: { [key]: { key, definition: null, item: { id: "notice_item", resourceKey: key, revision: "1" }, current, baseline: null, draft, published: null, versions: [draft] } },
  });
  await h.click("出租上架须知");
  assert.equal(h.button("提交发布审批").disabled, true);
  await h.click("平台服务协议");
  await h.click("提交发布审批");
  const checkbox = document.body.querySelector("[aria-label='上架说明'][role='checkbox']");
  assert.ok(checkbox, "页面说明可随首次协议一并提交");
  await act(async () => checkbox.parentElement.querySelector("input[type='checkbox']").click());
  assert.equal(checkbox.getAttribute("aria-checked"), "true", checkbox.parentElement.outerHTML);
  await h.type(document.body.querySelector("[role='dialog'] textarea"), "首次发布协议与说明");
  await h.click("提交审批");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  const submission = h.writes.find(write => write.path.includes("/fixed-document-submissions"));
  assert.ok(submission, `未发送审批：${h.text()}`);
  assert.deepEqual(submission.body.items.map(item => item.kind), ["PLATFORM_TERMS", "PLATFORM_PRIVACY", "NOTICE"]);
  assert.equal(submission.body.items[2].key, key);
  assert.equal(submission.body.items[2].digest, await plateDigest(noticeDocument));
});

test("switching page explanations protects the unsaved editor", async t => {
  const makeDetail = (key, title) => {
    const document = { ...plate(`${title}正文`), preset: "notice" };
    const payload = { kind: "notice", title, format: "plate", schemaVersion: 1, document, mediaIds: [] };
    const draft = { id: `${key}_draft`, sequence: 1, state: "DRAFT", revision: "1", title, payload, updatedAt: "2026-11-01T00:00:00.000Z" };
    const current = { key, payload, kind: "notice", media: [], state: "available", source: "MANAGED", version: null };
    return { key, definition: null, item: { id: `${key}_item`, resourceKey: key, revision: "1" }, current, baseline: null, draft, published: null, versions: [draft] };
  };
  const first = makeDetail("placement:PUBLISH_NOTICE", "上架说明");
  const second = makeDetail("placement:RENTAL_FEES", "费用说明");
  const h = await harness(t, { versions: [version({})], permissions: ["content.platform.read", "content.platform.edit"], resources: { [first.key]: first, [second.key]: second } });
  await h.click("出租上架须知");
  await h.type(h.host.querySelector("[aria-label='文档标题']"), "尚未保存的标题");
  assert.equal(h.dirty.at(-1), true);
  const readsBeforeRefresh = h.reads.filter(path => path.includes("placement%3APUBLISH_NOTICE")).length;
  await h.refresh();
  assert.equal(h.reads.filter(path => path.includes("placement%3APUBLISH_NOTICE")).length, readsBeforeRefresh);
  assert.equal(h.host.querySelector("[aria-label='文档标题']").value, "尚未保存的标题");
  await h.click("租用费用说明");
  assert.match(h.text(), /放弃未保存的修改/);
  assert.equal(h.reads.some(path => path.includes("placement%3ARENTAL_FEES")), false);
  await h.click("继续编辑");
  assert.equal(h.host.querySelector("[aria-label='文档标题']").value, "尚未保存的标题");
  await h.click("租用费用说明");
  await h.click("放弃修改并继续");
  assert.equal(h.host.querySelector("[aria-label='文档标题']").value, "费用说明");
  assert.ok(h.reads.some(path => path.includes("placement%3ARENTAL_FEES")));
});
