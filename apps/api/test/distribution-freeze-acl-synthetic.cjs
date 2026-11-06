/* Runtime ACL reapplication on the registered isolated synthetic DB; transaction rolls back. */
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true}}).outputText,file);
const {Client}=require('pg');const {applyRuntimePrivileges}=require('../src/database/business-migrations.ts');const {claim}=require('./distribution-management-synthetic-resource.cjs');
const env=process.env;assert.equal(env.DISTRIBUTION_SYNTH_OPT_IN,'1');assert.equal(env.DISTRIBUTION_SYNTH_HOST,'127.0.0.1');
for(const key of ['DISTRIBUTION_SYNTH_DB','DISTRIBUTION_SYNTH_OWNER','DISTRIBUTION_SYNTH_RUNTIME'])assert.match(env[key]??'',/^[a-z][a-z0-9_]{0,62}$/);
for(const key of ['DISTRIBUTION_SYNTH_MARKER','DISTRIBUTION_SYNTH_DB_OID','DISTRIBUTION_SYNTH_SYSTEM_ID'])assert.ok(env[key]);
const client=new Client({host:env.DISTRIBUTION_SYNTH_HOST,port:Number(env.DISTRIBUTION_SYNTH_PORT??5432),database:env.DISTRIBUTION_SYNTH_DB,user:env.DISTRIBUTION_SYNTH_OWNER,application_name:'distribution-freeze-acl-owner',statement_timeout:10000,lock_timeout:1000});
let releaseLock,inTransaction=false;
(async()=>{try{
 await client.connect();const identity=(await client.query(`SELECT d.oid::text oid,current_database() name,current_user owner,shobj_description(d.oid,'pg_database') marker,(pg_control_system()).system_identifier::text system_id,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid AND a.pid<>pg_backend_pid()) others FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(identity,{oid:env.DISTRIBUTION_SYNTH_DB_OID,name:env.DISTRIBUTION_SYNTH_DB,owner:env.DISTRIBUTION_SYNTH_OWNER,marker:env.DISTRIBUTION_SYNTH_MARKER,system_id:env.DISTRIBUTION_SYNTH_SYSTEM_ID,others:0});
 releaseLock=await claim(client,env);await client.query('BEGIN');inTransaction=true;
 await applyRuntimePrivileges(client,env.DISTRIBUTION_SYNTH_RUNTIME);
 const row=(await client.query(`SELECT has_column_privilege($1,'zzsh_order.distribution_participant','commission_frozen','UPDATE') frozen,
  has_column_privilege($1,'zzsh_order.distribution_participant','revision','UPDATE') revision,
  has_column_privilege($1,'zzsh_order.distribution_participant','eligibility','UPDATE') eligibility,
  has_column_privilege($1,'zzsh_order.distribution_participant','source_digest','UPDATE') source_digest,
  has_table_privilege($1,'zzsh_order.distribution_participant','DELETE') delete_table`,[env.DISTRIBUTION_SYNTH_RUNTIME])).rows[0];
 assert.deepEqual(row,{frozen:true,revision:true,eligibility:false,source_digest:false,delete_table:false});
 assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');inTransaction=false;
 console.log(JSON.stringify({status:'PASS',checks:['formal_acl_function','freeze_column_granted','eligibility_and_source_denied','transaction_rollback']}));
 }finally{try{if(inTransaction)await client.query('ROLLBACK');}finally{try{if(releaseLock)await releaseLock();}finally{await client.end();}}}})().catch(error=>{console.error(error);process.exitCode=1;});
