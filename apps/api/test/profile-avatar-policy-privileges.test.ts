import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { applyRuntimePrivileges, configureProfileAvatarPolicyPrivileges } from "../src/database/business-migrations";

const TABLE = "zzsh_supply.profile_avatar_policy";
const FUNCTIONS = ["zzsh_supply.guard_profile_avatar_policy()", "zzsh_supply.guard_avatar_policy_asset()"];
const COLUMNS = ["singleton", "requires_review", "revision", "updated_by_admin_id", "updated_at"];
const WRITABLE = COLUMNS.slice(1), OPERATIONS = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
type Rights = { table: Set<string>; columns: Map<string, Set<string>>; grantOption: boolean };

// Runs the real ACL helper with stale table/column rights; no PostgreSQL or inherited-role claim.
function fixture(installed = true) {
  const seen: { sql: string; args: unknown[] }[] = [];
  const state = {
    table: [{ present: installed }] as Record<string, unknown>[], asset: [{ ready: installed }] as Record<string, unknown>[],
    functions: new Map(FUNCTIONS.map(name => [name, [{ present: installed }] as Record<string, unknown>[]])),
    columns: [...COLUMNS] as unknown[], failAt: "", sandbox: false,
  };
  const rights = new Map<string, Rights>(["PUBLIC", "runtime_role", "migration_owner"].map(principal => [principal, {
    table: new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]),
    columns: new Map(OPERATIONS.map(operation => [operation, new Set(COLUMNS)])), grantOption: true,
  }]));
  const mediaRights = new Set(["SELECT", "INSERT", "UPDATE"]);
  const emit = (sql: string) => {
    for (const raw of sql.split(";")) {
      const text = raw.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
      const match = /^(GRANT|REVOKE) (.+?) ON (?:TABLE )?zzsh_supply\.profile_avatar_policy (?:TO|FROM) (PUBLIC|"runtime_role")$/.exec(text);
      if (!match) continue;
      const [, verb, privileges, principal] = match, target = rights.get(principal!.replaceAll('"', ""))!;
      if (privileges === "ALL") { assert.equal(verb, "REVOKE"); target.table.clear(); target.grantOption = false; continue; }
      const columnRights = [...privileges!.matchAll(/(SELECT|INSERT|UPDATE|REFERENCES)\s*\(([^)]+)\)/g)];
      if (columnRights.length) {
        for (const [, operation, names] of columnRights) for (const name of names!.split(",").map(value => value.replaceAll('"', "").trim())) {
          const granted = target.columns.get(operation!)!;
          if (verb === "GRANT") granted.add(name); else granted.delete(name);
        }
      } else for (const operation of privileges!.split(",").map(value => value.trim())) {
        if (verb === "GRANT") target.table.add(operation); else target.table.delete(operation);
      }
    }
  };
  const pool = { query: async (sql: string, args: unknown[] = []) => {
    seen.push({ sql, args });
    if (state.failAt && sql.includes(state.failAt)) throw Error("SYNTHETIC_CATALOG_FAILURE");
    if (sql === "SELECT to_regclass('zzsh_supply.profile_avatar_policy') IS NOT NULL AS present") return { rows: state.table };
    if (sql.includes("attname='avatar_policy_revision'")) return { rows: state.asset };
    if (sql === "SELECT to_regprocedure($1) IS NOT NULL AS present") return { rows: state.functions.get(args[0] as string) ?? [] };
    if (sql.startsWith("SELECT attname FROM pg_attribute")) return { rows: (args[0] === TABLE ? state.columns : ["id", "active"]).map(attname => ({ attname })) };
    if (sql.startsWith("SELECT name,to_regclass")) return { rows: (args[0] as string[]).map(name => ({ name, present: state.sandbox && name.startsWith("zzsh_order.local_") })) };
    if (sql.startsWith("SELECT name,to_regprocedure")) return { rows: (args[0] as string[]).map(name => ({ name, present: state.sandbox && name.startsWith("zzsh_order.local_") })) };
    if (sql.includes("count(*)")) return { rows: [{ count: 0, ready: false }] };
    emit(sql);
    return { rows: [{ relation: null, present: false, ready: false, proof: false, initializer: false }] };
  } } as unknown as Pick<Pool, "query">;
  const snapshot = () => [...rights].map(([principal, r]) => ({ principal, table: [...r.table].sort(),
    columns: [...r.columns].map(([operation, names]) => [operation, [...names].sort()]), grantOption: r.grantOption }));
  const writes = () => seen.filter(({ sql }) => /^\s*(GRANT|REVOKE|ALTER DEFAULT)/.test(sql.replace(/--[^\n]*/g, "")));
  return { pool, state, seen, rights, mediaRights, snapshot, writes };
}

test("avatar ACL rejects unsafe runtime names before catalog access", async () => {
  for (const role of ["", "UPPER", "role;drop", "a".repeat(64)]) {
    const f = fixture(); await assert.rejects(configureProfileAvatarPolicyPrivileges(f.pool, role), /safe identifier/); assert.equal(f.seen.length, 0);
  }
});

test("fully absent avatar policy on an old media schema is optional and changes no privileges", async () => {
  const f = fixture(false), before = f.snapshot(); await configureProfileAvatarPolicyPrivileges(f.pool, "runtime_role");
  assert.equal(f.seen.length, 4); assert.equal(f.writes().length, 0); assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.seen.filter(query => query.sql.includes("to_regprocedure")).map(query => query.args[0]), FUNCTIONS);
});

test("every partial table/asset-column/trigger-function installation fails before ACL writes", async () => {
  for (let mask = 1; mask < 15; mask++) {
    const f = fixture(); f.state.table = [{ present: Boolean(mask & 1) }]; f.state.asset = [{ ready: Boolean(mask & 2) }];
    FUNCTIONS.forEach((name, index) => f.state.functions.set(name, [{ present: Boolean(mask & (4 << index)) }]));
    await assert.rejects(configureProfileAvatarPolicyPrivileges(f.pool, "runtime_role"), /partially deployed/); assert.equal(f.writes().length, 0);
  }
});

test("missing, malformed and failed catalog observations cannot grant or silently treat a schema as absent", async () => {
  for (const field of ["TABLE_EMPTY", "TABLE_DUPLICATE", "TABLE_BAD", "ASSET_EMPTY", "ASSET_BAD", "FUNCTION_EMPTY", "FUNCTION_BAD", "ERROR"]) {
    const f = fixture();
    if (field === "TABLE_EMPTY") f.state.table = [];
    if (field === "TABLE_DUPLICATE") f.state.table.push({ present: true });
    if (field === "TABLE_BAD") f.state.table = [{ present: "true" }];
    if (field === "ASSET_EMPTY") f.state.asset = [];
    if (field === "ASSET_BAD") f.state.asset = [{ ready: 1 }];
    if (field === "FUNCTION_EMPTY") f.state.functions.set(FUNCTIONS[0]!, []);
    if (field === "FUNCTION_BAD") f.state.functions.set(FUNCTIONS[1]!, [{ present: null }]);
    if (field === "ERROR") f.state.failAt = "to_regprocedure($1)";
    await assert.rejects(configureProfileAvatarPolicyPrivileges(f.pool, "runtime_role"), /inventory|SYNTHETIC_CATALOG_FAILURE/); assert.equal(f.writes().length, 0);
  }
  for (const columns of [[], COLUMNS.slice(1), [...COLUMNS, "other"], [...COLUMNS.slice(1), "revision"], [...COLUMNS.slice(1), "bad;column"]]) {
    const f = fixture(); f.state.columns = columns;
    await assert.rejects(configureProfileAvatarPolicyPrivileges(f.pool, "runtime_role"), /column inventory/); assert.equal(f.writes().length, 0);
  }
});

test("avatar policy removes PUBLIC and old table/column grants, retaining only SELECT and four runtime updates idempotently", async () => {
  const f = fixture(), owner = structuredClone(f.rights.get("migration_owner")), media = [...f.mediaRights];
  await configureProfileAvatarPolicyPrivileges(f.pool, "runtime_role");
  const runtime = f.rights.get("runtime_role")!, pub = f.rights.get("PUBLIC")!;
  assert.deepEqual([...runtime.table], ["SELECT"]); assert.equal(runtime.grantOption, false); assert.equal(pub.table.size, 0); assert.equal(pub.grantOption, false);
  for (const operation of OPERATIONS) {
    assert.equal(pub.columns.get(operation)!.size, 0);
    assert.deepEqual([...runtime.columns.get(operation)!].sort(), operation === "UPDATE" ? [...WRITABLE].sort() : []);
  }
  assert.deepEqual(f.rights.get("migration_owner"), owner); assert.deepEqual([...f.mediaRights], media);
  const changes = f.writes().map(query => query.sql).join("\n");
  assert.match(changes, /REVOKE SELECT \([^)]*"singleton"/); assert.match(changes, /REVOKE ALL ON FUNCTION zzsh_supply\.guard_profile_avatar_policy\(\),zzsh_supply\.guard_avatar_policy_asset\(\) FROM PUBLIC, "runtime_role"/);
  assert.doesNotMatch(changes, /GRANT (?:INSERT|DELETE|TRUNCATE|REFERENCES|TRIGGER|EXECUTE)|UPDATE\(singleton|WITH GRANT OPTION|media_asset|SET ROLE|GRANT .* TO PUBLIC/);
  const first = f.snapshot(), sql = f.seen.map(query => query.sql); f.seen.length = 0;
  await configureProfileAvatarPolicyPrivileges(f.pool, "runtime_role"); assert.deepEqual(f.snapshot(), first); assert.deepEqual(f.seen.map(query => query.sql), sql);
});

test("the common runner narrows avatar policy after broad/default grants and still finalizes local sandbox last", async () => {
  const f = fixture(); f.state.sandbox = true; await applyRuntimePrivileges(f.pool, "runtime_role");
  const broad = f.seen.findIndex(query => query.sql.includes('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_supply"'));
  const defaults = f.seen.findIndex(query => query.sql.includes('ALTER DEFAULT PRIVILEGES IN SCHEMA "zzsh_supply"'));
  const policy = f.seen.findIndex(query => query.sql.includes("UPDATE(requires_review,revision,updated_by_admin_id,updated_at)"));
  const sandbox = f.seen.findIndex(query => query.sql.includes("GRANT UPDATE(active) ON zzsh_order.local_financial_sandbox_registration"));
  assert(broad >= 0 && defaults > broad && policy > defaults && sandbox > policy);
  assert(f.writes().at(-1)!.sql.includes("GRANT EXECUTE ON FUNCTION zzsh_order.local_financial_sandbox_matches"));
  assert.deepEqual([...f.rights.get("runtime_role")!.table], ["SELECT"]);
});
