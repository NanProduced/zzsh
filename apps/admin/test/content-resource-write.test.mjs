import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { DEFAULT_RESOURCES, RESOURCE_DEFINITIONS } from "@zzsh/content";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const detail = key => ({ key, item: { id: "item_1", revision: "2" }, current: { key }, draft: { id: "draft_1", sequence: 1 } });
const pause = () => new Promise(resolve => setTimeout(resolve, 12));

async function harness(t, fetcher) {
  const browser = new Window({ url: "http://127.0.0.1:3101/content" });
  Object.assign(globalThis, { window: browser, document: browser.document, localStorage: browser.localStorage, Event: browser.Event, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  Object.defineProperty(browser.navigator, "locks", { value: { request: async (_key, _options, operation) => operation({}) }, configurable: true });
  const originalFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    const request = { path: url.pathname, query: url.searchParams, method: init.method ?? "GET", key: new Headers(init.headers).get("idempotency-key"), body: typeof init.body === "string" ? JSON.parse(init.body) : null };
    requests.push(request); return fetcher(request);
  };
  const source = await createOfflineAdminSource({ root: fileURLToPath(new URL("..", import.meta.url)) });
  const module = await source.ssrLoadModule("/src/views/content-resource-write.ts");
  const { createRoot } = await import("react-dom/client");
  const container = browser.document.createElement("div"); browser.document.body.appendChild(container);
  let root = createRoot(container), current;
  function Probe({ session = "session_1" }) { current = module.useContentResourceWrite("admin_1", session); return null; }
  const render = async session => { await act(async () => { root.render(createElement(Probe, { session })); await pause(); }); };
  await render("session_1");
  t.after(async () => { await act(async () => root.unmount()); await source.close(); globalThis.fetch = originalFetch; browser.happyDOM.abort(); });
  return { browser, module, source, requests, get current() { return current; }, render, tick: async () => act(async () => { await pause(); }), remount: async () => { await act(async () => root.unmount()); root = createRoot(container); await render("session_1"); } };
}

test("media and restore commands use their restricted endpoints", async t => {
  const h = await harness(t, () => { throw new Error("unexpected request"); });
  assert.deepEqual(h.module.contentWriteRequest("placement:FOLLOW", "content.resource.media-draft.save"), { path: "/content/resources/placement%3AFOLLOW/media-draft", method: "PUT" });
  assert.deepEqual(h.module.contentWriteRequest("guide:alpha", "content.resource.draft.restore"), { path: "/content/resources/guide%3Aalpha/restore", method: "POST" });
  const record = { schema: 1, adminId: "admin_1", resourceId: "guide:alpha", operation: "content.resource.publish", key: "idem_abcdefgh", fingerprint: "a".repeat(64), versionId: "draft_1", expectedRevision: "9" };
  assert.equal(h.module.parsePendingContent(JSON.stringify(record), "admin_1").versionId, "draft_1");
  assert.throws(() => h.module.parsePendingContent(JSON.stringify({ ...record, expectedRevision: "zero" }), "admin_1"));
});

test("unknown publication freezes original key, fingerprint and draft version, blocks a changed request", async t => {
  const h = await harness(t, () => json({ error: { code: "INTERNAL_ERROR" } }, 503));
  const body = { versionId: "draft_1", expectedRevision: "7" };
  await act(async () => { await h.current.write("guide:alpha", "content.resource.publish", body); });
  const original = JSON.parse(h.browser.localStorage.getItem(h.module.contentPendingKey("admin_1")));
  assert.equal(original.versionId, "draft_1"); assert.equal(original.expectedRevision, "7");
  assert.equal(original.fingerprint, await h.module.contentFingerprint("content.resource.publish", "guide:alpha", body));
  await act(async () => { await h.current.write("guide:alpha", "content.resource.publish", { versionId: "draft_2", expectedRevision: "8" }); });
  assert.equal(h.requests.filter(row => row.method !== "GET").length, 1);
  assert.deepEqual(JSON.parse(h.browser.localStorage.getItem(h.module.contentPendingKey("admin_1"))), original);
  assert.ok(h.current.locked && h.current.error.includes("结果尚未确认"));
});

test("double click and caller mutation cannot change the fingerprinted request", async t => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const h = await harness(t, () => response);
  const body = { versionId: "draft_1", expectedRevision: "7", payload: { markdown: "原始正文" } };
  let first, second;
  await act(async () => { first = h.current.write("guide:alpha", "content.resource.draft.save", body); body.payload.markdown = "后来修改"; second = h.current.write("guide:alpha", "content.resource.draft.save", body); await pause(); });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].body.payload.markdown, "原始正文");
  assert.equal(await second, undefined);
  await act(async () => { finish(json(detail("guide:alpha"))); await first; });
  assert.equal(h.browser.localStorage.getItem(h.module.contentPendingKey("admin_1")), null);
});

test("late success after remount clears recovery metadata without returning an old document", async t => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const h = await harness(t, () => response);
  let first;
  await act(async () => { first = h.current.write("guide:alpha", "content.resource.publish", { versionId: "draft_1", expectedRevision: "7" }); await pause(); });
  await h.remount(); assert.equal(h.current.pending.resourceId, "guide:alpha");
  let returned;
  await act(async () => { finish(json(detail("guide:alpha"))); returned = await first; await pause(); });
  assert.equal(returned, undefined); assert.equal(h.current.pending, null); assert.equal(h.current.success, undefined);
});

test("receipt recovery only reads using the original command identity", async t => {
  const h = await harness(t, row => row.method !== "GET" ? json({ error: { code: "INTERNAL_ERROR" } }, 503) : row.path.endsWith("operation-result") ? json({ receipt: "RECORDED", operation: "content.resource.media-draft.save", resourceId: "placement:FOLLOW", responseStatus: 200, result: { itemId: "item_1" } }) : json(detail("placement:FOLLOW")));
  await act(async () => { await h.current.write("placement:FOLLOW", "content.resource.media-draft.save", { versionId: "draft_1", expectedRevision: "4", media: { qrMediaId: "media_1" } }); });
  const original = h.current.pending;
  await act(async () => { await h.current.recover(); });
  assert.equal(h.requests.filter(row => row.method !== "GET").length, 1);
  const receipt = h.requests.find(row => row.path.endsWith("operation-result"));
  assert.equal(receipt.key, original.key); assert.equal(receipt.query.get("fingerprint"), original.fingerprint);
  assert.equal(receipt.query.get("resourceId"), original.resourceId); assert.equal(h.current.pending, null);
});

test("placement drafts contain only media references and shared QR dimensions reject undersized choices", async t => {
  const h = await harness(t, () => { throw new Error("unexpected request"); });
  const { placementMedia, contentMediaChoiceIssue } = await h.source.ssrLoadModule("/src/views/content-media-editor.tsx");
  assert.deepEqual(placementMedia(DEFAULT_RESOURCES["placement:FOLLOW"]), { qrMediaId: null });
  const carousel = placementMedia(DEFAULT_RESOURCES["placement:HOME_HERO"]);
  assert.ok(carousel.slides.length > 0);
  for (const row of carousel.slides) assert.deepEqual(Object.keys(row), ["id", "mediaId", "mobileMediaId"]);
  const definition = RESOURCE_DEFINITIONS.find(row => row.key === "placement:FOLLOW");
  assert.ok(contentMediaChoiceIssue(definition, { width: 240, height: 240 }));
  assert.equal(contentMediaChoiceIssue(definition, { width: 256, height: 256 }), undefined);
  assert.ok(contentMediaChoiceIssue(definition, { width: 512, height: 256 }));
});

test("Markdown toolbar omits unsupported HTML comments and retains supported writing commands", async t => {
  const h = await harness(t, () => { throw new Error("unexpected request"); });
  const { contentMarkdownCommands } = await h.source.ssrLoadModule("/src/views/content-markdown-input.tsx");
  const names = contentMarkdownCommands.map(command => command.name);
  assert.ok(!names.includes("comment"));
  assert.ok(contentMarkdownCommands.every(command => !String(command.buttonProps?.title ?? "").includes("插入注释")));
  for (const name of ["bold", "italic", "link", "quote", "table"]) assert.ok(names.includes(name), `${name} remains available`);
});
