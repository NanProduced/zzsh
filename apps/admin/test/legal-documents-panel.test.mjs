import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createOfflineAdminSource } from "./offline-admin-source.mjs";

test("legal drafts require real input and cannot seal unsaved edits", async () => {
  const browser = new Window({ url: "http://127.0.0.1:3101/content" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const originalFetch = globalThis.fetch;
  const { createRoot } = await import("react-dom/client");
  const vite = await createOfflineAdminSource({ root: fileURLToPath(new URL("..", import.meta.url)) });
  const writes = [];
  let versions = [];
  globalThis.fetch = async (input, init = {}) => {
    if (!init.method || init.method === "GET") return Response.json({ versions });
    const body = JSON.parse(init.body); writes.push({ path: String(input), body });
    versions = [{ id: "legal_1", docType: "PLATFORM_TERMS", status: "DRAFT", revision: String(writes.length), title: body.title, body: body.body, digest: "d".repeat(64), effectiveAt: null, sealedAt: null, createdAt: "2026-10-30T00:00:00Z" }];
    return Response.json(versions[0]);
  };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const button = text => [...host.querySelectorAll("button")].find(node => node.textContent.includes(text));
  const click = async text => act(async () => button(text).click());
  const type = async (node, value) => act(async () => {
    const proto = node.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(new browser.Event("input", { bubbles: true }));
    node.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  try {
    const { LegalDocumentsPanel } = await vite.ssrLoadModule("/src/views/legal-documents-panel.tsx");
    await act(async () => root.render(createElement(LegalDocumentsPanel, { snapshot: { authenticated: true, adminUserId: "admin_1", security: { isBoss: true }, permissions: ["content.platform.read", "content.platform.edit", "content.platform.publish"] } })));
    assert.equal(button("新建草稿").disabled, false);
    await click("新建草稿");
    assert.equal(writes.length, 0, "opening a draft must not persist placeholder text");
    await click("保存草稿");
    assert.equal(writes.length, 0, "blank content cannot be saved");
    await type(host.querySelector("input[maxlength='160']"), "平台服务协议");
    await type(host.querySelector("textarea"), "待审阅的合成测试正文");
    await click("保存草稿");
    assert.equal(writes.length, 1, host.textContent);
    assert.equal(writes[0].body.body, "待审阅的合成测试正文");
    assert.equal(button("封存并生效").disabled, false);
    await type(host.querySelector("textarea"), "尚未保存的合成测试修订");
    assert.equal(button("封存并生效").disabled, true, "the visible unsaved body cannot seal an older saved body");
    assert.match(host.textContent, /请先保存，再封存/);
  } finally {
    await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch;
    await vite.close(); await browser.happyDOM.abort();
  }
});
