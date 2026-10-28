import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(testDirectory, "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const display = requireFromTree(path.join(tree, "apps/web/src/lib/order-display.ts"));

const yuan = (amount) => ({ currency: "CNY", unit: "yuan", scale: 2, amount });

test("order titles come from frozen facts, never from a stored listing title",()=>{
 const legacy={source:{origin:'LEGACY'},account:{readable:true},title:'PRIVATE ACCOUNT TITLE'};
 assert.equal(display.orderAccountTitle(legacy),'租赁账号');
 const native={source:{origin:'NATIVE'},title:'本地联验草稿（迁移数据核对，非对外发布）',quote:{lines:[{itemId:'haff',name:'哈夫币',unit:'HAFF_BASE',quantity:'51000000'}]}};
 assert.equal(display.orderAccountTitle(native),'51 M 哈夫币');
 assert.doesNotMatch(display.orderAccountTitle(native),/本地联验草稿/);
 assert.equal(display.orderAccountTitle({source:{origin:'NATIVE'},title:'任意标题',quote:{lines:[]}}),'租赁账号');
});

test("resource names resolve through the order projection and never invent a name", () => {
  const order = { quote: { lines: [{ itemId: "item_haff", name: "哈夫币", unit: "HAFF_BASE" }, { itemId: "item_piece", name: "", unit: "PIECE" }] } };
  assert.equal(display.resourceName(order, "item_haff"), "哈夫币");
  assert.equal(display.resourceName(order, "item_piece"), "item_piece");
  assert.equal(display.resourceName(order, "item_unknown"), "item_unknown");
});

test("haff quantities keep the exact integer and the exact M helper", () => {
  assert.equal(display.quantityText("HAFF_BASE", "60000000"), "60,000,000 哈夫币（60 M）");
  assert.equal(display.quantityText("HAFF_BASE", "30500000"), "30,500,000 哈夫币（30.5 M）");
  assert.equal(display.quantityText("PIECE", "10"), "10 件");
  assert.equal(display.quantityText("ROUND", "1020"), "1,020 发");
  assert.equal(display.quantityText("PIECE", "not-a-number"), "not-a-number");
});

test("party amounts expose the concrete values and fee payer without internal profit fields", () => {
  const amounts = {
    haffConsumedBuyer: yuan("150.00"), itemConsumedBuyer: yuan("4.00"), unusedItemRefund: yuan("16.00"), unusedHaffRefund: yuan("0.00"),
    earlyMakeup: yuan("0.00"), renterCharge: yuan("154.00"), renterRefund: yuan("316.00"), depositRefund: yuan("300.00"),
    feeAmount: yuan("9.84"), feeRate: "0.08", feePayer: "OWNER",
    haffConsumedOwner: yuan("120.00"), itemConsumedOwner: yuan("3.00"), ownerGross: yuan("123.00"), ownerNet: yuan("113.16"),
    platformHaffSpread: yuan("30.00"), platformContribution: yuan("40.84"),
  };
  const renter = display.settlementAmountRows("renter", amounts);
  const labels = renter.map((row) => row.label);
  assert.ok(labels.includes("预计应退"));
  assert.ok(labels.includes("本次消耗合计"));
  assert.ok(!labels.some((label) => label.includes("平台")));
  assert.equal(renter.find((row) => row.label === "预计应退").value, "¥316.00");
  const owner = display.settlementAmountRows("owner", amounts);
  assert.equal(owner.find((row) => row.label === "号主净入账").value, "¥113.16");
  assert.ok(owner.some((row) => row.label.includes("包赔费用（号主承担") && row.value === "¥9.84"));
  assert.ok(!owner.some((row) => row.value === "¥40.84"));
  const renterPayerOwner = display.settlementAmountRows("owner", { ...amounts, feePayer: "RENTER" });
  assert.ok(renterPayerOwner.some((row) => row.label.includes("包赔费用") && row.value === "由租客承担"));
  assert.ok(!renterPayerOwner.some((row) => row.value === "¥9.84" && row.label.includes("包赔")));
});

test("projected yuan strings and money objects render identically", () => {
  assert.equal(display.moneyText("316.00"), "¥316.00");
  assert.equal(display.moneyText(yuan("316.00")), "¥316.00");
  assert.equal(display.moneyText("not-money"), "—");
});

test("missing or non-CNY amounts are explicit, never zero-filled", () => {
  assert.equal(display.moneyText(undefined), "—");
  assert.equal(display.moneyText({ currency: "USD", amount: "1.00" }), "—");
  const rows = display.settlementAmountRows("renter", { feePayer: "RENTER", feeAmount: yuan("1.00") });
  assert.equal(rows.find((row) => row.label.includes("包赔费用")).value, "¥1.00");
  assert.equal(rows.find((row) => row.label === "哈夫币消耗（租客侧）").value, "—");
});

test("an effective posting is named as the settled result, never with the preview wording", () => {
  const amounts = {
    haffConsumedBuyer: yuan("224.00"), itemConsumedBuyer: yuan("24.00"), unusedHaffRefund: yuan("56.00"), unusedItemRefund: yuan("24.00"),
    renterCharge: yuan("248.00"), renterRefund: yuan("280.00"), depositRefund: yuan("200.00"), feePayer: "OWNER",
    haffConsumedOwner: yuan("168.00"), itemConsumedOwner: yuan("15.00"), ownerGross: yuan("183.00"), ownerNet: yuan("168.36"),
  };
  const renter = display.settlementAmountRows("renter", amounts, "effective");
  const renterLabels = renter.map((row) => row.label);
  assert.ok(renterLabels.includes("本次结算扣费"));
  assert.ok(renterLabels.includes("最终应退"));
  assert.ok(!renterLabels.includes("本次消耗合计"));
  assert.ok(!renterLabels.includes("预计应退"));
  assert.equal(renter.find((row) => row.label === "最终应退").value, "¥280.00");
  assert.equal(renter.find((row) => row.label === "其中押金应退").value, "¥200.00");
  const owner = display.settlementAmountRows("owner", amounts, "effective");
  assert.equal(owner.find((row) => row.label === "本单净入账").value, "¥168.36");
  assert.ok(!owner.some((row) => row.label === "号主净入账"));
  // The default stays the estimate wording so a preview is never presented as a settled result.
  assert.ok(display.settlementAmountRows("renter", amounts).some((row) => row.label === "预计应退"));
});

test("cents-suffixed postings keep the exact value and an unknown one stays unknown", () => {
  assert.equal(display.moneyCents("16836"), "¥168.36 元");
  assert.equal(display.moneyCents("0"), "¥0.00 元");
  assert.equal(display.moneyCents("-150"), "-¥1.50 元");
  assert.equal(display.moneyCents(null), "—");
  assert.equal(display.moneyCents(undefined), "—");
  assert.equal(display.moneyCents("168.36"), "—");
});

test("consumption rows read opening, remaining and consumed from the server projection only", () => {
  const order = { quote: { lines: [{ itemId: "item_haff", name: "哈夫币", unit: "HAFF_BASE" }, { itemId: "item_piece", name: "弹药", unit: "ROUND" }] } };
  const opening = { id: "o1", versionNo: "1", status: "CONFIRMED", lines: [{ itemId: "item_haff", quantity: "10000000", unit: "HAFF_BASE", pricingKind: "HAFF_RATIO" }, { itemId: "item_piece", quantity: "600", unit: "ROUND", pricingKind: "FIXED_UNIT" }], acks: [] };
  const version = { id: "v1", versionNo: "1", versionHash: "h", inputSnapshot: { lines: [{ itemId: "item_haff", openingQuantity: "10000000", remainingQuantity: "2000000" }, { itemId: "item_piece", openingQuantity: "600", remainingQuantity: "300" }] }, computation: { consumed: { haff: "8000000", items: [{ itemId: "item_piece", consumed: "300", remaining: "300" }] } } };
  const rows = display.consumptionRows(order, opening, version);
  assert.deepEqual(rows.map((row) => [row.itemId, row.opening, row.remaining, row.consumed]), [
    ["item_haff", "10000000", "2000000", "8000000"],
    ["item_piece", "600", "300", "300"],
  ]);
  assert.equal(rows[0].name, "哈夫币");
  // Without a submitted or computed quantity the row stays unknown instead of defaulting to zero.
  const bare = display.consumptionRows(order, opening, null);
  assert.deepEqual(bare.map((row) => row.consumed), [null, null]);
  assert.deepEqual(bare.map((row) => row.remaining), [null, null]);
  assert.deepEqual(display.consumptionRows(order, null, version), []);
});

test("frozen legacy order resources form a labelled summary without a private title or unit conversion", () => {
  const order = {
    source: { origin: "LEGACY" }, account: { readable: false }, title: "PRIVATE_CURRENT_ACCOUNT_TITLE",
    orderFacts: { resources: [
      { code: "df_billable_haff", quantity: "12.50", unit: null },
      { code: "df_billable_level6_bullet", quantity: "60", unit: null },
      { code: "df_billable_level6_armor", quantity: "0", unit: null },
      { code: "df_billable_top_insure_card", quantity: "7", unit: "DAY" },
      { code: "df_billable_coffee", quantity: "1", unit: null },
    ], rentalDeadlineAt: "2025-10-09T08:53:20.000Z" },
  };
  assert.equal(display.orderResourceSummary(order), "哈夫币 12.50 · 6级子弹 60 · 顶级保险卡 7 天 · +1项");
  assert.equal(display.orderAccountTitle(order), "哈夫币 12.50 · 6级子弹 60 · 顶级保险卡 7 天 · +1项");
  assert.equal(display.orderUsesResourceSummary(order), true);
  assert.ok(!display.orderAccountTitle(order).includes("PRIVATE_CURRENT_ACCOUNT_TITLE"));
  assert.equal(display.orderAccountTitle({ ...order, account: { readable: true } }), "哈夫币 12.50 · 6级子弹 60 · 顶级保险卡 7 天 · +1项");
});

test("a short order summary names omitted nonzero resources and detail retains every frozen quantity", () => {
  const order = { orderFacts: { resources: [
    { code: 'df_billable_haff', quantity: '64.00', unit: null },
    { code: 'df_billable_awm_bullet', quantity: '46', unit: null },
    { code: 'df_billable_level6_helmet', quantity: '4', unit: null },
    { code: 'df_billable_level6_armor', quantity: '7', unit: null },
    { code: 'df_billable_coffee', quantity: '0', unit: null },
  ] } };
  assert.equal(display.orderResourceSummary(order), '哈夫币 64.00 · AWM子弹 46 · 6级头盔 4 · +1项');
  assert.deepEqual(display.orderResourceLines(order).map(({name, value}) => [name, value]), [
    ['哈夫币', '64.00'], ['AWM子弹', '46'], ['6级头盔', '4'], ['6级护甲', '7'], ['咖啡豆', '0'],
  ]);
});

test("legacy amount facts share renter evidence across parties and never rename it as owner income", () => {
  const order = {
    readOnly: true, source: { origin: "LEGACY" }, status: "CANCELLED",
    payment: { state: "RECORDED_PAID" },
    legacyAmounts: { required: yuan("66.00"), paid: yuan("66.00"), deposit: yuan("0.00"), refund: null },
  };
  const renter = display.orderAmountFacts(order, "renter");
  const owner = display.orderAmountFacts(order, "owner");
  assert.equal(renter.main, "66.00 元");
  assert.equal(owner.main, "66.00 元");
  assert.equal(renter.caption, "已付金额记录");
  assert.equal(owner.caption, "租客实付记录");
  assert.deepEqual(owner.secondary, ["押金 0.00 元"]);
  assert.ok(!owner.secondary.some((line) => line.includes("号主") || line.includes("结算收入")));
  const unknown = display.orderAmountFacts({ ...order, legacyAmounts: { required: null, paid: null, deposit: null, refund: null }, payment: { state: "UNKNOWN" } }, "owner");
  assert.equal(unknown.main, "待确认");
  assert.deepEqual(unknown.secondary, []);
});

test("a historical refund figure is labelled as the original record, never as the current duty", () => {
  // gross 87 / detain 5 / verified net 82: only the gross source record exists on the read projection,
  // so it is shown as a record — not as what is still owed, and not as money already received.
  const order = {
    readOnly: true, source: { origin: "LEGACY" }, status: "COMPLETED",
    payment: { state: "RECORDED_PAID" },
    legacyAmounts: { required: yuan("66.00"), paid: yuan("66.00"), deposit: yuan("57.00"), refund: yuan("87.00") },
    orderFacts: { resources: [], rentalDeadlineAt: null },
  };
  for (const party of ["renter", "owner"]) {
    const facts = display.orderAmountFacts(order, party);
    assert.deepEqual(facts.secondary, ["押金 57.00 元", "原退款金额记录 87.00 元"]);
    assert.ok(!facts.secondary.some((line) => /应退责任|仍欠|已到账|净/.test(line)), `${party} must not read the record as a live duty`);
  }
  assert.ok(!JSON.stringify(display.orderAmountFacts(order, "renter")).includes("82.00"), "no net is derived from the record");
  // REFUND_RECORD_EXISTS keeps only the record: no duty row is invented and nothing claims settlement.
  const recordOnly = display.orderAmountFacts({ ...order, payment: { state: "RECORDED_UNPAID" } }, "renter");
  assert.deepEqual(recordOnly.secondary, ["押金 57.00 元", "原退款金额记录 87.00 元"]);
  // Unknown stays unknown: no refund record, no invented line.
  const empty = display.orderAmountFacts({ ...order, legacyAmounts: { ...order.legacyAmounts, refund: null } }, "renter");
  assert.deepEqual(empty.secondary, ["押金 57.00 元"]);
});

test("a reader placeholder never blocks the frozen resource summary", () => {
  const order = {
    source: { origin: "LEGACY" }, account: { readable: true }, title: "账号资料暂未提供",
    orderFacts: { resources: [
      { code: "df_billable_haff", quantity: "12.50", unit: null },
      { code: "df_billable_top_insure_card", quantity: "7", unit: "DAY" },
    ], rentalDeadlineAt: null },
  };
  assert.equal(display.orderResourceSummary(order), "哈夫币 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderAccountTitle(order), "哈夫币 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderUsesResourceSummary(order), true);
  // an empty/null current title behaves the same way
  assert.equal(display.orderAccountTitle({ ...order, title: null }), "哈夫币 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderAccountTitle({ ...order, title: "   " }), "哈夫币 12.50 · 顶级保险卡 7 天");
  // a stored title never overrides the frozen resource facts
  assert.equal(display.orderAccountTitle({ ...order, title: "真实当前标题" }), "哈夫币 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderUsesResourceSummary({ ...order, title: "真实当前标题" }), true);
  assert.equal(display.orderAccountTitle({ ...order, account: { readable: false }, title: "PRIVATE_CURRENT_ACCOUNT_TITLE" }), "哈夫币 12.50 · 顶级保险卡 7 天");
  assert.ok(!JSON.stringify(display.orderAccountTitle({ ...order, account: { readable: false } })).includes("PRIVATE"));
  // without any frozen fact the display stays honestly empty
  const bare = { source: { origin: "LEGACY" }, account: { readable: true }, title: null, orderFacts: { resources: [], rentalDeadlineAt: null } };
  assert.equal(display.orderAccountTitle(bare), "租赁账号");
  assert.equal(display.orderUsesResourceSummary(bare), false);
});

test("ORDER-A: frozen rental mode labels are read only from the order quote", () => {
  assert.equal(display.orderRentalModeLabel({ quote: { rentalMode: "ordinary" } }), "普通出租");
  assert.equal(display.orderRentalModeLabel({ quote: { rentalMode: "custom" } }), "自定义出租");
  assert.equal(display.orderRentalModeLabel({ quote: { rentalMode: "fast" } }), "极速出租");
  assert.equal(display.orderRentalModeLabel({ quote: {} }), null);
  assert.equal(display.orderRentalModeLabel({ quote: null }), null);
  assert.equal(display.orderRentalModeLabel({}), null);
});

test("ORDER-A: unit price keeps eight decimals and the snapshot's real unit pair", () => {
  const amount = (value) => ({ currency: "CNY", unit: "yuan", amount: value, scale: 8 });
  assert.equal(display.orderUnitPriceText(amount("0.12345678"), "1000000", "HAFF_BASE"), "¥0.12345678 / 1,000,000 哈夫币（1 M）");
  assert.equal(display.orderUnitPriceText(amount("0.00000012"), "60", "ROUND"), "¥0.00000012 / 60 发");
  assert.equal(display.orderUnitPriceText(amount("1.00000000"), "1", "PIECE"), "¥1.00000000 / 1 件");
  assert.equal(display.orderUnitPriceText(amount("2.00000000"), null, "DAY"), "¥2.00000000");
  assert.equal(display.orderUnitPriceText(amount("0.123456789"), "1", "PIECE"), null);
  assert.equal(display.orderUnitPriceText(null, "1", "PIECE"), null);
});

test("ORDER-A: the fee total names the resource subtotal, never the deposit or owner income", () => {
  assert.equal(display.orderLinesTotalLabel("renter"), "资源合计（不含押金）");
  assert.equal(display.orderLinesTotalLabel("owner"), "号主报价合计");
});
