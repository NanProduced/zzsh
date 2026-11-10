import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { assertDistributionCoreReadback, assertRegisteredDistributionTarget, isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';
import { assertRoundDependencyProof, inspectRoundDependencyLayout } from './local-round-dependencies.mjs';
import { collectListedAccounts } from './legacy-listed-round-source.mjs';
import { readSourceRows } from './local-source-adapter.mjs';
import { acquireMigrationTransactionFence, advisoryLockSql, assertLiveTarget, assertMigrationFenceHeld, captureMaintenanceLockEpoch, loadRegisteredTarget, maintenanceConnection, NEXT_MIGRATION_PROFILE, targetConnection, targetIdentityQuery } from './local-target-registry.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>/^[a-f0-9]{64}$/.test(value??'');

export function assertSealedTools(manifest,tools) {
  assert(manifest?.schema==='zzsh.round07-source-snapshot.v1' && Array.isArray(manifest.files),'EMPTY_LISTED_SOURCE_MANIFEST_INVALID');
  for(const [path,digest] of Object.entries(tools)){
    const entries=manifest.files.filter(entry=>entry?.path===path);
    assert(hex(digest) && entries.length===1 && entries[0].sha256===digest,'EMPTY_LISTED_TOOL_NOT_SEALED');
  }
}

/** Prove the source set is empty using the exact bytes consumed by the parser. */
export async function scanEmptyListedSource(file,entry) {
  assert(entry?.file==='accounts.jsonl' && hex(entry.sha256) && Number.isSafeInteger(entry.rows) && entry.rows>=0,'EMPTY_LISTED_SOURCE_ENTRY_INVALID');
  const hash=createHash('sha256');
  const scan=await collectListedAccounts(readSourceRows(file,chunk=>hash.update(chunk)),JSON.stringify);
  assert(hash.digest('hex')===entry.sha256 && scan.captured===entry.rows,'EMPTY_LISTED_SOURCE_CHANGED');
  assert(scan.accounts.size===0,'EMPTY_LISTED_SOURCE_HAS_LISTINGS');
  return {capturedAccounts:scan.captured,listedAccounts:0};
}

/** Historical source status and new-platform publication are distinct target facts. */
export async function readEmptyListedTarget(client) {
  const result=await client.query(`SELECT
    (SELECT count(*)::text FROM zzsh_supply.legacy_listing_read_snapshot
      WHERE source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts' AND source_status=3) AS observations,
    (SELECT count(*)::text FROM zzsh_supply.listing_publication p JOIN zzsh_supply.legacy_supply_map m ON m.account_id=p.account_id
      WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts') AS publications`);
  const row=result.rows[0];
  assert(result.rows.length===1 && typeof row?.observations==='string' && typeof row?.publications==='string'
    && /^(0|[1-9]\d*)$/.test(row.observations) && /^(0|[1-9]\d*)$/.test(row.publications),'EMPTY_LISTED_TARGET_UNAVAILABLE');
  return {status:row.observations==='0' && row.publications==='0'?'EMPTY_LISTED_TARGET_READBACK_PASSED':'EMPTY_LISTED_TARGET_REVIEW_REQUIRED',
    listedObservations:row.observations,mappedAccountPublications:row.publications};
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length===0){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--readback','--input','--input-sha','--maintenance-password-file','--out'],connections:0,targetWrites:0}));return;}
  assert(args[0]==='--readback' && process.version==='v24.20.0','EMPTY_LISTED_EXPLICIT_MODE_REQUIRED');
  const required=['--input','--input-sha','--maintenance-password-file','--out'],options=new Map();
  assert(args.length===1+required.length*2,'EMPTY_LISTED_ARGUMENTS_INVALID');
  for(let i=1;i<args.length;i+=2){
    assert(required.includes(args[i]) && !options.has(args[i]) && args[i+1] && !args[i+1].startsWith('--'),'EMPTY_LISTED_ARGUMENTS_INVALID');
    options.set(args[i],args[i+1]);
  }
  const option=name=>options.get(name);
  const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
  function privatePath(value,output=false){
    assert(typeof value==='string' && isAbsolute(value),'EMPTY_LISTED_PRIVATE_PATH_REQUIRED');
    const path=resolve(value),rel=relative(restricted,path);
    assert(rel && !rel.startsWith('..') && !isAbsolute(rel),'EMPTY_LISTED_PRIVATE_PATH_REQUIRED');
    for(let current=output?dirname(path):path;;current=dirname(current)){
      if(existsSync(current))assert(!lstatSync(current).isSymbolicLink(),'EMPTY_LISTED_LINK_REFUSED');
      if(current.toLowerCase()===restricted.toLowerCase())break;
    }
    return path;
  }
  function pinned(ref){
    const path=privatePath(ref?.path),bytes=readFileSync(path);
    assert(hex(ref.sha256) && sha(bytes)===ref.sha256,'EMPTY_LISTED_INPUT_CHANGED');
    return JSON.parse(bytes);
  }
  const startedAt=new Date().toISOString(),started=performance.now(),inputRef={path:option('--input'),sha256:option('--input-sha')},input=pinned(inputRef);
  assert(input.schema==='zzsh.empty-legacy-listed-readback-input.v1','EMPTY_LISTED_INPUT_INVALID');
  const round=pinned(input.roundInput),core=pinned(input.coreReceipt),coreReadback=pinned(input.coreReadback);
  assert(round.schema==='zzsh.local-round.v1' && input.roundInput.sha256===core.inputSha256,'EMPTY_LISTED_ROUND_CHANGED');
  assertDistributionCoreReadback(core,coreReadback,{roundInputSha256:input.roundInput.sha256,readbackSha256:input.coreReadback.sha256,
    datasetSha256:round.dataset?.sha256,sourceSha256:round.source?.sha256,target:round.target});
  const receiptPath=join(privatePath(round.source?.path),'receipt.json'),receipt=pinned({path:receiptPath,sha256:round.source.sha256});
  assert(receipt.schema==='zzsh.legacy-source-capture.v1' && receipt.status==='CAPTURED_READ_ONLY' && receipt.database==='sg_zzsh_restore'
    && receipt.rollbackConfirmed===true && receipt.clientClosed===true && receipt.identity?.database===receipt.database
    && receipt.identity.readOnly===1 && receipt.identity.isolation==='REPEATABLE-READ'
    && receipt.identity.accessMode==='READ ONLY' && receipt.identity.txState==='ACTIVE','EMPTY_LISTED_SOURCE_NOT_CONFIRMED');
  const entry=receipt.files?.accounts,sourceFile=privatePath(join(dirname(receiptPath),entry?.file??''));
  const out=privatePath(option('--out'),true);assert(!existsSync(out),'EMPTY_LISTED_OUTPUT_EXISTS');
  const toolNames=['readback-empty-legacy-listed.mjs','legacy-listed-round-source.mjs','local-source-adapter.mjs',
    'local-distribution-qualification-plan.mjs','local-round-dependencies.mjs','local-target-registry.mjs','../local-auth.mjs'];
  const toolFiles=Object.fromEntries(toolNames.map(name=>[name,sha(readFileSync(new URL(name,import.meta.url)))]));
  const sealedTools=Object.fromEntries(toolNames.map(name=>[relative(root,fileURLToPath(new URL(name,import.meta.url))).replaceAll('\\','/'),toolFiles[name]]));
  const source=await scanEmptyListedSource(sourceFile,entry);
  const actor=pinned(round.actor),actorId=actor.id??actor.actorId;
  assert(typeof actorId==='string' && actorId && typeof actor.sessionId==='string' && actor.sessionId
    && (!actor.actorId || actor.actorId===actorId),'EMPTY_LISTED_ACTOR_REQUIRED');
  assert(isAbsolute(round.credentials??''),'EMPTY_LISTED_CREDENTIALS_REQUIRED');
  const credentialsPath=resolve(round.credentials),resourcePath=join(dirname(credentialsPath),'resource.json');
  assert(!lstatSync(credentialsPath).isSymbolicLink() && !lstatSync(resourcePath).isSymbolicLink(),'EMPTY_LISTED_LINK_REFUSED');
  const resource=JSON.parse(readFileSync(resourcePath)),registered=loadRegisteredTarget(credentialsPath),credentials=JSON.parse(readFileSync(credentialsPath));
  assertRegisteredDistributionTarget(round.target,round.dataset.sha256,resource);
  assert(credentials.runtime?.name===registered.runtimeRole && credentials.runtime?.oid===registered.runtimeRoleOid
    && credentials.database===registered.database,'EMPTY_LISTED_TARGET_CHANGED');
  const api=isolatedDistributionBuild(root,round.apiDist),dep=round.dependencyBinding;
  assert(dep?.proof && dep.buildManifest && dep.sourceManifest && round.bootstrapEvidence?.bundle,'EMPTY_LISTED_BUILD_PROOF_REQUIRED');
  const proof=pinned(dep.proof),layout=inspectRoundDependencyLayout({apiDist:api,bundlePath:round.bootstrapEvidence.bundle.path,
    bundleSha256:round.bootstrapEvidence.bundle.sha256,buildManifestPath:dep.buildManifest.path,buildManifestSha256:dep.buildManifest.sha256,
    sourceSnapshot:dep.sourceSnapshot,sourceManifestPath:dep.sourceManifest.path,sourceManifestSha256:dep.sourceManifest.sha256});
  assertRoundDependencyProof(proof,layout);
  const checkTools=()=>{
    const sourceManifest=readFileSync(dep.sourceManifest.path);
    assert(sha(sourceManifest)===dep.sourceManifest.sha256,'EMPTY_LISTED_SOURCE_MANIFEST_CHANGED');
    assertSealedTools(JSON.parse(sourceManifest),sealedTools);
    for(const name of toolNames){
      for(const file of [fileURLToPath(new URL(name,import.meta.url)),join(layout.scriptDir,name),join(dep.sourceSnapshot,'scripts/migration',name)]){
        for(let path=resolve(file);path!==dirname(path);path=dirname(path))assert(!lstatSync(path).isSymbolicLink(),'EMPTY_LISTED_LINK_REFUSED');
        assert(sha(readFileSync(file))===toolFiles[name],'EMPTY_LISTED_TOOL_CHANGED');
      }
    }
  };
  checkTools();
  process.env.NODE_PATH=layout.moduleDirs.join(delimiter);Module._initPaths();
  const modulePath=join(api,'auth/auth-security.js');
  assert(hex(round.buildFiles?.['auth/auth-security.js']) && sha(readFileSync(modulePath))===round.buildFiles['auth/auth-security.js'],'EMPTY_LISTED_BUILD_CHANGED');
  const require=createRequire(join(layout.sourceRoot,'apps/api/package.json')),{Client}=require('pg');
  const {assertAdminContextInTransaction}=require(modulePath);
  function checkLoadedModules(){
    const dependencies=new Map(proof.closureFiles),used={};
    for(const file of Object.keys(require.cache)){
      const apiRelative=relative(api,file).replaceAll('\\','/');
      if(apiRelative && !apiRelative.startsWith('../') && !isAbsolute(apiRelative)){
        assert(sha(readFileSync(file))===round.buildFiles?.[apiRelative],'EMPTY_LISTED_BUILD_CHANGED');
        used[apiRelative]=round.buildFiles[apiRelative];
      }
      if(file.toLowerCase().includes('node_modules')){
        const name=relative(layout.sourceRoot,file).replaceAll('\\','/');
        assert(name && !name.startsWith('../') && !isAbsolute(name) && dependencies.get(name)===sha(readFileSync(file)),'EMPTY_LISTED_DEPENDENCY_CHANGED');
      }
    }
    assert(Object.hasOwn(used,'auth/auth-security.js'),'EMPTY_LISTED_BUILD_CHANGED');
    return used;
  }
  checkLoadedModules();
  const passwordFile=option('--maintenance-password-file');assert(isAbsolute(passwordFile??'') && !lstatSync(passwordFile).isSymbolicLink(),'EMPTY_LISTED_LOCK_CREDENTIAL_REQUIRED');
  const lock=new Client(maintenanceConnection(registered,{user:'zzsh',password:readFileSync(passwordFile,'utf8').trim(),connectionTimeoutMillis:3000,
    applicationName:'empty-listed-readback-lock'}));
  const client=new Client(targetConnection(registered,{user:credentials.runtime.name,password:credentials.runtime.password,connectionTimeoutMillis:3000,
    statement_timeout:30000,lock_timeout:1000,applicationName:'empty-listed-readback'}));
  let locked=false,transaction=false,rollbackConfirmed=false,lockReleased=false,connectionsClosed=false,result,targetObservedAt,fenceEpoch;
  try{
    await lock.connect();locked=(await lock.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(locked,'EMPTY_LISTED_LOCK_BUSY');
    if(registered.migrationProfile===NEXT_MIGRATION_PROFILE)fenceEpoch=await captureMaintenanceLockEpoch(lock,registered);
    await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
    await client.query('SET LOCAL row_security=off');
    const live=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,live,'runtime');
    assert(live.read_only==='on','EMPTY_LISTED_READ_ONLY_REQUIRED');
    if(fenceEpoch)await acquireMigrationTransactionFence(client,registered,fenceEpoch);
    const at=(await client.query('SELECT transaction_timestamp() AS at')).rows[0]?.at;
    assert(at instanceof Date && Number.isFinite(at.getTime()),'EMPTY_LISTED_TIME_UNAVAILABLE');targetObservedAt=at.toISOString();
    await assertAdminContextInTransaction(client,{userId:actorId,sessionId:actor.sessionId});
    result=await readEmptyListedTarget(client);
    if(fenceEpoch)await assertMigrationFenceHeld(client,registered,fenceEpoch);
    rollbackConfirmed=(await client.query('ROLLBACK')).command==='ROLLBACK';transaction=false;
    assert(rollbackConfirmed,'EMPTY_LISTED_ROLLBACK_UNCONFIRMED');
  }finally{
    if(transaction)try{rollbackConfirmed=(await client.query('ROLLBACK')).command==='ROLLBACK';}catch{}
    try{await client.end();connectionsClosed=true;}catch{}
    if(locked)try{lockReleased=(await lock.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{}
    try{await lock.end();}catch{connectionsClosed=false;}
  }
  assert(rollbackConfirmed && lockReleased && connectionsClosed,'EMPTY_LISTED_CLEANUP_UNCONFIRMED');
  assert(sha(readFileSync(receiptPath))===round.source.sha256,'EMPTY_LISTED_SOURCE_CHANGED');
  const after=createHash('sha256');for await(const chunk of createReadStream(sourceFile))after.update(chunk);
  assert(after.digest('hex')===entry.sha256,'EMPTY_LISTED_SOURCE_CHANGED');
  pinned(inputRef);pinned(input.roundInput);pinned(input.coreReceipt);pinned(input.coreReadback);pinned(round.actor);pinned(dep.proof);
  assertRegisteredDistributionTarget(round.target,round.dataset.sha256,JSON.parse(readFileSync(resourcePath)));
  assert(sha(readFileSync(modulePath))===round.buildFiles['auth/auth-security.js'],'EMPTY_LISTED_BUILD_CHANGED');
  assertRoundDependencyProof(proof,layout);checkTools();const usedBuildModules=checkLoadedModules();
  const report={schema:'zzsh.empty-legacy-listed-readback.v1',...result,source,roundInputSha256:input.roundInput.sha256,
    sourceReceiptSha256:round.source.sha256,sourceAccountsSha256:entry.sha256,coreReadbackSha256:input.coreReadback.sha256,
    target:{database:registered.database,oid:registered.oid,nonce:registered.nonce,instance:registered.instance,...(registered.migrationProfile?{migrationProfile:registered.migrationProfile}:{})},startedAt,targetObservedAt,finishedAt:new Date().toISOString(),
    wallMs:Math.round(performance.now()-started),rollbackConfirmed,lockReleased,connectionsClosed,toolFiles,usedBuildModules,targetWrites:0,...(fenceEpoch?{targetFence:'HELD_UNTIL_ROLLBACK'}:{}),
    limitations:['POINT_IN_TIME_ONLY','PRICING_AND_OTHER_DOMAINS_NOT_ASSESSED','RESTORE_AND_BROWSER_NOT_ASSESSED']};
  mkdirSync(out,{mode:0o700});
  writePrivate(join(out,'readback.json'),report);
  console.log(JSON.stringify({status:report.status,capturedAccounts:source.capturedAccounts,listedAccounts:0,
    listedObservations:result.listedObservations,mappedAccountPublications:result.mappedAccountPublications,targetWrites:0,...(fenceEpoch?{targetFence:report.targetFence}:{})}));
  if(result.status!=='EMPTY_LISTED_TARGET_READBACK_PASSED')process.exitCode=1;
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  const code=/^([A-Z][A-Z0-9_]+)(?:[:\r\n]|$)/.exec(error.message??'')?.[1]??error.code??error.name;
  console.error(JSON.stringify({status:'EMPTY_LISTED_READBACK_STOPPED',code}));process.exitCode=1;
});
