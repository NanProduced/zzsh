import assert from "node:assert/strict";
import { test } from "node:test";
import { SecurityApiError } from "../src/auth/security-core";
import * as v1 from "../src/finance/personal-withdrawal-read";
import { parseWithdrawalHistoryQuery, readJoinpayWithdrawalHistory, readPersonalWithdrawalHistory, recoverJoinpayWithdrawalFromHistory } from "../src/finance/personal-withdrawal-history";
import { actor, cursorKey, fixture, nativeRow } from "./fixtures/withdrawal-history-model";

// SYNTHETIC_READER_COMPONENT：HMAC/投影是真函数；事务与数据为无socket模型。
const query = (value = "source=JOINPAY") => parseWithdrawalHistoryQuery(new URLSearchParams(value));
test("新增v2解析只接受明确来源/状态，旧v1继续拒绝JOINPAY", () => {
  assert.equal(query().source, "JOINPAY"); assert.throws(() => v1.parsePersonalWithdrawalQuery(new URLSearchParams("source=JOINPAY")));
  for (const value of ["source=JOINPAY&state=1", "source=JOINPAY&state=RECONCILIATION_REQUIRED", "source=JOINPAY&source=HISTORICAL", "source=JOINPAY&limit=101", "source=JOINPAY&userId=other", "source=ALL&cursor=x", "source=ALL&state=UNKNOWN"]) assert.throws(() => query(value));
});
test("无渠道装配也可读本人Native记录；金额精确且银行/到账/证据等级不升级", async () => {
  const f = fixture([nativeRow("a")]), r = await readJoinpayWithdrawalHistory(f.pool, actor, query(), cursorKey), data = r.data! as any;
  assert.equal(data.count, "1"); assert.equal(data.items[0].amountCents, "10000"); assert.equal(data.items[0].originalDestination.cardMask, "**** **** 0015");
  assert.equal(data.items[0].evidenceLevel, "LOCAL_RECORDS_NOT_REVALIDATED"); assert.equal(data.items[0].bankArrival, "UNKNOWN"); assert.equal(data.items[0].mayResubmit, false);
  assert.equal(data.scope, "LOCAL_NATIVE_INTENTS_ONLY");
  const serialized = JSON.stringify(r); for (const hidden of ["0000000000000015", "虚构用户", "admission_canonical", "keyVersion", "receiverAccountNoEnc"]) assert(!serialized.includes(hidden));
  assert.equal(f.keys(), 0); assert(f.trace.every(q => !/INSERT INTO|UPDATE |DELETE FROM/.test(q.sql))); assert(f.trace.every(q => !q.sql.includes("FROM zzsh_order.withdrawal_bank_binding")));
});
test("缺schema/窄权不是0笔；已接的本地空记录仅证明本地为空", async () => {
  const f = fixture(); f.history.ready = false; const absent = await readJoinpayWithdrawalHistory(f.pool, actor, query(), cursorKey); assert.equal(absent.availability, "NOT_INTEGRATED"); assert.equal(absent.data, null);
  f.history.ready = true; const empty = await readJoinpayWithdrawalHistory(f.pool, actor, query(), cursorKey); assert.equal((empty.data as any).count, "0"); assert.equal((empty.data as any).scope, "LOCAL_NATIVE_INTENTS_ONLY");
});
test("稳定双键分页无重复遗漏；状态筛选只作用JOINPAY", async () => {
  const f = fixture([nativeRow("a"), nativeRow("b"), nativeRow("c")]), all: string[] = []; let cursor: string | null = null;
  do { const r = await readJoinpayWithdrawalHistory(f.pool, actor, { ...query("source=JOINPAY&limit=1"), cursor }, cursorKey), page = r.data as any;
    all.push(...page.items.map((i: any) => i.intentId)); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(all, ["jwd_" + "c".repeat(40), "jwd_" + "b".repeat(40), "jwd_" + "a".repeat(40)]);
  f.history.rows[0]!.state = "PROCESSING"; f.history.rows[0]!.operation_version = "2";
  const selected = await readJoinpayWithdrawalHistory(f.pool, actor, query("source=JOINPAY&state=PROCESSING"), cursorKey); assert.equal((selected.data as any).count, "1");
});
test("cursor绑定用户/会话/过滤和版本；新状态或源失效须刷新，不补新page", async () => {
  const f = fixture([nativeRow("a"), nativeRow("b")]), first = await readJoinpayWithdrawalHistory(f.pool, actor, query("source=JOINPAY&limit=1"), cursorKey), cursor = (first.data as any).nextCursor;
  for (const [a, q] of [[{ ...actor, sessionId: "unit_other_session" }, { ...query(), cursor }], [{ ...actor, userId: "unit_other_user" }, { ...query(), cursor }], [actor, { ...query("source=JOINPAY&state=UNKNOWN"), cursor }]] as const)
    await assert.rejects(readJoinpayWithdrawalHistory(f.pool, a, q, cursorKey), (e: any) => e.status === 409);
  await assert.rejects(readJoinpayWithdrawalHistory(f.pool, actor, { ...query(), cursor: cursor + "x" }, cursorKey));
  f.history.rows[0]!.operation_version = "2"; await assert.rejects(readJoinpayWithdrawalHistory(f.pool, actor, { ...query(), cursor }, cursorKey), (e: any) => e.status === 409);
  f.history.ready = false; await assert.rejects(readJoinpayWithdrawalHistory(f.pool, actor, { ...query(), cursor }, cursorKey), (e: any) => e.status === 409);
});

test("相同记录/会话的cursor不能跨数据库、角色或重建后的OID复用", async () => {
  for (const property of ["database", "runtimeUser", "databaseOid"] as const) {
    const f = fixture([nativeRow("a"), nativeRow("b")]), r = await readJoinpayWithdrawalHistory(f.pool, actor, query("source=JOINPAY&limit=1"), cursorKey), cursor = (r.data as any).nextCursor;
    f.history[property] = property === "databaseOid" ? "54321" : "other_resource";
    await assert.rejects(readJoinpayWithdrawalHistory(f.pool, actor, { ...query(), cursor }, cursorKey), (e: any) => e.status === 409);
  }
});
test("详情与原key恢复都按本人归属，不依赖当前商户配置，也不重新提交", async () => {
  const row = nativeRow("a"), f = fixture([row]); f.history.receipts.set(actor.userId + ":unit_original", row.id);
  const detail: any = await readPersonalWithdrawalHistory(f.pool, actor, query(), cursorKey, undefined, "joinpay:" + row.id); assert.equal(detail.data.item.intentId, row.id);
  const r = await recoverJoinpayWithdrawalFromHistory(f.pool, actor, "unit_original"); assert.equal(r.knowledge, "KNOWN"); assert.equal(r.mayResubmit, false); assert.equal(r.item!.state, "UNKNOWN");
  const sql = f.trace.find(q => q.sql.includes("JOIN zzsh_supply.idempotency_record"))!; assert.equal(sql.values[1], JSON.stringify(["user", actor.userId, "joinpay.withdrawal.reserve.v1", null])); assert(sql.sql.includes("i.request_fingerprint=r.request_fingerprint"));
  const other = { ...actor, userId: "unit_other_user" }; assert.equal((await recoverJoinpayWithdrawalFromHistory(f.pool, other, "unit_original")).knowledge, "UNKNOWN");
  await assert.rejects(readPersonalWithdrawalHistory(f.pool, other, query(), cursorKey, undefined, "joinpay:" + row.id), (e: any) => e.status === 404);
});
test("UNKNOWN原key不表示未执行；未来状态/资金枚举不伪造失败或释放", async () => {
  const row = { ...nativeRow("a"), state: "FUTURE_VENDOR_PHASE", funds_disposition: "FUTURE_DISPOSITION" }, f = fixture([row]);
  const r = await readJoinpayWithdrawalHistory(f.pool, actor, query(), cursorKey), item = (r.data as any).items[0]; assert.equal(item.state, "UNKNOWN"); assert.equal(item.fundsDisposition, "UNKNOWN"); assert.equal(item.bankArrival, "UNKNOWN"); assert.equal(item.reasonCodes.length, 2);
  assert.equal((await recoverJoinpayWithdrawalFromHistory(f.pool, actor, "unit_missing")).knowledge, "UNKNOWN");
});
test("错币种/金额/行归属不暴露数据；原掩码坏摘要保持null", async () => {
  for (const change of [{ currency: "USD" }, { gross_cents: "10001" }, { net_cents: "1.00" }, { requires_review: null }]) {
    const f = fixture([{ ...nativeRow("a"), ...change }]); await assert.rejects(readJoinpayWithdrawalHistory(f.pool, actor, query(), cursorKey), (e: any) => e.status === 503);
  }
  const f = fixture([nativeRow("a")]); f.history.injectForeign = true; await assert.rejects(readJoinpayWithdrawalHistory(f.pool, actor, query(), cursorKey));
  f.history.injectForeign = false; f.history.rows[0]!.admission_sha256 = "f".repeat(64); const r = await readJoinpayWithdrawalHistory(f.pool, actor, query(), cursorKey); assert.equal((r.data as any).items[0].originalDestination.cardMask, null);
});
test("三来源分别复用旧reader，旧证据异常不阻断Native；认证错误不能吞成空", async t => {
  const f = fixture([nativeRow("a")]), seen: string[] = [];
  t.mock.method(v1, "readPersonalWithdrawals", async (_p: unknown, _a: unknown, q: any) => { seen.push(q.source); if (q.source === "HISTORICAL") throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "private diagnostic");
    return { controlled: { availability: "NOT_ADMITTED", reason: "CONTROLLED_LOCAL_ADMISSION_UNAVAILABLE", data: null } } as any;
  });
  const result: any = await readPersonalWithdrawalHistory(f.pool, actor, query(""), cursorKey); assert.deepEqual(seen, ["HISTORICAL", "LOCAL_CONTROLLED"]);
  assert.equal(result.contractVersion, "personal-withdrawals.read.v2"); assert.equal(result.sections.historical.availability, "UNAVAILABLE"); assert.equal(result.sections.historical.data, null); assert.equal(result.sections.joinpay.data.count, "1"); assert(!JSON.stringify(result).includes("private diagnostic"));
  t.mock.method(v1, "readPersonalWithdrawals", async () => { throw new SecurityApiError(401, "UNAUTHENTICATED", "Denied"); });
  await assert.rejects(readPersonalWithdrawalHistory(f.pool, actor, query(""), cursorKey), (e: any) => e.status === 401);
});
test("认证失败先于Native读取和签名，原v1明细继续委托", async t => {
  const f = fixture([nativeRow("a")]); f.state.authenticated = false; await assert.rejects(readJoinpayWithdrawalHistory(f.pool, actor, query(), cursorKey)); assert(!f.trace.some(q => q.sql.includes("FROM pg_attribute")));
  let id: unknown; t.mock.method(v1, "readPersonalWithdrawals", async (...args: any[]) => { id = args[5]; return { contractVersion: "personal-withdrawals.read.v1", source: "HISTORICAL_WITHDRAWAL", item: { id } } as any; });
  const r: any = await readPersonalWithdrawalHistory(f.pool, actor, query(""), cursorKey, undefined, "history:unit_old"); assert.equal(r.contractVersion, "personal-withdrawals.read.v2"); assert.equal(id, "history:unit_old");
});
