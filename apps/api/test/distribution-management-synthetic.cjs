/* Explicit opt-in, disposable synthetic PostgreSQL only. Never points at an existing app database. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true}}).outputText,file);
const {Pool,Client}=require('pg');
const {createHash}=require('node:crypto');
const {canonicalize}=require('../src/supply/content-hash.ts');
const {createProvisionedDistributionManagementResource,createRegisteredR06DistributionManagementPreview,assertDistributionManagementAssembly,assertDistributionManagementResource}=require('../src/finance/distribution-management-resource.ts');
const {createRegisteredLocalNativeDistributionReadScope}=require('../src/finance/distribution-policy-store.ts');
const {readManagementParticipants,changeDistributionLevelPolicy,changeParticipantLevel,rotateParticipantInviteCode}=require('../src/finance/admin-distribution-management.ts');
const {resolveCurrentInviteCode,readCurrentInviteCodes}=require('../src/finance/distribution-invite-code.ts');
const {freezePaymentDistributionBasis}=require('../src/finance/distribution-payment-basis.ts');
const {prepareAccrualFromFrozenPayment}=require('../src/finance/distribution-accrual.ts');
const {claim}=require('./distribution-management-synthetic-resource.cjs');
const env=process.env;
assert.equal(env.DISTRIBUTION_SYNTH_OPT_IN,'1');
for(const key of ['DISTRIBUTION_SYNTH_HOST','DISTRIBUTION_SYNTH_DB','DISTRIBUTION_SYNTH_OWNER','DISTRIBUTION_SYNTH_RUNTIME','DISTRIBUTION_SYNTH_MARKER','DISTRIBUTION_SYNTH_DB_OID','DISTRIBUTION_SYNTH_SYSTEM_ID'])assert.ok(env[key],key);
assert.match(env.DISTRIBUTION_SYNTH_DB,/^[a-z][a-z0-9_]{0,62}$/);
for(const key of ['DISTRIBUTION_SYNTH_OWNER','DISTRIBUTION_SYNTH_RUNTIME'])assert.match(env[key],/^[a-z][a-z0-9_]{0,62}$/);
assert.equal(env.DISTRIBUTION_SYNTH_HOST,'127.0.0.1');
const connection={host:env.DISTRIBUTION_SYNTH_HOST,database:env.DISTRIBUTION_SYNTH_DB,port:Number(env.DISTRIBUTION_SYNTH_PORT??5432),statement_timeout:10000,lock_timeout:1000};
const owner=new Client({...connection,user:env.DISTRIBUTION_SYNTH_OWNER,application_name:'distribution-synthetic-owner'});
const pool=new Pool({...connection,user:env.DISTRIBUTION_SYNTH_RUNTIME,max:2,application_name:'distribution-synthetic-runtime'});
const actor={userId:'ops_synth',sessionId:'session_synth',requestId:'synth_request'},denied={userId:'denied_synth',sessionId:'denied_session',requestId:'synth_denied'};
let releaseLock;
const sha=s=>createHash('sha256').update(s).digest('hex');
const codeDigest=sha('synthetic-code');
let resource,makePreview;
if(env.DISTRIBUTION_SYNTH_PREVIEW==='1'){
 assert.equal(connection.port,55432);assert.equal(connection.database,'zzsh_test_regression');assert.equal(env.DISTRIBUTION_SYNTH_OWNER,'zzsh');assert.equal(env.DISTRIBUTION_SYNTH_RUNTIME,'zzsh_regression_runtime');
 assert.match(env.DISTRIBUTION_SYNTH_NONCE??'',/^[a-f0-9]{24}$/);assert.match(env.DISTRIBUTION_SYNTH_MIGRATION_OID??'',/^[1-9]\d*$/);
 const origins={apiOrigin:'http://127.0.0.1:4232',userOrigin:'http://127.0.0.1:4230',adminOrigin:'http://127.0.0.1:4231',secureCookies:false,testOperationsEnabled:false};
 const config={profile:'test',provider:'fake',host:'127.0.0.1',port:4232,testOperationsEnabled:false,database:{target:'local-compose',targetProfile:'test',host:'127.0.0.1',port:55432,name:connection.database,user:env.DISTRIBUTION_SYNTH_RUNTIME,runtimeUser:env.DISTRIBUTION_SYNTH_RUNTIME}};
 const baseBinding={database:connection.database,resourceOid:Number(env.DISTRIBUTION_SYNTH_DB_OID),nonce:env.DISTRIBUTION_SYNTH_NONCE,marker:env.DISTRIBUTION_SYNTH_MARKER,owner:env.DISTRIBUTION_SYNTH_OWNER,ownerOid:Number(env.DISTRIBUTION_SYNTH_OWNER_OID),migrationRole:'zzsh_regression_migration',migrationRoleOid:Number(env.DISTRIBUTION_SYNTH_MIGRATION_OID),runtimeRole:env.DISTRIBUTION_SYNTH_RUNTIME,runtimeRoleOid:Number(env.DISTRIBUTION_SYNTH_RUNTIME_OID)};
 makePreview=patch=>{const binding={...baseBinding,...patch},readScope=createRegisteredLocalNativeDistributionReadScope(config,binding,origins),swap={status:'COMMIT_ACK',commitAck:true,registrationAck:true,unlockAck:true,maintenanceClosed:true,stageOid:binding.resourceOid,targetIdentity:{database:binding.database,oid:binding.resourceOid,marker:binding.marker,nonce:binding.nonce,owner:binding.owner,ownerOid:binding.ownerOid,migrationRole:binding.migrationRole,migrationRoleOid:binding.migrationRoleOid,runtimeRole:binding.runtimeRole,runtimeRoleOid:binding.runtimeRoleOid,read_only:'on',rollbackAck:true,clientClosed:true}},bytes=Buffer.from(JSON.stringify(swap));
  const value=createRegisteredR06DistributionManagementPreview({enabled:true,config,binding,readScope,origins,swapProof:{bytes,sha256:sha(bytes)}});assertDistributionManagementAssembly(value,readScope,origins);return value;};
 resource=makePreview({});
}else resource=createProvisionedDistributionManagementResource({profile:'dev',database:{targetProfile:'dev',name:connection.database,user:env.DISTRIBUTION_SYNTH_RUNTIME,runtimeUser:env.DISTRIBUTION_SYNTH_RUNTIME}});
const base={schema:'distribution-policy.v3',scope:'NATIVE',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,accountModes:['ordinary'],minimumAccrualCents:'1',settlementDelayDays:7,
 levels:[{code:'legacy_1',rank:1,default:true,renterPercent:'5',ownerPercent:'5',upgrade:null},{code:'legacy_2',rank:2,default:false,renterPercent:'10',ownerPercent:'10',upgrade:null}],
 legacySource:{receiptSha256:'a'.repeat(64),configurationSha256:'b'.repeat(64),levelsSha256:'c'.repeat(64),levelNames:{legacy_1:'默认',legacy_2:'进阶'}}};
const request=(id,rev,command)=>({expectedPolicyId:id,expectedRevision:rev,command,reason:'合成测试原因'});
async function setup(){
 await owner.connect();
 const row=(await owner.query(`SELECT current_database() AS name,current_user AS owner,d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,(pg_control_system()).system_identifier::text AS system_id,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid AND a.pid<>pg_backend_pid()) AS other_connections
  FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(row,{name:env.DISTRIBUTION_SYNTH_DB,owner:env.DISTRIBUTION_SYNTH_OWNER,oid:env.DISTRIBUTION_SYNTH_DB_OID,marker:env.DISTRIBUTION_SYNTH_MARKER,system_id:env.DISTRIBUTION_SYNTH_SYSTEM_ID,other_connections:0});
 releaseLock=await claim(owner,env);
 const prior=(await owner.query('SELECT count(*)::int n FROM zzsh_auth_admin."user"')).rows[0].n;
 if(prior!==0){
  assert.equal(prior,2);
  const state=(await owner.query(`SELECT (SELECT count(*)::int FROM zzsh_order.distribution_participant) participants,
   (SELECT current_version_id FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE') policy,
   (SELECT count(*)::int FROM zzsh_order.distribution_invite_code WHERE id='old_code' AND active) old_code,
   (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE action IN('distribution.invite_code.changed','distribution.level.changed','distribution.participant.level_changed')) writes`)).rows[0];
  assert.deepEqual(state,{participants:2,policy:'policy_1',old_code:1,writes:0},'Existing synthetic fixture is not the failed pre-write stage');
  return;
 }
 await owner.query('BEGIN');
 try{
 await owner.query(`GRANT USAGE ON SCHEMA zzsh_iam,zzsh_auth_admin,zzsh_auth_user,zzsh_supply,zzsh_order,zzsh_credit,zzsh_content TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT SELECT ON ALL TABLES IN SCHEMA zzsh_iam,zzsh_auth_admin,zzsh_auth_user,zzsh_supply,zzsh_order,zzsh_credit,zzsh_content TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT UPDATE(updated_at) ON zzsh_iam.admin_security TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT UPDATE(locked) ON zzsh_auth_admin."session" TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT INSERT ON zzsh_iam.audit_event TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT INSERT,UPDATE ON zzsh_supply.idempotency_record TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT INSERT ON zzsh_order.distribution_policy_version TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT UPDATE(revision,current_version_id) ON zzsh_order.distribution_policy_head TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT UPDATE(level_code,policy_version_id,revision) ON zzsh_order.distribution_participant TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT INSERT ON zzsh_order.distribution_invite_code TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT UPDATE(active) ON zzsh_order.distribution_invite_code TO ${env.DISTRIBUTION_SYNTH_RUNTIME};
  GRANT EXECUTE ON FUNCTION zzsh_order.distribution_management_contract_version() TO ${env.DISTRIBUTION_SYNTH_RUNTIME};`);
 await owner.query(`INSERT INTO zzsh_auth_admin."user"(id,name,email,"createdAt","updatedAt","twoFactorEnabled") VALUES
  ('ops_synth','Operator','ops@example.invalid',now(),now(),true),('denied_synth','Denied','denied@example.invalid',now(),now(),true);
 INSERT INTO zzsh_iam.admin_security(admin_user_id,status,game_scope_mode) VALUES('ops_synth','PENDING_ENROLLMENT','SELECTED_GAMES'),('denied_synth','PENDING_ENROLLMENT','SELECTED_GAMES');
 UPDATE zzsh_iam.admin_security SET status='ACTIVE',first_activated_at=now() WHERE admin_user_id IN('ops_synth','denied_synth');
 INSERT INTO zzsh_auth_admin."session"(id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES
  ('session_synth',now()+interval '1 day','token_synth',now(),now(),'ops_synth'),('denied_session',now()+interval '1 day','token_denied',now(),now(),'denied_synth');
 INSERT INTO zzsh_iam.admin_user_role(admin_user_id,role_id) VALUES('ops_synth','role_preset_ops');
 INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES('owner_synth','Owner','owner@example.invalid',now(),now()),('invitee_synth','Invitee','invitee@example.invalid',now(),now());`);
 const text=canonicalize(base);
 await owner.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id)
  VALUES('policy_1',1,'NATIVE','distribution-policy.v3',$1,$2,'ops_synth')`,[text,sha(text)]);
 await owner.query("INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES('NATIVE',1,'policy_1')");
 await owner.query(`INSERT INTO zzsh_order.distribution_participant(user_id,eligibility,commission_frozen,level_code,policy_version_id,revision,inviter_knowledge,leader_knowledge,invitees_knowledge,source_type,source_ref,source_digest) VALUES
  ('owner_synth','ELIGIBLE',true,'legacy_2','policy_1',1,'KNOWN_NONE','KNOWN_NONE','KNOWN','LEGACY_MYSQL','legacy:owner',$1),
  ('invitee_synth','ELIGIBLE',false,'legacy_1','policy_1',1,'KNOWN_PARENT','KNOWN_NONE','KNOWN','LEGACY_MYSQL','legacy:invitee',$1)`,[codeDigest]);
 await owner.query(`INSERT INTO zzsh_order.distribution_invite_code(id,user_id,display_code,source_type,source_system,source_entity,source_id,source_digest)
 VALUES('old_code','owner_synth','OLD_CODE','LEGACY_MYSQL','fixture','la_user','owner',$1)`,[codeDigest]);
 await owner.query(`INSERT INTO zzsh_order.invitation_relation(id,type,child_user_id,parent_user_id,policy_version_id,source_type,source_ref,source_digest)
 VALUES('relation_synth','INVITER','invitee_synth','owner_synth','policy_1','LEGACY_MYSQL','legacy:relation',$1)`,[codeDigest]);
 await owner.query('COMMIT');
 }catch(error){await owner.query('ROLLBACK');throw error;}
}

async function main(){
 try{
  await setup();
  if(makePreview){const c=await pool.connect();try{await c.query('BEGIN READ ONLY');await assert.rejects(()=>assertDistributionManagementResource(c,makePreview({resourceOid:Number(env.DISTRIBUTION_SYNTH_DB_OID)+1})),e=>e.status===503);await assert.rejects(()=>assertDistributionManagementResource(c,makePreview({nonce:'b'.repeat(24)})),e=>e.status===503);await c.query('ROLLBACK');}finally{c.release();}}
  const read=await readManagementParticipants(pool,actor,{q:'owner_synth',page:1},undefined,resource);
  assert.equal(read.items[0].inviteCode,'OLD_CODE');assert.equal(read.items[0].frozen,true);
  await assert.rejects(()=>readManagementParticipants(pool,denied,{q:'',page:1},undefined,resource),e=>e.status===403);
  await assert.rejects(()=>rotateParticipantInviteCode(pool,denied,'owner_synth',{expectedCodeId:'old_code',code:'NEW_CODE',reason:'合成测试原因'},'idem_denied',resource),e=>e.status===403);
  const rotateBody={expectedCodeId:'old_code',code:'NEW_CODE',reason:'合成测试原因'};
  const rotated=await rotateParticipantInviteCode(pool,actor,'owner_synth',rotateBody,'idem_rotate',resource);
  assert.equal(rotated.body.code,'NEW_CODE');
  const replay=await rotateParticipantInviteCode(pool,actor,'owner_synth',rotateBody,'idem_rotate',resource);assert.equal(replay.replayed,true);assert.equal(replay.body.codeId,rotated.body.codeId);
  await assert.rejects(()=>rotateParticipantInviteCode(pool,actor,'owner_synth',{...rotateBody,code:'OTHER'},'idem_rotate',resource),e=>e.status===409);
  const client=await pool.connect();try{await client.query('BEGIN READ ONLY');assert.equal(await resolveCurrentInviteCode(client,'old_code'),undefined);assert.equal((await resolveCurrentInviteCode(client,'new_code')).user_id,'owner_synth');assert.equal((await readCurrentInviteCodes(client,'owner_synth')).length,1);await client.query('ROLLBACK');}finally{client.release();}
  const oldFacts=(await owner.query("SELECT active,source_type FROM zzsh_order.distribution_invite_code WHERE id='old_code'")).rows[0];assert.deepEqual(oldFacts,{active:false,source_type:'LEGACY_MYSQL'});
  assert.equal((await owner.query("SELECT count(*)::int n FROM zzsh_order.invitation_relation WHERE id='relation_synth' AND parent_user_id='owner_synth'")).rows[0].n,1);
  await assert.rejects(()=>rotateParticipantInviteCode(pool,actor,'owner_synth',{expectedCodeId:rotated.body.codeId,code:'old_code',reason:'合成测试原因'},'idem_reuse',resource),e=>e.status===409);
  await assert.rejects(()=>changeDistributionLevelPolicy(pool,actor,request('policy_1','1',{action:'DELETE',code:'legacy_1'}),'idem_default',resource),e=>e.status===409);
  const update=await changeDistributionLevelPolicy(pool,actor,request('policy_1','1',{action:'UPSERT',code:'legacy_2',name:'高级',rank:2,renterPercent:'12',ownerPercent:'10',isDefault:false}),'idem_level',resource);
  assert.equal(update.body.config.baseMode,'LEGACY_RENTAL');assert.equal(update.body.config.levelNames.legacy_2,'高级');
  await assert.rejects(()=>changeParticipantLevel(pool,actor,'owner_synth',{expectedPolicyId:'policy_1',expectedPolicyRevision:'1',expectedParticipantRevision:'1',levelCode:'legacy_1',reason:'合成测试原因'},'idem_stale',resource),e=>e.status===409);
  const headId=update.body.versionId;
  const deleted=await changeDistributionLevelPolicy(pool,actor,request(headId,'2',{action:'DELETE',code:'legacy_2'}),'idem_delete',resource);assert.equal(deleted.body.reassigned,1);
  const participant=(await owner.query("SELECT level_code,commission_frozen,policy_version_id,revision::text FROM zzsh_order.distribution_participant WHERE user_id='owner_synth'")).rows[0];
  assert.deepEqual(participant,{level_code:'legacy_1',commission_frozen:true,policy_version_id:deleted.body.versionId,revision:'2'});
  assert.equal((await owner.query("SELECT count(*)::int n FROM zzsh_order.distribution_policy_version WHERE id='policy_1' AND canonical_config=$1",[canonicalize(base)])).rows[0].n,1);
  const body={expectedPolicyId:deleted.body.versionId,expectedPolicyRevision:'3',expectedParticipantRevision:'2',levelCode:'legacy_1',reason:'合成测试原因'};
  const assignment=await changeParticipantLevel(pool,actor,'owner_synth',body,'idem_assign',resource);assert.equal(assignment.body.revision,'3');
  await assert.rejects(()=>changeParticipantLevel(pool,actor,'owner_synth',body,'idem_stale_user',resource),e=>e.status===409);
  await owner.query('BEGIN');
  try{await owner.query("UPDATE zzsh_order.distribution_invite_code SET active=false WHERE id=$1",[rotated.body.codeId]);await assert.rejects(()=>owner.query('SET CONSTRAINTS ALL IMMEDIATE'),e=>e.code==='23514');await owner.query('ROLLBACK');}catch(e){await owner.query('ROLLBACK');throw e;}
  const facts=['RENTER_REFERRAL','OWNER_REFERRAL'].map((role,n)=>({role,partyUserId:'party'+n,relation:{knowledge:'KNOWN_PARENT',id:'rel'+n,childUserId:'party'+n,parentUserId:'parent'+n,sourceDigest:'d'.repeat(64)},beneficiary:{userId:'parent'+n,active:true,eligibility:'ELIGIBLE',commissionFrozen:false,levelCode:'legacy_2'}}));
  const frozen=freezePaymentDistributionBasis({orderId:'order_synth',gameId:'delta',currency:'CNY',confirmationId:'payment_synth',acceptedAt:'2026-10-04T03:00:00.000000Z',paymentDigest:'a'.repeat(64),admissionId:'a1',admissionRevision:'1',origin:'NATIVE',accountMode:'ordinary',estimate:{baseCents:'5000',sourceDigest:'a'.repeat(64)},policy:{versionId:'policy_1',digest:sha(canonicalize(base)),config:base},facts});
  const result=prepareAccrualFromFrozenPayment(frozen,{origin:'NATIVE',orderId:'order_synth',confirmationId:'payment_synth',postingId:'posting_synth',postingDigest:'e'.repeat(64),postedAt:'2026-10-04T03:12:10.123456Z',classification:'NORMAL',calculationMode:'SYSTEM',capturedCents:'10000',ownerNetCents:'4000',renterRefundCents:'1000',platformContributionCents:'5000',compensationFeeCents:'200'});
  assert.equal(result.baseCents,'5000');assert.deepEqual(result.items.map(i=>i.amountCents),['500','500']);
  const audits=(await owner.query("SELECT action,count(*)::int n FROM zzsh_iam.audit_event WHERE action LIKE 'distribution.%' GROUP BY action ORDER BY action")).rows;
  assert(audits.some(a=>a.action==='distribution.invite_code.changed'&&a.n===1));assert(audits.some(a=>a.action==='distribution.level.changed'&&a.n===2));
  console.log(JSON.stringify({status:'PASS',checks:['selected_games_fine_grained_permission','denied_write','code_replay_and_permanent_reservation','relation_unchanged','default_delete_rejected','v4_policy_and_frozen_basis','delete_reassign_and_frozen_preserved','stale_cas','audit_and_guard']}));
 }finally{await pool.end();try{if(releaseLock)await releaseLock();}finally{await owner.end();}}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
