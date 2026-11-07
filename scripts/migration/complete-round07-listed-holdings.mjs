import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { readSourceRows } from './local-source-adapter.mjs';
import { advisoryLockSql, assertLiveTarget, loadRegisteredTarget, maintenanceConnection, targetConnection, targetIdentityQuery } from './local-target-registry.mjs';
import { assertDistributionCoreReadback, isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted'),sha=x=>createHash('sha256').update(x).digest('hex');
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'R07_HOLDING_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_HOLDING_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_HOLDING_LINK_REFUSED');return p;}
function pinned(ref){const file=privatePath(ref?.path),bytes=readFileSync(file);assert(/^[a-f0-9]{64}$/.test(ref.sha256??'')&&sha(bytes)===ref.sha256,'R07_HOLDING_INPUT_CHANGED');return JSON.parse(bytes);}
async function sourceFile(dir,entry){assert(entry&&entry.file===basename(entry.file)&&/^[a-f0-9]{64}$/.test(entry.sha256??''),'R07_HOLDING_SOURCE_INVALID');const file=privatePath(join(dir,entry.file)),h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);assert.equal(h.digest('hex'),entry.sha256,'R07_HOLDING_SOURCE_CHANGED');return file;}
export function assertHoldingTrial(plan,trial,planSha){
 assert(trial?.schema==='zzsh.round07-listed-holdings-trial.v1'&&trial.status==='ALL_ROLLED_BACK'&&trial.planSha256===planSha
  &&JSON.stringify(trial.target)===JSON.stringify(plan.target)&&trial.rollbackAck===true&&trial.lockReleased===true&&trial.connectionsClosed===true
  &&JSON.stringify(trial.sourceIds)===JSON.stringify(plan.rows.filter(x=>!x.alreadyPresent).map(x=>x.sourceId)),'R07_HOLDING_TRIAL_CHANGED');
}
export async function applyHoldingTransaction({client,rows,apply,save}){
 let begun=false,commitSent=false;const state={status:'STARTED',rows:rows.length};
 try{await client.query('BEGIN');begun=true;for(const row of rows)await apply(row);state.status='COMMIT_INTENT';save(state);commitSent=true;
  const result=await client.query('COMMIT');assert.equal(result.command,'COMMIT','R07_HOLDING_COMMIT_ACK_MISSING');begun=false;state.status='COMMIT_ACK';save(state);return state;
 }catch(error){state.status=commitSent?'COMMIT_UNKNOWN':'STOPPED_BEFORE_COMMIT';if(begun&&!commitSent){try{state.rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';}catch{state.rollbackAck=false;}}save(state);throw error;}
}
export function listedHoldingMode(args){
 const modes=['--prepare','--trial','--execute','--readback'].filter(name=>args.includes(name));
 assert(modes.length<=1,'R07_HOLDING_MODE_INVALID');return modes[0]??null;
}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];},mode=listedHoldingMode(args);
 if(!mode){console.log(JSON.stringify({status:'PLAN_ONLY',modes:['--prepare','--trial','--execute','--readback'],executeTrial:['--trial-receipt','--trial-sha'],connections:0,targetWrites:0}));return;}
 assert(process.version==='v24.20.0','R07_HOLDING_MODE_INVALID');const out=privatePath(option('--out'),true);assert(!existsSync(out),'R07_HOLDING_OUTPUT_EXISTS');
 const started=performance.now(),startedAt=new Date().toISOString();
 const supplied=pinned({path:option('--input'),sha256:option('--input-sha')}),input=mode==='--prepare'?supplied:pinned(supplied.inputRef),plan=mode==='--prepare'?null:supplied;
 assert(input.schema==='zzsh.round07-listed-holdings-input.v1','R07_HOLDING_INPUT_INVALID');
 const round=pinned(input.roundInput),core=pinned(input.coreReceipt),readback=pinned(input.coreReadback),rebind=pinned(input.skinRebind),overlay=pinned(input.overlay),priorSkin=pinned(input.priorSkinAudit),audit=pinned(input.listedAudit);
 assertDistributionCoreReadback(core,readback,{roundInputSha256:input.roundInput.sha256,readbackSha256:input.coreReadback.sha256,datasetSha256:round.dataset.sha256,sourceSha256:round.source.sha256,target:round.target});
 assert(round.target?.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'&&rebind.status==='SOURCE_AND_TARGET_MAPPING_VERIFIED_NO_WRITES'
  &&rebind.sourceSha256===round.source.sha256&&rebind.overlaySha256===input.overlay.sha256&&rebind.priorSkinAuditSha256===input.priorSkinAudit.sha256
  &&rebind.target?.oid===round.target.oid&&rebind.target?.nonce===round.target.nonce&&JSON.stringify(rebind.target.instance)===JSON.stringify(round.target.instance)
  &&audit.status==='OFFLINE_INPUT_COMPATIBLE_TARGET_NOT_RUN'&&audit.sourceReceiptSha256===round.source.sha256&&audit.supplementalOverlaySha256===input.overlay.sha256,
 'R07_HOLDING_EVIDENCE_CHANGED');
 const credentialsPath=privatePath(round.credentials),credentialsBytes=readFileSync(credentialsPath),credentials=JSON.parse(credentialsBytes),registered=loadRegisteredTarget(credentialsPath),actorFile=pinned(round.actor);
 assert(registered.oid===round.target.oid&&registered.nonce===round.target.nonce&&JSON.stringify(registered.instance)===JSON.stringify(round.target.instance)&&!registered.pendingReset
  &&registered.protectedDataset?.manifestSha256===round.dataset.sha256&&registered.protectedDataset.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'
  &&registered.protectedDataset.status==='LOCAL_DATASET_SKIN_HOLDINGS_COMMITTED_REVIEW_REQUIRED'&&credentials.migration?.name===registered.migrationRole&&credentials.migration?.oid===registered.migrationRoleOid
  &&actorFile.realm==='admin'&&actorFile.resourceOid===registered.oid&&actorFile.nonce===registered.nonce&&actorFile.id===actorFile.actorId&&actorFile.sessionId,
 'R07_HOLDING_TARGET_CHANGED');
 const api=isolatedDistributionBuild(root,round.apiDist),require=createRequire(join(root,'apps/api/package.json')),{Client,Pool}=require('pg');
 const toolFiles=Object.fromEntries(['complete-round07-listed-holdings.mjs','local-source-adapter.mjs','local-target-registry.mjs','local-distribution-qualification-plan.mjs','../local-auth.mjs'].map(name=>[name,sha(readFileSync(join(root,'scripts/migration',name)))]));
 const mod=name=>{const file=join(api,name+'.js');assert.equal(sha(readFileSync(file)),round.buildFiles?.[name+'.js'],'R07_HOLDING_BUILD_CHANGED');return require(file);};
 const skin=mod('legacy-load/legacy-skin-holdings'),writer=mod('supply/legacy-observation'),{canonicalize}=mod('supply/content-hash'),order=mod('order/legacy-order-read');
 const dataset=pinned({path:join(round.dataset.path,'manifest.json'),sha256:round.dataset.sha256}),source=pinned({path:join(round.source.path,'receipt.json'),sha256:round.source.sha256});
 const accountPath=await sourceFile(round.source.path,source.files.accountDisplay),dictionaryPath=await sourceFile(round.source.path,source.files.skinDictionaryData),typesPath=await sourceFile(round.source.path,source.files.skinDictionaryTypes);
 assert(overlay.sourceReceiptSha256===round.source.sha256&&overlay.sourceExtractSha256===source.files.accountDisplay.sha256&&overlay.sourceDictionarySha256===source.files.skinDictionaryData.sha256,'R07_HOLDING_OVERLAY_CHANGED');
 const actors={id:actorFile.id,sessionId:actorFile.sessionId,requestId:'r07-listed-skin-completion'},target={oid:registered.oid,nonce:registered.nonce,instance:registered.instance},ids=rebind.accounts.map(x=>x.sourceId);
 assert(ids.length===10&&new Set(ids).size===ids.length&&audit.accounts.length===ids.length&&audit.accounts.every(x=>rebind.accounts.some(y=>y.sourceId===x.sourceId&&y.sourceDigest===x.sourceDigest)),'R07_HOLDING_SOURCE_SET_CHANGED');
 const raw=new Map();for await(const row of readSourceRows(accountPath))if(ids.includes(row.id)){assert(!raw.has(row.id),'R07_HOLDING_SOURCE_DUPLICATE');raw.set(row.id,row);}assert.equal(raw.size,ids.length,'R07_HOLDING_SOURCE_SET_CHANGED');
 const dictionary=[];for await(const row of readSourceRows(dictionaryPath))dictionary.push(row);const types=new Map();for await(const row of readSourceRows(typesPath))types.set(row.id,row);
 for(const m of overlay.mappings){const matches=dictionary.filter(r=>r.name===m.token&&r.value===m.token);assert(matches.length===m.sourceRows.length&&m.sourceRows.every(x=>matches.some(r=>r.id===String(x.dictDataId)&&r.type_id===String(x.dictTypeId)&&types.get(r.type_id)?.dict_type===x.dictField&&(r.is_delete==='1'?'HISTORICAL_SOFT_DELETED':'CURRENT')===x.state)),'R07_HOLDING_DICTIONARY_CHANGED');}
 const script=readFileSync(join(root,'tmp/round07-source-snapshot-20261106-01/scripts/migration/local-target-holdings.mjs'),'utf8'),m=/const AMBIGUOUS = (\[[^\]]+\]);/.exec(script);assert(m,'R07_HOLDING_RULES_UNAVAILABLE');
 const tokenRules=JSON.parse(m[1]).map((token,index)=>{const matches=dictionary.filter(x=>x.name===token&&x.value===token);assert(matches.length>=2&&matches.every(x=>types.has(x.type_id)&&['0','1'].includes(x.is_delete)),'R07_HOLDING_AMBIGUITY_CHANGED');return{field:index===0?'knife_skin':'weapon_skin',token,decision:'SOURCE_AMBIGUOUS',sources:matches.map(x=>({dictField:types.get(x.type_id).dict_type,dictTypeId:Number(x.type_id),dictDataId:Number(x.id),state:x.is_delete==='1'?'HISTORICAL_SOFT_DELETED':'CURRENT'}))};});
 const common={connectionTimeoutMillis:3000,statement_timeout:30000,lock_timeout:1000},maintenance=new Client(maintenanceConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password})),pool=new Pool(targetConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password,max:1}));
 let held=false,client,rollbackAck=false,lockReleased=false,connectionsClosed=false,result,error;
 try{
  await maintenance.connect();held=(await maintenance.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(held,'R07_HOLDING_LOCK_BUSY');client=await pool.connect();
  await client.query('BEGIN READ ONLY');const actual=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,actual);assert.equal(actual.read_only,'on');
  const games=(await client.query("SELECT id,catalog_revision::text revision FROM zzsh_supply.game WHERE code='delta'")).rows;assert(games.length===1&&games[0].id===overlay.gameId&&games[0].revision===overlay.catalogRevision,'R07_HOLDING_CATALOG_CHANGED');
  const catalog=(await client.query(`SELECT id AS "skinId",game_id AS "gameId",source_field AS "sourceField",source_token AS "sourceToken",naming_state AS "namingState",enabled,form_visible AS "formVisible",source_namespace AS "sourceNamespace",name,owner_kind AS "ownerKind" FROM zzsh_supply.skin WHERE game_id=$1 ORDER BY id`,[games[0].id])).rows;
  const map=(await client.query(`SELECT m.legacy_id,m.account_id,m.version_id,m.source_digest,h.skin_ids,h.holding_digest,h.source_digest AS holding_source_digest,h.observation_version_id FROM zzsh_supply.legacy_supply_map m LEFT JOIN zzsh_supply.legacy_skin_holding h ON h.account_id=m.account_id WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts' AND m.legacy_id=ANY($1::text[])`,[ids])).rows;
  assert(map.length===ids.length&&new Set(map.map(x=>x.legacy_id)).size===ids.length,'R07_HOLDING_TARGET_SET_CHANGED');
  const index=skin.buildLegacySkinIndex(catalog,tokenRules,overlay),prior=new Map(priorSkin.rows.map(x=>[x.sourceId,x])),mapById=new Map(map.map(x=>[x.legacy_id,x]));
  const targetBindingsSha256=sha(canonicalize([...map].map(x=>({legacy_id:x.legacy_id,account_id:x.account_id,version_id:x.version_id,source_digest:x.source_digest})).sort((a,b)=>a.legacy_id<b.legacy_id?-1:1)));
  const sourceContext={schema:'legacy-skin-holdings-source-v2',mappingOverlay:{sha256:sha(canonicalize(overlay)),body:overlay},sourceSystem:'legacy_mysql_restore',sourceEntity:'la_rental_accounts',sourceExtractSha256:source.files.accountDisplay.sha256,
   sourceCutoff:new Date(dataset.sourceCutoff).toISOString(),targetBindingsSha256,tokenRulesVersion:'SUP-SKIN-020-nine-source-ambiguities-v1',tokenRulesExtractSha256:round.source.sha256,tokenRules,gameId:games[0].id,catalogRevision:games[0].revision};
  const rows=[];for(const id of ids){const original=raw.get(id),expected=rebind.accounts.find(x=>x.sourceId===id),targetRow=mapById.get(id),old=prior.get(id);
   assert(original&&expected&&targetRow&&targetRow.source_digest===expected.sourceDigest&&sha(canonicalize(original))===expected.sourceDigest&&old?.complete===true,'R07_HOLDING_ACCOUNT_CHANGED');
   const columns=Object.fromEntries(skin.LEGACY_SKIN_FIELDS.map(name=>[name,original[name]])),holding=skin.mapLegacySkinHolding({accountKey:id,gameId:games[0].id,columns},index,games[0].revision),skinIds=skin.declarableLegacySkinIds(holding),oldIds=[...new Set(old.tokenMappings.flatMap(x=>(x.targets??[]).map(t=>t.id)))].sort(),updated=order.legacyEpochTimestamp(original.update_time);
   assert(skinIds&&canonicalize([...skinIds].sort())===canonicalize(oldIds)&&updated&&Date.parse(updated)<=Date.parse(sourceContext.sourceCutoff),'R07_HOLDING_MAPPING_CHANGED');
   const present=targetRow.skin_ids!==null;if(present)assert(canonicalize([...targetRow.skin_ids].sort())===canonicalize([...skinIds].sort())&&targetRow.holding_source_digest===targetRow.source_digest&&targetRow.observation_version_id===targetRow.version_id,'R07_HOLDING_EXISTING_DIFFERS');
   rows.push({sourceId:id,sealedRow:{legacyId:id,accountId:targetRow.account_id,observationVersionId:targetRow.version_id,sourceDigest:targetRow.source_digest,sourceUpdatedAtUtc:updated,columns},expectedSkinIds:skinIds,expectedHoldingDigest:holding.digest,alreadyPresent:present,evidenceRef:dataset.sourceRef+':skin-holdings:'+id});
  }
  rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';
  if(mode==='--prepare')result={schema:'zzsh.round07-listed-holdings-plan.v1',status:'PREPARED_READ_ONLY',inputRef:{path:option('--input'),sha256:option('--input-sha')},target,toolFiles,sourceContext,rows,preparedAt:new Date().toISOString()};
  else{
   assert(plan.schema==='zzsh.round07-listed-holdings-plan.v1'&&plan.status==='PREPARED_READ_ONLY'&&JSON.stringify(plan.target)===JSON.stringify(target)
    &&canonicalize(plan.toolFiles)===canonicalize(toolFiles)
    &&canonicalize(plan.sourceContext)===canonicalize(sourceContext)&&canonicalize(plan.rows.map(x=>({...x,alreadyPresent:false})))===canonicalize(rows.map(x=>({...x,alreadyPresent:false}))), 'R07_HOLDING_PLAN_CHANGED');
   const pending=plan.rows.filter(x=>!x.alreadyPresent);if(mode!=='--readback')assert(pending.every(x=>rows.find(y=>y.sourceId===x.sourceId)?.alreadyPresent===false),'R07_HOLDING_ALREADY_CHANGED');
   if(mode==='--trial'||mode==='--execute')assert(Date.parse(round.window.notBefore)<=Date.now()&&Date.now()<Date.parse(round.window.expiresAt),'R07_HOLDING_WINDOW_EXPIRED');
   const apply=async row=>{const bytes=Buffer.from(JSON.stringify({...sourceContext,rows:[row.sealedRow]})),admission=writer.prepareLegacySkinHoldingsAdmission(bytes,sha(bytes)),prepared=writer.prepareLegacySkinHoldingsInput(admission,row.sourceId,catalog,row.evidenceRef);assert.deepEqual([...prepared.input.skinIds].sort(),[...row.expectedSkinIds].sort());await writer.recordLegacySkinHoldings(client,prepared.accountId,prepared.input,actors,admission);};
   if(mode==='--trial'){
    const progress={schema:'zzsh.round07-listed-holdings-trial-progress.v1',status:'TRIAL_INTENT',planSha256:option('--input-sha'),target,rows:pending.length};writePrivate(join(out,'progress.json'),progress);
    await client.query('BEGIN');try{for(const row of pending)await apply(row);rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';progress.status=rollbackAck?'TRIAL_ROLLBACK_ACK':'TRIAL_ROLLBACK_UNCONFIRMED';writePrivate(join(out,'progress.json'),progress);}
    catch(e){try{progress.rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';}catch{progress.rollbackAck=false;}progress.status='TRIAL_STOPPED';progress.error=e.code??e.name;writePrivate(join(out,'progress.json'),progress);throw e;}
    result={schema:'zzsh.round07-listed-holdings-trial.v1',status:'ALL_ROLLED_BACK',planSha256:option('--input-sha'),target,sourceIds:pending.map(x=>x.sourceId),rollbackAck};
   }else if(mode==='--execute'){
    const trial=pinned({path:option('--trial-receipt'),sha256:option('--trial-sha')});assertHoldingTrial(plan,trial,option('--input-sha'));
    const attempt=join(dirname(privatePath(option('--input'))),'apply-attempt.json'),fd=openSync(attempt,'wx',0o600);try{writeFileSync(fd,JSON.stringify({planSha256:option('--input-sha'),target,at:new Date().toISOString()}));fsyncSync(fd);}finally{closeSync(fd);}
    const save=state=>writePrivate(join(out,'receipt.json'),{schema:'zzsh.round07-listed-holdings-apply.v1',planSha256:option('--input-sha'),target,startedAt,wallMs:performance.now()-started,...state});
    result=await applyHoldingTransaction({client,rows:pending,apply,save});
   }else{
    const applied=pinned({path:option('--apply-receipt'),sha256:option('--apply-sha')});assert(applied.schema==='zzsh.round07-listed-holdings-apply.v1'&&applied.status==='COMMIT_ACK'&&applied.lockReleased===true&&applied.connectionsClosed===true&&applied.planSha256===option('--input-sha')&&JSON.stringify(applied.target)===JSON.stringify(target),'R07_HOLDING_APPLY_UNCONFIRMED');
    assert(rows.every(x=>x.alreadyPresent),'R07_HOLDING_READBACK_MISSING');result={schema:'zzsh.round07-listed-holdings-readback.v1',status:'ALL_SOURCE_MAPPINGS_VERIFIED',planSha256:option('--input-sha'),target,accounts:rows.length};
   }
  }
 }catch(e){error=e;}
 finally{try{client?.release();await pool.end();connectionsClosed=true;}catch{connectionsClosed=false;}try{if(held)lockReleased=(await maintenance.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{lockReleased=false;}try{await maintenance.end();}catch{connectionsClosed=false;}}
 if(error||!result||!rollbackAck||!lockReleased||!connectionsClosed){if(error)throw error;throw Error('R07_HOLDING_CLEANUP_UNCONFIRMED');}
 if(mode==='--prepare'){Object.assign(result,{startedAt,finishedAt:new Date().toISOString(),wallMs:performance.now()-started});writePrivate(join(out,'plan.json'),result);console.log(JSON.stringify({status:result.status,plan:join(out,'plan.json'),sha256:sha(readFileSync(join(out,'plan.json'))),accounts:result.rows.length,missing:result.rows.filter(x=>!x.alreadyPresent).length,targetWrites:0}));return;}
 if(mode==='--trial'){Object.assign(result,{lockReleased,connectionsClosed,startedAt,finishedAt:new Date().toISOString(),wallMs:performance.now()-started});writePrivate(join(out,'trial.json'),result);console.log(JSON.stringify({status:result.status,trial:join(out,'trial.json'),sha256:sha(readFileSync(join(out,'trial.json'))),count:result.sourceIds.length,targetWrites:0}));return;}
 if(mode==='--execute'){const receipt=pinned({path:join(out,'receipt.json'),sha256:sha(readFileSync(join(out,'receipt.json')))});writePrivate(join(out,'receipt.json'),{...receipt,lockReleased,connectionsClosed,finishedAt:new Date().toISOString(),wallMs:performance.now()-started});console.log(JSON.stringify({status:receipt.status,receipt:join(out,'receipt.json'),sha256:sha(readFileSync(join(out,'receipt.json'))),written:receipt.rows}));return;}
 Object.assign(result,{rollbackAck,lockReleased,connectionsClosed,startedAt,finishedAt:new Date().toISOString(),wallMs:performance.now()-started});writePrivate(join(out,'readback.json'),result);console.log(JSON.stringify({status:result.status,readback:join(out,'readback.json'),sha256:sha(readFileSync(join(out,'readback.json'))),accounts:result.accounts,targetWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_HOLDING_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
