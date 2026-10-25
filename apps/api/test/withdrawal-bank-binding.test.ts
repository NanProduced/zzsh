import assert from "node:assert/strict";
import { test } from "node:test";
import { withTransaction } from "../src/auth/security-core";
import { BankBindingCommitUnknown, readWithdrawalBankBinding, readWithdrawalBankBindingPrivate, recoverWithdrawalBankBinding,
  saveWithdrawalBankBinding } from "../src/finance/withdrawal-bank-binding";
import { actor, input, fixture } from "./fixtures/withdrawal-bank-binding-model";

// SYNTHETIC_COMPONENT_ONLY：使用真实标准库加密及内存事务，不是PG/银行/汇聚实测。
const save = (f: ReturnType<typeof fixture>, body: Record<string, unknown> = input, key = "unit_first") => saveWithdrawalBankBinding(f.pool, actor, body, key, f.options);
test("首次保存、脱敏读取与内部解密；绑定成功始终不是银行卡归属验证", async () => {
  const f = fixture(), r = await save(f), b = r.body.binding!; assert.equal(b.revision, "1"); assert.equal(b.cardMask, "**** **** 0015"); assert.equal(b.holderNameMask, "虚**");
  assert.equal(b.ownershipVerification, "NOT_VERIFIED"); assert.equal(f.data().audits.length, 1); assert.equal(f.data().receipts.size, 1);
  const serialized = JSON.stringify([r, f.data().audits, [...f.data().receipts.values()]]);
  for (const secret of [input.cardNo, input.name, "sealed_details", "encrypted", f.originalKey.toString("base64url")]) assert(!serialized.includes(secret));
  const stored = f.data().banks.get(actor.userId)!; assert(!stored.sealed_details.includes(input.cardNo)); assert(!stored.sealed_details.includes(input.name));
  const keys = f.keys(), get = await withTransaction(f.pool, c => readWithdrawalBankBinding(c, actor, { database: f.options.database, runtimeUser: f.options.runtimeUser }));
  assert.equal(f.keys(), keys); assert.deepEqual(get, r.body);
  const raw = await withTransaction(f.pool, c => readWithdrawalBankBindingPrivate(c, actor, b.id, "1", f.options));
  assert.equal(raw.cardNo, input.cardNo); assert.equal(raw.name, input.name); assert(f.originalKey.every(v => v === 17));
});
test("修改绑定沿同一逻辑ID递增版本，旧回执保持原版本且无需再读钥", async () => {
  const f = fixture(), first = await save(f), id = first.body.binding!.id;
  const changed = await save(f, { ...input, name: "另一虚构用户", cardNo: "0000000000000023", expectedRevision: "1" }, "unit_second");
  assert.equal(changed.body.binding!.id, id); assert.equal(changed.body.binding!.revision, "2"); assert.equal(changed.body.binding!.cardMask, "**** **** 0023");
  const keys = f.keys(), readOnly = { database: f.options.database, runtimeUser: f.options.runtimeUser };
  const replay = await saveWithdrawalBankBinding(f.pool, actor, input, "unit_first", readOnly); assert.equal(replay.replayed, true); assert.deepEqual(replay.body, first.body);
  const recovered = await withTransaction(f.pool, c => recoverWithdrawalBankBinding(c, actor, "unit_first", readOnly));
  assert.equal(recovered.knowledge, "KNOWN"); assert.deepEqual(recovered.receipt, first.body); assert.equal(f.keys(), keys);
  assert(f.state.queries.every(q => !q.sql.includes("joinpay_withdrawal_intent")));
});
test("同key异体、旧版本和CAS丢失均拒绝，不覆盖新银行卡", async () => {
  const f = fixture(); await save(f);
  await assert.rejects(save(f, { ...input, cardNo: "0000000000000023" }), /Idempotency key was reused/);
  await assert.rejects(save(f, input, "unit_stale"), /Bank binding changed/);
  f.state.casFailure = true; await assert.rejects(save(f, { ...input, expectedRevision: "1" }, "unit_cas"), /Bank binding write changed/);
  assert.equal(f.data().banks.get(actor.userId)!.revision, "1"); assert.equal(f.data().audits.length, 1); assert.equal(f.data().receipts.size, 1);
});
test("格式/越权字段/非法key在保护钥读取之前拒绝；不增加额外认证表单", async () => {
  for (const body of [{ ...input, userId: "other" }, { ...input, verified: true }, { ...input, name: "" }, { ...input, name: "x\n" },
    { ...input, name: "\ud800" }, { ...input, name: "名".repeat(43) }, { ...input, cardNo: "12345678901234" },
    { ...input, cardNo: "１".repeat(16) }, { ...input, cardNo: "0000000000000015\t" }, { ...input, expectedRevision: "01" },
    { ...input, expectedRevision: "9223372036854775808" }]) {
    const f = fixture(); await assert.rejects(save(f, body)); assert.equal(f.keys(), 0); assert.equal(f.data().banks.size, 0);
  }
  for (const key of [undefined, "", "bad key"]) {
    const f = fixture(); await assert.rejects(saveWithdrawalBankBinding(f.pool, actor, input, key, f.options)); assert.equal(f.keys(), 0);
  }
  const f = fixture(); assert.equal((await save(f, { ...input, name: "  Example Name  ", cardNo: "0000 0000 0000 0015" })).body.binding!.holderNameMask, "E**");
});
test("资源/schema/登录失败不保存、不读钥；缺表与未绑定保持区别", async () => {
  for (const defect of ["resource", "schema", "auth"] as const) {
    const f = fixture(); if (defect === "resource") f.state.database = "other_db"; if (defect === "schema") f.state.integrated = false; if (defect === "auth") f.state.authenticated = false;
    await assert.rejects(save(f)); assert.equal(f.keys(), 0); assert.equal(f.data().banks.size, 0);
  }
  const f = fixture(); assert.equal((await withTransaction(f.pool, c => readWithdrawalBankBinding(c, actor, f.options))).expectedRevision, "0");
  f.state.integrated = false; const result = await withTransaction(f.pool, c => readWithdrawalBankBinding(c, actor, f.options));
  assert.equal(result.integration, "NOT_INTEGRATED"); assert.equal(result.expectedRevision, null); assert.equal(f.keys(), 0);
});
test("审计失败回滚绑定和幂等回执；钥错误不泄露私有文本", async () => {
  const f = fixture(); f.state.failAudit = true; await assert.rejects(save(f), /unit audit failure/);
  assert.equal(f.data().banks.size, 0); assert.equal(f.data().receipts.size, 0); assert.equal(f.data().audits.length, 0);
  const o = { ...f.options, protection: { currentKeyVersion: "unit_storage_key", keyFor: () => { throw Error("PRIVATE_SECRET_PATH_VALUE"); } } };
  await assert.rejects(saveWithdrawalBankBinding(f.pool, actor, input, "unit_no_key", o), e => { assert(!String(e).includes("PRIVATE")); assert(String(e).includes("BANK_BINDING_KEY_UNAVAILABLE")); return true; });
});
test("COMMIT响应未知保留原key，独立本地恢复不重写绑卡或重读钥", async () => {
  const f = fixture(); f.state.commitUnknown = true;
  await assert.rejects(save(f), e => e instanceof BankBindingCommitUnknown && e.originalKey === "unit_first");
  assert.equal(f.data().banks.size, 1); assert.equal(f.data().receipts.size, 1); f.state.commitUnknown = false;
  const keys = f.keys(), r = await withTransaction(f.pool, c => recoverWithdrawalBankBinding(c, actor, "unit_first", f.options));
  assert.equal(r.knowledge, "KNOWN"); assert.equal(f.keys(), keys); assert.equal(f.data().banks.get(actor.userId)!.revision, "1");
  assert.equal((await withTransaction(f.pool, c => recoverWithdrawalBankBinding(c, actor, "unit_unknown", f.options))).knowledge, "UNKNOWN");
});
test("内部解密严格绑定用户/逻辑ID/版本/保护钥/掩码；不能把密文挪给另一目标", async () => {
  for (const tamper of ["user", "id", "revision", "ciphertext", "mask", "key"] as const) {
    const f = fixture(), r = await save(f), b = r.body.binding!, row = f.data().banks.get(actor.userId)!;
    let expected = "1", id = b.id, options = f.options;
    if (tamper === "user") row.user_id = "other_user";
    if (tamper === "id") { row.id = "bank_" + "a".repeat(32); id = row.id; }
    if (tamper === "revision") { row.revision = "2"; expected = "2"; }
    if (tamper === "mask") row.card_mask = "**** **** 9999";
    if (tamper === "ciphertext") { const e = JSON.parse(row.sealed_details); e.encrypted = (e.encrypted[0] === "A" ? "B" : "A") + e.encrypted.slice(1); row.sealed_details = JSON.stringify(e); }
    if (tamper === "key") options = { ...f.options, protection: { currentKeyVersion: "unit_storage_key", keyFor: () => Buffer.alloc(32, 18) } };
    await assert.rejects(withTransaction(f.pool, c => readWithdrawalBankBindingPrivate(c, actor, id, expected, options)));
  }
});
test("其他用户无法读取本人绑定或回执；过期绑定版本不作提现目标", async () => {
  const f = fixture(), r = await save(f), b = r.body.binding!, other = { ...actor, userId: "unit_other_user" };
  const get = await withTransaction(f.pool, c => readWithdrawalBankBinding(c, other, f.options)); assert.equal(get.binding, null);
  const recovery = await withTransaction(f.pool, c => recoverWithdrawalBankBinding(c, other, "unit_first", f.options)); assert.equal(recovery.knowledge, "UNKNOWN");
  await assert.rejects(withTransaction(f.pool, c => readWithdrawalBankBindingPrivate(c, other, b.id, "1", f.options)));
  await assert.rejects(withTransaction(f.pool, c => readWithdrawalBankBindingPrivate(c, actor, b.id, "2", f.options)), /Bank binding changed/);
});
test("nonce每次不同，轮换保护钥按版本精确读取；不影响旧幂等恢复", async () => {
  const f = fixture(); await save(f); const first = JSON.parse(f.data().banks.get(actor.userId)!.sealed_details);
  const next = { ...f.options, protection: { currentKeyVersion: "unit_next_key", keyFor: () => Buffer.alloc(32, 19) } };
  const r = await saveWithdrawalBankBinding(f.pool, actor, { ...input, expectedRevision: "1" }, "unit_next", next), e = JSON.parse(f.data().banks.get(actor.userId)!.sealed_details);
  assert.notEqual(e.nonce, first.nonce); assert.equal(e.keyVersion, "unit_next_key");
  assert.equal((await withTransaction(f.pool, c => readWithdrawalBankBindingPrivate(c, actor, r.body.binding!.id, "2", next))).cardNo, input.cardNo);
});
test("损坏回执只输出白名单投影；最大revision可读但不能溢出递增", async () => {
  const f = fixture(), r = await save(f), rec = [...f.data().receipts.values()][0]!;
  rec.responseBody.extraSecret = "PRIVATE_DETAILS"; rec.responseBody.binding.extraCard = input.cardNo;
  const recovery = await withTransaction(f.pool, c => recoverWithdrawalBankBinding(c, actor, "unit_first", f.options));
  assert(!JSON.stringify(recovery).includes("PRIVATE")); assert(!JSON.stringify(recovery).includes(input.cardNo));
  f.data().banks.get(actor.userId)!.revision = "9223372036854775807";
  assert.equal((await withTransaction(f.pool, c => readWithdrawalBankBinding(c, actor, f.options))).expectedRevision, "9223372036854775807");
  await assert.rejects(save(f, { ...input, expectedRevision: "9223372036854775807" }, "unit_exhausted"), /revision exhausted/);
  assert.equal(r.body.binding!.revision, "1");
});

test("损坏数据库记录不能把完整卡号借ID字段带回GET", async () => {
  const f = fixture(); await save(f); f.data().banks.get(actor.userId)!.id = input.cardNo;
  await assert.rejects(withTransaction(f.pool, c => readWithdrawalBankBinding(c, actor, f.options)), e => {
    assert(String(e).includes("BANK_BINDING_RECORD_INVALID")); assert(!String(e).includes(input.cardNo)); return true;
  });
});
