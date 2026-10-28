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
const listingView = require(path.join(tree, "apps/web/src/lib/listing-view.ts"));
const listingFilters = require(path.join(tree, "apps/web/src/lib/listing-filters.ts"));

const compiled = ts.transpileModule(
  fs.readFileSync(path.join(tree, "apps/web/src/components/delta/account-card.tsx"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }
).outputText;

const tick = () => new Promise(setImmediate);
const passthrough = (name) => {
  const Component = ({ children }) => React.createElement(React.Fragment, null, children);
  Component.displayName = name;
  return Component;
};
const dialogStub = {
  Root: passthrough("DialogRoot"),
  Portal: passthrough("DialogPortal"),
  Overlay: () => null,
  Content: passthrough("DialogContent"),
  Title: passthrough("DialogTitle"),
  Description: passthrough("DialogDescription"),
  Close: passthrough("DialogClose"),
};
const icon = (name) => {
  const Icon = ({ size = 16 }) => React.createElement("i", { "data-icon": name, style: { width: size, height: size } });
  Icon.displayName = name;
  return Icon;
};

const favTitles = [];
const accountTitleCompiled = ts.transpileModule(
  fs.readFileSync(path.join(tree, "apps/web/src/lib/account-title.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }
).outputText;
const accountTitleModule = new Module(path.join(tree, "apps/web/src/lib/account-title.ts"));
accountTitleModule.filename = path.join(tree, "apps/web/src/lib/account-title.ts");
accountTitleModule.paths = Module._nodeModulePaths(tree);
accountTitleModule.require = (n) => {
  if (n === "./listing-filters" || n === "@/lib/listing-filters") return listingFilters;
  return require(n);
};
accountTitleModule._compile(accountTitleCompiled, accountTitleModule.filename);
const accountTitle = accountTitleModule.exports;

function loadCard() {
  const module = new Module(path.join(tree, "account-card-market-probe.cjs"));
  module.filename = path.join(tree, "account-card-market-probe.cjs");
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "next/link") return (props) => React.createElement("a", props);
    if (name === "@radix-ui/react-dialog") return dialogStub;
    if (name === "@radix-ui/react-popover") return { Root: passthrough("PopoverRoot"), Trigger: ({ children }) => children, Portal: passthrough("PopoverPortal"), Content: ({ children }) => React.createElement("div", { "data-popover": "" }, children) };
    if (name === "lucide-react") return { Check: icon("check"), ChevronRight: icon("chevron"), Clock: icon("clock"), Copy: icon("copy"), Image: icon("image"), ImageOff: icon("image-off"), PackageOpen: icon("package"), X: icon("x") };
    if (name === "@/components/favorites/favorite-button") return { FavoriteButton: ({ title }) => { favTitles.push(title); return React.createElement("button", { type: "button", "data-fav-title": title }, "收藏"); } };
    if (name === "@/components/ui/tooltip") return { Tooltip: passthrough("Tooltip"), TooltipTrigger: passthrough("TooltipTrigger"), TooltipContent: () => null };
    if (name === "@/components/ui/thumbnail-carousel") return { ThumbnailCarousel: () => null };
    if (name === "./login-method-icon") return { LoginMethodIcon: () => null };
    if (name === "@/lib/account-return") return { rememberAccountReturn: () => {} };
    if (name === "@/lib/listing-view") return listingView;
    if (name === "@/lib/account-title") return accountTitle;
    if (name === "@/lib/listing-filters") return listingFilters;
    return require(name);
  };
  module._compile(compiled, module.filename);
  return module.exports;
}
const card = loadCard();

const money = (amount) => ({ currency: "CNY", unit: "yuan", amount, scale: 2 });
const line = (itemId, code, unit, quantity, amount, name) => ({ itemId, code, unit, quantity, buyerAmount: money(amount), buyerUnitAmount: money(amount), unitQuantity: "1" });
const item = (id, code, unit, name) => ({ id, code, unit, name });

// Mirrors the first real public listing: 7 goods rows (two known zeros, one positive free-capable
// row) plus the haff rent line; resourceTotal 761.97 = 494.87 + 267.10.
function realListing(overrides = {}) {
  const items = [
    item("i_barrett", "df_billable_barrett_bullet", "ROUND", "巴雷特子弹"),
    item("i_awm", "df_billable_awm_bullet", "ROUND", "AWM子弹"),
    item("i_armor", "df_billable_level6_armor", "PIECE", "六级甲"),
    item("i_coffee", "df_billable_coffee", "PIECE", "咖啡"),
    item("i_insure", "df_billable_top_insure_card", "DAY", "九格保险体验卡"),
    item("i_helmet", "df_billable_level6_helmet", "PIECE", "六级头"),
    item("i_bullet", "df_billable_level6_bullet", "ROUND", "六级子弹"),
    item("i_haff", "df_billable_haff", "HAFF_BASE", "哈夫币"),
  ];
  return {
    id: "account_1",
    displayNo: "ZZ20261018000056",
    title: "193M 哈夫币 · 旧号202609110112",
    attributes: { safe_box_code: "3*3", grading_code: "4", character_level: 60 },
    attributeDisplay: { safeBox: { code: "3*3", displayName: "3×3安全箱" }, grading: { code: "4", displayName: "钻石" } },
    media: [],
    presentation: { items, skins: [], entitlements: [] },
    quote: {
      schemaVersion: 2,
      currency: "CNY",
      lines: [
        line("i_barrett", "df_billable_barrett_bullet", "ROUND", "0", "0.00"),
        line("i_awm", "df_billable_awm_bullet", "ROUND", "61", "67.10"),
        line("i_armor", "df_billable_level6_armor", "PIECE", "12", "36.00"),
        line("i_coffee", "df_billable_coffee", "PIECE", "25", "100.00"),
        line("i_insure", "df_billable_top_insure_card", "DAY", "0", "0.00"),
        line("i_helmet", "df_billable_level6_helmet", "PIECE", "7", "14.00"),
        line("i_bullet", "df_billable_level6_bullet", "ROUND", "300", "50.00"),
        line("i_haff", "df_billable_haff", "HAFF_BASE", "193000000", "494.87"),
      ],
      resourceTotal: money("761.97"),
      tenantDeposit: null,
      tenantPayableTotal: null,
      termSeconds: "1728000",
      expiryDisclosures: [],
      baseRenterHaffRatioWanPerYuan: "39",
    },
    fullPayoutSelected: true,
    ...overrides,
  };
}

async function renderCard(data, props = {}) {
  const window = new Window({ url: "http://127.0.0.1:4220/accounts" });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, MouseEvent: window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  let copied = null;
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (text) => { copied = text; } }, configurable: true });
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = require("react-dom/client").createRoot(host);
  await React.act(async () => root.render(React.createElement(card.AccountCard, { data, ...props })));
  await tick();
  return {
    host,
    window,
    copied: () => copied,
    text: () => host.textContent,
    query: (selector) => host.querySelector(selector),
    all: (selector) => [...host.querySelectorAll(selector)],
    async clickCopy() {
      const button = host.querySelector(".account-card-number");
      await React.act(async () => { button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await tick(); });
      return button;
    },
    async unmount() { await React.act(async () => root.unmount()); await window.happyDOM.abort(); },
  };
}

const financeText = (host) => [...host.querySelectorAll(".finance-row, .finance-total-row, .breakdown-row, .breakdown-total-row, .breakdown-note")].map((row) => row.textContent.replace(/\s+/g, " ").trim());

test('desktop money: unknown, waived and positive deposits keep their own honest total semantics', async () => {
  const cases = [
    { deposit: null, payable: null, expected: '详情核定', caption: '押金待核', total: '761.97' },
    { deposit: money('0.00'), payable: money('761.97'), expected: '无需押金', caption: '', total: '761.97' },
    { deposit: money('300.00'), payable: money('1061.97'), expected: '¥300.00', caption: '含押金', total: '1061.97' },
  ];
  for (const viewMode of ['list', 'grid']) {
    for (const { deposit, payable, expected, caption, total } of cases) {
      const listing = realListing();
      listing.quote.tenantDeposit = deposit;
      listing.quote.tenantPayableTotal = payable;
      const view = await renderCard(listingView.toListingCard(listing), { viewMode });
      try {
        const row = view.query('.finance-row--deposit, .breakdown-row--deposit');
        assert.ok(row, 'the renter deposit has its own honest display row');
        assert.match(row.textContent, /押金/);
        assert.ok(row.textContent.includes(expected), `${viewMode}: ${row.textContent}`);
        assert.equal(view.all('.finance-label, .breakdown-label').some(node => node.textContent === '租金'), false, 'the resource-rental contract has no separate base rent');
        assert.ok(!/不含押金/.test(view.text()), 'current listings must not use the legacy resource-only caption');
        if (caption) assert.match(view.text(), new RegExp(caption));
        else assert.ok(!/押金待核|含押金/.test(view.text()), 'a known zero deposit needs no extra total caption');
        const totalRow = view.query('.finance-total-row, .breakdown-total-row');
        assert.ok(totalRow.textContent.includes(total), `${viewMode}: ${totalRow.textContent}`);
        assert.ok(totalRow.textContent.includes('总价'));
      } finally { await view.unmount(); }
    }
  }
});

test('desktop supplies: level-six ammo has a full label and compact group count; filter hits still lead', async () => {
  const listing = realListing();
  listing.quote.lines.find(row => row.itemId === 'i_bullet').quantity = '240';
  const data = listingView.toListingCard(listing);
  const ordinary = await renderCard(data, { viewMode: 'list' });
  try {
    const first = ordinary.query('.account-list-resources-panel .resources-cell');
    assert.equal(first.querySelector('.resources-cell-name').textContent, '六级子弹');
    assert.equal(first.querySelector('.resources-cell-qty').textContent.trim(), '4组（240发）');
  } finally { await ordinary.unmount(); }
  const filtered = await renderCard(data, { viewMode: 'list', matchedResourceItemIds: new Set(['i_coffee']) });
  try {
    const rows = filtered.all('.account-list-resources-panel .resources-cell');
    assert.match(rows[0].textContent, /咖啡25件/);
    assert.equal(rows[1].querySelector('.resources-cell-name').textContent, '六级子弹');
  } finally { await filtered.unmount(); }
});

test("list shows six skin tags and grid keeps four before the remainder count", async () => {
  const listing = realListing();
  listing.presentation.skins = Array.from({ length: 7 }, (_, index) => ({ id: `skin_${index}`, name: `皮肤${index}` }));
  const data = listingView.toListingCard(listing);
  const list = await renderCard(data, { viewMode: "list" });
  try {
    const chips = list.all(".account-list-skins .account-skin-chip").filter((node) => !node.classList.contains("account-skin-chip--more"));
    assert.equal(chips.length, 6);
    assert.match(list.query(".account-skin-chip--more").textContent, /\+1/);
  } finally { await list.unmount(); }
  const grid = await renderCard(data, { viewMode: "grid" });
  try {
    const chips = grid.all(".account-skin-tags .account-skin-chip").filter((node) => !node.classList.contains("account-skin-chip--more"));
    assert.equal(chips.length, 4);
    assert.match(grid.query(".account-skin-chip--more").textContent, /\+3/);
  } finally { await grid.unmount(); }
});

test("mobile list compresses account, conditions and resources into summary lines", async () => {
  const view = await renderCard(listingView.toListingCard(realListing()), { viewMode: "list" });
  try {
    const lines = view.all(".account-mobile-summary-line");
    assert.equal(lines.length, 3);
    assert.match(lines[0].textContent, /等级/);
    assert.match(lines[0].textContent, /体力/);
    assert.match(lines[0].textContent, /负重/);
    assert.ok(!/段位/.test(lines[0].textContent), "the title badge already carries the grading level");
    assert.match(lines[1].textContent, /租期/);
    assert.ok(!/比例/.test(lines[1].textContent), "the ratio moves next to the haff quantity");
    const ratioPill = view.query(".account-list-title-row .account-tag-pill--ratio");
    assert.equal(ratioPill.textContent.trim(), "39万/元");
    assert.match(lines[2].textContent, /6级甲/);
    assert.match(lines[2].textContent, /6级头盔/);
    assert.match(lines[2].textContent, /全部 \d+ 项/);
    const price = view.query(".account-mobile-price-summary");
    assert.match(price.textContent, /总价/);
    assert.match(price.textContent, /押金待核/);
    assert.match(price.textContent, /费用明细/);
    assert.equal(view.query(".account-mobile-price-lines"), null, "fee details stay collapsed by default");
  } finally { await view.unmount(); }
});

test("list and grid show the same authoritative cost facts under one label set", async () => {
  const data = listingView.toListingCard(realListing());
  const list = await renderCard(data, { viewMode: "list" });
  const grid = await renderCard(data, { viewMode: "grid" });
  for (const view of [list, grid]) {
    const rows = financeText(view.host).join(" | ");
    assert.match(rows, /¥761\.97/);
    assert.match(rows, /哈夫币租金\s*¥494\.87/);
    assert.match(rows, /物资预付\s*¥267\.10/);
    assert.match(rows, /押金\s*详情核定/);
    assert.match(rows, /总价/);
    assert.match(rows, /押金待核/);
    assert.ok(!/不含押金/.test(rows), "current listings use the all-in total or explicitly mark the deposit pending");
    assert.ok(!/参考资源费/.test(rows), "参考资源费 label must be removed per user request");
    assert.ok(!/押金 \/ 个人应付/.test(rows), `undeclared deposit must not render a placeholder row: ${rows}`);
    assert.ok(!/(?:^|\| )租金\s*¥0\.00/.test(rows), `missing deposit must not become an extra zero-priced rent: ${rows}`);
  }
  await list.unmount();
  await grid.unmount();

  // A published deposit and payable are real facts and still show with their own semantics.
  const priced = realListing();
  priced.quote.tenantDeposit = money("800.00");
  priced.quote.tenantPayableTotal = money("1561.97");
  const pricedView = await renderCard(listingView.toListingCard(priced), { viewMode: "list" });
  const pricedRows = financeText(pricedView.host).join(" | ");
  assert.match(pricedRows, /押金¥800\.00/);
  assert.match(pricedRows, /总价.*含押金.*¥1561\.97/);
  assert.ok(!/预付合计/.test(pricedRows), "the all-in total replaces the duplicate prepayment row");
  await pricedView.unmount();

  const depositOnly = realListing();
  depositOnly.quote.tenantDeposit = money("800.00");
  const partialView = await renderCard(listingView.toListingCard(depositOnly), { viewMode: "list" });
  const partialRows = financeText(partialView.host).join(" | ");
  assert.match(partialRows, /押金¥800\.00/);
  assert.match(partialRows, /总价.*押金待核.*¥761\.97/);
  assert.equal(partialView.query('.finance-row--settle'), null, 'a known deposit does not invent a payable total');
  await partialView.unmount();
});

// The compact mobile row relies on these class hooks to keep the ratio and total legible.
test("ratio and total rows keep the class hooks the compact mobile row selects on", async () => {
  const listing = realListing();
  listing.quote.tenantDeposit = money("800.00");
  listing.quote.tenantPayableTotal = money("1561.97");
  const view = await renderCard(listingView.toListingCard(listing), { viewMode: "list" });
  assert.ok(view.host.querySelector(".finance-row--ratio"), "ratio row needs its own class, not first-child");
  assert.ok(view.host.querySelector(".finance-total-row"), "total row needs its own class to re-flow on mobile");
  await view.unmount();

  const noRatio = realListing();
  delete noRatio.quote.baseRenterHaffRatioWanPerYuan;
  const without = await renderCard(listingView.toListingCard(noRatio), { viewMode: "list" });
  assert.equal(without.host.querySelector(".finance-row--ratio"), null);
  assert.match(financeText(without.host).join(" | "), /哈夫币租金/, "a positional hide rule would have eaten this money row");
  await without.unmount();
});

test("the published base ratio is shown as-is and never re-derived from amounts", async () => {
  const withRatio = await renderCard(listingView.toListingCard(realListing()), { viewMode: "list" });
  assert.match(withRatio.text(), /39万\/元/);
  assert.ok(!/辅助换算/.test(withRatio.text()));
  await withRatio.unmount();

  // Same quote lines would reverse-calculate to 41万/元; with no published ratio nothing may show.
  const listing = realListing();
  delete listing.quote.baseRenterHaffRatioWanPerYuan;
  const without = await renderCard(listingView.toListingCard(listing), { viewMode: "list" });
  assert.ok(!/万\/元/.test(without.text()), `reverse-calculated ratio leaked: ${without.text()}`);
  assert.ok(!/基准比例/.test(without.text()));
  await without.unmount();

  assert.equal(card.authoritativeRatioLabel("44.10000000"), "44.1万/元");
  assert.equal(card.authoritativeRatioLabel("0"), "0万/元");
  assert.equal(card.authoritativeRatioLabel("not-a-number"), null);
  assert.equal(card.authoritativeRatioLabel(null), null);
});

test("the owner-side payout scheme never surfaces in the renter-facing card", async () => {
  for (const value of [true, false, null, undefined]) {
    for (const viewMode of ["list", "grid"]) {
      const view = await renderCard(listingView.toListingCard(realListing({ fullPayoutSelected: value })), { viewMode });
      const tags = view.all(".account-list-deal-tag, .account-card-deal-tag").map((node) => node.textContent).join(" ");
      assert.ok(!tags.includes("全额包赔"), `payout scheme leaked for fullPayoutSelected=${String(value)} in ${viewMode}`);
      assert.ok(!/全额包赔|已投保|已承保/.test(view.text()));
      await view.unmount();
    }
  }
});

test("resource summary lists filter hits first, hides known zeros, and counts real hidden rows", async () => {
  const data = listingView.toListingCard(realListing());
  const plain = await renderCard(data, { viewMode: "list" });
  const panel = plain.query(".account-list-resources-panel");
  const summaryGrid = panel.querySelector(".resources-grid-2x2");
  const cells = [...summaryGrid.children].filter((node) => node.classList.contains("resources-cell")).map((node) => node.textContent.replace(/\s+/g, " ").trim());
  assert.equal(cells.length, 5, "desktop list only lays out positive items, 0s are omitted");
  assert.deepEqual(cells.slice(0, 4), ["六级子弹5组（300发）", "6级护甲12件", "6级头盔7件", "AWM子弹61发"]);
  assert.ok(cells.some((text) => text.includes("咖啡25件")), "positive items like coffee 25 are present");
  assert.ok(!cells.some((text) => text.includes("巴雷特子弹0发")), "0-quantity items like barrett 0 are omitted per user request");
  await plain.unmount();

  // Positive stock stays visible even when its buyer amount is zero.
  const free = realListing();
  free.quote.lines.find((entry) => entry.itemId === "i_coffee").buyerAmount = money("0.00");
  const freeView = await renderCard(listingView.toListingCard(free), { viewMode: "list" });
  assert.ok(freeView.all(".resources-cell").some((c) => /咖啡\s*25件/.test(c.textContent)));
  await freeView.unmount();
});

test("missing rows are never padded and unknown stock is not treated as zero", async () => {
  const listing = realListing();
  listing.quote.lines = listing.quote.lines.filter((entry) => entry.itemId !== "i_insure");
  listing.presentation.items = listing.presentation.items.filter((entry) => entry.id !== "i_insure");
  const view = await renderCard(listingView.toListingCard(listing), { viewMode: "list" });
  const cells = view.all(".resources-cell").map((node) => node.textContent);
  assert.ok(!cells.some((text) => text.includes("九格保险")), "absent row must not be invented");
  assert.equal(cells.length, 5, "remains exactly 5 positive returned rows");
  await view.unmount();

  const unknown = realListing();
  unknown.source = "LEGACY_READ_ONLY";
  unknown.quote = null;
  unknown.canCreateOrder = false;
  unknown.inventory = unknown.presentation.items.map((entry, index) => ({
    itemId: entry.id,
    unit: entry.unit,
    quantity: index === 4 ? null : (realListing().quote.lines.find((entry2) => entry2.itemId === entry.id)?.quantity ?? "0"),
  }));
  unknown.historicalQuote = { haffRent: money("494.87"), goods: money("267.10"), deposit: null, termDays: 20 };
  const history = await renderCard(listingView.toListingCard(unknown), { viewMode: "list", matchedResourceItemIds: new Set(["i_coffee", "i_insure"]) });
  const historyRows = financeText(history.host).join(" | ");
  assert.match(historyRows, /¥761\.97/);
  assert.match(historyRows, /哈夫币租金记录/);
  assert.match(historyRows, /物资预付记录/);
  assert.match(historyRows, /押金记录未提供/);
  assert.ok(!/基准比例|详情核定|详情核价/.test(historyRows), `historical record must not promise confirmation: ${historyRows}`);
  assert.match(history.all(".resources-cell").map((node) => node.textContent).join(" "), /咖啡\s*25件/);
  assert.match(history.all(".resources-cell").map((node) => node.textContent).join(" "), /未提供/);
  await history.unmount();
});

test("round quantities keep their accepted 59/61 formatting", async () => {
  for (const [itemId, quantity, expected] of [["i_awm", "61", "61发"], ["i_awm", "59", "59发"], ["i_awm", "300", "300发"], ["i_awm", "301", "301发"], ["i_bullet", "300", "5组（300发）"], ["i_bullet", "61", "1组零1发（共61发）"]]) {
    const listing = realListing();
    listing.quote.lines.find((entry) => entry.itemId === itemId).quantity = quantity;
    const view = await renderCard(listingView.toListingCard(listing), { viewMode: "list", matchedResourceItemIds: new Set([itemId]) });
    const first = view.all(".resources-cell")[0].textContent.replace(/\s+/g, "");
    assert.match(first, new RegExp(expected.replace(/[（）]/g, (char) => "\\" + char) + "$"));
    await view.unmount();
  }
});

test("the account number renders once, outside the title, and copy feedback auto-exits", async () => {
  const view = await renderCard(listingView.toListingCard(realListing()), { viewMode: "list" });
  const title = view.query(".account-list-title-link");
  assert.ok(!/ZZ20261018000056/.test(title.textContent), "number must not occupy the title");
  const numberNodes = view.all(".account-card-number");
  assert.equal(numberNodes.length, 1);
  assert.match(numberNodes[0].textContent, /ZZ20261018000056/);
  assert.equal(view.all("[data-fav-title]")[0].getAttribute("data-fav-title"), title.textContent.replace(/\s+/g, " ").trim());

  const button = await view.clickCopy();
  assert.equal(view.copied(), "ZZ20261018000056");
  const actionSpans = [...button.querySelectorAll(".account-card-number-action > span")];
  assert.equal(actionSpans.length, 3, "all three labels stay mounted so the button width cannot shift");
  assert.deepEqual(actionSpans.map((node) => node.style.visibility), ["hidden", "visible", "hidden"]);
  assert.match(button.querySelector(".sr-only").textContent, /账号编号已复制/);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await React.act(async () => { await tick(); });
  assert.deepEqual([...button.querySelectorAll(".account-card-number-action > span")].map((node) => node.style.visibility), ["visible", "hidden", "hidden"]);
  assert.equal(button.querySelector(".sr-only").textContent, "");
  await view.unmount();
});

test("grid mode exposes the same summary with the existing more pill", async () => {
  const listing = realListing();
  listing.quote.lines.push(
    { itemId: "i_extra1", quantity: "10", unit: "ROUND", unitQuantity: "1", buyerUnitAmount: money("1.00"), buyerAmount: money("10.00") }
  );
  listing.presentation.items.push(
    { id: "i_extra1", code: "df_extra1", name: "额外弹药1", unit: "ROUND" }
  );
  const view = await renderCard(listingView.toListingCard(listing), { viewMode: "grid" });
  const pills = view.all(".account-resource-pill").map((node) => node.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(pills.slice(0, 4), ["6级护甲12件", "6级头盔7件", "6级子弹5组", "AWM子弹61发"]);
  const more = view.query(".account-resource-pill--more");
  assert.equal(more.tagName, "BUTTON");
  assert.match(more.textContent, /\+2/);
  const full = [...view.query(".account-resource-pills [data-popover] .resources-grid-2x2").querySelectorAll(".resources-cell")];
  assert.equal(full.length, 8, "grid popover lists every declared row");
  assert.match(view.query(".breakdown-note").textContent, /39万\/元 · 基准比例/);
  await view.unmount();
});
