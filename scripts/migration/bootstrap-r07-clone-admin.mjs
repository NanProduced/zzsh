import assert from 'node:assert/strict';import {createHash,randomBytes} from 'node:crypto';import {existsSync,lstatSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import Module,{createRequire} from 'node:module';import {dirname,isAbsolute,join,relative,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {LocalSession,writePrivate} from '../local-auth.mjs';import {advisoryLockSql,assertLiveTarget,loadRegisteredTarget,maintenanceConnection,targetConnection,targetIdentityQuery} from './local-target-registry.mjs';
import {assertBootstrapOnlyAuth,assertCloneBossGrant,R07_CLONE_BOSS_TARGET as targetConstant,R07_CLEAN_EXPORT_SHA} from './r07-clone-admin-bootstrap-guard.mjs';
import {createBootstrapGateway,runCloneBossEnrollment} from './r07-clone-admin-bootstrap-flow.mjs';

const mainRoot=resolve('D:/CodexWorktrees/main-consolidation-20261028/zzsh'),privateRoot=resolve('E:/zzsh-local-state/restricted');
const credentialFile=join(privateRoot,'r07-demo-clone-resource-20261108-01/credentials.json');
const exportFile=join(privateRoot,'r07-delivery-seal-20261108-01/export-01/receipt.json');
const cloneRestoreFile=join(privateRoot,'r07-delivery-seal-20261108-01/restore-01/verification.json');
const dataReadbackFile=join(privateRoot,'r07-delivery-seal-20261108-01/restore-01/data-readback.json');
const authPlanFile=join(privateRoot,'r07-demo-clone-auth-handoff-20261108-01/plan-03/plan.json');
const output=join(privateRoot,'r07-local-demo-boss-20261108-01'),sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
function inside(base,value){assert(typeof value==='string'&&isAbsolute(value),'R07_BOSS_PRIVATE_PATH_REQUIRED');const p=resolve(value),r=relative(base,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_BOSS_PRIVATE_PATH_REQUIRED');
 for(let x=p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_BOSS_LINK_REFUSED');return p;}
function pin(path,expected,base=privateRoot){const p=inside(base,path),bytes=readFileSync(p);assert(/^[a-f0-9]{64}$/.test(expected??'')&&sha(bytes)===expected,'R07_BOSS_INPUT_CHANGED');return JSON.parse(bytes);}
function buildDigest(dir){const root=resolve(dir),rel=relative(join(mainRoot,'tmp'),root).replaceAll('\\','/');
 assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}\/api\/dist\/src$/.test(rel),'R07_BOSS_ISOLATED_BUILD_REQUIRED');
 for(let x=root;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_BOSS_BUILD_LINK_REFUSED');
 const files=[];function walk(folder,prefix=''){for(const e of readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){assert(!e.isSymbolicLink(),'R07_BOSS_BUILD_LINK_REFUSED');const name=prefix+e.name,p=join(folder,e.name);if(e.isDirectory())walk(p,name+'/');else{assert(e.isFile(),'R07_BOSS_BUILD_FILE_INVALID');files.push({path:name,sha256:sha(readFileSync(p))});}}}walk(root);
 assert(files.some(x=>x.path==='app.js')&&files.some(x=>x.path==='auth/auth-runtime.js'),'R07_BOSS_BUILD_INCOMPLETE');return {sha256:sha(canonical(files)),files:files.length};}
function options(args){const out={};for(let i=0;i<args.length;i+=2){assert(['--request','--request-sha','--grant','--grant-sha'].includes(args[i])&&args[i+1]&&!out[args[i]],'R07_BOSS_ARGUMENTS_INVALID');out[args[i]]=args[i+1];}return out;}
async function readState(c,retiredIds){
 const state=(await c.query(`SELECT (SELECT count(*)::int FROM zzsh_auth_admin."user") admin_users,(SELECT count(*)::int FROM zzsh_auth_admin.account) admin_accounts,
  (SELECT count(*)::int FROM zzsh_auth_admin."twoFactor") admin_factors,(SELECT count(*)::int FROM zzsh_auth_admin.session) admin_sessions,
  (SELECT count(*)::int FROM zzsh_iam.admin_security) admin_security,(SELECT count(*)::int FROM zzsh_auth_user.session) user_sessions,
  (SELECT count(*)::int FROM zzsh_auth_user.account) user_accounts,(SELECT count(*)::int FROM zzsh_supply.rental_account) accounts,
  (SELECT count(*)::int FROM zzsh_order.legacy_order_read_snapshot) legacy_orders,(SELECT count(*)::int FROM zzsh_order.rental_order) native_orders,
  (SELECT count(*)::int FROM zzsh_order.payment_confirmation) payment_confirmations,(SELECT count(*)::int FROM zzsh_order.payment_request) payment_requests,
  (SELECT count(*)::int FROM zzsh_order.finance_economic_root WHERE source_kind<>'LEGACY_OPENING') nonopening_roots,
  (SELECT count(*)::int FROM zzsh_order.finance_event WHERE kind<>'OPENING') nonopening_events,
  (SELECT count(*)::int FROM zzsh_order.invitation_relation) invitations,(SELECT count(*)::int FROM zzsh_order.distribution_participant) participants,
  (SELECT count(*)::int FROM zzsh_supply.legacy_listing_capture_fact) capture_facts,(SELECT count(*)::int FROM zzsh_order.withdrawal_bank_binding) banks`)).rows[0];
 const userAccounts=(await c.query(`SELECT count(*)::int n,encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY id COLLATE "C"),''),'UTF8')),'hex') digest FROM zzsh_auth_user.account t`)).rows[0];
 const retired=(await c.query(`SELECT count(*)::int n,encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex'),'' ORDER BY u.id COLLATE "C"),''),'UTF8')),'hex') digest
  FROM zzsh_auth_admin."user" u LEFT JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id WHERE u.id=ANY($1::text[]) AND u.suspended AND NOT u."twoFactorEnabled" AND s.admin_user_id IS NULL`,[retiredIds])).rows[0];
 return {state,userAccounts,retired};
}
function unchanged(before,after){for(const [k,v] of Object.entries(before.state))if(!['admin_users','admin_accounts','admin_factors','admin_sessions','admin_security'].includes(k))assert.equal(after.state[k],v,'R07_BOSS_EXISTING_STATE_CHANGED');
 assert.deepEqual(after.userAccounts,before.userAccounts,'R07_BOSS_USER_ACCOUNTS_CHANGED');assert.deepEqual(after.retired,before.retired,'R07_BOSS_RETIRED_IDENTITIES_CHANGED');}
async function criticalRows(c){
 const tables=[['users','zzsh_auth_user."user"','id'],['userAccounts','zzsh_auth_user.account','id'],['accounts','zzsh_supply.rental_account','id'],
  ['legacyAccounts','zzsh_supply.legacy_listing_read_snapshot','account_id'],['accountSourceFacts','zzsh_supply.legacy_listing_capture_fact','account_id'],
  ['legacyOrders','zzsh_order.legacy_order_read_snapshot','id'],['nativeOrders','zzsh_order.rental_order','id'],['invitations','zzsh_order.invitation_relation','id'],
  ['distributionParticipants','zzsh_order.distribution_participant','user_id'],['openingBalances','zzsh_order.finance_opening_basis','id'],
  ['bankBindings','zzsh_order.withdrawal_bank_binding','id'],['legacyObservations','zzsh_order.personal_finance_observation','id'],
  ['legacyCoverage','zzsh_order.personal_finance_observation_coverage','id'],['ledgerEntries','zzsh_order.settlement_ledger_entry','id'],
  ['membershipGrowth','zzsh_iam.membership_growth_state','user_id'],['membershipCoverage','zzsh_iam.membership_growth_legacy_coverage','id'],
  ['rentalMembership','zzsh_iam.user_rental_membership','user_id'],['creditState','zzsh_credit.user_credit_state','user_id']];
 const sql=tables.map(([name,table,key])=>`SELECT '${name}' name,count(*)::text count,encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY t."${key}"::text COLLATE "C"),''),'UTF8')),'hex') digest FROM ${table} t`).join(' UNION ALL ');
 return (await c.query(`SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.name),'[]'::jsonb) result FROM (${sql}) x`)).rows[0].result;
}

async function main(){
 const args=process.argv.slice(2);if(!args.length){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--execute','--request','--request-sha','--grant','--grant-sha'],connections:0,writes:0}));return;}
 if(args[0]==='--describe-build'){assert.equal(args.length,2);console.log(JSON.stringify(buildDigest(args[1])));return;}
 assert.equal(args.shift(),'--execute','R07_BOSS_EXECUTE_REQUIRED');const o=options(args);assert.equal(Object.keys(o).length,4,'R07_BOSS_ARGUMENTS_INVALID');
 assert.equal(process.version,'v24.20.0','R07_BOSS_NODE_CHANGED');assert.equal(resolve(process.cwd()),mainRoot,'R07_BOSS_WORKTREE_CHANGED');assert(!existsSync(output),'R07_BOSS_OUTPUT_EXISTS');
 const request=pin(o['--request'],o['--request-sha']),grant=pin(o['--grant'],o['--grant-sha']),credentialsBytes=readFileSync(credentialFile),credentials=JSON.parse(credentialsBytes),registered=loadRegisteredTarget(credentialFile);
 assert.equal(sha(credentialsBytes),request.credentialsSha256,'R07_BOSS_CREDENTIALS_CHANGED');
 const exportReceipt=pin(exportFile,R07_CLEAN_EXPORT_SHA),cloneRestoreReceipt=pin(cloneRestoreFile,request.cloneRestoreVerificationSha256),authPlan=pin(authPlanFile,'6b892613d0793d7993536856cba048f4e4eb2a6e9fa7fbb853ae825dbed85c56'),
  dataReadback=pin(dataReadbackFile,'3ffad6411dad5e7cdcc8e610998c2f8d20c595c9d679d7b80bfc697c48c482db');
 assert(dataReadback.status==='ROW_DIGESTS_MATCHED_AFTER_EXPORT'&&dataReadback.rollbackAck&&dataReadback.sourceWrites===0,'R07_BOSS_DATA_READBACK_INVALID');
 const approval=assertCloneBossGrant({request,requestSha256:o['--request-sha'],grant,registered,exportReceipt,exportReceiptSha256:R07_CLEAN_EXPORT_SHA,cloneRestoreReceipt,cloneRestoreVerificationSha256:request.cloneRestoreVerificationSha256});
 assert(request.buildDir&&buildDigest(request.buildDir).sha256===request.buildSha256,'R07_BOSS_BUILD_CHANGED');
 const codeFiles=['scripts/migration/bootstrap-r07-clone-admin.mjs','scripts/migration/r07-clone-admin-bootstrap-guard.mjs','scripts/migration/r07-clone-admin-bootstrap-flow.mjs','scripts/migration/local-target-registry.mjs','scripts/local-auth.mjs'];
 assert(request.toolProof&&Object.keys(request.toolProof).sort().join()===codeFiles.slice().sort().join(),'R07_BOSS_TOOL_PROOF_REQUIRED');
 const verifyTools=()=>{for(const file of codeFiles)assert.equal(sha(readFileSync(resolve(file))),request.toolProof[file],'R07_BOSS_TOOL_CHANGED');assert.equal(buildDigest(request.buildDir).sha256,request.buildSha256,'R07_BOSS_BUILD_CHANGED');
  assert.equal(sha(readFileSync(credentialFile)),request.credentialsSha256,'R07_BOSS_CREDENTIALS_CHANGED');assert.equal(sha(readFileSync(o['--request'])),o['--request-sha']);assert.equal(sha(readFileSync(o['--grant'])),o['--grant-sha']);
  assert.equal(sha(readFileSync(exportFile)),R07_CLEAN_EXPORT_SHA,'R07_BOSS_EXPORT_EVIDENCE_CHANGED');assert.equal(sha(readFileSync(cloneRestoreFile)),request.cloneRestoreVerificationSha256,'R07_BOSS_RESTORE_EVIDENCE_CHANGED');
  assert.equal(sha(readFileSync(dataReadbackFile)),'3ffad6411dad5e7cdcc8e610998c2f8d20c595c9d679d7b80bfc697c48c482db','R07_BOSS_DATA_READBACK_CHANGED');};verifyTools();
 const retiredIds=authPlan.snapshot.actors.map(x=>x.id);assert.equal(retiredIds.length,4);
 const staged={bootstrapSecret:randomBytes(32).toString('hex'),temporaryPassword:randomBytes(24).toString('base64url'),password:randomBytes(24).toString('base64url'),adminSecret:randomBytes(32).toString('hex')};
 const receipt={schema:'zzsh.r07-local-demo-boss.v1',status:'STARTED',attempt:approval.attempt,target:{...targetConstant},requestSha256:o['--request-sha'],exportReceiptSha256:R07_CLEAN_EXPORT_SHA,
  cloneRestoreVerificationSha256:request.cloneRestoreVerificationSha256,steps:[],financialWrites:0,providerCalls:0,startedAt:new Date().toISOString()};
 writePrivate(join(output,'receipt.json'),receipt);writePrivate(join(output,'staged-secrets.json'),staged);writeFileSync(join(output,'admin-runtime-secret'),staged.adminSecret+'\n',{flag:'wx',mode:0o600});
 const save=async()=>{writePrivate(join(output,'receipt.json'),receipt);writePrivate(join(output,'staged-secrets.json'),staged);};
 const {Client,Pool}=createRequire(import.meta.url)('pg'),common={connectionTimeoutMillis:3000,statement_timeout:120000,lock_timeout:1000};
 const maintenance=new Client(maintenanceConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-clone-boss-lock'}));
 const reader=new Client(targetConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-clone-boss-readback'}));
 let held=false,app,gateway,pool,appClosed=false,gatewayClosed=false,poolClosed=false,readerClosed=false,maintenanceClosed=false,unlockAck=false,success=false,before,adminId;
 const checkWindow=()=>{assert(Date.now()<approval.expiresAt,'R07_BOSS_WINDOW_EXPIRED');verifyTools();assert.equal(readFileSync(join(output,'admin-runtime-secret'),'utf8'),staged.adminSecret+'\n','R07_BOSS_ADMIN_SECRET_CHANGED');};
 try{
  checkWindow();await maintenance.connect();held=(await maintenance.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(held,'R07_BOSS_RESOURCE_BUSY');await reader.connect();
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET LOCAL TIME ZONE 'UTC'");const identity=(await reader.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,identity,'migration');assert.equal(String(identity.owner_oid),targetConstant.ownerOid,'R07_BOSS_OWNER_OID_CHANGED');
  const roleFacts=(await reader.query(`SELECT r.rolname,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid) memberships FROM pg_roles r WHERE r.rolname=ANY($1::text[]) ORDER BY r.rolname`,[[targetConstant.owner,targetConstant.migrationRole,targetConstant.runtimeRole]])).rows;
  assert(roleFacts.length===3&&roleFacts.every(r=>!r.rolsuper&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolreplication&&!r.rolbypassrls&&r.memberships===0)
   &&roleFacts.find(r=>r.rolname===targetConstant.owner)?.rolcanlogin===false&&roleFacts.filter(r=>r.rolname!==targetConstant.owner).every(r=>r.rolcanlogin&&!r.rolinherit),'R07_BOSS_ROLE_FACTS_CHANGED');
  before=await readState(reader,retiredIds);assert(before.state.admin_users===4&&before.retired.n===4&&before.state.admin_accounts===0&&before.state.admin_factors===0&&before.state.admin_sessions===0
   &&before.state.admin_security===0&&before.state.user_sessions===0&&before.state.native_orders===0&&before.state.payment_confirmations===0&&before.state.payment_requests===0
   &&before.state.nonopening_roots===0&&before.state.nonopening_events===0&&before.state.capture_facts===26745,'R07_BOSS_PREIMAGE_CHANGED');
  assert.deepEqual(before.userAccounts,authPlan.snapshot.userAccounts,'R07_BOSS_USER_PREIMAGE_CHANGED');
  assert.equal((await reader.query('ROLLBACK')).command,'ROLLBACK');receipt.preflightRollbackAck=true;receipt.before=before.state;await save();
  for(const key of Object.keys(process.env))if(!/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA)$/i.test(key))delete process.env[key];
  process.env.NODE_ENV='development';process.env.NODE_PATH=[join(mainRoot,'apps/api/node_modules'),join(mainRoot,'node_modules')].join(';');Module._initPaths();
  const load=name=>createRequire(join(mainRoot,'apps/api/package.json'))(join(request.buildDir,name+'.js'));
  const {createApp}=load('app'),{loadAuthRuntimeConfig}=load('auth/auth-runtime');
  const auth=loadAuthRuntimeConfig({APP_PROFILE:'test',PROVIDER_MODE:'fake',NODE_ENV:'development',HOST:'127.0.0.1',PORT:'4242',DB_TARGET:'local-compose',DB_HOST:'127.0.0.1',DB_NAME:registered.database,
   AUTH_API_ORIGIN:request.apiOrigin,AUTH_USER_ORIGIN:'http://127.0.0.1:4240',AUTH_ADMIN_ORIGIN:request.apiOrigin,AUTH_USER_SECRET:randomBytes(32).toString('hex'),AUTH_ADMIN_SECRET:staged.adminSecret,
   AUTH_ADMIN_BOOTSTRAP_SECRET:staged.bootstrapSecret,AUTH_LOCAL_SMS_MOCK:'false',USER_SMS_PROVIDER:'disabled',USER_REAL_NAME_PROVIDER:'disabled',ORDER_SETTLEMENT_RECORDING_ENABLED:'false',ORDER_IM_EVENTS_ENABLED:'false'});
  assertBootstrapOnlyAuth(auth);pool=new Pool(targetConnection(registered,{...common,user:credentials.runtime.name,password:credentials.runtime.password,applicationName:'r07-clone-boss-api',max:3}));
  const probe=await pool.connect();try{await probe.query('BEGIN READ ONLY');const identity=(await probe.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,identity,'runtime');assert.equal(String(identity.owner_oid),targetConstant.ownerOid);assert.equal((await probe.query('ROLLBACK')).command,'ROLLBACK');}finally{probe.release();}
  app=await createApp({health:{dependencies:{postgres:{check:async()=>{},close:async()=>{}},redis:{check:async()=>{},close:async()=>{}}}},database:{pool},auth:{...auth,pool}});
  await app.init();const gate=randomBytes(32).toString('hex');gateway=createBootstrapGateway(app.getHttpAdapter().getInstance(),gate);
  await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(4242,'127.0.0.1',resolve);});verifyTools();let requestId='';
  const sessionFactory=()=>new LocalSession(request.apiOrigin,'admin',[],(url,opts)=>fetch(url,{...opts,headers:{...opts.headers,'X-Request-Id':requestId,'X-R07-Bootstrap-Gate':gate}}));
  const enrollment=await runCloneBossEnrollment({request,staged,receipt,sessionFactory,setRequestId:id=>requestId=id,save,assertWindow:checkWindow});adminId=enrollment.administratorId;
  writePrivate(join(output,'profile.json'),enrollment.profile);await new Promise((resolve,reject)=>gateway.close(error=>error?reject(error):resolve()));gateway=undefined;gatewayClosed=true;
  await app.close();app=undefined;appClosed=true;if(!pool.ended&&!pool.ending)await pool.end();poolClosed=true;
  await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET LOCAL TIME ZONE 'UTC'");assertLiveTarget(registered,(await reader.query(targetIdentityQuery())).rows[0],'migration');
  const after=await readState(reader,retiredIds);unchanged(before,after);const unchangedRows=await criticalRows(reader);
  assert.deepEqual(unchangedRows,dataReadback.tables.filter(x=>!['retiredAdminUsers','auditCore','idempotencyKeys'].includes(x.name)),'R07_BOSS_CRITICAL_ROWS_CHANGED');
  assert(after.state.admin_users===5&&after.state.admin_accounts===1&&after.state.admin_factors===1&&after.state.admin_security===1&&after.state.admin_sessions===0,'R07_BOSS_POSTIMAGE_CHANGED');
  const admin=(await reader.query(`SELECT s.status,s.is_boss,s.password_change_required,u.suspended,u."twoFactorEnabled" factor,s.first_activated_at IS NOT NULL activated,
   (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id=u.id AND action='admin.bootstrap.created' AND request_id=$2 AND outcome='SUCCESS') bootstrap_audit,
   (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id=u.id AND action='admin.enrollment.activated' AND outcome='SUCCESS') activation_audit,
   (SELECT count(*)::int FROM zzsh_supply.profile_avatar WHERE realm='admin' AND subject_id=u.id AND current_kind='DEFAULT' AND current_asset_id IS NULL AND pending_asset_id IS NULL) avatar
   FROM zzsh_auth_admin."user" u JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id WHERE u.id=$1`,[adminId,receipt.steps.find(x=>x.name==='bootstrap').requestId])).rows;
  assert(admin.length===1&&admin[0].status==='ACTIVE'&&admin[0].is_boss&&!admin[0].password_change_required&&!admin[0].suspended&&admin[0].factor&&admin[0].activated&&admin[0].bootstrap_audit===1&&admin[0].activation_audit===1&&admin[0].avatar===1,'R07_BOSS_FINAL_IDENTITY_INVALID');
  assert.equal((await reader.query('ROLLBACK')).command,'ROLLBACK');receipt.readbackRollbackAck=true;receipt.after=after.state;receipt.auditVerified=true;receipt.enrollmentVerified=true;
  receipt.existingIdentityPreserved=true;receipt.userAccountsUnchanged=true;receipt.financialFactsUnchanged=true;receipt.businessFactsUnchanged=true;
  receipt.verifiedTables=unchangedRows.map(x=>x.name);receipt.added={adminUsers:1,credentialAccounts:1,adminSecurity:1,twoFactor:1,adminProfileAvatars:1,bootstrapAudit:1,activationAudit:1};
  receipt.profile=join(output,'profile.json');receipt.adminRuntimeSecret=join(output,'admin-runtime-secret');success=true;
 }catch(error){receipt.status=receipt.pendingStep?'STOPPED_COMMAND_OUTCOME_UNKNOWN':'STOPPED_PRESERVE_ATTEMPT';receipt.failure=/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name;process.exitCode=1;}
 finally{
  try{if(gateway){await new Promise((resolve,reject)=>gateway.close(error=>error?reject(error):resolve()));gatewayClosed=true;}}catch{}
  try{if(app){await app.close();appClosed=true;}}catch{}try{if(pool&&!pool.ended&&!pool.ending)await pool.end();poolClosed=true;}catch{}
  try{await reader.end();readerClosed=true;}catch{}try{if(held)unlockAck=(await maintenance.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{}try{await maintenance.end();maintenanceClosed=true;}catch{}
  receipt.unlockAck=unlockAck;receipt.connectionsClosed=gatewayClosed&&appClosed&&poolClosed&&readerClosed&&maintenanceClosed;receipt.finishedAt=new Date().toISOString();
  if(success&&receipt.readbackRollbackAck&&receipt.unlockAck&&receipt.connectionsClosed){try{unlinkSync(join(output,'staged-secrets.json'));receipt.temporarySecretsRemoved=true;receipt.status='ACTIVE_AND_VERIFIED';}
   catch{receipt.status='STOPPED_SECRET_CLEANUP_UNCONFIRMED';process.exitCode=1;}}
  else if(success){receipt.status='STOPPED_CLEANUP_UNCONFIRMED';process.exitCode=1;}writePrivate(join(output,'receipt.json'),receipt);
 }
 console.log(JSON.stringify({status:receipt.status,administratorId:receipt.status==='ACTIVE_AND_VERIFIED'?adminId:undefined,receipt:join(output,'receipt.json'),failure:receipt.failure,
  auditVerified:receipt.auditVerified,enrollmentVerified:receipt.enrollmentVerified,readbackRollbackAck:receipt.readbackRollbackAck,unlockAck,connectionsClosed:receipt.connectionsClosed}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'R07_BOSS_STOPPED_BEFORE_EXECUTION',failure:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
