import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(path.join(tree, "apps/web/package.json"));
const React = require("react");
const { Window } = require("happy-dom");
const ts = require("typescript");
const listingFilters = require(path.join(tree, "apps/web/src/lib/listing-filters.ts"));

const compiled = ts.transpileModule(
  fs.readFileSync(path.join(tree, "apps/web/src/components/market/market-filter-controls.tsx"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }
).outputText;

const tick = () => new Promise(setImmediate);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const icon = (name) => {
  const Icon = ({ size = 16 }) => React.createElement("i", { "data-icon": name, style: { width: size, height: size } });
  Icon.displayName = name;
  return Icon;
};
// HeroUI Select stand-in: Root owns the value contract, Trigger is the focusable control that
// must carry aria-invalid/aria-describedby in the real product too.
const selectStub = {
  Select: {
    Root: ({ children, selectedKey, onSelectionChange, ...rest }) => React.createElement("select", {
      "data-select-root": "",
      "aria-invalid": rest["aria-invalid"] || undefined,
      value: selectedKey ?? "",
      onChange: (event) => onSelectionChange(event.target.value === "" ? null : event.target.value),
    }, children),
    Trigger: React.forwardRef((props, ref) => React.createElement("button", { ref, type: "button", "data-select-trigger": "", "aria-describedby": props["aria-describedby"] }, props.children)),
    Value: () => null,
    Indicator: () => null,
    Popover: ({ children }) => children,
  },
};
const listBoxStub = {
  ListBox: Object.assign(({ children }) => children, {
    Item: Object.assign(({ id, children }) => React.createElement("option", { value: id }, children), { Indicator: () => null }),
  }),
};

const metadata = {
  available: true, reasonCode: null, gameId: "game_1", queryVersion: 2,
  filterRevision: null, catalogRevision: null, ruleReleaseId: null,
  defaultSort: { sort: "latest", direction: "DESC", label: "最新发布" },
  fields: [
    { key: "serviceWindow", operator: "between", label: "配合上号时段", enabled: true, order: 1 },
    { key: "resources", operator: "range", label: "资源数量", enabled: true, order: 2, items: [{ itemId: "it_coffee", min: "0", max: "1000" }] },
    { key: "safeBoxCodes", operator: "in", label: "安全箱", enabled: true, order: 3, options: [{ value: "3*3", label: "3×3安全箱" }] },
  ],
  sorts: [{ key: "latest", label: "最新发布", enabled: true, order: 1 }],
  directions: ["ASC", "DESC"],
  items: [{ id: "it_coffee", code: "df_billable_coffee", name: "咖啡", unit: "PIECE" }],
  categories: [], skinCatalogUrl: "",
  limits: { urlBytes: 8192, resources: 16, skinGroups: 8, skinIds: 50, enumValues: 50, regions: 20, limit: 50, scanBudget: 200 },
};

function loadControls() {
  const module = new Module(path.join(tree, "market-filter-controls-probe.cjs"));
  module.filename = path.join(tree, "market-filter-controls-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "@radix-ui/react-popover") return { Root: ({ children }) => React.createElement(React.Fragment, null, children), Trigger: ({ children }) => children, Portal: ({ children }) => React.createElement(React.Fragment, null, children), Content: ({ children }) => React.createElement("div", null, children) };
    if (name === "@heroui/react/list-box") return listBoxStub;
    if (name === "@heroui/react/select") return selectStub;
    if (name === "lucide-react") return { Check: icon("check"), ChevronDown: icon("chevron"), MapPin: icon("pin"), Minus: icon("minus"), Plus: icon("plus"), Search: icon("search"), X: icon("x"), ZoomIn: icon("zoom") };
    if (name === "@/components/supply/skin-media-thumb") return { SkinMediaThumb: () => null, SkinMediaPreview: ({ children }) => React.createElement("button", { type: "button" }, children), SkinMetadata: () => null };
    if (name === "@/lib/listing-filters") return listingFilters;
    return require(name);
  };
  module._compile(compiled, module.filename);
  return module.exports;
}
const controls = loadControls();

async function renderHarness(props = {}) {
  const window = new Window({ url: "http://127.0.0.1:4220/accounts" });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  const calls = [];
  const flushers = new Set();
  const base = {
    flushDrafts: (fn) => { flushers.add(fn); return () => { flushers.delete(fn); }; },
    filters: listingFilters.parseListingFilters({ game: "game_1" }),
    metadata,
    catalog: null,
    catalogStatus: "idle",
    skinSearch: "", skinOwner: "", skinRarity: "", activeSkinCategoryId: "",
    skinSearchCatalog: null, skinSearchStatus: "idle",
    onChange: (next) => calls.push(next),
    onRetryCatalog: () => {}, onRetrySkinSearch: () => {},
    onSkinSearchChange: () => {}, onSkinOwnerChange: () => {}, onSkinRarityChange: () => {},
    onSkinCategoryChange: () => {}, onLoadMoreSkins: () => {}, loadingMoreSkins: false,
    ...props,
  };
  const render = async (nextProps) => {
    await React.act(async () => root.render(React.createElement(controls.MarketFilterControls, { ...base, ...nextProps })));
    await tick();
  };
  await render({});
  return {
    host, calls, render, window,
    flushAll: () => [...flushers].map((fn) => fn()),
    timeTriggers: () => [...host.querySelectorAll(".market-time-selects [data-select-trigger]")],
    minInput: () => host.querySelector('.market-resource-quantity input[aria-label$="（件）"]'),
    async typeMin(value) {
      const input = this.minInput();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      await React.act(async () => { setter.call(input, value); input.dispatchEvent(new window.Event("input", { bubbles: true })); await tick(); });
    },
    async pickTime(index, value) {
      const select = host.querySelectorAll(".market-time-selects [data-select-root]")[index];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      await React.act(async () => { setter.call(select, value); select.dispatchEvent(new window.Event("change", { bubbles: true })); await tick(); });
    },
    async unmount() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); },
  };
}

test("equal time window puts aria-invalid and its description on the real select triggers", async () => {
  const harness = await renderHarness();
  await harness.pickTime(0, "600");
  await harness.pickTime(1, "600");
  const triggers = harness.timeTriggers();
  assert.equal(triggers.length, 2);
  assert.equal(triggers[0].getAttribute("aria-invalid"), "true");
  assert.equal(triggers[1].getAttribute("aria-invalid"), "true");
  const describedBy = triggers[0].getAttribute("aria-describedby");
  assert.ok(describedBy, "trigger must reference the error text");
  const errorNode = harness.host.ownerDocument.getElementById(describedBy);
  assert.ok(errorNode, "describedby target must exist");
  assert.equal(errorNode.getAttribute("role"), "alert");
  assert.match(errorNode.textContent, /起止时间不能相同/);
  await harness.unmount();
});

test("reset token clears an invalid equal-time draft while the committed count is still zero", async () => {
  const harness = await renderHarness();
  await harness.pickTime(0, "600");
  await harness.pickTime(1, "600");
  assert.equal(harness.timeTriggers()[0].getAttribute("aria-invalid"), "true");
  assert.equal(harness.calls.length, 0, "invalid draft must not commit");
  await harness.render({ resetToken: 1 });
  assert.equal(harness.timeTriggers()[0].getAttribute("aria-invalid"), null);
  assert.equal(harness.host.querySelectorAll("[role=alert]").length, 0);
  const selects = harness.host.querySelectorAll(".market-time-selects [data-select-root]");
  assert.equal(selects[0].value, "__clear__", "start draft returns to 不限");
  assert.equal(selects[1].value, "__clear__", "end draft returns to 不限");
  await harness.unmount();
});

test("reset token drops an invalid resource draft and its pending timer writes nothing back", async () => {
  const harness = await renderHarness();
  await harness.typeMin("abc");
  await wait(400);
  assert.ok(harness.host.querySelector('.market-resource-quantity [role=alert]'), "invalid draft keeps its inline error");
  assert.equal(harness.calls.length, 0);
  await harness.render({ resetToken: 1 });
  assert.equal(harness.host.querySelector('.market-resource-quantity [role=alert]'), null);
  assert.equal(harness.minInput().value, "");
  await wait(400);
  assert.equal(harness.calls.length, 0, "cleared timer must not commit the stale draft");
  await harness.unmount();
});

test("reset token cancels a valid but uncommitted debounce without committing it", async () => {
  const harness = await renderHarness();
  await harness.typeMin("5");
  await harness.render({ resetToken: 1 });
  await wait(400);
  assert.equal(harness.calls.length, 0, "reset must cancel the pending 350ms commit");
  assert.equal(harness.minInput().value, "");
  await harness.unmount();
});

test("committing an unrelated filter keeps an in-progress resource draft and still commits it", async () => {
  const harness = await renderHarness();
  await harness.typeMin("5");
  const withSafeBox = { ...harness.calls.length ? harness.calls[0] : listingFilters.parseListingFilters({ game: "game_1" }), filters: { safeBoxCodes: ["3*3"] } };
  await harness.render({ filters: withSafeBox });
  assert.equal(harness.minInput().value, "5", "unrelated commit must not wipe the draft being typed");
  await wait(400);
  const committed = harness.calls.find((call) => call.filters.resources?.some((entry) => entry.itemId === "it_coffee"));
  assert.ok(committed, "pending draft still commits after its debounce");
  assert.equal(committed.filters.resources[0].minQuantity, "5");
  assert.deepEqual(committed.filters.safeBoxCodes, ["3*3"]);
  await harness.unmount();
});

test("the mobile drawer flush commits a pending valid draft immediately", async () => {
  const harness = await renderHarness();
  await harness.typeMin("5");
  assert.equal(harness.calls.length, 0, "the 350ms debounce has not fired yet");
  let results;
  await React.act(async () => { results = harness.flushAll(); });
  assert.deepEqual(results, [true], "flusher reports the draft as valid");
  const committed = harness.calls.find((call) => call.filters.resources?.some((entry) => entry.itemId === "it_coffee"));
  assert.ok(committed, "flush commits without waiting for the timer");
  assert.equal(committed.filters.resources[0].minQuantity, "5");
  await harness.unmount();
});

test("the flush refuses to commit an invalid draft so 查看结果 keeps the sheet open", async () => {
  const harness = await renderHarness();
  await harness.typeMin("abc");
  let results;
  await React.act(async () => { results = harness.flushAll(); });
  assert.deepEqual(results, [false], "an invalid draft must block the commit");
  assert.equal(harness.calls.length, 0);
  assert.ok(harness.host.querySelector('.market-resource-quantity [role=alert]'), "the control keeps its error");
  await harness.unmount();
});

test("an error that already settled still blocks 查看结果", async () => {
  const harness = await renderHarness();
  await harness.typeMin("abc");
  await wait(400);
  assert.equal(harness.calls.length, 0, "the debounce ran and refused to commit the invalid draft");
  assert.ok(harness.host.querySelector('.market-resource-quantity [role=alert]'), "the error is on screen before the flush");
  let results;
  await React.act(async () => { results = harness.flushAll(); });
  assert.deepEqual(results, [false], "no pending timer must not read as nothing to check");
  assert.equal(harness.calls.length, 0);
  await harness.unmount();
});

test("a draft whose valid debounce already committed flushes clean", async () => {
  const harness = await renderHarness();
  await harness.typeMin("5");
  await wait(400);
  let results;
  await React.act(async () => { results = harness.flushAll(); });
  assert.deepEqual(results, [true], "a settled valid draft must not block the commit");
  assert.equal(harness.calls.length, 1);
  await harness.unmount();
});

test("desktop filter opens 基础条件 by default and collapses the secondary groups", async () => {
  const harness = await renderHarness();
  const groups = [...harness.host.querySelectorAll(".market-filter-group")];
  assert.equal(groups.length, 4);
  assert.equal(groups[0].open, true);
  assert.match(groups[0].querySelector("summary").textContent, /基础条件/);
  for (const group of groups.slice(1)) assert.equal(group.open, false);
  assert.ok(groups[0].querySelector(".market-filter-row"), "the basic rows are visible without a click");
  await harness.unmount();
});

test("mobile 皮肤外观 renders the picker inline without the gallery detour", async () => {
  const skinMetadata = {
    ...metadata,
    fields: [...metadata.fields, { key: "skinGroups", operator: "in", label: "皮肤外观", enabled: true, order: 9, categoryIds: ["cat_1"] }],
  };
  const catalog = {
    game: { id: "game_1", code: "delta", name: "三角洲行动", catalogRevision: "1" },
    categories: [{ id: "cat_1", name: "步枪", ownerKind: "FIREARM" }],
    owners: [],
    rarities: [],
    skins: [{ id: "skin_1", name: "测试皮肤", categoryId: "cat_1", ownerKind: "FIREARM", mediaId: null }],
  };
  const harness = await renderHarness({
    mobile: true,
    metadata: skinMetadata,
    catalog,
    catalogStatus: "ready",
    skinSearchCatalog: catalog,
    skinSearchStatus: "ready",
  });
  const skinTab = [...harness.host.querySelectorAll(".market-rail-item")].find((node) => node.textContent.includes("皮肤外观"));
  assert.ok(skinTab);
  await React.act(async () => { skinTab.dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true })); await tick(); });
  assert.equal(harness.host.querySelector(".market-mobile-skin-banner"), null);
  assert.equal(harness.host.querySelector(".market-mobile-skin-enter-btn"), null);
  assert.ok(harness.host.querySelector(".market-mobile-skin-panel"));
  assert.ok(harness.host.querySelector(".market-mobile-skin-grid"));
  assert.equal(harness.host.querySelector(".market-mobile-skin-thumb-wrap").getAttribute("data-owner-kind"), "FIREARM");
  assert.match(harness.host.querySelector(".market-mobile-skin-name").textContent, /测试皮肤/);
  await harness.unmount();
});
