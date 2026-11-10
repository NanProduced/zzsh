import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertInitialDatabaseReadback } from './install-round07-schema.mjs';
import { loadInitialTailSeedProof } from './business-initial-tail-seeds.mjs';

test('production baseline and full tail reject changed seeds, extra rows and missing comments on isolated PostgreSQL',
  {skip:!process.env.ZZSH_SYNTH_INITIAL_TAIL_PORT},async()=>{
    const port=process.env.ZZSH_SYNTH_INITIAL_TAIL_PORT,system=process.env.ZZSH_SYNTH_INITIAL_TAIL_SYSTEM,oid=process.env.ZZSH_SYNTH_INITIAL_TAIL_OID;
    assert.match(port??'',/^[1-9][0-9]{3,4}$/);assert.match(system??'',/^[1-9][0-9]*$/);assert.match(oid??'',/^[1-9][0-9]*$/);
    const migrations=join(dirname(fileURLToPath(import.meta.url)),'../../apps/api/migrations'),read=path=>readFileSync(join(migrations,path));
    const sha=value=>createHash('sha256').update(value).digest('hex');
    const baseline=JSON.parse(read('initial/release_production_0174/manifest.json'));
    const baselineBytes=read('initial/release_production_0174/CANONICAL-SEED-PROOF.json'),baselineProof=JSON.parse(baselineBytes);
    const journalBytes=read('business/meta/_journal.json'),journal=JSON.parse(journalBytes);
    const proofKey=`initial/seed-contracts/${baseline.baseline}.json`;
    const hashes=Object.fromEntries(journal.entries.map(row=>[`business/${row.tag}.sql`,sha(read(`business/${row.tag}.sql`))]));hashes[proofKey]=sha(read(proofKey));
    const expected=loadInitialTailSeedProof(migrations,baseline,baselineBytes,journalBytes,hashes);
    const commentMigrations=journal.entries.filter(row=>row.tag.endsWith('_initial_tail_comments'));
    assert.equal(commentMigrations.length,1);
    const {Client}=createRequire(import.meta.url)('pg'),client=new Client({host:'127.0.0.1',port:Number(port),database:'zzsh_test_initial_target',user:'postgres',connectionTimeoutMillis:3000});
    await client.connect();let begun=false;
    try{
      const identity=(await client.query(`SELECT current_database() AS database,d.oid::text,shobj_description(d.oid,'pg_database') AS marker,
        (pg_control_system()).system_identifier::text AS system FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
      assert.deepEqual(identity,{database:'zzsh_test_initial_target',oid,marker:'zzsh:synthetic:initial-target-proof:v1',system});
      const before=(await client.query(`SELECT col_description('zzsh_iam.im_support_presence'::regclass,a.attnum) AS value FROM pg_attribute a
        WHERE a.attrelid='zzsh_iam.im_support_presence'::regclass AND a.attname='auth_session_id'`)).rows[0].value;
      await client.query('BEGIN');begun=true;
      await client.query('COMMENT ON COLUMN zzsh_iam.im_support_presence.auth_session_id IS NULL');
      await assert.rejects(assertInitialDatabaseReadback(client,baseline,baselineProof,expected.tables),/SCHEMA_CHINESE_COMMENTS_INCOMPLETE/);
      await client.query(read(`business/${commentMigrations[0].tag}.sql`).toString('utf8'));
      const good=await assertInitialDatabaseReadback(client,baseline,baselineProof,expected.tables);
      assert.equal(good.status,'INITIAL_SEEDS_AND_COMMENTS_VERIFIED');assert.equal(good.seedTables,expected.tables?Object.keys(expected.tables).length:0);
      await client.query('SAVEPOINT nonseed_tail');
      await client.query('CREATE TABLE zzsh_order.synthetic_nonseed_tail (id text)');
      await client.query("COMMENT ON TABLE zzsh_order.synthetic_nonseed_tail IS '测试新增结构'");
      await client.query("COMMENT ON COLUMN zzsh_order.synthetic_nonseed_tail.id IS '测试标识'");
      assert.equal((await assertInitialDatabaseReadback(client,baseline,baselineProof,expected.tables)).status,'INITIAL_SEEDS_AND_COMMENTS_VERIFIED');
      await client.query('ROLLBACK TO SAVEPOINT nonseed_tail');
      await client.query('SAVEPOINT changed_policy');
      await client.query('UPDATE zzsh_order.opening_auto_confirm_policy SET wait_minutes=41,revision=revision+1 WHERE singleton');
      await assert.rejects(assertInitialDatabaseReadback(client,baseline,baselineProof,expected.tables),/SCHEMA_SEED_ROWS_DRIFT:zzsh_order.opening_auto_confirm_policy/);
      await client.query('ROLLBACK TO SAVEPOINT changed_policy');
      await client.query('SAVEPOINT extra_permission');
      await client.query(`INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES('synthetic.proof.extra','测试','验证额外权限')`);
      await assert.rejects(assertInitialDatabaseReadback(client,baseline,baselineProof,expected.tables),/SCHEMA_SEED_COUNT_DRIFT:zzsh_iam.admin_permission/);
      await client.query('ROLLBACK TO SAVEPOINT extra_permission');
      await client.query('SAVEPOINT missing_permission');
      const removed=await client.query(`DELETE FROM zzsh_iam.admin_role_permission WHERE role_id='role_preset_ops' AND permission_code='admin.permission.read'`);
      assert.equal(removed.rowCount,1);
      await assert.rejects(assertInitialDatabaseReadback(client,baseline,baselineProof,expected.tables),/SCHEMA_SEED_COUNT_DRIFT:zzsh_iam.admin_role_permission/);
      await client.query('ROLLBACK TO SAVEPOINT missing_permission');
      await client.query('SAVEPOINT extra_business');
      await client.query(`INSERT INTO zzsh_supply.game(id,code,name) VALUES('synthetic-proof-game','syntheticproof','测试')`);
      await assert.rejects(assertInitialDatabaseReadback(client,baseline,baselineProof,expected.tables),/SCHEMA_UNEXPECTED_INITIAL_BUSINESS_ROWS:zzsh_supply.game/);
      await client.query('ROLLBACK TO SAVEPOINT extra_business');
      await client.query('SAVEPOINT unknown_schema');
      await client.query('CREATE SCHEMA zzsh_synthetic_extra');
      await assert.rejects(assertInitialDatabaseReadback(client,baseline,baselineProof,expected.tables),/SCHEMA_UNEXPECTED_BUSINESS_SCHEMA/);
      await client.query('ROLLBACK TO SAVEPOINT unknown_schema');
      const runtime=(await client.query(`SELECT has_schema_privilege('zzsh_initial_synth_runtime','zzsh_iam','USAGE') AS usage,
        has_schema_privilege('zzsh_initial_synth_runtime','zzsh_iam','CREATE') AS create,
        has_table_privilege('zzsh_initial_synth_runtime','zzsh_order.opening_auto_confirm_policy','SELECT') AS policy_read`)).rows[0];
      assert.deepEqual(runtime,{usage:true,create:false,policy_read:true});
      assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');begun=false;
      assert.equal((await client.query(`SELECT col_description('zzsh_iam.im_support_presence'::regclass,a.attnum) AS value FROM pg_attribute a
        WHERE a.attrelid='zzsh_iam.im_support_presence'::regclass AND a.attname='auth_session_id'`)).rows[0].value,before);
    }finally{if(begun)assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');await client.end();}
  });
