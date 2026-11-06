/* Real two-transaction authorization revocation race; isolated synthetic PostgreSQL only. */
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true}}).outputText,file);
const {Pool,Client}=require('pg');
const {createProvisionedDistributionManagementResource}=require('../src/finance/distribution-management-resource.ts');
const {readManagementParticipants}=require('../src/finance/admin-distribution-management.ts');
const {claim}=require('./distribution-management-synthetic-resource.cjs');
const e=process.env;assert.equal(e.DISTRIBUTION_SYNTH_OPT_IN,'1');assert.equal(e.DISTRIBUTION_SYNTH_HOST,'127.0.0.1');
for(const key of ['DISTRIBUTION_SYNTH_DB','DISTRIBUTION_SYNTH_OWNER','DISTRIBUTION_SYNTH_RUNTIME'])assert.match(e[key]??'',/^[a-z][a-z0-9_]{0,62}$/);
for(const key of ['DISTRIBUTION_SYNTH_MARKER','DISTRIBUTION_SYNTH_DB_OID','DISTRIBUTION_SYNTH_SYSTEM_ID'])assert.ok(e[key]);
const opts={host:e.DISTRIBUTION_SYNTH_HOST,port:5432,database:e.DISTRIBUTION_SYNTH_DB,statement_timeout:10000,lock_timeout:1000};
const owner=new Client({...opts,user:e.DISTRIBUTION_SYNTH_OWNER,application_name:'distribution-race-owner'}),pool=new Pool({...opts,user:e.DISTRIBUTION_SYNTH_RUNTIME,max:2,application_name:'distribution-race-runtime'});
const resource=createProvisionedDistributionManagementResource({profile:'dev',database:{targetProfile:'dev',name:opts.database,user:e.DISTRIBUTION_SYNTH_RUNTIME,runtimeUser:e.DISTRIBUTION_SYNTH_RUNTIME}}),actor={userId:'ops_synth',sessionId:'session_synth',requestId:'race_request'};
(async()=>{let revoked=false,missingGrant=false,releaseLock;try{
 await owner.connect();const identity=(await owner.query(`SELECT d.oid::text oid,current_database() name,current_user owner,shobj_description(d.oid,'pg_database') marker,(pg_control_system()).system_identifier::text system_id,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid AND a.pid<>pg_backend_pid()) others FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(identity,{oid:e.DISTRIBUTION_SYNTH_DB_OID,name:e.DISTRIBUTION_SYNTH_DB,owner:e.DISTRIBUTION_SYNTH_OWNER,marker:e.DISTRIBUTION_SYNTH_MARKER,system_id:e.DISTRIBUTION_SYNTH_SYSTEM_ID,others:0});
 releaseLock=await claim(owner,e);
 assert.equal((await owner.query("SELECT count(*)::int n FROM zzsh_iam.admin_user_permission WHERE admin_user_id='ops_synth' AND permission_code='user.directory.read'")).rows[0].n,0);
 const wrapped={connect:async()=>{const c=await pool.connect();return new Proxy(c,{get(target,key){if(key==='query')return async(sql,...args)=>{const result=await target.query(sql,...args);if(sql==='COMMIT'&&!revoked){
  await owner.query("INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES('ops_synth','user.directory.read','DENY')");revoked=true;}return result;};
  const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};
 await assert.rejects(()=>readManagementParticipants(wrapped,actor,{q:'owner_synth',page:1},undefined,resource),error=>error.status===403);assert.equal(revoked,true);
 await owner.query("DELETE FROM zzsh_iam.admin_user_permission WHERE admin_user_id='ops_synth' AND permission_code='user.directory.read' AND effect='DENY'");revoked=false;
 await owner.query(`REVOKE UPDATE(active) ON zzsh_order.distribution_invite_code FROM ${e.DISTRIBUTION_SYNTH_RUNTIME}`);missingGrant=true;
 await assert.rejects(()=>readManagementParticipants(pool,actor,{q:'owner_synth',page:1},undefined,resource),error=>error.status===503);
 console.log(JSON.stringify({status:'PASS',checks:['revocation_between_read_and_response_blocks_private_rows','missing_runtime_grant_fails_closed']}));
 }finally{try{if(revoked)await owner.query("DELETE FROM zzsh_iam.admin_user_permission WHERE admin_user_id='ops_synth' AND permission_code='user.directory.read' AND effect='DENY'");if(missingGrant)await owner.query(`GRANT UPDATE(active) ON zzsh_order.distribution_invite_code TO ${e.DISTRIBUTION_SYNTH_RUNTIME}`);}finally{await pool.end();try{if(releaseLock)await releaseLock();}finally{await owner.end();}}}})().catch(err=>{console.error(err);process.exitCode=1;});
