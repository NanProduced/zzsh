import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdminFinanceFilters, resolveFinanceLookup, projectAdminFinanceLedger, projectAdminFinanceObservation, financeDocuments, financeOrderDocuments, readAdminFinanceDocument, financePeriodProjection, filterAdminFinanceEntries, financeSnapshot, type FinanceFacts } from "../src/finance/admin-finance-read";
import { generateAdminFinanceCsv } from "../src/finance/admin-finance-export";
import { matchFinanceOrderReference, type FinanceOrderFact } from "../src/finance/admin-finance-order-read";
import { loadAdminFinanceFacts } from "../src/finance/admin-finance-read";
import type { PoolClient } from "pg";

const filters = parseAdminFinanceFilters(new URLSearchParams("from=2026-10-03&to=2026-10-03"));
const line = (overrides: Record<string, unknown> = {}) => projectAdminFinanceLedger({ id: "a", account_code: "WALLET_AVAILABLE", subject_id: "u1", subject_name: "同昵称", delta: "-20000", at: "2026-10-03T00:00:00.000000Z", source_entity: "withdrawal_intent", source_id: "w1", event_kind: "RESERVE", ...overrides });
const facts = (): FinanceFacts => ({ entries: [line()], subjects: [{ id: "u1", name: "同昵称" }], revisions: [], withdrawalsReady: true, asOf: "2026-10-03T10:00:00.000000Z", version: "a".repeat(64) });
const actor = { userId: "admin1", sessionId: "session1", authorizationKey: "access1" }, key = { keyId: "read1", secret: "x".repeat(64) };

for (const disposition of ["PAYOUT_POSTED", "RELEASE_POSTED", "RESERVED"] as const) test(`C1 ${disposition}: late conflict preserves original disposition across document, period and CSV`, async () => {
  const paid = disposition === "PAYOUT_POSTED", released = disposition === "RELEASE_POSTED";
  const rows = [
    { id: "reserve-out", account_code: "WALLET_AVAILABLE", delta: "-200", event_kind: "RESERVE" },
    { id: "reserve-in", account_code: "WALLET_RESERVED", delta: "200", event_kind: "RESERVE" },
    ...(paid ? [{ id: "payout-out", account_code: "WALLET_RESERVED", delta: "-200", event_kind: "PAYOUT" }, { id: "payout-net", account_code: "PAYOUT_CLEARING", delta: "196", event_kind: "PAYOUT" }, { id: "fee", account_code: "WITHDRAW_FEE", delta: "4", event_kind: "PAYOUT" }] : released ? [{ id: "release-out", account_code: "WALLET_RESERVED", delta: "-200", event_kind: "RELEASE" }, { id: "release-in", account_code: "WALLET_AVAILABLE", delta: "200", event_kind: "RELEASE" }] : []),
  ].map(row => ({ ...row, subject_id: ["PAYOUT_CLEARING", "WITHDRAW_FEE"].includes(row.account_code) ? null : "u1", subject_name: "test user", at: facts().asOf, source_entity: "withdrawal_intent", source_id: "w1", source_digest: "d".repeat(64) }));
  const terminal = paid ? "SUCCEEDED" : released ? "FAILED" : null;
  const calls: string[] = [];
  const client = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith("SELECT to_regclass")) return { rows: [{ ready: true, withdrawals: true }] };
    if (sql.startsWith("SELECT md5")) return { rows: [{ finance_version: "conflict-version" }] };
    if (sql.includes("clock_timestamp()")) return { rows: [{ at: facts().asOf }] };
    if (sql.startsWith("WITH finance_scoped_rows")) return { rows: sql.includes("settlement_ledger_entry") ? rows : [] };
    if (sql.startsWith("SELECT id,COALESCE(name")) return { rows: [{ id: "u1", name: "test user" }] };
    if (sql.startsWith("SELECT i.id")) return { rows: [{ id: "w1", state: "RECONCILIATION_REQUIRED", funds_disposition: disposition, gross_cents: "200", net_cents: "196", fee_cents: "4", operation_version: "15", terminal_state: terminal, terminal_reference: terminal ? "original-receipt" : null }] };
    if (sql.startsWith("SELECT id,intent_id")) return { rows: terminal ? [{ id: "original-operation", intent_id: "w1", outcome: terminal, reference: "original-receipt" }] : [] };
    throw Error("Unexpected integration SQL: " + sql);
  } } as unknown as PoolClient;
  const loaded = await loadAdminFinanceFacts(client, { documentRef: "WITHDRAWAL:w1" });
  const detail = readAdminFinanceDocument(loaded, "WITHDRAWAL:w1");
  assert.equal(detail.document.state, "RECONCILIATION_REQUIRED");
  assert.equal(detail.evidence.fundsDisposition, disposition);
  assert.equal(detail.evidence.channelState, terminal);
  assert.equal(detail.evidence.channelReference, terminal ? "original-receipt" : null);
  assert.equal(loaded.entries.reduce((sum, entry) => sum + BigInt(entry.deltaCents!), 0n), 0n);
  const period = financePeriodProjection(loaded.entries), available = period.find(row => row.bucket === "AVAILABLE")!, reserved = period.find(row => row.bucket === "RESERVED")!;
  assert.equal(available.knownOutflows, "200"); assert.equal(available.knownInflows, released ? "200" : "0");
  assert.equal(reserved.knownInflows, "200"); assert.equal(reserved.knownOutflows, terminal ? "200" : "0");
  assert.equal(period.find(row => row.bucket === "REFUND_PAYABLE")!.knownInflows, "0");
  assert.ok(period.every(row => row.knowledge === "UNKNOWN" && row.openingBalance === null && row.closingBalance === null));
  const selected = filterAdminFinanceEntries(loaded, { ...filters, state: "RECONCILIATION_REQUIRED", period: false }, false);
  assert.equal(selected.length, rows.length);
  const csv = generateAdminFinanceCsv(selected, filters, loaded.asOf, loaded.version);
  assert.equal(csv.rowCount, rows.length); assert.equal(csv.bytes.toString().split('"RECONCILIATION_REQUIRED"').length - 1, rows.length);
  assert.ok(calls.every(sql => !/\b(?:INSERT|UPDATE|DELETE)\b/.test(sql)), "projection cannot write funds or audit");
});

test("Beijing half-open period validates calendars, duplicates and explicit lookup mode", () => {
  for (const q of ["from=2026-02-30", "from=2027-01-01&to=2026-01-01", "scope=x&scope=y", "limit=20", "from=2024-01-01&to=2026-01-01", "period=0"]) assert.throws(() => parseAdminFinanceFilters(new URLSearchParams(q)), (error: any) => error.status === 400);
  assert.equal(parseAdminFinanceFilters(new URLSearchParams(), new Date("2026-10-03T17:00Z")).from, "2026-10-04");
  assert.equal(parseAdminFinanceFilters(new URLSearchParams("q=同昵称"), new Date(), false).period, false);
  const rows = [line({ id: "before", at: "2026-10-02T15:59:59.999999Z" }), line({ id: "start", at: "2026-10-02T16:00:00.000000Z" }), line({ id: "end", at: "2026-10-03T16:00:00.000000Z" }), line({ id: "unknown", at: null })];
  assert.deepEqual(filterAdminFinanceEntries({ ...facts(), entries: rows }, filters, true).map(row => row.id), ["ledger:start", "ledger:unknown"]);
});
test("station links only parse known paths without network access or source-type loss", () => {
  assert.equal(resolveFinanceLookup("http://localhost:4241/finance/documents/ORDER%3Aorder1", ["http://localhost:4241"]), "ORDER:order1");
  for (const q of ["https://evil.test/orders/x", "http://localhost:4241/orders/x?token=secret", "http://user:pass@localhost:4241/users/u", "http://localhost:4241/unknown/u"]) assert.throws(() => resolveFinanceLookup(q, ["http://localhost:4241"]));
  assert.equal(resolveFinanceLookup("WITHDRAWAL:w1", []), "WITHDRAWAL:w1");
  assert.equal(resolveFinanceLookup("http://localhost:4241/orders/order1", ["http://localhost:4241"]), "ORDER_LINK:order1");
});
test("refund liability is recorded without inventing channel paid zero or wallet income", () => {
  const refund = line({ account_code: "RENTER_REFUND_PAYABLE", source_entity: null, source_id: null, order_id: "o1", posting_id: "p1", delta: "21000", renter_refund_cents: "21000" });
  assert.equal(refund.kind, "REFUND"); assert.equal(refund.state, "REFUND_PAYABLE_RECORDED"); assert.equal(refund.bucket, "REFUND_PAYABLE"); assert.equal(refund.evidence.refundPaidCents, null); assert.equal(refund.evidence.refundPayableCents, "21000");
});
test("signed old net/fee/balance fields remain source facts, not current balance", () => {
  const old = projectAdminFinanceObservation({ id: "h1", source_entity: "la_withdraw_apply", source_id: "42", source_type: "LEGACY_MYSQL", source_system: "legacy_mysql_restore", subject_id: "u1", subject_name: "用户一", amount: "10.00", net: "-1.00", fee: "11.00", balance_after: "-2.00", included_in_opening: true, at: null, imported_at: "2026-10-03T10:00:00Z" });
  assert.equal(old.evidence.originalNetCents, "-100"); assert.equal(old.evidence.historicalBalanceAfterCents, "-200"); assert.equal(old.affectsCurrentLedger, false); assert.equal(old.affectsCurrentWallet, false);
});
test("old order links require exact source tuple, keep duplicate numbers separate and never invent posting", () => {
  const original: FinanceOrderFact = { ref: "LEGACY_ORDER:order1", id: "order1", number: "SN1", sourceType: "LEGACY_MYSQL", sourceSystem: "legacy_mysql_restore", sourceId: "42", sourceDigest: "a".repeat(64), kind: "SETTLEMENT", state: "HISTORICAL_ORDER_RECORDED", occurredAt: "2026-10-03T00:00:00Z", importedAt: "2026-10-03T10:00:00Z", ownerId: "u1", renterId: "u2", accountId: "account1", dueCents: "1000", recordedPaidCents: "1000", depositCents: "0", originalOrderStatus: "4", originalPaymentStatus: "1" };
  const other = { ...original, ref: "LEGACY_ORDER:order2", id: "order2", sourceId: "43" };
  assert.equal(matchFinanceOrderReference({ sourceSystem: "other-source", evidence: { originalReference: "42", originalNumber: "SN1" } }, [original]).length, 0);
  assert.equal(matchFinanceOrderReference({ sourceSystem: "legacy_mysql_restore", evidence: { originalReference: "42", originalNumber: "SN1" } }, [original, other]).length, 1);
  assert.equal(matchFinanceOrderReference({ sourceSystem: "legacy_mysql_restore", evidence: { originalNumber: "SN1" } }, [original, other]).length, 2);
  const f = { ...facts(), entries: [], orders: [original, other] };
  const documents = financeOrderDocuments(f, { ...filters, q: "ORDER_LINK:order1" }); assert.equal(documents.length, 1); assert.equal(documents[0]!.ref, original.ref);
  const detail = readAdminFinanceDocument(f, original.ref); assert.equal(detail.entries.length, 0); assert.equal(detail.evidence.recordedPaidCents, "1000"); assert.ok(detail.reasonCodes.includes("ORDER_RECORD_NOT_CHANNEL_RESULT")); assert.ok(detail.reasonCodes.includes("ORDER_NO_CURRENT_POSTING"));
});
test("transfer remains one document with exact distinct directions, no cross-bucket net", () => {
  const rows = [line(), line({ id: "b", account_code: "WALLET_RESERVED", delta: "20000" })];
  const documents = financeDocuments(rows); assert.equal(documents.length, 1); assert.equal(documents[0]!.entryCount, 2);
  assert.deepEqual(documents[0]!.amounts.map(row => [row.bucket, row.knownNetCents]), [["AVAILABLE", "-20000"], ["RESERVED", "20000"]]);
  const bad = line({ delta: "NaN" }); assert.equal(bad.deltaCents, null); assert.equal(bad.knowledge, "UNKNOWN");
});
test("covered historical facts never enter current period movement; migration separately counted", () => {
  const historical = projectAdminFinanceObservation({ id: "h1", source_entity: "la_log_earnings", source_id: "12", source_type: "LEGACY_MYSQL", subject_id: "u1", subject_name: "同昵称", amount: "200.00", action: "1", included_in_opening: true, at: "2026-10-03T00:00:00.000000Z", imported_at: "2026-10-03T10:00:00.000000Z" });
  const opening = line({ id: "o", event_kind: "OPENING", basis_id: "basis1", delta: "86000" });
  const projection = financePeriodProjection([historical, opening, line()]).find(row => row.bucket === "AVAILABLE")!;
  assert.equal(historical.affectsCurrentWallet, false); assert.equal(projection.knownInflows, "0"); assert.equal(projection.knownOutflows, "20000"); assert.equal(projection.migrationMovement, "86000"); assert.equal(projection.coveredHistoricalCount, 1);
  assert.equal(projection.openingBalance, null); assert.equal(projection.closingBalance, null); assert.equal(projection.difference, null);
});
test("signed snapshot binds actor/session/access/all filters/global version/expiry and catches added subject", () => {
  const snapshot = financeSnapshot(facts(), filters, actor, key, undefined, 1000).token;
  assert.equal(financeSnapshot(facts(), filters, actor, key, snapshot, 2000).asOf, facts().asOf);
  for (const [f, a, q] of [[{ ...facts(), version: "new-subject-version" }, actor, filters], [facts(), { ...actor, sessionId: "other" }, filters], [facts(), { ...actor, authorizationKey: "denied" }, filters], [facts(), actor, { ...filters, scope: "u2" }]] as const) assert.throws(() => financeSnapshot(f, q, a, key, snapshot, 2000), (error: any) => error.status === 409);
  assert.throws(() => financeSnapshot(facts(), filters, actor, key, snapshot, 601000), (error: any) => error.status === 409);
  assert.throws(() => financeSnapshot(facts(), filters, actor, key, snapshot.slice(0, -1) + "!", 2000), (error: any) => error.status === 400);
  assert.throws(() => financeSnapshot(facts(), filters, actor, undefined), (error: any) => error.status === 503);
});
test("CSV is all matching rows, exact integer columns, unknown blank and text formula-safe", () => {
  const known = line({ delta: "-900719925474099312345", subject_name: ' =HYPERLINK("x,y")\nnext' }), unknown = line({ id: "unknown", delta: "bad" });
  const csv = generateAdminFinanceCsv([known, unknown], filters, facts().asOf, facts().version);
  const text = csv.bytes.toString("utf8"); assert.equal(csv.rowCount, 2); assert.match(text, /"-900719925474099312345"/); assert.match(text, /"","UNKNOWN"/); assert.match(text, /' =HYPERLINK\(""x,y""\)/); assert.match(text, /\nnext/); assert.equal(csv.sha256.length, 64);
  assert.throws(() => generateAdminFinanceCsv([{ ...known, deltaCents: "=1+1" }], filters, facts().asOf, facts().version));
  assert.equal(line({ delta: "0" }).deltaCents, "0");
});
