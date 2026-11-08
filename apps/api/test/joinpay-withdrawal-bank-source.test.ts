import assert from "node:assert/strict";
import { test } from "node:test";
import { withTransaction } from "../src/auth/security-core";
import { describePayoutProfile, readWithdrawalAdmission } from "../src/finance/joinpay-payout-profile";
import { matchesLegacyBankSource, prepareLegacyBankBinding, saveWithdrawalBankBinding } from "../src/finance/withdrawal-bank-binding";
import { createBankBoundWithdrawalOptions, JOINPAY_BANK_PASSTHROUGH_IMPLEMENTATION,readUnavailableWithdrawalContext } from "../src/finance/joinpay-withdrawal-bank-source";
import { actor, input, fixture } from "./fixtures/withdrawal-bank-binding-model";

// SYNTHETIC_SOURCE_COMPONENT：资格行和profile是内存假设，绝非真实KYC/银行验证/出款证据。
import { configuration, verified, bound } from "./fixtures/joinpay-withdrawal-bank-source-model";
import { quoteNativeWithdrawalInTransaction, reserveNativeWithdrawalInTransaction, readNativeWithdrawalRecovery } from "../src/finance/native-withdrawal-store";
import * as wallet from "../src/finance/personal-finance-read";
import * as recovery from "../src/finance/distribution-recovery-gate";
import { localWithdrawalDayWindow, ownerLocalWithdrawalPolicy, quoteControlledWithdrawal } from "../src/finance/controlled-withdrawal";

test("without payout assembly, options preserve local masked bank/identity but never invent a policy, quota or authority",async()=>{
 const {f}=await bound(),keys=f.keys(),before=f.state.queries.length;
 const result=await withTransaction(f.pool,c=>readUnavailableWithdrawalContext(c,actor));
 assert.equal(result.bankBinding.binding?.cardMask,"**** **** 0015");assert.equal(result.bankBinding.binding?.ownershipVerification,"NOT_VERIFIED");
 assert.equal(result.identity?.identityStatus,"UNVERIFIED");assert.equal(result.canQuote,false);
 assert.equal(result.policy,null);assert.equal(result.quota,null);assert.ok(result.reasonCodes.includes("WITHDRAWAL_CHANNEL_NOT_CONFIGURED"));
 assert.equal(f.keys(),keys);assert.equal(f.state.queries.slice(before).some(q=>/^(INSERT|UPDATE|DELETE|ALTER)/.test(q.sql)),false);
 const empty=fixture();const none=await withTransaction(empty.pool,c=>readUnavailableWithdrawalContext(c,actor));
 assert.equal(none.bankBinding.binding,null);assert.equal(none.bankBinding.expectedRevision,"0");assert.ok(none.reasonCodes.includes("BANK_BINDING_REQUIRED"));
 empty.state.integrated=false;const missing=await withTransaction(empty.pool,c=>readUnavailableWithdrawalContext(c,actor));
 assert.equal(missing.bankBinding.integration,"NOT_INTEGRATED");assert.equal(missing.bankBinding.expectedRevision,null);
 assert.equal(missing.canQuote,false);assert.ok(missing.reasonCodes.includes("BANK_BINDING_NOT_INTEGRATED"));
 empty.state.authenticated=false;await assert.rejects(withTransaction(empty.pool,c=>readUnavailableWithdrawalContext(c,actor)));
});
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
test("旧卡保留旧来源：不要求重绑，不伪装新声明，仍受实名、账户与显式渠道配置约束", async () => {
  const f = fixture(), id = "bank_" + "a".repeat(32);
  const source = { legacyUserId: "1", userSourceDigest: "1".repeat(64), sourceReceiptSha256: "2".repeat(64), sourceDumpSha256: "3".repeat(64),
    sourceCutoff: "2026-10-26T00:00:00.000Z", sourceCreateTime: "1760000000", sourceUpdateTime: "1760000001" };
  const prepared = prepareLegacyBankBinding(input, source, f.options, actor.userId, id);
  f.data().banks.set(actor.userId, { id, user_id: actor.userId, revision: "1", sealed_details: prepared.sealedDetails,
    card_mask: prepared.cardMask, holder_mask: prepared.holderMask, updated_at: "2026-10-25T01:00:00.000000Z" });
  f.data().audits.push(["audit_unit", "admin", "unit_boss", "unit_session", "withdrawal.bank_binding.legacy_imported",
    "withdrawal_bank_binding", id, "SUCCESS", "unit_import", null, JSON.stringify(prepared.proof)]);
  assert(!JSON.stringify(prepared.proof).includes(input.name)); assert(!JSON.stringify(prepared.proof).includes(input.cardNo));
  assert.equal(await withTransaction(f.pool, c => matchesLegacyBankSource(c, actor.userId, source, input, f.options)), true);
  assert.equal(await withTransaction(f.pool, c => matchesLegacyBankSource(c, actor.userId, source, { ...input, cardNo: "0000000000000023" }, f.options)), false);
  const defaultMode = createBankBoundWithdrawalOptions(configuration(f)); verified(f);
  await assert.rejects(withTransaction(f.pool, async c => defaultMode.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })), /LEGACY_BANK_SOURCE_NOT_ADMITTED/);
  assert((await withTransaction(f.pool, c => defaultMode.readContext!(c, actor)) as any).reasonCodes.includes("LEGACY_BANK_SOURCE_NOT_ADMITTED"));
  const enabled = createBankBoundWithdrawalOptions({ ...configuration(f), destinationAuthorization: "AUTHENTICATED_USER_OR_LEGACY_BINDING" });
  const admission = readWithdrawalAdmission(await withTransaction(f.pool, async c => enabled.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })));
  assert.match(admission.target.bankOwnershipReference, /^LEGACY_PLATFORM_BANK_BINDING:/); assert.match(admission.target.bankOwnershipSha256, /^[a-f0-9]{64}$/);
  f.state.identityRow.provider = "legacy_mysql_restore";
  await assert.rejects(withTransaction(f.pool, async c => enabled.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })), /REAL_IDENTITY_SOURCE_REQUIRED/);
  verified(f); f.state.authenticated = false;
  await assert.rejects(withTransaction(f.pool, async c => enabled.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })));
});
test("旧卡来源证明与密文/版本/身份及版本化密钥共同绑定，来源篡改不得准入", async () => {
  const f = fixture(), id = "bank_" + "b".repeat(32), source = { legacyUserId: "2", userSourceDigest: "1".repeat(64), sourceReceiptSha256: "2".repeat(64),
    sourceDumpSha256: "3".repeat(64), sourceCutoff: "2026-10-26T00:00:00.000Z", sourceCreateTime: "1760000000", sourceUpdateTime: "1760000001" };
  const p = prepareLegacyBankBinding(input, source, f.options, actor.userId, id);
  f.data().banks.set(actor.userId, { id, user_id: actor.userId, revision: "1", sealed_details: p.sealedDetails, card_mask: p.cardMask,
    holder_mask: p.holderMask, updated_at: "2026-10-25T01:00:00.000000Z" });
  const audit: unknown[] = ["audit_unit", "admin", "unit_boss", "unit_session", "withdrawal.bank_binding.legacy_imported", "withdrawal_bank_binding", id, "SUCCESS", "unit_import", null, JSON.stringify(p.proof)];
  f.data().audits.push(audit); verified(f);
  const enabled = createBankBoundWithdrawalOptions({ ...configuration(f), destinationAuthorization: "AUTHENTICATED_USER_OR_LEGACY_BINDING" });
  audit[10] = JSON.stringify({ ...p.proof, sourceDumpSha256: "4".repeat(64) });
  await assert.rejects(withTransaction(f.pool, async c => enabled.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })), /LEGACY_BANK_SOURCE_PROOF_MISMATCH/);
  audit[10] = JSON.stringify(p.proof);
  audit[1] = "user";
  await assert.rejects(withTransaction(f.pool, async c => enabled.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })), /BANK_BINDING_SOURCE_UNAVAILABLE/);
  audit[1] = "admin"; f.data().audits.push([...audit]);
  await assert.rejects(withTransaction(f.pool, async c => enabled.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })), /BANK_BINDING_SOURCE_UNAVAILABLE/);
  f.data().audits.pop(); f.data().audits.pop();
  await assert.rejects(withTransaction(f.pool, async c => enabled.loadAdmission!(c, actor.userId, { destinationId: id, policyVersion: "unit_policy" })), /BANK_BINDING_SOURCE_UNAVAILABLE/);
  f.data().audits.push(audit);
  const wrong = { ...f.options, protection: { currentKeyVersion: "unit_storage_key", keyFor: () => Buffer.alloc(32, 18) } };
  await assert.rejects(withTransaction(f.pool, c => matchesLegacyBankSource(c, actor.userId, source, input, wrong)));
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
  const formal=readWithdrawalAdmission(await withTransaction(f.pool,async c=>o.loadAdmission!(c,actor.userId,{destinationId:id,policyVersion:"unit_policy"}))).policy;
  const local=ownerLocalWithdrawalPolicy("BANK_CARD",[actor.userId]);
  assert.deepEqual([formal.minCents,formal.maxCents,formal.fee,formal.frequencyBasis,formal.maxIntents],
    [local.minCents,local.maxCents,local.fee,local.frequencyBasis,local.maxAcceptedPerWindow]);
  const at="2026-10-25T00:00:00.000Z",simulated=quoteControlledWithdrawal({amountCents:body.amountCents,destinationId:id,policyVersion:local.version,expectedWalletVersion:"8"},local,
    {userId:actor.userId,active:true,localAdmissionEligible:true,coverageKnown:true,availableCents:"50000",ledgerRevision:"8",now:at,
      destination:{id,userId:actor.userId,mode:"LOCAL_CONTROLLED",kind:"BANK_CARD",active:true},usage:{...localWithdrawalDayWindow(at),quotaCount:0}});
  assert.deepEqual([simulated.grossCents,simulated.netCents,simulated.feeCents],[first.grossCents,first.netCents,first.feeCents]);
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

test("上下文按PG业务日界返回身份与剩余次数；配额耗尽/未知时不得声称可报价", async () => {
  const { f } = await bound(); verified(f); const o = createBankBoundWithdrawalOptions(configuration(f));
  f.state.quotaUsed = "1";
  const context: any = await withTransaction(f.pool, c => o.readContext!(c, actor));
  assert.equal(context.canQuote, true);
  assert.deepEqual(context.quota, { used: "1", maxIntents: 2, remaining: 1,
    windowStart: "2026-10-24T16:00:00.000Z", windowEnd: "2026-10-25T16:00:00.000Z" });
  assert.deepEqual(context.identity, { identityStatus: "VERIFIED", ageStatus: "ADULT", verifiedAt: "2026-10-25T00:00:00.000Z" });
  assert(!JSON.stringify(context).includes(f.state.identityRow.providerReference));
  f.state.quotaUsed = "2";
  const exhausted: any = await withTransaction(f.pool, c => o.readContext!(c, actor));
  assert.equal(exhausted.canQuote, false); assert(exhausted.reasonCodes.includes("WITHDRAWAL_QUOTA_EXHAUSTED")); assert.equal(exhausted.quota.remaining, 0);
  f.state.quotaUsed = "invalid";
  const unknown: any = await withTransaction(f.pool, c => o.readContext!(c, actor));
  assert.equal(unknown.canQuote, false); assert(unknown.reasonCodes.includes("WITHDRAWAL_QUOTA_UNKNOWN")); assert.equal(unknown.quota, null);
});
