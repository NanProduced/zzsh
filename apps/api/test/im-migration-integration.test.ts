import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const migration = (name: string) => readFileSync(resolve("migrations/business", name), "utf8");
const supportSql = migration("0134_support_cancel.sql");
const openingSql = migration("0137_opening_confirmation.sql");

function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`FUNCTION zzsh_order.${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `unterminated ${name}`);
  return sql.slice(start, end + 3);
}

function assertSupportPrestartGate(sql: string): void {
  const basis = functionSql(sql, "support_cancel_payment_basis_valid");
  assert.match(basis, /AND\s+zzsh_order\.prestart_payment_basis_valid\(b\)/);
  assert.doesNotMatch(basis, /\bOR\s+zzsh_order\.prestart_payment_basis_valid\(b\)/);
}

function backfillSql(sql: string): string {
  const match = /UPDATE\s+"zzsh_order"\."rental_opening"\s+AS\s+opening\s+SET\s+[\s\S]*?;/i.exec(sql);
  assert.ok(match, "missing historical opening backfill");
  return match[0];
}

function assertProtectedOpeningExcluded(sql: string): void {
  const backfill = backfillSql(sql);
  assert.match(backfill, /AND\s+NOT EXISTS\s*\(\s*SELECT 1 FROM "zzsh_order"\."prestart_termination" termination/);
  assert.match(backfill, /termination\."order_id"\s*=\s*opening\."order_id"/);
  assert.match(backfill, /termination\."state"\s*<>\s*'REJECTED'/);
}

test("support full original refund uses the same unstarted basis as both original parties", () => {
  assertSupportPrestartGate(supportSql);
  const original = functionSql(migration("0107_prestart_termination.sql"), "prestart_payment_basis_valid");
  assert.match(original, /x\.status='CONFIRMED'/);
  assert.match(original, /count\(DISTINCT a\.party\)[\s\S]*?=2/);
});

test("removing or turning the shared unstarted gate into an alternative is rejected", () => {
  const gate = "AND zzsh_order.prestart_payment_basis_valid(b)";
  assert.throws(() => assertSupportPrestartGate(supportSql.replace(gate, "AND true")));
  assert.throws(() => assertSupportPrestartGate(supportSql.replace(gate, "OR zzsh_order.prestart_payment_basis_valid(b)")));
});

test("support basis retains original JOINPAY amount and settlement/commission blockers", () => {
  const basis = functionSql(supportSql, "support_cancel_payment_basis_valid");
  assert.match(basis, /c\.source='JOINPAY' AND b->>'source'='JOINPAY'/);
  assert.match(basis, /c\.amount_cents=o\.rental_amount_cents\+o\.deposit_amount_cents/);
  assert.match(basis, /c\.amount_cents::text=b->>'amountCents'/);
  assert.match(basis, /NOT EXISTS\(SELECT 1 FROM zzsh_order\.settlement_posting/);
  assert.match(basis, /NOT EXISTS\(SELECT 1 FROM zzsh_order\.settlement_version/);
  assert.match(basis, /NOT EXISTS\(SELECT 1 FROM zzsh_order\.settlement_intake/);
  assert.match(basis, /e\.amount_cents>0 AND e\.state<>'REVOKED'/);
});

test("request, approval, liability and order closure reuse the same support payment gate", () => {
  for (const name of ["guard_prestart_termination", "prestart_liability_complete", "guard_prestart_liability_root", "guard_prestart_order_cancel"]) {
    assert.match(functionSql(supportSql, name), /zzsh_order\.support_cancel_payment_basis_valid\(/, name);
    assert.match(functionSql(supportSql, name), /zzsh_order\.prestart_payment_basis_valid\(/, name);
  }
});

test("support liability keeps exact original-payment roots, two lines, xid and audit evidence", () => {
  const liability = functionSql(supportSql, "prestart_liability_complete");
  assert.match(liability, /r\.id='prestart_refund_'\|\|substr\(encode\(sha256\(convert_to\(t\.payment_basis->>'paymentConfirmationId'/);
  assert.match(liability, /settlement_ledger_entry l WHERE l\.finance_event_id=e\.id\)=2/);
  assert.match(liability, /l\.line_no=1 AND l\.account_code='CAPTURED_PAYMENT_SOURCE'/);
  assert.match(liability, /l\.line_no=2 AND l\.account_code='RENTER_REFUND_PAYABLE'/);
  assert.match(liability, /d\.created_xid=t\.approved_xid/);
  assert.match(liability, /a\.action=\(CASE WHEN t\.requested_by_party='SUPPORT' THEN 'order\.support_cancel'/);
  assert.match(functionSql(supportSql, "guard_prestart_order_cancel"), /t\.approved_xid=pg_current_xact_id\(\)/);
});

test("historical active termination remains protected and its due fact remains nullable", () => {
  assertProtectedOpeningExcluded(openingSql);
  const original = migration("0107_prestart_termination.sql");
  assert.match(original, /CREATE TRIGGER prestart_opening_guard BEFORE INSERT OR UPDATE/);
  assert.match(original, /state<>'REJECTED'/);
  assert.doesNotMatch(openingSql, /(?:DISABLE|DROP)\s+TRIGGER\s+(?:IF EXISTS\s+)?"?prestart_opening_guard"?/i);
  assert.doesNotMatch(openingSql, /auto_confirm_due_at"?\s+(?:timestamptz\s+)?(?:SET\s+)?NOT NULL/i);
});

test("removing historical termination exclusion or correlating it to another order is rejected", () => {
  assert.throws(() => assertProtectedOpeningExcluded(openingSql.replace("AND NOT EXISTS (", "AND EXISTS (")));
  assert.throws(() => assertProtectedOpeningExcluded(openingSql.replace('termination."order_id" = opening."order_id"', 'termination."order_id" <> opening."order_id"')));
});

test("historical backfill changes only the deterministic due fact on unresolved DRAFT rows", () => {
  const backfill = backfillSql(openingSql);
  const assignments = backfill.split(/\bWHERE\b/i)[0]!.split(/\bSET\b/i)[1]!.trim();
  assert.equal(assignments, '"auto_confirm_due_at" = opening."created_at" + interval \'40 minutes\'');
  assert.match(backfill, /opening\."auto_confirm_due_at" IS NULL AND opening\."status" = 'DRAFT'/);
  assert.doesNotMatch(openingSql, /\b(?:DELETE FROM|TRUNCATE|COMMIT|ROLLBACK)\b/i);
});

test("opening version guard is restored within the same migration sequence", () => {
  const disable = openingSql.indexOf('DISABLE TRIGGER "rental_opening_guard"');
  const update = openingSql.indexOf('UPDATE "zzsh_order"."rental_opening" AS opening');
  const enable = openingSql.indexOf('ENABLE TRIGGER "rental_opening_guard"');
  assert.ok(disable >= 0 && disable < update && update < enable);
  assert.match(openingSql, /BEFORE INSERT ON "zzsh_order"\."rental_opening"/);
  assert.match(openingSql, /NEW\."auto_confirm_due_at" := NEW\."created_at" \+ interval '40 minutes'/);
});

test("unknown historical due values cannot enter the automatic confirmation candidate query", () => {
  const worker = readFileSync(resolve("src/order/opening-auto-confirm.ts"), "utf8");
  assert.match(worker, /op\.auto_confirm_due_at <= clock_timestamp\(\)/);
  assert.doesNotMatch(worker, /COALESCE\s*\(\s*op\.auto_confirm_due_at/i);
});
