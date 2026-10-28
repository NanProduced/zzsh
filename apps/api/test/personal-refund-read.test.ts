import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../src/auth/security-core";
import { readPersonalNativeRefunds } from "../src/finance/personal-refund-read";

// SYNTHETIC_READER_COMPONENT: real projection and real auth/session checks; no socket, database, channel or key.
const USER = "user_renter_01";
const OTHER = "user_renter_other";
const ORDER = "order_native_01";
const POSTING = "posting_native_01";
const AS_OF = "2026-10-27T10:00:00.000000Z";
const PAST = "2026-10-26T10:00:00.000000Z";
const FUTURE = "2026-10-28T10:00:00.000000Z";
const EVENT_ID = "native_refund_paid_" + "c".repeat(20);
const ROOT_ID = "native_refund_root_" + "c".repeat(20);
const EVIDENCE_ID = "jre_" + "b".repeat(40);
const INTENT_ID = "rfi_" + "a".repeat(40);

type Query = { sql: string; values: unknown[] };
type Result = { rows: Record<string, unknown>[]; rowCount?: number };
type State = {
  suspended?: boolean;
  accountStatus?: string | null;
  session?: boolean;
  preflightReady?: boolean;
  orderRows?: Record<string, unknown>[];
  intentRows?: Record<string, unknown>[];
  abnormalRows?: Record<string, unknown>[];
  abnormalIntentRows?: Record<string, unknown>[];
  liabilityRows?: Record<string, unknown>[];
  ledgerRows?: Record<string, unknown>[];
};

function fake(state: State = {}) {
  const trace: Query[] = [];
  const query = async (sql: string, values: unknown[] = []): Promise<Result> => {
    trace.push({ sql, values });
    if (sql.startsWith('SELECT "suspended"')) return { rows: [{ suspended: state.suspended === true }], rowCount: 1 };
    if (sql.includes('"zzsh_iam"."user_identity_state"')) {
      return { rows: state.accountStatus === null ? [] : [{ accountStatus: state.accountStatus ?? "ACTIVE" }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"')) {
      return { rows: state.session === false ? [] : [{}], rowCount: state.session === false ? 0 : 1 };
    }
    if (sql.startsWith("WITH req AS")) {
      return { rows: [{ database: "zzsh_test", runtime_user: "zzsh_api_test", as_of: AS_OF, ready: state.preflightReady !== false }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT o.id,o.display_no,o.status,o.renter_user_id")) return { rows: state.orderRows ?? [order()] };
    if (sql.startsWith("SELECT c.id AS confirmation_id")) return { rows: state.abnormalRows ?? [] };
    if (sql.startsWith("SELECT i.id,i.posting_id,i.order_id") && sql.includes("basis_kind='REVIEW_CONFIRMATION'")) return { rows: state.abnormalIntentRows ?? [] };
    if (sql.startsWith("SELECT i.id,i.posting_id,i.order_id")) return { rows: state.intentRows ?? [] };
    if (sql.startsWith("SELECT e.id AS event_id,e.kind AS event_kind")) return { rows: state.liabilityRows ?? [] };
    if (sql.startsWith("SELECT e.id AS event_id")) return { rows: state.ledgerRows ?? [] };
    throw new Error("Unexpected SQL: " + sql);
  };
  return { trace, client: { query } as unknown as PoolClient };
}

function order(overrides: Record<string, unknown> = {}) {
  return { id: ORDER, display_no: "ZZ261027-000001", status: "COMPLETED", renter_user_id: USER,
    posting_id: POSTING, posting_currency: "CNY", refund_cents: "10000", due_at: PAST, ...overrides };
}

function intent(overrides: Record<string, unknown> = {}) {
  return { id: INTENT_ID, posting_id: POSTING, order_id: ORDER, renter_user_id: USER,
    payment_source: "JOINPAY", evidence_level: "JOINPAY_FORMAL", refund_order_no: "RF" + "a".repeat(28),
    merchant_identity_id: "merchant_1", original_payment_trx_no: "trx_abn", original_payment_order_no: "ORDER_NO_1",
    basis_kind: "POSTING", payment_confirmation_id: "pc_native_01", liability_root_id: null, liability_event_id: null,
    responsibility_version_hash: "c".repeat(64), submit_attempts: 0, blocked_count: 0, blocked_at: null, blocked_reason: null,
    amount_cents: "10000", currency: "CNY", state: "READY", budget_disposition: "ALLOCATED", requires_review: false,
    terminal_evidence_id: null, terminal_root_id: null, terminal_event_id: null, provider_refund_trx_no: null, completed_at: null,
    due_at: PAST, created_at: "2026-10-26T11:00:00.000000Z", updated_at: "2026-10-26T11:00:00.000000Z",
    evidence_terminal: null, evidence_trx_no: null, evidence_completed_at: null, terminal_evidence_level: null,
    latest_source: "JOINPAY", latest_event: "PROCESSING", latest_failure_reason: null,
    latest_evidence_level: "PROVIDER_RESPONSE", latest_observed_at: "2026-10-26T11:00:00.000000Z",
    failure_source: null, failure_event: null, failure_reason_code: null, failure_evidence_level: null,
    failure_observed_at: null, ...overrides };
}

function consumed(overrides: Record<string, unknown> = {}) {
  return intent({ state: "SUCCEEDED", budget_disposition: "CONSUMED", terminal_evidence_id: EVIDENCE_ID,
    terminal_root_id: ROOT_ID, terminal_event_id: EVENT_ID, provider_refund_trx_no: "CHTRX001", completed_at: "2026-10-26T12:00:00.000000Z",
    evidence_terminal: "SUCCEEDED", evidence_trx_no: "CHTRX001",
    evidence_completed_at: "2026-10-26T12:00:00.000000Z", terminal_evidence_level: "PROVIDER_RESPONSE",
    latest_event: "TERMINAL", latest_observed_at: "2026-10-26T12:00:00.000000Z", ...overrides });
}

function failed(overrides: Record<string, unknown> = {}) {
  return intent({ state: "FAILED", budget_disposition: "RELEASED", terminal_evidence_id: EVIDENCE_ID,
    terminal_event_id: null, provider_refund_trx_no: null, completed_at: null,
    evidence_terminal: "FAILED_NO_EXECUTION", evidence_trx_no: null, evidence_completed_at: null,
    terminal_evidence_level: "PROVIDER_RESPONSE", latest_event: "TERMINAL",
    latest_observed_at: "2026-10-26T12:00:00.000000Z", ...overrides });
}

function ledger(amount = "10000", overrides: Record<string, unknown> = {}) {
  return { event_id: EVENT_ID, economic_root_id: ROOT_ID, root_id: ROOT_ID, root_source_kind: "NATIVE_RENTAL_REFUND",
    root_source_id: INTENT_ID, root_subject_user_id: USER, total_lines: "2", subject_user_id: USER, posted_at: "2026-10-26T12:00:00.100000Z",
    payable_debit: amount, payable_credit: "0", payable_lines: "1", payable_subject_lines: "1",
    clearing_debit: "0", clearing_credit: amount, clearing_lines: "1", ...overrides };
}

const read = (state: State, orderId = ORDER) => {
  const f = fake(state);
  return { trace: f.trace, result: readPersonalNativeRefunds(f.client, { userId: USER, sessionId: "session_01" }, { orderId }) };
};
const rejectStatus = (error: unknown, status: number) => error instanceof SecurityApiError && error.status === status;
const helperSql = (trace: Query[]) => trace.filter(entry => !entry.sql.startsWith('SELECT "suspended"')
  && !entry.sql.includes('"zzsh_iam"."user_identity_state"') && !entry.sql.startsWith('SELECT 1 FROM "zzsh_auth_user"."session"'));

test("本人正常读取：全部分摊、精确金额、本地记账与渠道事实分列", async () => {
  const { result, trace } = await read({ intentRows: [intent()] });
  const data = await result;
  assert.equal(data.status, "AVAILABLE");
  assert.equal(data.outcome, "FULLY_ALLOCATED");
  assert.equal(data.order.orderId, ORDER);
  assert.equal(data.responsibility.originalCents, "10000");
  assert.equal(data.responsibility.allocatedCents, "10000");
  assert.equal(data.responsibility.consumedCents, "0");
  assert.equal(data.responsibility.releasedCents, "0");
  assert.equal(data.responsibility.remainingCents, "0");
  assert.equal(data.responsibility.totalsComplete, true);
  assert.equal(data.responsibility.dueState, "DUE");
  assert.equal(data.intents.length, 1);
  assert.equal(data.intents[0]!.source, "JOINPAY_FORMAL");
  assert.equal(data.intents[0]!.budgetDisposition, "ALLOCATED");
  assert.equal(data.intents[0]!.amount!.cents, "10000");
  assert.equal(data.intents[0]!.latestObservation!.ageSeconds, 82800);
  assert.equal(data.intents[0]!.channelFacts.actualAmountCents, null);
  assert.equal(data.intents[0]!.channelFacts.channelRefundTrxNo, null);
  assert.equal(data.intents[0]!.channelFacts.destination, null);
  assert.equal(data.intents[0]!.channelFacts.bankArrival, "UNKNOWN");
  assert.equal(data.actualChannelRefund.amountCents, null);
  assert.equal(data.actualChannelRefund.completedAt, null);
  assert.equal(data.coverage.scope, "LOCAL_REGISTERED_ONLY");
  assert.equal(data.coverage.intentLimit, 50);
  assert.equal(data.coverage.channelRecordsChecked, false);
  assert(data.unknowns.includes("CHANNEL_REFUND_RECORD_NOT_CHECKED"));
  assert(data.unknowns.includes("BANK_ARRIVAL_UNKNOWN"));
  const statements = helperSql(trace);
  assert.equal(statements.length, 5);
  const preflight = statements.find(entry => entry.sql.startsWith("WITH req AS"))!;
  const orderQuery = statements.find(entry => entry.sql.startsWith("SELECT o.id"))!;
  const intentQuery = statements.find(entry => entry.sql.startsWith("SELECT i.id") && !entry.sql.includes("basis_kind='REVIEW_CONFIRMATION'"))!;
  const spec = JSON.parse(preflight.values[0] as string) as { table: string; columns: string[] }[];
  const rootRead = spec.find(entry => entry.table === "zzsh_order.finance_economic_root");
  assert(rootRead && ["id", "source_kind", "source_id", "subject_user_id"].every(column => rootRead.columns.includes(column)));
  assert(spec.some(entry => entry.table === "zzsh_order.channel_refund_intent"));
  assert.deepEqual(orderQuery.values, [ORDER]);
  assert.deepEqual(intentQuery.values, [POSTING]);
  assert(intentQuery.sql.includes("LIMIT 51"));
  const all = trace.map(entry => entry.sql).join("\n");
  for (const forbidden of ["INSERT", "UPDATE ", "DELETE", "FOR UPDATE", "raw_body", "profile_canonical", "key_version",
    "pg_advisory", "BEGIN", "COMMIT", "legacy_order"]) assert(!all.includes(forbidden), forbidden);
});

test("跨租户订单与其它租户意图都不暴露：404 / CONFLICT 且不含他人金额", async () => {
  await assert.rejects(read({ orderRows: [order({ renter_user_id: OTHER })] }).result, error => rejectStatus(error, 404));
  const { result, trace } = await read({ intentRows: [intent({ renter_user_id: OTHER, amount_cents: "54321" })] });
  const data = await result;
  assert.equal(data.outcome, "CONFLICT");
  assert(data.reasonCodes.includes("INTENT_RENTER_MISMATCH"));
  assert.equal(data.intents.length, 0);
  assert.equal(data.responsibility.allocatedCents, null);
  assert.equal(data.responsibility.totalsComplete, false);
  assert(!JSON.stringify(data).includes("54321"));
  assert.equal(helperSql(trace).length, 5);
});

test("订单不存在返回404；认证失败先于任何证据读取", async () => {
  const missing = fake({ orderRows: [] });
  await assert.rejects(readPersonalNativeRefunds(missing.client, { userId: USER, sessionId: "session_01" }, { orderId: ORDER }),
    error => rejectStatus(error, 404));
  assert.equal(helperSql(missing.trace).length, 2);
  assert(!missing.trace.some(entry => entry.sql.startsWith("SELECT i.id")));

  const suspended = fake({ suspended: true });
  await assert.rejects(readPersonalNativeRefunds(suspended.client, { userId: USER, sessionId: "session_01" }, { orderId: ORDER }),
    error => rejectStatus(error, 401));
  assert(!suspended.trace.some(entry => entry.sql.startsWith("WITH req AS")));

  const expired = fake({ session: false });
  await assert.rejects(readPersonalNativeRefunds(expired.client, { userId: USER, sessionId: "session_01" }, { orderId: ORDER }),
    error => rejectStatus(error, 401));
  assert(!expired.trace.some(entry => entry.sql.startsWith("WITH req AS")));

  const invalid = fake();
  await assert.rejects(readPersonalNativeRefunds(invalid.client, { userId: USER, sessionId: "session_01" }, { orderId: "bad id" }),
    error => rejectStatus(error, 400));
  assert.equal(invalid.trace.length, 0);
});

test("schema或列权限不可用返回503，不伪装成零退款", async () => {
  const { result, trace } = await read({ preflightReady: false });
  await assert.rejects(result, error => rejectStatus(error, 503));
  assert.equal(helperSql(trace).length, 1);
  assert(!trace.some(entry => entry.sql.startsWith("SELECT o.id")));
});

test("订单未形成退款责任时只投影本地状态，不推断渠道未支付", async () => {
  for (const [status, expected] of [["PENDING_PAYMENT", "RESPONSIBILITY_NOT_POSTED"], ["CANCELLED", "RESPONSIBILITY_NOT_POSTED"]] as const) {
    const { result, trace } = await read({ orderRows: [order({ status, posting_id: null, posting_currency: null, refund_cents: null, due_at: null })] });
    const data = await result;
    assert.equal(data.status, "NOT_APPLICABLE");
    assert.equal(data.outcome, expected);
    assert.equal(data.responsibility.state, "NOT_POSTED");
    assert.equal(data.intents.length, 0);
    assert(!trace.some(entry => entry.sql.startsWith("SELECT i.id") && !entry.sql.includes("basis_kind='REVIEW_CONFIRMATION'")));
  }
  const paid = await read({ orderRows: [order({ status: "PAID", posting_id: null, posting_currency: null, refund_cents: null, due_at: null })] });
  const data = await paid.result;
  assert.equal(data.status, "NOT_APPLICABLE");
  assert.equal(data.outcome, "RESPONSIBILITY_NOT_POSTED");
  assert(data.reasonCodes.includes("LOCAL_RESPONSIBILITY_NOT_POSTED"));
});

test("零责任、未到期、无意图是三个不同结果；空意图只证明本地登记为空", async () => {
  const zero = await read({ orderRows: [order({ refund_cents: "0" })] });
  const zeroData = await zero.result;
  assert.equal(zeroData.outcome, "ZERO_RESPONSIBILITY");
  assert.equal(zeroData.responsibility.originalCents, "0");
  assert.equal(zeroData.responsibility.remainingCents, "0");
  assert.equal(zeroData.responsibility.totalsComplete, true);
  assert.equal(zeroData.localFundsEffect.writtenOffCents, "0");
  assert(zeroData.reasonCodes.includes("ZERO_FROZEN_RENTER_REFUND_RESPONSIBILITY"));

  const notDue = await read({ orderRows: [order({ due_at: FUTURE })] });
  const notDueData = await notDue.result;
  assert.equal(notDueData.outcome, "NOT_DUE");
  assert.equal(notDueData.responsibility.dueState, "NOT_DUE");
  assert.equal(notDueData.responsibility.remainingCents, "10000");

  const none = await read({});
  const noneData = await none.result;
  assert.equal(noneData.outcome, "NO_INTENT");
  assert.equal(noneData.intents.length, 0);
  assert.equal(noneData.responsibility.remainingCents, "10000");
  assert(noneData.reasonCodes.includes("NO_LOCAL_REFUND_INTENT_RECORDED"));
  assert(noneData.reasonCodes.includes("EMPTY_INTENTS_MEANS_NO_LOCAL_INTENT_ONLY"));
});

test("部分/全部分摊按所有意图求和，不选最近一笔为完整结果", async () => {
  const partial = await read({ intentRows: [intent({ id: "rfi_" + "1".repeat(40), amount_cents: "3000" }),
    intent({ id: "rfi_" + "2".repeat(40), amount_cents: "2000" })] });
  const partialData = await partial.result;
  assert.equal(partialData.outcome, "PARTIALLY_ALLOCATED");
  assert.equal(partialData.responsibility.allocatedCents, "5000");
  assert.equal(partialData.responsibility.remainingCents, "5000");
  assert.equal(partialData.returnedIntentCount, 2);
  assert(partialData.reasonCodes.includes("MULTIPLE_REFUND_INTENTS"));

  const full = await read({ intentRows: [intent({ id: "rfi_" + "1".repeat(40), amount_cents: "4000" }),
    intent({ id: "rfi_" + "2".repeat(40), amount_cents: "6000" })] });
  const fullData = await full.result;
  assert.equal(fullData.outcome, "FULLY_ALLOCATED");
  assert.equal(fullData.responsibility.allocatedCents, "10000");
  assert.equal(fullData.responsibility.remainingCents, "0");
});

test("本地核销与渠道成功/银行到账分列；未重验的实际字段固定null", async () => {
  const { result, trace } = await read({ intentRows: [consumed()], ledgerRows: [ledger()] });
  const data = await result;
  assert.equal(data.outcome, "FULLY_CONSUMED");
  assert.equal(data.responsibility.consumedCents, "10000");
  assert.equal(data.responsibility.remainingCents, "0");
  assert.equal(data.localFundsEffect.basis, "LOCAL_REGISTERED_ACCOUNTING");
  assert.equal(data.localFundsEffect.writtenOffCents, "10000");
  assert.equal(data.localFundsEffect.bankArrival, "UNKNOWN");
  const item = data.intents[0]!;
  assert.equal(item.budgetDisposition, "CONSUMED");
  assert.equal(item.localAccounting.writeOff!.amountCents, "10000");
  assert.equal(item.localAccounting.writeOff!.trust, "LOCAL_LEDGER");
  assert.equal(item.localAccounting.release, null);
  assert.equal(item.savedChannelEvidence!.terminal, "SUCCEEDED");
  assert.equal(item.savedChannelEvidence!.providerRefundTrxNo, "CHTRX001");
  assert.equal(item.savedChannelEvidence!.trust, "SAVED_EVIDENCE_NOT_REVALIDATED");
  assert.equal(item.channelFacts.actualAmountCents, null);
  assert.equal(item.channelFacts.channelRefundTrxNo, null);
  assert.equal(item.channelFacts.completedAt, null);
  assert.equal(item.channelFacts.destination, null);
  assert.equal(item.channelFacts.bankArrival, "UNKNOWN");
  assert.equal(data.actualChannelRefund.channelRefundTrxNo, null);
  assert.equal(data.actualChannelRefund.completedAt, null);
  assert(data.reasonCodes.includes("LOCAL_WRITE_OFF_RECORDED"));
  const ledgerQuery = helperSql(trace).find(entry => entry.sql.startsWith("SELECT e.id AS event_id"))!;
  assert.deepEqual(ledgerQuery.values[0], [EVENT_ID]);
  assert.equal(ledgerQuery.values[1], USER);
  assert(ledgerQuery.sql.includes("ANY($1::text[])"));
});

test("部分核销保留剩余责任；重复观察不增加金额", async () => {
  const row = consumed({ amount_cents: "4000", failure_source: "JOINPAY", failure_event: "REVIEW",
    failure_reason_code: "REVIEW_REQUIRED", failure_evidence_level: "PROVIDER_RESPONSE", failure_observed_at: "2026-10-26T12:30:00.000000Z" });
  const { result } = await read({ intentRows: [row], ledgerRows: [ledger("4000")] });
  const data = await result;
  assert.equal(data.outcome, "PARTIALLY_CONSUMED");
  assert.equal(data.responsibility.allocatedCents, "4000");
  assert.equal(data.responsibility.consumedCents, "4000");
  assert.equal(data.responsibility.remainingCents, "6000");
  assert.equal(data.intents[0]!.latestObservation!.event, "TERMINAL");
  assert.equal(data.intents[0]!.latestFailure!.event, "REVIEW");
  assert.equal(data.intents[0]!.latestFailure!.failureReason, "REVIEW_REQUIRED");
  assert.equal(data.intents[0]!.latestFailure!.ageSeconds, 77400);
  assert.equal(data.intents[0]!.localAccounting.writeOff!.amountCents, "4000");
});

test("释放本地分摊释放预算但不写成资金核销", async () => {
  const { result } = await read({ intentRows: [failed()] });
  const data = await result;
  assert.equal(data.outcome, "RELEASED");
  assert.equal(data.responsibility.allocatedCents, "0");
  assert.equal(data.responsibility.consumedCents, "0");
  assert.equal(data.responsibility.releasedCents, "10000");
  assert.equal(data.responsibility.remainingCents, "10000");
  assert.equal(data.localFundsEffect.writtenOffCents, "0");
  assert.equal(data.localFundsEffect.releasedCents, "10000");
  const item = data.intents[0]!;
  assert.equal(item.localAccounting.writeOff, null);
  assert.equal(item.localAccounting.release!.trust, "LOCAL_INTENT_ONLY");
  assert.equal(item.localAccounting.release!.ledgerEventId, null);
  assert.equal(item.savedChannelEvidence!.terminal, "FAILED_NO_EXECUTION");
  assert.equal(item.savedChannelEvidence!.providerRefundTrxNo, null);
  assert(data.reasonCodes.includes("LOCAL_ALLOCATION_RELEASED"));
});

test("UNKNOWN与REVIEW_REQUIRED是显式结果，不从责任减少推断失败", async () => {
  const unknown = await read({ intentRows: [intent({ state: "UNKNOWN" })] });
  const unknownData = await unknown.result;
  assert.equal(unknownData.outcome, "UNKNOWN");
  assert.equal(unknownData.responsibility.allocatedCents, "10000");
  assert.equal(unknownData.localFundsEffect.writtenOffCents, "0");

  const review = await read({ intentRows: [intent({ requires_review: true })] });
  const reviewData = await review.result;
  assert.equal(reviewData.outcome, "REVIEW_REQUIRED");
  assert.equal(reviewData.responsibility.allocatedCents, "10000");
});

test("CONTROLLED与SYNTHETIC来源原样保留，不升级JOINPAY_FORMAL", async () => {
  const controlled = await read({ intentRows: [intent({ payment_source: "CONTROLLED", evidence_level: "CONTROLLED_TEST",
    latest_source: "CONTROLLED", latest_event: "STALE", latest_evidence_level: null })] });
  const controlledData = await controlled.result;
  assert.equal(controlledData.intents[0]!.source, "LOCAL_CONTROLLED");
  assert.equal(controlledData.intents[0]!.evidenceLevel, "CONTROLLED_TEST");
  assert(!JSON.stringify(controlledData.intents[0]).includes("JOINPAY_FORMAL"));

  const synthetic = await read({ intentRows: [intent({ latest_evidence_level: "SYNTHETIC_PROTOCOL" })] });
  const syntheticData = await synthetic.result;
  assert.equal(syntheticData.intents[0]!.latestObservation!.evidenceLevel, "SYNTHETIC_PROTOCOL");
  assert.equal(syntheticData.intents[0]!.source, "JOINPAY_FORMAL");
});

test("截断时不报告完整合计，也不把前50笔当成全部", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => intent({ id: "rfi_" + String(index).padStart(40, "0"),
    amount_cents: "100", refund_order_no: "RF" + String(index).padStart(28, "0") }));
  const { result } = await read({ intentRows: rows });
  const data = await result;
  assert.equal(data.outcome, "TRUNCATED");
  assert.equal(data.intentsTruncated, true);
  assert.equal(data.returnedIntentCount, 50);
  assert.equal(data.coverage.intentsComplete, false);
  assert.equal(data.responsibility.totalsComplete, false);
  assert.equal(data.responsibility.allocatedCents, null);
  assert.equal(data.responsibility.consumedCents, null);
  assert.equal(data.responsibility.releasedCents, null);
  assert.equal(data.responsibility.remainingCents, null);
  assert.equal(data.localFundsEffect.writtenOffCents, null);
  assert(data.reasonCodes.includes("INTENT_LIST_TRUNCATED"));
});

test("存储不一致显式CONFLICT：坏金额/坏币种/超额分摊都不当作零", async () => {
  const badAmount = await read({ intentRows: [intent({ amount_cents: "1.00" })] });
  const badAmountData = await badAmount.result;
  assert.equal(badAmountData.outcome, "CONFLICT");
  assert.equal(badAmountData.intents[0]!.amount, null);
  assert.equal(badAmountData.responsibility.allocatedCents, null);
  assert(badAmountData.reasonCodes.includes("INTENT_AMOUNT_INVALID"));

  const badCurrency = await read({ intentRows: [intent({ currency: "USD" })] });
  const badCurrencyData = await badCurrency.result;
  assert.equal(badCurrencyData.outcome, "CONFLICT");
  assert(badCurrencyData.reasonCodes.includes("INTENT_CURRENCY_NOT_CNY"));

  const mixedObservation = await read({ intentRows: [intent({ payment_source: "CONTROLLED", evidence_level: "CONTROLLED_TEST" })] });
  const mixedObservationData = await mixedObservation.result;
  assert.equal(mixedObservationData.outcome, "CONFLICT");
  assert(mixedObservationData.reasonCodes.includes("REFUND_OBSERVATION_SOURCE_MISMATCH"));

  const over = await read({ intentRows: [intent({ id: "rfi_" + "1".repeat(40), amount_cents: "6000" }),
    intent({ id: "rfi_" + "2".repeat(40), amount_cents: "6000" })] });
  const overData = await over.result;
  assert.equal(overData.outcome, "CONFLICT");
  assert.equal(overData.responsibility.allocatedCents, null);
  assert.equal(overData.responsibility.totalsComplete, false);
  assert.equal(overData.coverage.intentsComplete, false);
  assert(overData.reasonCodes.includes("ALLOCATION_EXCEEDS_RESPONSIBILITY"));
});

test("核销账缺失/不平/错主体都显式CONFLICT，不把本地成功当渠道成功", async () => {
  const missing = await read({ intentRows: [consumed()] });
  const missingData = await missing.result;
  assert.equal(missingData.outcome, "CONFLICT");
  assert.equal(missingData.intents[0]!.localAccounting.writeOff, null);
  assert.equal(missingData.responsibility.consumedCents, null);
  assert(missingData.reasonCodes.includes("LOCAL_WRITE_OFF_UNREADABLE"));

  const mismatch = await read({ intentRows: [consumed()], ledgerRows: [ledger("9999")] });
  const mismatchData = await mismatch.result;
  assert.equal(mismatchData.outcome, "CONFLICT");
  assert(mismatchData.reasonCodes.includes("LOCAL_WRITE_OFF_MISMATCH"));

  const foreign = await read({ intentRows: [consumed()], ledgerRows: [ledger("10000", { subject_user_id: OTHER })] });
  const foreignData = await foreign.result;
  assert.equal(foreignData.outcome, "CONFLICT");
  assert(foreignData.reasonCodes.includes("LOCAL_WRITE_OFF_SUBJECT_MISMATCH"));
});

test("终态证据缺失/状态与预算不符不伪造成功", async () => {
  const missing = await read({ intentRows: [consumed({ terminal_evidence_id: null })] });
  const missingData = await missing.result;
  assert.equal(missingData.outcome, "CONFLICT");
  assert.equal(missingData.intents[0]!.savedChannelEvidence, null);
  assert(missingData.reasonCodes.includes("TERMINAL_EVIDENCE_MISSING"));

  const wrongBudget = await read({ intentRows: [consumed({ budget_disposition: "ALLOCATED" })] });
  const wrongBudgetData = await wrongBudget.result;
  assert.equal(wrongBudgetData.outcome, "CONFLICT");
  assert(wrongBudgetData.reasonCodes.includes("SUCCEEDED_WITHOUT_CONSUMED_BUDGET"));

  const controlledTerminal = await read({ intentRows: [consumed({ payment_source: "CONTROLLED", evidence_level: "CONTROLLED_TEST" })] });
  const controlledTerminalData = await controlledTerminal.result;
  assert.equal(controlledTerminalData.outcome, "CONFLICT");
  assert(controlledTerminalData.reasonCodes.includes("TERMINAL_EVIDENCE_OUTSIDE_JOINPAY"));
});

test("渠道处理中与零责任上的分摊是显式结果", async () => {
  const processing = await read({ intentRows: [intent({ state: "SUBMITTING" })] });
  assert.equal((await processing.result).outcome, "PROCESSING");

  const zeroConflict = await read({ orderRows: [order({ refund_cents: "0" })], intentRows: [intent({ amount_cents: "1" })] });
  const zeroConflictData = await zeroConflict.result;
  assert.equal(zeroConflictData.outcome, "CONFLICT");
  assert(zeroConflictData.reasonCodes.includes("ALLOCATION_EXCEEDS_RESPONSIBILITY"));
});

test("异常订单状态/多过账/非法ID显式失败", async () => {
  const unknown = await read({ orderRows: [order({ status: "FUTURE_STATE" })] });
  assert.equal((await unknown.result).outcome, "CONFLICT");
  assert((await unknown.result).reasonCodes.includes("UNRECOGNIZED_ORDER_STATUS"));

  const completedWithoutPosting = await read({ orderRows: [order({ posting_id: null, posting_currency: null, refund_cents: null, due_at: null })] });
  const completedWithoutPostingData = await completedWithoutPosting.result;
  assert.equal(completedWithoutPostingData.outcome, "CONFLICT");
  assert(completedWithoutPostingData.reasonCodes.includes("COMPLETED_ORDER_WITHOUT_POSTING"));

  const paidWithPosting = await read({ orderRows: [order({ status: "PAID" })] });
  const paidWithPostingData = await paidWithPosting.result;
  assert.equal(paidWithPostingData.outcome, "CONFLICT");
  assert(paidWithPostingData.reasonCodes.includes("POSTING_BEFORE_ORDER_COMPLETION"));

  const multiple = await read({ orderRows: [order({ posting_id: "posting_1" }), order({ posting_id: "posting_2" })] });
  assert.equal((await multiple.result).outcome, "CONFLICT");
  assert((await multiple.result).reasonCodes.includes("MULTIPLE_SETTLEMENT_POSTINGS"));

  const legacy = await read({ orderRows: [] }, "legacy_order_0001");
  await assert.rejects(legacy.result, error => rejectStatus(error, 404));
  assert(!legacy.trace.some(entry => entry.sql.includes("legacy_order")));
});


// C04B-02 abnormal REVIEW_CONFIRMATION local responsibility
const ABN_ROOT = "native_abnormal_refund_liability_" + "d".repeat(40);
const ABN_EVENT = ABN_ROOT + "_recognized";
const ABN_PC = "pc_abn_01";
function abnormalResponsibility(overrides: Record<string, unknown> = {}) {
  return { confirmation_id: ABN_PC, order_id: ORDER, reason_code: "LATE_PAYMENT", original_cents: "5000", currency: "CNY",
    merchant_scope_id: "merchant_1", provider_transaction_id: "trx_abn", merchant_order_no: "ORDER_NO_1",
    joinpay_request_id: "payreq_1", joinpay_evidence_id: "jpe_1", joinpay_anchor_id: "paytrx_1", renter_user_id: USER,
    request_channel: "JOINPAY", request_evidence_level: "JOINPAY_CANDIDATE", request_merchant: "merchant_1",
    request_order_no: "ORDER_NO_1", request_amount_cents: "5000", request_currency: "CNY", wire_merchant_no: "999900000000001",
    formal_admission_ref: "ref_1", anchor_channel: "JOINPAY", anchor_order: ORDER, anchor_request: "payreq_1",
    anchor_merchant: "merchant_1", anchor_trx: "trx_abn", anchor_evidence_level: "JOINPAY_VERIFIED",
    liability_root_id: ABN_ROOT, liability_root_kind: "NATIVE_ABNORMAL_REFUND", liability_root_type: "NATIVE",
    liability_root_system: "zzsh", liability_root_entity: "joinpay_abnormal_refund_liability",
    liability_root_source_id: ABN_PC, liability_root_subject: USER, liability_root_role: "RENTER",
    liability_root_digest: "c".repeat(64), liability_root_policy: null, liability_root_basis: null,
    liability_event_id: ABN_EVENT, liability_event_kind: "REFUND_LIABILITY_RECOGNIZED",
    liability_event_root: ABN_ROOT, liability_event_subject: USER, intent_count: 1, submit_attempts: 0,
    blocked_count: 1, blocked_at: PAST, blocked_reason: "ORIGINAL_ORDER_NO_AMBIGUOUS", ...overrides };
}
function abnormalIntent(overrides: Record<string, unknown> = {}) {
  return intent({ posting_id: null, basis_kind: "REVIEW_CONFIRMATION", payment_confirmation_id: ABN_PC,
    liability_root_id: ABN_ROOT, liability_event_id: ABN_EVENT, responsibility_version_hash: "c".repeat(64),
    amount_cents: "5000", due_at: PAST, submit_attempts: 0, blocked_count: 1, blocked_at: PAST,
    blocked_reason: "ORIGINAL_ORDER_NO_AMBIGUOUS", ...overrides });
}
function abnormalLiability(overrides: Record<string, unknown> = {}) {
  return { event_id: ABN_EVENT, event_kind: "REFUND_LIABILITY_RECOGNIZED", event_root: ABN_ROOT, event_subject: USER,
    root_id: ABN_ROOT, root_kind: "NATIVE_ABNORMAL_REFUND", root_type: "NATIVE", root_system: "zzsh",
    root_entity: "joinpay_abnormal_refund_liability", root_source_id: ABN_PC, root_subject: USER,
    root_role: "RENTER", root_digest: "c".repeat(64), root_policy: null, root_basis: null,
    line1_debit: "5000", line1_credit: "0", line1_good: "1", line2_debit: "0", line2_credit: "5000",
    line2_good: "1", total_lines: "2", ...overrides };
}

test("C04B-02 CANCELLED+异常责任可见：原款一份、阻断原因/时间/从未派发", async () => {
  const cancelled = order({ status: "CANCELLED", posting_id: null, posting_currency: null, refund_cents: null, due_at: null });
  const { result, trace } = await read({ orderRows: [cancelled], abnormalRows: [abnormalResponsibility()],
    abnormalIntentRows: [abnormalIntent()], liabilityRows: [abnormalLiability()] });
  const data = await result;
  assert.equal(data.status, "AVAILABLE");
  assert.equal(data.outcome, "REVIEW_REQUIRED");
  assert.equal(data.responsibility.state, "NOT_POSTED");
  assert.equal(data.abnormalResponsibilities.length, 1);
  assert.equal(data.abnormalResponsibilities[0]!.originalCents, "5000");
  assert.equal(data.abnormalResponsibilities[0]!.allocatedCents, "5000");
  assert.equal(data.abnormalResponsibilities[0]!.remainingCents, "0");
  assert.equal(data.abnormalResponsibilities[0]!.firstSubmit!.dispatch, "NEVER_DISPATCHED");
  assert.equal(data.abnormalResponsibilities[0]!.firstSubmit!.blockedReason, "ORIGINAL_ORDER_NO_AMBIGUOUS");
  assert.equal(data.abnormalResponsibilities[0]!.firstSubmit!.blockedAt, PAST);
  assert.equal(data.intents.length, 1);
  assert.equal(data.intents[0]!.basisKind, "REVIEW_CONFIRMATION");
  assert.equal(data.intents[0]!.firstSubmit!.blockedAuditCount, 1);
  assert.equal(data.responsibilityTotals.originalCents, "5000");
  assert.equal(data.responsibilityTotals.totalsComplete, true);
  assert.equal(data.localFundsEffect.writtenOffCents, "0");
  assert.equal(data.actualChannelRefund.bankArrival, "UNKNOWN");
  assert.equal(data.intents[0]!.channelFacts.bankArrival, "UNKNOWN");
  assert.equal(helperSql(trace).some(entry => /INSERT|UPDATE |DELETE|FOR UPDATE|pg_advisory/.test(entry.sql)), false);
});

test("C04B-02 释放后新key只一份责任：allocated/released分列，不把两笔金额相加", async () => {
  const released = abnormalIntent({ id: "rfi_released", state: "FAILED", budget_disposition: "RELEASED",
    terminal_evidence_id: EVIDENCE_ID, terminal_root_id: null, terminal_event_id: null,
    evidence_terminal: "FAILED_NO_EXECUTION", provider_refund_trx_no: null, completed_at: null,
    evidence_trx_no: null, evidence_completed_at: null, terminal_evidence_level: "PROVIDER_RESPONSE",
    blocked_at: null, blocked_count: 0, blocked_reason: null,
    submit_attempts: 1, created_at: "2026-10-26T11:00:00.000000Z", updated_at: "2026-10-26T11:30:00.000000Z" });
  const active = abnormalIntent({ id: "rfi_active", created_at: "2026-10-26T12:00:00.000000Z", updated_at: "2026-10-26T12:00:00.000000Z" });
  const responsibility = abnormalResponsibility({ intent_count: 2, submit_attempts: 1, blocked_count: 0, blocked_at: null, blocked_reason: null });
  const { result } = await read({ orderRows: [order({ status: "CANCELLED", posting_id: null, posting_currency: null, refund_cents: null, due_at: null })],
    abnormalRows: [responsibility], abnormalIntentRows: [released, active], liabilityRows: [abnormalLiability()] });
  const data = await result;
  assert.equal(data.abnormalResponsibilities.length, 1);
  assert.equal(data.abnormalResponsibilities[0]!.originalCents, "5000");
  assert.equal(data.abnormalResponsibilities[0]!.allocatedCents, "5000");
  assert.equal(data.abnormalResponsibilities[0]!.releasedCents, "5000");
  assert.equal(data.abnormalResponsibilities[0]!.remainingCents, "0");
  assert.equal(data.responsibilityTotals.originalCents, "5000");
  assert.equal(data.intents.length, 2);
});

test("C04B-02 异常核销只认未分配收款负债两条分录，仍不推断渠道/银行成功", async () => {
  const consumed = abnormalIntent({ state: "SUCCEEDED", budget_disposition: "CONSUMED", terminal_evidence_id: EVIDENCE_ID,
    terminal_root_id: ROOT_ID, terminal_event_id: EVENT_ID, provider_refund_trx_no: "CHTRX001",
    completed_at: "2026-10-26T12:00:00.000000Z", evidence_terminal: "SUCCEEDED", evidence_trx_no: "CHTRX001",
    evidence_completed_at: "2026-10-26T12:00:00.000000Z", terminal_evidence_level: "PROVIDER_RESPONSE",
    latest_event: "TERMINAL", submit_attempts: 1, blocked_count: 0, blocked_at: null, blocked_reason: null });
  const ledgerRow = ledger("5000", { root_source_id: consumed.id, unallocated_debit: "0", unallocated_credit: "5000", unallocated_lines: "1" });
  const { result } = await read({ orderRows: [order({ status: "CANCELLED", posting_id: null, posting_currency: null, refund_cents: null, due_at: null })],
    abnormalRows: [abnormalResponsibility()], abnormalIntentRows: [consumed], liabilityRows: [abnormalLiability()], ledgerRows: [ledgerRow] });
  const data = await result;
  assert.equal(data.outcome, "FULLY_CONSUMED");
  assert.equal(data.abnormalResponsibilities[0]!.consumedCents, "5000");
  assert.equal(data.intents[0]!.localAccounting.writeOff!.amountCents, "5000");
  assert.equal(data.intents[0]!.savedChannelEvidence!.trust, "SAVED_EVIDENCE_NOT_REVALIDATED");
  assert.equal(data.actualChannelRefund.amountCents, null);
  assert.equal(data.localFundsEffect.bankArrival, "UNKNOWN");
});

test("C04B-02 异常坏根/多分录/错绑进入CONFLICT，合计不伪报", async () => {
  const { result } = await read({ orderRows: [order({ status: "CANCELLED", posting_id: null, posting_currency: null, refund_cents: null, due_at: null })],
    abnormalRows: [abnormalResponsibility()], abnormalIntentRows: [abnormalIntent()],
    liabilityRows: [abnormalLiability({ line2_good: "0", total_lines: "3" })] });
  const data = await result;
  assert.equal(data.outcome, "CONFLICT");
  assert.ok(data.reasonCodes.includes("ABNORMAL_LIABILITY_MISMATCH"));
  assert.equal(data.responsibilityTotals.totalsComplete, false);
  assert.equal(data.responsibilityTotals.originalCents, null);
  assert.equal(data.abnormalResponsibilities[0]!.totalsComplete, false);
});

test("C04B-02 正常POSTING与异常责任同单并列，金额按各自责任计一次", async () => {
  const normal = intent();
  const { result } = await read({ abnormalRows: [abnormalResponsibility({ blocked_count: 0, blocked_at: null, blocked_reason: null })],
    abnormalIntentRows: [abnormalIntent({ blocked_count: 0, blocked_at: null, blocked_reason: null })],
    liabilityRows: [abnormalLiability()], intentRows: [normal] });
  const data = await result;
  assert.equal(data.status, "AVAILABLE");
  assert.equal(data.responsibility.state, "POSTED");
  assert.equal(data.abnormalResponsibilities.length, 1);
  assert.equal(data.intents.length, 2);
  assert.equal(data.responsibilityTotals.originalCents, "15000");
  assert.equal(data.responsibilityTotals.postingOriginalCents, "10000");
  assert.equal(data.responsibilityTotals.abnormalOriginalCents, "5000");
  assert.equal(data.outcome, "FULLY_ALLOCATED");
});


test("C04B-02 异常跨用户意图不进入金额/意图列表，显式CONFLICT", async () => {
  const foreign = abnormalIntent({ renter_user_id: OTHER, amount_cents: "54321" });
  const { result } = await read({ orderRows: [order({ status: "CANCELLED", posting_id: null, posting_currency: null, refund_cents: null, due_at: null })],
    abnormalRows: [abnormalResponsibility()], abnormalIntentRows: [foreign], liabilityRows: [abnormalLiability()] });
  const data = await result;
  assert.equal(data.outcome, "CONFLICT");
  assert.equal(data.intents.length, 0);
  assert.equal(data.abnormalResponsibilities[0]!.intentIds.length, 0);
  assert.equal(data.responsibilityTotals.totalsComplete, false);
  assert(!JSON.stringify(data).includes("54321"));
});

test("C04B-02 异常责任超过50条显式TRUNCATED，不报告完整合计", async () => {
  const rows = Array.from({ length: 51 }, (_, index) => abnormalResponsibility({
    confirmation_id: "pc_abn_" + String(index).padStart(3, "0"), liability_root_id: null,
    liability_event_id: null, intent_count: 0, submit_attempts: 0, blocked_count: 0,
    blocked_at: null, blocked_reason: null }));
  const { result } = await read({ orderRows: [order({ status: "CANCELLED", posting_id: null, posting_currency: null, refund_cents: null, due_at: null })],
    abnormalRows: rows, abnormalIntentRows: [], liabilityRows: [] });
  const data = await result;
  assert.equal(data.outcome, "TRUNCATED");
  assert.equal(data.responsibilitiesTruncated, true);
  assert.equal(data.responsibilityTotals.totalsComplete, false);
  assert.equal(data.responsibilityTotals.originalCents, null);
  assert.equal(data.intents.length, 0);
});

// Master independent regression probes; SYNTHETIC_READER_COMPONENT only.
const masterOrder = () => order({status:"CANCELLED",posting_id:null,posting_currency:null,refund_cents:null,due_at:null});
const masterState = () => ({orderRows:[masterOrder()],abnormalRows:[abnormalResponsibility()],abnormalIntentRows:[abnormalIntent()],liabilityRows:[abnormalLiability()]});
test("Master: PAID without posting retains established abnormal liability",async()=>{
 const state=masterState();state.orderRows=[order({status:"PAID",posting_id:null,posting_currency:null,refund_cents:null,due_at:null})];
 const data=await read(state).result;
 assert.equal(data.abnormalResponsibilities.length,1);
 assert.equal(data.responsibilityTotals.originalCents,"5000");
 assert.equal(data.outcome,"REVIEW_REQUIRED");
});
test("Master: combined partial allocation is not FULLY_ALLOCATED",async()=>{
 const data=await read({intentRows:[intent({amount_cents:"3000"})],
 abnormalRows:[abnormalResponsibility({blocked_count:0,blocked_at:null,blocked_reason:null})],
 abnormalIntentRows:[abnormalIntent({blocked_count:0,blocked_at:null,blocked_reason:null})],
 liabilityRows:[abnormalLiability()]}).result;
 assert.equal(data.responsibilityTotals.originalCents,"15000");
 assert.equal(data.responsibilityTotals.allocatedCents,"8000");
 assert.equal(data.outcome,"PARTIALLY_ALLOCATED");
});
test("Master: invalid terminal ledger also invalidates its per-receipt totals",async()=>{
 const current=abnormalIntent({state:"SUCCEEDED",budget_disposition:"CONSUMED",terminal_evidence_id:EVIDENCE_ID,
 terminal_root_id:ROOT_ID,terminal_event_id:EVENT_ID,provider_refund_trx_no:"CHTRX001",completed_at:"2026-10-26T12:00:00.000000Z",
 evidence_terminal:"SUCCEEDED",evidence_trx_no:"CHTRX001",evidence_completed_at:"2026-10-26T12:00:00.000000Z",
 terminal_evidence_level:"PROVIDER_RESPONSE",submit_attempts:1,blocked_count:0,blocked_at:null,blocked_reason:null});
 const data=await read({...masterState(),abnormalIntentRows:[current],ledgerRows:[]}).result;
 assert.equal(data.outcome,"CONFLICT");
 assert.equal(data.abnormalResponsibilities[0]!.totalsComplete,false);
 assert.equal(data.abnormalResponsibilities[0]!.state,"CONFLICT");
 assert.equal(data.abnormalResponsibilities[0]!.consumedCents,null);
});
test("Master: intent liability IDs must match the established receipt liability",async()=>{
 const data=await read({...masterState(),abnormalIntentRows:[abnormalIntent({liability_root_id:"other_root",liability_event_id:"other_event"})]}).result;
 assert.equal(data.outcome,"CONFLICT");
 assert.equal(data.responsibilityTotals.totalsComplete,false);
});
test("Master: mixed 50 normal plus one abnormal intent does not claim complete totals",async()=>{
 const normal=Array.from({length:50},(_,i)=>intent({id:"rfi_normal_"+i,amount_cents:"100"}));
 const data=await read({intentRows:normal,abnormalRows:[abnormalResponsibility({blocked_count:0,blocked_at:null,blocked_reason:null})],
 abnormalIntentRows:[abnormalIntent({blocked_count:0,blocked_at:null,blocked_reason:null})],liabilityRows:[abnormalLiability()]}).result;
 assert.equal(data.intents.length,50);assert.equal(data.intentsTruncated,true);
 assert.equal(data.responsibilityTotals.totalsComplete,false);
 assert.equal(data.responsibilityTotals.originalCents,null);
 assert.equal(data.localFundsEffect.writtenOffCents,null);
});
test("Master: unmatched established abnormal intent cannot disappear as no responsibility",async()=>{
 const data=await read({...masterState(),abnormalRows:[]}).result;
 assert.equal(data.outcome,"CONFLICT");
 assert.equal(data.responsibilityTotals.totalsComplete,false);
});
test("Master: malformed abnormal intent cannot retain a complete per-receipt budget",async()=>{
 const data=await read({...masterState(),abnormalIntentRows:[abnormalIntent({currency:"USD"})]}).result;
 assert.equal(data.outcome,"CONFLICT");
 assert.equal(data.abnormalResponsibilities[0]!.totalsComplete,false);
 assert.equal(data.abnormalResponsibilities[0]!.allocatedCents,null);
});

test("Master R1: preflight checks the anchor evidence column actually read by SQL",async()=>{
 const probe=await read({});
 await probe.result;
 const checked=JSON.parse(probe.trace.find(q=>q.sql.startsWith("WITH req AS"))!.values[0] as string) as {table:string;columns:string[]}[];
 assert(checked.find(q=>q.table==="zzsh_order.payment_channel_transaction")!.columns.includes("evidence_level"));
});
