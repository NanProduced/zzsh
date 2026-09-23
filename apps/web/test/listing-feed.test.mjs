import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(repoRoot, "package.json"));

function loadSource(file, dependencies = {}) {
  const fs = require("node:fs");
  const ts = require("typescript");
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => {
    if (name in dependencies) return dependencies[name];
    return name.startsWith(".")
      ? loadSource(path.resolve(path.dirname(file), name))
      : require(name);
  }, exports);
  return exports;
}

test("consuming a restored cursor snapshot keeps all replayed pages", async (t) => {
  const { Window } = require("happy-dom");
  const React = require("react");
  const { act, createElement, useEffect, useState } = React;
  const browser = new Window({ url: "http://127.0.0.1:4320/accounts" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });

  const { createRoot } = require("react-dom/client");
  const calls = [];
  const restoredCounts = [];
  let changeFilters;
  const supplyApi = {
    market: async (query) => {
      const cursor = query.get("cursor");
      calls.push({ cursor, q: query.get("q") });
      const start = cursor ? 20 : 0;
      const count = cursor ? 5 : 20;
      return {
        items: Array.from({ length: count }, (_, index) => ({ id: `account-${start + index}` })),
        nextCursor: cursor ? null : "page2",
        scanBudgetReached: false,
      };
    },
  };
  const { useListingFeed } = loadSource(path.join(repoRoot, "apps/web/src/components/market/use-listing-feed.ts"), {
    react: React,
    "@/lib/listing-filters": loadSource(path.join(repoRoot, "apps/web/src/lib/listing-filters.ts")),
    "@/lib/listing-feed-utils": loadSource(path.join(repoRoot, "apps/web/src/lib/listing-feed-utils.ts")),
    "@/lib/supply-client": { supplyApi, SupplyRequestError: class extends Error {} },
  });
  const filters = {
    game: "game_delta", q: null, filters: {}, sort: "latest", direction: "DESC",
    limit: 20, cursor: null, coreItemId: null, viewMode: "list",
  };
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);

  function ReturnConsumer() {
    const [replayCursors, setReplayCursors] = useState([null, "page2"]);
    const [currentFilters, setCurrentFilters] = useState(filters);
    changeFilters = setCurrentFilters;
    const feed = useListingFeed(currentFilters, null, { enabled: true, replayCursors });
    useEffect(() => {
      if (replayCursors && feed.status === "ready" && feed.requestedCursors.length === 2) {
        restoredCounts.push(feed.items.length);
        setReplayCursors(undefined);
      }
    }, [feed.items.length, feed.requestedCursors.length, feed.status, replayCursors]);
    return createElement("output", null, `${feed.status}:${feed.items.length}`);
  }

  t.after(async () => {
    await act(async () => root.unmount());
    browser.happyDOM.abort();
    for (const [key, value] of Object.entries(previous)) {
      if (key === "navigator") continue;
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
    else delete globalThis.navigator;
  });

  await act(async () => root.render(createElement(ReturnConsumer)));
  for (let attempt = 0; attempt < 100 && host.textContent !== "ready:25"; attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }

  assert.deepEqual(restoredCounts, [25]);
  assert.deepEqual(calls, [{ cursor: null, q: null }, { cursor: "page2", q: null }]);
  assert.equal(host.textContent, "ready:25");
  await act(async () => changeFilters({ ...filters, q: "fresh" }));
  for (let attempt = 0; attempt < 100 && host.textContent !== "ready:20"; attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.deepEqual(calls, [
    { cursor: null, q: null },
    { cursor: "page2", q: null },
    { cursor: null, q: "fresh" },
  ]);
  assert.equal(host.textContent, "ready:20");
});

test("snapshot consumption preserves pagination; filter changes, disable and unmount abort stale pages", async (t) => {
  const { Window } = require("happy-dom");
  const React = require("react");
  const { act, createElement, useEffect, useState } = React;
  const browser = new Window({ url: "http://127.0.0.1:4320/accounts" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });

  const { createRoot } = require("react-dom/client");
  const calls = [];
  const deferredPages = [];
  const deferredCursors = new Set(["page3", "page4"]);
  let writesAfterUnmount = 0;
  let isUnmounted = false;
  const supplyApi = {
    market: (query, signal) => {
      const cursor = query.get("cursor");
      calls.push({ cursor, q: query.get("q") });
      if (deferredCursors.has(cursor)) {
        deferredCursors.delete(cursor);
        return new Promise((resolve) => deferredPages.push({ resolve, signal }));
      }
      const start = cursor === "page2" ? 20 : cursor === "page3" ? 25 : cursor === "page4" ? 26 : 0;
      const count = cursor === "page2" ? 5 : cursor === "page3" || cursor === "page4" ? 1 : 20;
      return Promise.resolve({
        items: Array.from({ length: count }, (_, index) => ({ id: `account-${start + index}` })),
        nextCursor: cursor === null ? "page2" : cursor === "page2" ? "page3" : cursor === "page3" ? "page4" : null,
        scanBudgetReached: false,
      });
    },
  };
  const trackedReact = {
    ...React,
    useState(initial) {
      const [value, setValue] = React.useState(initial);
      return [value, (next) => {
        if (isUnmounted) writesAfterUnmount += 1;
        setValue(next);
      }];
    },
  };
  const { useListingFeed } = loadSource(path.join(repoRoot, "apps/web/src/components/market/use-listing-feed.ts"), {
    react: trackedReact,
    "@/lib/listing-filters": loadSource(path.join(repoRoot, "apps/web/src/lib/listing-filters.ts")),
    "@/lib/listing-feed-utils": loadSource(path.join(repoRoot, "apps/web/src/lib/listing-feed-utils.ts")),
    "@/lib/supply-client": { supplyApi, SupplyRequestError: class extends Error {} },
  });
  const filters = {
    game: "game_delta", q: null, filters: {}, sort: "latest", direction: "DESC",
    limit: 20, cursor: null, coreItemId: null, viewMode: "list",
  };
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let rootMounted = true;
  let setEnabled;
  let setReplayCursors;
  let setConsumeReplay;
  let setFilters;
  let latestFeed;
  let consumedSnapshots = 0;

  function ReturnConsumer() {
    const [enabled, updateEnabled] = useState(true);
    const [replayCursors, updateReplayCursors] = useState([null, "page2"]);
    const [consumeReplay, updateConsumeReplay] = useState(false);
    const [currentFilters, updateFilters] = useState(filters);
    setEnabled = updateEnabled;
    setReplayCursors = updateReplayCursors;
    setConsumeReplay = updateConsumeReplay;
    setFilters = updateFilters;
    const feed = useListingFeed(currentFilters, null, { enabled, replayCursors });
    latestFeed = feed;
    useEffect(() => {
      if (consumeReplay && replayCursors && feed.status === "ready" && feed.requestedCursors.length === 2) {
        consumedSnapshots += 1;
        setReplayCursors(undefined);
        setConsumeReplay(false);
      }
    }, [consumeReplay, feed.requestedCursors.length, feed.status, replayCursors]);
    return createElement("output", null, `${feed.status}:${feed.items.length}:${feed.isLoadingMore ? "more" : "idle"}`);
  }

  t.after(async () => {
    if (rootMounted) {
      await act(async () => root.unmount());
      rootMounted = false;
    }
    browser.happyDOM.abort();
    for (const [key, value] of Object.entries(previous)) {
      if (key === "navigator") continue;
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
    else delete globalThis.navigator;
  });

  async function waitFor(text) {
    for (let attempt = 0; attempt < 100 && host.textContent !== text; attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    assert.equal(host.textContent, text);
  }

  await act(async () => root.render(createElement(ReturnConsumer)));
  await waitFor("ready:25:idle");
  await act(async () => latestFeed.loadMore());
  assert.equal(deferredPages.length, 1);
  await waitFor("ready:25:more");
  await act(async () => setConsumeReplay(true));
  for (let attempt = 0; attempt < 100 && consumedSnapshots === 0; attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(consumedSnapshots, 1);
  assert.equal(deferredPages[0].signal.aborted, false);
  assert.equal(host.textContent, "ready:25:more");
  await act(async () => {
    deferredPages[0].resolve({ items: [{ id: "account-25" }], nextCursor: "page4", scanBudgetReached: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(host.textContent, "ready:26:idle");

  await act(async () => latestFeed.loadMore());
  await waitFor("ready:26:more");
  assert.equal(deferredPages.length, 2);
  await act(async () => setFilters({ ...filters, q: "fresh" }));
  await waitFor("ready:20:idle");
  assert.equal(deferredPages[1].signal.aborted, true);
  await act(async () => {
    deferredPages[1].resolve({ items: [{ id: "late-filter-page" }], nextCursor: null, scanBudgetReached: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(host.textContent, "ready:20:idle");

  deferredCursors.add("page2");
  await act(async () => latestFeed.loadMore());
  await waitFor("ready:20:more");
  await act(async () => setEnabled(false));
  assert.equal(host.textContent, "loading:0:idle");
  assert.equal(deferredPages[2].signal.aborted, true);
  await act(async () => {
    deferredPages[2].resolve({ items: [{ id: "late-disabled-page" }], nextCursor: null, scanBudgetReached: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(host.textContent, "loading:0:idle");

  await act(async () => {
    deferredCursors.add("page3");
    setReplayCursors([null, "page2"]);
    setEnabled(true);
  });
  await waitFor("ready:25:idle");
  await act(async () => latestFeed.loadMore());
  assert.equal(deferredPages.length, 4);

  isUnmounted = true;
  await act(async () => root.unmount());
  rootMounted = false;
  assert.equal(deferredPages[3].signal.aborted, true);
  await act(async () => {
    deferredPages[3].resolve({ items: [{ id: "late-unmounted-page" }], nextCursor: null, scanBudgetReached: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(calls.slice(0, 3), [
    { cursor: null, q: null },
    { cursor: "page2", q: null },
    { cursor: "page3", q: null },
  ]);
  assert.equal(writesAfterUnmount, 0);
});

test("refreshFirstPage aborts an in-flight next page and coalesces rapid refreshes", async (t) => {
  const { Window } = require("happy-dom");
  const React = require("react");
  const { act, createElement, useState } = React;
  const browser = new Window({ url: "http://127.0.0.1:4320/accounts?game=game_delta" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });

  const { createRoot } = require("react-dom/client");
  const calls = [];
  const deferred = [];
  let firstPages = 0;
  const supplyApi = {
    market: (query, signal) => {
      const cursor = query.get("cursor");
      calls.push(cursor);
      if (cursor === "page2") return new Promise((resolve) => deferred.push({ resolve, signal }));
      firstPages += 1;
      return Promise.resolve({
        items: [{ id: firstPages === 1 ? "old-first-page" : "fresh-first-page" }],
        nextCursor: firstPages === 1 ? "page2" : null,
        scanBudgetReached: false,
      });
    },
  };
  const { useListingFeed } = loadSource(path.join(repoRoot, "apps/web/src/components/market/use-listing-feed.ts"), {
    react: React,
    "@/lib/listing-filters": loadSource(path.join(repoRoot, "apps/web/src/lib/listing-filters.ts")),
    "@/lib/listing-feed-utils": loadSource(path.join(repoRoot, "apps/web/src/lib/listing-feed-utils.ts")),
    "@/lib/supply-client": { supplyApi, SupplyRequestError: class extends Error {} },
  });
  const filters = {
    game: "game_delta", q: null, filters: {}, sort: "latest", direction: "DESC",
    limit: 20, cursor: null, coreItemId: null, viewMode: "list",
  };
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let latestFeed;
  let setRefreshCount;

  function RefreshConsumer() {
    const [, updateRefreshCount] = useState(0);
    setRefreshCount = updateRefreshCount;
    latestFeed = useListingFeed(filters, null, { enabled: true });
    return createElement("output", null, `${latestFeed.status}:${latestFeed.items.map((item) => item.id).join(",")}:${latestFeed.isLoadingMore ? "more" : "idle"}`);
  }

  t.after(async () => {
    await act(async () => root.unmount());
    browser.happyDOM.abort();
    for (const [key, value] of Object.entries(previous)) {
      if (key === "navigator") continue;
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
    else delete globalThis.navigator;
  });

  await act(async () => root.render(createElement(RefreshConsumer)));
  for (let attempt = 0; attempt < 100 && host.textContent !== "ready:old-first-page:idle"; attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(host.textContent, "ready:old-first-page:idle");
  await act(async () => latestFeed.loadMore());
  assert.equal(deferred.length, 1);
  assert.equal(host.textContent, "ready:old-first-page:more");

  await act(async () => {
    latestFeed.reloadFirstPage();
    latestFeed.reloadFirstPage();
    setRefreshCount((value) => value + 1);
  });
  for (let attempt = 0; attempt < 100 && host.textContent !== "ready:fresh-first-page:idle"; attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(host.textContent, "ready:fresh-first-page:idle");
  assert.equal(deferred[0].signal.aborted, true);
  assert.deepEqual(calls, [null, "page2", null]);
});

test("BFF-overlimit filters do not request and recover after reducing conditions", async (t) => {
  const { Window } = require("happy-dom");
  const React = require("react");
  const { act, createElement, useState } = React;
  const browser = new Window({ url: "http://127.0.0.1:4320/accounts" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });

  const listingFilters = loadSource(path.join(repoRoot, "apps/web/src/lib/listing-filters.ts"));
  const longConditions = {
    resources: Array.from({ length: 16 }, (_, index) => ({
      itemId: `item_${String(index).padStart(3, "0")}${"x".repeat(90)}`,
      minQuantity: "1",
      maxQuantity: "999999999999999999999999",
    })),
    skinGroups: [{
      categoryId: "category_1",
      match: "ALL",
      ids: Array.from({ length: 33 }, (_, index) => `skin_${String(index).padStart(3, "0")}${"x".repeat(118)}`),
    }],
  };
  const overlong = listingFilters.parseListingFilters({ game: "game_delta", filters: JSON.stringify(longConditions) });
  const reduced = { ...overlong, filters: {} };
  const metadata = { limits: { urlBytes: 8192 }, filterRevision: "123", catalogRevision: "456", ruleReleaseId: `release_${"r".repeat(90)}` };
  const calls = [];
  const supplyApi = {
    market: async (query) => {
      calls.push(query.toString());
      return { items: [], nextCursor: null, scanBudgetReached: false };
    },
  };
  const { createRoot } = require("react-dom/client");
  const { useListingFeed } = loadSource(path.join(repoRoot, "apps/web/src/components/market/use-listing-feed.ts"), {
    react: React,
    "@/lib/listing-filters": listingFilters,
    "@/lib/listing-feed-utils": loadSource(path.join(repoRoot, "apps/web/src/lib/listing-feed-utils.ts")),
    "@/lib/supply-client": { supplyApi, SupplyRequestError: class extends Error {} },
  });
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let setFilters;

  function Consumer() {
    const [filters, updateFilters] = useState(overlong);
    setFilters = updateFilters;
    const feed = useListingFeed(filters, metadata, { enabled: true });
    return createElement("output", null, `${feed.status}:${feed.error?.code ?? ""}`);
  }

  t.after(async () => {
    await act(async () => root.unmount());
    browser.happyDOM.abort();
    for (const [key, value] of Object.entries(previous)) {
      if (key === "navigator") continue;
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
    else delete globalThis.navigator;
  });

  await act(async () => root.render(createElement(Consumer)));
  for (let attempt = 0; attempt < 100 && host.textContent !== "error:LISTING_URL_TOO_LONG"; attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(host.textContent, "error:LISTING_URL_TOO_LONG");
  assert.deepEqual(calls, []);

  await act(async () => setFilters(reduced));
  for (let attempt = 0; attempt < 100 && host.textContent !== "ready:"; attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(host.textContent, "ready:");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("cursor="), false);
});

test("a cursor can exceed the BFF budget without retrying the next page forever", async (t) => {
  const { Window } = require("happy-dom");
  const React = require("react");
  const { act, createElement } = React;
  const browser = new Window({ url: "http://127.0.0.1:4320/accounts" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    Event: browser.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: browser.navigator, configurable: true });

  const listingFilters = loadSource(path.join(repoRoot, "apps/web/src/lib/listing-filters.ts"));
  const conditions = {
    resources: Array.from({ length: 16 }, (_, index) => ({
      itemId: `item_${String(index).padStart(3, "0")}${"x".repeat(90)}`,
      minQuantity: "1",
      maxQuantity: "999999999999999999999999",
    })),
    skinGroups: [{
      categoryId: "category_1",
      match: "ALL",
      ids: Array.from({ length: 27 }, (_, index) => `skin_${String(index).padStart(3, "0")}${"x".repeat(118)}`),
    }],
  };
  const filters = listingFilters.parseListingFilters({ game: "game_delta", filters: JSON.stringify(conditions) });
  const cursor = `cursor_${"x".repeat(1000)}`;
  const metadata = { limits: { urlBytes: 8192 }, filterRevision: "123", catalogRevision: "456", ruleReleaseId: `release_${"r".repeat(90)}` };
  assert.equal(listingFilters.listingRequestBudget(filters, metadata, null), null);
  assert.equal(listingFilters.listingRequestBudget(filters, metadata, cursor).kind, "webBff");
  const calls = [];
  const supplyApi = {
    market: async (query) => {
      calls.push(query.get("cursor"));
      return { items: [{ id: "first-page" }], nextCursor: cursor, scanBudgetReached: false };
    },
  };
  const { createRoot } = require("react-dom/client");
  const { useListingFeed } = loadSource(path.join(repoRoot, "apps/web/src/components/market/use-listing-feed.ts"), {
    react: React,
    "@/lib/listing-filters": listingFilters,
    "@/lib/listing-feed-utils": loadSource(path.join(repoRoot, "apps/web/src/lib/listing-feed-utils.ts")),
    "@/lib/supply-client": { supplyApi, SupplyRequestError: class extends Error {} },
  });
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = createRoot(host);
  let latestFeed;
  function Consumer() {
    latestFeed = useListingFeed(filters, metadata, { enabled: true });
    return createElement("output", null, `${latestFeed.status}:${latestFeed.loadMoreError?.code ?? ""}`);
  }

  t.after(async () => {
    await act(async () => root.unmount());
    browser.happyDOM.abort();
    for (const [key, value] of Object.entries(previous)) {
      if (key === "navigator") continue;
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
    else delete globalThis.navigator;
  });

  await act(async () => root.render(createElement(Consumer)));
  for (let attempt = 0; attempt < 100 && !host.textContent.startsWith("ready:"); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(host.textContent, "ready:");
  assert.deepEqual(calls, [null]);
  await act(async () => latestFeed.loadMore());
  for (let attempt = 0; attempt < 100 && host.textContent !== "error:LISTING_URL_TOO_LONG"; attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  assert.equal(host.textContent, "error:LISTING_URL_TOO_LONG");
  await act(async () => latestFeed.loadMore());
  assert.deepEqual(calls, [null]);
});
