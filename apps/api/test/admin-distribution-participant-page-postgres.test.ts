import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { readAdminDistributionParticipants, type DashboardFilters } from "../src/finance/admin-distribution-dashboard";

// Runs the generated page SQL against VALUES-only fixtures in an explicitly registered read-only PG.
test("participant pages retain sorting, counts, search and visibility after page-first lookup", async () => {
  assert.equal(process.env.DISTRIBUTION_PAGE_PG_READONLY, "1");
  const path = process.env.DISTRIBUTION_PAGE_PG_CREDENTIALS;
  assert.ok(path);
  const credentials = JSON.parse(readFileSync(path, "utf8"));
  const registry = JSON.parse(readFileSync(join(dirname(path), "resource.json"), "utf8"));
  assert.equal(registry.instance.host, "127.0.0.1");
  assert.equal(credentials.database, registry.database);
  assert.equal(credentials.runtime.name, registry.roles.runtime.name);
  assert.equal(credentials.runtime.oid, registry.roles.runtime.oid);
  assert.equal(String(registry.oid), process.env.DISTRIBUTION_PAGE_PG_OID);
  assert.equal(registry.nonce, process.env.DISTRIBUTION_PAGE_PG_NONCE);
  assert.equal(registry.marker, process.env.DISTRIBUTION_PAGE_PG_MARKER);
  assert.equal(registry.instance.systemIdentifier, process.env.DISTRIBUTION_PAGE_PG_SYSTEM_ID);
  const pg = new Client({ host: registry.instance.host, port: registry.instance.port, database: credentials.database,
    user: credentials.runtime.name, password: credentials.runtime.password, application_name: "distribution_page_values_readonly",
    statement_timeout: 3000, connectionTimeoutMillis: 3000 });
  const fixture = `WITH fixture_context AS (SELECT $1::text actor,$2::boolean boss),
    fixture_participants(user_id,eligibility,commission_frozen,level_code,inviter_knowledge,leader_knowledge,invitees_knowledge,source_type,revision,policy_version_id) AS (VALUES
      ('u_a','ELIGIBLE',false,'bronze','KNOWN_NONE','KNOWN_NONE','KNOWN','LEGACY_MYSQL',1::bigint,'pv'),
      ('u_b','ELIGIBLE',false,'bronze','KNOWN_PARENT','KNOWN_PARENT','KNOWN','LEGACY_MYSQL',1::bigint,'pv'),
      ('u_c','ELIGIBLE',true,'bronze','KNOWN_PARENT','KNOWN_PARENT','UNKNOWN','LEGACY_MYSQL',2::bigint,'pv'),
      ('u_d','UNKNOWN',NULL,'bronze','UNKNOWN','UNKNOWN','KNOWN','LEGACY_MYSQL',1::bigint,'pv'),
      ('u_e','ELIGIBLE',false,'bronze','KNOWN_NONE','KNOWN_NONE','KNOWN','LEGACY_MYSQL',1::bigint,'pv')),
    fixture_users(id,name) AS (VALUES ('u_a','Alpha'),('u_b','Beta'),('u_c','Gamma'),('u_d','Delta'),('u_e','100%_Alpha')),
    fixture_policy(id,scope,schema_version,canonical_config) AS (VALUES ('pv','NATIVE','distribution-policy.v4','{"levelNames":{"bronze":"青铜"}}')),
    fixture_head(scope,current_version_id) AS (VALUES ('NATIVE','pv')),
    fixture_relations(parent_user_id,child_user_id,type) AS (VALUES
      ('u_a','u_b','INVITER'),('u_a','u_c','INVITER'),('u_a','u_b','DISTRIBUTION_LEADER'),('u_b','u_d','INVITER')),
    dashboard_records(beneficiary_id,state,amount_cents,recovery_cents) AS (VALUES
      ('u_a','SETTLED',100::bigint,0::bigint),('u_a','PENDING',50,0),('u_a','UNKNOWN',5,0),
      ('u_b','SETTLED',100,0),('u_b','PENDING',1,0),('u_c','PENDING',300,0),
      ('u_e','SETTLED',10,0),('u_e','RECOVERY_REQUIRED',0,7))`;
  const filters: DashboardFilters = { from: "2026-10-09", to: "2026-11-07", source: "ALL", state: "ALL", role: "ALL",
    q: "", page: 1, pageSize: 2, rankingBasis: "CURRENT_SETTLED_STOCK", rankingLimit: 10, sort: "recordCount", order: "desc" };
  const context = (directoryRead: boolean) => ({ actor: { userId: "admin", sessionId: "session" },
    access: { isBoss: true, permissions: new Set<string>() }, scope: { games: "ALL_GAMES", gameIds: [], network: "AVAILABLE", reasonCodes: [] },
    filterScope: "ALL", directoryRead, authorizationKey: "test" }) as any;
  async function page(options: Partial<DashboardFilters>, directoryRead = true, exactUserId?: string) {
    let actual: any[] | undefined;
    const proxy = { query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("set_config('statement_timeout'")) return { rows: [{}] };
      if (sql.includes("to_regclass('zzsh_order.rental_referral_earning')")) return { rows: [{ native: true, legacy: false, duties: false, coverage: false, native_origin: false }] };
      if (sql.includes("WITH visible_earnings AS")) return { rows: [{ native: "n", events: "e", legacy: "l", participants: "p", relations: "r", effects: "x", coverage: "c", native_birth: "b" }] };
      if (sql.includes("clock_timestamp()::text AS at")) return { rows: [{ at: "2026-11-07T00:00:00Z" }] };
      if (sql.includes("participant_amounts AS") && sql.includes("SELECT p.user_id,u.name")) {
        const at = sql.indexOf(", participant_amounts AS (");
        assert.ok(at > 0);
        const sqlWithFixtures = fixture + sql.slice(at)
          .replaceAll('zzsh_order.distribution_participant', 'fixture_participants')
          .replaceAll('zzsh_auth_user."user"', 'fixture_users')
          .replaceAll('zzsh_order.distribution_policy_version', 'fixture_policy')
          .replaceAll('zzsh_order.distribution_policy_head', 'fixture_head')
          .replaceAll('zzsh_order.invitation_relation', 'fixture_relations');
        actual = (await pg.query(sqlWithFixtures, values)).rows;
        throw new Error("PAGE_CAPTURED");
      }
      throw new Error("UNEXPECTED_QUERY");
    } };
    try { await readAdminDistributionParticipants(proxy as any, context(directoryRead), { ...filters, ...options }, undefined, undefined, exactUserId, true); }
    catch (error) { if (!(error instanceof Error) || error.message !== "PAGE_CAPTURED") throw error; }
    assert.ok(actual);
    return actual;
  }
  let begun = false;
  try {
    await pg.connect();
    await pg.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
    const identity = (await pg.query(`SELECT d.oid::text oid,shobj_description(d.oid,'pg_database') marker,
      current_setting('zzsh.regression_run',true) nonce,current_user role,r.oid::text role_oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system_id
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
    assert.equal(identity.oid, String(registry.oid)); assert.equal(identity.marker, registry.marker); assert.equal(identity.nonce, registry.nonce);
    assert.equal(identity.role, credentials.runtime.name); assert.equal(identity.role_oid, String(credentials.runtime.oid)); assert.equal(identity.system_id, registry.instance.systemIdentifier);
    const cases: Array<[Partial<DashboardFilters>, string[], number, boolean?, string?]> = [
      [{}, ["u_a", "u_b"], 5],
      [{ page: 2 }, ["u_e", "u_c"], 5],
      [{ page: 3 }, ["u_d"], 5],
      [{ order: "asc" }, ["u_d", "u_c"], 5],
      [{ sort: "settledCents" }, ["u_a", "u_b"], 5],
      [{ sort: "settledCents", order: "asc" }, ["u_c", "u_d"], 5],
      [{ sort: "pendingCents" }, ["u_c", "u_a"], 5],
      [{ sort: "pendingCents", order: "asc" }, ["u_d", "u_e"], 5],
      [{ q: "alp" }, ["u_a", "u_e"], 2],
      [{ q: "%_" }, ["u_e"], 1],
      [{ q: "Alpha" }, [], 0, false],
      [{ page: 9 }, [], 0],
      [{}, ["u_c"], 1, true, "u_c"],
    ];
    for (const [query, ids, total, directoryRead = true, exact] of cases) {
      const rows = await page(query, directoryRead, exact);
      assert.deepEqual(rows.map(row => row.user_id), ids);
      for (const row of rows) {
        assert.equal(row.total, total);
        assert.equal(row.level_name, "青铜");
        if (row.user_id === "u_a") assert.deepEqual([row.record_count, row.settled_cents, row.pending_cents, row.inviter_children, row.leader_children], ["3", "100", "50", 2, 1]);
        if (row.user_id === "u_b") assert.deepEqual([row.record_count, row.settled_cents, row.pending_cents, row.inviter_children, row.leader_children], ["2", "100", "1", 1, 0]);
        if (row.user_id === "u_d") assert.deepEqual([row.record_count, row.settled_cents, row.pending_cents], ["0", "0", "0"]);
      }
    }
  } finally {
    try { if (begun) await pg.query("ROLLBACK"); } finally { await pg.end(); }
  }
});
