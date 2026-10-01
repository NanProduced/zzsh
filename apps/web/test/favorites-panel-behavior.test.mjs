import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(tree, "package.json"));
const React = require("react");
const { Window } = require("happy-dom");
const ts = require("typescript");
const client = require(path.join(tree, "apps/web/src/lib/supply-client.ts"));
const compiled = ts.transpileModule(fs.readFileSync(path.join(tree, "apps/web/src/components/favorites/favorites-panel.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const tick = () => new Promise(setImmediate);
const record = (accountId) => ({ accountId, listing: { accountId, title: accountId } });

async function probe(readPage) {
  const window = new Window({ url: "http://127.0.0.1:3100/account?view=favorites" });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  let revalidations = 0;
  const favorites = { snapshot: { status: "authenticated", userId: "user_A", generation: 1 }, statusOf: () => "saved", registerSavedRecords() {}, reload() { revalidations += 1; } };
  const module = new Module(path.join(tree, "favorites-panel-probe.cjs"));
  module.filename = path.join(tree, "favorites-panel-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "next/link") return (props) => React.createElement("a", props);
    if (name === "@/components/delta/account-card") return { AccountCard: ({ data }) => React.createElement("article", { "data-account-id": data.accountId }, data.title) };
    if (name === "@/components/delta/account-card-skeleton") return { AccountCardSkeleton: () => React.createElement("span", null, "loading") };
    if (name === "./favorite-button") return { FavoriteButton: () => null, FavoriteNotice: () => null };
    if (name === "./favorites-context") return { useFavorites: () => favorites };
    if (name === "@/lib/listing-view") return { toListingCard: (listing) => listing };
    if (name === "@/lib/supply-client") return { ...client, supplyApi: { favorites: readPage } };
    return require(name);
  };
  module._compile(compiled, module.filename);
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  const commits = [];
  return {
    host, favorites, commits,
    get revalidations() { return revalidations; },
    async render() {
      await React.act(async () => root.render(React.createElement(React.Profiler, { id: "favorites", onRender: () => commits.push(host.textContent) }, React.createElement(module.exports.FavoritesPanel))));
      await tick();
    },
    async click(text) {
      const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
      assert.ok(button, `missing button: ${text}`);
      await React.act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await tick(); });
    },
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); },
  };
}

test("a failed favorites continuation keeps records and retries the same cursor", async () => {
  const cursors = [];
  let attempts = 0;
  const p = await probe(async (query) => {
    const cursor = query.get("cursor"); cursors.push(cursor);
    if (!cursor) return { items: [record("PRIVATE_A")], nextCursor: "cursor_A" };
    if (++attempts === 1) throw new client.SupplyRequestError(503, null);
    return { items: [record("PRIVATE_B")], nextCursor: null };
  });
  try {
    await p.render();
    await p.click("加载更多收藏");
    assert.match(p.host.textContent, /PRIVATE_A/);
    assert.ok(p.host.querySelector(".favorites-more-error"));
    assert.equal(p.host.querySelector(".account-empty-state"), null);
    await p.click("重试加载");
    assert.match(p.host.textContent, /PRIVATE_A/);
    assert.match(p.host.textContent, /PRIVATE_B/);
    assert.deepEqual(cursors, [null, "cursor_A", "cursor_A"]);
    assert.equal(p.host.querySelector(".favorites-more-error"), null);
  } finally { await p.close(); }
});

test("a favorites continuation 401 clears records and reconfirms identity", async () => {
  const p = await probe(async (query) => {
    if (!query.get("cursor")) return { items: [record("PRIVATE_A")], nextCursor: "cursor_A" };
    throw new client.SupplyRequestError(401, { error: { code: "UNAUTHENTICATED" } });
  });
  try {
    await p.render(); await p.click("加载更多收藏");
    assert.doesNotMatch(p.host.textContent, /PRIVATE_A/);
    assert.equal(p.revalidations, 1);
    assert.equal(p.host.querySelector(".favorites-more-error"), null);
  } finally { await p.close(); }
});

test("a new favorites generation never commits the previous identity's records", async () => {
  let resolveB;
  const pendingB = new Promise((resolve) => { resolveB = resolve; });
  let phase = "A";
  const p = await probe(async () => phase === "A" ? { items: [record("PRIVATE_A")], nextCursor: null } : pendingB);
  try {
    await p.render();
    phase = "B"; p.favorites.snapshot = { status: "authenticated", userId: "user_B", generation: 2 };
    const previousCommits = p.commits.length;
    await p.render();
    assert.ok(p.commits.slice(previousCommits).every((commit) => !commit.includes("PRIVATE_A")));
    await React.act(async () => { resolveB({ items: [record("PRIVATE_B")], nextCursor: null }); await tick(); });
    assert.match(p.host.textContent, /PRIVATE_B/);
  } finally { resolveB({ items: [], nextCursor: null }); await p.close(); }
});
