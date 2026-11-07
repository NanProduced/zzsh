// Dedicated isolated synthetic database; caller verifies and removes it after this script exits.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module');
const originalLoad=Module._load;Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return originalLoad.call(this,name,...args)};
const {Pool}=require('pg');assert.equal(process.env.LEGACY_TEAM_WORKER_SYNTH_OPT_IN,'1');
assert.match(process.env.LEGACY_TEAM_WORKER_SYNTH_OID??'',/^[1-9]\d*$/);assert.match(process.env.LEGACY_TEAM_WORKER_SYNTH_SYSTEM_ID??'',/^[1-9]\d*$/);
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_legacy_team_synth',user:'postgres',max:6,statement_timeout:10000});
const auth=require('../dist/src/auth/auth-security.js'),userAuth=require('../dist/src/auth/user-identity.js');
const authorization=require('../dist/src/auth/admin-authorization.js'),scope=require('../dist/src/auth/admin-scope.js');
const security=require('../dist/src/auth/security-core.js'),dispatch=require('../dist/src/im/support-dispatch.js');
auth.assertAdminContextInTransaction=async()=>{};userAuth.assertUserContextInTransaction=async()=>{};userAuth.assertActiveInTransaction=async()=>{};
authorization.loadEffectiveAdminAccess=async()=>({status:'ACTIVE',isBoss:true,passwordChangeRequired:false,permissions:new Set(['order.read','im.support.read','im.support.accept'])});
scope.readAdminGameScope=async()=>({mode:'ALL_GAMES',gameIds:[]});security.recordAudit=async()=>{};dispatch.lockSupportMutation=async()=>({});
const team=require('../dist/src/im/legacy-order-team.js'),worker=require('../dist/src/im/order-team.js');
const {ORDER_TEAM_CONFIGURATION}=require('../dist/src/im/yunxin-provider.js'),identity=require('../dist/src/im/identity-lifecycle.js');
const app='fixture',first='legacy_order_'+'a'.repeat(40),unknown='legacy_order_'+'b'.repeat(40),actor={userId:'staff',sessionId:'session'};
function mapping(kind,subject){const realm=kind.toLowerCase(),key={provider:'yunxin',appId:app,realm,kind,platformSubjectId:subject};return {realm,kind,subject,account:identity.deriveYunxinAccountId(key),marker:identity.buildYunxinIdentityMarker(key)};}
async function prepare(){const c=await pool.connect();try{
 const info=(await c.query(`SELECT current_database() AS db,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(info,{db:'zzsh_legacy_team_synth',oid:process.env.LEGACY_TEAM_WORKER_SYNTH_OID,marker:'zzsh:legacy-team-synthetic:v1',system_id:process.env.LEGACY_TEAM_WORKER_SYNTH_SYSTEM_ID});
 await c.query('BEGIN');await c.query(fs.readFileSync('migrations/business/0173_legacy_order_im_team.sql','utf8'));await c.query("SET LOCAL session_replication_role='replica'");
 await c.query("INSERT INTO zzsh_supply.game(id,code,name) VALUES('game','fixture_game','合成游戏')");
 for(const id of ['renter','owner'])await c.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$1||'@example.invalid',now(),now())`,[id]);
 await c.query(`INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt") VALUES('staff','客服','staff@example.invalid',now(),now())`);
 for(const [index,oid] of [first,unknown].entries())await c.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
 VALUES($1,'legacy_mysql_restore','la_order',$2,repeat('a',64),'synthetic',$2,'account','game','owner','renter','1','la_rental_accounts',repeat('a',64),'2',repeat('a',64),'3',repeat('a',64),3,1,'{"is_delete":"0"}',1,repeat('a',64),'staff')`,[oid,String(index+1)]);
 for(const [id,kind,subject] of [['buyer','USER','renter'],['owner','USER','owner'],['staff','ADMIN','staff'],['system','SYSTEM','support-manager']]){const m=mapping(kind,subject);await c.query(`INSERT INTO zzsh_iam.im_identity_mapping(id,provider,app_id,realm,identity_kind,platform_subject_id,account_id,identity_marker,status) VALUES($1,'yunxin',$2,$3,$4,$5,$6,$7,'READY')`,[id,app,m.realm,m.kind,m.subject,m.account,m.marker]);}
 await c.query("SET LOCAL session_replication_role='origin'");
 for(const oid of [first,unknown])await team.requestLegacyOrderTeam(c,actor,app,oid,'fixture-request');
 await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
(async()=>{try{
 await prepare();let calls=0,input;
 const provider={async createOrderTeam(value){calls++;input=value;return {teamId:'12345',partial:false};},async readOrderTeam(teamId){return {teamId,ownerAccountId:input.ownerAccountId,teamType:1,name:input.name,membersLimit:input.membersLimit,
  serverExtension:JSON.stringify({schema:'zzsh.im-order.v1',appId:app,orderId:input.orderId}),configuration:ORDER_TEAM_CONFIGURATION,
  members:[{accountId:input.ownerAccountId,role:1,chatBanned:false},...input.memberAccountIds.map(accountId=>({accountId,role:0,chatBanned:false}))]};}};
 const options={pool,appId:app,provider,identities:{ensure:async()=>({outcome:'READY'})},membersLimit:4};
 await Promise.all([worker.advanceOrderTeam(options,first),worker.advanceOrderTeam(options,first)]);
 assert.equal(calls,1,'concurrent requests may send one CREATE');await worker.advanceOrderTeam(options,first);assert.equal(calls,1);
 const row=(await pool.query(`SELECT g.team_state,g.team_id,g.payment_confirmation_id,op.state,(SELECT count(*)::int FROM zzsh_order.im_order_member WHERE order_id=g.order_id AND state='JOINED') AS members
  FROM zzsh_order.im_order_group g JOIN zzsh_order.im_order_operation op ON op.order_id=g.order_id WHERE g.order_id=$1`,[first])).rows[0];
 assert.deepEqual(row,{team_state:'READY',team_id:'12345',payment_confirmation_id:null,state:'SUCCEEDED',members:3});
 let unknownCalls=0;const failing={...provider,async createOrderTeam(){unknownCalls++;throw Error('synthetic timeout');}};
 await worker.advanceOrderTeam({...options,provider:failing},unknown);await worker.advanceOrderTeam({...options,provider:failing},unknown);
 assert.equal(unknownCalls,1,'an unknown CREATE is not submitted again');
 const failure=(await pool.query(`SELECT g.team_state,op.state,op.sent_at IS NOT NULL AS sent FROM zzsh_order.im_order_group g JOIN zzsh_order.im_order_operation op ON op.order_id=g.order_id WHERE g.order_id=$1`,[unknown])).rows[0];
 assert.deepEqual(failure,{team_state:'NEEDS_REVIEW',state:'NEEDS_REVIEW',sent:true});
 console.log('legacy Team worker synthetic PostgreSQL checks passed; provider, identities, auth, audit and dispatch locks are mocked');
 }finally{await pool.end();}})().catch(error=>{console.error(error);process.exitCode=1;});
