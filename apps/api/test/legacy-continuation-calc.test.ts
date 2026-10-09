import { test } from "node:test";
import { strict as assert } from "node:assert";
import { admitLegacyEvidence, planLegacyContinuation, LEGACY_REJECT_ASSIGNMENTS, type LegacyContinuationSource, type LegacyPrices, type LegacyQuantities } from "../src/order/legacy-continuation-calc";

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
  const patch = { goodsMoney: "20.00", accountPrices: { ...prices("8.00"), barrett: "20.00" }, orderPrices: { ...prices("8.00"), barrett: "1.00" } };
  const preview = plan(patch, { kind: "preview", caller: owner, quantities });
  const propose = plan(patch, { kind: "propose", caller: owner, quantities });
  if (!preview.ok || !propose.ok) assert.fail("price paths should calculate");
  assert.equal(preview.nextStatus, null);
  assert.equal(preview.isAdvanceSet, 1);
  assert.equal(preview.amounts.saleEarnings, "10.20");
  assert.equal(propose.nextStatus, "9");
  assert.equal(propose.isAdvanceSet, 0);
  assert.deepEqual([propose.amounts.saleEarnings, propose.amounts.returnOrderMoney], ["30.00", "86.00"]);
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
