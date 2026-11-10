import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readTargetRentalReference, verifyRuntimeRentalReference } from './business-reference-readiness.mjs';

test('target rental reference readback detects missing rules and exact numeric changes in PostgreSQL',
  { skip: !process.env.ZZSH_SYNTH_RENTAL_REFERENCE_PORT }, async () => {
    const port = process.env.ZZSH_SYNTH_RENTAL_REFERENCE_PORT, system = process.env.ZZSH_SYNTH_RENTAL_REFERENCE_SYSTEM;
    assert.match(port ?? '', /^[1-9][0-9]{3,4}$/); assert.match(system ?? '', /^[0-9]+$/);
    const { Client } = createRequire(import.meta.url)('pg');
    const client = new Client({ host: '127.0.0.1', port: Number(port), database: 'zzsh_synth_rental_reference', user: 'postgres', connectionTimeoutMillis: 3000 });
    await client.connect(); let transaction = false;
    try {
      const identity = (await client.query(`SELECT current_database() AS database,(pg_control_system()).system_identifier::text AS system,
        shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker,
        (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas`)).rows[0];
      assert.deepEqual(identity, { database: 'zzsh_synth_rental_reference', system, marker: 'zzsh:synthetic:rental-reference-v1', schemas: 0 });
      await client.query('BEGIN'); transaction = true;
      await client.query(`CREATE SCHEMA zzsh_supply;
        CREATE TABLE zzsh_supply.game(id text,code text,enabled boolean,current_release_id text);
        CREATE TABLE zzsh_supply.game_service_operation(id text,game_id text,service_code text,enabled boolean);
        CREATE TABLE zzsh_supply.rule_release(id text,game_id text,price_version_id text,term_version_id text,agreement_version_id text);
        CREATE TABLE zzsh_supply.price_version(id text,game_id text,status text,mode text,rounding_policy text,haff_rule jsonb,funding_policy jsonb);
        CREATE TABLE zzsh_supply.term_version(id text,game_id text,status text);
        CREATE TABLE zzsh_supply.agreement_version(id text,game_id text,status text,title text,body text,digest text);
        CREATE TABLE zzsh_supply.full_payout_terms_version(id text,game_id text,status text);
        CREATE TABLE zzsh_supply.billable_item(id text,game_id text,enabled boolean,unit text);
        CREATE TABLE zzsh_supply.price_line(id text,price_version_id text,item_id text,customer_tier text,pricing_kind text,unit_quantity numeric(24,0),buyer_unit_amount numeric(24,8),owner_unit_amount numeric(24,8));
        CREATE TABLE zzsh_supply.term_option(id text,version_id text,code text,daily_consumption numeric(24,0),duration_rounding text);
        CREATE ROLE zzsh_synth_rental_reader LOGIN;
        GRANT USAGE ON SCHEMA zzsh_supply TO zzsh_synth_rental_reader;
        GRANT SELECT ON ALL TABLES IN SCHEMA zzsh_supply TO zzsh_synth_rental_reader;
        INSERT INTO zzsh_supply.game VALUES ('game','delta',true,'release');
        INSERT INTO zzsh_supply.game_service_operation VALUES ('service','game','ACCOUNT_RENTAL',true);
        INSERT INTO zzsh_supply.rule_release VALUES ('release','game','price','term','agreement');
        INSERT INTO zzsh_supply.price_version VALUES ('price','game','SEALED','SPREAD','HALF_UP_CENT_V1','{"schema":"haff-ratio-v2","dailyDeltaByTermOption":{"daily":"0"}}',NULL);
        INSERT INTO zzsh_supply.term_version VALUES ('term','game','SEALED');
        INSERT INTO zzsh_supply.billable_item VALUES ('haff','game',true,'HAFF_BASE'),('item','game',true,'PIECE');
        INSERT INTO zzsh_supply.price_line VALUES ('haff-line','price','haff','STANDARD','HAFF_RATIO',NULL,NULL,NULL),('item-line','price','item','STANDARD','FIXED_UNIT',1,9007199254740993.00000000,1);
        INSERT INTO zzsh_supply.term_option VALUES ('option','term','daily',10000000,'CEIL_DAY');`);
      const body = 'fixture terms', digest = createHash('sha256').update(body).digest('hex');
      await client.query("INSERT INTO zzsh_supply.agreement_version VALUES ('agreement','game','SEALED','fixture',$1,$2)", [body, digest]);
      assert.equal((await client.query('COMMIT')).command, 'COMMIT'); transaction = false;
      const readOnly = async () => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
        try { await client.query('SET LOCAL ROLE zzsh_synth_rental_reader'); return await readTargetRentalReference(client, 'delta'); }
        finally { assert.equal((await client.query('ROLLBACK')).command, 'ROLLBACK'); transaction = false; }
      };
      const initial = await readOnly();
      assert.equal(initial.status, 'TARGET_RENTAL_REFERENCE_CHECKED'); assert.equal(initial.enabledItems, 2);
      assert.equal((await readOnly()).targetDigest, initial.targetDigest);
      const runtime = () => new Client({ host: '127.0.0.1', port: Number(port), database: 'zzsh_synth_rental_reference',
        user: 'zzsh_synth_rental_reader', application_name: 'zzsh-synth-rental-runtime', connectionTimeoutMillis: 3000 });
      const assertRuntime = async connection => {
        const row = (await connection.query("SELECT current_user AS role,current_setting('transaction_read_only') AS read_only")).rows[0];
        assert.deepEqual(row, { role: 'zzsh_synth_rental_reader', read_only: 'on' });
      };
      assert.deepEqual(await verifyRuntimeRentalReference(runtime(), initial, assertRuntime),
        { runtimeAccess: 'VERIFIED', runtimeRollbackConfirmed: true, runtimeClosed: true });
      await client.query("UPDATE zzsh_supply.price_line SET buyer_unit_amount=9007199254740993.00000001 WHERE id='item-line'");
      assert.notEqual((await readOnly()).targetDigest, initial.targetDigest);
      await assert.rejects(verifyRuntimeRentalReference(runtime(), initial, assertRuntime), /RENTAL_REFERENCE_RUNTIME_CHANGED/);
      await client.query("UPDATE zzsh_supply.price_line SET buyer_unit_amount=9007199254740993.00000000 WHERE id='item-line'");
      await client.query('REVOKE SELECT ON zzsh_supply.price_line FROM zzsh_synth_rental_reader');
      await assert.rejects(verifyRuntimeRentalReference(runtime(), initial, assertRuntime), error => error.code === '42501');
      assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='zzsh-synth-rental-runtime'")).rows[0].n, 0);
      await client.query('GRANT SELECT ON zzsh_supply.price_line TO zzsh_synth_rental_reader');
      await client.query("DELETE FROM zzsh_supply.price_line WHERE id='item-line'");
      await assert.rejects(readOnly(), /BUSINESS_RENTAL_REFERENCE_STANDARD_PRICE_MISSING/);
    } finally {
      if (transaction) assert.equal((await client.query('ROLLBACK')).command, 'ROLLBACK');
      await client.end();
    }
  });
