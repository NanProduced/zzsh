// Only the registered, isolated synthetic PostgreSQL resource is accepted. Every change rolls back.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(name,...args){if(name==='sharp')return function(){throw Error('unused synthetic media')};return originalLoad.call(this,name,...args)};
const {Pool}=require('pg');
assert.equal(process.env.LEGACY_TEAM_SYNTH_OPT_IN,'1');
assert.match(process.env.LEGACY_TEAM_SYNTH_OID??'',/^[1-9]\d*$/);assert.match(process.env.LEGACY_TEAM_SYNTH_SYSTEM_ID??'',/^[1-9]\d*$/);
const pool=new Pool({host:'127.0.0.1',port:5432,database:'zzsh_test_order_settlement_closure',user:'postgres',max:1,statement_timeout:10000});
const auth=require('../dist/src/auth/auth-security.js'),userAuth=require('../dist/src/auth/user-identity.js');
const authorization=require('../dist/src/auth/admin-authorization.js'),scope=require('../dist/src/auth/admin-scope.js');
const security=require('../dist/src/auth/security-core.js'),dispatch=require('../dist/src/im/support-dispatch.js');
auth.assertAdminContextInTransaction=async()=>{};userAuth.assertUserContextInTransaction=async()=>{};
authorization.loadEffectiveAdminAccess=async()=>({status:'ACTIVE',isBoss:true,passwordChangeRequired:false,permissions:new Set(['order.read','im.support.read','im.support.accept'])});
scope.readAdminGameScope=async()=>({mode:'ALL_GAMES',gameIds:[]});security.recordAudit=async()=>{};dispatch.lockSupportMutation=async()=>({});
const team=require('../dist/src/im/legacy-order-team.js'),access=require('../dist/src/im/order-team-access.js');
const identity=require('../dist/src/im/identity-lifecycle.js');
const app='fixture',order='legacy_order_'+'a'.repeat(40),second='legacy_order_'+'b'.repeat(40);
const admin={userId:'staff',sessionId:'session'},user=(userId)=>({realm:'user',userId,sessionId:'session'});
function mapping(kind,subject){const realm=kind.toLowerCase(),key={provider:'yunxin',appId:app,realm,kind,platformSubjectId:subject};return {realm,kind,subject,account:identity.deriveYunxinAccountId(key),marker:identity.buildYunxinIdentityMarker(key)};}
(async()=>{
 const c=await pool.connect();try{
  const info=(await c.query(`SELECT current_database() AS db,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,
    (pg_control_system()).system_identifier::text AS system_id FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(info,{db:'zzsh_test_order_settlement_closure',oid:process.env.LEGACY_TEAM_SYNTH_OID,marker:'zzsh:synthetic-settlement-test:v1',system_id:process.env.LEGACY_TEAM_SYNTH_SYSTEM_ID});
  await c.query('BEGIN');await c.query(fs.readFileSync('migrations/business/0173_legacy_order_im_team.sql','utf8'));
  await c.query("SET LOCAL session_replication_role='replica'");
  await c.query("INSERT INTO zzsh_supply.game(id,code,name) VALUES('game','fixture_game','合成游戏')");
  for(const id of ['renter','owner'])await c.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES($1,$1,$1||'@example.invalid',now(),now())`,[id]);
  await c.query(`INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt") VALUES('staff','客服','staff@example.invalid',now(),now())`);
  for(const [index,oid] of [order,second].entries())await c.query(`INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,source_completed_at,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
    VALUES($1,'legacy_mysql_restore','la_order',$2,repeat('a',64),'synthetic',$2,'account','game','owner','renter','1','la_rental_accounts',repeat('a',64),'2',repeat('a',64),'3',repeat('a',64),4,1,now()-interval '1 month','{"is_delete":"0"}',1,repeat('a',64),'staff')`,[oid,String(index+1)]);
  const entries=[['buyer','USER','renter'],['owner','USER','owner'],['staff','ADMIN','staff'],['system','SYSTEM','support-manager']];
  for(const [id,kind,subject] of entries){const m=mapping(kind,subject);await c.query(`INSERT INTO zzsh_iam.im_identity_mapping(id,provider,app_id,realm,identity_kind,platform_subject_id,account_id,identity_marker,status)
    VALUES($1,'yunxin',$2,$3,$4,$5,$6,$7,'READY')`,[id,app,m.realm,m.kind,m.subject,m.account,m.marker]);}
  await c.query(`INSERT INTO zzsh_order.im_order_group(order_id,legacy_order_id,payment_confirmation_id,app_id,provision_state,assigned_admin_id,assigned_at,responsible_admin_id,
    team_state,system_identity_id,team_name,members_limit,team_id,team_ready_at) VALUES($1,$1,NULL,$2,'ASSIGNED','staff',now(),'staff','READY','system','fixture',4,'123',now())`,[order,app]);
  for(const [identityId,party] of [['buyer','BUYER'],['owner','OWNER'],['staff','STAFF']])await c.query(`INSERT INTO zzsh_order.im_order_member(order_id,app_id,identity_id,party,state,joined_at) VALUES($1,$2,$3,$4,'JOINED',now())`,[order,app,identityId,party]);
  await c.query("SET LOCAL session_replication_role='origin'");
  for(const id of ['renter','owner']){const view=await team.readLegacyOrderTeamAccess(c,user(id),order,'send');assert.equal(view.canSend,true);assert.equal(view.origin,'LEGACY');}
  await assert.rejects(team.readLegacyOrderTeamAccess(c,user('outsider'),order),e=>e.status===403);
  assert.equal((await team.readLegacyOrderTeamAccess(c,{realm:'admin',...admin},order)).canRead,true);
  assert.equal((await team.listJoinedLegacyOrderTeams(c,user('renter'),app,'renter',null,20)).items.length,1);
  assert.equal((await team.listJoinedLegacyOrderTeams(c,user('owner'),app,'owner',null,20)).items.length,1);
  const adminList=await access.listJoinedOrderTeams(c,{realm:'admin',...admin},null,20,app);
  assert.equal(adminList.items.length,1);assert.equal(adminList.items[0].origin,'LEGACY');
  const buyer=mapping('USER','renter');assert.equal(await access.recordOrderGroupMessage(c,app,`${buyer.account}|2|123`,'合成消息'),true);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.im_order_unread WHERE order_id=$1',[order])).rows[0].n,2);
  assert.equal((await access.markOrderGroupRead(c,app,order,{realm:'user',userId:'owner',sessionId:'session'})).unreadCount,0);
  const first=await team.requestLegacyOrderTeam(c,admin,app,second,'request');assert.equal(first.created,true);assert.equal(first.assignedToCurrentOperator,true);
  assert.equal((await team.requestLegacyOrderTeam(c,admin,app,second,'replay')).created,false);
  assert.equal((await c.query('SELECT count(*)::int AS n FROM zzsh_order.im_order_group WHERE order_id=$1',[second])).rows[0].n,1);
  console.log('legacy Team synthetic PostgreSQL checks passed; auth, audit and dispatch locks are mocked');
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
