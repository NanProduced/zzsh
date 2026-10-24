import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { applyRuntimePrivileges, configureChannelRefundPrivileges } from "../src/database/business-migrations";

const INTENT = "zzsh_order.channel_refund_intent", OBSERVATION = "zzsh_order.channel_refund_observation";
const NAMES = [INTENT, OBSERVATION];
const INSERT_INTENT = "id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,merchant_identity_id,original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,amount_cents,currency,idempotency_key,request_fingerprint,due_at".split(",");
const UPDATE_INTENT = "state,revision,lease_version,lease_owner,lease_until".split(",");
const INSERT_OBSERVATION = "id,intent_id,event,failure_reason,lease_version,lease_owner,state_before,state_after,request_id".split(",");
const COLUMNS = new Map([[INTENT, [...INSERT_INTENT, ...UPDATE_INTENT, "created_at", "updated_at", "unlisted_column"]],
  [OBSERVATION, [...INSERT_OBSERVATION, "created_at", "unlisted_column"]]]);
const OPERATIONS = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
type Rights = { table: Set<string>; columns: Map<string, Set<string>>; grantOption: boolean };
type Inventory = Array<{ name: unknown; present: unknown }>;
function fixture(present = true) {
  const seen: Array<{ sql: string; args: unknown[] }> = [];
  const state = { inventory: NAMES.map(name => ({ name, present })) as Inventory, columns: new Map(COLUMNS), failAt: "" };
  const rights = new Map<string, Rights>(NAMES.map(name => [name, {
    table: new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]),
    columns: new Map(OPERATIONS.map(op => [op, new Set(COLUMNS.get(name)!)])), grantOption: true,
  }]));
  function emitted(sql: string) {
    for (const raw of sql.split(";")) {
      const text = raw.replace(/\s+/g, " ").trim();
      if (/^GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_order"/.test(text)) {
        for (const r of rights.values()) for (const op of ["SELECT", "INSERT", "UPDATE"]) r.table.add(op);
      }
      const match = /^(GRANT|REVOKE) (.+?) ON (?:TABLE )?(zzsh_order\.channel_refund_\w+) (?:TO|FROM) "runtime_role"$/.exec(text);
      if (!match) continue;
      const [, verb, privileges, name] = match;
      const target = rights.get(name!)!;
      if (privileges === "ALL") { assert.equal(verb, "REVOKE"); target.table.clear(); target.grantOption = false; continue; }
      const columnPrivileges = [...privileges!.matchAll(/(SELECT|INSERT|UPDATE|REFERENCES)\s*\(([^)]+)\)/g)];
      if (columnPrivileges.length) {
        for (const [, op, textColumns] of columnPrivileges) {
          const targetColumns = target.columns.get(op!)!;
          for (const column of textColumns!.split(",").map(c => c.replaceAll('"', "").trim())) {
            if (verb === "GRANT") targetColumns.add(column); else targetColumns.delete(column);
          }
        }
      } else for (const op of privileges!.split(",").map(s => s.trim())) {
        if (verb === "GRANT") target.table.add(op); else target.table.delete(op);
      }
    }
  }
  const pool = { query: async (sql: string, args: unknown[] = []) => {
    seen.push({ sql, args });
    if (state.failAt && sql.includes(state.failAt)) throw Error("SYNTHETIC_METADATA_FAILURE");
    if (sql.startsWith("SELECT name,to_regclass")) {
      const names = args[0] as string[];
      return { rows: names.includes(INTENT) ? state.inventory : names.map(name => ({ name, present: false })) };
    }
    if (sql.startsWith("SELECT name,to_regprocedure")) return { rows: (args[0] as string[]).map(name => ({ name, present: false })) };
    if (sql.startsWith("SELECT attname FROM pg_attribute")) return { rows: (state.columns.get(args[0] as string) ?? []).map(attname => ({ attname })) };
    if (sql.includes("native_user_insert_proof") && sql.startsWith("SELECT")) return { rows: [{ proof: false, initializer: false }] };
    if (sql.includes("count(*)")) return { rows: [{ count: 0, ready: false }] };
    emitted(sql);
    return { rows: [{ relation: null, present: false, ready: false }] };
  } } as unknown as Pick<Pool, "query">;
  const snapshot = () => [...rights].map(([name, r]) => ({ name, table: [...r.table].sort(),
    columns: [...r.columns].map(([op, columns]) => [op, [...columns].sort()]), grantOption: r.grantOption }));
  return { pool, seen, state, rights, snapshot };
}
const changes = (f: ReturnType<typeof fixture>) => f.seen.filter(q => /^\s*(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)/.test(q.sql));
const sorted = (values: Iterable<string>) => [...values].sort();

// 这里核验实际helper生成的SQL与离线权限模型，不代表PG有效权限或角色继承已验收。
test("unsafe role rejects before any SQL", async () => {
  for (const role of ["role;drop", "UPPER", "", "a".repeat(64)]) {
    const f = fixture(); await assert.rejects(configureChannelRefundPrivileges(f.pool, role), /safe identifier/); assert.equal(f.seen.length, 0);
  }
});
test("both absent tables are a single inventory read and no-op", async () => {
  const f = fixture(false); const before = f.snapshot(); await configureChannelRefundPrivileges(f.pool, "runtime_role");
  assert.equal(f.seen.length, 1); assert.deepEqual(f.seen[0]!.args, [NAMES]); assert.deepEqual(f.snapshot(), before);
});
test("partial and malformed inventories reject before privilege changes", async () => {
  const invalid: Inventory[] = [[], [{ name: INTENT, present: true }],
    [{ name: INTENT, present: true }, { name: OBSERVATION, present: false }],
    [{ name: INTENT, present: false }, { name: OBSERVATION, present: true }],
    [{ name: INTENT, present: true }, { name: INTENT, present: true }],
    [{ name: "zzsh_order.other", present: false }, { name: OBSERVATION, present: false }],
    [{ name: INTENT, present: "false" }, { name: OBSERVATION, present: false }],
    [{ name: INTENT, present: null }, { name: OBSERVATION, present: false }],
    [{ name: undefined, present: false }, { name: OBSERVATION, present: false }]];
  for (const inventory of invalid) {
    const f = fixture(); f.state.inventory = inventory; await assert.rejects(configureChannelRefundPrivileges(f.pool, "runtime_role"), /inventory|partially/);
    assert.equal(changes(f).length, 0); assert.equal(f.seen.length, 1);
  }
});
test("old table and every discovered column grant are removed before exact store grants", async () => {
  const f = fixture(); await configureChannelRefundPrivileges(f.pool, "runtime_role");
  const resets = f.seen.filter(q => q.sql.startsWith("REVOKE ALL ON TABLE")); assert.equal(resets.length, 2);
  for (const reset of resets) {
    assert(reset.sql.includes('"unlisted_column"')); for (const op of OPERATIONS) assert(reset.sql.includes(op + " ("));
  }
  const intent = f.rights.get(INTENT)!, observation = f.rights.get(OBSERVATION)!;
  for (const r of [intent, observation]) { assert.deepEqual(sorted(r.table), ["SELECT"]); assert.equal(r.grantOption, false); assert.equal(r.columns.get("SELECT")!.size, 0); assert.equal(r.columns.get("REFERENCES")!.size, 0); }
  assert.deepEqual(sorted(intent.columns.get("INSERT")!), sorted(INSERT_INTENT));
  assert.deepEqual(sorted(intent.columns.get("UPDATE")!), sorted(UPDATE_INTENT));
  assert.deepEqual(sorted(observation.columns.get("INSERT")!), sorted(INSERT_OBSERVATION)); assert.equal(observation.columns.get("UPDATE")!.size, 0);
  const grants = f.seen.at(-1)!.sql; assert.doesNotMatch(grants, /WITH GRANT OPTION|GRANT (?:DELETE|TRUNCATE|REFERENCES|TRIGGER)|unlisted_column|created_at|updated_at/);
  assert(!f.seen.some(q => /^(BEGIN|COMMIT|ROLLBACK)$/.test(q.sql)), "helper leaves transaction ownership to caller");
});
test("every repeated convergence has identical output and permissions", async () => {
  const f = fixture(); await configureChannelRefundPrivileges(f.pool, "runtime_role"); const first = f.snapshot(), sql = f.seen.map(q => q.sql);
  f.seen.length = 0; await configureChannelRefundPrivileges(f.pool, "runtime_role"); assert.deepEqual(f.snapshot(), first); assert.deepEqual(f.seen.map(q => q.sql), sql);
});
test("missing or unsafe discovered column metadata fails instead of broad fallback", async () => {
  for (const columns of [[], ["bad;column"]]) {
    const f = fixture(); f.state.columns.set(INTENT, columns); await assert.rejects(configureChannelRefundPrivileges(f.pool, "runtime_role"), /unavailable|safe identifier/);
    assert.equal(changes(f).length, 0);
  }
});
test("database metadata errors propagate without silently widening permissions", async () => {
  const f = fixture(); f.state.failAt = "SELECT name,to_regclass"; await assert.rejects(configureChannelRefundPrivileges(f.pool, "runtime_role"), /SYNTHETIC_METADATA_FAILURE/); assert.equal(changes(f).length, 0);
});
test("common path converges refund last after broad/default and other narrow helpers", async () => {
  const f = fixture(); await applyRuntimePrivileges(f.pool, "runtime_role");
  const broad = f.seen.findIndex(q => q.sql.includes('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_order"'));
  const defaults = f.seen.findIndex(q => q.sql.includes('ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_order"'));
  const previousNarrow = f.seen.findIndex(q => q.sql.includes("assert_personal_growth_order_v4"));
  const refund = f.seen.findIndex(q => q.sql.startsWith("SELECT name,to_regclass") && (q.args[0] as string[]).includes(INTENT));
  assert(broad >= 0 && defaults > broad && previousNarrow > defaults && refund > previousNarrow);
  const exactGrant = f.seen.findIndex(q => q.sql.includes("GRANT INSERT(id,intent_id,event"));
  assert(exactGrant > refund); assert(f.seen.at(-1)!.sql.includes("joinpay financial optional tables"));
  assert(!f.seen.slice(exactGrant + 1).some(q => /^\s*(GRANT|REVOKE|ALTER DEFAULT)/.test(q.sql)));
  assert(!f.seen.slice(refund).some(q => q.sql.includes("ON ALL TABLES") || q.sql.includes("ALTER DEFAULT")));
  assert.deepEqual(sorted(f.rights.get(INTENT)!.table), ["SELECT"]);
  assert(!f.seen.some(q => /^(BEGIN|COMMIT|ROLLBACK)$/.test(q.sql)));
});
test("common caller stays compatible when the optional refund schema is absent", async () => {
  const f = fixture(false); await applyRuntimePrivileges(f.pool, "runtime_role");
  const refund = f.seen.findIndex(q => q.sql.startsWith("SELECT name,to_regclass") && (q.args[0] as string[]).includes(INTENT));
  assert.equal(refund, f.seen.length - 2); assert(f.seen.at(-1)!.sql.includes("joinpay financial optional tables")); assert.equal(f.seen.filter(q => q.sql.startsWith("REVOKE ALL ON TABLE zzsh_order.channel_refund_")).length, 0);
  const first = f.seen.map(q => q.sql); f.seen.length = 0; await applyRuntimePrivileges(f.pool, "runtime_role"); assert.deepEqual(f.seen.map(q => q.sql), first);
});
