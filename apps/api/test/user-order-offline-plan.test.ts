import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { canonicalize } from "../src/supply/content-hash";
import { legacyOwnerUserId } from "../src/supply/legacy-user-migration";
import { legacyAccountId } from "../src/legacy-load/legacy-account-seam";
import { binaryFlag, planBatchDigest, planLegacyOrder, planLegacyUser, planLegacyUserBatch, planSourceChain, projectIdentityStatus, publicSourceChain, publicUserPlan } from "../src/legacy-load/user-order-offline-plan";
import type { LegacyOrderReadInput } from "../src/order/legacy-order-read";

const digest = "a".repeat(64);
const frozen = "b".repeat(64);
const user = (overrides: Record<string, unknown> = {}) => ({
  id: "7", mobile: "13800138000", nickname: "owner", is_delete: 0, is_disable: 0, is_bind_id: 1, is_high_risk: 0, ageAdult: true as boolean | null,
  sourceDigest: digest, evidenceRef: "frozen", ...overrides,
});

test("deleted wins, non-binary flags isolate, and inherited verification is not a new channel check", () => {
  assert.equal(projectIdentityStatus({ deleted: true, disabled: true, realNameBound: true, ageAdult: true }).accountStatus, "CANCELLED");
  assert.equal(projectIdentityStatus({ deleted: false, disabled: true, realNameBound: false, ageAdult: null }).accountStatus, "DEACTIVATED");
  assert.equal(projectIdentityStatus({ deleted: false, disabled: false, realNameBound: true, ageAdult: false }).identityStatus, "VERIFIED");
  assert.equal(projectIdentityStatus({ deleted: false, disabled: false, realNameBound: true, ageAdult: false }).ageStatus, "MINOR");
  assert.equal(projectIdentityStatus({ deleted: false, disabled: false, realNameBound: false, ageAdult: null }).ageStatus, "UNKNOWN");
  assert.equal(projectIdentityStatus({ deleted: false, disabled: false, realNameBound: true, ageAdult: true }).phoneNumberVerified, false);
  assert.equal(projectIdentityStatus({ deleted: false, disabled: false, realNameBound: true, ageAdult: true }).loginProven, false);
  assert.throws(() => binaryFlag(null, "is_disable"), /FLAG_NOT_BINARY:is_disable/);
  assert.throws(() => binaryFlag(2, "is_delete"), /FLAG_NOT_BINARY:is_delete/);
  assert.equal(planLegacyUser(user({ is_delete: null }), new Set()).disposition, "ISOLATED");
  const disabled = planLegacyUser(user({ is_disable: 1, is_bind_id: 0, ageAdult: null, is_high_risk: 1, createTime: "0", updateTime: 1 }), new Set());
  assert.equal(disabled.disposition, "PARAMETER_READY");
  assert.equal(disabled.writeAllowed, false);
  if (disabled.disposition === "PARAMETER_READY") {
    assert.equal(disabled.projected.accountStatus, "DEACTIVATED");
    assert.equal(disabled.projected.identityStatus, "UNVERIFIED");
    assert.equal(disabled.writerInput.evidence.sourceCreatedAt, null);
    assert.equal(disabled.writerInput.evidence.sourceUpdatedAt, "1970-01-01T00:00:01.000Z");
    assert.equal(disabled.legacyPasswordPresent, false);
    assert.equal(disabled.passwordInvented, false);
    assert.ok(disabled.blockers.includes("HIGH_RISK_RETAINED"));
    assert.ok(disabled.blockers.includes("TRADING_ADMISSION_NOT_DECIDED"));
    assert.equal(disabled.writes, 0);
    assert.equal(publicUserPlan(disabled).evidenceDigest, disabled.writerInput.evidenceDigest);
    assert.equal(JSON.stringify(publicUserPlan(disabled)).includes("13800138000"), false);
  }
  assert.equal(planLegacyUser(user({ createTime: "" }), new Set()).disposition, "ISOLATED");
  assert.equal(planLegacyUser(user({ updateTime: "1.5" }), new Set()).disposition, "ISOLATED");
  const duplicate = planLegacyUser(user({ id: "8", mobile: "+8613800138000" }), new Set(["13800138000"]));
  assert.equal(duplicate.disposition, "ISOLATED");
  if (duplicate.disposition === "ISOLATED") assert.equal(duplicate.reason, "MOBILE_DUPLICATE");
  assert.equal(planLegacyUser(user({ id: "9", mobile: "+86 138-0013-8000" }), new Set(["13800138000"])).disposition, "ISOLATED");
  assert.equal(planLegacyUser(user({ mobile: "12345" }), new Set()).disposition, "ISOLATED");
  const laterFirst = planLegacyUserBatch([user({ id: "20", mobile: "+8613800138000" }), user({ id: "3", mobile: "13800138000" })]);
  const earlierFirst = planLegacyUserBatch([user({ id: "3", mobile: "13800138000" }), user({ id: "20", mobile: "+8613800138000" })]);
  assert.equal(laterFirst.results.find(item => item.disposition === "PARAMETER_READY")?.userId, earlierFirst.results.find(item => item.disposition === "PARAMETER_READY")?.userId);
  assert.equal(laterFirst.isolated, 1);
  assert.equal(earlierFirst.isolated, 1);
  const invalid = planLegacyUserBatch([user({ id: "4", mobile: "12345" }), user({ id: "5" })]);
  assert.equal(invalid.results.some(item => item.disposition === "PARAMETER_READY"), true);
  const committed = new Set<string>(["13800138000"]);
  const replayRows = [user({ id: "11", mobile: "13900139000" })];
  const firstPlan = planLegacyUserBatch(replayRows, committed);
  const secondPlan = planLegacyUserBatch(replayRows, committed);
  assert.deepEqual(firstPlan, secondPlan);
  assert.equal(firstPlan.parameterReady, 1);
  assert.equal(firstPlan.writes, 0);
  assert.equal(committed.size, 1);
  assert.equal(committed.has("13900139000"), false);
  const intra = planLegacyUserBatch([user({ id: "31", mobile: "+86 139-0013-9000" }), user({ id: "30", mobile: "13900139000" })], committed);
  assert.equal(intra.parameterReady, 1);
  assert.equal(intra.isolated, 1);
  assert.equal(intra.results.find(item => item.disposition === "PARAMETER_READY")?.userId, legacyOwnerUserId("legacy_mysql_restore", "la_user", "30"));
  assert.equal(committed.size, 1);
});

function orderInput(orderStatus: string): LegacyOrderReadInput {
  const row = { id: "1", order_sn: "legacy-1", accounts_id: "10", user_id: "20", sale_user_id: "30", order_status: orderStatus, pay_is: "1", need_pay_money: "66.00", pay_money: "66.00", deposit_amount: "0.00", return_order_money: "0.00", pay_time: "0", create_time: "1", cancel_time: "0", confirm_time: "0" };
  return {
    source: { legacyId: "1", digest: createHash("sha256").update(canonicalize(row), "utf8").digest("hex"), evidenceRef: "frozen", row },
    account: { accountId: "account-10", gameId: "game-1", legacyId: "10", businessNo: "A-10", sourceDigest: digest },
    owner: { userId: legacyOwnerUserId("legacy_mysql_restore", "la_user", "30"), legacyId: "30", businessNo: "U-30", sourceDigest: digest },
    renter: { userId: legacyOwnerUserId("legacy_mysql_restore", "la_user", "20"), legacyId: "20", businessNo: "U-20", sourceDigest: digest },
  };
}

test("order read stays plan-only and missing bindings do not create a snapshot", () => {
  const input = orderInput("5");
  const matched = { ownerUserId: input.owner.userId, renterUserId: input.renter.userId, accountId: "account-10", gameId: "game-1" };
  const ready = planLegacyOrder(input, matched);
  assert.equal(ready.disposition, "PARAMETER_READY");
  assert.equal(ready.writeAllowed, false);
  if (ready.disposition === "PARAMETER_READY") {
    assert.equal(ready.originalOrderNo, "legacy-1");
    assert.equal(ready.dueCents, "6600");
    assert.equal(ready.paidCents, "6600");
    assert.equal(ready.sourceStatus, "5");
    assert.equal(ready.inflightReadOnly, false);
    assert.equal(ready.cancelledWithPaymentRecord, true);
    assert.equal(ready.refundChannelState, "UNKNOWN");
    assert.equal(ready.continuationEligible, false);
    assert.equal(ready.existence, "NOT_CHECKED");
    assert.equal(ready.writes, 0);
    assert.deepEqual(Object.keys(ready.dependencyDigests).sort(), ["account", "owner", "renter"]);
  }
  const waiting = planLegacyOrder(null, { ownerUserId: input.owner.userId });
  assert.equal(waiting.disposition, "PENDING_DEPENDENCY");
  if (waiting.disposition === "PENDING_DEPENDENCY") assert.equal(waiting.snapshot, false);
  const changed = structuredClone(input);
  changed.source.row.pay_money = "1.00";
  assert.equal(planLegacyOrder(changed, matched).disposition, "ISOLATED");
  const conflict = planLegacyOrder(input, { ownerUserId: "wrong-owner", renterUserId: "wrong-renter", accountId: "wrong-account", gameId: "wrong-game" });
  assert.equal(conflict.disposition, "ISOLATED");
  if (conflict.disposition === "ISOLATED") assert.equal(conflict.snapshot, false);
  const inflight = planLegacyOrder(orderInput("8"), matched);
  if (inflight.disposition === "PARAMETER_READY") {
    assert.equal(inflight.sourceStatus, "8");
    assert.equal(inflight.inflightReadOnly, true);
    assert.equal(inflight.continuationEligible, false);
  }
  assert.equal(planBatchDigest(frozen, [["la_order:1", input.source.digest]]), planBatchDigest(frozen, [["la_order:1", input.source.digest]]));
});

const party = (legacyId: string, mobile: string) => ({
  sourceSystem: "legacy_mysql_restore" as const, sourceEntity: "la_user" as const, legacyId, sourceDigest: digest, evidenceRef: "frozen",
  nickname: "secret-nick", mobile, sourceCreatedAt: null, sourceUpdatedAt: null,
  status: { realNameBound: false, ageAdult: null, disabled: false, deleted: false }, legacyPassword: null,
});
const accountRow = (overrides: Record<string, string> = {}) => ({
  id: "10", user_id: "30", game_id: "1", status: "3", is_delete: "0", no: "ACCTNO", price_tenant: "1.00", extra_goods_total_price_tenant: "2.00", deposit_amount: "3.00", rental_days: "1", default_consume_type: "1", update_time: "1", ...overrides,
});
function chainOrder(row = accountRow()) {
  const sourceRow = { id: "1", order_sn: "legacy-1", accounts_id: row.id, user_id: "20", sale_user_id: row.user_id, order_status: "5", pay_is: "1", need_pay_money: "1.00", pay_money: "1.00", deposit_amount: "0.00", return_order_money: "0.00", pay_time: "0", create_time: "1", cancel_time: "0", confirm_time: "0" };
  return {
    source: { legacyId: "1", digest: createHash("sha256").update(canonicalize(sourceRow), "utf8").digest("hex"), evidenceRef: "frozen", row: sourceRow },
    account: { legacyId: row.id, businessNo: "A-10", sourceDigest: digest },
    owner: { userId: legacyOwnerUserId("legacy_mysql_restore", "la_user", row.user_id), legacyId: row.user_id, businessNo: "U-30", sourceDigest: digest },
    renter: { userId: legacyOwnerUserId("legacy_mysql_restore", "la_user", "20"), legacyId: "20", businessNo: "U-20", sourceDigest: digest },
  };
}
const chainInput = () => ({ owner: party("30", "13700137000"), renter: party("20", "13900139000"), account: { sourceDigest: digest, evidenceRef: "account-frozen", row: accountRow() }, game: { sourceGameId: "1", targetGameId: "game-delta", serviceCode: "ACCOUNT_RENTAL" as const }, order: chainOrder() });

test("account dependency plan stays offline and rejects a mismatched relation", () => {
  const input = chainInput();
  const frozenInput = structuredClone(input);
  const first = planSourceChain(input);
  const second = planSourceChain(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, frozenInput);
  assert.equal(first.writeAllowed, false);
  assert.equal(first.existence, "NOT_CHECKED");
  assert.equal(first.actor, "UNBOUND");
  assert.equal(first.ids.accountId, legacyAccountId("legacy_mysql_restore", "la_rental_accounts", "10"));
  assert.equal(first.ids.ownerUserId, legacyOwnerUserId("legacy_mysql_restore", "la_user", "30"));
  assert.equal(first.ids.serviceCode, "ACCOUNT_RENTAL");
  assert.equal(first.branches.targetExistsUnverified.selected, true);
  assert.equal(first.branches.targetExistsUnverified.match, "NOT_CHECKED");
  assert.equal(first.branches.targetCreateRequired.selected, false);
  assert.equal(first.branches.targetExistsUnverified.ifAbsent["zzsh_iam.audit_event"], 4);
  const account = first.steps.find(item => item.step === "account");
  const observation = first.steps.find(item => item.step === "observation");
  const snapshot = first.steps.find(item => item.step === "readSnapshot");
  const order = first.steps.find(item => item.step === "order");
  assert.equal(account?.disposition, "PARAMETER_READY");
  assert.equal(observation?.disposition, "PARAMETER_READY");
  assert.equal(snapshot?.reason, "OBSERVATION_VERSION_ASSIGNED_AT_WRITE");
  assert.equal(snapshot?.snapshotReady, true);
  assert.equal(order?.disposition, "PARAMETER_READY");
  assert.equal(JSON.stringify(publicSourceChain(first)).includes("secret-nick"), false);
  assert.equal(JSON.stringify(publicSourceChain(first)).includes("13700137000"), false);
  assert.equal(JSON.stringify(publicSourceChain(first)).includes("ACCTNO"), false);
  const unbound = planSourceChain({ ...input, game: { ...input.game, targetGameId: null } });
  assert.equal(unbound.branches.targetCreateRequired.selected, true);
  assert.equal(unbound.branches.targetCreateRequired.accountPlan, "NOT_EMITTED");
  assert.equal(unbound.steps.find(item => item.step === "account")?.disposition, "PENDING_DEPENDENCY");
  const sameSource = planSourceChain({ ...input, game: { ...input.game, targetGameId: "1" } });
  assert.equal(sameSource.existence, "NOT_CHECKED");
  assert.equal(sameSource.branches.targetExistsUnverified.match, "NOT_CHECKED");
  const mismatched = planSourceChain({ ...input, account: { ...input.account, row: accountRow({ user_id: "99" }) } });
  assert.equal(mismatched.steps.find(item => item.step === "account")?.reason, "ACCOUNT_OWNER_MISMATCH");
  assert.equal(mismatched.steps.find(item => item.step === "order")?.parameterReady, false);
  const wrongGame = planSourceChain({ ...input, account: { ...input.account, row: accountRow({ game_id: "2" }) } });
  assert.equal(wrongGame.steps.find(item => item.step === "account")?.reason, "ACCOUNT_GAME_MISMATCH");
  const wrongTarget = planSourceChain({ ...input, order: { ...input.order, account: { ...input.order.account, accountId: "10" } } });
  assert.equal(wrongTarget.steps.find(item => item.step === "order")?.reason, "ORDER_TARGET_MISMATCH");
  const hidden = planSourceChain({ ...input, account: { ...input.account, row: accountRow({ status: "4" }) } });
  const hiddenSnapshot = hidden.steps.find(item => item.step === "readSnapshot");
  assert.equal(hidden.steps.find(item => item.step === "account")?.disposition, "PARAMETER_READY");
  assert.equal(hiddenSnapshot?.snapshotReady, true);
  assert.equal(hiddenSnapshot?.sourceStatusPublicCandidate, false);
  assert.equal(hiddenSnapshot?.sourceStatus, 4);
  const illegal = planSourceChain({ ...input, account: { ...input.account, row: accountRow({ status: "6" }) } });
  assert.equal(illegal.steps.find(item => item.step === "account")?.reason, "ACCOUNT_STATUS_NOT_PUBLIC");
});

test("an unextracted is_high_risk is not read as 0 but still keeps the smallest-id phone winner", () => {
  const noRisk = (overrides: Record<string, unknown> = {}) => { const row: Record<string, unknown> = user(overrides); delete row.is_high_risk; return row as unknown as Parameters<typeof planLegacyUser>[0]; };
  const single = planLegacyUser(noRisk(), new Set());
  assert.equal(single.parameterReady, false);
  assert.equal("reason" in single ? single.reason : null, "FIELD_NOT_EXTRACTED:is_high_risk");
  assert.equal("writerInput" in single, false);
  assert.throws(() => binaryFlag(undefined, "is_high_risk"), /FLAG_NOT_BINARY:is_high_risk/);
  assert.equal(planLegacyUser(user({ is_high_risk: null }), new Set()).disposition, "ISOLATED");
  const batch = planLegacyUserBatch([noRisk({ id: "40", mobile: "13700137000" }), user({ id: "41", mobile: "+86 137-0013-7000" })]);
  assert.equal(batch.parameterReady, 0);
  assert.deepEqual(batch.results.map(item => "reason" in item ? item.reason : null), ["FIELD_NOT_EXTRACTED:is_high_risk", "MOBILE_DUPLICATE"]);
  const committed = new Set<string>();
  const pageOne = planLegacyUserBatch([noRisk({ id: "40", mobile: "13700137000" })], committed);
  assert.equal(committed.size, 0);
  const carried = new Set<string>(pageOne.results.flatMap(item => "claimedMobile" in item && typeof item.claimedMobile === "string" ? [item.claimedMobile] : []));
  const pageTwo = planLegacyUserBatch([user({ id: "41", mobile: "13700137000" })], carried);
  assert.equal(pageTwo.parameterReady, 0);
  assert.equal(carried.size, 1);
});