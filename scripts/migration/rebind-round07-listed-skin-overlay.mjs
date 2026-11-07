import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { assertSourceSupplementFields, readSourceRows } from './local-source-adapter.mjs';
import { assertLiveTarget, loadRegisteredTarget, targetConnection, targetIdentityQuery } from './local-target-registry.mjs';
import { isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted'),sha=x=>createHash('sha256').update(x).digest('hex');
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'R07_SKIN_REBIND_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_SKIN_REBIND_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_SKIN_REBIND_LINK_REFUSED');return p;}
function pinned(value,digest){const p=privatePath(value),bytes=readFileSync(p);assert(/^[a-f0-9]{64}$/.test(digest??'')&&sha(bytes)===digest,'R07_SKIN_REBIND_INPUT_CHANGED');return JSON.parse(bytes);}
async function sourceFile(root,entry){assert(entry&&entry.file===basename(entry.file)&&/^[a-f0-9]{64}$/.test(entry.sha256??''),'R07_SKIN_REBIND_SOURCE_INVALID');const path=privatePath(join(root,entry.file)),h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);assert.equal(h.digest('hex'),entry.sha256,'R07_SKIN_REBIND_SOURCE_CHANGED');return path;}
export function rebindOverlay(original,{sourceReceiptSha256,sourceExtractSha256,sourceDictionarySha256,gameId,catalogRevision}){
 return {...original,sourceReceiptSha256,sourceExtractSha256,sourceDictionarySha256,gameId,catalogRevision};
}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 if(!args.includes('--prepare')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--prepare','--input','--input-sha','--out'],sourceWrites:0,targetWrites:0}));return;}
 const input=pinned(option('--input'),option('--input-sha')),out=privatePath(option('--out'),true);assert(!existsSync(out)&&input.schema==='zzsh.round07-skin-rebind-input.v1','R07_SKIN_REBIND_INPUT_INVALID');
 const oldSource=privatePath(input.oldSource.path),source=privatePath(input.source.path),oldReceipt=pinned(join(oldSource,'receipt.json'),input.oldSource.sha256),receipt=pinned(join(source,'receipt.json'),input.source.sha256),
  audit=pinned(input.priorAudit.path,input.priorAudit.sha256),skinAudit=pinned(input.priorSkinAudit.path,input.priorSkinAudit.sha256),overlay=pinned(input.priorOverlay.path,input.priorOverlay.sha256),round=pinned(input.roundInput.path,input.roundInput.sha256);
 assert([oldReceipt,receipt].every(x=>x.status==='CAPTURED_READ_ONLY'&&x.rollbackConfirmed===true&&x.clientClosed===true)
  &&oldReceipt.containerId===receipt.containerId&&oldReceipt.database===receipt.database&&audit.status==='OFFLINE_INPUT_COMPATIBLE_TARGET_NOT_RUN'
  &&audit.sourceReceiptSha256===input.oldSource.sha256&&audit.skinAuditSha256===input.priorSkinAudit.sha256&&audit.skinOverlaySha256===input.priorOverlay.sha256
  &&skinAudit.sourceReceiptSha256===input.oldSource.sha256&&skinAudit.overlayFileSha256===input.priorOverlay.sha256
  &&overlay.sourceReceiptSha256===input.oldSource.sha256&&overlay.sourceExtractSha256===oldReceipt.files?.accountDisplay?.sha256
  &&overlay.sourceDictionarySha256===oldReceipt.files?.skinDictionaryData?.sha256&&receipt.files?.skinDictionaryData?.sha256===oldReceipt.files.skinDictionaryData.sha256
  &&receipt.files?.skinDictionaryTypes?.sha256===oldReceipt.files?.skinDictionaryTypes?.sha256&&round.source?.sha256===input.source.sha256,
 'R07_SKIN_REBIND_SOURCE_BINDING_CHANGED');
 const api=isolatedDistributionBuild(root,round.apiDist),modulePath=join(api,'legacy-load/legacy-skin-holdings.js'),hashPath=join(api,'supply/content-hash.js');
 assert(sha(readFileSync(modulePath))===round.buildFiles?.['legacy-load/legacy-skin-holdings.js']&&sha(readFileSync(hashPath))===round.buildFiles?.['supply/content-hash.js'],'R07_SKIN_REBIND_BUILD_CHANGED');
 const require=createRequire(join(root,'apps/api/package.json')),{Client}=require('pg'),skin=require(modulePath),{canonicalize}=require(hashPath);
 const oldPath=await sourceFile(oldSource,oldReceipt.files.accountDisplay),newPath=await sourceFile(source,receipt.files.accountDisplay),dictPath=await sourceFile(source,receipt.files.skinDictionaryData),typePath=await sourceFile(source,receipt.files.skinDictionaryTypes);
 const expected=new Map((audit.accounts??[]).map(x=>[x.sourceId,x.sourceDigest]));assert(expected.size>0&&expected.size===audit.accounts.length,'R07_SKIN_REBIND_AUDIT_SET_INVALID');
 const oldRows=new Map(),newRows=new Map();for await(const r of readSourceRows(oldPath))if(expected.has(r.id))oldRows.set(r.id,r);for await(const r of readSourceRows(newPath))if(expected.has(r.id))newRows.set(r.id,r);
 assert(oldRows.size===expected.size&&newRows.size===expected.size,'R07_SKIN_REBIND_ACCOUNT_MISSING');
 for(const [id,digest] of expected){const previous=oldRows.get(id),next=newRows.get(id);assert.equal(sha(canonicalize(previous)),digest,'R07_SKIN_REBIND_OLD_ACCOUNT_CHANGED');assertSourceSupplementFields(previous,next);assert(next.status==='3'&&next.is_delete==='0','R07_SKIN_REBIND_ACCOUNT_NOT_LISTED');}
 const dictionary=[];for await(const r of readSourceRows(dictPath))dictionary.push(r);const types=new Map();for await(const r of readSourceRows(typePath)){assert(!types.has(r.id),'R07_SKIN_REBIND_DICTIONARY_DUPLICATE');types.set(r.id,r);}
 for(const mapping of overlay.mappings){const matches=dictionary.filter(r=>r.name===mapping.token&&r.value===mapping.token);
  assert(matches.length===mapping.sourceRows.length&&mapping.sourceRows.every(ref=>matches.some(r=>r.id===String(ref.dictDataId)&&r.type_id===String(ref.dictTypeId)&&types.get(r.type_id)?.dict_type===ref.dictField&&(r.is_delete==='1'?'HISTORICAL_SOFT_DELETED':'CURRENT')===ref.state)),'R07_SKIN_REBIND_DICTIONARY_CHANGED');}
 const credentialPath=privatePath(input.credentials.path),credentialBytes=readFileSync(credentialPath);assert.equal(sha(credentialBytes),input.credentials.sha256,'R07_SKIN_REBIND_CREDENTIAL_CHANGED');
 const registered=loadRegisteredTarget(credentialPath),credentials=JSON.parse(credentialBytes);assert(registered.port===55433&&JSON.stringify(registered.instance)===JSON.stringify(round.target.instance)&&registered.oid===round.target.oid&&registered.nonce===round.target.nonce&&!registered.pendingReset&&credentials.runtime?.name===registered.runtimeRole&&credentials.runtime?.oid===registered.runtimeRoleOid,'R07_SKIN_REBIND_TARGET_CHANGED');
 const client=new Client(targetConnection(registered,{user:credentials.runtime.name,password:credentials.runtime.password,applicationName:'r07-listed-skin-overlay-readonly',connectionTimeoutMillis:3000,statement_timeout:15000}));
 let begun=false,rollbackAck=false,closed=false,result;
 try{
  await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;const identity=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,identity,'runtime');assert.equal(identity.read_only,'on','R07_SKIN_REBIND_NOT_READ_ONLY');
  const games=(await client.query("SELECT id,catalog_revision::text revision FROM zzsh_supply.game WHERE code='delta'")).rows;assert(games.length===1&&games[0].id===overlay.gameId,'R07_SKIN_REBIND_GAME_CHANGED');
  const catalog=(await client.query(`SELECT id AS "skinId",game_id AS "gameId",source_field AS "sourceField",source_token AS "sourceToken",naming_state AS "namingState",enabled,form_visible AS "formVisible",source_namespace AS "sourceNamespace",name,owner_kind AS "ownerKind" FROM zzsh_supply.skin WHERE game_id=$1 ORDER BY id`,[games[0].id])).rows;
  const next=skin.parseLegacySkinMappingOverlay(rebindOverlay(overlay,{sourceReceiptSha256:input.source.sha256,sourceExtractSha256:receipt.files.accountDisplay.sha256,sourceDictionarySha256:receipt.files.skinDictionaryData.sha256,gameId:games[0].id,catalogRevision:games[0].revision}));
  const holdingSource=readFileSync(join(root,'tmp/round07-source-snapshot-20261106-01/scripts/migration/local-target-holdings.mjs'),'utf8'),match=/const AMBIGUOUS = (\[[^\]]+\]);/.exec(holdingSource);assert(match,'R07_SKIN_REBIND_RULES_UNAVAILABLE');
  const tokens=JSON.parse(match[1]),rules=tokens.map((token,index)=>{const field=index===0?'knife_skin':'weapon_skin',matches=dictionary.filter(r=>r.name===token&&r.value===token);
   assert(matches.length>=2&&matches.every(r=>/^[1-9]\d*$/.test(r.id)&&/^[1-9]\d*$/.test(r.type_id)&&['0','1'].includes(r.is_delete)&&types.has(r.type_id)),'R07_SKIN_REBIND_AMBIGUITY_CHANGED');
   return {field,token,decision:'SOURCE_AMBIGUOUS',sources:matches.map(r=>({dictField:types.get(r.type_id).dict_type,dictTypeId:Number(r.type_id),dictDataId:Number(r.id),state:r.is_delete==='1'?'HISTORICAL_SOFT_DELETED':'CURRENT'}))};});
  const index=skin.buildLegacySkinIndex(catalog,rules,next),prior=new Map((skinAudit.rows??[]).map(x=>[x.sourceId,x])),accounts=[];
  for(const [id,row] of newRows){const old=prior.get(id);assert(old?.complete===true&&Array.isArray(old.tokenMappings),'R07_SKIN_REBIND_PRIOR_AUDIT_INCOMPLETE');
   const columns=Object.fromEntries(skin.LEGACY_SKIN_FIELDS.map(field=>[field,row[field]])),holding=skin.mapLegacySkinHolding({accountKey:id,gameId:games[0].id,columns},index,games[0].revision),ids=skin.declarableLegacySkinIds(holding);
   const expectedIds=[...new Set(old.tokenMappings.flatMap(x=>(x.targets??[]).map(t=>t.id)))].sort();
   assert(ids&&canonicalize([...ids].sort())===canonicalize(expectedIds),'R07_SKIN_REBIND_ACCOUNT_MAPPING_CHANGED');accounts.push({sourceId:id,sourceDigest:sha(canonicalize(row)),skinCount:ids.length});}
  result={overlay:next,accounts,catalogRevision:games[0].revision,catalogRows:catalog.length,mappingCount:next.mappings.length};
  rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';begun=false;
 }finally{try{if(begun)await client.query('ROLLBACK');}finally{await client.end();closed=true;}}
 assert(result&&rollbackAck&&closed,'R07_SKIN_REBIND_READBACK_UNCONFIRMED');writePrivate(join(out,'mapping-overlay.json'),result.overlay);
 const overlaySha=sha(readFileSync(join(out,'mapping-overlay.json'))),canonicalSha=sha(canonicalize(result.overlay));
 writePrivate(join(out,'receipt.json'),{schema:'zzsh.round07-skin-rebind-receipt.v1',status:'SOURCE_AND_TARGET_MAPPING_VERIFIED_NO_WRITES',oldSourceSha256:input.oldSource.sha256,sourceSha256:input.source.sha256,
  priorAuditSha256:input.priorAudit.sha256,priorSkinAuditSha256:input.priorSkinAudit.sha256,priorOverlaySha256:input.priorOverlay.sha256,overlaySha256:overlaySha,overlayCanonicalSha256:canonicalSha,
  target:{oid:registered.oid,nonce:registered.nonce,instance:registered.instance},accounts:result.accounts,catalogRevision:result.catalogRevision,catalogRows:result.catalogRows,mappingCount:result.mappingCount,rollbackAck,closed,targetWrites:0});
 console.log(JSON.stringify({status:'SOURCE_AND_TARGET_MAPPING_VERIFIED_NO_WRITES',overlay:join(out,'mapping-overlay.json'),overlaySha256:overlaySha,accounts:result.accounts.length,mappings:result.mappingCount,targetWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_SKIN_REBIND_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
