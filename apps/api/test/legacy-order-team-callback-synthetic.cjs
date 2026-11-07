// Continues only the exact isolated worker fixture. The caller removes its database afterward.
const assert=require('node:assert/strict'),{createHash}=require('node:crypto'),Module=require('node:module');
const originalLoad=Module._load;Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return originalLoad.call(this,name,...args)};
const {Pool}=require('pg');assert.equal(process.env.LEGACY_TEAM_WORKER_SYNTH_OPT_IN,'1');
assert.match(process.env.LEGACY_TEAM_WORKER_SYNTH_OID??'',/^[1-9]\d*$/);assert.match(process.env.LEGACY_TEAM_WORKER_SYNTH_SYSTEM_ID??'',/^[1-9]\d*$/);
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_legacy_team_synth',user:'postgres',max:4,statement_timeout:10000});
const userAuth=require('../dist/src/auth/user-identity.js');userAuth.assertUserContextInTransaction=async()=>{};userAuth.assertActiveInTransaction=async()=>{};
const security=require('../dist/src/auth/security-core.js');security.recordAudit=async()=>{};
const {mountOrderImEventHandlers}=require('../dist/src/im/order-im-events.js'),{readLegacyOrderTeamAccess}=require('../dist/src/im/legacy-order-team.js');
const appId='fixture',secret='fixture-secret',order='legacy_order_'+'a'.repeat(40),clock=Date.now(),handlers={};
mountOrderImEventHandlers({getHttpAdapter:()=>({getInstance:()=>({use:(path,handler)=>{handlers[path]=handler;}})})},{pool,appId,appSecret:secret,now:()=>clock});
async function callback(account){
 const body=JSON.stringify({eventType:2,convType:'TEAM',to:'12345',fromAccount:account,msgType:'TEXT',msgTimestamp:clock,msgidClient:'fixture-message'});
 const md5=createHash('md5').update(body).digest('hex'),curtime=String(clock),checksum=createHash('sha1').update(secret+md5+curtime).digest('hex');
 let result;const response={status(){return this;},setHeader(){return this;},json(body){result=body;return this;}};
 await handlers['/api/v1/im/order-events/pre-send']({rawBody:Buffer.from(body),headers:{appkey:appId,curtime,md5,checksum}},response);
 return result;
}
(async()=>{try{
 const info=(await pool.query(`SELECT current_database() AS db,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(info,{db:'zzsh_legacy_team_synth',oid:process.env.LEGACY_TEAM_WORKER_SYNTH_OID,marker:'zzsh:legacy-team-synthetic:v1',system_id:process.env.LEGACY_TEAM_WORKER_SYNTH_SYSTEM_ID});
 const mapping=(await pool.query("SELECT account_id FROM zzsh_iam.im_identity_mapping WHERE id='buyer'")).rows[0];assert(mapping);
 assert.equal((await callback(mapping.account_id)).errCode,0,'active order allows joined renter');
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query("UPDATE zzsh_order.legacy_order_read_snapshot SET source_order_status=4,source_completed_at=now()-interval '30 days' WHERE id=$1",[order]);
  await c.query("UPDATE zzsh_order.im_order_group SET team_ready_at=now()-interval '73 hours' WHERE order_id=$1",[order]);
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 const read=await pool.connect();try{const view=await readLegacyOrderTeamAccess(read,{realm:'user',userId:'renter',sessionId:'session'},order);
  assert.equal(view.canRead,true);assert.equal(view.canSend,false);
 }finally{read.release();}
 const denied=await callback(mapping.account_id);assert.equal(denied.errCode,1);assert.equal(denied.callbackExt,'SEND_WINDOW_CLOSED');
 console.log('legacy Team pre-send window checks passed on synthetic PostgreSQL; auth and provider signatures are synthetic');
 }finally{await pool.end();}})().catch(error=>{console.error(error);process.exitCode=1;});
