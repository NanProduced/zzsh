/* Handler + real synthetic runtime-role PostgreSQL. No HTTP listener or provider is started. */
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true}}).outputText,file);
const {Pool,Client}=require('pg');
const {createProvisionedDistributionManagementResource}=require('../src/finance/distribution-management-resource.ts');
const {handleAdminDistributionManagement}=require('../src/finance/admin-distribution-management-routes.ts');
const {claim}=require('./distribution-management-synthetic-resource.cjs');
const e=process.env;assert.equal(e.DISTRIBUTION_SYNTH_OPT_IN,'1');assert.equal(e.DISTRIBUTION_SYNTH_HOST,'127.0.0.1');
for(const key of ['DISTRIBUTION_SYNTH_DB','DISTRIBUTION_SYNTH_OWNER','DISTRIBUTION_SYNTH_RUNTIME'])assert.match(e[key]??'',/^[a-z][a-z0-9_]{0,62}$/);
for(const key of ['DISTRIBUTION_SYNTH_MARKER','DISTRIBUTION_SYNTH_DB_OID','DISTRIBUTION_SYNTH_SYSTEM_ID'])assert.ok(e[key]);
const opts={host:e.DISTRIBUTION_SYNTH_HOST,port:5432,database:e.DISTRIBUTION_SYNTH_DB,statement_timeout:10000,lock_timeout:1000};
const owner=new Client({...opts,user:e.DISTRIBUTION_SYNTH_OWNER,application_name:'distribution-routes-owner'}),pool=new Pool({...opts,user:e.DISTRIBUTION_SYNTH_RUNTIME,max:2,application_name:'distribution-routes-runtime'});
const resource=createProvisionedDistributionManagementResource({profile:'dev',database:{targetProfile:'dev',name:opts.database,user:e.DISTRIBUTION_SYNTH_RUNTIME,runtimeUser:e.DISTRIBUTION_SYNTH_RUNTIME}});
const options={pool,apiOrigin:'http://api.local',adminOrigin:'http://admin.local',userOrigin:'http://user.local',distributionManagement:resource,
 adminAuth:{api:{getSession:async()=>({user:{id:'minimal_synth',twoFactorEnabled:true},session:{id:'minimal_session',locked:false}})}}};
async function invoke(method,path,body,headers={}){
 const result={status:0,json:null};const response={headersSent:false,status(code){result.status=code;return this},setHeader(){return this},json(value){result.json=value;return this},send(value){result.json=value;return this},end(){},once(){}};
 await handleAdminDistributionManagement({method,url:'/api/v1/admin/distribution/manage'+path,originalUrl:'/api/v1/admin/distribution/manage'+path,body,
  headers:{origin:'http://admin.local',cookie:'session=synthetic',...headers}},response,options);return result;
}
let releaseLock;
(async()=>{try{
 await owner.connect();const identity=(await owner.query(`SELECT d.oid::text oid,current_database() name,current_user owner,shobj_description(d.oid,'pg_database') marker,(pg_control_system()).system_identifier::text system_id,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid AND a.pid<>pg_backend_pid()) others FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(identity,{oid:e.DISTRIBUTION_SYNTH_DB_OID,name:e.DISTRIBUTION_SYNTH_DB,owner:e.DISTRIBUTION_SYNTH_OWNER,marker:e.DISTRIBUTION_SYNTH_MARKER,system_id:e.DISTRIBUTION_SYNTH_SYSTEM_ID,others:0});
 releaseLock=await claim(owner,e);
 const state=(await owner.query("SELECT password_change_required FROM zzsh_iam.admin_security WHERE admin_user_id='minimal_synth'")).rows[0];assert.equal(state.password_change_required,true);
 await owner.query("UPDATE zzsh_iam.admin_security SET password_change_required=false WHERE admin_user_id='minimal_synth'");
 const list=await invoke('GET','/participants?q=owner_synth');assert.equal(list.status,200);assert.equal(list.json.items.length,1);assert.equal(list.json.items[0].name,null);
 assert.equal((await invoke('GET','/participants?q=x',{},{origin:'http://untrusted.invalid'})).status,403);
 assert.equal((await invoke('POST','/participants/owner_synth/code',{expectedCodeId:list.json.items[0].inviteCodeId,code:'ROUTE_CODE',reason:'接口合成测试'})).status,400);
 const body={expectedCodeId:list.json.items[0].inviteCodeId,code:'ROUTE_CODE',reason:'接口合成测试'},headers={'idempotency-key':'idem_'+'d'.repeat(32)};
 const first=await invoke('POST','/participants/owner_synth/code',body,headers);assert.equal(first.status,200);assert.equal(first.json.code,'ROUTE_CODE');
 const replay=await invoke('POST','/participants/owner_synth/code',body,headers);assert.equal(replay.status,200);assert.equal(replay.json.replayed,true);
 const conflict=await invoke('POST','/participants/owner_synth/code',{...body,code:'OTHER'},headers);assert.equal(conflict.status,409);
 console.log(JSON.stringify({status:'PASS',checks:['handler_real_pg','origin_rejection','required_idempotency_key','same_key_replay','different_body_conflict','minimal_permission_redaction']}));
 }finally{await pool.end();try{if(releaseLock)await releaseLock();}finally{await owner.end();}}})().catch(err=>{console.error(err);process.exitCode=1;});
