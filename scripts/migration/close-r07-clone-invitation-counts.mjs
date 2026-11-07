import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';import {dirname,isAbsolute,join,relative,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {writePrivate} from '../local-auth.mjs';import {writeLoadCheckpoint} from './local-load-checkpoint.mjs';
import {loadRegisteredTarget,targetConnection,maintenanceConnection,targetIdentityQuery,assertLiveTarget} from './local-target-registry.mjs';
import {preflightInvitationFile,readBoundInvitationPackets} from './local-round-contract.mjs';
const require=createRequire(import.meta.url),root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'INVITE_CLONE_PRIVATE_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'INVITE_CLONE_PRIVATE_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'INVITE_CLONE_LINK_REFUSED');return p;}
function pinned(ref){const p=privatePath(ref?.path),b=readFileSync(p);assert(hex(ref.sha256)&&sha(b)===ref.sha256,'INVITE_CLONE_INPUT_CHANGED');return JSON.parse(b);}
function code(e){const first=String(e?.message??'').split(/\r?\n/,1)[0].trim();return /^[A-Z][A-Z0-9_]+$/.test(first)?first:e?.code??e?.name??'INVITE_CLONE_FAILED';}
function targetBinding(t,ownerOid){return{instance:t.instance,database:t.database,oid:t.oid,nonce:t.nonce,marker:t.marker,owner:t.owner,ownerOid,migrationRole:t.migrationRole,migrationRoleOid:t.migrationRoleOid,runtimeRole:t.runtimeRole,runtimeRoleOid:t.runtimeRoleOid,lockKey:t.lockKey};}
export function assertCloneCountsTarget(t,credentials,actor,datasetSha){
 assert(t.instance?.host==='127.0.0.1'&&t.instance.port===55434&&/^[0-9]+$/.test(t.instance.systemIdentifier??'')
  &&t.instance.systemIdentifier!=='7704972584346443810'&&t.database==='zzsh_test_r07_delivery_20261108'&&t.marker==='zzsh:r07-delivery-clone:v1'
  &&t.owner==='zzsh'&&t.migrationRole==='zzsh_regression_migration'&&t.migrationRoleOid&&t.runtimeRoleOid&&!t.pendingReset
  &&t.protectedDataset?.manifestSha256===datasetSha&&credentials.migration?.name===t.migrationRole&&credentials.migration?.oid===t.migrationRoleOid
  &&actor.realm==='admin'&&actor.resourceOid===t.oid&&actor.nonce===t.nonce&&/^[A-Za-z0-9._:-]{1,128}$/.test(actor.id??'')
  &&/^[A-Za-z0-9._:-]{1,128}$/.test(actor.sessionId??''),'INVITE_CLONE_TARGET_REQUIRED');
}
export function assertCloneCountsAuthority(a,plan,planSha,now=Date.now()){
 const start=Date.parse(a?.notBefore),end=Date.parse(a?.expiresAt);
 assert(a?.schema==='zzsh.r07-clone-invitation-counts-authority.v1'&&a.status==='APPROVED'&&a.operation==='CLOSE_PROVEN_INVITATION_COUNTS'
  &&a.planSha256===planSha&&JSON.stringify(a.target)===JSON.stringify(plan.target)&&a.maxPackets===plan.packetHashes.length&&a.allowFinancialWrites===false
  &&/^[A-Za-z0-9._:-]{1,179}$/.test(a.approvalRef??'')&&/^[A-Za-z0-9._:-]{1,179}$/.test(a.attempt??'')
  &&Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end&&end>start&&end-start<=30*60_000,'INVITE_CLONE_AUTHORITY_CHANGED');
}
export function assertCloneCountsApplyReceipt(a,planSha,target){
 const ack=a?.status==='COMMIT_ACK_READBACK_REQUIRED'&&a.commitAck===true;
 const unknown=a?.status==='COMMIT_UNKNOWN'&&a.commitAck===false;
 assert(a?.schema==='zzsh.r07-clone-invitation-counts-receipt.v1'&&(ack||unknown)&&a.commitSent===true
  &&a.planSha256===planSha&&a.unlockAck===true&&a.connectionsClosed===true&&JSON.stringify(a.target)===JSON.stringify(target)
  &&/^[A-Za-z0-9._:-]{1,179}$/.test(a.approvalRef??'')&&/^[A-Za-z0-9._:-]{1,179}$/.test(a.attempt??'')
  &&Number.isFinite(Date.parse(a.notBefore))&&Number.isFinite(Date.parse(a.expiresAt))&&Date.parse(a.expiresAt)>Date.parse(a.notBefore)
  &&Date.parse(a.expiresAt)-Date.parse(a.notBefore)<=30*60_000,'INVITE_CLONE_APPLY_RECEIPT_INVALID');
}
function loadedFilesProof(){
 const files=['scripts/migration/close-r07-clone-invitation-counts.mjs','scripts/migration/local-target-registry.mjs','scripts/migration/local-round-contract.mjs',
  'scripts/migration/local-load-checkpoint.mjs','scripts/local-auth.mjs','package-lock.json','node_modules/.package-lock.json'];
 for(const p of Object.keys(require.cache)){const local=p.toLowerCase().startsWith(root.toLowerCase()+'\\')||p.startsWith(root+'/');assert(local,'INVITE_CLONE_DEPENDENCY_OUTSIDE_BUILD');files.push(relative(root,p));
  if(p.toLowerCase().includes('node_modules')){let d=dirname(p);while(d.toLowerCase().startsWith(root.toLowerCase())){const f=join(d,'package.json');if(existsSync(f)){files.push(relative(root,f));break;}const next=dirname(d);if(next===d)break;d=next;}}}
 return Object.fromEntries([...new Set(files)].sort().map(p=>[p.replaceAll('\\','/'),sha(readFileSync(join(root,p)))]));
}
async function main(){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},modes=['--prepare','--execute','--readback'].filter(x=>args.includes(x));
 if(!modes.length){console.log(JSON.stringify({status:'PLAN_ONLY',connections:0,targetWrites:0}));return;}assert.equal(modes.length,1,'INVITE_CLONE_MODE_INVALID');assert.equal(process.version,'v24.20.0','INVITE_CLONE_NODE_CHANGED');
 const mode=modes[0],out=privatePath(option('--out'),true);assert(!existsSync(out),'INVITE_CLONE_OUTPUT_EXISTS');
 const inputRef={path:privatePath(option('--input')),sha256:option('--input-sha')},input=pinned(inputRef);assert(input.schema==='zzsh.r07-clone-invitation-counts-input.v1','INVITE_CLONE_INPUT_INVALID');
 const manifest=pinned(input.datasetManifest),graph=pinned(input.graphReadback),restore=pinned(input.restoreReceipt),actorFile=pinned(input.actor);
 const credentialsPath=privatePath(input.credentialsPath),credentialBytes=readFileSync(credentialsPath),credentials=JSON.parse(credentialBytes),registryPath=privatePath(join(dirname(credentialsPath),'resource.json')),
  registrySha=sha(readFileSync(registryPath)),credentialSha=sha(credentialBytes),target=loadRegisteredTarget(credentialsPath),targetRef=targetBinding(target,restore.target?.owner?.oid);
 assertCloneCountsTarget(target,credentials,actorFile,input.datasetManifest.sha256);
 assert(graph.status==='READ_ONLY_INVITATION_FULL_PROOF_PASSED'&&graph.target?.systemIdentifier===target.instance.systemIdentifier&&graph.target.oid===target.oid
  &&graph.target.marker===target.marker&&graph.sourceReceiptSha256===manifest.sourceReceiptSha256&&graph.invitationFileSha256===manifest.files?.['invitation-facts']?.sha256
  &&graph.packets===manifest.invitationFacts?.selectedPackets&&graph.subjects===manifest.domains?.users?.source&&graph.known===graph.subjects&&graph.edges===manifest.invitationFacts?.relations&&graph.unknown===0&&graph.rollbackAck===true&&graph.connectionClosed===true
  &&restore.schema==='zzsh.r07-demo-clone-restored.v1'&&restore.status==='RESTORED_AND_VERIFIED'&&restore.target?.systemIdentifier===target.instance.systemIdentifier
  &&restore.target?.oid===target.oid&&restore.target?.nonce===target.nonce&&restore.target?.marker===target.marker
  &&restore.target?.owner?.name===target.owner&&/^[0-9]+$/.test(restore.target?.owner?.oid??'')
  &&restore.target?.migration?.name===target.migrationRole&&restore.target?.migration?.oid===target.migrationRoleOid
  &&restore.target?.runtime?.name===target.runtimeRole&&restore.target?.runtime?.oid===target.runtimeRoleOid
  &&restore.source?.database==='zzsh_test_regression'&&restore.source?.systemIdentifier==='7704972584346443810'&&restore.source?.oid==='16390'
  &&['sameExportedSnapshot','dataSummaryMatched','keySetsMatched','objectAclMatched','roleSecurityMatchedWithDeclaredExceptions','rlsAndDefinerMatched','runtimeAccessTested'].every(k=>restore.verification?.[k]===true)
  &&restore.verification?.sourceWrites===0,'INVITE_CLONE_PROOF_CHANGED');
 const packetFile=privatePath(join(dirname(input.datasetManifest.path),manifest.files['invitation-facts'].file)),invitation=require(join(root,'apps/api/dist/src/finance/legacy-invitation-facts.js')),
  writer=require(join(root,'apps/api/dist/src/finance/legacy-invitation-facts-maintenance.js')),{canonicalize}=require(join(root,'apps/api/dist/src/supply/content-hash.js')),{Client}=require('pg');
 const hashes=await preflightInvitationFile(packetFile,manifest.files['invitation-facts'].sha256,manifest,invitation),toolFiles=loadedFilesProof();
 const verifyFiles=()=>{pinned(inputRef);pinned(input.datasetManifest);pinned(input.graphReadback);pinned(input.restoreReceipt);pinned(input.actor);
  assert(sha(readFileSync(credentialsPath))===credentialSha&&sha(readFileSync(registryPath))===registrySha,'INVITE_CLONE_RESOURCE_CHANGED');
  assert.deepEqual(loadedFilesProof(),toolFiles,'INVITE_CLONE_TOOL_CHANGED');};
 const planRef=mode==='--prepare'?null:{path:privatePath(option('--plan')),sha256:option('--plan-sha')},plan=planRef?pinned(planRef):null;
 const authorityRef=mode==='--execute'?{path:option('--authority'),sha256:option('--authority-sha')}:null,authority=authorityRef?pinned(authorityRef):null;
 const appliedRef=mode==='--readback'?{path:option('--apply-receipt'),sha256:option('--apply-sha')}:null,applied=appliedRef?pinned(appliedRef):null;
 if(applied)assertCloneCountsApplyReceipt(applied,planRef.sha256,targetRef);
 const verifyRunFiles=()=>{verifyFiles();if(planRef)pinned(planRef);if(authorityRef)pinned(authorityRef);if(appliedRef)pinned(appliedRef);};
 const lock=new Client(maintenanceConnection(target,{user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-invite-counts-lock'}));
 const client=new Client(targetConnection(target,{user:credentials.migration.name,password:credentials.migration.password,applicationName:'r07-invite-counts',statement_timeout:30000,lock_timeout:1000}));
 let held=false,lockOpen=false,clientOpen=false,begun=false,commitSent=false,commitAck=false,rollbackAck=false,unlockAck=false,connectionsClosed=false;
 let result={schema:'zzsh.r07-clone-invitation-counts-receipt.v1',status:'STARTED',mode,target:targetRef,startedAt:new Date().toISOString(),financialWrites:0};
 if(mode==='--execute')writePrivate(join(out,'receipt.json'),result);const save=()=>writeLoadCheckpoint(join(out,'receipt.json'),result);
 try{
  await lock.connect();lockOpen=true;held=(await lock.query('SELECT pg_try_advisory_lock($1::bigint) ok',[target.lockKey])).rows[0]?.ok===true;assert(held,'INVITE_CLONE_LOCK_BUSY');
  await client.connect();clientOpen=true;await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;const identity=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,identity,'migration');assert.equal(identity.read_only,'on');
  assert.equal(String(identity.owner_oid),targetRef.ownerOid,'INVITE_CLONE_OWNER_OID_CHANGED');
  const pre=(await client.query(`SELECT count(*)::int total,count(*) FILTER(WHERE invitees_knowledge='KNOWN')::int known,count(*) FILTER(WHERE invitees_knowledge='UNKNOWN')::int unknown FROM zzsh_order.distribution_participant WHERE source_type='LEGACY_MYSQL'`)).rows[0];
  const original=(await client.query(`SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.imported' AND actor_id=$1 AND outcome='SUCCESS'`,[actorFile.id])).rows[0]?.n;
  const already=(await client.query(`SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.counts_closed' AND outcome='SUCCESS'`)).rows[0]?.n;
  assert(pre.total===manifest.domains.users.source&&pre.known+pre.unknown===pre.total&&original===hashes.length,'INVITE_CLONE_PREIMAGE_CHANGED');
  const expected={schema:'zzsh.r07-clone-invitation-counts-plan.v1',inputSha256:inputRef.sha256,target:targetRef,toolFiles,credentialSha,registrySha,
   datasetManifestSha256:input.datasetManifest.sha256,graphReadbackSha256:input.graphReadback.sha256,restoreReceiptSha256:input.restoreReceipt.sha256,
   packetFileSha256:manifest.files['invitation-facts'].sha256,packetHashes:hashes,preimage:pre,originalBatches:original};
  if(plan)assert(plan.schema===expected.schema&&plan.status==='PREPARED_READ_ONLY'&&plan.rollbackAck===true&&plan.unlockAck===true&&plan.connectionsClosed===true
    &&plan.inputSha256===expected.inputSha256&&canonicalize(plan.target)===canonicalize(expected.target)&&canonicalize(plan.toolFiles)===canonicalize(expected.toolFiles)
    &&plan.credentialSha===credentialSha&&plan.registrySha===registrySha&&canonicalize(plan.packetHashes)===canonicalize(hashes),'INVITE_CLONE_PLAN_CHANGED');
  if(mode==='--prepare')assert(already===0&&pre.unknown>0,'INVITE_CLONE_PREIMAGE_NOT_ORIGINAL');
  if(mode==='--execute')assert(already===0&&canonicalize(plan.preimage)===canonicalize(pre),'INVITE_CLONE_PREIMAGE_CHANGED');
  if(mode==='--readback'){
   assert(pre.known===pre.total&&pre.unknown===0&&already===hashes.length,'INVITE_CLONE_READBACK_INCOMPLETE');
  }
  assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');begun=false;rollbackAck=true;verifyRunFiles();
  if(mode==='--prepare')result={...expected,status:'PREPARED_READ_ONLY',rollbackAck:true};
  else{
   const reviewMeta=mode==='--execute'?authority:applied;
   if(mode==='--execute'){assertCloneCountsAuthority(authority,plan,planRef.sha256);result.planSha256=planRef.sha256;result.approvalRef=authority.approvalRef;result.attempt=authority.attempt;result.notBefore=authority.notBefore;result.expiresAt=authority.expiresAt;result.status='TRANSACTION_INTENT';save();}
   await client.query(mode==='--execute'?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;const live=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(target,live,'migration');assert.equal(String(live.owner_oid),targetRef.ownerOid,'INVITE_CLONE_OWNER_OID_CHANGED');
   const actor={userId:actorFile.id,sessionId:actorFile.sessionId,requestId:reviewMeta.attempt};let packets=0,subjects=0;
   const resource={host:'127.0.0.1',port:55434,database:target.database,oid:Number(target.oid),owner:target.owner,ownerOid:Number(targetRef.ownerOid),marker:target.marker,
    role:target.migrationRole,roleOid:Number(target.migrationRoleOid)};
   for await(const packet of readBoundInvitationPackets(packetFile,manifest.files['invitation-facts'].sha256,hashes)){
    if(mode==='--execute')assertCloneCountsAuthority(authority,plan,planRef.sha256);
    const review={ref:reviewMeta.approvalRef,attempt:reviewMeta.attempt,actor:{userId:actor.userId,sessionId:actor.sessionId},resource,
     notBefore:reviewMeta.notBefore,expiresAt:reviewMeta.expiresAt,sourceDigest:invitation.invitationFactHash(packet.input.source),bodyDigest:packet.bodyDigest,
     phase:'COUNTS',nonce:target.nonce,systemIdentifier:target.instance.systemIdentifier};
    const scope=await writer.bindReviewedLegacyInvitationFacts(client,actor,review,mode==='--execute'?'execute':'recover');
    if(mode==='--execute'){const changed=await writer.closeReviewedLegacyInvitationCounts(client,actor,packet.input,packet.bodyDigest,scope);assert.equal(changed.status,200,'INVITE_CLONE_PACKET_REJECTED');}
    else{const recovered=await writer.recoverReviewedLegacyInvitationFacts(client,actor,packet.input,packet.bodyDigest,scope,'COUNTS');assert.equal(recovered.knowledge,'KNOWN','INVITE_CLONE_RECEIPT_MISSING');
     const audit=(await client.query(`SELECT count(*)::int n FROM zzsh_iam.audit_event WHERE action='distribution.legacy_facts.counts_closed' AND object_id=$1 AND actor_id=$2 AND session_id=$3 AND outcome='SUCCESS' AND details->>'bodyDigest'=$1 AND details->>'financialEffects'='false'`,[packet.bodyDigest,actor.userId,actor.sessionId])).rows[0]?.n;assert.equal(audit,1,'INVITE_CLONE_AUDIT_MISSING');}
    packets++;subjects+=packet.input.subjects.length;if(mode==='--execute'){result.processedInOpenTransaction=packets;save();}
   }
   assert(packets===hashes.length&&subjects===manifest.domains.users.source,'INVITE_CLONE_PACKET_SET_CHANGED');verifyRunFiles();
   if(mode==='--execute'){await client.query('SET CONSTRAINTS ALL IMMEDIATE');assertCloneCountsAuthority(authority,plan,planRef.sha256);assertLiveTarget(target,(await client.query(targetIdentityQuery())).rows[0],'migration');
    result.status='COMMIT_REQUESTED';result.commitSent=true;save();commitSent=true;assert.equal((await client.query('COMMIT')).command,'COMMIT');begun=false;commitAck=true;result.status='COMMIT_ACK_READBACK_REQUIRED';result.commitAck=true;result.packets=packets;result.subjects=subjects;save();}
   else{assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');begun=false;rollbackAck=true;result={schema:'zzsh.r07-clone-invitation-counts-readback.v1',status:'INVITATION_COUNTS_CLOSED_AND_VERIFIED',
     target:targetRef,planSha256:planRef.sha256,commitOutcome:applied.commitAck?'ACKNOWLEDGED':'CONFIRMED_BY_ORIGINAL_RECEIPTS',packets,subjects,known:pre.known,unknown:pre.unknown,financialWrites:0,rollbackAck:true};}
  }
 }catch(e){result.status=mode==='--readback'&&applied?.status==='COMMIT_UNKNOWN'?'COMMIT_UNKNOWN_UNRESOLVED':commitSent&&!commitAck?'COMMIT_UNKNOWN':commitAck?'COMMIT_ACK_READBACK_REQUIRED':'STOPPED';result.error=code(e);
  if(commitSent)result.commitAck=commitAck;
  if(begun&&!commitSent){try{rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';begun=false;}catch{rollbackAck=false;}}result.rollbackAck=rollbackAck;process.exitCode=1;
 }finally{
  if(begun&&!commitSent)try{await client.query('ROLLBACK');}catch{}let cClosed=!clientOpen,lClosed=!lockOpen;
  try{if(clientOpen){await client.end();cClosed=true;}}catch{}try{if(held)unlockAck=(await lock.query('SELECT pg_advisory_unlock($1::bigint) ok',[target.lockKey])).rows[0]?.ok===true;}catch{}
  try{if(lockOpen){await lock.end();lClosed=true;}}catch{}connectionsClosed=cClosed&&lClosed;Object.assign(result,{unlockAck,connectionsClosed,finishedAt:new Date().toISOString()});
 }
 if(mode==='--execute')save();else if(rollbackAck&&unlockAck&&connectionsClosed){const file=join(out,mode==='--prepare'?'plan.json':'readback.json');writePrivate(file,result);
  console.log(JSON.stringify({status:result.status,error:result.error,sha256:sha(readFileSync(file)),preimage:result.preimage,packets:result.packets,subjects:result.subjects,known:result.known,unknown:result.unknown,financialWrites:0}));return;}
 console.log(JSON.stringify({status:result.status,error:result.error,processedInOpenTransaction:result.processedInOpenTransaction,commitAck,rollbackAck,unlockAck,connectionsClosed,financialWrites:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main().catch(e=>{console.error(JSON.stringify({status:'INVITE_CLONE_STOPPED',code:code(e)}));process.exitCode=1;});
