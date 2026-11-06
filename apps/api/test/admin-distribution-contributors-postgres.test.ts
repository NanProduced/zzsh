import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { contributorSourceSql } from '../src/finance/admin-distribution-dashboard';

// Explicit opt-in outside the offline manifest: absent resource binding is a failure, not a pass.
test('contributor matching counts invited people once and rejects unconfirmed earnings', async () => {
 assert.equal(process.env.DISTRIBUTION_CONTRIBUTOR_READONLY,'1','explicit read-only PG opt-in required');
 const credentialPath=process.env.DISTRIBUTION_CONTRIBUTOR_PG_CREDENTIALS;
 const host=process.env.DISTRIBUTION_CONTRIBUTOR_PG_HOST,port=Number(process.env.DISTRIBUTION_CONTRIBUTOR_PG_PORT);
 const expectedOid=process.env.DISTRIBUTION_CONTRIBUTOR_PG_OID,expectedNonce=process.env.DISTRIBUTION_CONTRIBUTOR_PG_NONCE,expectedMarker=process.env.DISTRIBUTION_CONTRIBUTOR_PG_MARKER;
 assert.ok(credentialPath,'registered credentials path required');assert.equal(host,'127.0.0.1');assert.ok(Number.isInteger(port)&&port>0&&port<65536);
 assert.match(expectedOid??'',/^[0-9]+$/);assert.match(expectedNonce??'',/^[a-z0-9_]{12,40}$/);assert.ok(expectedMarker);
 const credentials=JSON.parse(readFileSync(credentialPath,'utf8')),registry=JSON.parse(readFileSync(join(dirname(credentialPath),'resource.json'),'utf8'));
 assert.equal(String(registry.oid),expectedOid);assert.equal(registry.nonce,expectedNonce);assert.equal(registry.marker,expectedMarker);
 assert.equal(credentials.database,registry.database);assert.equal(credentials.runtime.name,registry.roles.runtime.name);assert.equal(credentials.runtime.oid,registry.roles.runtime.oid);
 const client=new Client({host,port,database:credentials.database,user:credentials.runtime.name,password:credentials.runtime.password,application_name:'distribution_contributor_synthetic_readonly',statement_timeout:10000,connectionTimeoutMillis:3000});
 let begun=false;
 try{
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only,'on');
  const identity=(await client.query(`SELECT d.oid::text oid,shobj_description(d.oid,'pg_database') marker,current_setting('zzsh.regression_run',true) nonce,current_user role,r.oid::text role_oid FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
  assert.equal(identity.oid,expectedOid);assert.equal(identity.marker,expectedMarker);assert.equal(identity.nonce,expectedNonce);assert.equal(identity.role,credentials.runtime.name);assert.equal(identity.role_oid,String(credentials.runtime.oid));
  const source=contributorSourceSql(true,true,'TRUE','$1'),start=source.indexOf(',\n    contributor_records AS MATERIALIZED');assert.ok(start>0);
  const tail=source.slice(start).replaceAll('zzsh_order.invitation_relation','fixture_relations');
  const sql=`WITH dashboard_records(beneficiary_id,party_user_id,state,amount_cents,source_valid,contributor_confirmed) AS (VALUES
    ('A','B','PENDING',100::numeric,true,true),('A','B','SETTLED',200,true,true),
    ('A','C','SETTLED',100,true,true),('A','D','REVOKED',100,true,true),('A','E','EXPIRED',100,true,true),
    ('A','F','PENDING',0,true,true),('A','G','PENDING',100,true,false),('A','H','SETTLED',100,false,true),
    ('A','I','RECOVERY_REQUIRED',100,true,true),('A','J','SETTLED',100,true,true)),
   fixture_relations(id,type,parent_user_id,child_user_id,commission_frozen) AS (VALUES
    ('b','INVITER','A','B',true),('c','INVITER','A','C',false),('d','INVITER','A','D',false),('e','INVITER','A','E',false),
    ('f','INVITER','A','F',false),('g','INVITER','A','G',false),('h','INVITER','A','H',false),('i','INVITER','A','I',false),
    ('j','INVITER','X','J',false),('leader','DISTRIBUTION_LEADER','A','J',false)) ${tail}
   SELECT ARRAY(SELECT child_user_id FROM contributor_users ORDER BY child_user_id) people,
     EXISTS(SELECT 1 FROM contributor_uncertain WHERE beneficiary_id='A') uncertain,
     (SELECT count(DISTINCT child_user_id)::int FROM fixture_relations WHERE type='INVITER' AND parent_user_id='A') invitations,
     EXISTS(SELECT 1 FROM fixture_relations WHERE type='INVITER' AND parent_user_id='A' AND child_user_id='B' AND commission_frozen) includes_frozen`;
  const result=(await client.query(sql)).rows[0];assert.deepEqual(result.people,['B','C']);assert.equal(result.uncertain,true);assert.equal(result.invitations,8);assert.equal(result.includes_frozen,true);
  const begin=source.indexOf('bool_and(d.maturity_at IS NOT NULL AND ('),end=source.indexOf(')) finalized',begin);assert.ok(begin>0&&end>begin);
  const finalized=source.slice(begin,end+2).replaceAll('zzsh_order.legacy_order_duty_admission','fixture_admissions').replaceAll('zzsh_order.legacy_continuation_version','fixture_versions').replaceAll('zzsh_order.legacy_order_duty_revision','fixture_revisions');
  const finalSql=`WITH fixture_duties(id,order_id,source_record_id,counterparty_user_id,amount_cents,maturity_at,admission_id,continuation_version_id) AS (VALUES
    ('provisional','o1','1','u',100::numeric,NULL::timestamptz,NULL::text,NULL::text),
    ('admitted','o2','2','u',100,'2026-11-10T00:00:00Z'::timestamptz,'a2',NULL),
    ('created','o3','3','u',100,'2026-11-10T00:00:00Z',NULL,'v3'),
    ('revised','o4','4','u',100,'2026-11-10T00:00:00Z',NULL,NULL),
    ('wrong_amount','o5','5','u',100,'2026-11-10T00:00:00Z',NULL,NULL)),
   fixture_admissions(id,duty_id,order_id,source_record_id,counterparty_user_id,amount_cents,maturity_at) AS (VALUES
    ('a2','admitted','o2','2','u',100::numeric,'2026-11-10T00:00:00Z'::timestamptz)),
   fixture_versions(id,order_id,command) AS (VALUES ('v3','o3','CONFIRM'),('v4','o4','CONFIRM'),('v5','o5','CONFIRM')),
   fixture_revisions(duty_id,source_command_version_id,reason,after_values) AS (VALUES
    ('revised','v4','CONFIRM_FINAL_AMOUNT','{"amountCents":"100","maturityAt":"2026-11-10T00:00:00Z"}'::jsonb),
    ('wrong_amount','v5','CONFIRM_FINAL_AMOUNT','{"amountCents":"99","maturityAt":"2026-11-10T00:00:00Z"}'::jsonb))
   SELECT d.id,${finalized} AS confirmed FROM fixture_duties d
   GROUP BY d.id,d.order_id,d.source_record_id,d.counterparty_user_id,d.amount_cents,d.maturity_at,d.admission_id,d.continuation_version_id ORDER BY d.id`;
  const rows=(await client.query(finalSql)).rows;assert.deepEqual(Object.fromEntries(rows.map(r=>[r.id,r.confirmed])),{admitted:true,created:true,provisional:false,revised:true,wrong_amount:false});
 }finally{try{if(begun)await client.query('ROLLBACK');}finally{await client.end();}}
});
