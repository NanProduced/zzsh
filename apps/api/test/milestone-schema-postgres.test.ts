// The authorized parent owns resource creation, credentials, window, pools and cleanup.
// These exported probes never select a database, read secrets or connect at import time.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { types } from "pg";
import type { Pool, PoolClient } from "pg";
import { BusinessMigrationAclError, runBusinessMigrations } from "../src/database/business-migrations";

const sequence74 = "45124baf29a7e412b1df92e19afd6150eec95302a9e8270ef961a10373dd0852";
const sequence80 = "9eb306ec90b83e8a97b9132744048e75e4669caa7134fbf92b41cda6808f2627";
const runnerSha = "f3f2e8ca4beeddd99c40f62cade11ed3af39272eb80079d9aeaff30b89688518";
const seedCode = "order.legacy.continue";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const id = (value: string) => { assert.match(value, /^[A-Za-z_][A-Za-z0-9_]*$/); return `"${value}"`; };
const relation = (name: string) => name.split(".").map(id).join(".");
const orderTables = [
  "finance_opening_basis", "finance_covered_event", "finance_economic_root", "finance_event", "settlement_ledger_entry",
  "finance_observation_admission", "personal_finance_observation", "wallet_coverage", "wallet_revision",
  "rental_order", "legacy_order_read_snapshot", "payment_confirmation", "settlement_posting", "settlement_intake",
  "settlement_version", "settlement_decision", "im_order_group", "im_order_member", "withdrawal_admission",
  "withdrawal_destination", "withdrawal_intent", "withdrawal_provider_fact", "controlled_payout_operation", "controlled_payout_notice",
  "rental_referral_earning", "rental_referral_reversal_source", "rental_referral_transition", "invitation_relation",
  "owner_guarantee_payment", "owner_guarantee_refund",
].map(n => `zzsh_order.${n}`);
const existingTables = [...orderTables,
  "zzsh_iam.audit_event", "zzsh_iam.admin_security", "zzsh_iam.user_identity_state", "zzsh_iam.im_identity_mapping",
  "zzsh_supply.idempotency_record", "zzsh_supply.rental_account", "zzsh_supply.listing_version", "zzsh_supply.legacy_supply_map",
  "zzsh_supply.legacy_listing_read_snapshot", "zzsh_supply.legacy_listing_display_snapshot",
  ...["zzsh_auth_user", "zzsh_auth_admin"].flatMap(s => ["user", "account", "session", "twoFactor"].map(t => `${s}.${t}`)),
  "zzsh_supply.rule_acceptance", "zzsh_iam.admin_security_command", "zzsh_iam.admin_backup_code_generation", "zzsh_iam.admin_permission",
].sort();
const newTables = [
  "legacy_continuation_evidence", "legacy_continuation_version", "legacy_order_duty", "legacy_order_duty_admission",
  "legacy_order_duty_revision", "legacy_inflight_register", "personal_finance_observation_coverage", "finance_stored_opening_review",
  "legacy_duty_finance_contract", "legacy_duty_finance_fact", "legacy_owner_guarantee_observation", "legacy_owner_guarantee_coverage",
].map(n => `zzsh_order.${n}`).sort();
const primaryKeys: Record<string, string[]> = {
  "zzsh_order.finance_covered_event": ["user_id", "source_kind", "source_type", "source_entity", "source_id", "beneficiary_role"],
  "zzsh_order.finance_observation_admission": ["basis_id", "source_entity", "source_id"],
  "zzsh_order.wallet_coverage": ["user_id"], "zzsh_order.wallet_revision": ["user_id"],
  "zzsh_iam.admin_security": ["admin_user_id"], "zzsh_iam.user_identity_state": ["user_id"],
  "zzsh_supply.idempotency_record": ["scope_key", "key"],
  "zzsh_supply.legacy_supply_map": ["source_system", "source_entity", "legacy_id"],
  "zzsh_supply.legacy_listing_read_snapshot": ["account_id"],
  "zzsh_supply.legacy_listing_display_snapshot": ["account_id", "schema_version"],
  "zzsh_order.im_order_group": ["order_id"], "zzsh_order.im_order_member": ["order_id", "identity_id"],
  "zzsh_iam.admin_security_command": ["admin_user_id", "command_id"],
  "zzsh_iam.admin_backup_code_generation": ["admin_user_id"], "zzsh_iam.admin_permission": ["code"],
};
const touchedFunctions = ["guard_observation_admission", "guard_personal_order", "guard_supply_final_funding"];
const requiredFixtures: Record<string, number> = {
  "zzsh_auth_user.user": 2, "zzsh_auth_admin.user": 1, "zzsh_supply.rental_account": 1,
  "zzsh_order.rental_order": 1, "zzsh_supply.rule_acceptance": 1,
};
function assertFixtures(rows: { name: string; rows: string }[]) {
  for (const [name, minimum] of Object.entries(requiredFixtures)) {
    const row = rows.find(r => r.name === name);
    assert(row && /^[0-9]+$/.test(row.rows) && BigInt(row.rows) >= BigInt(minimum), `missing74 domain fixture ${name} >= ${minimum}; use the registered order fixture before schema upgrade`);
  }
}
const expectedDefinitionChanges = [
  "constraint:zzsh_supply.rule_acceptance:legacy_acceptance_shape",
  "constraint:zzsh_supply.rule_acceptance:rule_acceptance_acceptance_kind_check",
  "constraint:zzsh_order.finance_economic_root:finance_root_enabled_source_shape",
  "constraint:zzsh_order.finance_event:finance_event_kind_check",
  "constraint:zzsh_order.finance_event:legacy_duty_event_batch",
  "constraint:zzsh_order.settlement_ledger_entry:legacy_duty_entry_batch",
  "constraint:zzsh_order.settlement_ledger_entry:settlement_ledger_accounts",
  "trigger:zzsh_supply.rule_acceptance:legacy_takeover_authorization_guard",
  "trigger:zzsh_order.personal_finance_observation:a_history_subject_lock",
  "trigger:zzsh_order.finance_economic_root:legacy_duty_root_guard",
  "trigger:zzsh_order.finance_event:legacy_duty_event_guard",
  "trigger:zzsh_order.finance_event:legacy_duty_event_batch",
  "trigger:zzsh_order.finance_event:legacy_duty_wallet_revision",
  "trigger:zzsh_order.settlement_ledger_entry:legacy_duty_entry_guard",
  "trigger:zzsh_order.settlement_ledger_entry:legacy_duty_entry_batch",
  "trigger:zzsh_order.settlement_ledger_entry:finance_entry_guard",
  "trigger:zzsh_order.settlement_ledger_entry:finance_entry_batch_guard",
].sort();

export type MilestoneSchemaPgOptions = {
  apiRoot: string;
  migrationPool: Pool;
  runtimePool: Pool;
  target: { database: string; oid: string; marker: string; owner: string; migrationRole: string; migrationOid: string; runtimeRole: string; runtimeOid: string };
  limits: { pageRows: number; maxRowsPerPass: number; maxPagesPerTable: number; statementMs: number; lockMs: number };
  assertWindow: () => void;
  checkpoint: (stage: string, evidence: unknown) => void | Promise<void>;
};
type RowDigest = { rows: string; digest: string };
type Column = { name: string; type: string; notNull: boolean; default: string | null; owner?: string; tableAcl?: string[] | null; acl?: string[] | null; collation?: string; identity?: string; generated?: string };
type FunctionDefinition = { name: string; body: string; definition: string; owner: string; acl: string[] | null; result: string; arguments: string; security: boolean; strict: boolean; volatility: string; config: string[] | null; parallel?: string; leakproof?: boolean; cost?: string; resultRows?: string };
export type MilestoneSchemaSnapshot = {
  chain: 74 | 80;
  target: MilestoneSchemaPgOptions["target"];
  columns: Record<string, Column[]>;
  rows: Record<string, RowDigest>;
  definitions: Record<string, string>;
  functions: FunctionDefinition[];
  permissionExceptSeed: RowDigest;
  seed: string | null;
};

function localMigrations(o: MilestoneSchemaPgOptions) {
  o.assertWindow();
  assert.equal(o.target.database, "zzsh_test_order_qf80_integration");
  assert.equal(o.target.migrationRole, "zzsh_order_qf80_integration_m");
  assert.equal(o.target.runtimeRole, "zzsh_order_qf80_integration_r");
  for (const key of ["oid", "migrationOid", "runtimeOid"] as const) assert.match(o.target[key], /^[1-9][0-9]*$/);
  assert.notEqual(o.target.oid, "931888", "the original C resource is not this isolated schema probe");
  assert.notEqual(o.target.oid, "943369", "the performance REVIEW resource is not this schema probe");
  assert(o.target.marker && o.target.owner);
  id(o.target.migrationRole); id(o.target.runtimeRole);
  assert.notEqual(o.target.migrationRole, o.target.runtimeRole);
  for (const [pool, role] of [[o.migrationPool, o.target.migrationRole], [o.runtimePool, o.target.runtimeRole]] as const) {
    assert.equal(pool.options.host, "127.0.0.1"); assert.equal(Number(pool.options.port), 55432);
    assert.equal(pool.options.database, o.target.database); assert.equal(pool.options.user, role);
    assert(Number(pool.options.connectionTimeoutMillis) > 0 && Number(pool.options.connectionTimeoutMillis) <= 3000);
  }
  for (const n of Object.values(o.limits)) assert(Number.isSafeInteger(n) && n > 0);
  assert(o.limits.pageRows <= 4096 && o.limits.statementMs <= 3000 && o.limits.lockMs <= 500);
  const folder = resolve(o.apiRoot, "migrations/business");
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  assert.equal(migrations.length, 80);
  const digest = (n: number) => hash(JSON.stringify(migrations.slice(0, n).map(m => ({ hash: m.hash, when: String(m.folderMillis) }))));
  assert.equal(digest(74), sequence74); assert.equal(digest(80), sequence80);
  assert.equal(hash(readFileSync(resolve(o.apiRoot, "src/database/business-migrations.ts"))), runnerSha);
  return { folder, migrations };
}

async function identity(c: PoolClient, o: MilestoneSchemaPgOptions, runtime: boolean) {
  o.assertWindow();
  const r = (await c.query(`SELECT current_database() AS name,d.oid::text AS oid,
    shobj_description(d.oid,'pg_database') AS marker,pg_get_userbyid(d.datdba) AS owner,
    current_user AS role,r.oid::text AS "roleOid",r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
    current_setting('statement_timeout')::interval <= ($1||' milliseconds')::interval AS "statementBound",
    current_setting('statement_timeout')::interval > interval '0' AS "statementPositive",
    current_setting('lock_timeout')::interval <= ($2||' milliseconds')::interval AS "lockBound",
    current_setting('lock_timeout')::interval > interval '0' AS "lockPositive"
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`,
  [o.limits.statementMs, o.limits.lockMs])).rows[0];
  assert(r); assert.equal(r.name, o.target.database); assert.equal(r.oid, o.target.oid);
  assert.equal(r.marker, o.target.marker); assert.equal(r.owner, o.target.owner);
  assert.equal(r.role, runtime ? o.target.runtimeRole : o.target.migrationRole);
  assert.equal(r.roleOid, runtime ? o.target.runtimeOid : o.target.migrationOid);
  assert(r.statementBound && r.statementPositive && r.lockBound && r.lockPositive);
  if (runtime) for (const key of ["rolsuper", "rolbypassrls", "rolcreaterole", "rolcreatedb", "rolreplication"]) assert.equal(r[key], false);
}

async function rollbackProbe<T>(o: MilestoneSchemaPgOptions, pool: Pool, runtime: boolean, readOnlyTx: boolean, run: (c: PoolClient) => Promise<T>): Promise<T> {
  o.assertWindow(); const c = await pool.connect(); let started = false, primary: unknown;
  try {
    await identity(c, o, runtime); await c.query(`BEGIN ISOLATION LEVEL REPEATABLE READ${readOnlyTx ? " READ ONLY" : ""}`); started = true;
    await c.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO, YMD'; SET LOCAL IntervalStyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL search_path=pg_catalog");
    return await run(c);
  } catch (error) { primary = error; throw error;
  } finally {
    let broken = !started && primary !== undefined;
    try { if (started) await c.query("ROLLBACK"); }
    catch (closeError) {
      broken = true;
      if (primary !== undefined) throw new AggregateError([primary, closeError], "original schema probe failure and transaction close failure preserved", { cause: primary });
      throw closeError;
    } finally { c.release(broken ? true : undefined); }
  }
}
const readOnly = <T>(o: MilestoneSchemaPgOptions, run: (c: PoolClient) => Promise<T>) => rollbackProbe(o, o.migrationPool, false, true, run);

async function assertChain(c: PoolClient, o: MilestoneSchemaPgOptions, count: 74 | 80) {
  o.assertWindow(); const rows = (await c.query(`SELECT hash,created_at::text AS "when" FROM zzsh_business_meta.migrations ORDER BY created_at,id`)).rows;
  assert.equal(rows.length, count); assert.equal(hash(JSON.stringify(rows)), count === 74 ? sequence74 : sequence80);
}

async function rowProjection(c: PoolClient, o: MilestoneSchemaPgOptions, table: string, columns: Column[], totals: { rows: number }, excludeSeed = false): Promise<RowDigest> {
  const keys = primaryKeys[table] ?? ["id"], quoted = relation(table);
  assert(keys.every(k => columns.some(col => col.name === k && col.notNull)));
  const digest = createHash("sha256"); let cursor: string | null = null, rows = 0;
  for (let page = 0; page < o.limits.maxPagesPerTable; page++) {
    o.assertWindow();
    const boundary: string = cursor === null ? "" : ` AND ROW(${keys.map(k => `t.${id(k)}`).join(",")}) > ROW(${keys.map(k => `(jsonb_populate_record(NULL::${quoted},$2::jsonb)).${id(k)}`).join(",")})`;
    const sql: string = `SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS digest,
      jsonb_build_object(${keys.flatMap(k => [`'${k}'`, `p.${id(k)}`]).join(",")})::text AS cursor
      FROM (SELECT ${columns.map(col => `t.${id(col.name)}`).join(",")} FROM ${quoted} t WHERE true${excludeSeed ? ` AND t.code <> '${seedCode}'` : ""}${boundary}) p
      ORDER BY ${keys.map(k => `p.${id(k)}`).join(",")} LIMIT $1`;
    const pageRows: { digest: string; cursor: string }[] = (await c.query<{ digest: string; cursor: string }>(sql, cursor === null ? [o.limits.pageRows] : [o.limits.pageRows, cursor])).rows;
    assert(pageRows.length <= o.limits.pageRows);
    for (const row of pageRows) {
      assert.match(row.digest, /^[a-f0-9]{64}$/); assert.equal(typeof row.cursor, "string");
      assert.notEqual(row.cursor, cursor, "opaque PK cursor must advance"); cursor = row.cursor;
      digest.update(Buffer.from(row.digest, "hex")); rows++; totals.rows++;
      assert(totals.rows <= o.limits.maxRowsPerPass, "complete projection row budget exceeded; do not accept a prefix");
    }
    if (pageRows.length < o.limits.pageRows) return { rows: String(rows), digest: digest.digest("hex") };
  }
  throw new Error("complete projection page budget exceeded; do not accept a prefix");
}

async function capture(c: PoolClient, o: MilestoneSchemaPgOptions, chain: 74 | 80, before?: MilestoneSchemaSnapshot): Promise<MilestoneSchemaSnapshot> {
  await assertChain(c, o, chain);
  const inventory = (await c.query(`SELECT name,to_regclass(format('%I.%I',split_part(name,'.',1),split_part(name,'.',2))) IS NOT NULL AS present FROM unnest($1::text[]) t(name)`, [[...existingTables, ...newTables]])).rows;
  for (const name of existingTables) assert.equal(inventory.find(x => x.name === name)?.present, true, `missing74 prerequisite ${name}; use existing auth/domain setup`);
  for (const name of newTables) assert.equal(inventory.find(x => x.name === name)?.present, chain === 80);
  if (chain === 74) assertFixtures((await c.query<{ name: string; rows: string }>(Object.entries(requiredFixtures).map(([name, count]) =>
    `SELECT '${name}' AS name,count(*)::text AS rows FROM (SELECT 1 FROM ${relation(name)} LIMIT ${count}) fixture`).join(" UNION ALL "))).rows);
  const columns: Record<string, Column[]> = {}, totals = { rows: 0 }, rows: Record<string, RowDigest> = {};
  const metadata = (await c.query(`SELECT n.nspname||'.'||t.relname AS name,t.relrowsecurity,t.relforcerowsecurity,
    t.relowner::text AS owner,t.relacl::text[] AS "tableAcl",a.attacl::text[] AS acl,a.attcollation::text AS collation,a.attidentity AS identity,a.attgenerated AS generated,
    a.attname AS column,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull",pg_get_expr(d.adbin,d.adrelid) AS default,
    ARRAY(SELECT k.attname::text FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute k ON k.attrelid=t.oid AND k.attnum=x.num
      WHERE i.indrelid=t.oid AND i.indisprimary AND i.indisvalid AND i.indisready AND i.indimmediate ORDER BY x.ord) AS pk
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
    WHERE t.oid=ANY(ARRAY(SELECT to_regclass(format('%I.%I',split_part(name,'.',1),split_part(name,'.',2))) FROM unnest($1::text[]) x(name))) AND a.attnum>0 AND NOT a.attisdropped ORDER BY name,a.attnum`, [existingTables])).rows;
  for (const row of metadata) {
    assert.equal(row.relrowsecurity, false); assert.equal(row.relforcerowsecurity, false);
    assert.deepEqual(row.pk, primaryKeys[row.name] ?? ["id"]);
    (columns[row.name] ??= []).push({ name: row.column, type: row.type, notNull: row.notNull, default: row.default, owner: row.owner, tableAcl: row.tableAcl, acl: row.acl, collation: row.collation, identity: row.identity, generated: row.generated });
  }
  for (const name of existingTables) {
    assert(columns[name]?.length); rows[name] = await rowProjection(c, o, name, before?.columns[name] ?? columns[name]!, totals);
    await o.checkpoint(`PROJECTION_${chain}`, { table: name, ...rows[name], complete: true });
  }
  const definitions = Object.fromEntries((await c.query(`SELECT 'constraint:'||n.nspname||'.'||r.relname||':'||x.conname AS key,pg_get_constraintdef(x.oid,true) AS definition
    FROM pg_constraint x JOIN pg_class r ON r.oid=x.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE r.oid=ANY(ARRAY(SELECT to_regclass(format('%I.%I',split_part(name,'.',1),split_part(name,'.',2))) FROM unnest($1::text[]) t(name)))
    UNION ALL SELECT 'trigger:'||n.nspname||'.'||r.relname||':'||x.tgname,pg_get_triggerdef(x.oid,true)
    FROM pg_trigger x JOIN pg_class r ON r.oid=x.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE NOT x.tgisinternal AND r.oid=ANY(ARRAY(SELECT to_regclass(format('%I.%I',split_part(name,'.',1),split_part(name,'.',2))) FROM unnest($1::text[]) t(name))) ORDER BY key`, [existingTables])).rows.map(x => [x.key, x.definition]));
  const functions = (await c.query<FunctionDefinition>(`SELECT p.proname AS name,p.prosrc AS body,pg_get_functiondef(p.oid) AS definition,p.proowner::text AS owner,p.proacl::text[] AS acl,
    pg_get_function_result(p.oid) AS result,pg_get_function_identity_arguments(p.oid) AS arguments,p.prosecdef AS security,p.proisstrict AS strict,p.provolatile AS volatility,p.proconfig AS config,
    p.proparallel AS parallel,p.proleakproof AS leakproof,p.procost::text AS cost,p.prorows::text AS "resultRows"
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='zzsh_order' AND p.proname=ANY($1::text[]) ORDER BY p.proname`, [touchedFunctions])).rows;
  assert.equal(functions.length, 3);
  const permissionExceptSeed = await rowProjection(c, o, "zzsh_iam.admin_permission", before?.columns["zzsh_iam.admin_permission"] ?? columns["zzsh_iam.admin_permission"]!, totals, true);
  const seedRows = (await c.query(`SELECT to_jsonb(p)::text AS row FROM zzsh_iam.admin_permission p WHERE code=$1`, [seedCode])).rows;
  assert(seedRows.length <= 1);
  return { chain, target: { ...o.target }, columns, rows, definitions, functions, permissionExceptSeed, seed: seedRows[0]?.row ?? null };
}

export async function captureMilestoneSchema74(o: MilestoneSchemaPgOptions): Promise<MilestoneSchemaSnapshot> {
  localMigrations(o);
  const snapshot = await readOnly(o, c => capture(c, o, 74));
  await o.checkpoint("BASELINE74_COMPLETE_READ_TRANSACTION_CLOSED", snapshot); return snapshot;
}

function expectedBody(sqls: string[], name: string): string {
  let body: string | undefined;
  for (const sql of sqls) {
    const match = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION zzsh_order\\.${name}\\([^]*?AS \\$\\$([^]*?)\\$\\$;`, "i").exec(sql);
    if (match) body = match[1];
  }
  assert(body, `bound source function ${name} missing`); return body.replaceAll("\r\n", "\n");
}

function verifyDelta(before: MilestoneSchemaSnapshot, after: MilestoneSchemaSnapshot, sqls: string[]) {
  assert.equal(before.chain, 74); assert.equal(after.chain, 80);
  assert.deepEqual(after.target, before.target, "old74 evidence belongs to a different resource/role binding");
  assert.equal(before.functions.length, 3); assert.equal(after.functions.length, 3);
  for (const name of existingTables) {
    assert.deepEqual(after.columns[name]?.filter(c => !["acceptance_kind", "authorization_evidence"].includes(c.name) || name !== "zzsh_supply.rule_acceptance"), before.columns[name], `old column definition drift ${name}`);
    if (name !== "zzsh_iam.admin_permission") assert.deepEqual(after.rows[name], before.rows[name], `old-column row projection drift ${name}`);
  }
  const added = after.columns["zzsh_supply.rule_acceptance"]!.filter(c => !before.columns["zzsh_supply.rule_acceptance"]!.some(b => b.name === c.name));
  assert.deepEqual(added.map(c => c.name), ["acceptance_kind", "authorization_evidence"]);
  assert.equal(added[0]?.type, "text"); assert.equal(added[0]?.notNull, true); assert.equal(added[0]?.default, "'OWNER_ACCEPTED'::text");
  assert.equal(added[1]?.type, "jsonb"); assert.equal(added[1]?.notNull, false); assert.equal(added[1]?.default, null);
  assert.deepEqual(after.permissionExceptSeed, before.permissionExceptSeed);
  assert(after.seed);
  if (before.seed !== null) { assert.equal(after.seed, before.seed); assert.deepEqual(after.rows["zzsh_iam.admin_permission"], before.rows["zzsh_iam.admin_permission"]); }
  else {
    const s = JSON.parse(after.seed) as Record<string, unknown>;
    assert.deepEqual(Object.keys(s).sort(), ["code", "created_at", "description", "name"]);
    assert.equal(s.code, seedCode); assert.equal(s.name, "旧单续办"); assert.equal(s.description, "受权处理旧单续办与佣金成熟，财账终定独立"); assert.equal(typeof s.created_at, "string");
    assert.equal(BigInt(after.rows["zzsh_iam.admin_permission"]!.rows), BigInt(before.rows["zzsh_iam.admin_permission"]!.rows) + 1n);
  }
  const changed = [...new Set([...Object.keys(before.definitions), ...Object.keys(after.definitions)])].filter(k => before.definitions[k] !== after.definitions[k]).sort();
  assert.deepEqual(changed, expectedDefinitionChanges, "only the bound17 old-object definition deltas are allowed");
  for (const f of before.functions) {
    const next = after.functions.find(n => n.name === f.name); assert(next);
    const { body: oldBody, definition: oldDefinition, ...oldMeta } = f;
    const { body: newBody, definition: newDefinition, ...newMeta } = next;
    assert.deepEqual(newMeta, oldMeta); assert(oldDefinition && newDefinition);
    assert.equal(oldBody.replaceAll("\r\n", "\n"), expectedBody(sqls.slice(0, 74), f.name));
    assert.equal(newBody.replaceAll("\r\n", "\n"), expectedBody(sqls, f.name));
  }
}

async function assertNewTables(c: PoolClient, o: MilestoneSchemaPgOptions, initialAcl: boolean) {
  o.assertWindow();
  const empty = (await c.query(newTables.map(n => `SELECT '${n}' AS name,count(*)::text AS rows FROM ${relation(n)}`).join(" UNION ALL "))).rows;
  assert.equal(empty.length, 12); assert(empty.every(r => r.rows === "0"), "schema probes do not import financial/source facts");
  const grants = (await c.query(`SELECT n.nspname||'.'||t.relname AS name,t.relowner::text AS owner,
    pg_has_role($2::oid,t.relowner,'MEMBER') AS "runtimeOwner",acl.grantee::text AS grantee,acl.privilege_type AS privilege
    FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace LEFT JOIN LATERAL (
      SELECT x.grantee,x.privilege_type FROM aclexplode(t.relacl) x
      UNION ALL SELECT x.grantee,x.privilege_type FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped
    ) acl ON true WHERE t.oid=ANY(ARRAY(SELECT to_regclass(format('%I.%I',split_part(name,'.',1),split_part(name,'.',2))) FROM unnest($1::text[]) r(name)))`, [newTables, o.target.runtimeOid])).rows;
  assert.equal(new Set(grants.map(r => r.name)).size, 12);
  for (const row of grants) {
    assert.equal(row.owner, o.target.migrationOid); assert.equal(row.runtimeOwner, false);
    if (initialAcl && row.grantee !== null) assert.equal(row.grantee, row.owner, `nonowner initial table/column grant ${row.name}`);
  }
}

export async function verifyMilestoneSchema80(o: MilestoneSchemaPgOptions, before: MilestoneSchemaSnapshot, initialAcl: boolean): Promise<MilestoneSchemaSnapshot> {
  const source = localMigrations(o);
  assert.deepEqual(before.target, o.target);
  const after = await readOnly(o, async c => {
    const after = await capture(c, o, 80, before);
    verifyDelta(before, after, source.migrations.map(m => m.sql.join("--> statement-breakpoint")));
    assert.equal((await c.query(`SELECT count(*)::text AS bad FROM zzsh_supply.rule_acceptance WHERE acceptance_kind IS DISTINCT FROM 'OWNER_ACCEPTED' OR authorization_evidence IS NOT NULL`)).rows[0]?.bad, "0");
    await assertNewTables(c, o, initialAcl);
    return after;
  });
  await o.checkpoint("SCHEMA80_OLD_PROJECTIONS_DEFINITION_KEYS_AND_3_BODIES_READ_TRANSACTION_CLOSED", after); return after;
}

export type MilestoneAclFault = "NONE" | "MID_ACL" | "CONNECT" | "COMMIT_BEFORE" | "COMMIT_AFTER";
function faultPool(o: MilestoneSchemaPgOptions, fault: MilestoneAclFault) {
  const injected = new Error(`MILESTONE_SCHEMA_INJECTED_${fault}`);
  const trace = { migrationCommitted: false, hit: false, releases: [] as boolean[], aclCommands: [] as string[] };
  // Only the real PG client's failure boundary is replaced; Drizzle and production ACL stay intact.
  const pool = new Proxy(o.migrationPool, { get(target, key) {
    if (key !== "connect") { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; }
    return async () => {
      o.assertWindow(); const acl = trace.migrationCommitted;
      if (acl && fault === "CONNECT") { trace.hit = true; throw injected; }
      const client = await target.connect();
      try { await identity(client, o, false); } catch (error) { client.release(true); throw error; }
      return new Proxy(client, { get(c, member) {
        if (member === "release") return (discard?: boolean) => { if (acl) trace.releases.push(discard === true); return c.release(discard); };
        if (member !== "query") { const value = Reflect.get(c, member, c); return typeof value === "function" ? value.bind(c) : value; }
        return async (...args: unknown[]) => {
          const input = args[0]; const sql = typeof input === "string" ? input : String((input as { text: string }).text);
          if (!/^\s*(ROLLBACK|RELEASE)\b/i.test(sql)) o.assertWindow();
          const commit = sql.trim().toUpperCase() === "COMMIT";
          if (acl && /^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) trace.aclCommands.push(sql.trim().toUpperCase());
          if (acl && commit && fault === "COMMIT_BEFORE") { trace.hit = true; throw injected; }
          const result = await Reflect.apply(c.query, c, args);
          if (!acl && commit) trace.migrationCommitted = true;
          if (acl && commit && fault === "COMMIT_AFTER") { trace.hit = true; throw injected; }
          if (acl && fault === "MID_ACL" && sql.includes('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "zzsh_order"')) {
            trace.hit = true;
            await readOnly(o, other => assertNewTables(other, o, true));
            throw injected;
          }
          return result;
        };
      } });
    };
  } });
  return { pool, injected, trace };
}

export async function runMilestoneSchemaUpgrade(o: MilestoneSchemaPgOptions, before: MilestoneSchemaSnapshot, fault: MilestoneAclFault) {
  const source = localMigrations(o); assert(["NONE", "MID_ACL", "CONNECT", "COMMIT_BEFORE", "COMMIT_AFTER"].includes(fault));
  assert.equal(before.chain, 74); assert.deepEqual(before.target, o.target);
  assert.deepEqual(Object.keys(before.rows).sort(), existingTables);
  if (fault === "MID_ACL") assert(Number(o.migrationPool.options.max) >= 2, "mid-ACL observer needs a separately budgeted second owner connection");
  await readOnly(o, async c => {
    const n = (await c.query("SELECT count(*)::int AS count FROM zzsh_business_meta.migrations")).rows[0]?.count;
    assert(n === 74 || n === 80); await assertChain(c, o, n);
    const role = (await c.query(`SELECT r.oid::text AS oid,r.rolsuper,r.rolbypassrls,
      pg_has_role(r.oid,$2::oid,'MEMBER') AS "migrationOwner",pg_has_role(r.oid,d.datdba,'MEMBER') AS "databaseOwner"
      FROM pg_roles r CROSS JOIN pg_database d WHERE r.rolname=$1 AND d.datname=current_database()`, [o.target.runtimeRole, o.target.migrationOid])).rows[0];
    assert(role); assert.equal(role.oid, o.target.runtimeOid); assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    assert.equal(role.migrationOwner, false); assert.equal(role.databaseOwner, false);
  });
  await rollbackProbe(o, o.runtimePool, true, true, async () => undefined);
  const { pool, injected, trace } = faultPool(o, fault);
  const { releases, aclCommands } = trace;
  try {
    await runBusinessMigrations(pool, { runtimeUser: o.target.runtimeRole, migrationsFolder: source.folder });
    assert.equal(fault, "NONE", "requested fault was not reached; do not report a green skip");
    assert(trace.migrationCommitted); assert.deepEqual(aclCommands, ["BEGIN", "COMMIT"]); assert.deepEqual(releases, [false]);
    await o.checkpoint("ACL_COMMITTED", { releases, aclCommands });
    return { outcome: "ACL_COMMITTED" as const, hit: trace.hit, releases, aclCommands };
  } catch (error) {
    if (!(error instanceof BusinessMigrationAclError)) {
      await o.checkpoint("MIGRATION_OR_PROBE_FAILURE_NO_AUTOMATIC_RETRY", { fault, hit: trace.hit, migrationCommitted: trace.migrationCommitted }); throw error;
    }
    await o.checkpoint(error.outcome, { cause: error.cause === injected ? injected.message : "NON_INJECTED_FAILURE", rollbackAcknowledged: error.rollbackAcknowledged, releases, aclCommands });
    assert(trace.hit && error.cause === injected, "preserve unexpected migration/ACL failure; do not automatically retry");
    if (fault === "COMMIT_BEFORE" || fault === "COMMIT_AFTER") {
      assert.equal(error.outcome, "ACL_COMMIT_UNKNOWN"); assert.equal(error.rollbackAcknowledged, false); assert.deepEqual(releases, [true]);
      assert.deepEqual(aclCommands, ["BEGIN", "COMMIT"]);
    } else {
      assert.equal(error.outcome, "ACL_NOT_COMMITTED"); assert.equal(error.rollbackAcknowledged, fault === "MID_ACL");
      assert.deepEqual(aclCommands, fault === "MID_ACL" ? ["BEGIN", "ROLLBACK"] : []);
      assert.deepEqual(releases, fault === "MID_ACL" ? [false] : []);
    }
    // UNKNOWN is returned immediately. A separately authorized recovery caller may inspect the original outcome.
    return { outcome: error.outcome, hit: trace.hit, releases, aclCommands };
  }
}

async function rejected(c: PoolClient, o: MilestoneSchemaPgOptions, sql: string, values: unknown[], state: string) {
  o.assertWindow(); await c.query("SAVEPOINT milestone_denied");
  let caught: unknown;
  try { await c.query(sql, values); } catch (error) { caught = error; }
  try { await c.query("ROLLBACK TO SAVEPOINT milestone_denied"); await c.query("RELEASE SAVEPOINT milestone_denied"); }
  catch (closeError) {
    if (caught) throw new AggregateError([caught, closeError], "original rejection and savepoint close failure preserved", { cause: caught });
    throw closeError;
  }
  assert(caught && (caught as { code?: string }).code === state, `expected SQLSTATE ${state}; a different constraint failure does not prove authorization denial`);
}

export async function runMilestoneRuntimeAclProbes(o: MilestoneSchemaPgOptions): Promise<void> {
  localMigrations(o);
  await readOnly(o, async c => { await assertChain(c, o, 80); await assertNewTables(c, o, false); });
  await rollbackProbe(o, o.runtimePool, true, false, async c => {
    for (const n of newTables.filter(n => !n.endsWith("finance_stored_opening_review") && !n.endsWith("legacy_duty_finance_contract"))) await c.query(`SELECT 1 FROM ${relation(n)} LIMIT 0`);
    await rejected(c, o, "SELECT review_canonical FROM zzsh_order.finance_stored_opening_review LIMIT 0", [], "42501");
    await rejected(c, o, "INSERT INTO zzsh_order.legacy_duty_finance_contract(singleton,contract_version,enabled,approval_ref,approval_digest) VALUES(true,'legacy-duty-finance.v1',true,'milestone-schema-denial',$1)", ["0".repeat(64)], "42501");
    // Zero-row DML proves column ACL only, not legacy business CAS or financial completion.
    await c.query("UPDATE zzsh_order.legacy_order_duty SET amount_cents=amount_cents,maturity_at=maturity_at,revision=revision,status=status WHERE false");
    await c.query("UPDATE zzsh_order.legacy_continuation_version SET superseded_at=superseded_at WHERE false");
    await rejected(c, o, "UPDATE zzsh_order.legacy_order_duty SET settled_by=settled_by WHERE false", [], "42501");
    const permitted = (await c.query(`SELECT has_column_privilege(current_user,'zzsh_order.legacy_continuation_evidence','id','INSERT') AS id,
      has_column_privilege(current_user,'zzsh_order.legacy_continuation_evidence','source_kind','INSERT') AS kind`)).rows[0]; assert(permitted?.id && permitted.kind);
    await rejected(c, o, "INSERT INTO zzsh_order.legacy_continuation_evidence(id,source_kind) VALUES('milestone_schema_source_gate','SOURCE_IMPORT')", [], "42501");
    await rejected(c, o, "INSERT INTO zzsh_order.legacy_continuation_evidence(id,source_kind) VALUES('milestone_schema_derived_gate','DERIVED')", [], "23502");
    await o.checkpoint("RUNTIME_MINIMUM_ACL_AND_SOURCE_OWNER_GATE", { runtimeIndependentLogin: true, zeroRowDmlIsNotBusinessCas: true });
  });
  await rollbackProbe(o, o.migrationPool, false, false, async owner => {
    await assertNewTables(owner, o, false);
    // The same incomplete INSERT reaches NOT NULL only for the actual owner: it passed the owner gate.
    await rejected(owner, o, "INSERT INTO zzsh_order.legacy_continuation_evidence(id,source_kind) VALUES('milestone_schema_source_gate','SOURCE_IMPORT')", [], "23502");
    await o.checkpoint("OWNER_VALUE_GATE_PASSED_NO_SOURCE_ROW_INSERTED", { incompleteInsertRejectedByNotNull: true });
  });
}

test("milestone PG helper has no implicit resource or credential fallback and validates the52+12 scope", () => {
  assert.equal(existingTables.length, 52); assert.equal(new Set(existingTables).size, 52); assert.equal(newTables.length, 12);
  assert(existingTables.includes("zzsh_iam.admin_permission")); assert(existingTables.includes("zzsh_supply.rule_acceptance"));
  assert.equal(expectedDefinitionChanges.length, 17);
  let calls = 0;
  const o = { assertWindow() { calls++; throw new Error("WINDOW_NOT_APPROVED"); } } as unknown as MilestoneSchemaPgOptions;
  assert.throws(() => localMigrations(o), /WINDOW_NOT_APPROVED/); assert.equal(calls, 1);
});

test("missing/stale source folder cannot become a PG green skip", () => {
  const o = { apiRoot: ".", assertWindow() {}, target: { database: "zzsh_dev", oid: "931888" } } as MilestoneSchemaPgOptions;
  assert.throws(() => localMigrations(o));
});

test("catalog lookup quotes both identifiers before resolving mixed-case auth tables", async () => {
  assert.equal(relation("zzsh_auth_admin.twoFactor"), '"zzsh_auth_admin"."twoFactor"');
  assert.equal(relation("zzsh_auth_user.twoFactor"), '"zzsh_auth_user"."twoFactor"');
  const lookup = "to_regclass(format('%I.%I',split_part(name,'.',1),split_part(name,'.',2)))";
  const migrations = readMigrationFiles({ migrationsFolder: resolve("migrations/business") }).slice(0, 74);
  const reachedMetadata = new Error("CATALOG_METADATA_REACHED"); let lookups = 0;
  const c = { query: async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("SELECT hash,")) return { rows: migrations.map(m => ({ hash: m.hash, when: String(m.folderMillis) })) };
    if (sql.includes("to_regclass")) {
      assert(sql.includes(lookup)); lookups++;
      if (sql.startsWith("SELECT name,")) return { rows: (params![0] as string[]).map(name => ({ name, present: existingTables.includes(name) })) };
      throw reachedMetadata;
    }
    return { rows: Object.entries(requiredFixtures).map(([name, n]) => ({ name, rows: String(n) })) };
  } } as unknown as PoolClient;
  await assert.rejects(capture(c, { assertWindow() {} } as MilestoneSchemaPgOptions, 74), error => error === reachedMetadata);
  assert.equal(lookups, 2);
});

test("installed pg parses text-array PKs while its name-array fallback reproduces the capture failure", () => {
  const previous = Reflect.apply(types.getTypeParser, types, [1003])("{id}");
  const textArray = Reflect.apply(types.getTypeParser, types, [1009]);
  assert.equal(previous, "{id}");
  assert.throws(() => assert.deepEqual(previous, ["id"]), error => error instanceof Error && hash(error.message) === "23f3f453f791fc4133bf10b3e3bbdbe747c6c9b8267aee204fb026f6aba62561");
  assert.deepEqual(textArray("{id}"), ["id"]);
  assert.deepEqual(textArray("{account_id,schema_version}"), ["account_id", "schema_version"]);
  assert.throws(() => assert.deepEqual(textArray("{schema_version,account_id}"), primaryKeys["zzsh_supply.legacy_listing_display_snapshot"]));
});

test("bound function extraction uses the latest real migration body rather than an earlier version", () => {
  const sqls = ["CREATE FUNCTION zzsh_order.guard_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$old$$;", "CREATE OR REPLACE FUNCTION zzsh_order.guard_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$new\r\nbody$$;"];
  assert.equal(expectedBody(sqls, "guard_personal_order"), "new\nbody");
  assert.throws(() => expectedBody([], "guard_personal_order"));
});

test("full projection refuses a page prefix or corrupt row digest instead of certifying empty/equal", async () => {
  const o = { assertWindow() {}, limits: { pageRows: 1, maxRowsPerPass: 2, maxPagesPerTable: 1 } } as MilestoneSchemaPgOptions;
  const col: Column[] = [{ name: "id", type: "text", notNull: true, default: null }];
  const c = { query: async () => ({ rows: [{ digest: "a".repeat(64), cursor: '{"id":"opaque"}' }] }) } as unknown as PoolClient;
  await assert.rejects(rowProjection(c, o, "zzsh_order.finance_event", col, { rows: 0 }), /page budget/);
  const bad = { query: async () => ({ rows: [{ digest: "not-a-digest", cursor: "{}" }] }) } as unknown as PoolClient;
  await assert.rejects(rowProjection(bad, o, "zzsh_order.finance_event", col, { rows: 0 }));
  await assert.rejects(rowProjection(c, o, "zzsh_order.finance_event", col, { rows: 2 }), /row budget/);
});

test("projection keeps native PK cursor text opaque and hashes every returned row", async () => {
  const o = { assertWindow() {}, limits: { pageRows: 2, maxRowsPerPass: 5, maxPagesPerTable: 3 } } as MilestoneSchemaPgOptions;
  const cursor = '{"id":900719925474099312345}', queries: unknown[][] = [];
  let page = 0;
  const c = { query: async (_sql: string, values: unknown[]) => {
    queries.push(values); return { rows: page++ === 0 ? [{ digest: "a".repeat(64), cursor: '{"id":1}' }, { digest: "b".repeat(64), cursor }] : [] };
  } } as unknown as PoolClient;
  const result = await rowProjection(c, o, "zzsh_order.finance_event", [{ name: "id", type: "text", notNull: true, default: null }], { rows: 0 });
  assert.deepEqual(queries, [[2], [2, cursor]]); assert.equal(result.rows, "2");
  assert.equal(result.digest, hash(Buffer.concat([Buffer.from("a".repeat(64), "hex"), Buffer.from("b".repeat(64), "hex")])));
});

test("a constraint error or successful write cannot masquerade as runtime permission rejection", async () => {
  const o = { assertWindow() {} } as MilestoneSchemaPgOptions;
  for (const state of ["23502", null, "42501"]) {
    const seen: string[] = [];
    const c = { query: async (sql: string) => { seen.push(sql); if (sql === "probe" && state !== null) throw Object.assign(new Error("fixture"), { code: state }); return { rows: [] }; } } as unknown as PoolClient;
    if (state === "42501") await rejected(c, o, "probe", [], "42501");
    else await assert.rejects(rejected(c, o, "probe", [], "42501"));
    assert.deepEqual(seen.slice(-2), ["ROLLBACK TO SAVEPOINT milestone_denied", "RELEASE SAVEPOINT milestone_denied"]);
  }
});

test("every exported PG phase refuses before any pool access when the parent's window guard refuses", async () => {
  const o = { assertWindow() { throw new Error("WINDOW_NOT_APPROVED"); } } as unknown as MilestoneSchemaPgOptions;
  const before = {} as MilestoneSchemaSnapshot;
  for (const run of [() => captureMilestoneSchema74(o), () => verifyMilestoneSchema80(o, before, true), () => runMilestoneSchemaUpgrade(o, before, "NONE"), () => runMilestoneRuntimeAclProbes(o)]) {
    await assert.rejects(run, /WINDOW_NOT_APPROVED/);
  }
});

test("real frozen migration bodies are extracted without invoking the PostgreSQL runner", () => {
  const sqls = readMigrationFiles({ migrationsFolder: resolve("migrations/business") }).map(m => m.sql.join("--> statement-breakpoint"));
  for (const name of touchedFunctions) {
    const old = expectedBody(sqls.slice(0, 74), name), next = expectedBody(sqls, name);
    assert(old.length > 100 && next.length > 100); assert.notEqual(next, old);
  }
});

test("schema evidence verifier rejects altered old content, source definitions, defaults, or permission seed", () => {
  // Synthetic catalog/digest evidence tests the verifier only, never SQL or DDL/ACL success.
  const sqls = readMigrationFiles({ migrationsFolder: resolve("migrations/business") }).map(m => m.sql.join("--> statement-breakpoint"));
  const before: MilestoneSchemaSnapshot = {
    chain: 74, target: { database: "zzsh_test_fixture", oid: "40000", marker: "fixture", owner: "fixture", migrationRole: "fixture_m", migrationOid: "40001", runtimeRole: "fixture_r", runtimeOid: "40002" },
    columns: Object.fromEntries(existingTables.map(n => [n, [{ name: "id", type: "text", notNull: true, default: null }]])),
    rows: Object.fromEntries(existingTables.map(n => [n, { rows: "0", digest: hash("") }])),
    definitions: Object.fromEntries(expectedDefinitionChanges.filter(k => /:(finance_root_enabled_source_shape|finance_event_kind_check|settlement_ledger_accounts|finance_entry_guard|finance_entry_batch_guard)$/.test(k)).map(k => [k, "old"])),
    functions: touchedFunctions.map(name => ({ name, body: expectedBody(sqls.slice(0, 74), name), definition: "old", owner: "40001", acl: null, result: "trigger", arguments: "", security: false, strict: false, volatility: "v", config: null })),
    permissionExceptSeed: { rows: "0", digest: hash("") }, seed: null,
  };
  const after = structuredClone(before); after.chain = 80;
  after.columns["zzsh_supply.rule_acceptance"]!.push({ name: "acceptance_kind", type: "text", notNull: true, default: "'OWNER_ACCEPTED'::text" }, { name: "authorization_evidence", type: "jsonb", notNull: false, default: null });
  after.rows["zzsh_iam.admin_permission"] = { rows: "1", digest: "a".repeat(64) };
  after.seed = JSON.stringify({ code: seedCode, name: "旧单续办", description: "受权处理旧单续办与佣金成熟，财账终定独立", created_at: "2026-10-16T00:00:00Z" });
  after.definitions = Object.fromEntries(expectedDefinitionChanges.map(k => [k, "new"]));
  for (const f of after.functions) { f.body = expectedBody(sqls, f.name); f.definition = "new"; }
  verifyDelta(before, after, sqls);
  const changes: ((s: MilestoneSchemaSnapshot) => void)[] = [
    s => { s.rows["zzsh_order.finance_event"]!.digest = "b".repeat(64); },
    s => { s.columns["zzsh_order.finance_event"]![0]!.notNull = false; },
    s => { s.columns["zzsh_supply.rule_acceptance"]![1]!.default = "'WRONG'::text"; },
    s => { s.permissionExceptSeed.digest = "b".repeat(64); },
    s => { s.seed = null; },
    s => { s.definitions["trigger:zzsh_order.finance_event:unapproved"] = "extra"; },
    s => { s.functions[0]!.owner = "40002"; },
    s => { s.functions[0]!.acl = ["unexpected=X/unexpected"]; },
    s => { s.functions[0]!.body = "source mismatch"; },
  ];
  for (const change of changes) { const wrong = structuredClone(after); change(wrong); assert.throws(() => verifyDelta(before, wrong, sqls)); }
});

test("actual client fault adapter distinguishes post-migration acquisition and before/after COMMIT loss", async () => {
  // Transport-boundary fixtures only: no Drizzle/SQL execution is claimed by this test.
  for (const fault of ["CONNECT", "COMMIT_BEFORE", "COMMIT_AFTER"] as const) {
    const forwarded: string[] = [], released: boolean[] = [];
    const target = { database: "zzsh_test_fixture", oid: "40000", marker: "fixture", owner: "fixture", migrationRole: "fixture_m", migrationOid: "40001", runtimeRole: "fixture_r", runtimeOid: "40002" };
    const client = { query: async (sql: string) => {
      forwarded.push(sql);
      return { rows: [{ name: target.database, oid: target.oid, marker: target.marker, owner: target.owner, role: target.migrationRole, roleOid: target.migrationOid, statementBound: true, statementPositive: true, lockBound: true, lockPositive: true }] };
    }, release: (discard?: boolean) => released.push(discard === true) };
    const o = { target, assertWindow() {}, limits: { statementMs: 3000, lockMs: 500 }, migrationPool: { connect: async () => client } } as unknown as MilestoneSchemaPgOptions;
    const f = faultPool(o, fault), migration = await f.pool.connect();
    await migration.query("COMMIT"); migration.release(); assert.equal(f.trace.migrationCommitted, true);
    forwarded.length = 0;
    if (fault === "CONNECT") {
      await assert.rejects(f.pool.connect(), e => e === f.injected); assert.equal(forwarded.length, 0); assert.deepEqual(f.trace.releases, []);
    } else {
      const acl = await f.pool.connect(); await acl.query("BEGIN");
      await assert.rejects(acl.query("COMMIT"), e => e === f.injected); acl.release(true);
      assert.equal(forwarded.filter(s => s === "COMMIT").length, fault === "COMMIT_BEFORE" ? 0 : 1);
      assert.deepEqual(f.trace.aclCommands, ["BEGIN", "COMMIT"]); assert.deepEqual(f.trace.releases, [true]);
    }
    assert.equal(f.trace.hit, true); assert(!forwarded.includes("ROLLBACK")); assert.equal(released.length, fault === "CONNECT" ? 1 : 2);
  }
});

test("window expiry never blocks the owned client's rollback cleanup", async () => {
  let expired = false; const forwarded: string[] = [];
  const target = { database: "zzsh_test_fixture", oid: "40000", marker: "fixture", owner: "fixture", migrationRole: "fixture_m", migrationOid: "40001", runtimeRole: "fixture_r", runtimeOid: "40002" };
  const client = { query: async (sql: string) => { forwarded.push(sql); return { rows: [{ name: target.database, oid: target.oid, marker: target.marker, owner: target.owner, role: target.migrationRole, roleOid: target.migrationOid, statementBound: true, statementPositive: true, lockBound: true, lockPositive: true }] }; }, release() {} };
  const o = { target, assertWindow() { if (expired) throw new Error("expired"); }, limits: { statementMs: 3000, lockMs: 500 }, migrationPool: { connect: async () => client } } as unknown as MilestoneSchemaPgOptions;
  const f = faultPool(o, "NONE"), c = await f.pool.connect(); expired = true;
  await assert.rejects(c.query("SELECT 1"), /expired/); await c.query("ROLLBACK"); c.release(); assert.equal(forwarded.at(-1), "ROLLBACK");
});

test("savepoint-close failure retains the original permission error", async () => {
  const original = Object.assign(new Error("original"), { code: "42501" }), close = new Error("close");
  const c = { query: async (sql: string) => { if (sql === "probe") throw original; if (sql.startsWith("ROLLBACK TO")) throw close; return { rows: [] }; } } as unknown as PoolClient;
  await assert.rejects(rejected(c, { assertWindow() {} } as MilestoneSchemaPgOptions, "probe", [], "42501"), e => e instanceof AggregateError && e.cause === original && e.errors[1] === close);
});

test("an empty74 resource cannot pass the nonempty order/rule default upgrade fixture requirement", () => {
  assert.throws(() => assertFixtures([]), /missing74 domain fixture/);
  const rows = Object.entries(requiredFixtures).map(([name, n]) => ({ name, rows: String(n) })); assertFixtures(rows);
  for (const row of rows) {
    const missing = rows.map(r => r === row ? { ...r, rows: "0" } : r);
    assert.throws(() => assertFixtures(missing), /missing74 domain fixture/);
  }
});

test("the one proposed resource and frozen source validate locally without constructing a PG pool", () => {
  let connections = 0;
  const target = { database: "zzsh_test_order_qf80_integration", oid: "40000", marker: "fixture", owner: "fixture", migrationRole: "zzsh_order_qf80_integration_m", migrationOid: "40001", runtimeRole: "zzsh_order_qf80_integration_r", runtimeOid: "40002" };
  const pool = (user: string) => ({ options: { host: "127.0.0.1", port: 55432, database: target.database, user, connectionTimeoutMillis: 3000 }, connect() { connections++; throw new Error("unexpected offline connection"); } });
  const o = { target, apiRoot: process.cwd(), limits: { pageRows: 4096, maxRowsPerPass: 2000000, maxPagesPerTable: 512, statementMs: 3000, lockMs: 500 }, assertWindow() {}, checkpoint() {}, migrationPool: pool(target.migrationRole), runtimePool: pool(target.runtimeRole) } as unknown as MilestoneSchemaPgOptions;
  assert.equal(localMigrations(o).migrations.length, 80); assert.equal(connections, 0);
  assert.throws(() => localMigrations({ ...o, target: { ...target, database: "zzsh_test_order_another" } }));
});
