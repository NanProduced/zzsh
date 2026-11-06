/* Runs after distribution-management-synthetic.cjs in the same isolated synthetic PostgreSQL. */
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(mod,file)=>mod._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,experimentalDecorators:true}}).outputText,file);
const {Pool,Client}=require('pg');
const {createProvisionedDistributionManagementResource}=require('../src/finance/distribution-management-resource.ts');
const {readManagementParticipants,setParticipantCommissionFrozen}=require('../src/finance/admin-distribution-management.ts');
const {handleAdminDistributionManagement}=require('../src/finance/admin-distribution-management-routes.ts');
const {claim}=require('./distribution-management-synthetic-resource.cjs');
const env=process.env;assert.equal(env.DISTRIBUTION_SYNTH_OPT_IN,'1');assert.equal(env.DISTRIBUTION_SYNTH_HOST,'127.0.0.1');
for(const key of ['DISTRIBUTION_SYNTH_DB','DISTRIBUTION_SYNTH_OWNER','DISTRIBUTION_SYNTH_RUNTIME'])assert.match(env[key]??'',/^[a-z][a-z0-9_]{0,62}$/);
for(const key of ['DISTRIBUTION_SYNTH_MARKER','DISTRIBUTION_SYNTH_DB_OID','DISTRIBUTION_SYNTH_SYSTEM_ID'])assert.ok(env[key]);
const options={host:env.DISTRIBUTION_SYNTH_HOST,port:Number(env.DISTRIBUTION_SYNTH_PORT??5432),database:env.DISTRIBUTION_SYNTH_DB,statement_timeout:10000,lock_timeout:5000};
const owner=new Client({...options,user:env.DISTRIBUTION_SYNTH_OWNER,application_name:'distribution-freeze-owner'}),pool=new Pool({...options,user:env.DISTRIBUTION_SYNTH_RUNTIME,max:2,application_name:'distribution-freeze-runtime'});
const resource=createProvisionedDistributionManagementResource({profile:'dev',database:{targetProfile:'dev',name:options.database,user:env.DISTRIBUTION_SYNTH_RUNTIME,runtimeUser:env.DISTRIBUTION_SYNTH_RUNTIME}});
const actor={userId:'ops_synth',sessionId:'session_synth',requestId:'freeze_request'},denied={userId:'denied_synth',sessionId:'denied_session',requestId:'freeze_denied'};
const body=(expectedParticipantRevision,frozen)=>({expectedParticipantRevision,frozen,reason:'冻结状态合成测试'});
let releaseLock;
(async()=>{try{
 await owner.connect();const identity=(await owner.query(`SELECT d.oid::text oid,current_database() name,current_user owner,shobj_description(d.oid,'pg_database') marker,(pg_control_system()).system_identifier::text system_id,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid AND a.pid<>pg_backend_pid()) others FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
 assert.deepEqual(identity,{oid:env.DISTRIBUTION_SYNTH_DB_OID,name:env.DISTRIBUTION_SYNTH_DB,owner:env.DISTRIBUTION_SYNTH_OWNER,marker:env.DISTRIBUTION_SYNTH_MARKER,system_id:env.DISTRIBUTION_SYNTH_SYSTEM_ID,others:0});
 releaseLock=await claim(owner,env);
 const initial=(await owner.query("SELECT revision::text,commission_frozen FROM zzsh_order.distribution_participant WHERE user_id='owner_synth'")).rows[0];assert.deepEqual(initial,{revision:'3',commission_frozen:true});
 await owner.query(`INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES('unknown_synth','Unknown','unknown@example.invalid',now(),now());
  INSERT INTO zzsh_order.distribution_participant(user_id,eligibility,commission_frozen,level_code,policy_version_id,revision,inviter_knowledge,leader_knowledge,invitees_knowledge,source_type,source_ref,source_digest)
  VALUES('unknown_synth','UNKNOWN',NULL,NULL,NULL,1,'KNOWN_NONE','KNOWN_NONE','UNKNOWN','LEGACY_MYSQL','legacy:unknown',repeat('a',64))`);
 const before=(await owner.query(`SELECT (SELECT count(*)::int FROM zzsh_order.invitation_relation) relations,
  (SELECT count(*)::int FROM zzsh_order.rental_referral_earning) earnings,(SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry) ledger,
  (SELECT source_digest FROM zzsh_order.distribution_participant WHERE user_id='owner_synth') source_digest`)).rows[0];
 const noGrant=await readManagementParticipants(pool,actor,{q:'owner_synth',page:1},undefined,resource);assert.equal(noGrant.freezeWriteReady,false);
 await assert.rejects(()=>setParticipantCommissionFrozen(pool,actor,'owner_synth',body('3',false),'idem_freeze_acl',resource),e=>e.status===503);
 await owner.query(`GRANT UPDATE(commission_frozen) ON zzsh_order.distribution_participant TO ${env.DISTRIBUTION_SYNTH_RUNTIME}`);
 const ready=await readManagementParticipants(pool,actor,{q:'owner_synth',page:1},undefined,resource);assert.equal(ready.freezeWriteReady,true);
 await assert.rejects(()=>setParticipantCommissionFrozen(pool,denied,'owner_synth',body('3',false),'idem_freeze_denied',resource),e=>e.status===403);
 await assert.rejects(()=>setParticipantCommissionFrozen(pool,actor,'unknown_synth',body('1',false),'idem_freeze_unknown',resource),e=>e.status===409);
 const unfreeze=await setParticipantCommissionFrozen(pool,actor,'owner_synth',body('3',false),'idem_freeze_acl',resource);
 assert.deepEqual(unfreeze.body,{userId:'owner_synth',frozen:false,revision:'4',changed:true});
 await owner.query(`REVOKE UPDATE(commission_frozen) ON zzsh_order.distribution_participant FROM ${env.DISTRIBUTION_SYNTH_RUNTIME}`);
 const replay=await setParticipantCommissionFrozen(pool,actor,'owner_synth',body('3',false),'idem_freeze_acl',resource);assert.equal(replay.replayed,true);assert.deepEqual(replay.body,unfreeze.body);
 assert.equal((await readManagementParticipants(pool,actor,{q:'owner_synth',page:1},undefined,resource)).freezeWriteReady,false);
 await owner.query(`GRANT UPDATE(commission_frozen) ON zzsh_order.distribution_participant TO ${env.DISTRIBUTION_SYNTH_RUNTIME}`);
 await assert.rejects(()=>setParticipantCommissionFrozen(pool,actor,'owner_synth',body('3',true),'idem_freeze_acl',resource),e=>e.status===409);
 await assert.rejects(()=>setParticipantCommissionFrozen(pool,actor,'owner_synth',body('3',true),'idem_freeze_stale',resource),e=>e.status===409);
 const unchanged=await setParticipantCommissionFrozen(pool,actor,'owner_synth',body('4',false),'idem_freeze_noop',resource);assert.deepEqual(unchanged.body,{userId:'owner_synth',frozen:false,revision:'4',changed:false});
 const blocker=await pool.connect();let blocked,waiting;
 try{
  await blocker.query('BEGIN');await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0))");
  let pid=0;const tracked={connect:async()=>{const client=await pool.connect();pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client;}};
  waiting=setParticipantCommissionFrozen(tracked,actor,'owner_synth',body('4',true),'idem_freeze_locked',resource);
  for(let attempt=0;attempt<100&&!blocked;attempt++){if(pid)blocked=(await owner.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting",[pid])).rows[0].waiting;if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(blocked,true,'freeze waits on the payment invitation lock');
  assert.deepEqual((await owner.query("SELECT revision::text,commission_frozen FROM zzsh_order.distribution_participant WHERE user_id='owner_synth'")).rows[0],{revision:'4',commission_frozen:false});
  await blocker.query('COMMIT');blocker.release();const frozen=await waiting;waiting=null;
  assert.deepEqual(frozen.body,{userId:'owner_synth',frozen:true,revision:'5',changed:true});
 }catch(error){await blocker.query('ROLLBACK').catch(()=>{});blocker.release();if(waiting)await waiting.catch(()=>{});throw error;}
 const final=await setParticipantCommissionFrozen(pool,actor,'owner_synth',body('5',false),'idem_freeze_final',resource);assert.equal(final.body.revision,'6');assert.equal(final.body.frozen,false);
 const routeOptions={pool,apiOrigin:'http://api.local',adminOrigin:'http://admin.local',userOrigin:'http://user.local',distributionManagement:resource,
  adminAuth:{api:{getSession:async()=>({user:{id:'ops_synth',twoFactorEnabled:true},session:{id:'session_synth',locked:false}})}}};
 const invoke=async(headers={})=>{const out={status:0,json:null},response={headersSent:false,status(code){out.status=code;return this},setHeader(){return this},json(value){out.json=value;return this},send(value){out.json=value;return this},end(){},once(){}};
  await handleAdminDistributionManagement({method:'POST',url:'/api/v1/admin/distribution/manage/participants/owner_synth/freeze',originalUrl:'/api/v1/admin/distribution/manage/participants/owner_synth/freeze',body:body('6',false),headers:{origin:'http://admin.local',cookie:'session=synthetic',...headers}},response,routeOptions);return out;};
 assert.equal((await invoke({origin:'http://untrusted.invalid'})).status,403);assert.equal((await invoke()).status,400);
 const headers={'idempotency-key':'idem_'+'f'.repeat(32)},route=await invoke(headers),routeReplay=await invoke(headers);
 assert.equal(route.status,200);assert.deepEqual(route.json,{userId:'owner_synth',frozen:false,revision:'6',changed:false,replayed:false});assert.equal(routeReplay.json.replayed,true);
 const after=(await owner.query(`SELECT (SELECT count(*)::int FROM zzsh_order.invitation_relation) relations,
  (SELECT count(*)::int FROM zzsh_order.rental_referral_earning) earnings,(SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry) ledger,
  (SELECT source_digest FROM zzsh_order.distribution_participant WHERE user_id='owner_synth') source_digest`)).rows[0];assert.deepEqual(after,before);
 const audits=(await owner.query("SELECT details FROM zzsh_iam.audit_event WHERE action='distribution.participant.freeze_changed' AND object_id='owner_synth' ORDER BY recorded_at,id")).rows;
 assert.equal(audits.length,5);assert(audits.some(row=>row.details.changed===false&&row.details.beforeRevision==='4'));
 console.log(JSON.stringify({status:'PASS',checks:['minimal_acl','readiness','authorization','unknown_state','idempotent_original_replay','stale_cas','explicit_noop','payment_graph_lock','handler_origin_and_key','audit','no_earnings_wallet_or_relation_change']}));
 }finally{await pool.end();try{if(releaseLock)await releaseLock();}finally{await owner.end();}}})().catch(error=>{console.error(error);process.exitCode=1;});
