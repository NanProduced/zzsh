import assert from "node:assert/strict";
import { test } from "node:test";
import { withTransaction } from "../src/auth/security-core";
import { describePayoutProfile, readWithdrawalAdmission } from "../src/finance/joinpay-payout-profile";
import { saveWithdrawalBankBinding } from "../src/finance/withdrawal-bank-binding";
import { createBankBoundWithdrawalOptions, JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION } from "../src/finance/joinpay-withdrawal-bank-source";
import { actor, input, fixture } from "./fixtures/withdrawal-bank-binding-model";

// SYNTHETIC_SOURCE_COMPONENT：资格行和profile是内存假设，绝非真实KYC/银行验证/出款证据。
import { configuration, verified, bound } from "./fixtures/joinpay-withdrawal-bank-source-model";
import { quoteNativeWithdrawalInTransaction, reserveNativeWithdrawalInTransaction, readNativeWithdrawalRecovery } from "../src/finance/native-withdrawal-store";
import * as wallet from "../src/finance/personal-finance-read";
import * as recovery from "../src/finance/distribution-recovery-gate";
test("fake/未核身份不解密银行资料、不生成出款资格；上下文保留真实未知原因", async () => {
  const { f, id } = await bound(), o = createBankBoundWithdrawalOptions(configuration(f)), keys = f.keys();
  await assert.rejects(withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })), /IDENTITY_NOT_VERIFIED/);
  Object.assign(f.state.identityRow, { identityStatus: "VERIFIED", ageStatus: "ADULT" });
  await assert.rejects(withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })), /REAL_IDENTITY_SOURCE_REQUIRED/);
  const context: any = await withTransaction(f.pool, c => o.readContext!(c, actor));
  assert.equal(context.canQuote, false); assert(context.reasonCodes.includes("REAL_IDENTITY_SOURCE_REQUIRED")); assert.equal(context.bankBinding.binding.ownershipVerification, "NOT_VERIFIED"); assert.equal(f.keys(), keys);
});
test("版本化持久绑卡被逐字段装配；bankOwnership历史字段只记录用户目标声明", async () => {
  const { f, id } = await bound(); verified(f); const o = createBankBoundWithdrawalOptions(configuration(f));
  const a = readWithdrawalAdmission(await withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })));
  assert.equal(a.target.receiverAccountNoEnc, input.cardNo); assert.equal(a.target.receiverNameEnc, input.name); assert.equal(a.target.receiverAccountType, "201");
  assert.equal(a.target.revision, "1"); assert.match(a.target.fingerprint, /^[a-f0-9]{64}$/); assert(a.target.bankOwnershipReference.startsWith("USER_AUTHORIZED_BANK_BINDING:"));
  assert.equal(a.identity.proofReference, "USER_IDENTITY_STATE:" + actor.userId + ":1"); assert.equal(a.identity.validUntil, "2026-10-26T00:00:00.000Z");
  assert.equal(a.policy.quotaStart, "2026-10-24T16:00:00.000Z"); assert.equal(a.policy.quotaEnd, "2026-10-25T16:00:00.000Z");
});
test("改卡只产生新目标版本；原准入快照及原卡不被回写", async () => {
  const { f, id } = await bound(); verified(f); const o = createBankBoundWithdrawalOptions(configuration(f));
  const first = readWithdrawalAdmission(await withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })));
  await saveWithdrawalBankBinding(f.pool, actor, { ...input, cardNo: "0000000000000023", expectedRevision: "1" }, "unit_change", f.options);
  const next = readWithdrawalAdmission(await withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })));
  assert.equal(next.target.revision, "2"); assert.notEqual(next.target.fingerprint, first.target.fingerprint); assert.equal(first.target.receiverAccountNoEnc, input.cardNo); assert.equal(next.target.receiverAccountNoEnc, "0000000000000023");
  assert(f.state.queries.every(q => !/UPDATE zzsh_order.joinpay_withdrawal_intent/.test(q.sql)));
});
test("银行/身份/时限错误不被用户声明绕过", async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.state.identityRow.ageStatus = "MINOR", (f: ReturnType<typeof fixture>) => f.state.identityRow.provider = "legacy_restore",
    (f: ReturnType<typeof fixture>) => f.state.identityRow.provider = "fake_alias", (f: ReturnType<typeof fixture>) => f.state.identityRow.provider = "unreviewed_provider",
    (f: ReturnType<typeof fixture>) => f.state.identityRow.providerReference = "", (f: ReturnType<typeof fixture>) => f.state.identityRow.version = 0,
    (f: ReturnType<typeof fixture>) => f.state.identityRow.verifiedAt = "2026-10-23T00:00:00.000Z", (f: ReturnType<typeof fixture>) => f.state.identityRow.verifiedAt = "2026-10-26T00:00:00.000Z"]) {
    const { f, id } = await bound(); verified(f); mutate(f); const o = createBankBoundWithdrawalOptions(configuration(f)), keys = f.keys();
    await assert.rejects(withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" }))); assert.equal(f.keys(), keys);
  }
});
test("政策/目的地不能由客户端覆盖；不存在目标不泄露其他人银行卡", async () => {
  const { f, id } = await bound(); verified(f); const o = createBankBoundWithdrawalOptions(configuration(f));
  await assert.rejects(withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "other_policy" })));
  await assert.rejects(withTransaction(f.pool, async c => o.loadAdmission!(c, "unit_other", { destinationId: id, policyVersion: "unit_policy" })));
  await assert.rejects(withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: "bank_" + "a".repeat(32), policyVersion: "unit_policy" })));
});
test("上下文只读且无需保护钥；只可报价不代表余额已足或已出款", async () => {
  const { f } = await bound(); verified(f); const o = createBankBoundWithdrawalOptions(configuration(f)), keys = f.keys(), before = f.state.queries.length;
  const context: any = await withTransaction(f.pool, c => o.readContext!(c, actor));
  assert.equal(context.canQuote, true); assert.equal(context.bankOwnershipVerification, "NOT_VERIFIED"); assert.equal(context.bankArrival, "UNKNOWN"); assert.equal(f.keys(), keys);
  const sql = f.state.queries.slice(before).map(q => q.sql); assert(sql.every(s => !/INSERT INTO|UPDATE zzsh_order|sealed_details/.test(s)));
  assert(!JSON.stringify(context).includes(input.cardNo)); assert(!JSON.stringify(context).includes(input.name));
});
test("业务日界由明确时区和PG时钟推导，跨日更换配额窗口/摘要", async () => {
  const { f, id } = await bound(); verified(f); const o = createBankBoundWithdrawalOptions(configuration(f));
  const first = readWithdrawalAdmission(await withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })));
  f.state.identityRow.now = "2026-10-25T16:00:00.000Z";
  const next = readWithdrawalAdmission(await withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })));
  assert.equal(next.policy.quotaStart, first.policy.quotaEnd); assert.notEqual(next.policy.sha256, first.policy.sha256);
});
test("配置验证在读库/钥之前；不能把本地AES密文当JoinPay Enc", () => {
  const f = fixture();
  for (const changes of [{ maxCents: "1" }, { identityMaximumAgeSeconds: 0 }, { quotaUtcOffsetMinutes: 841 }, { version: 123 as any }, { reviewStrategy: "UNKNOWN" as any }])
    assert.throws(() => createBankBoundWithdrawalOptions(configuration(f, changes)));
  const cfg = configuration(f); assert.throws(() => createBankBoundWithdrawalOptions({ ...cfg, targetEncoding: "LOCAL_AES" as any }));
  assert.throws(() => createBankBoundWithdrawalOptions({ ...cfg, destinationAuthorization: "BANK_VERIFIED_BY_INPUT" as any }));
  assert.throws(() => createBankBoundWithdrawalOptions({ ...cfg, identityProvider: "fake_alias" }));
  assert.throws(() => createBankBoundWithdrawalOptions({ ...cfg, bankBinding: { ...f.options, runtimeUser: "other_r" } })); assert.equal(f.keys(), 0);
  assert.equal(describePayoutProfile(cfg.profile).targetRules.encodingImplementationRef, JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION.reference);
});

test("实际原生报价消费新绑定来源；改卡后原报价不能创建提现预留（组件，非PG并发）", async t => {
  const { f, id } = await bound(); verified(f); const o = createBankBoundWithdrawalOptions(configuration(f));
  const coverage = { knowledge: "KNOWN", origin: "NATIVE", cutoff: "2026-10-24T00:00:00.000000Z", sourceDigest: "1".repeat(64), coveredSetDigest: "2".repeat(64), coverageVersion: "1" };
  t.mock.method(wallet, "readPersonalWallet", async () => ({ ledgerRevision: "8", coverage, buckets: { available: { amountCents: "50000" } } }) as never);
  t.mock.method(recovery, "assertNoReferralRecoveryForWithdrawal", async () => {});
  const original = f.client.query.bind(f.client);
  (f.client as any).query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("pg_current_xact_id()")) return { rows: [{ db: f.options.database, actor: f.options.runtimeUser, xid: "100", isolation: "read committed" }] };
    if (sql.includes("G4 payout execution schema inventory") || sql.includes("G4 payout fixed guards")) return { rows: [{ ready: true }] };
    if (sql.includes("FROM zzsh_iam.user_identity_state")) { const r = f.state.identityRow; return { rows: [{ account_status: r.accountStatus, identity_status: r.identityStatus, age_status: r.ageStatus, provider: r.provider, provider_reference: r.providerReference, version: r.version }] }; }
    if (sql.startsWith("SELECT to_char(clock_timestamp()")) return { rows: [{ now: f.state.identityRow.now }] };
    if (sql.includes("SELECT ledger_revision::text AS revision")) return { rows: [{ revision: "8" }] };
    if (sql.includes("wallet_coverage c")) return { rows: [coverage] };
    if (sql.includes("SELECT count(*)::text AS count")) return { rows: [{ count: "0" }] };
    return original(sql, values);
  };
  const body = { amountCents: "10000", destinationId: id, policyVersion: "unit_policy" };
  const first = await withTransaction(f.pool, c => quoteNativeWithdrawalInTransaction(c, actor, body, o)); assert.equal(first.destination.mask, "**** **** 0015");
  await saveWithdrawalBankBinding(f.pool, actor, { ...input, cardNo: "0000000000000023", expectedRevision: "1" }, "unit_new_bank", f.options);
  const next = await withTransaction(f.pool, c => quoteNativeWithdrawalInTransaction(c, actor, body, o)); assert.equal(next.destination.mask, "**** **** 0023");
  assert.notEqual(next.expectedWalletVersion, first.expectedWalletVersion);
  await assert.rejects(withTransaction(f.pool, c => reserveNativeWithdrawalInTransaction(c, actor, { ...body, expectedWalletVersion: first.expectedWalletVersion }, "unit_stale_request", o)), /Withdrawal quote\/wallet\/destination changed/);
  assert(f.state.queries.every(q => !q.sql.startsWith("INSERT INTO zzsh_order.joinpay_withdrawal_intent")));
});

test("原单GET展示冻结的卡掩码；改卡不替换历史目标，旧格式未知不泄露原号", async () => {
  const { f, id } = await bound(); verified(f); const o = createBankBoundWithdrawalOptions(configuration(f));
  const a = readWithdrawalAdmission(await withTransaction(f.pool, async c => o.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })));
  const row: any = { id: "jwd_unit_original", user_id: actor.userId, gross_cents: "10000", net_cents: "9900", fee_cents: "100", currency: "CNY", state: "UNKNOWN", operation_version: "1",
    funds_disposition: "RESERVED", requires_review: false, merchant_order_no: "UNITWITHDRAW20261025", policy_version: "unit_policy", destination_id: id, destination_revision: "1",
    accepted_at: "2026-10-25T02:00:00.000Z", admission_canonical: a.canonical, admission_sha256: a.sha256 };
  await saveWithdrawalBankBinding(f.pool, actor, { ...input, cardNo: "0000000000000023", expectedRevision: "1" }, "unit_later_bank", f.options);
  const original = f.client.query.bind(f.client);
  (f.client as any).query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes("pg_current_xact_id()")) return { rows: [{ db: f.options.database, actor: f.options.runtimeUser, xid: "100", isolation: "read committed" }] };
    if (sql.includes("FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1 AND user_id=$2")) return { rows: [row] };
    return original(sql, values);
  };
  const r: any = await withTransaction(f.pool, c => readNativeWithdrawalRecovery(c, actor, o.scope, { intentId: row.id }));
  assert.equal(r.intent.originalDestination.cardMask, "**** **** 0015"); assert.equal(f.data().banks.get(actor.userId)!.card_mask, "**** **** 0023");
  assert(!JSON.stringify(r).includes(input.cardNo)); assert(!JSON.stringify(r).includes(input.name));
  row.admission_sha256 = "f".repeat(64);
  const unknown: any = await withTransaction(f.pool, c => readNativeWithdrawalRecovery(c, actor, o.scope, { intentId: row.id })); assert.equal(unknown.intent.originalDestination.cardMask, null);
});
