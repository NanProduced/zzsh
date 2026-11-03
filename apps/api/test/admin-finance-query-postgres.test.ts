import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { scopedFinanceSql } from "../src/finance/admin-finance-query";
import { parseAdminFinanceFilters } from "../src/finance/admin-finance-read";

// Explicit PG scalar/filter smoke, not ledger, ACL or finance-service acceptance. It is outside
// the offline manifest; a missing registered resource must fail instead of becoming a green skip.
test("registered regression PG runs generated filters and exact numeric/JSONB scalars read-only", async () => {
  assert.equal(process.env.ADMIN_FINANCE_PG, "1", "ADMIN_FINANCE_PG=1 is required");
  const database = process.env.ADMIN_FINANCE_PG_DATABASE?.trim();
  assert.equal(database, "zzsh_test_regression", "only the registered regression target is accepted");
  assert.equal(process.env.DB_HOST, "127.0.0.1");
  assert.equal(Number(process.env.DB_PORT), 55432);
  const expectedOid=process.env.ZZSH_REGRESSION_DB_OID, expectedNonce=process.env.ZZSH_REGRESSION_RUN;
  assert.match(expectedOid??"", /^[0-9]+$/, "the actual current regression OID is required");
  assert.match(expectedNonce??"", /^[a-z0-9_]{12,40}$/, "the actual current run nonce is required");
  assert.ok(process.env.DB_HOST && process.env.DB_PORT && process.env.DB_USER && process.env.DB_PASSWORD, "DB connection settings are required");

  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    application_name: "admin-finance-query-pg-contract",
    max: 1,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 3_000,
    lock_timeout: 500,
  });
  let client:PoolClient|undefined, failure:unknown;
  try {
    client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal((await client.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only, "on");
    const identity = (await client.query(`SELECT current_database() AS db,current_user AS usr,d.oid::text AS oid,
      shobj_description(d.oid,'pg_database') AS marker,current_setting('zzsh.regression_run',true) AS nonce
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.equal(identity?.db, database);
    assert.equal(identity?.usr, process.env.DB_USER);
    assert.equal(identity?.oid,expectedOid);assert.equal(identity?.marker,"zzsh:regression-test:v1");assert.equal(identity?.nonce,expectedNonce);

    // The synthetic relation is only a source for the real generated SQL. No finance table is written.
    const base = `SELECT 'line_'||n AS id,
      'WALLET_AVAILABLE'::text AS account_code,
      'user_'||n AS subject_id,
      CASE WHEN n=6001 THEN E'中文%_\\\\' ELSE 'other' END::text AS subject_name,
      CASE WHEN n=6001 THEN '100000000000000000000001' ELSE '1' END::text AS delta,
      '2026-10-03T01:02:03.123456Z'::text AS at,
      jsonb_build_object('n',n,'kind','contract') AS details,
      NULL::text AS event_kind, NULL::text AS source_kind, NULL::text AS beneficiary_role,
      NULL::text AS economic_root_id, NULL::text AS earning_state, NULL::text AS source_entity,
      'source_'||n AS source_id, NULL::text AS basis_id, NULL::text AS posting_id,
      NULL::text AS order_id, 'NO_'||n AS display_no
      FROM generate_series(1,25001) n`;

    const filters = parseAdminFinanceFilters(new URLSearchParams("scope=user_6001&from=2026-10-03&to=2026-10-03"), new Date(), false);
    const scoped = scopedFinanceSql(base, "ledger", { filters }, 20001, false);
    const rows = (await client.query(scoped.text, scoped.values)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.delta, "100000000000000000000001");
    assert.deepEqual(rows[0]?.details, { n: 6001, kind: "contract" });
    assert.equal(rows[0]?.subject_id, "user_6001");
    const literal=scopedFinanceSql(base,"ledger",{filters:parseAdminFinanceFilters(new URLSearchParams("q=%25_%5C&from=2026-10-03&to=2026-10-03"),new Date(),false)},20001,false);
    assert.equal((await client.query(literal.text,literal.values)).rows.length,1);
    const exact=(await client.query(`WITH scalar_rows AS (${base}) SELECT sum(delta::numeric)::text AS total FROM scalar_rows`)).rows[0];
    assert.equal(exact.total,"100000000000000000025001");

    const otherScope = parseAdminFinanceFilters(new URLSearchParams("scope=user_missing&from=2026-10-03&to=2026-10-03"), new Date(), false);
    const other = scopedFinanceSql(base, "ledger", { filters: otherScope }, 20001, false);
    assert.equal((await client.query(other.text, other.values)).rows.length, 0);

    const later = parseAdminFinanceFilters(new URLSearchParams("scope=ALL&from=2026-10-04&to=2026-10-04"), new Date(), false);
    const laterPage = scopedFinanceSql(base, "ledger", { filters: later }, 20001, false);
    assert.equal((await client.query(laterPage.text, laterPage.values)).rows.length, 0);

    const limited = scopedFinanceSql(base, "ledger", { filters: parseAdminFinanceFilters(new URLSearchParams("scope=ALL&from=2026-10-03&to=2026-10-03"), new Date(), false) }, 2, false);
    assert.equal((await client.query(limited.text, limited.values)).rows.length, 2);
    const ceiling=scopedFinanceSql(base,"ledger",{filters:parseAdminFinanceFilters(new URLSearchParams("scope=ALL&from=2026-10-03&to=2026-10-03"),new Date(),false)},20001,false);
    assert.equal((await client.query(ceiling.text,ceiling.values)).rows.length,20001);

    // A read-only transaction rejects the write before any cleanup can pretend success.
    await client.query("SAVEPOINT finance_contract_write");
    await assert.rejects(() => client!.query("CREATE TEMP TABLE finance_contract_write_probe(id integer)"), /read-only|read only/i);
    await client.query("ROLLBACK TO SAVEPOINT finance_contract_write");
    assert.equal((await client.query("SELECT 1 AS ok")).rows[0]?.ok, 1);
  } catch(error) { failure=error; }
  finally {
    let rollbackFailed=false;
    if(client){
      try{await client.query("ROLLBACK");}catch(error){rollbackFailed=true;failure=failure?new AggregateError([failure,error],"PG test and rollback failed"):error;}
      try{client.release(rollbackFailed);}catch(error){failure=failure?new AggregateError([failure,error],"PG test and release failed"):error;}
    }
    try{await pool.end();}catch(error){failure=failure?new AggregateError([failure,error],"PG test and pool close failed"):error;}
  }
  if(failure)throw failure;
});
