import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { readAdminFinanceObligationQueues } from "../src/finance/admin-finance-obligation-queues";

const asOf = "2026-11-02T04:00:00.000000Z";
const item = (overrides: Record<string, unknown> = {}) => ({ id: "POSTING:p1", number: "ZZ-TEST-1", source: "POSTING", status: "NO_INTENT", amountCents: "900",
  recordedAmountCents: "900", dueAt: "2026-11-01T04:00:00.000000Z", overdue: true, documentRef: "ORDER:o1",
  reasonCodes: ["NO_LOCAL_INTENT_DOES_NOT_PROVE_NO_BANK_REFUND"], ...overrides });
const empty = (refund: boolean) => ({ count: "0", amount: "0", unknown_count: "0", overdue_count: refund ? "0" : null,
  overdue_amount: refund ? "0" : null, unknown_due_count: "0", items: [], sources: [] });
function fixture(options: { refunds?: Record<string, unknown>; withdrawals?: Record<string, unknown>; ready?: { refunds: boolean; withdrawals: boolean } } = {}) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = { query: async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("effective schema and ACL")) return { rows: [options.ready ?? { refunds: true, withdrawals: true }] };
    if (sql.includes("refund responsibilities")) return { rows: [options.refunds ?? empty(true)] };
    if (sql.includes("withdrawal original reserve")) return { rows: [options.withdrawals ?? empty(false)] };
    throw new Error("Unexpected obligation queue query");
  } } as unknown as PoolClient;
  return { client, calls };
}

test("a proved empty queue is zero; an unreadable source is unavailable, never zero", async () => {
  const f = fixture({ ready: { refunds: false, withdrawals: true } }), q = await readAdminFinanceObligationQueues(f.client, asOf, true);
  assert.equal(q.refunds.knowledge, "UNAVAILABLE"); assert.equal(q.refunds.count, null); assert.equal(q.refunds.amountCents, null);
  assert.equal(q.withdrawals.knowledge, "KNOWN"); assert.equal(q.withdrawals.count, "0"); assert.equal(q.withdrawals.amountCents, "0");
  assert.equal(f.calls.length, 2); assert.ok(!f.calls.some(c => c.sql.includes("refund responsibilities")));
});

test("no-intent responsibility stays in the queue and carries no bank-result claim", async () => {
  const f = fixture({ refunds: { ...empty(true), count: "1", amount: "900", overdue_count: "1", overdue_amount: "900", items: [item()],
    sources: [{ source: "POSTING", count: "1", unknownCount: "0", amountCents: "900" }] } });
  const q = await readAdminFinanceObligationQueues(f.client, asOf, true);
  assert.equal(q.refunds.amountCents, "900"); assert.equal(q.refunds.overdueAmountCents, "900"); assert.equal(q.refunds.items[0]?.status, "NO_INTENT");
  assert.equal(q.refunds.items[0]?.bankArrival, "UNKNOWN"); assert.equal(q.refunds.items[0]?.documentRef, "ORDER:o1");
  assert.equal(q.refunds.items[0]?.number, "ZZ-TEST-1");
  assert.ok(q.refunds.items[0]?.reasonCodes.includes("NO_LOCAL_INTENT_DOES_NOT_PROVE_NO_BANK_REFUND"));
  assert.deepEqual(f.calls[1]?.values, [asOf]);
});

test("known subtotal survives unknown legacy duties and broken terminal roots", async () => {
  const f = fixture({ refunds: { ...empty(true), count: "3", amount: "900", unknown_count: "2", overdue_count: "1", overdue_amount: "900", unknown_due_count: "2",
    items: [item(), item({ id: "LEGACY_DUTY:d1", source: "LEGACY_DUTY", amountCents: null, recordedAmountCents: "2500", dueAt: null,
      overdue: null, documentRef: "LEGACY_ORDER:old1" })], sources: [
      { source: "POSTING", count: "2", unknownCount: "1", amountCents: "900" },
      { source: "LEGACY_DUTY", count: "1", unknownCount: "1", amountCents: "0" },
    ] } });
  const q = await readAdminFinanceObligationQueues(f.client, asOf, true);
  assert.equal(q.refunds.knowledge, "PARTIAL"); assert.equal(q.refunds.amountCents, "900"); assert.equal(q.refunds.unknownCount, "2");
  assert.equal(q.refunds.hasMore, true); assert.equal(q.refunds.items[1]?.amountCents, null); assert.equal(q.refunds.items[1]?.recordedAmountCents, "2500");
  assert.ok(q.refunds.reasonCodes.includes("OVERDUE_COVERAGE_INCOMPLETE"));
});

test("LOCAL_CONTROLLED and formal original reservations stay separate and have no invented due date", async () => {
  const f = fixture({ withdrawals: { ...empty(false), count: "2", amount: "1800", unknown_due_count: "2", items: [
    item({ id: "WITHDRAWAL:w1", source: "LOCAL_CONTROLLED", status: "UNKNOWN", amountCents: "900", dueAt: null, overdue: null, documentRef: "WITHDRAWAL:w1" }),
    item({ id: "JOINPAY_WITHDRAWAL:jwd_a", source: "JOINPAY_FORMAL", status: "PROCESSING", amountCents: "900", dueAt: null, overdue: null, documentRef: "JOINPAY_WITHDRAWAL:jwd_a" }),
  ], sources: [{ source: "LOCAL_CONTROLLED", count: "1", unknownCount: "0", amountCents: "900" }, { source: "JOINPAY_FORMAL", count: "1", unknownCount: "0", amountCents: "900" }] } });
  const q = await readAdminFinanceObligationQueues(f.client, asOf, false);
  assert.equal(q.withdrawals.amountCents, "1800"); assert.equal(q.withdrawals.overdueCount, null); assert.equal(q.withdrawals.overdueAmountCents, null);
  assert.equal(q.withdrawals.sources.length, 2); assert.ok(q.withdrawals.items.every(i => i.documentRef === null));
  assert.equal(q.withdrawals.bankArrival, "UNKNOWN");
});

test("even a FINANCE-labeled legacy source amount stays unknown until the original canonical verifier runs", async () => {
  const f = fixture({ refunds: { ...empty(true), count: "1", amount: "0", unknown_count: "1", unknown_due_count: "1",
    items: [item({ id: "LEGACY_DUTY:d1", number: "OLD-TEST-1", source: "LEGACY_DUTY", status: "SOURCE_RESPONSIBILITY_REVIEW",
      amountCents: null, recordedAmountCents: "2500", dueAt: null, overdue: null, documentRef: "LEGACY_ORDER:old1",
      reasonCodes: ["LEGACY_FINAL_CANONICAL_NOT_REVALIDATED", "RECORDED_AMOUNT_IS_NOT_CURRENT_PAYABLE_PROOF"] })],
    sources: [{ source: "LEGACY_DUTY", count: "1", unknownCount: "1", amountCents: "0" }] } });
  const q = await readAdminFinanceObligationQueues(f.client, asOf, true);
  assert.equal(q.refunds.knowledge, "PARTIAL"); assert.equal(q.refunds.amountCents, "0"); assert.equal(q.refunds.unknownCount, "1");
  assert.equal(q.refunds.items[0]?.recordedAmountCents, "2500"); assert.equal(q.refunds.items[0]?.amountCents, null);
  assert.ok(q.refunds.items[0]?.reasonCodes.includes("LEGACY_FINAL_CANONICAL_NOT_REVALIDATED"));
});

test("document authorization gates all four existing reference types", async () => {
  for (const ref of ["ORDER:o1", "LEGACY_ORDER:old1", "WITHDRAWAL:w1", "JOINPAY_WITHDRAWAL:jwd_a"]) {
    const f = fixture({ refunds: { ...empty(true), count: "1", amount: "900", items: [item({ documentRef: ref })],
      sources: [{ source: "POSTING", count: "1", unknownCount: "0", amountCents: "900" }] } });
    const q = await readAdminFinanceObligationQueues(f.client, asOf, false);
    assert.equal(q.refunds.items[0]?.documentRef, null);
  }
});

test("aggregates reject rounded money, wrong totals, foreign refs and unbounded previews", async () => {
  const good = { ...empty(true), count: "1", amount: "900", items: [item()], sources: [{ source: "POSTING", count: "1", unknownCount: "0", amountCents: "900" }] };
  for (const broken of [ { ...good, amount: "9.00" }, { ...good, unknown_count: "2" }, { ...good, overdue_count: "2" },
    { ...good, sources: [] }, { ...good, items: [item({ documentRef: "OPENING:private" })] },
    { ...good, count: "6", items: Array.from({ length: 6 }, () => item()) } ]) {
    await assert.rejects(readAdminFinanceObligationQueues(fixture({ refunds: broken }).client, asOf, true),
      (e: unknown) => (e as { status?: number }).status === 503);
  }
});

test("three set-based SELECTs reuse existing closure functions and original FK bindings", async () => {
  const f = fixture(); await readAdminFinanceObligationQueues(f.client, asOf, true);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) assert.doesNotMatch(call.sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|FOR\s+UPDATE|pg_advisory)\b/i);
  assert.match(f.calls[0]!.sql, /has_table_privilege/); assert.match(f.calls[0]!.sql, /has_function_privilege/); assert.match(f.calls[0]!.sql, /NOT c.relrowsecurity/);
  const refunds = f.calls[1]!.sql, withdrawals = f.calls[2]!.sql;
  for (const source of ["POSTING", "REVIEW_CONFIRMATION", "PRESTART_TERMINATION", "LEGACY_DUTY"]) assert.ok(refunds.includes(source));
  for (const fn of ["native_refund_terminal_complete", "native_abnormal_refund_terminal_complete", "native_prestart_refund_terminal_complete", "prestart_liability_complete"]) assert.ok(refunds.includes(`zzsh_order.${fn}(`));
  assert.match(refunds, /i\.posting_id IS NOT DISTINCT FROM b\.posting_id/); assert.match(refunds, /i\.original_payment_trx_no=b\.trx/);
  assert.match(refunds, /NULL::numeric AS amount/); assert.doesNotMatch(refunds, /BOOK_PAYABLE/);
  assert.match(refunds, /LEGACY_FINAL_CANONICAL_NOT_REVALIDATED/); assert.match(refunds, /CASE WHEN source='LEGACY_DUTY' THEN 1 ELSE 0 END/);
  assert.match(withdrawals, /zzsh_order\.withdrawal_expected_lines\(e\.id\)/); assert.match(withdrawals, /zzsh_order\.joinpay_withdrawal_complete\(id\)/);
  for (const sql of [refunds, withdrawals]) { assert.match(sql, /LIMIT 5/); assert.match(sql, /sum\(amount\)/); }
});

test("invalid clock is rejected before any database work", async () => {
  const f = fixture(); await assert.rejects(readAdminFinanceObligationQueues(f.client, "tomorrow", true)); assert.equal(f.calls.length, 0);
});
