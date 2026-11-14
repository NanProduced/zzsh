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

test("payment observation translates known states without treating the original request as confirmed", () => {
  assert.equal(display.paymentObservation(null), "暂未查到付款记录");
  assert.equal(display.paymentObservation({ disposition: "APPLIED" }), "已有付款记录（已记入订单）");
  assert.equal(display.paymentObservation({ disposition: "REVIEW_REQUIRED" }), "已有付款记录（需要人工核对）");
  assert.equal(display.paymentObservation({ disposition: "FUTURE_STATE" }), "已有付款记录（状态未记录）");
});

test("pending payment link stays on the same order route with a recoverable pay intent", () => {
  const url = display.orderPaymentUrl("renter", "PENDING_PAYMENT", undefined, "order_1");
  assert.match(url, /view=rentals/);
  assert.match(url, /orderId=order_1/);
  assert.match(url, /pay=1/);
});

test("payment countdown text never invents time", () => {
  assert.equal(display.formatPaymentCountdown(0), null);
  assert.equal(display.formatPaymentCountdown(Number.NaN), null);
  assert.equal(display.formatPaymentCountdown(65_000), "1:05");
  assert.equal(display.formatPaymentCountdown(3_665_000), "1:01:05");
});

test("settlement preview failures remain actionable without exposing internal reason codes", () => {
  assert.match(display.settlementPreviewProblem(["FULL_PAYOUT_UNKNOWN"]), /包赔资料.*联系客服/);
  assert.match(display.settlementPreviewProblem(["SETTLEMENT_QUANTITY_MISMATCH"]), /数量.*核对/);
  assert.match(display.settlementPreviewProblem(["FUTURE_REASON"]), /暂时无法确认/);
  assert.doesNotMatch(display.settlementPreviewProblem(["FUTURE_REASON"]), /FUTURE_REASON/);
});

test("order facts name historical, frozen or current sources without pretending current facts are snapshots", () => {
  assert.equal(display.orderListingSourceLabel({ source: { origin: "LEGACY" } }), "历史订单");
  assert.equal(display.orderListingSourceLabel({ listingFacts: { source: "ORDER_VERSION" } }), "下单时账号资料");
  assert.equal(display.orderListingSourceLabel({ listingFacts: { source: "ACCOUNT_CURRENT" } }), "当前账号资料");
  assert.equal(display.orderListingSourceLabel({ source: { origin: "LEGACY" }, listingFacts: { source: "LEGACY_ACCOUNT_SNAPSHOT" } }), "当前账号资料（迁入时记录）");
  assert.equal(display.orderListingSourceLabel({ listingFactsUnknownReason: "UNREADABLE" }), "账号资料未确认");
  assert.equal(display.orderListingSourceLabel({}), null);
});

test("server opening and renting stages stay distinct, while rejection stays explicit", () => {
  assert.equal(display.orderSettlementStageLabel({ stage: { code: "NONE", label: null } }), null);
  assert.equal(display.orderSettlementStageLabel({ stage: { code: "UNKNOWN", label: "未确认" } }), null);
  assert.equal(display.orderSettlementStageLabel({ stage: { code: "RENTING", label: "租赁中" } }), "租赁中");
  assert.equal(display.orderSettlementStageLabel({ stage: { code: "OPENING_PENDING", label: "未记录开租" } }), "未记录开租");
  assert.equal(display.orderSettlementStageLabel({ stage: { code: "DECISION_REJECTED", label: "结算方案未达成一致" } }), "结算方案未达成一致");
  assert.match(display.orderFulfillmentSummary({ stage: "ENDING" }, { ending: "REJECTED" }), /本版已拒绝/);
  const opening = { stage: "OPENING_CONFIRM", openingState: "NONE", openingAcks: { renter: false, owner: false } };
  assert.equal(display.orderFulfillmentSummary(opening), "开租确认 · 待生成或核对开租清单");
  assert.equal(display.orderFulfillmentSummary({ ...opening, openingState: "DRAFT" }), "开租确认 · 租客未记录 · 号主未记录");
  assert.equal(display.orderFulfillmentSummary({ ...opening, openingState: "PARTIAL", openingAcks: { renter: true, owner: false } }), "开租确认 · 租客确认已记录 · 号主未记录");
});

test("owner projections and historical owner records never borrow renter money", () => {
  const native = { amounts: { ownerExpectedIncome: yuan("135.00"), totalDue: null }, quote: { ownerTotal: null } };
  assert.equal(display.orderAmountFacts(native, "owner").main, "135.00 元");
  const legacy = { readOnly: true, source: { origin: "LEGACY" }, legacyAmounts: { paid: yuan("900.00"), deposit: yuan("300.00") }, payment: { state: "RECORDED_PAID" } };
  const facts = display.orderAmountFacts(legacy, "owner");
  assert.equal(facts.main, "未记录");
  assert.deepEqual(facts.secondary, []);
  assert.doesNotMatch(JSON.stringify(facts), /900|300|租客实付/);
  assert.equal(display.orderAmountFacts({ ...legacy, legacyAmounts: null }, "owner").main, "未记录");
});

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

test("bill quantities are compact and exact while missing quantities remain unknown", () => {
  assert.equal(display.orderLineQuantityText({ name: "哈夫币", unit: "HAFF_BASE", quantity: "1680000000" }), "1,680 M");
  assert.equal(display.orderLineQuantityText({ name: "哈夫币", unit: "HAFF_BASE", quantity: "1500001" }), "1.500001 M");
  assert.equal(display.orderLineQuantityText({ name: "保险（天）", unit: "DAY", quantity: "3" }), "3");
  assert.equal(display.orderLineQuantityText({ name: "保险卡", unit: "DAY", quantity: "3" }), "3 天");
  assert.equal(display.orderLineQuantityText({ name: "哈夫币", unit: "HAFF_BASE" }), "数量未记录");
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
  assert.ok(labels.includes("未消耗物资预付款（按下单时分配）"));
  assert.ok(labels.includes("未消耗哈夫币预付款（按下单时分配）"));
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

test("cents-suffixed postings keep the exact value, one currency unit and an unknown one stays unknown", () => {
  assert.equal(display.moneyCents("16836"), "¥168.36");
  assert.equal(display.moneyCents("0"), "¥0.00");
  assert.equal(display.moneyCents("-150"), "-¥1.50");
  assert.equal(display.moneyCents(null), "—");
  assert.equal(display.moneyCents(undefined), "—");
  assert.equal(display.moneyCents("168.36"), "—");
  // 单一单位：任何 moneyCents 输出都不能同时带 ¥ 和「元」，也不能重复 ¥。
  for (const value of ["1", "0", "16836", "-150", "99999999999"]) {
    assert.doesNotMatch(display.moneyCents(value), /¥.* 元|^¥¥/, value);
  }
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
  const actual={...version,inputSnapshot:{lines:[...version.inputSnapshot.lines,{itemId:"coffee",openingQuantity:"0",remainingQuantity:"0",consumedQuantity:"2"},{itemId:"unused",openingQuantity:"0",remainingQuantity:"0",consumedQuantity:"0"}]},computation:{consumed:{...version.computation.consumed,items:[...version.computation.consumed.items,{itemId:"coffee",consumed:"2",remaining:"0"}]}}};
  const extra=display.consumptionRows(order,opening,actual,[{itemId:"coffee",name:"咖啡豆",unit:"PIECE"},{itemId:"unused",name:"未使用物资",unit:"PIECE"}]);
  assert.deepEqual(extra.at(-1),{itemId:"coffee",name:"咖啡豆",unit:"PIECE",opening:"0",remaining:"0",consumed:"2"});
  assert.equal(extra.some(row=>row.itemId==="unused"),false);
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
  assert.equal(display.orderResourceSummary(order), "哈夫币消耗 12.50 · 6级子弹 60 · 顶级保险卡 7 天 · +1项");
  assert.equal(display.orderAccountTitle(order), "哈夫币消耗 12.50 · 6级子弹 60 · 顶级保险卡 7 天 · +1项");
  assert.equal(display.orderUsesResourceSummary(order), true);
  assert.ok(!display.orderAccountTitle(order).includes("PRIVATE_CURRENT_ACCOUNT_TITLE"));
  assert.equal(display.orderAccountTitle({ ...order, account: { readable: true } }), "哈夫币消耗 12.50 · 6级子弹 60 · 顶级保险卡 7 天 · +1项");
});

test("a short order summary names omitted nonzero resources and detail retains every frozen quantity", () => {
  const order = { orderFacts: { resources: [
    { code: 'df_billable_haff', quantity: '64.00', unit: null },
    { code: 'df_billable_awm_bullet', quantity: '46', unit: null },
    { code: 'df_billable_level6_helmet', quantity: '4', unit: null },
    { code: 'df_billable_level6_armor', quantity: '7', unit: null },
    { code: 'df_billable_coffee', quantity: '0', unit: null },
  ] } };
  assert.equal(display.orderResourceSummary(order), '哈夫币消耗 64.00 · AWM子弹 46 · 6级头盔 4 · +1项');
  assert.deepEqual(display.orderResourceLines(order).map(({name, value}) => [name, value]), [
    ['哈夫币消耗', '64.00'], ['AWM子弹', '46'], ['6级头盔', '4'], ['6级护甲', '7'], ['咖啡豆', '0'],
  ]);
});

test("legacy amount facts keep renter evidence private instead of relabelling it as owner income", () => {
  const order = {
    readOnly: true, source: { origin: "LEGACY" }, status: "CANCELLED",
    payment: { state: "RECORDED_PAID" },
    legacyAmounts: { required: yuan("66.00"), paid: yuan("66.00"), deposit: yuan("0.00"), refund: null },
  };
  const renter = display.orderAmountFacts(order, "renter");
  const owner = display.orderAmountFacts(order, "owner");
  assert.equal(renter.main, "66.00 元");
  assert.equal(owner.main, "未记录");
  assert.equal(renter.caption, "已付金额记录");
  assert.equal(owner.caption, "收益未记录");
  assert.deepEqual(owner.secondary, []);
  assert.doesNotMatch(JSON.stringify(owner), /66\.00|租客实付/);
  const unknown = display.orderAmountFacts({ ...order, legacyAmounts: { required: null, paid: null, deposit: null, refund: null }, payment: { state: "UNKNOWN" } }, "owner");
  assert.equal(unknown.main, "未记录");
  assert.deepEqual(unknown.secondary, []);
});

test("legacy owner captions never invent 待结算 for cancelled or unpaid rows", () => {
  const unpaidCancel = {
    readOnly: true, source: { origin: "LEGACY" }, status: "CANCELLED",
    payment: { state: "RECORDED_UNPAID" }, legacyAmounts: { required: yuan("10.00"), paid: null, deposit: null, refund: null },
  };
  assert.equal(display.orderAmountFacts(unpaidCancel, "owner").caption, "已取消 · 未付款");
  const completedMissing = {
    readOnly: true, source: { origin: "LEGACY" }, status: "COMPLETED",
    payment: { state: "RECORDED_PAID" }, legacyAmounts: { required: yuan("10.00"), paid: yuan("10.00"), deposit: null, refund: null },
  };
  assert.equal(display.orderAmountFacts(completedMissing, "owner").caption, "收益未记录");
  assert.doesNotMatch(JSON.stringify([
    display.orderAmountFacts(unpaidCancel, "owner"),
    display.orderAmountFacts(completedMissing, "owner"),
  ]), /待结算/);
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
  for (const party of ["renter"]) {
    const facts = display.orderAmountFacts(order, party);
    assert.deepEqual(facts.secondary, ["押金 57.00 元", "原退款金额记录 87.00 元"]);
    assert.ok(!facts.secondary.some((line) => /应退责任|仍欠|已到账|净/.test(line)), `${party} must not read the record as a live duty`);
  }
  assert.deepEqual(display.orderAmountFacts(order, "owner").secondary, [], "the owner does not receive the renter refund record");
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
  assert.equal(display.orderResourceSummary(order), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderAccountTitle(order), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderUsesResourceSummary(order), true);
  // an empty/null current title behaves the same way
  assert.equal(display.orderAccountTitle({ ...order, title: null }), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderAccountTitle({ ...order, title: "   " }), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  // a stored title never overrides the frozen resource facts
  assert.equal(display.orderAccountTitle({ ...order, title: "真实当前标题" }), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
  assert.equal(display.orderUsesResourceSummary({ ...order, title: "真实当前标题" }), true);
  assert.equal(display.orderAccountTitle({ ...order, account: { readable: false }, title: "PRIVATE_CURRENT_ACCOUNT_TITLE" }), "哈夫币消耗 12.50 · 顶级保险卡 7 天");
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

test("ORDER-A: reference unit prices round to cents without changing the snapshot's unit pair", () => {
  const amount = (value) => ({ currency: "CNY", unit: "yuan", amount: value, scale: 8 });
  assert.equal(display.orderUnitPriceText(amount("0.12345678"), "1000000", "HAFF_BASE"), "约 ¥0.12 / 1,000,000 哈夫币（1 M）");
  assert.equal(display.orderUnitPriceText(amount("0.00000012"), "60", "ROUND"), "< ¥0.01 / 60 发");
  assert.equal(display.orderUnitPriceText(amount("1.00000000"), "1", "PIECE"), "¥1.00 / 1 件");
  assert.equal(display.orderUnitPriceText(amount("2.00000000"), null, "DAY"), "¥2.00");
  assert.equal(display.orderUnitPriceText(amount("0.005"), "1", "PIECE"), "约 ¥0.01 / 1 件");
  assert.equal(display.orderUnitPriceText(amount("0.999"), "1", "PIECE"), "约 ¥1.00 / 1 件");
  assert.equal(display.orderUnitPriceText(amount("90071992547409930.015"), null, "DAY"), "约 ¥90071992547409930.02");
  assert.equal(display.orderUnitPriceText(amount("0.12345678901234567"), "1", "PIECE"), null);
  assert.equal(display.orderUnitPriceText(null, "1", "PIECE"), null);
});

test("ORDER-A: the fee total names the resource subtotal, never the deposit or owner income", () => {
  assert.equal(display.orderLinesTotalLabel("renter"), "资源合计（不含押金）");
  assert.equal(display.orderLinesTotalLabel("owner"), "号主报价合计");
});

test("historical owner income is shown only with explicit original-net evidence", () => {
  const order = { readOnly: true, source: { origin: "LEGACY" }, ownerIncomeSource: { source: "LEGACY_ORDER_SNAPSHOT", sourceLabel: "旧平台原单净收益记录" }, amounts: { ownerRecordedIncome: yuan("87.00") } };
  const facts = display.orderAmountFacts(order, "owner");
  assert.equal(facts.main, "87.00 元"); assert.equal(facts.caption, "已结算");
  assert.deepEqual(facts.secondary, []);
  assert.equal(display.orderAmountFacts({ ...order, ownerIncomeSource: undefined }, "owner").main, "未记录");
  assert.equal(display.orderAmountFacts({ ...order, amounts: { ownerRecordedIncome: null } }, "owner").main, "未记录");
  assert.equal(display.orderAmountFacts({ ...order, amounts: { ownerRecordedIncome: null } }, "owner").caption, "无号主收益记录");
});


test("membership labels keep the tier and aggregate ratio readable", () => {
  assert.equal(display.orderMembershipText({ tier: "SILVER", payableRatio: "0.98000000" }), "银卡会员 · 9.8折");
  assert.equal(display.orderMembershipText({ tier: "GOLD" }), "金卡会员");
  assert.equal(display.orderMembershipText({ tier: "UNKNOWN_TIER" }), null);
  assert.equal(display.membershipDiscountLabel("1.00000000"), null);
  assert.equal(display.membershipDiscountLabel("0.90000000"), "9折");
});

test("haff quantities show one exact M figure without the raw base units", () => {
  assert.equal(display.haffMillionsText("0"), "0 M");
  assert.equal(display.haffMillionsText("500000"), "0.5 M");
  assert.equal(display.haffMillionsText("1000000"), "1 M");
  assert.equal(display.haffMillionsText("123456789"), "123.456789 M");
  assert.equal(display.haffMillionsText(null), "未记录");
  assert.equal(display.haffMillionsText("not-a-number"), "not-a-number");
});

test("membership discount requires complete unique resource lines and an authoritative total",()=>{
 const personal=[{itemId:'item-1',quantity:'2',buyerAmount:yuan('8.00')}];
 const reference=[{itemId:'item-1',quantity:'2',costAmount:'10.00'}];
 assert.equal(display.matchingResourceDiscount(personal,yuan('8.00'),reference)?.reduction,200n);
 assert.equal(display.formatNiceZhe(10000n,9800n),'9.8折');
 assert.equal(display.matchingResourceDiscount(personal,null,reference),null);
 assert.equal(display.matchingResourceDiscount([...personal,...personal],yuan('16.00'),reference),null);
 assert.equal(display.matchingResourceDiscount(personal,yuan('8.00'),[...reference,...reference]),null);
 assert.equal(display.matchingResourceDiscount(personal,yuan('8.00'),[...reference,{itemId:'item-2',quantity:'1',costAmount:'2.00'}]),null);
});

test("new quote displays actual growth tier and separate whole-price/deposit sources without old tier labels", () => {
  const quote = {
    membershipBenefits: {
      schema: "membership-benefits-v1",
      effectiveTier: "GOLD",
      policyTier: "GOLD",
      priceSource: "FRIEND",
      depositSource: "GROWTH",
      policyVersion: "1",
    },
    customerTier: "VIP",
  };
  assert.equal(display.personalMembershipLabel(quote), "金卡会员");
  assert.equal(display.personalBenefitSources(quote), "价格：挚友礼遇；押金：成长权益");
  assert(!display.personalMembershipLabel(quote).includes("VIP"));
  quote.membershipBenefits.effectiveTier = "BLACK_GOLD";
  quote.membershipBenefits.policyTier = "DIAMOND";
  assert.equal(display.personalMembershipLabel(quote), "黑金会员·终身");
  assert.equal(display.personalMembershipLabel({ customerTier: "SVIP" }), "既有确认方案");
  assert.equal(display.personalMembershipLabel({}), "会员权益未记录");
  assert.equal(display.personalBenefitSources({ customerTier: "STANDARD" }), null);
});



/* --- Order Aftersale DTO & Boundary Rules --- */


import { parseAftersalePage, parseAftersaleRecord } from "../../../packages/im-client/src/aftersale.ts";

const asRow=(id="ASrecord1",description="本人的订单问题")=>({id,orderSource:"NATIVE",orderId:"order",orderDisplayNo:"DD-TEST",requesterParty:"RENTER",description,state:"PENDING",result:null,version:1,handler:null,createdAt:"2026-11-01T00:00:00Z",updatedAt:"2026-11-01T00:00:00Z",resolvedAt:null});
const asPage=(items=[],canSubmit=true)=>({items,canSubmit,nextCursor:null});

test("aftersale response boundary rejects malformed status/handler instead of rendering false completion",()=>{
  assert.equal(parseAftersaleRecord(asRow()).state,"PENDING");assert.throws(()=>parseAftersaleRecord({...asRow(),state:"RESOLVED"}));
  assert.throws(()=>parseAftersaleRecord({...asRow(),orderSource:"LEGACY"}));assert.throws(()=>parseAftersaleRecord({...asRow(),handler:{id:"x",name:""}}));
  assert.throws(()=>parseAftersalePage({items:[],nextCursor:null}));assert.equal(parseAftersalePage(asPage()).canSubmit,true);
});


/* --- Order Intent & IM Order Reference Rules --- */

import { Window as OrderWindow } from "happy-dom";
const orderWin = new OrderWindow({ url: "http://127.0.0.1/accounts" });
globalThis.window = orderWin;
const orderIntents = requireFromTree(path.join(tree, "apps/web/src/lib/order-intents.ts"));

test("an intent is persisted per user, action and resource and reloads exactly", () => {
  const saved = orderIntents.saveIntent({ userId: "user_A", kind: "order.create.v2", resourceId: "account_1", key: "key_1", body: {}, token: "token_1", context: { payable: "470.00" } });
  assert.equal(saved.persisted, true);
  const loaded = orderIntents.loadIntent("user_A", "order.create.v2", "account_1");
  assert.equal(loaded.key, "key_1");
  assert.equal(loaded.token, "token_1");
  assert.equal(loaded.context.payable, "470.00");
  assert.equal(loaded.version, 1);
});

test("another identity can never load or reuse the intent", () => {
  orderIntents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_1", key: "key_2", body: {} });
  assert.equal(orderIntents.loadIntent("user_B", "order.payment", "order_1"), null);
  assert.notEqual(orderIntents.loadIntent("user_A", "order.payment", "order_1"), null);
});

test("Native channel intent keeps its own method/key and never replaces the controlled payment slot", () => {
  orderIntents.saveIntent({userId:"user_native",kind:"order.payment",resourceId:"same_order",key:"controlled_key",body:{}});
  orderIntents.saveIntent({userId:"user_native",kind:"order.channel-payment",resourceId:"same_order",key:"native_key",body:{method:"WEIXIN_NATIVE"}});
  const recovered=orderIntents.loadIntent("user_native","order.channel-payment","same_order");
  assert.equal(recovered.key,"native_key");assert.deepEqual(recovered.body,{method:"WEIXIN_NATIVE"});
  assert.equal(orderIntents.loadIntent("user_native","order.payment","same_order").key,"controlled_key");
  assert.equal(orderIntents.loadIntent("other_user","order.channel-payment","same_order"),null);
  orderIntents.clearIntent("user_native","order.channel-payment","same_order");orderIntents.clearIntent("user_native","order.payment","same_order");
});

test("saving again preserves the original key and creation time", async () => {
  const first = orderIntents.saveIntent({ userId: "user_A", kind: "order.cancel", resourceId: "order_2", key: "key_3", body: {} }).intent;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = orderIntents.saveIntent({ userId: "user_A", kind: "order.cancel", resourceId: "order_2", key: "key_3", body: {} }).intent;
  assert.equal(second.key, "key_3");
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
});

test("receipts are frozen on the intent and a different resource is a different slot", () => {
  orderIntents.saveIntent({ userId: "user_A", kind: "settlement.submit", resourceId: "order_3", key: "key_4", body: { lines: [] } });
  orderIntents.recordIntentReceipt("user_A", "settlement.submit", "order_3", { status: 200, body: { ok: true } });
  assert.deepEqual(orderIntents.loadIntent("user_A", "settlement.submit", "order_3").receipt, { status: 200, body: { ok: true } });
  assert.equal(orderIntents.loadIntent("user_A", "settlement.submit", "order_4"), null);
  orderIntents.clearIntent("user_A", "settlement.submit", "order_3");
  assert.equal(orderIntents.loadIntent("user_A", "settlement.submit", "order_3"), null);
});

test("age never deletes an unresolved intent; it only disables automatic replay", () => {
  orderIntents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_5", key: "key_5", body: { frozen: true } });
  const storageKey = "zzsh.order-intent.v1:user_A:order.payment:order_5";
  const stored = JSON.parse(orderWin.sessionStorage.getItem(storageKey));
  stored.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  orderWin.sessionStorage.setItem(storageKey, JSON.stringify(stored));
  const loaded = orderIntents.loadIntent("user_A", "order.payment", "order_5");
  assert.ok(loaded, "the unresolved responsibility must remain loadable");
  assert.equal(loaded.key, "key_5");
  assert.deepEqual(loaded.body, { frozen: true });
  assert.equal(orderIntents.isIntentStale(loaded), true);
  assert.equal(orderIntents.isIntentStale(orderIntents.loadIntent("user_A", "order.cancel", "order_2")), false);
});

test("storage failure is reported instead of pretending the intent is recoverable", () => {
  const realWindow = globalThis.window;
  globalThis.window = { sessionStorage: { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} } };
  try {
    const saved = orderIntents.saveIntent({ userId: "user_A", kind: "order.payment", resourceId: "order_6", key: "key_6", body: {} });
    assert.equal(saved.persisted, false);
    assert.equal(orderIntents.loadIntent("user_A", "order.payment", "order_6"), null);
  } finally {
    globalThis.window = realWindow;
  }
});

test("order reference round trips a bounded reference and caption without quote facts", async () => {
  const { encodeOrderReference, parseOrderReference, orderReferenceSummary } = await import(
    "../../../packages/im-client/src/order-reference.ts"
  );
  const order = { id: "order-1", displayNo: "ZZ20261101-00001", title: "三角洲账号", party: "renter" };
  const wire = encodeOrderReference({ ...order, amount: "untrusted", url: "https://bad.invalid" }, " 请核对 \n这笔订单 ");
  assert.deepEqual(parseOrderReference(wire), { order, caption: "请核对 \n这笔订单" });
  assert.doesNotMatch(wire, /untrusted|bad.invalid/);
  assert.equal(orderReferenceSummary(wire), "[订单] 三角洲账号 · ZZ20261101-00001");

  for (const patch of [{ id: "../users/private" }, { id: "javascript:bad" }, { title: "\n伪造" }, { party: "admin" }, { title: "x".repeat(241) }]) {
    assert.throws(() => encodeOrderReference({ ...order, ...patch }));
    assert.equal(parseOrderReference("【关联订单卡】" + JSON.stringify({ version: 1, ...order, ...patch })), null);
  }
  assert.equal(parseOrderReference("【关联订单卡】" + JSON.stringify({ version: 2, ...order })), null);
  assert.equal(parseOrderReference("【关联订单卡】{"), null);
  assert.throws(() => encodeOrderReference(order, "x".repeat(4000)));
  assert.equal(orderReferenceSummary("普通消息"), "普通消息");
  assert.equal(orderReferenceSummary("【关联订单卡】{\"version\":"), "[订单]");
});
