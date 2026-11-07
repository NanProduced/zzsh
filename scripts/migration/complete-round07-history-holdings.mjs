import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,lstatSync,readFileSync} from 'node:fs';
import {createRequire,Module} from 'node:module';
import {basename,delimiter,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writePrivate} from '../local-auth.mjs';
import {readSourceRows} from './local-source-adapter.mjs';
import {loadRegisteredTarget,targetIdentityQuery,assertLiveTarget} from './local-target-registry.mjs';
import {assertDistributionCoreReadback} from './local-distribution-qualification-plan.mjs';
import {inspectRoundDependencyLayout,assertRoundDependencyProof} from './local-round-dependencies.mjs';
import {writeLoadCheckpoint} from './local-load-checkpoint.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'HISTORY_HOLDING_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'HISTORY_HOLDING_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'HISTORY_HOLDING_LINK_REFUSED');return p;}
function pinned(ref){const p=privatePath(ref?.path),b=readFileSync(p);assert(hex(ref.sha256)&&sha(b)===ref.sha256,'HISTORY_HOLDING_INPUT_CHANGED');return JSON.parse(b);}
async function sourceFile(dir,entry){assert(entry&&entry.file===basename(entry.file)&&hex(entry.sha256),'HISTORY_HOLDING_SOURCE_INVALID');const p=privatePath(join(dir,entry.file)),h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);assert.equal(h.digest('hex'),entry.sha256,'HISTORY_HOLDING_SOURCE_CHANGED');return p;}
export function selectReviewedHistoryCandidates(isolated,overlay){
 assert(Array.isArray(isolated?.isolated)&&Array.isArray(overlay?.mappings)&&overlay.mappings.length===5,'HISTORY_HOLDING_CANDIDATE_SOURCE_INVALID');
 const exact=new Set(overlay.mappings.map(x=>x.field+'\0'+x.token));assert.equal(exact.size,5,'HISTORY_HOLDING_OVERLAY_DUPLICATE');
 const ids=[];for(const x of isolated.isolated){const bad=[...(x.holding?.pending??[]),...(x.holding?.unresolved??[])];
  if(bad.length&&bad.every(v=>exact.has(v.field+'\0'+v.token))&&!(x.holding?.unobservedColumns??[]).length&&!x.reasons?.includes('SOURCE_UPDATED_AT_NOT_BOUND'))ids.push(x.sourceId);}
 assert(ids.every(x=>typeof x==='string')&&new Set(ids).size===ids.length,'HISTORY_HOLDING_DUPLICATE_SOURCE');return ids.sort();
}
export function assertHistoryHoldingAuthority(authority,plan,planSha,now=Date.now()){
 const start=Date.parse(authority?.notBefore),end=Date.parse(authority?.expiresAt);
 assert(authority?.schema==='zzsh.r07-history-holdings-authority.v1'&&authority.approvedBy==='Root'&&authority.status==='APPROVED'&&authority.planSha256===planSha
  &&canonical(authority.target)===canonical(plan.target)&&authority.operation==='ADD_REVIEWED_COMPLETE_HOLDINGS'&&authority.maxAccounts===plan.rows.length
  &&authority.lock==='806006'&&authority.allowFinancialWrites===false&&typeof authority.approvalRef==='string'&&/^[A-Za-z0-9._:-]{1,179}$/.test(authority.approvalRef)&&/^[A-Za-z0-9._:-]{1,179}$/.test(authority.attempt??'')
  &&Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end&&end>start&&end-start<=30*60000,'HISTORY_HOLDING_AUTHORITY_CHANGED');
}

async function main(){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},modes=['--prepare','--sign','--execute','--readback'].filter(x=>args.includes(x));
 if(!modes.length){console.log(JSON.stringify({status:'PLAN_ONLY',connections:0,targetWrites:0}));return;}assert.equal(modes.length,1,'HISTORY_HOLDING_MODE_INVALID');
 const mode=modes[0],out=privatePath(option('--out'),true);assert(!existsSync(out),'HISTORY_HOLDING_OUTPUT_EXISTS');
 const inputRef={path:privatePath(option('--input')),sha256:option('--input-sha')},input=pinned(inputRef);assert(input.schema==='zzsh.r07-history-holdings-input.v1','HISTORY_HOLDING_INPUT_INVALID');
 const round=pinned(input.round),core=pinned(input.core),coreReadback=pinned(input.coreReadback),isolated=pinned(input.isolated),overlay=pinned(input.overlay),listedPlan=pinned(input.listedPlan),listedReadback=pinned(input.listedReadback),summary=pinned(input.candidateSummary);
 assertDistributionCoreReadback(core,coreReadback,{roundInputSha256:input.round.sha256,readbackSha256:input.coreReadback.sha256,datasetSha256:round.dataset.sha256,sourceSha256:round.source.sha256,target:round.target});
 assert(listedPlan.schema==='zzsh.round07-listed-holdings-plan.v1'&&listedReadback.status==='ALL_SOURCE_MAPPINGS_VERIFIED'&&listedReadback.planSha256===input.listedPlan.sha256
  &&summary.status==='READ_ONLY_CANDIDATES_ONLY'&&summary.counts?.candidateAccounts===2499&&summary.counts?.remainingAccounts===2567
  &&overlay.sourceReceiptSha256===round.source.sha256&&listedPlan.sourceContext?.mappingOverlay?.sha256===sha(canonical(overlay)),'HISTORY_HOLDING_EVIDENCE_CHANGED');
 const cp=privatePath(round.credentials),credentials=JSON.parse(readFileSync(cp)),registered=loadRegisteredTarget(cp),actorFile=pinned(round.actor),target={oid:registered.oid,nonce:registered.nonce,instance:registered.instance};
 assert(registered.oid===round.target.oid&&registered.nonce===round.target.nonce&&canonical(registered.instance)===canonical(round.target.instance)&&registered.port===55433
  &&!registered.pendingReset&&registered.lockKey==='806006'&&registered.protectedDataset?.manifestSha256===round.dataset.sha256
  &&credentials.migration?.name===registered.migrationRole&&credentials.migration?.oid===registered.migrationRoleOid&&actorFile.realm==='admin'&&actorFile.resourceOid===registered.oid&&actorFile.nonce===registered.nonce&&actorFile.sessionId,'HISTORY_HOLDING_TARGET_CHANGED');
 const dep=round.dependencyBinding,proof=pinned(dep.proof),layout=inspectRoundDependencyLayout({apiDist:round.apiDist,bundlePath:round.bootstrapEvidence.bundle.path,bundleSha256:round.bootstrapEvidence.bundle.sha256,buildManifestPath:dep.buildManifest.path,buildManifestSha256:dep.buildManifest.sha256,sourceSnapshot:dep.sourceSnapshot,sourceManifestPath:dep.sourceManifest.path,sourceManifestSha256:dep.sourceManifest.sha256});assertRoundDependencyProof(proof,layout);
 process.env.NODE_PATH=layout.moduleDirs.join(delimiter);Module._initPaths();const require=createRequire(join(round.apiDist,'app.js')),{Client}=require('pg');
 const mod=name=>{const file=join(round.apiDist,name+'.js');assert.equal(sha(readFileSync(file)),round.buildFiles?.[name+'.js'],'HISTORY_HOLDING_BUILD_CHANGED');return require(file);};
 const skin=mod('legacy-load/legacy-skin-holdings'),writer=mod('supply/legacy-observation'),{canonicalize}=mod('supply/content-hash'),order=mod('order/legacy-order-read');
 const source=pinned({path:join(round.source.path,'receipt.json'),sha256:round.source.sha256}),dataset=pinned({path:join(round.dataset.path,'manifest.json'),sha256:round.dataset.sha256});
 const accountPath=await sourceFile(round.source.path,source.files.accountDisplay);await sourceFile(round.source.path,source.files.skinDictionaryData);await sourceFile(round.source.path,source.files.skinDictionaryTypes);
 assert(overlay.sourceExtractSha256===source.files.accountDisplay.sha256&&overlay.sourceDictionarySha256===source.files.skinDictionaryData.sha256,'HISTORY_HOLDING_OVERLAY_SOURCE_CHANGED');
 const selectedIds=selectReviewedHistoryCandidates(isolated,overlay),idSet=new Set(selectedIds),prior=new Map(isolated.isolated.map(x=>[x.sourceId,x])),raw=new Map();
 assert.equal(selectedIds.length,2504,'HISTORY_HOLDING_CANDIDATE_COUNT_CHANGED');for await(const row of readSourceRows(accountPath))if(idSet.has(row.id)){assert(!raw.has(row.id),'HISTORY_HOLDING_SOURCE_DUPLICATE');raw.set(row.id,row);}assert.equal(raw.size,selectedIds.length,'HISTORY_HOLDING_SOURCE_MISSING');
 const toolFiles=Object.fromEntries(['complete-round07-history-holdings.mjs','local-source-adapter.mjs','local-target-registry.mjs','local-distribution-qualification-plan.mjs','local-round-dependencies.mjs','../local-auth.mjs'].map(x=>[x,sha(readFileSync(join(root,'scripts/migration',x)))]));
 const verifyFiles=()=>{for(const [name,digest]of Object.entries(toolFiles))assert.equal(sha(readFileSync(join(root,'scripts/migration',name))),digest,'HISTORY_HOLDING_TOOL_CHANGED');assertRoundDependencyProof(proof,layout);for(const name of ['legacy-load/legacy-skin-holdings','supply/legacy-observation','supply/content-hash','order/legacy-order-read'])assert.equal(sha(readFileSync(join(round.apiDist,name+'.js'))),round.buildFiles[name+'.js'],'HISTORY_HOLDING_BUILD_CHANGED');};
 const planRef=mode==='--prepare'?null:{path:privatePath(option('--plan')),sha256:option('--plan-sha')},plan=planRef?pinned(planRef):null;
 if(mode==='--sign'){
  assert(plan.schema==='zzsh.r07-history-holdings-plan.v1'&&plan.inputSha256===inputRef.sha256&&canonical(plan.toolFiles)===canonical(toolFiles),'HISTORY_HOLDING_PLAN_CHANGED');
  const authority={schema:'zzsh.r07-history-holdings-authority.v1',approvedBy:'Root',status:'APPROVED',planSha256:planRef.sha256,target:plan.target,operation:'ADD_REVIEWED_COMPLETE_HOLDINGS',maxAccounts:plan.rows.length,lock:'806006',allowFinancialWrites:false,notBefore:option('--not-before'),expiresAt:option('--expires-at'),approvalRef:option('--review-ref'),attempt:option('--attempt')};
  assertHistoryHoldingAuthority(authority,plan,planRef.sha256);writePrivate(join(out,'authority.json'),authority);console.log(JSON.stringify({status:'HISTORY_HOLDING_AUTHORITY_SEALED',sha256:sha(readFileSync(join(out,'authority.json'))),maxAccounts:authority.maxAccounts,notBefore:authority.notBefore,expiresAt:authority.expiresAt}));return;
 }
 const common={host:registered.host,port:registered.port,user:credentials.migration.name,password:credentials.migration.password,statement_timeout:30000,lock_timeout:1000,connectionTimeoutMillis:3000},client=new Client({...common,database:registered.database,application_name:'r07-history-holdings'}),lock=new Client({...common,database:'postgres',application_name:'r07-history-holdings-lock'});
 let held=false,begun=false,commitSent=false,commitAck=false,rollbackAck=false,closed=false,lockClosed=false,unlockAck=false,result={schema:'zzsh.r07-history-holdings-receipt.v1',status:'STARTED',mode,target,startedAt:new Date().toISOString(),financialWrites:0,automaticRetry:false};
 if(mode==='--execute')writePrivate(join(out,'receipt.json'),result);
 const save=()=>writeLoadCheckpoint(join(out,'receipt.json'),result);
 try{
  await lock.connect();held=(await lock.query('SELECT pg_try_advisory_lock(806006) AS ok')).rows[0]?.ok===true;assert(held,'HISTORY_HOLDING_LOCK_BUSY');await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;const identity=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,identity,'migration');assert.equal(identity.read_only,'on');
  const games=(await client.query("SELECT id,catalog_revision::text revision FROM zzsh_supply.game WHERE code='delta'")).rows;assert(games.length===1&&games[0].id===overlay.gameId&&games[0].revision===overlay.catalogRevision,'HISTORY_HOLDING_CATALOG_CHANGED');
  const catalog=(await client.query('SELECT id AS "skinId",game_id AS "gameId",source_field AS "sourceField",source_token AS "sourceToken",naming_state AS "namingState",enabled,form_visible AS "formVisible",source_namespace AS "sourceNamespace",name,owner_kind AS "ownerKind" FROM zzsh_supply.skin WHERE game_id=$1 ORDER BY id',[games[0].id])).rows;
  const mapped=(await client.query("SELECT m.legacy_id,m.account_id,m.version_id,m.source_digest,h.skin_ids,h.holding_digest,h.source_digest AS holding_source_digest,h.observation_version_id,EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot o JOIN zzsh_order.legacy_continuation_evidence e ON e.order_id=o.id AND e.source_kind='SOURCE_IMPORT' WHERE o.account_id=m.account_id) AS inflight FROM zzsh_supply.legacy_supply_map m LEFT JOIN zzsh_supply.legacy_skin_holding h ON h.account_id=m.account_id WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=ANY($1::text[])",[selectedIds])).rows;
  assert(mapped.length===selectedIds.length&&new Set(mapped.map(x=>x.legacy_id)).size===selectedIds.length,'HISTORY_HOLDING_TARGET_SET_CHANGED');const targetMap=new Map(mapped.map(x=>[x.legacy_id,x])),index=skin.buildLegacySkinIndex(catalog,listedPlan.sourceContext.tokenRules,overlay);
  const pendingIds=mode==='--prepare'?selectedIds.filter(id=>targetMap.get(id).skin_ids===null):plan.rows.map(x=>x.sourceId);
  assert.equal(pendingIds.length,2499,'HISTORY_HOLDING_TARGET_COUNT_CHANGED');
  const targetBindingsSha256=sha(canonicalize(pendingIds.map(id=>{const x=targetMap.get(id);return{legacy_id:x.legacy_id,account_id:x.account_id,version_id:x.version_id,source_digest:x.source_digest};}).sort((a,b)=>a.legacy_id<b.legacy_id?-1:1)));
  const sourceContext={...listedPlan.sourceContext,targetBindingsSha256};const rows=[];
  for(const id of pendingIds){const original=raw.get(id),previous=prior.get(id),dest=targetMap.get(id),columns=Object.fromEntries(skin.LEGACY_SKIN_FIELDS.map(k=>[k,original[k]]));
   assert(original&&previous&&dest&&sha(canonicalize(original))===dest.source_digest,'HISTORY_HOLDING_SOURCE_IDENTITY_CHANGED');
   const holding=skin.mapLegacySkinHolding({accountKey:id,gameId:games[0].id,columns},index,games[0].revision),skinIds=skin.declarableLegacySkinIds(holding),updated=order.legacyEpochTimestamp(original.update_time);
   assert(skinIds&&previous.holding.mappedSkinIds.every(x=>skinIds.includes(x))&&updated&&Date.parse(updated)<=Date.parse(dataset.sourceCutoff),'HISTORY_HOLDING_MAPPING_INCOMPLETE');
   const present=dest.skin_ids!==null;if(present)assert(canonicalize([...dest.skin_ids].sort())===canonicalize([...skinIds].sort())&&dest.holding_source_digest===dest.source_digest&&dest.observation_version_id===dest.version_id&&dest.holding_digest===holding.digest,'HISTORY_HOLDING_EXISTING_DIFFERS');
   rows.push({sourceId:id,sealedRow:{legacyId:id,accountId:dest.account_id,observationVersionId:dest.version_id,sourceDigest:dest.source_digest,sourceUpdatedAtUtc:updated,columns},expectedSkinIds:skinIds,expectedHoldingDigest:holding.digest,evidenceRef:dataset.sourceRef+':skin-holdings:'+id,inflight:dest.inflight,present});
  }
  assert.equal(rows.filter(x=>x.inflight).length,163,'HISTORY_HOLDING_INFLIGHT_CHANGED');const before=rows.filter(x=>!x.present).length;
  if(mode==='--prepare')assert.equal(before,2499,'HISTORY_HOLDING_PREIMAGE_CHANGED');else{
   assert(plan.schema==='zzsh.r07-history-holdings-plan.v1'&&plan.inputSha256===inputRef.sha256&&canonical(plan.target)===canonical(target)&&canonical(plan.toolFiles)===canonical(toolFiles)
    &&canonical(plan.sourceContext)===canonical(sourceContext)&&canonical(plan.rows.map(({present,...x})=>x))===canonical(rows.map(({present,...x})=>x)),'HISTORY_HOLDING_PLAN_CHANGED');
   assert.equal(before,mode==='--execute'?2499:0,'HISTORY_HOLDING_PREIMAGE_CHANGED');
  }
  const remaining=mode==='--readback'?(await client.query("SELECT count(*)::int AS n FROM zzsh_supply.legacy_supply_map m LEFT JOIN zzsh_supply.legacy_skin_holding h ON h.account_id=m.account_id WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND h.account_id IS NULL")).rows[0].n:null;
  assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');begun=false;rollbackAck=true;verifyFiles();
  if(mode==='--prepare'){
   result={schema:'zzsh.r07-history-holdings-plan.v1',status:'PREPARED_READ_ONLY',inputSha256:inputRef.sha256,target,toolFiles,sourceContext,rows,counts:{selected:rows.length,inflight:163,alreadyReviewed:5,otherUnknown:2567},readOnlyRollbackAck:true};
  }else if(mode==='--execute'){
   const authority=pinned({path:option('--authority'),sha256:option('--authority-sha')});assertHistoryHoldingAuthority(authority,plan,planRef.sha256);
   result.planSha256=planRef.sha256;result.status='TRANSACTION_INTENT';save();await client.query('BEGIN');begun=true;
   const actor={id:actorFile.id,sessionId:actorFile.sessionId,requestId:'r07-reviewed-history-skin-completion'};
   for(const [i,row] of rows.entries()){
    assertHistoryHoldingAuthority(authority,plan,planRef.sha256);const bytes=Buffer.from(JSON.stringify({...sourceContext,rows:[row.sealedRow]})),admission=writer.prepareLegacySkinHoldingsAdmission(bytes,sha(bytes)),prepared=writer.prepareLegacySkinHoldingsInput(admission,row.sourceId,catalog,row.evidenceRef);
    assert.deepEqual([...prepared.input.skinIds].sort(),[...row.expectedSkinIds].sort());await writer.recordLegacySkinHoldings(client,prepared.accountId,prepared.input,actor,admission);
    if((i+1)%100===0){verifyFiles();assertHistoryHoldingAuthority(authority,plan,planRef.sha256);result.processedInOpenTransaction=i+1;save();}
   }
   verifyFiles();assertHistoryHoldingAuthority(authority,plan,planRef.sha256);await client.query('SET CONSTRAINTS ALL IMMEDIATE');assertHistoryHoldingAuthority(authority,plan,planRef.sha256);
   result.status='COMMIT_REQUESTED';save();commitSent=true;const ack=await client.query('COMMIT');assert.equal(ack.command,'COMMIT','HISTORY_HOLDING_COMMIT_ACK_MISSING');begun=false;commitAck=true;result.status='COMMIT_ACK_READBACK_REQUIRED';result.commitAck=true;result.rows=rows.length;save();
  }else{
   const applied=pinned({path:option('--apply-receipt'),sha256:option('--apply-sha')});assert(applied.status==='COMMIT_ACK_READBACK_REQUIRED'&&applied.commitAck===true&&applied.planSha256===planRef.sha256&&canonical(applied.target)===canonical(target)&&applied.unlockAck===true&&applied.connectionsClosed===true,'HISTORY_HOLDING_APPLY_UNCONFIRMED');
   assert.equal(remaining,2567,'HISTORY_HOLDING_REMAINING_CHANGED');result={schema:'zzsh.r07-history-holdings-readback.v1',status:'EXACT_HISTORY_HOLDINGS_READBACK_PASSED',planSha256:planRef.sha256,target,matched:rows.length,inflight:163,remainingUnknown:remaining,readOnlyRollbackAck:true};
  }
 }catch(error){result.status=commitSent&&!commitAck?'COMMIT_UNKNOWN':commitAck?'COMMIT_ACK_READBACK_REQUIRED':'STOPPED';result.error=/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name;if(begun&&!commitSent){try{rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';begun=false;}catch{rollbackAck=false;}}result.rollbackAck=rollbackAck;process.exitCode=1;}
 finally{if(begun&&!commitSent)try{rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';}catch{}try{await client.end();closed=true;}catch{}try{if(held)unlockAck=(await lock.query('SELECT pg_advisory_unlock(806006) AS ok')).rows[0]?.ok===true;}catch{}try{await lock.end();lockClosed=true;}catch{}}
 if(result.status==='PREPARED_READ_ONLY'&&rollbackAck&&unlockAck&&closed&&lockClosed){result.finishedAt=new Date().toISOString();writePrivate(join(out,'plan.json'),result);console.log(JSON.stringify({status:result.status,sha256:sha(readFileSync(join(out,'plan.json'))),counts:result.counts,targetWrites:0}));return;}
 if(result.status==='EXACT_HISTORY_HOLDINGS_READBACK_PASSED'&&rollbackAck&&unlockAck&&closed&&lockClosed){Object.assign(result,{unlockAck,connectionsClosed:true,finishedAt:new Date().toISOString(),targetWrites:0});writePrivate(join(out,'readback.json'),result);console.log(JSON.stringify({status:result.status,sha256:sha(readFileSync(join(out,'readback.json'))),matched:result.matched,inflight:result.inflight,remainingUnknown:result.remainingUnknown,targetWrites:0}));return;}
 Object.assign(result,{unlockAck,connectionsClosed:closed&&lockClosed,finishedAt:new Date().toISOString()});if(mode==='--execute')save();console.log(JSON.stringify({status:result.status,processedInOpenTransaction:result.processedInOpenTransaction,rows:result.rows,rollbackAck:result.rollbackAck,unlockAck,connectionsClosed:result.connectionsClosed,financialWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'HISTORY_HOLDING_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
