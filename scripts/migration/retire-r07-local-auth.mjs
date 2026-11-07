import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';import {dirname,isAbsolute,join,relative,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {writePrivate} from '../local-auth.mjs';import {writeLoadCheckpoint} from './local-load-checkpoint.mjs';
import {loadRegisteredTarget,targetConnection,maintenanceConnection,targetIdentityQuery,assertLiveTarget} from './local-target-registry.mjs';
import {assertCaptureRestoreBinding} from './complete-r07-account-capture.mjs';
import {snapshotDeliveryAuth,deliveryAuthSnapshotDigest,deliveryHandoffDigest,retireStagingMigrationAdmins,recoverDeliveryHandoff} from './admin-staging-handoff.mjs';
const require=createRequire(import.meta.url),root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=b=>createHash('sha256').update(b).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'AUTH_HANDOFF_PRIVATE_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'AUTH_HANDOFF_PRIVATE_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'AUTH_HANDOFF_LINK_REFUSED');return p;}
function pinned(ref){const p=privatePath(ref?.path),b=readFileSync(p);assert(hex(ref.sha256)&&sha(b)===ref.sha256,'AUTH_HANDOFF_INPUT_CHANGED');return JSON.parse(b);}
function code(e){const first=String(e?.message??'').split(/\r?\n/,1)[0].trim();return /^[A-Z][A-Z0-9_]+$/.test(first)?first:e?.code??e?.name??'AUTH_HANDOFF_FAILED';}
function bindTarget(t,ownerOid){return{host:t.host,port:t.port,database:t.database,oid:t.oid,marker:t.marker,nonce:t.nonce,owner:t.owner,ownerOid,
 role:t.migrationRole,roleOid:t.migrationRoleOid,runtimeRole:t.runtimeRole,runtimeRoleOid:t.runtimeRoleOid,systemIdentifier:t.instance.systemIdentifier,lockKey:t.lockKey};}
export function assertAuthHandoffAuthority(a,plan,planSha,now=Date.now()){
 const start=Date.parse(a?.notBefore),end=Date.parse(a?.expiresAt),iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
 assert(a?.schema==='zzsh.r07-auth-handoff-authority.v1'&&a.status==='APPROVED'&&a.operation==='RETIRE_LOCAL_AUTH_MATERIAL'
  &&a.planSha256===planSha&&JSON.stringify(a.target)===JSON.stringify(plan.target)&&a.admins===plan.snapshot.actors.length
  &&a.userSessions===plan.snapshot.userSessions.length&&a.userVerifications===plan.snapshot.userVerifications.length&&a.allowFinancialWrites===false
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(a.approvalRef??'')&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(a.attempt??'')
  &&iso.test(a.notBefore??'')&&iso.test(a.expiresAt??'')&&Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end&&end>start&&end-start<=30*60_000,'AUTH_HANDOFF_AUTHORITY_CHANGED');}
export function assertAuthHandoffApplyReceipt(a,planSha,target){const ack=a?.status==='COMMIT_ACK_READBACK_REQUIRED'&&a.commitAck===true,unknown=a?.status==='COMMIT_UNKNOWN'&&a.commitAck===false;
 assert(a?.schema==='zzsh.r07-auth-handoff-receipt.v1'&&(ack||unknown)&&a.commitSent===true&&a.planSha256===planSha&&JSON.stringify(a.target)===JSON.stringify(target)
  &&a.unlockAck===true&&a.connectionsClosed===true&&hex(a.handoffDigest)&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(a.approvalRef??'')
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(a.attempt??'')&&Number.isFinite(Date.parse(a.notBefore))&&Number.isFinite(Date.parse(a.expiresAt))
  &&Date.parse(a.expiresAt)>Date.parse(a.notBefore)&&Date.parse(a.expiresAt)-Date.parse(a.notBefore)<=30*60_000,'AUTH_HANDOFF_APPLY_UNCONFIRMED');}
export function authHandoffFailureStatus(mode,appliedStatus,error,commitSent,commitAck){
 return error==='ADMIN_HANDOFF_ROLLBACK_UNKNOWN'?'ROLLBACK_UNKNOWN':mode==='--readback'&&appliedStatus==='COMMIT_UNKNOWN'?'COMMIT_UNKNOWN_UNRESOLVED'
  :commitSent&&!commitAck?'COMMIT_UNKNOWN':commitAck?'COMMIT_ACK_READBACK_REQUIRED':'STOPPED';
}
function toolProof(){const files=['scripts/migration/retire-r07-local-auth.mjs','scripts/migration/admin-staging-handoff.mjs','scripts/migration/complete-r07-account-capture.mjs',
 'scripts/migration/local-target-registry.mjs','scripts/migration/local-load-checkpoint.mjs','scripts/local-auth.mjs','package-lock.json','node_modules/.package-lock.json'];
 for(const p of Object.keys(require.cache)){assert(p.toLowerCase().startsWith(root.toLowerCase()+'\\')||p.startsWith(root+'/'),'AUTH_HANDOFF_DEPENDENCY_OUTSIDE_BUILD');files.push(relative(root,p));
  if(p.toLowerCase().includes('node_modules')){let d=dirname(p);while(d.toLowerCase().startsWith(root.toLowerCase())){const f=join(d,'package.json');if(existsSync(f)){files.push(relative(root,f));break;}const next=dirname(d);if(next===d)break;d=next;}}}
 return Object.fromEntries([...new Set(files)].sort().map(p=>[p.replaceAll('\\','/'),sha(readFileSync(join(root,p)))]));}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];},modes=['--prepare','--execute','--readback'].filter(x=>args.includes(x));
 if(!modes.length){console.log(JSON.stringify({status:'PLAN_ONLY',connections:0,targetWrites:0}));return;}assert.equal(modes.length,1,'AUTH_HANDOFF_MODE_INVALID');assert.equal(process.version,'v24.20.0','AUTH_HANDOFF_NODE_CHANGED');
 const mode=modes[0],out=privatePath(option('--out'),true);assert(!existsSync(out),'AUTH_HANDOFF_OUTPUT_EXISTS');
 const inputRef={path:privatePath(option('--input')),sha256:option('--input-sha')},input=pinned(inputRef);assert(input.schema==='zzsh.r07-auth-handoff-input.v1','AUTH_HANDOFF_INPUT_INVALID');
 const restore=pinned(input.restoreReceipt),counts=pinned(input.countsReadback),schema=pinned(input.schemaReadback),capture=pinned(input.captureReadback),dataset=pinned(input.datasetManifest),
  credentialsPath=privatePath(input.credentialsPath),credentialsBytes=readFileSync(credentialsPath),credentials=JSON.parse(credentialsBytes),resourcePath=privatePath(join(dirname(credentialsPath),'resource.json')),
  credentialSha=sha(credentialsBytes),resourceSha=sha(readFileSync(resourcePath)),target=loadRegisteredTarget(credentialsPath),binding=bindTarget(target,restore.target?.owner?.oid);
 assert(target.database==='zzsh_test_r07_delivery_20261108'&&target.oid==='16391'&&target.marker==='zzsh:r07-delivery-clone:v1'&&target.host==='127.0.0.1'&&target.port===55434
  &&target.instance?.systemIdentifier==='7705473419326033954'&&target.nonce==='62ca9c4e419e1039f500ac1e'&&target.owner==='zzsh'&&target.migrationRole==='zzsh_regression_migration'
  &&target.migrationRoleOid==='16389'&&target.runtimeRole==='zzsh_regression_runtime'&&target.runtimeRoleOid==='16390'&&!target.pendingReset
  &&credentials.migration?.name===target.migrationRole&&credentials.migration?.oid===target.migrationRoleOid
  &&target.protectedDataset?.manifestSha256===input.datasetManifest.sha256&&input.datasetManifest.sha256==='a55730c8b0c036a1c27cfb65650a1ac9e4d21803598113ac2f2d035f91c0154b'
  &&dataset.schema==='zzsh.local-legacy-dataset.v1','AUTH_HANDOFF_TARGET_REQUIRED');
 assertCaptureRestoreBinding(restore,target);
 const targetProof=x=>x?.target?.instance?.systemIdentifier===target.instance.systemIdentifier&&x.target.oid===target.oid&&x.target.marker===target.marker&&x.target.nonce===target.nonce;
 assert(counts.status==='INVITATION_COUNTS_CLOSED_AND_VERIFIED'&&targetProof(counts)&&counts.packets===36&&counts.subjects===174846&&counts.known===174846&&counts.unknown===0
  &&counts.rollbackAck===true&&counts.unlockAck===true&&counts.connectionsClosed===true&&counts.financialWrites===0,'AUTH_HANDOFF_COUNTS_PROOF_REQUIRED');
 assert(schema.status==='SCHEMA_INSTALLED_AND_VERIFIED'&&targetProof(schema)&&schema.contract?.comments===205&&schema.contract?.guards===2&&schema.contract?.constraints===3
  &&schema.contract?.runtimeReadOnly===true&&schema.rollbackAck===true&&schema.unlockAck===true&&schema.connectionsClosed===true&&schema.financialWrites===0,'AUTH_HANDOFF_SCHEMA_PROOF_REQUIRED');
 assert(capture.status==='CAPTURE_SOURCE_AND_TARGET_MATCHED'&&targetProof(capture)&&capture.counts?.selected===26745&&capture.counts?.alreadyPresent===26745
  &&capture.counts?.ratioKnown===26745&&capture.counts?.payoutSelected===4097&&capture.counts?.payoutUnselected===22648
  &&capture.readOnlyRollbackAck===true&&capture.unlockAck===true&&capture.connectionsClosed===true,'AUTH_HANDOFF_CAPTURE_PROOF_REQUIRED');
 const {Client}=require('pg'),proof=toolProof(),planRef=mode==='--prepare'?null:{path:privatePath(option('--plan')),sha256:option('--plan-sha')},plan=planRef?pinned(planRef):null;
 const authorityRef=mode==='--execute'?{path:option('--authority'),sha256:option('--authority-sha')}:null,authority=authorityRef?pinned(authorityRef):null;
 const appliedRef=mode==='--readback'?{path:option('--apply-receipt'),sha256:option('--apply-sha')}:null,applied=appliedRef?pinned(appliedRef):null;
 if(applied)assertAuthHandoffApplyReceipt(applied,planRef.sha256,binding);
 const verifyFiles=()=>{pinned(inputRef);for(const ref of [input.restoreReceipt,input.countsReadback,input.schemaReadback,input.captureReadback,input.datasetManifest])pinned(ref);
  if(planRef)pinned(planRef);if(authorityRef)pinned(authorityRef);if(appliedRef)pinned(appliedRef);
  assert(sha(readFileSync(credentialsPath))===credentialSha&&sha(readFileSync(resourcePath))===resourceSha,'AUTH_HANDOFF_RESOURCE_CHANGED');assert.deepEqual(toolProof(),proof,'AUTH_HANDOFF_TOOL_CHANGED');};
 const c=new Client(targetConnection(target,{user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-auth-handoff',statement_timeout:30000,lock_timeout:3000}));
 let opened=false,begun=false,writeStarted=false,commitSent=false,commitAck=false,rollbackAck=false,unlockAck=false,connectionsClosed=false;
 let result={schema:'zzsh.r07-auth-handoff-receipt.v1',status:'STARTED',mode,target:binding,startedAt:new Date().toISOString(),financialWrites:0};
 if(mode==='--execute')writePrivate(join(out,'receipt.json'),result);const save=()=>writeLoadCheckpoint(join(out,'receipt.json'),result);
 const request=meta=>({schema:'zzsh.admin-staging-handoff.v1',target:binding,sourceDatasetSha256:input.datasetManifest.sha256,approvalRef:meta.approvalRef,attempt:meta.attempt,
  planSha256:planRef.sha256,notBefore:meta.notBefore,expiresAt:meta.expiresAt,actors:plan.snapshot.actors,snapshot:plan.snapshot,snapshotDigest:plan.snapshotDigest});
 try{
  await c.connect();opened=true;await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;await c.query("SET LOCAL TIME ZONE 'UTC'");
  const identity=(await c.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,identity,'migration');assert.equal(String(identity.owner_oid),binding.ownerOid,'AUTH_HANDOFF_OWNER_CHANGED');
  assert((await c.query('SELECT pg_try_advisory_xact_lock($1::bigint) ok',[target.lockKey])).rows[0]?.ok===true,'AUTH_HANDOFF_LOCK_BUSY');
  const live=(await c.query(`SELECT (SELECT count(*)::int FROM zzsh_order.distribution_participant WHERE source_type='LEGACY_MYSQL' AND invitees_knowledge='KNOWN') known,
   (SELECT count(*)::int FROM zzsh_order.distribution_participant WHERE source_type='LEGACY_MYSQL' AND invitees_knowledge='UNKNOWN') unknown,
   (SELECT count(*)::int FROM zzsh_supply.legacy_listing_capture_fact) captures,
   (SELECT max(created_at)::text FROM zzsh_business_meta.migrations) migration_last`)).rows[0];
  assert(live.known===174846&&live.unknown===0&&live.captures===26745&&live.migration_last==='1793730640496','AUTH_HANDOFF_BUSINESS_STATE_CHANGED');
  const snapshot=mode==='--readback'?null:await snapshotDeliveryAuth(c);
  if(snapshot)assert(snapshot.actors.length===4&&snapshot.userSessions.length===1&&snapshot.userVerifications.length===1&&snapshot.userAccounts.n===40224,'AUTH_HANDOFF_PREIMAGE_COUNTS_CHANGED');
  if(mode==='--prepare')result={schema:'zzsh.r07-auth-handoff-plan.v1',status:'PREPARED_READ_ONLY',inputSha256:inputRef.sha256,target:binding,toolFiles:proof,credentialSha,resourceSha,
   restoreSha256:input.restoreReceipt.sha256,countsReadbackSha256:input.countsReadback.sha256,schemaReadbackSha256:input.schemaReadback.sha256,captureReadbackSha256:input.captureReadback.sha256,
   snapshot,snapshotDigest:deliveryAuthSnapshotDigest(snapshot)};
  else{
   assert(plan.schema==='zzsh.r07-auth-handoff-plan.v1'&&plan.status==='PREPARED_READ_ONLY'&&plan.rollbackAck===true&&plan.unlockAck===true&&plan.connectionsClosed===true
    &&plan.inputSha256===inputRef.sha256&&same(plan.target,binding)&&same(plan.toolFiles,proof)&&plan.credentialSha===credentialSha&&plan.resourceSha===resourceSha
    &&deliveryAuthSnapshotDigest(plan.snapshot)===plan.snapshotDigest,'AUTH_HANDOFF_PLAN_CHANGED');
   if(mode==='--execute')assert(deliveryAuthSnapshotDigest(snapshot)===plan.snapshotDigest,'AUTH_HANDOFF_PREIMAGE_CHANGED');
   if(mode==='--readback'){const req=request(applied);assert.equal(deliveryHandoffDigest(req),applied.handoffDigest,'AUTH_HANDOFF_ORIGINAL_KEY_CHANGED');
    const recovered=await recoverDeliveryHandoff(c,req);assert.equal(recovered.knowledge,'KNOWN','AUTH_HANDOFF_ORIGINAL_AUDIT_UNKNOWN');
    result={schema:'zzsh.r07-auth-handoff-readback.v1',status:'LOCAL_AUTH_RETIRED_AND_VERIFIED',target:binding,planSha256:planRef.sha256,commitOutcome:applied.commitAck?'ACKNOWLEDGED':'CONFIRMED_BY_ORIGINAL_AUDIT',
      admins:recovered.actors,userSessions:recovered.userSessions,userVerifications:recovered.userVerifications,userAccountsPreserved:plan.snapshot.userAccounts.n,financialWrites:0};}
  }
  verifyFiles();assert.equal((await c.query('ROLLBACK')).command,'ROLLBACK');begun=false;rollbackAck=true;
  if(mode==='--execute'){
   assertAuthHandoffAuthority(authority,plan,planRef.sha256);const req=request(authority),handoffDigest=deliveryHandoffDigest(req);
   Object.assign(result,{planSha256:planRef.sha256,handoffDigest,approvalRef:authority.approvalRef,attempt:authority.attempt,notBefore:authority.notBefore,expiresAt:authority.expiresAt,status:'TRANSACTION_INTENT'});save();
   writeStarted=true;const done=await retireStagingMigrationAdmins(c,req,{beforeCommit:async()=>{verifyFiles();assertAuthHandoffAuthority(authority,plan,planRef.sha256);result.status='COMMIT_REQUESTED';save();}});
   commitSent=true;commitAck=true;assert(done.status==='STAGING_IDENTITIES_RETIRED'&&done.handoffDigest===handoffDigest,'AUTH_HANDOFF_RESULT_CHANGED');
   Object.assign(result,{status:'COMMIT_ACK_READBACK_REQUIRED',commitSent:true,commitAck:true,admins:done.actors,userSessions:done.userSessions,userVerifications:done.userVerifications});save();
  }
 }catch(e){if(e.message==='ADMIN_HANDOFF_COMMIT_UNKNOWN')commitSent=true;if(e.message==='ADMIN_HANDOFF_ROLLBACK_UNKNOWN')rollbackAck=false;
  result.status=authHandoffFailureStatus(mode,applied?.status,e.message,commitSent,commitAck);
  if(writeStarted&&!commitSent&&e.message!=='ADMIN_HANDOFF_ROLLBACK_UNKNOWN')rollbackAck=true;
  result.error=code(e);if(commitSent){result.commitSent=true;result.commitAck=commitAck;}if(begun){try{rollbackAck=(await c.query('ROLLBACK')).command==='ROLLBACK';begun=false;}catch{rollbackAck=false;}}result.rollbackAck=rollbackAck;process.exitCode=1;
 }finally{
  if(begun)try{await c.query('ROLLBACK');}catch{}let closed=!opened;try{if(opened){await c.end();closed=true;}}catch{}
  const lock=new Client(maintenanceConnection(target,{user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-auth-handoff-lock-check'}));let lockClosed=false;
  try{await lock.connect();const got=(await lock.query('SELECT pg_try_advisory_lock($1::bigint) ok',[target.lockKey])).rows[0]?.ok===true;if(got)unlockAck=(await lock.query('SELECT pg_advisory_unlock($1::bigint) ok',[target.lockKey])).rows[0]?.ok===true;}catch{}
  try{await lock.end();lockClosed=true;}catch{}connectionsClosed=closed&&lockClosed;Object.assign(result,{unlockAck,connectionsClosed,finishedAt:new Date().toISOString()});
 }
 if(mode==='--execute')save();else if(rollbackAck&&unlockAck&&connectionsClosed){result.rollbackAck=true;const file=join(out,mode==='--prepare'?'plan.json':'readback.json');writePrivate(file,result);
  console.log(JSON.stringify({status:result.status,error:result.error,sha256:sha(readFileSync(file)),admins:result.snapshot?.actors.length??result.admins,userSessions:result.snapshot?.userSessions.length??result.userSessions,
   userVerifications:result.snapshot?.userVerifications.length??result.userVerifications,userAccounts:result.snapshot?.userAccounts.n??result.userAccountsPreserved,financialWrites:0}));return;}
 console.log(JSON.stringify({status:result.status,error:result.error,commitAck,rollbackAck,unlockAck,connectionsClosed,financialWrites:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(e=>{console.error(JSON.stringify({status:'AUTH_HANDOFF_STOPPED',code:code(e)}));process.exitCode=1;});
