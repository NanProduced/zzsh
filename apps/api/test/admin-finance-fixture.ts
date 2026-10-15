import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { ADMIN_FINANCE_LEDGER_SQL, ADMIN_FINANCE_OBSERVATION_SQL } from "../src/finance/admin-finance-read";

type Row = Record<string, unknown>;
// Execute the actual filter/rank/page SQL in memory. Only fixture sources and PG scalar syntax are adapted.
// This checks relational behavior, not PostgreSQL syntax, MVCC, query plans or numeric arithmetic.
export class FinanceSqlFixture {
  readonly db = new DatabaseSync(":memory:");
  readonly reads: { family: string; rows: number }[] = [];
  clusterSnapshot = "100:100:";
  constructor(data: { ledger?: Row[]; history?: Row[]; native?: Row[]; legacy?: Row[]; subjects?: Row[]; withdrawals?: Row[]; operations?: Row[] } = {}) {
    this.db.function("regexp", (pattern, value) => typeof value === "string" && new RegExp(String(pattern)).test(value) ? 1 : 0);
    this.db.exec(`ATTACH DATABASE ':memory:' AS zzsh_order; ATTACH DATABASE ':memory:' AS zzsh_auth_user; BEGIN`);
    const ledger=(data.ledger??[]).map(row=>{const delta=typeof row.delta==="string"&&/^-?\d+$/.test(row.delta)?BigInt(row.delta):null;return {...row,counterparty_user_id:row.subject_id,credit_cents:delta===null?null:delta>=0n?String(delta):"0",debit_cents:delta===null?null:delta<0n?String(-delta):"0",finance_event_id:row.finance_event_id??row.event_kind,created_at:row.at};});
    this.table("zzsh_order.fixture_ledger", "id account_code subject_id subject_name delta at posting_id event_kind source_kind source_type source_system source_entity source_id source_digest basis_id order_id display_no account_id opening_cutoff covered_count payment_confirmation_id settlement_version_id version_hash captured_cents renter_refund_cents platform_contribution_cents refund_due_at counterparty_user_id credit_cents debit_cents finance_event_id created_at", ledger);
    this.table("zzsh_order.fixture_history", "id subject_id subject_name source_kind source_type source_system source_entity source_id source_digest basis_id included_in_opening at imported_at amount action source_status reference_id reference_no net fee balance_after", data.history ?? []);
    this.table("zzsh_order.rental_order", "id display_no owner_user_id renter_user_id account_id status revision rental_amount_cents deposit_amount_cents created_at", data.native ?? []);
    this.table("zzsh_order.legacy_order_read_snapshot", "id source_system legacy_id source_digest binding_digest original_order_no owner_user_id renter_user_id account_id due_amount_cents recorded_paid_amount_cents deposit_amount_cents source_order_status source_pay_status source_created_at imported_at", data.legacy ?? []);
    this.table('zzsh_auth_user."user"', "id name", data.subjects ?? [{ id: "u1", name: "用户一" }, { id: "u2", name: "用户二" }]);
    this.table("zzsh_order.withdrawal_intent", "id state operation_version funds_disposition last_provider_fact_id", data.withdrawals??[]);
    this.table("zzsh_order.withdrawal_provider_fact", "id evidence_digest", []);
    this.table("zzsh_order.controlled_payout_operation", "id final_evidence_digest", data.operations??[]);
    this.table("zzsh_order.wallet_revision", "user_id ledger_revision read_revision", []);
    this.table("zzsh_order.wallet_coverage", "user_id basis_id coverage_version", []);
    this.table("zzsh_order.finance_opening_basis", "id source_digest covered_set_digest source_cutoff", []);
    this.table("zzsh_order.finance_economic_root", "id source_digest policy_version", []);
    this.table("zzsh_order.settlement_posting", "id version_hash", []);
    this.db.exec(`CREATE VIEW zzsh_order.settlement_ledger_entry AS SELECT id,account_code,counterparty_user_id,credit_cents,debit_cents,posting_id,finance_event_id,created_at FROM fixture_ledger`);
    this.db.exec(`CREATE VIEW zzsh_order.personal_finance_observation AS SELECT id,subject_id AS user_id,basis_id,source_digest,included_in_opening,at AS source_event_at,imported_at FROM fixture_history`);
    this.db.exec("COMMIT");
  }
  private table(name: string, columns: string, rows: Row[]) {
    const names = columns.split(" ");
    this.db.exec(`CREATE TABLE ${name}(${names.map(name => '"' + name + '" TEXT').join(",")})`);
    const insert = this.db.prepare(`INSERT INTO ${name} VALUES(${names.map(() => "?").join(",")})`);
    for (const row of rows) insert.run(...names.map(name => row[name] == null ? null : typeof row[name] === "boolean" ? row[name] ? 1 : 0 : String(row[name])));
  }
  query(sql: string, values: unknown[]) {
    if(sql.includes("AS finance_version"))return {rows:[{finance_version:this.sourceVersion(sql)}],rowCount:1};
    const base = (source: string) => source.replace(/\s+ORDER BY [lo]\.id COLLATE "C" LIMIT \$1\s*$/, "");
    const text = sql.replaceAll(base(ADMIN_FINANCE_LEDGER_SQL), "SELECT * FROM fixture_ledger")
      .replaceAll(base(ADMIN_FINANCE_OBSERVATION_SQL), "SELECT * FROM fixture_history")
      .replace(/=ANY\((\$\d+)::text\[\]\)/g, " IN(SELECT value FROM json_each($1))")
      .replace(/([\w.]+|\$\d+)::timestamptz/g, "julianday($1)")
      .replace(/::text\b/g, "")
      .replace(/to_char\(([\w.]+) AT TIME ZONE 'UTC','[^']*'\)/g, "$1")
      .replace(/([\w.]+) ~ ('[^']*')/g, "regexp($2,$1)")
      .replace(/left\(([^,]+),3\)/g, "substr($1,1,3)").replace(/right\(([^,]+),4\)/g, "substr($1,-4)")
      .replaceAll(' COLLATE "C"', "");
    const bindings = Object.fromEntries(values.map((value, index) => ["$" + (index + 1), Array.isArray(value) ? JSON.stringify(value) : value as string | number]));
    const rows = this.db.prepare(text).all(bindings).map(row=>Object.hasOwn(row,"included_in_opening")?{...row,included_in_opening:row.included_in_opening==="1"}:row);
    this.reads.push({ family: sql.startsWith("WITH finance_lookup") ? "keys" : sql.startsWith("WITH finance_order") ? "orders" : "entries", rows: rows.length });
    return { rows, rowCount: rows.length };
  }
  private sourceVersion(sql: string): string {
    const md5=(value:string)=>createHash("md5").update(value).digest("hex");
    if(sql.includes("pg_current_snapshot()"))return "pg-snapshot-v2:"+md5("fixture-db:"+this.clusterSnapshot);
    const relations=[...sql.matchAll(/FROM \((SELECT[\s\S]*?)\) v/g)].map(match=>match[1]!);
    if(!relations.length)throw Error("Unrecognized source-version SQL");
    // The real generated SELECTs determine membership and fields; PG JSONB serialization/cost remain NOT_RUN.
    return md5(relations.map(relation=>{
      const rows=this.db.prepare(relation.replace(/::text\b/g,"")+" ORDER BY id").all();
      return md5(rows.map(row=>md5(JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a<b?-1:a>b?1:0))))).join(""));
    }).join("|"));
  }
  close() { this.db.close(); }
}

export const legacyFinanceOrder = (id: string, overrides: Row = {}): Row => ({ id, source_system: "synthetic-legacy", legacy_id: id, source_digest: "a".repeat(64), binding_digest:"b".repeat(64), original_order_no: "SN-" + id, owner_user_id: "u1", renter_user_id: "u2", account_id: "account1", due_amount_cents: "10000", recorded_paid_amount_cents: "9000", deposit_amount_cents: "1000", source_order_status: "4", source_pay_status: "1", source_created_at: "2026-10-03T01:00:00.000000Z", imported_at: "2026-10-03T02:00:00.000000Z", ...overrides });
