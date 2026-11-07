// A dedicated empty synthetic database and NOLOGIN roles must be created and verified by the caller.
const assert=require('node:assert/strict'),{Pool}=require('pg');
assert.equal(process.env.LEGACY_TEAM_CHAIN_SYNTH_OPT_IN,'1');
for(const name of ['LEGACY_TEAM_CHAIN_SYNTH_OID','LEGACY_TEAM_CHAIN_RUNTIME_OID','LEGACY_TEAM_CHAIN_SYSTEM_ID'])assert.match(process.env[name]??'',/^[1-9]\d*$/);
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_legacy_team_chain_synth',user:'postgres',max:2,statement_timeout:30000});
const {runBusinessMigrations}=require('../dist/src/database/business-migrations.js');
(async()=>{try{
 const identity=(await pool.query(`SELECT current_database() AS db,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
  (pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(identity,{db:'zzsh_legacy_team_chain_synth',oid:process.env.LEGACY_TEAM_CHAIN_SYNTH_OID,marker:'zzsh:legacy-team-chain:v1',system_id:process.env.LEGACY_TEAM_CHAIN_SYSTEM_ID});
 const role=(await pool.query("SELECT oid::text AS oid,rolcanlogin FROM pg_roles WHERE rolname='zzsh_legacy_team_chain_runtime'")).rows[0];
 assert.deepEqual(role,{oid:process.env.LEGACY_TEAM_CHAIN_RUNTIME_OID,rolcanlogin:false});
 await runBusinessMigrations(pool,{runtimeUser:'zzsh_legacy_team_chain_runtime',initialInstall:true,initialBaseline:'release_0151'});
 await runBusinessMigrations(pool,{runtimeUser:'zzsh_legacy_team_chain_runtime'});
 const history=(await pool.query('SELECT count(*)::int AS n,max(created_at)::text AS latest FROM zzsh_business_meta.migrations')).rows[0];
 assert.deepEqual(history,{n:23,latest:'1793730640494'});
 const privilege=(await pool.query(`SELECT has_table_privilege('zzsh_legacy_team_chain_runtime','zzsh_order.im_order_group','INSERT') AS insert_ok,
  has_column_privilege('zzsh_legacy_team_chain_runtime','zzsh_order.im_order_group','team_state','UPDATE') AS state_ok,
  has_column_privilege('zzsh_legacy_team_chain_runtime','zzsh_order.im_order_group','legacy_order_id','UPDATE') AS source_update,
  has_column_privilege('zzsh_legacy_team_chain_runtime','zzsh_order.im_order_group','payment_confirmation_id','UPDATE') AS payment_update,
  has_table_privilege('zzsh_legacy_team_chain_runtime','zzsh_order.im_order_member','DELETE') AS member_delete`)).rows[0];
 assert.deepEqual(privilege,{insert_ok:true,state_ok:true,source_update:false,payment_update:false,member_delete:false});
 console.log('legacy Team migration chain and runtime ACL checks passed in an empty synthetic database');
 }finally{await pool.end();}})().catch(error=>{console.error(error);process.exitCode=1;});
