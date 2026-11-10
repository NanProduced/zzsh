import { test } from "node:test";
import { strict as assert } from "node:assert";
import { admitLegacyEvidence, planLegacyContinuation, planVerifiedLegacySettlement, LEGACY_REJECT_ASSIGNMENTS, type LegacyContinuationSource, type LegacyPrices, type LegacyQuantities, type LegacySettlementBasis } from "../src/order/legacy-continuation-calc";
import { deriveLegacyFacts, initialLegacyFacts, legacyPlanYuanToCents } from "../src/order/legacy-continuation-model";

const names = ["barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"] as const;
const prices = (value: string | null): LegacyPrices => Object.fromEntries(names.map(name => [name, value])) as LegacyPrices;
const qty = (haff: string | null, barrett = "0.00"): LegacyQuantities => ({ expendHaff: haff, ...prices("0.00"), barrett });
const policy = { advanceOrderSetRatio: "90", expend: Object.fromEntries(["barrettBullet", "bullet", "awm", "armor", "helmet", "coffee", "experienceCard", "barrettBulletSale", "bulletSale", "awmSale", "armorSale", "helmetSale", "coffeeSale", "experienceCardSale"].map(key => [key, "0.20"])) };
function source(patch: Partial<LegacyContinuationSource> = {}): LegacyContinuationSource {
  return { legacyOrderId: "7", orderStatus: "3", isSettle: "0", renterId: "11", ownerId: "22", accountId: "33", profitDot: "2", baseBot: "10", payMoney: "100.00", goodsMoney: "10.00", storedCommissionMoney: "0.00", depositAmount: "57.00", detainMoney: "0.00", returnOrderMoney: null, saleEarnings: null, fullPayoutMoney: "0.00", isFullPayout: "0", isAdvanceSet: "0", orderPrices: prices("8.00"), accountPrices: prices("8.00"), quantities: qty(null), paidPay: [{ id: "9", payOrderSn: "P7", payMoney: "100.00" }], commissions: [], policy, ...patch };
}
const renter = { role: "renter" as const, legacyUserId: "11" };
const owner = { role: "owner" as const, legacyUserId: "22" };
const plan = (patch: Partial<LegacyContinuationSource>, command: Parameters<typeof planLegacyContinuation>[1]) => planLegacyContinuation(admitLegacyEvidence(source(patch)), command);

test("verified old orders use quantity-only threshold and the shared early fee for both parties", () => {
  const original = source({ baseBot: "110", profitDot: "10", goodsMoney: "100.00", storedCommissionMoney: "9.00", depositAmount: "0.00" });
  const quantities = qty("60.00");
  const basis: LegacySettlementBasis = { id: "basis_1", openingHaffM: "100", baseBot: "110", ownerPrices: prices("1.00"),
    openingItems: qty("100"), fullPayout: false };
  const results = [renter, owner].map(caller => planVerifiedLegacySettlement(admitLegacyEvidence(original), { kind: "propose", caller, quantities, endReason:"TENANT_VOLUNTARY_EARLY" }, basis));
  for (const result of results) {
    assert(result.ok); assert.equal(result.isAdvanceSet, 1);
    assert.equal(result.amounts.earlyMakeup, "2.25");
    assert.equal(result.amounts.returnOrderMoney, "37.75");
    assert.equal(result.amounts.ownerNet, "55.00");
  }
  const ownerReason = planVerifiedLegacySettlement(admitLegacyEvidence(original), { kind: "propose", caller: renter, quantities, endReason: "OWNER_OR_ACCOUNT_EARLY" }, basis);
  assert(ownerReason.ok); assert.equal(ownerReason.amounts.earlyMakeup, "0.00"); assert.equal(ownerReason.amounts.returnOrderMoney, "40.00");
  const normalQty = qty("70.00");
  const normal = planVerifiedLegacySettlement(admitLegacyEvidence(original), { kind: "propose", caller: renter, quantities: normalQty, endReason:"NORMAL" }, basis);
  assert(normal.ok); assert.equal(normal.isAdvanceSet, 0); assert.equal(normal.amounts.earlyMakeup, "0.00");
  const missingReason=planVerifiedLegacySettlement(admitLegacyEvidence(original),{kind:"propose",caller:renter,quantities},basis);
  assert(!missingReason.ok);assert.equal(missingReason.code,"END_REASON_REQUIRED");
  const incorrectReason=planVerifiedLegacySettlement(admitLegacyEvidence(original),{kind:"propose",caller:renter,quantities,endReason:"NORMAL"},basis);
  assert(!incorrectReason.ok);assert.equal(incorrectReason.code,"END_REASON_INCONSISTENT");
  const changedPayout=planVerifiedLegacySettlement(admitLegacyEvidence(original),{kind:"propose",caller:renter,quantities,endReason:"TENANT_VOLUNTARY_EARLY"},{...basis,fullPayout:true});
  assert(!changedPayout.ok);assert.equal(changedPayout.code,"OPENING_BASIS_UNVERIFIED");
  const mismatch = planVerifiedLegacySettlement(admitLegacyEvidence(original), { kind: "propose", caller: renter, quantities }, { ...basis, baseBot: "111" });
  assert.equal(mismatch.ok, false);
  const withPayout = planVerifiedLegacySettlement(admitLegacyEvidence({...original,isFullPayout:"1"}), { kind: "propose", caller: renter, quantities, endReason:"TENANT_VOLUNTARY_EARLY" }, { ...basis, fullPayout: true });
  assert(withPayout.ok); assert.equal(withPayout.amounts.renterPayoutFee, "7.28"); assert.equal(withPayout.amounts.ownerNet, "55.00");
  const payoutCommand={kind:"propose" as const,caller:renter,quantities,endReason:"TENANT_VOLUNTARY_EARLY" as const,settlementBasis:{...basis,fullPayout:true}};
  const payoutFacts=deriveLegacyFacts(initialLegacyFacts({...original,isFullPayout:"1"}),withPayout,payoutCommand,"input","payout_proposal");
  const payoutConfirm=planLegacyContinuation(payoutFacts.evidence,{kind:"confirm",caller:owner});assert(payoutConfirm.ok);
  assert.equal(payoutConfirm.amounts.renterPayoutFee,"7.28");assert.equal(payoutConfirm.amounts.commissionPool,withPayout.amounts.commissionPool);
  const proposalCommand = { kind: "propose" as const, caller: renter, quantities, settlementBasis: basis, endReason:"TENANT_VOLUNTARY_EARLY" as const };
  const proposed = results[0]!; assert(proposed.ok);
  const facts = deriveLegacyFacts(initialLegacyFacts(original), proposed, proposalCommand, "input", "proposal");
  const confirmed = planLegacyContinuation(facts.evidence, { kind: "confirm", caller: owner }); assert(confirmed.ok);
  assert.equal(confirmed.amounts.refundNet, proposed.amounts.returnOrderMoney);
  assert.equal(confirmed.amounts.commissionPool, proposed.amounts.commissionPool);
});

test("旧单客服特殊取消按原实付分配，不改变旧单价格且不计佣金",()=>{
  const actor={role:"admin" as const,legacyUserId:""};
  const command={kind:"support_cancel" as const,caller:actor,refundCents:"5000",ownerCents:"3000"};
  for(const status of ["3","8","9"]){
    const input=source({orderStatus:status}),facts=initialLegacyFacts(input),result=planLegacyContinuation(facts.evidence,command);
    if(!result.ok)assert.fail(result.code);
    assert.deepEqual([result.nextStatus,result.amounts.refundNet,result.amounts.ownerNet,result.amounts.platformContribution,result.amounts.commissionPool],
      ["5","50.00","30.00","20.00","0.00"]);
    assert.deepEqual(result.commissionRevisions,[]);
    const after=deriveLegacyFacts(facts,result,command,"source","cancel");
    assert.equal(after.evidence.source.orderStatus,"5");assert.deepEqual(after.evidence.source.orderPrices,input.orderPrices);
    assert.deepEqual(after.evidence.source.accountPrices,input.accountPrices);assert.equal(facts.evidence.source.orderStatus,status);
  }
  const isolated=plan({baseBot:null},command);assert.equal(isolated.ok,true,"取消不依赖旧单物资价格或比例齐全");
  assert.throws(()=>initialLegacyFacts(source({orderStatus:"5"})),/STATUS_INVALID/);
  const held=plan({isSettle:"2",detainMoney:"5.00"},command);assert.equal(held.ok&&held.isSettle,"0");
  for(const invalid of [
    plan({}, {...command,refundCents:"8000",ownerCents:"3000"}),
    plan({}, {...command,refundCents:"1.5"}),
    plan({}, {...command,caller:renter}),
    plan({orderStatus:"4"},command),
    plan({isSettle:"3"},command),
    plan({paidPay:[]},command),
    plan({paidPay:[{id:"9",orderId:"8",payOrderSn:"P7",payMoney:"100.00"}]},command),
    plan({paidPay:[{id:"bad",payOrderSn:"P7",payMoney:"100.00"}]},command),
    plan({paidPay:[{id:"9",payOrderSn:"P7!",payMoney:"100.00"}]},command),
    plan({commissions:[{id:"1",beneficiaryId:"44",ratio:"20",level:"2",status:"9",storedEarnings:"1.00"}]},command),
    plan({commissions:[{id:"1",beneficiaryId:"44",ratio:"20",level:"2",status:"1",storedEarnings:"1.00"},{id:"1",beneficiaryId:"44",ratio:"20",level:"2",status:"1",storedEarnings:"1.00"}]},command),
    plan({commissions:[{id:"1",beneficiaryId:"44",ratio:"20",level:"2",status:"2",storedEarnings:"1.00"}]},command),
  ])assert.equal(invalid.ok,false);
});

test("hand golden matches the isolated Java transcription for ordinary, advance, and payout", () => {
  const ordinary = plan({}, { kind: "propose", caller: renter, quantities: qty("1.00") });
  assert.equal(ordinary.ok, true);
  if (ordinary.ok) {
    assert.equal(ordinary.nextStatus, "8");
    assert.equal(ordinary.applied, false);
    assert.equal(ordinary.isAdvanceSet, 0);
    assert.deepEqual([ordinary.amounts.returnOrderMoney, ordinary.amounts.saleEarnings, ordinary.amounts.fullPayoutMoney, ordinary.amounts.ownerNet, ordinary.amounts.commissionPool], ["87.00", "10", null, "10.00", "3.00"]);
  }
  const early = plan({ goodsMoney: "100.00" }, { kind: "propose", caller: renter, quantities: qty("1.00") });
  assert.equal(early.ok && early.isAdvanceSet, 1);
  if (early.ok) assert.deepEqual([early.amounts.returnOrderMoney, early.amounts.saleEarnings, early.amounts.commissionPool], ["90.00", "10", "0.00"]);
  const payout = plan({ isFullPayout: "1" }, { kind: "propose", caller: renter, quantities: qty("1.00") });
  if (!payout.ok) assert.fail(payout.code);
  assert.deepEqual([payout.amounts.fullPayoutMoney, payout.amounts.ownerNet, payout.amounts.saleEarnings], ["0.80", "9.20", "10"]);
});

test("equal threshold does not become advance, and the next cent does", () => {
  const same = plan({ policy: { ...policy, advanceOrderSetRatio: "100" }, goodsMoney: "13.00" }, { kind: "preview", caller: renter, quantities: qty("1.00") });
  const over = plan({ policy: { ...policy, advanceOrderSetRatio: "100" }, goodsMoney: "13.01" }, { kind: "preview", caller: renter, quantities: qty("1.00") });
  assert.equal(same.ok && same.isAdvanceSet, 0);
  assert.equal(over.ok && over.isAdvanceSet, 1);
});

test("owner preview and owner propose use different price sources", () => {
  const quantities = qty("1.00", "1");
  const patch = { goodsMoney: "20.00", accountPrices: { ...prices("8.00"), barrett: "10.00" }, orderPrices: { ...prices("8.00"), barrett: "20.00" } };
  const preview = plan(patch, { kind: "preview", caller: owner, quantities });
  const propose = plan(patch, { kind: "propose", caller: owner, quantities });
  if (!preview.ok || !propose.ok) assert.fail("price paths should calculate");
  assert.equal(preview.nextStatus, null);
  assert.equal(preview.isAdvanceSet, 1);
  assert.equal(preview.amounts.saleEarnings, "10.20");
  assert.equal(propose.nextStatus, "9");
  assert.equal(propose.isAdvanceSet, 0);
  assert.deepEqual([propose.amounts.saleEarnings, propose.amounts.returnOrderMoney], ["20.00", "67.00"]);
});

test("preview does not move status and a repeated call keeps the fingerprint", () => {
  const command = { kind: "preview" as const, caller: renter, quantities: qty("1.00") };
  const first = plan({}, command);
  const second = plan({}, command);
  if (!first.ok || !second.ok) assert.fail("preview should calculate");
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.ok && first.nextStatus, null);
});

test("confirm uses the stored settlement and revises only unsettled commission rows", () => {
  const result = plan({ orderStatus: "8", saleEarnings: "10.00", returnOrderMoney: "87.00", fullPayoutMoney: "0.00", commissions: [
    { id: "1", beneficiaryId: "44", ratio: "50.00", level: "2", status: "1", storedEarnings: "9.99" },
    { id: "2", beneficiaryId: "45", ratio: "50.00", level: "3", status: "2", storedEarnings: "9.99" },
  ] }, { kind: "confirm", caller: owner });
  if (!result.ok) assert.fail(result.code);
  assert.equal(result.nextStatus, "4");
  assert.equal(result.amounts.commissionPool, "3.00");
  assert.equal(result.amounts.ownerNet, "10.00");
  assert.deepEqual(result.commissionRevisions.map(row => [row.id, row.legalEarnings, row.recalculable]), [["1", "1.50", true], ["2", "9.99", false]]);
  const rounded = plan({ orderStatus: "9", payMoney: "0.01", saleEarnings: "0.00", returnOrderMoney: "0.00", fullPayoutMoney: "0.00", paidPay: [{ id: "9", payOrderSn: "P7", payMoney: "0.01" }], commissions: [{ id: "3", beneficiaryId: "44", ratio: "50.00", level: "2", status: "1", storedEarnings: "0.00" }] }, { kind: "confirm", caller: renter });
  if (!rounded.ok) assert.fail(rounded.code);
  assert.equal(rounded.commissionRevisions[0]!.legalEarnings, "0.01");
});

test("illegal role, status, quantity, and deposit are refused without a zero fill", () => {
  assert.equal(plan({}, { kind: "propose", caller: { role: "renter", legacyUserId: "99" }, quantities: qty("1.00") }).ok, false);
  assert.equal(plan({}, { kind: "confirm", caller: { role: "admin", legacyUserId: "1" } }).ok, false);
  assert.equal(plan({ orderStatus: "4" }, { kind: "propose", caller: renter, quantities: qty("1.00") }).ok, false);
  assert.equal(plan({}, { kind: "propose", caller: renter, quantities: qty(null) }).ok, false);
  assert.equal(plan({}, { kind: "propose", caller: renter, quantities: { ...qty("1.00"), bullet: "-1.00" } }).ok, false);
  const short = plan({}, { kind: "propose", caller: renter, quantities: qty("20.00") });
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.code, "DEPOSIT_SHORT");
});

test("old used items require original prices even when a common fallback exists", () => {
  for (const orderPrice of [null, "", "0", "0.00"]) for (const caller of [renter, owner]) {
    const patch = { orderPrices: { ...prices("8.00"), barrett: orderPrice } };
    for (const kind of ["preview", "propose"] as const) {
      const result = plan(patch, { kind, caller, quantities: qty("1.00", "1") });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "EVIDENCE_ISOLATED");
    }
    assert.equal(plan(patch, { kind: "propose", caller, quantities: qty("1.00", "0") }).ok, true);
  }
  const missingOwnerPrice = { accountPrices: { ...prices("8.00"), barrett: null } };
  const missing = plan(missingOwnerPrice, { kind: "propose", caller: renter, quantities: qty("1.00", "1") });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "EVIDENCE_ISOLATED");
  assert.equal(plan({ accountPrices: { ...prices("8.00"), barrett: "0.00" } }, { kind: "propose", caller: renter, quantities: qty("1.00", "1") }).ok, true);
  const invalidQuantity = plan({ orderPrices: { ...prices("8.00"), barrett: null } }, { kind: "preview", caller: renter, quantities: { ...qty("1.00", "1"), bullet: "-1" } });
  assert.equal(invalidQuantity.ok, false);
  if (!invalidQuantity.ok) assert.equal(invalidQuantity.code, "QUANTITY_INVALID");
  const existing = plan({ orderStatus: "8", saleEarnings: "10.00", returnOrderMoney: "87.00", orderPrices: { ...prices("8.00"), barrett: null }, ...missingOwnerPrice }, { kind: "confirm", caller: owner });
  assert.equal(existing.ok, true, "a previously submitted old proposal keeps its saved amounts");
});

test("legacy in-flight settlement uses the recorded customer price and account owner price", () => {
  const patch: Partial<LegacyContinuationSource> = { baseBot: "42", profitDot: "4", payMoney: "722.70", goodsMoney: "355.00", depositAmount: "0.00", storedCommissionMoney: "34.00",
    paidPay: [{ id: "9", payOrderSn: "FIXTURE_P7", payMoney: "722.70" }], policy: { ...policy, advanceOrderSetRatio: "70" },
    orderPrices: { ...prices("8.00"), awm: "0.70" }, accountPrices: { ...prices("8.00"), awm: "0.50" } };
  const result = plan(patch, { kind: "propose", caller: renter, quantities: { ...qty("100"), awm: "10" } });
  assert(result.ok);
  assert.equal(result.isAdvanceSet, 0);
  assert.deepEqual([result.amounts.divide, result.amounts.expendOrder, result.amounts.returnOrderMoney, result.amounts.ownerNet], ["263", "7.00", "452.70", "243.00"]);
});

test("reject returns to 3, and hold keeps the recognized return", () => {
  const kept = admitLegacyEvidence(source({ orderStatus: "8" }));
  const rejected = planLegacyContinuation(kept, { kind: "reject", caller: owner });
  const renterRejected = plan({ orderStatus: "9" }, { kind: "reject", caller: renter });
  if (!rejected.ok || !renterRejected.ok) assert.fail("both parties can reject");
  assert.equal(kept.source.orderStatus, "8");
  assert.equal(rejected.assignments?.returnOrderMoney, null);
  assert.equal(rejected.assignments?.fullPayoutMoney, "0");
  assert.equal(rejected.assignments?.barrettBulletNum, "0");
  assert.equal(rejected.assignments?.disagreeCountDelta, "1");
  assert.equal(rejected.assignments?.orderStatus, "3");
  assert.deepEqual(renterRejected.assignments, LEGACY_REJECT_ASSIGNMENTS);
  const held = plan({ orderStatus: "4", returnOrderMoney: "57.00", isSettle: "0" }, { kind: "hold", caller: { role: "admin", legacyUserId: "1" } });
  if (!held.ok) assert.fail(held.code);
  assert.equal(held.amounts.returnOrderMoney, "57.00");
  assert.equal(held.isSettle, "2");
  assert.equal(held.recognitionDelta, "0");
  const released = plan({ orderStatus: "4", returnOrderMoney: "57.00", isSettle: "2" }, { kind: "release", caller: { role: "admin", legacyUserId: "1" } });
  const confiscated = plan({ orderStatus: "4", returnOrderMoney: "57.00", isSettle: "2" }, { kind: "confiscate", caller: { role: "admin", legacyUserId: "1" } });
  assert.equal(released.ok && released.isSettle, "0");
  assert.equal(released.ok && released.amounts.returnOrderMoney, "57.00");
  assert.equal(confiscated.ok && confiscated.amounts.returnOrderMoney, "57.00");
  assert.equal(confiscated.ok && confiscated.amounts.depositCompensation, "57.00");
});

test("missing base bot or a conflicting payment isolates the evidence and blocks calculation", () => {
  const missing = admitLegacyEvidence(source({ baseBot: null }));
  assert.equal(missing.admission, "ISOLATED");
  assert.equal(missing.reasons.includes("MISSING_BASE_BOT"), true);
  assert.equal(planLegacyContinuation(missing, { kind: "preview", caller: renter, quantities: qty("1.00") }).ok, false);
  const ambiguous = admitLegacyEvidence(source({ paidPay: [{ id: "1", payOrderSn: "A", payMoney: "100.00" }, { id: "2", payOrderSn: "B", payMoney: "100.00" }] }));
  assert.equal(ambiguous.reasons.includes("AMBIGUOUS_PAID_PAY_ROWS"), true);
  const mismatch = admitLegacyEvidence(source({ paidPay: [{ id: "1", payOrderSn: "A", payMoney: "1.00" }] }));
  assert.equal(mismatch.reasons.includes("PAID_AMOUNT_MISMATCH"), true);
  const again = admitLegacyEvidence(source());
  assert.equal(again.parameterDigest, admitLegacyEvidence(source()).parameterDigest);
  assert.notEqual(again.parameterDigest, missing.parameterDigest);
  assert.equal(admitLegacyEvidence(source({ baseBot: "0" })).admission, "ISOLATED");
  assert.equal(admitLegacyEvidence(source({ goodsMoney: "not-a-number" })).admission, "ISOLATED");
  assert.equal(admitLegacyEvidence(source({ payMoney: "100", paidPay: [{ id: "9", payOrderSn: "P7", payMoney: "100.00" }] })).admission, "PARAMETER_COMPLETE");
  assert.equal(admitLegacyEvidence(source({ paidPay: [{ id: "9", orderId: "8", payOrderSn: "P7", payMoney: "100.00" }] })).reasons.includes("PAY_ORDER_MISMATCH"), true);
});

test("a changed source is not accepted under the original digest", () => {
  const evidence = admitLegacyEvidence(source());
  const command = { kind: "propose" as const, caller: renter, quantities: qty("1.00") };
  const before = planLegacyContinuation(evidence, command);
  evidence.source.baseBot = "20";
  const after = planLegacyContinuation(evidence, command);
  if (!before.ok) assert.fail(before.code);
  assert.equal(before.amounts.returnOrderMoney, "87.00");
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.code, "EVIDENCE_DIGEST_MISMATCH");
});

test("confirm refuses a negative owner net or refund net and keeps the old figures", () => {
  const ownerNet = plan({ orderStatus: "8", saleEarnings: "10.00", returnOrderMoney: "80.00", fullPayoutMoney: "20.00" }, { kind: "confirm", caller: owner });
  const refundNet = plan({ orderStatus: "8", saleEarnings: "10.00", returnOrderMoney: "80.00", detainMoney: "90.00" }, { kind: "confirm", caller: owner });
  if (ownerNet.ok || refundNet.ok) assert.fail("negative nets are not executable");
  assert.equal(ownerNet.code, "OWNER_NET_NEGATIVE");
  assert.equal(ownerNet.amounts.ownerNet, "-10.00");
  assert.equal(refundNet.code, "REFUND_NET_NEGATIVE");
  assert.equal(refundNet.amounts.refundNet, "-10.00");
});

test("the live 70 ratio is not the code default 90", () => {
  const live = plan({ policy: { ...policy, advanceOrderSetRatio: "70" }, goodsMoney: "15.00" }, { kind: "propose", caller: renter, quantities: qty("1.00") });
  const fallback = plan({ goodsMoney: "15.00" }, { kind: "propose", caller: renter, quantities: qty("1.00") });
  if (!live.ok || !fallback.ok) assert.fail("threshold cases should calculate");
  assert.deepEqual([live.isAdvanceSet, live.amounts.returnOrderMoney], [0, "87.00"]);
  assert.deepEqual([fallback.isAdvanceSet, fallback.amounts.returnOrderMoney], [1, "90.00"]);
});

test("legacy PROPOSE books an integer-cent 8 percent fee from an exact-cent sale for both parties", () => {
  // The latter three bases/fees/nets are the accepted immutable source assessment examples; inputs remain synthetic.
  for (const example of [
    { account: "0.20", buyer: "0.40", fee: "82", net: "938" },
    { account: "345.10", buyer: "345.30", fee: "2841", net: "32669" },
    { account: "297.90", buyer: "298.10", fee: "2463", net: "28327" },
    { account: "180.20", buyer: "180.40", fee: "1522", net: "17498" },
  ]) for (const caller of [renter, owner]) {
    const original = source({ isFullPayout: "1", payMoney: "10000.00", paidPay: [{ id: "9", payOrderSn: "P7", payMoney: "10000.00" }],
      accountPrices: { ...prices("8.00"), barrett: example.account }, orderPrices: { ...prices("8.00"), barrett: example.buyer } });
    const command = { kind: "propose" as const, caller, quantities: qty("1.00", "1.00") }, result = planLegacyContinuation(admitLegacyEvidence(original), command);
    assert(result.ok); assert.equal(result.isAdvanceSet, 0);
    assert.equal(legacyPlanYuanToCents(result.amounts.fullPayoutMoney!), example.fee);
    assert.equal(legacyPlanYuanToCents(result.amounts.ownerNet!), example.net);
    const facts = deriveLegacyFacts(initialLegacyFacts(original), result, command, "synthetic-precision-input", "synthetic-precision-version");
    assert.equal(facts.evidence.source.fullPayoutMoney, result.amounts.fullPayoutMoney);
    const cents = (key: string) => BigInt(legacyPlanYuanToCents(result.amounts[key]!));
    assert.equal(cents("ownerNet") + cents("fullPayoutMoney"), cents("saleEarnings"));
    assert.equal(cents("ownerNet") + cents("fullPayoutMoney") + cents("returnOrderMoney") + cents("commissionPool"), 1_000_000n);
    const replay = planLegacyContinuation(admitLegacyEvidence(original), command); assert(replay.ok); assert.equal(replay.fingerprint, result.fingerprint);
  }
});

test("an already exact-cent assigned fee retains its padded text and previously accepted fingerprint byte-for-byte", () => {
  const result = plan({ isFullPayout: "1", accountPrices: { ...prices("8.00"), barrett: "0.25" }, orderPrices: { ...prices("8.00"), barrett: "0.25" } }, { kind: "propose", caller: renter, quantities: qty("1.00", "1.00") });
  assert(result.ok);
  assert.deepEqual([result.amounts.saleEarnings, result.amounts.fullPayoutMoney, result.amounts.ownerNet, result.fingerprint], ["10.2500", "0.820000", "9.430000", "ecfa58da3835ced028cbb6b55dd0fe202cc3d2a6e25bfee74d67e725d17b6f5e"]);
});

test("new fractional legacy proposals round stored amounts once and keep the money equation balanced",()=>{
 const original=source({isFullPayout:"1",accountPrices:{...prices("8.00"),barrett:"0.01"},orderPrices:{...prices("8.00"),barrett:"0.01"}});
 for(const caller of [renter,owner]){
  const command={kind:"propose" as const,caller,quantities:qty("1.00","0.50")};
  const result=planLegacyContinuation(admitLegacyEvidence(original),command);assert(result.ok);
  assert.deepEqual([result.amounts.saleEarnings,result.amounts.returnOrderMoney,result.amounts.fullPayoutMoney,result.amounts.ownerNet,result.amounts.commissionPool],
   ["10.01","87.00","0.80","9.21","2.99"]);
  const cents=(key:string)=>BigInt(legacyPlanYuanToCents(result.amounts[key]!));
  assert.equal(cents("ownerNet")+cents("fullPayoutMoney")+cents("returnOrderMoney")+cents("commissionPool"),cents("payMoney"));
  const facts=deriveLegacyFacts(initialLegacyFacts(original),result,command,"fractional-input","fractional-version");
  assert.equal(facts.evidence.source.saleEarnings,"10.01");assert.equal(facts.evidence.source.returnOrderMoney,"87.00");
  const confirmed=planLegacyContinuation(facts.evidence,{kind:"confirm",caller:caller.role==="renter"?owner:renter});assert(confirmed.ok);
  assert.equal(confirmed.amounts.ownerNet,"9.21");assert.equal(confirmed.amounts.refundNet,"87.00");assert.equal(confirmed.amounts.commissionPool,"2.99");
  const replay=planLegacyContinuation(admitLegacyEvidence(original),command);assert(replay.ok);assert.equal(replay.fingerprint,result.fingerprint);
 }
});

test("rounding that would over-allocate an old payment stops the proposal",()=>{
 const original=source({profitDot:"0",accountPrices:{...prices("8.00"),barrett:"0.01"},orderPrices:{...prices("8.00"),barrett:"0.01"}});
 const result=planLegacyContinuation(admitLegacyEvidence(original),{kind:"propose",caller:renter,quantities:qty("1.00","0.50")});
 assert.equal(result.ok,false);if(!result.ok)assert.equal(result.code,"CONFIRM_POOL_NEGATIVE");
});

test("proposals reject exact-cent negative owner income or commission pool before confirmation", () => {
  const command = { kind: "propose" as const, caller: renter, quantities: qty("1.00", "1.00") };
  const negativePool = plan({ orderPrices: { ...prices("8.00"), barrett: "1.00" }, accountPrices: { ...prices("8.00"), barrett: "100.00" } }, command);
  assert.equal(negativePool.ok, false);
  if (!negativePool.ok) assert.equal(negativePool.code, "CONFIRM_POOL_NEGATIVE");
  const negativeOwner = plan({ fullPayoutMoney: "20.00" }, { ...command, quantities: qty("1.00") });
  assert.equal(negativeOwner.ok, false);
  if (!negativeOwner.ok) assert.equal(negativeOwner.code, "OWNER_NET_NEGATIVE");
});

test("CONFIRM consumes the stored fee and never recomputes the newly normalized PROPOSE fee", () => {
  const command = { kind: "confirm" as const, caller: owner }, original = source({ orderStatus: "8", isFullPayout: "1", saleEarnings: "10.20", returnOrderMoney: "87.00", fullPayoutMoney: "0.81" });
  const result = planLegacyContinuation(admitLegacyEvidence(original), command); assert(result.ok);
  assert.equal(result.amounts.fullPayoutMoney, "0.81"); assert.equal(result.amounts.ownerNet, "9.39");
  assert.equal(deriveLegacyFacts(initialLegacyFacts(original), result, command, "synthetic-confirm-input", "synthetic-confirm-version").amounts.ownerNet, "9.39");
  const fractional = source({ ...original, fullPayoutMoney: "0.816" }), unchanged = planLegacyContinuation(admitLegacyEvidence(fractional), command); assert(unchanged.ok);
  assert.equal(unchanged.amounts.fullPayoutMoney, "0.816");
  assert.throws(() => deriveLegacyFacts(initialLegacyFacts(fractional), unchanged, command, "synthetic-confirm-input", "synthetic-confirm-version"), /PRECISION_UNSUPPORTED/);
});

test("legacy PROPOSE refuses negative quantities and the old fee-column overflow", () => {
  const command = { kind: "propose" as const, caller: renter, quantities: qty("1.00", "1.00") };
  for (const amount of ["-0.20", "1249999990.00", "1249999989.99"]) {
    const original = source({ isFullPayout: "1", payMoney: "2000000000.00", paidPay: [{ id: "9", payOrderSn: "P7", payMoney: "2000000000.00" }], accountPrices: { ...prices("8.00"), barrett: amount }, orderPrices: { ...prices("8.00"), barrett: amount } });
    const result = planLegacyContinuation(admitLegacyEvidence(original), command);
    if (result.ok) assert.throws(() => deriveLegacyFacts(initialLegacyFacts(original), result, command, "synthetic-invalid-input", "synthetic-invalid-version"));
  }
  const negativeQuantity = plan({ isFullPayout: "1" }, { ...command, quantities: qty("1.00", "-1.00") }); assert.equal(negativeQuantity.ok, false);
  const zero = plan({ isFullPayout: "1", goodsMoney: "0.00" }, { ...command, quantities: qty("0.00") }); assert(zero.ok);
  assert.equal(legacyPlanYuanToCents(zero.amounts.fullPayoutMoney!), "0"); assert.equal(legacyPlanYuanToCents(zero.amounts.ownerNet!), "0");
  const maximum = plan({ isFullPayout: "1", payMoney: "2000000000.00", paidPay: [{ id: "9", payOrderSn: "P7", payMoney: "2000000000.00" }], accountPrices: { ...prices("8.00"), barrett: "1249999989.93" }, orderPrices: { ...prices("8.00"), barrett: "1249999989.93" } }, command); assert(maximum.ok);
  assert.equal(legacyPlanYuanToCents(maximum.amounts.fullPayoutMoney!), "9999999999"); assert.equal(legacyPlanYuanToCents(maximum.amounts.ownerNet!), "114999999994");
});
