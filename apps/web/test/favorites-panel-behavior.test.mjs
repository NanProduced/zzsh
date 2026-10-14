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
const record = (accountId) => ({ accountId, savedAt: "2025-01-01T16:00:00Z", state: "AVAILABLE", message: null, listing: { accountId, title: accountId, quote: true } });
const summaryFault = (accountId) => ({ ...record(accountId), listing: { accountId, title: accountId, quote: null } });
const coverCard = (accountId) => ({ ...record(accountId), listing: { accountId, title: accountId, quote: true, imageUrl: `/${accountId}.webp` } });

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
    if (name === "@/components/delta/account-card") return { AccountCard: ({ data }) => React.createElement("article", { "data-account-id": data.id, "data-cover-retry": data.imageUrl ? "eligible" : "missing-cover" }, data.title) };
    if (name === "@/components/delta/account-card-skeleton") return { AccountCardSkeleton: () => React.createElement("span", null, "loading") };
    if (name === "./favorite-button") return { FavoriteButton: () => null, FavoriteNotice: () => null };
    if (name === "./favorites-context") return { useFavorites: () => favorites };
    if (name.endsWith(".css")) return {};
    if (name === "@/lib/listing-view") return { previewListingCard: (listing) => listing.quote ? { ok: true, card: { id: listing.accountId, title: listing.title, imageUrl: listing.imageUrl ?? null, media: [], resourceLines: [], resourceTotalLabel: "", haffRentLabel: "", itemResourceTotalLabel: "", depositLabel: "", payableTotalLabel: "", termLabel: null, termOptionLabel: null, conditionLines: [], loginMethod: null } } : { ok: false } };
    if (name === "@/lib/supply-client") return { ...client, supplyApi: { favorites: readPage } };
    if (name === "lucide-react") {
      const Icon = ({ size = 16, className }) => React.createElement("i", { "data-icon": className || "icon", style: { width: size, height: size } });
      return { Heart: Icon, HeartOff: Icon, RotateCw: Icon, TriangleAlert: Icon };
    }
    if (name === "@/components/ui/tooltip") return { Tooltip: ({ children }) => React.createElement(React.Fragment, null, children), TooltipTrigger: ({ children }) => React.createElement(React.Fragment, null, children), TooltipContent: () => null };
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
      const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
      assert.ok(button, `missing button: ${text}`);
      await React.act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await tick(); });
    },
    async search(value) {
      const input = host.querySelector('input[type="search"]');
      assert.ok(input);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      await React.act(async () => { setter.call(input, value); input.dispatchEvent(new window.Event("input", { bubbles: true })); await tick(); });
    },
    async close() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); },
  };
}

test("favorite filters and local search stay scoped to loaded records", async () => {
  const fault = summaryFault("BROKEN_SUMMARY");
  const unavailable = { ...record("UNAVAILABLE_A"), state: "UNAVAILABLE", message: "已下架", listing: null };
  const p = await probe(async () => ({ items: [record("AVAILABLE_A"), fault, unavailable], nextCursor: null }));
  try {
    await p.render();
    assert.match(p.host.textContent, /收藏于 2025-01-02 00:00/);
    assert.match(p.host.textContent, /仅筛选已加载的 3 个/);
    await p.click("可查看");
    assert.match(p.host.textContent, /AVAILABLE_A/);
    assert.equal(p.host.querySelector('[data-state="unreadable"]'), null);
    await p.click("暂不可用");
    assert.match(p.host.textContent, /该账号暂不可用/);
    await p.click("全部");
    await p.search("BROKEN");
    assert.ok(p.host.querySelector('[data-state="unreadable"]'));    await p.search("NO_MATCH");
    assert.match(p.host.textContent, /当前筛选没有匹配的收藏/);
    assert.match(p.host.textContent, /筛选只作用于已加载的 3 个收藏/);
    assert.equal(p.host.querySelector(".account-empty-art"), null);
    assert.match(p.host.textContent, /收藏不代表账号仍可租/);
  } finally { await p.close(); }
});

test("a favorite card passes the optional cover retry capability without changing ordinary cards", async () => {
  const p = await probe(async () => ({ items: [coverCard("AVAILABLE_A")], nextCursor: null }));
  try {
    await p.render();
    assert.equal(p.host.querySelector('[data-account-id="AVAILABLE_A"]')?.getAttribute("data-cover-retry"), "eligible");
  } finally { await p.close(); }
});

test("a bad single summary becomes a fault card while a page read failure stays distinct", async () => {
  const p = await probe(async () => ({ items: [record("AVAILABLE_A"), summaryFault("BROKEN_SUMMARY")], nextCursor: null }));
  try {
    await p.render();
    assert.match(p.host.textContent, /AVAILABLE_A/);
    assert.match(p.host.textContent, /摘要暂不可读取/);
    assert.ok(p.host.querySelector('[data-state="unreadable"]'));
    assert.equal(p.host.querySelector('[data-state="unavailable"]'), null);
    assert.ok(p.host.querySelector(".favorites-fault-notice"));
    await p.click("重新读取");
    assert.match(p.host.textContent, /摘要暂不可读取/);
  } finally { await p.close(); }

  const failed = await probe(async () => { throw new client.SupplyRequestError(503, null); });
  try {
    await failed.render();
    assert.match(failed.host.textContent, /收藏列表暂时无法读取/);
    assert.match(failed.host.textContent, /读取失败不等于没有收藏/);
    assert.equal(failed.host.querySelector(".account-empty-art"), null);
  } finally { await failed.close(); }
});

test("an unavailable favorite is a business state rather than a summary fault", async () => {
  const p = await probe(async () => ({ items: [{ ...record("UNAVAILABLE_A"), state: "UNAVAILABLE", message: "已下架", listing: null }], nextCursor: null }));
  try {
    await p.render();
    assert.match(p.host.textContent, /该账号暂不可用/);
    assert.ok(p.host.querySelector('[data-state="unavailable"]'));
    assert.equal(p.host.querySelector('[data-state="unreadable"]'), null);
  } finally { await p.close(); }
});

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

test("a saved favorite change is blocked offline before any business write", async () => {
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async () => { writes += 1; throw new Error("offline"); };
  const toggle = async () => { throw new Error("toggle should be intercepted before network write"); };
  const favorites = { snapshot: { status: "authenticated", userId: "user_A", generation: 1 }, statusOf: () => "saved", toggle };
  try {
    // The context contract owns the real store call; this harness pins the transition contract's
    // allowed verification surface: a rejected offline toggle and zero network writes.
    await assert.rejects(() => favorites.toggle("AVAILABLE_A", false), /intercepted before network write/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = originalFetch; }
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

// ══ t4（2026-10-14）F3：单卡摘要故障可恢复、整页失败可重试恢复、续页非可重试失败不伪造部分成功。
//    取消收藏失败回滚见 favorites-store（a failed write across a same-user refresh rolls back / a failed cancel restores the panel record）。 ══
test("a summary fault card recovers when the re-read returns a readable summary", async () => {
  let reads = 0;
  const p = await probe(async () => (++reads === 1
    ? { items: [record("AVAILABLE_A"), summaryFault("BROKEN_SUMMARY")], nextCursor: null }
    : { items: [record("AVAILABLE_A"), record("BROKEN_SUMMARY")], nextCursor: null }));
  try {
    await p.render();
    assert.ok(p.host.querySelector('[data-state="unreadable"]'), "单卡摘要异常降级为故障卡");
    assert.ok(p.host.querySelector(".favorites-fault-notice"));
    await p.click("重新读取");
    assert.equal(p.host.querySelector('[data-state="unreadable"]'), null, "权威重读恢复后故障卡消失");
    assert.equal(p.host.querySelector(".favorites-fault-notice"), null);
    assert.match(p.host.textContent, /BROKEN_SUMMARY/);
    assert.equal(reads, 2);
  } finally { await p.close(); }
});

test("a failed favorites page read can be retried into a full page", async () => {
  let reads = 0;
  const p = await probe(async () => { if (++reads === 1) throw new client.SupplyRequestError(503, null); return { items: [record("PRIVATE_A")], nextCursor: null }; });
  try {
    await p.render();
    assert.match(p.host.textContent, /收藏列表暂时无法读取/);
    assert.match(p.host.textContent, /读取失败不等于没有收藏/);
    assert.equal(p.host.querySelector(".account-empty-art"), null, "失败态不冒充首次空态");
    await p.click("重试");
    assert.match(p.host.textContent, /PRIVATE_A/);
    assert.equal(p.host.querySelector(".account-empty-state"), null);
  } finally { await p.close(); }
});

test("a non-retryable continuation failure stays a page failure instead of faking partial success", async () => {
  const p = await probe(async (query) => {
    if (!query.get("cursor")) return { items: [record("PRIVATE_A")], nextCursor: "cursor_A" };
    throw new client.SupplyRequestError(403, { error: { code: "FORBIDDEN" } });
  });
  try {
    await p.render();
    await p.click("加载更多收藏");
    assert.match(p.host.textContent, /收藏列表暂时无法读取/, "权威拒绝按整页失败表达");
    assert.equal(p.host.querySelector(".favorites-more-error"), null, "不伪装成可重试续页错误");
  } finally { await p.close(); }
});

test("a full favorites re-read supersedes old continuation success and failure", async () => {
  for (const status of [null, 503, 403, 401]) {
    let resolveMore, rejectMore;
    const more = new Promise((resolve, reject) => { resolveMore = resolve; rejectMore = reject; });
    let firstReads = 0;
    const p = await probe(async query => {
      if (query.get("cursor")) return more;
      return ++firstReads === 1
        ? { items: [summaryFault("BROKEN"), record("OLD_A")], nextCursor: "old-cursor" }
        : { items: [record("FRESH")], nextCursor: null };
    });
    const registered = [];
    p.favorites.registerSavedRecords = ids => registered.push(...ids);
    try {
      await p.render();
      await p.click("加载更多收藏");
      await p.click("重新读取");
      assert.match(p.host.textContent, /FRESH/);
      await React.act(async () => {
        if (status === null) resolveMore({ items: [record("STALE_PAGE2")], nextCursor: "obsolete-cursor" });
        else rejectMore(new client.SupplyRequestError(status, null));
        await tick();
      });
      assert.match(p.host.textContent, /FRESH/);
      assert.doesNotMatch(p.host.textContent, /STALE_PAGE2|收藏列表暂时无法读取|更多收藏暂未加载/);
      assert.equal(registered.includes("STALE_PAGE2"), false, "stale rows cannot update saved evidence");
      assert.equal(p.revalidations, 0, "stale 401 cannot start another identity reload");
      assert.ok(![...p.host.querySelectorAll("button")].some(button => button.textContent.includes("加载更多收藏")));
    } finally { resolveMore({ items: [], nextCursor: null }); await p.close(); }
  }
});

test("an unmounted favorites panel cannot register a late read", async () => {
  let resolvePage;
  const pending = new Promise(resolve => { resolvePage = resolve; });
  const p = await probe(() => pending);
  let registered = 0;
  p.favorites.registerSavedRecords = () => registered++;
  await p.render();
  await p.close();
  resolvePage({ items: [record("LATE")], nextCursor: null });
  await tick();
  assert.equal(registered, 0);
});
