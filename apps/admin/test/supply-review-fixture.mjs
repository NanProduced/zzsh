import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

export const accountA = { id: "a", game_id: "game-1", revision: "7", owner_paused: false, staff_restricted: false, restriction_reason: null };
export const accountB = { id: "b", game_id: "game-1", revision: "4", owner_paused: true, staff_restricted: false, restriction_reason: null };
export const accountC = { id: "c", game_id: "game-1", revision: "2", owner_paused: false, staff_restricted: false, restriction_reason: null };

export function detail(account, reviewState, overrides = {}) {
  const published = reviewState === "PUBLISHED";
  const titles = { a: "三角洲 · 60M 满配战斗号", b: "三角洲 · 新练小号 10M", c: "三角洲 · 历史待审账号" };
  return {
    account,
    ownerName: account.id === "a" ? "号主阿辰" : account.id === "b" ? "号主小洛" : "号主老周",
    version: {
      id: `v-${account.id}`,
      sequence: "1",
      reviewState,
      releaseId: "rel-1",
      contentHash: `hash-${account.id}`,
      publication: published ? { source: "OWNER_DIRECT", publishedAt: "2026-09-23T08:43:00.000Z" } : null,
      termOption: { code: "term-1", displayName: "日消耗 10M", dailyConsumption: { quantity: "10000000", unit: "HAFF_BASE" } },
      attributeDisplay: {
        safeBox: { code: "box-a", displayName: null, mappingStatus: "UNCONFIRMED", issueCode: null },
        grading: null,
        loginMethod: null,
        serviceWindow: null,
      },
      declaration: {
        attributes: { safe_box_code: "box-a", vit_level: 6 },
        title: titles[account.id],
        description: "仓库截图与申报数量一致。",
        inventory: [{ itemId: "haff", quantity: "60000000" }],
        skins: [],
        entitlements: [],
        mediaBindings: [
          { assetId: "m-display", purpose: "ACCOUNT_DISPLAY", position: 0, reviewState: "NOT_REQUIRED", publicDisplayEligible: true, publiclyReadable: true },
          { assetId: "m-evidence", purpose: "ACCOUNT_EVIDENCE", position: 1, reviewState: "PENDING", publicDisplayEligible: false, publiclyReadable: false },
        ],
      },
      presentation: { items: [{ id: "haff", name: "哈夫币", unit: "HAFF_BASE" }], skins: [], entitlements: [] },
      quote: { resourceTotal: { amount: "7650.00" }, termSeconds: "518400" },
    },
    history: [
      {
        id: `v-${account.id}`,
        sequence: "1",
        origin: "USER",
        review_state: reviewState,
        title: "三角洲",
        content_hash: null,
        rule_release_id: "rel-1",
        created_at: "2026-09-23T08:43:00.000Z",
      },
    ],
    previousDeclaration: null,
    previousPresentation: undefined,
    decisions: [],
    duplicateHints: [],
    blockers: [],
    available: true,
    ...overrides,
  };
}
export const queueItem = (account, reviewState) => ({
  id: account.id,
  game_id: account.game_id,
  title: account.id === "a" ? "三角洲 · 60M 满配战斗号" : account.id === "b" ? "三角洲 · 新练小号 10M" : "三角洲 · 历史待审账号",
  owner_name: account.id === "a" ? "号主阿辰" : account.id === "b" ? "号主小洛" : "号主老周",
  game_name: "三角洲行动",
  review_state: reviewState,
  sequence: "1",
  owner_paused: account.owner_paused,
  staff_restricted: account.staff_restricted,
});

export async function mountHarness(t, { permissions, isBoss = true, fetchImpl, initialAccountId, initialQuery = {}, strict = false }) {
  const browser = new Window({ url: "http://127.0.0.1:4291/supply/reviews" });
  browser.Element.prototype.scrollIntoView = function () {};
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });
  const originalFetch = globalThis.fetch;
  const { createRoot } = await import("react-dom/client");
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  const writes = [];
  const routes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), browser.location.href);
    const method = init.method ?? "GET";
    if (method !== "GET") writes.push({ path: url.pathname, body: JSON.parse(init.body), rawBody: init.body, key: new Headers(init.headers).get("idempotency-key") });
    return fetchImpl(url, init, browser);
  };
  browser.confirm = () => true;
  const { SupplyListingReviewView } = await vite.ssrLoadModule("/src/views/supply-listing-review-view.tsx");
  const el = browser.document.createElement("div");
  browser.document.body.append(el);
  const root = createRoot(el);
  const render = async (identity = "admin", nextPermissions = permissions, accountId = initialAccountId, query = initialQuery, nonce = 0) => act(async () => {
    const component = createElement(SupplyListingReviewView, {
      snapshot: { authenticated: true, adminUserId: identity, session: { id: identity }, security: { isBoss }, permissions: nextPermissions },
      refreshNonce: nonce,
      initialAccountId: accountId,
      initialQuery: query,
      onOpenPath: (path,title) => routes.push({path,title}),
      onQueryChange: () => {},
      onDirtyChange: () => {},
    });
    root.render(
      strict ? createElement(StrictMode,null,component) : component,
    );
  });
  await render();
  const settle = async (ms = 20) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  await settle();
  const btn = (name) => [...el.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || x.textContent.trim()) === name);
  const click = async (node) => {
    assert.ok(node, "expected clickable node");
    await act(async () => {
      node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };
  const cleanup = async () => {
    if (root) await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await vite.close();
    await browser.happyDOM.abort();
  };
  t.after(cleanup);
  const fillReason = async (text) => {
    const input = el.querySelector("textarea"); assert.ok(input);
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value").set.call(input, text);
    await act(async () => input.dispatchEvent(new browser.Event("input", { bubbles: true })));
  };
  const open = async (id) => { await render("admin",permissions,id,{context:"review"}); await settle(); };
  return { browser, el, root, btn, click, settle, writes, routes, fillReason, open, render };
}
