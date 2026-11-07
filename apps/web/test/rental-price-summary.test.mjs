import { contentFixtureDependency } from "./content-fixture.mjs";
import assert from "node:assert/strict";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(testDirectory, "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const typescript = requireFromTree("typescript");
const React = requireFromTree("react");
const ReactDOMClient = requireFromTree("react-dom/client");
const { Window } = requireFromTree("happy-dom");

function compile(relativePath) {
  const source = fs.readFileSync(path.join(tree, relativePath), "utf8");
  return typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      jsx: typescript.JsxEmit.ReactJSX,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
}

function loadSummaryComponent() {
  const file = path.join(tree, "apps/web/src/components/order/rental-price-summary.tsx");
  const module = new Module(file);
  module.filename = file;
  module.paths = Module._nodeModulePaths(tree);
  module.require = (name) => {
    if (name === "@/components/ui/tooltip") {
      return {
        Tooltip: (props) => React.createElement(React.Fragment, null, props.children),
        TooltipTrigger: (props) => React.createElement(React.Fragment, null, props.children),
        TooltipContent: () => null,
      };
    }
    if (name === "@/lib/order-display") {
      return requireFromTree(path.join(tree, "apps/web/src/lib/order-display.ts"));
    }
    if (name === "@/lib/money-display") return requireFromTree(path.join(tree, "apps/web/src/lib/money-display.ts"));
    if (name === "@/lib/order-client") {
      return requireFromTree(path.join(tree, "apps/web/src/lib/order-client.ts"));
    }
    if (name.endsWith(".css")) return {};
    return requireFromTree(name);
  };
  module.require = ((original) => (name) => contentFixtureDependency(name) ?? original(name))(module.require.bind(module));
 module._compile(compile("apps/web/src/components/order/rental-price-summary.tsx"), file);
  return module.exports;
}

const { RentalPriceSummary, personalFeeLines } = loadSummaryComponent();

async function withDom(run) {
  const window = new Window({ url: "http://127.0.0.1/accounts/test" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = ReactDOMClient.createRoot(host);
  try {
    await run(host, async (element) => {
      await React.act(async () => {
        root.render(element);
      });
    });
  } finally {
    await React.act(async () => {
      root.unmount();
    });
    host.remove();
  }
}

// Owner's billing view omits known zero stock; this does not alter quote totals.
test("zero-stock supplies are omitted while positive inventory and API subtotals remain", async () => {
  await withDom(async (host, render) => {
    const reference = {
      total: "¥193.30",
      haff: "¥173.08",
      items: "¥20.22",
      lines: [
        { itemId: "h1", code: "df_billable_haff", name: "哈夫币", quantity: "90000000", quantityLabel: "90M", unitLabel: "哈夫币", costAmount: "173.08", costLabel: "¥173.08", unitPriceLabel: "约52万/元" },
        { itemId: "a1", code: "df_billable_level6_armor", name: "6级护甲", quantity: "5", quantityLabel: "5件", unitLabel: "件", costAmount: "15.00", costLabel: "¥15.00", unitPriceLabel: "¥3.00 / 1 件" },
        { itemId: "b0", code: "df_billable_level6_bullet", name: "6级子弹", quantity: "0", quantityLabel: "0发", unitLabel: "发", costAmount: "0.00", costLabel: "¥0.00", unitPriceLabel: "¥12.00 / 60 发" },
        { itemId: "d0", code: "df_billable_top_insure_card", name: "九格保险卡", quantity: "0", quantityLabel: "0天", unitLabel: "天", costAmount: "0.00", costLabel: "¥0.00", unitPriceLabel: "¥5.00 / 1 天" },
      ],
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote: null }));
    const rows = host.querySelectorAll(".account-quote-bill-row");
    assert.equal(rows.length, 2);
    assert.equal(host.querySelector('[data-zero="true"]'), null);
    assert.ok(!host.querySelector('.account-quote-bill-list[aria-label="物资预付列表"]').textContent.includes("九格保险卡"));
    assert.match(host.textContent, /5件/);
    assert.equal(host.querySelector('.account-quote-bill-subtotal strong').textContent, "¥20.22", "display filtering must not reprice the API subtotal");
  });
});

// Case 2: Unknown quantity/price lines rendered with "未提供", not filtered or forced to 0
test("R3-02: unknown quantity or price lines display '未提供' honestly without suppression", async () => {
  await withDom(async (host, render) => {
    const reference = {
      total: "¥50.00",
      haff: "¥0.00",
      items: "¥50.00",
      lines: [
        { itemId: "u1", code: "unknown_item", name: "神秘物资", quantity: "", quantityLabel: "", unitLabel: "件", costAmount: null, costLabel: null, unitPriceLabel: null },
      ],
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote: null }));
    const row = host.querySelector(".account-quote-bill-row");
    assert.ok(row, "unknown item row must be rendered");
    assert.equal(row.getAttribute("data-unknown"), "true");
    assert.match(row.textContent, /数量未提供/);
  });
});

// Case 3: 60-bullet group denominator displayed with "组"
test("R3-03: 60-bullet denominator displayed with '组' representation", async () => {
  await withDom(async (host, render) => {
    const reference = {
      total: "¥24.00",
      haff: "¥0.00",
      items: "¥24.00",
      lines: [
        { itemId: "b1", code: "df_billable_level6_bullet", name: "6级子弹", quantity: "120", quantityLabel: "120发", unitLabel: "发", costAmount: "24.00", costLabel: "¥24.00", unitPriceLabel: "¥12.00 / 60 发" },
      ],
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote: null }));
    const spec = host.querySelector(".account-quote-bill-spec");
    assert.ok(spec);
    assert.match(spec.textContent, /2组（120发） · ¥12 \/ 组/);
  });
});

// Positive sub-cent prices remain distinguishable from a genuinely free item.
test("R3-05: positive sub-cent unit price is rounded for display without implying zero", async () => {
  await withDom(async (host, render) => {
    const reference = {
      total: "¥0.04",
      haff: "¥0.00",
      items: "¥0.04",
      lines: [
        { itemId: "awm1", code: "df_billable_awm_bullet", name: "AWM子弹", quantity: "10", quantityLabel: "10发", unitLabel: "发", costAmount: "0.04", costLabel: "¥0.04", unitPriceLabel: "¥0.00400000 / 1 发" },
      ],
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote: null }));
    const spec = host.querySelector(".account-quote-bill-spec");
    assert.ok(spec);
    assert.match(spec.textContent, /< ¥0\.01 \/ 发/);
    assert.ok(!spec.textContent.includes("¥0.00 /"), "must not be ¥0.00");
  });
});

// Case 6: Informational separator '·' is used instead of multiplying '×'
test("R3-06: informational separator '·' is used instead of '=' or '×'", async () => {
  await withDom(async (host, render) => {
    const reference = {
      total: "¥15.00",
      haff: "¥0.00",
      items: "¥15.00",
      lines: [
        { itemId: "c1", code: "df_billable_coffee", name: "咖啡豆", quantity: "3", quantityLabel: "3件", unitLabel: "件", costAmount: "15.00", costLabel: "¥15.00", unitPriceLabel: "¥5.00 / 1 件" },
      ],
      unitAmountsInformational: true,
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote: null }));
    const spec = host.querySelector(".account-quote-bill-spec");
    assert.ok(spec);
    assert.match(spec.textContent, /3件 · ¥5 \/ 件/);
    assert.ok(!spec.textContent.includes("×"), "must not claim guaranteed multiplication with ×");
  });
});

// Case 7: Owner fields excluded from DOM (no ownerUnitAmount, ownerAmount, ownerTotal, publisher bail)
test("R1-07: owner/internal fields are strictly excluded from DOM output", async () => {
  await withDom(async (host, render) => {
    const quote = {
      quote: {
        lines: [
          {
            itemId: "i1",
            quantity: "1",
            unit: "PIECE",
            buyerAmount: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 },
            ownerAmount: { currency: "CNY", unit: "yuan", amount: "8.00", scale: 2 },
            ownerUnitAmount: { currency: "CNY", unit: "yuan", amount: "8.00000000", scale: 8 },
          },
        ],
        resourceTotal: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 },
        tenantDeposit: { currency: "CNY", unit: "yuan", amount: "0.00", scale: 2 },
        tenantPayableTotal: { currency: "CNY", unit: "yuan", amount: "10.00", scale: 2 },
        ownerTotal: { currency: "CNY", unit: "yuan", amount: "8.00", scale: 2 },
      },
      baseTenantDeposit: { currency: "CNY", unit: "yuan", amount: "50.00", scale: 2 },
      depositWaived: true,
      confirmationId: "c1",
      listingHash: "h1",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      confirmationToken: "token1",
    };
    const reference = {
      total: "¥20.00",
      haff: "¥0.00",
      items: "¥20.00",
      lines: [
        { itemId: "i1", code: "item_1", name: "头盔", quantity: "1", quantityLabel: "1件", unitLabel: "件", costAmount: "20.00", costLabel: "¥20.00", unitPriceLabel: "¥20.00 / 1 件" },
      ],
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote }));
    const text = host.textContent;
    assert.ok(!text.includes("8.00"), "ownerAmount ¥8.00 must not appear anywhere in DOM");
    assert.ok(!text.includes("owner"), "no owner field names in DOM");
    assert.ok(!text.includes("publisherBail"), "no publisher bail in DOM");
  });
});

// Case 8: Personal price isolation (personal lines use buyerAmount, never borrow public prices)
test("R1-08: personal quote lines isolate prices and never borrow public price when personal price is missing", async () => {
  await withDom(async (host, render) => {
    const quote = {
      quote: {
        lines: [
          {
            itemId: "i1",
            quantity: "1",
            unit: "PIECE",
            buyerAmount: null, // missing personal price
            buyerUnitAmount: null,
          },
        ],
        resourceTotal: null,
        tenantDeposit: { currency: "CNY", unit: "yuan", amount: "100.00", scale: 2 },
        tenantPayableTotal: null,
      },
      baseTenantDeposit: { currency: "CNY", unit: "yuan", amount: "100.00", scale: 2 },
      depositWaived: false,
      confirmationId: "c2",
      listingHash: "h2",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      confirmationToken: "token2",
    };
    const reference = {
      total: "¥50.00",
      haff: "¥0.00",
      items: "¥50.00",
      lines: [
        { itemId: "i1", code: "item_1", name: "特种护甲", quantity: "1", quantityLabel: "1件", unitLabel: "件", costAmount: "50.00", costLabel: "¥50.00", unitPriceLabel: "¥50.00 / 1 件" },
      ],
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote }));
    const row = host.querySelector(".account-quote-bill-row");
    assert.ok(row);
    // Name is enriched from reference by itemId
    assert.match(row.textContent, /特种护甲/);
    // But price is NOT borrowed from public ¥50.00! It must state 未提供
    assert.ok(!row.textContent.includes("¥50.00"), "must never borrow public ¥50.00 for missing personal quote price");
    assert.match(row.textContent, /未提供/, "displays 未提供 when personal price is absent");
  });
});

const cny = (amount, scale = 2) => ({ currency: "CNY", unit: "yuan", scale, amount });
const haffReference = { itemId: "haff", code: "df_billable_haff", name: "哈夫币", quantity: "90000000", quantityLabel: "90M", unitLabel: "哈夫币", unitPriceLabel: "¥1.92307692 / 1000000 哈夫币", costAmount: "173.08", costLabel: "¥173.08" };
const awmReference = { itemId: "awm", code: "df_billable_awm_bullet", name: "AWM子弹", quantity: "90", quantityLabel: "90发", unitLabel: "发", unitPriceLabel: "¥2.00000000 / 1 发", costAmount: "180.00", costLabel: "¥180.00" };
const personalHaff = { itemId: "haff", quantity: "90000000", unit: "HAFF_BASE", unitQuantity: "1000000", buyerUnitAmount: cny("1.92307692", 8), buyerAmount: cny("173.08") };
const personalAwm = { itemId: "awm", quantity: "3", unit: "ROUND", unitQuantity: "1", buyerUnitAmount: cny("2.00000000", 8), buyerAmount: cny("6.00") };
const sourceReference = { total: "¥353.08", haff: "¥173.08", items: "¥180.00", lines: [haffReference, awmReference], unitAmountsInformational: true };
function personalQuote(lines) {
  return { quote: { lines, unitAmountsInformational: true, resourceTotal: cny("179.08"), tenantDeposit: cny("20.00"), tenantPayableTotal: cny("199.08") }, baseTenantDeposit: cny("20.00"), depositWaived: false, customerTier: "STANDARD" };
}

test("frozen legacy source ratio remains the base ratio before membership benefits", async () => {
  await withDom(async (host, render) => {
    const reference = { ...sourceReference, baseRenterHaffRatioWanPerYuan:"37", baseRatioReferenceOnly:true };
    await render(React.createElement(RentalPriceSummary,{reference,quote:null}));
    assert.equal(host.querySelector('.account-haff-ratio-badge')?.textContent,'37万/元');
    const base=personalQuote([personalHaff,personalAwm]);
    await render(React.createElement(RentalPriceSummary,{reference,quote:{...base,quote:{...base.quote,schemaVersion:3,baseRenterHaffRatioWanPerYuan:"37"}}}));
    assert.equal(host.querySelector('.account-haff-ratio-badge')?.textContent,'37万/元');
  });
});

test("personal quantity stays personal even when the public quantity label differs", async () => {
  await withDom(async (host, render) => {
    await render(React.createElement(RentalPriceSummary, { reference: sourceReference, quote: personalQuote([personalHaff, personalAwm]) }));
    const row = [...host.querySelectorAll('.account-quote-bill-row')].find(row => row.textContent.includes('AWM子弹'));
    assert.equal(row.querySelector('.account-quote-bill-spec').textContent, '3发 · 参考单价 ¥2 / 发');
    assert.equal(row.querySelector('.account-quote-bill-amount').textContent, '¥6.00');
    assert.equal(host.querySelector('.account-quote-bill-subtotal strong').textContent, '¥6.00');
  });
});

test("missing personal haff amount never borrows a public amount to display a ratio", async () => {
  await withDom(async (host, render) => {
    await render(React.createElement(RentalPriceSummary, { reference: sourceReference, quote: personalQuote([{ ...personalHaff, buyerAmount: null }, personalAwm]) }));
    assert.equal(host.querySelector('.account-haff-ratio-badge'), null);
    assert.equal(host.querySelector('.account-quote-bill-row--haff .account-quote-bill-amount').textContent, '未提供');
    assert.equal(host.querySelector('.account-quote-bill-row--haff .account-quote-bill-spec').textContent, '90M');
  });
});

test("supplies subtotal remains supplies-only when personal unit metadata is missing", async () => {
  await withDom(async (host, render) => {
    await render(React.createElement(RentalPriceSummary, { reference: sourceReference, quote: personalQuote([personalHaff, { ...personalAwm, unit: undefined }]) }));
    assert.equal(host.querySelector('.account-quote-bill-subtotal strong').textContent, '¥6.00');
    assert.equal(host.querySelector('.account-reference-price').textContent, '¥199.08');
  });
});

test("missing personal lines do not reveal public row prices", async () => {
  await withDom(async (host, render) => {
    await render(React.createElement(RentalPriceSummary, { reference: sourceReference, quote: personalQuote(undefined) }));
    assert.equal(host.querySelectorAll('.account-quote-bill-row').length, 0);
    assert.match(host.querySelector('.account-quote-bill-empty').textContent, /明细未提供/);
    assert.ok(!host.textContent.includes('¥353.08'));
  });
});

test("positive inventory with zero price stays visible and uses the 60-round group", async () => {
  await withDom(async (host, render) => {
    const reference = { total: '¥0.00', haff: '¥0.00', items: '¥0.00', lines: [{ ...awmReference, code: 'df_billable_level6_bullet', name: '6级子弹', quantity: '120', quantityLabel: '120发', unitPriceLabel: '¥0.00000000 / 60 发', costAmount: '0.00', costLabel: '¥0.00' }] };
    await render(React.createElement(RentalPriceSummary, { reference, quote: null }));
    assert.equal(host.querySelectorAll('.account-quote-bill-row').length, 1);
    assert.match(host.querySelector('.account-quote-bill-spec').textContent, /2组（120发）/);
    assert.equal(host.querySelector('.account-quote-bill-amount').textContent, '¥0.00');
  });
});

test("missing personal unit quantity remains unknown instead of becoming a one-round rate", async () => {
  await withDom(async (host, render) => {
    await render(React.createElement(RentalPriceSummary, { reference: sourceReference, quote: personalQuote([{ ...personalAwm, unitQuantity: undefined, buyerUnitAmount: cny('12.00000000', 8) }]) }));
    assert.equal(host.querySelector('.account-quote-bill-spec').textContent, '3发 · 参考单价 ¥2 / 发');
    assert.ok(!host.querySelector('.account-quote-bill-spec').textContent.includes('¥12 / 发'));
    assert.equal(host.querySelector('.account-quote-bill-amount').textContent, '¥6.00');
  });
});

for (const missingOrInconsistent of [null, '5.00']) {
  test(`omitting zero stock preserves a visible notice for ${missingOrInconsistent === null ? 'unknown' : 'nonzero'} charges`, async () => {
    await withDom(async (host, render) => {
      const reference = { total: '未提供', haff: '未提供', items: '未提供', lines: [{ ...awmReference, quantity: '0', quantityLabel: '0发', costAmount: missingOrInconsistent, costLabel: missingOrInconsistent === null ? null : `¥${missingOrInconsistent}` }] };
      await render(React.createElement(RentalPriceSummary, { reference, quote: null }));
      assert.equal(host.querySelectorAll('.account-quote-bill-row').length, 0);
      assert.match(host.querySelector('[role="status"]').textContent, /核对/);
      assert.equal(host.querySelector('.account-quote-bill-subtotal strong').textContent, '未提供');
    });
  });
}

test("DAY and historical PIECE inventory retain their supplied units", async () => {
  await withDom(async (host, render) => {
    const reference = { ...sourceReference, lines: [{ ...awmReference, itemId: 'card', code: 'top_insure_card_piece', name: '九格保险体验卡', unitLabel: '张' }] };
    for (const [unit, label] of [['DAY', '天'], ['PIECE', '张']]) {
      await render(React.createElement(RentalPriceSummary, { reference, quote: personalQuote([{ ...personalAwm, itemId: 'card', unit }]) }));
      assert.equal(host.querySelector('.account-quote-bill-spec').textContent, `3${label} · ¥2 / ${label}`);
    }
  });
});


const benefits = (tier = "STANDARD", source = "GROWTH") => ({
  schema: "membership-benefits-v1", effectiveTier: tier, policyTier: tier,
  priceSource: source, depositSource: source, policyVersion: "TEST_ONLY",
});

function savingsLabel(base, actual) {
  const cents = BigInt(base.amount.replace(".", "")) - BigInt(actual.amount.replace(".", ""));
  return `¥${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function chipTexts(host) {
  return [...host.querySelectorAll(".account-quote-benefit-chips li")].map((el) => el.textContent);
}

const matchedPersonalReference = {
  total: "¥179.08",
  haff: "¥173.08",
  items: "¥6.00",
  lines: [
    haffReference,
    { ...awmReference, quantity: "3", quantityLabel: "3发", costAmount: "6.00", costLabel: "¥6.00" },
  ],
  unitAmountsInformational: true,
};

for (const [name, tier, source] of [["standard", "STANDARD", "GROWTH"], ["higher tier at the same price", "GOLD", "GROWTH"], ["selected courtesy source", "STANDARD", "FRIEND"]]) {
  test(`membership sources without proved savings never imply a discount: ${name}`, async () => {
    await withDom(async (host, render) => {
      const quote = { ...personalQuote([personalHaff, personalAwm]), membershipBenefits: benefits(tier, source), baseTenantDeposit: cny("20.00") };
      await render(React.createElement(RentalPriceSummary, { reference: sourceReference, quote }));
      assert.equal(host.querySelector(".account-quote-benefits"), null);
      assert.equal(host.querySelector('[data-kind="rent"]'), null);
      assert.equal(host.querySelector(".rental-deposit del"), null);
      assert.ok(!host.textContent.includes("已减"));
      assert.ok(!host.textContent.includes("本次计价来源"));
      assert.ok(!host.textContent.includes("价格："));
    });
  });
}

for (const [name, base, actual, waived, expectedChain] of [
  ["known positive reduction", cny("50.00"), cny("20.00"), false, true],
  ["a zero base remains zero", cny("0.00"), cny("0.00"), true, false],
  ["missing baseline", null, cny("0.00"), true, false],
  ["missing actual deposit", cny("50.00"), null, false, false],
  ["different currency", { ...cny("50.00"), currency: "USD" }, cny("20.00"), false, false],
  ["invalid scale", cny("50.00", 8), cny("20.00"), false, false],
  ["large exact amount reduction", cny("90071992547409930.02"), cny("90071992547409930.01"), false, true],
]) {
  test(`deposit reduction card requires an exact known deposit reduction: ${name}`, async () => {
    await withDom(async (host, render) => {
      const original = personalQuote([personalHaff, personalAwm]);
      const quote = { ...original, membershipBenefits: benefits(), baseTenantDeposit: base, depositWaived: waived, quote: { ...original.quote, tenantDeposit: actual } };
      await render(React.createElement(RentalPriceSummary, { reference: sourceReference, quote }));
      const deposit = host.querySelector(".rental-deposit");
      const card = host.querySelector(".account-quote-benefits");
      assert.equal(Boolean(deposit?.querySelector("del")), expectedChain);
      assert.equal(host.querySelector('[data-kind="rent"]'), null, "mismatched public quantities must not invent a rent discount");
      if (expectedChain) {
        const savings = savingsLabel(base, actual);
        assert.ok(card);
        assert.equal(card.querySelector("strong"), null);
        assert.deepEqual(chipTexts(host), [`减免押金 ${savings}`]);
        assert.ok(!card.textContent.includes("成长权益"));
        assert.equal(deposit.querySelector("del").textContent, `¥${base.amount}`);
        assert.match(deposit.textContent, new RegExp(`¥${actual.amount.replace(".", "\\.")}`));
        assert.ok(!deposit.textContent.includes("已减"));
        assert.ok(!deposit.textContent.includes("成长权益"));
        assert.ok(!host.textContent.includes("价格：成长权益"));
        assert.ok(!host.textContent.includes("本次计价来源"));
      } else {
        assert.equal(card, null);
        assert.ok(!host.textContent.includes("减免押金"));
        assert.equal(deposit?.querySelector("del") ?? null, null);
      }
      assert.equal(host.querySelector(".account-reference-price").textContent, "¥199.08", "only the display indicator changes; payable remains the API amount");
    });
  });
}

test("silver member with only a deposit reduction shows one card and no invented rent discount", async () => {
  await withDom(async (host, render) => {
    const original = personalQuote([personalHaff, personalAwm]);
    const quote = {
      ...original,
      membershipBenefits: benefits("SILVER", "GROWTH"),
      baseTenantDeposit: cny("800.00"),
      depositWaived: false,
      quote: { ...original.quote, tenantDeposit: cny("780.00"), tenantPayableTotal: cny("959.08") },
    };
    await render(React.createElement(RentalPriceSummary, { reference: matchedPersonalReference, quote }));
    const card = host.querySelector(".account-quote-benefits");
    const deposit = host.querySelector(".rental-deposit");
    assert.equal(card.querySelector("strong").textContent, "银卡会员");
    assert.deepEqual(chipTexts(host), ["减免押金 ¥20.00"]);
    assert.ok(!host.textContent.includes("成长权益"));
    assert.equal(deposit.querySelector("del").textContent, "¥800.00");
    assert.match(deposit.textContent, /¥780\.00/);
    assert.ok(!deposit.textContent.includes("银卡会员"));
    assert.ok(!deposit.textContent.includes("已减"));
    assert.equal(host.querySelector('[data-kind="rent"]'), null);
    assert.ok(!host.textContent.includes("价格：成长权益"));
    assert.equal(host.querySelector(".account-reference-price").textContent, "¥959.08");
  });
});

test("silver member with a clean resource ratio shows 9.8折 and 减免押金 together in one card", async () => {
  await withDom(async (host, render) => {
    const reference = {
      total: "¥3447.50",
      haff: "¥3447.50",
      items: "¥0.00",
      lines: [{ ...haffReference, costAmount: "3447.50", costLabel: "¥3447.50" }],
      unitAmountsInformational: true,
    };
    const personal = { ...personalHaff, buyerAmount: cny("3378.55") };
    const original = personalQuote([personal]);
    const quote = {
      ...original,
      membershipBenefits: benefits("SILVER", "GROWTH"),
      baseTenantDeposit: cny("800.00"),
      depositWaived: false,
      quote: {
        ...original.quote,
        lines: [personal],
        resourceTotal: cny("3378.55"),
        tenantDeposit: cny("780.00"),
        tenantPayableTotal: cny("4158.55"),
      },
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote }));
    const card = host.querySelector(".account-quote-benefits");
    assert.equal(card.querySelector("strong").textContent, "银卡会员");
    assert.deepEqual(chipTexts(host), ["9.8折", "减免押金 ¥20.00"]);
    assert.ok(!host.textContent.includes("成长权益"));
    const rent = host.querySelector('[data-kind="rent"]');
    assert.equal(rent.querySelector("del").textContent, "¥3447.50");
    assert.match(rent.textContent, /¥3378\.55/);
    assert.ok(!rent.textContent.includes("银卡会员"));
    assert.ok(!rent.textContent.includes("已减"));
    const deposit = host.querySelector(".account-bill-section--deposit .rental-deposit");
    assert.equal(deposit.querySelector("del").textContent, "¥800.00");
    assert.match(deposit.textContent, /¥780\.00/);
    assert.ok(!deposit.textContent.includes("银卡会员"));
    assert.ok(!deposit.textContent.includes("减免押金"));
  });
});

test("matching cheaper personal resource lines show one card with fallback 已减 and courtesy title", async () => {
  await withDom(async (host, render) => {
    const cheaperHaff = { ...personalHaff, buyerAmount: cny("153.08") };
    const original = personalQuote([cheaperHaff, personalAwm]);
    const quote = {
      ...original,
      membershipBenefits: benefits("GOLD", "FRIEND"),
      baseTenantDeposit: cny("50.00"),
      depositWaived: false,
      quote: {
        ...original.quote,
        lines: [cheaperHaff, personalAwm],
        resourceTotal: cny("159.08"),
        tenantDeposit: cny("20.00"),
        tenantPayableTotal: cny("179.08"),
      },
    };
    await render(React.createElement(RentalPriceSummary, { reference: matchedPersonalReference, quote }));
    const card = host.querySelector(".account-quote-benefits");
    assert.equal(card.querySelector("strong").textContent, "金卡会员 · 挚友礼遇");
    assert.deepEqual(chipTexts(host), ["已减 ¥20.00", "减免押金 ¥30.00"]);
    assert.ok(!host.textContent.includes("成长权益"));
    const rent = host.querySelector('[data-kind="rent"]');
    assert.ok(rent);
    assert.equal(rent.querySelector("del").textContent, "¥179.08");
    assert.match(rent.textContent, /¥159\.08/);
    assert.ok(!rent.textContent.includes("金卡会员"));
    assert.ok(!rent.textContent.includes("挚友礼遇"));
    const deposit = host.querySelector(".account-bill-section--deposit .rental-deposit");
    assert.equal(deposit.querySelector("del").textContent, "¥50.00");
    assert.match(deposit.textContent, /¥20\.00/);
    assert.ok(!deposit.textContent.includes("挚友礼遇"));
    assert.ok(!deposit.textContent.includes("已减"));
    assert.ok(!host.textContent.includes("价格：挚友礼遇"));
  });
});

test("a proved reduction to zero deposit shows 免押 in the card without a waiver flag", async () => {
  await withDom(async (host, render) => {
    const original = personalQuote([personalHaff, personalAwm]);
    const quote = {
      ...original,
      membershipBenefits: benefits("SILVER", "GROWTH"),
      baseTenantDeposit: cny("50.00"),
      quote: { ...original.quote, tenantDeposit: cny("0.00"), tenantPayableTotal: cny("179.08") },
    };
    delete quote.depositWaived;
    await render(React.createElement(RentalPriceSummary, { reference: sourceReference, quote }));
    const card = host.querySelector(".account-quote-benefits");
    const deposit = host.querySelector(".rental-deposit");
    assert.equal(card.querySelector("strong").textContent, "银卡会员");
    assert.deepEqual(chipTexts(host), ["免押"]);
    assert.ok(!host.textContent.includes("成长权益"));
    assert.equal(deposit.querySelector("del").textContent, "¥50.00");
    assert.match(deposit.textContent, /¥0\.00/);
    assert.ok(!deposit.textContent.includes("银卡会员"));
    assert.match(host.textContent, /本次免押/);
    assert.equal(host.querySelector('[data-kind="rent"]'), null);
  });
});

test("itemized personal amounts remain authoritative while catalog units are labelled as reference", async () => {
  await withDom(async (host, render) => {
    const reference = {
      total: "¥3262.00",
      haff: "¥2878.00",
      items: "¥384.00",
      lines: [
        { ...haffReference, costAmount: "2878.00", costLabel: "¥2878.00" },
        { itemId: "awm", code: "df_billable_awm_bullet", name: "AWM子弹", quantity: "240", quantityLabel: "240发", unitLabel: "发", costAmount: "264.00", costLabel: "¥264.00", unitPriceLabel: "¥1.10 / 1 发" },
        { itemId: "b1", code: "df_billable_level6_bullet", name: "6级子弹", quantity: "600", quantityLabel: "600发", unitLabel: "发", costAmount: "120.00", costLabel: "¥120.00", unitPriceLabel: "¥12.00 / 60 发" },
      ],
      unitAmountsInformational: true,
    };
    const personalHaffDisc = { ...personalHaff, buyerAmount: cny("2820.44") };
    const personalAwmDisc = { itemId: "awm", quantity: "240", unit: "ROUND", unitQuantity: "1", buyerUnitAmount: cny("1.07779717", 8), buyerAmount: cny("258.72") };
    const personalBulletDisc = { itemId: "b1", quantity: "600", unit: "ROUND", unitQuantity: "60", buyerUnitAmount: cny("0.19600000", 8), buyerAmount: cny("117.60") };
    const original = personalQuote([personalHaffDisc, personalAwmDisc, personalBulletDisc]);
    const quote = {
      ...original,
      membershipBenefits: benefits("SILVER", "GROWTH"),
      baseTenantDeposit: cny("800.00"),
      depositWaived: false,
      quote: {
        ...original.quote,
        lines: [personalHaffDisc, personalAwmDisc, personalBulletDisc],
        resourceTotal: cny("3196.76"),
        tenantDeposit: cny("780.00"),
        tenantPayableTotal: cny("3976.76"),
      },
    };
    await render(React.createElement(RentalPriceSummary, { reference, quote }));
    const haff = [...host.querySelectorAll(".account-quote-bill-row")].find((row) => row.textContent.includes("哈夫币"));
    assert.equal(haff.querySelector(".account-quote-bill-amount").textContent, "¥2820.44");
    const awm = [...host.querySelectorAll(".account-quote-bill-row")].find((row) => row.textContent.includes("AWM子弹"));
    assert.equal(awm.querySelector(".account-quote-bill-spec").textContent, "240发 · 参考单价 ¥1.1 / 发");
    assert.equal(awm.querySelector(".account-quote-bill-amount").textContent, "¥258.72");
    const bullets = [...host.querySelectorAll(".account-quote-bill-row")].find((row) => row.textContent.includes("6级子弹"));
    assert.equal(bullets.querySelector(".account-quote-bill-spec").textContent, "10组（600发） · 参考单价 ¥12 / 组");
    assert.equal(bullets.querySelector(".account-quote-bill-amount").textContent, "¥117.60");
    assert.equal(host.querySelector(".account-quote-bill-subtotal strong").textContent, "¥376.32");
    assert.deepEqual(chipTexts(host), ["9.8折", "减免押金 ¥20.00"]);
    const rent = host.querySelector('[data-kind="rent"]');
    assert.equal(rent.querySelector("del").textContent, "¥3262.00");
    assert.match(rent.textContent, /¥3196\.76/);
    assert.ok(!rent.textContent.includes("银卡会员"));
    assert.equal(host.querySelector(".account-reference-price").textContent, "¥3976.76");
    const card = host.querySelector(".account-quote-benefits");
    assert.equal(card.querySelector("strong").textContent, "银卡会员");
    assert.ok(!host.textContent.includes("成长权益"));
  });
});
