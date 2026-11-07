import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,lstatSync,readFileSync} from 'node:fs';
import {createRequire,Module} from 'node:module';
import {basename,delimiter,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writePrivate} from '../local-auth.mjs';
import {readSourceRows} from './local-source-adapter.mjs';
import {loadRegisteredTarget,targetIdentityQuery,assertLiveTarget} from './local-target-registry.mjs';
import {assertRegisteredDistributionTarget} from './local-distribution-qualification-plan.mjs';
import {inspectRoundDependencyLayout,assertRoundDependencyProof} from './local-round-dependencies.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'SKIN_REBIND_PRIVATE_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'SKIN_REBIND_PRIVATE_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'SKIN_REBIND_LINK_REFUSED');return p;}
function pinned(ref){const p=privatePath(ref?.path),b=readFileSync(p);assert(hex(ref.sha256)&&sha(b)===ref.sha256,'SKIN_REBIND_INPUT_CHANGED');return JSON.parse(b);}
async function sourceFile(dir,entry){assert(entry&&entry.file===basename(entry.file)&&hex(entry.sha256),'SKIN_REBIND_SOURCE_INVALID');const p=privatePath(join(dir,entry.file)),h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);assert.equal(h.digest('hex'),entry.sha256,'SKIN_REBIND_SOURCE_CHANGED');return p;}

/** Preserve only previously reviewed semantics whose complete source tuple and unique target still match. */
export function revalidateReviewedSkinMappings(original,dictionary,types,catalog,gameId){
 assert(Array.isArray(original?.mappings)&&original.mappings.length===5&&Array.isArray(dictionary)&&types instanceof Map&&Array.isArray(catalog)&&typeof gameId==='string','SKIN_REBIND_REVIEWED_INPUT_INVALID');
 const seen=new Set(),mappings=[],isolated=[];
 for(const mapping of original.mappings){const key=mapping.field+'\0'+mapping.token;assert(!seen.has(key),'SKIN_REBIND_DUPLICATE_REVIEWED_MAPPING');seen.add(key);
  const rows=dictionary.filter(r=>r.name===mapping.token&&r.value===mapping.token),observed=[];let valid=true;
  for(const r of rows){const type=types.get(String(r.type_id)),id=Number(r.id),typeId=Number(r.type_id);if(!type||!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(typeId)||typeId<1||!['0','1'].includes(r.is_delete)){valid=false;break;}
   observed.push({dictField:type.dict_type,dictTypeId:typeId,dictDataId:id,state:r.is_delete==='1'?'HISTORICAL_SOFT_DELETED':'CURRENT'});}
  const sorted=x=>[...x].map(canonical).sort();
  if(!valid||canonical(sorted(observed))!==canonical(sorted(mapping.sourceRows??[]))){isolated.push({field:mapping.field,token:mapping.token,reason:'SOURCE_DICTIONARY_CHANGED'});continue;}
  const target=mapping.target,candidates=catalog.filter(x=>x.gameId===gameId&&x.sourceNamespace===target.sourceNamespace&&x.sourceField===target.sourceField&&x.sourceToken===target.sourceToken&&x.name===target.name&&x.ownerKind===target.ownerKind);
  if(candidates.length!==1){isolated.push({field:mapping.field,token:mapping.token,reason:candidates.length?'TARGET_AMBIGUOUS':'TARGET_CHANGED_OR_MISSING'});continue;}
  const found=candidates[0];if(found.skinId!==target.skinId){isolated.push({field:mapping.field,token:mapping.token,reason:'TARGET_ID_CHANGED'});continue;}
  if(found.namingState!=='VERIFIED'||found.enabled!==true||found.formVisible!==true){isolated.push({field:mapping.field,token:mapping.token,reason:'TARGET_NOT_AVAILABLE'});continue;}
  mappings.push({...mapping,target:{...target,skinId:found.skinId}});
 }
 return{mappings,isolated};
}

/** Make a new sealed assembly spec; never overwrite or silently accept a partial review. */
export function bindReboundOverlayToSpec({spec,preliminary,preliminarySha256,rebindInput,rebindInputSha256,receipt,overlay,overlaySha256,acceptPartial=false}){
 assert(spec?.schema==='zzsh.round07-assembly-spec.v1'&&spec.kind==='round'&&!spec.paths?.holdingOverlay&&preliminary?.schema==='zzsh.local-round.v1'
  &&resolve(spec.paths.source).toLowerCase()===resolve(preliminary.source.path).toLowerCase()&&resolve(spec.paths.credentials).toLowerCase()===resolve(preliminary.credentials).toLowerCase()
  &&resolve(spec.paths.roundOutput).toLowerCase()===resolve(preliminary.out).toLowerCase()&&rebindInput?.schema==='zzsh.reviewed-skin-overlay-rebind-input.v1'
  &&rebindInput.roundInput?.sha256===preliminarySha256&&receipt?.schema==='zzsh.reviewed-skin-overlay-rebind-receipt.v1'&&receipt.inputSha256===rebindInputSha256
  &&receipt.sourceSha256===preliminary.source.sha256&&canonical(receipt.target?.instance)===canonical(preliminary.target.instance)&&receipt.target?.oid===preliminary.target.oid&&receipt.target.nonce===preliminary.target.nonce
  &&receipt.overlay?.sha256===overlaySha256&&overlay?.sourceReceiptSha256===preliminary.source.sha256&&overlay.sourceExtractSha256===receipt.sourceExtractSha256
  &&overlay.sourceDictionarySha256===receipt.sourceDictionarySha256&&overlay.catalogRevision===receipt.catalogRevision&&receipt.targetWrites===0&&receipt.readOnlyRollbackAck===true&&receipt.clientClosed===true
  &&(receipt.status==='ALL_REVIEWED_MAPPINGS_REBOUND'||acceptPartial===true&&receipt.status==='PARTIAL_REVIEW_REQUIRED'),'SKIN_REBIND_SPEC_BINDING_CHANGED');
 return{...spec,paths:{...spec.paths,holdingOverlay:receipt.overlay.path}};
}

async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 const modes=['--assemble','--prepare','--bind-spec'].filter(x=>args.includes(x));if(!modes.length){console.log(JSON.stringify({status:'PLAN_ONLY',modes:['--assemble','--prepare','--bind-spec'],connections:0,targetWrites:0}));return;}assert.equal(modes.length,1,'SKIN_REBIND_ONE_MODE_REQUIRED');
 if(modes[0]==='--assemble'){
  const out=privatePath(option('--out'),true);assert(!existsSync(out),'SKIN_REBIND_OUTPUT_EXISTS');
  const refs=Object.fromEntries([['roundInput','--round-input'],['priorOverlay','--prior-overlay'],['priorRebindReceipt','--prior-rebind']].map(([name,flag])=>[name,{path:privatePath(option(flag)),sha256:option(flag+'-sha')}]));
  const round=pinned(refs.roundInput),previous=pinned(refs.priorOverlay),review=pinned(refs.priorRebindReceipt);
  assert(round?.schema==='zzsh.local-round.v1'&&previous?.schema==='legacy-skin-exact-mapping.v2'&&review?.status==='SOURCE_AND_TARGET_MAPPING_VERIFIED_NO_WRITES'
   &&review.overlaySha256===refs.priorOverlay.sha256&&review.sourceSha256===previous.sourceReceiptSha256&&review.mappingCount===5&&review.rollbackAck===true&&review.closed===true&&review.targetWrites===0,'SKIN_REBIND_SOURCE_PROOF_CHANGED');
  writePrivate(join(out,'input.json'),{schema:'zzsh.reviewed-skin-overlay-rebind-input.v1',...refs});console.log(JSON.stringify({status:'SKIN_REBIND_INPUT_READY',sha256:sha(readFileSync(join(out,'input.json'))),connections:0,targetWrites:0}));return;
 }
 if(modes[0]==='--bind-spec'){
  const out=privatePath(option('--out'),true);assert(!existsSync(out),'SKIN_REBIND_OUTPUT_EXISTS');
  const spec=pinned({path:option('--spec'),sha256:option('--spec-sha')}),preliminarySha256=option('--preliminary-sha'),preliminary=pinned({path:option('--preliminary-input'),sha256:preliminarySha256}),rebindInputSha256=option('--rebind-input-sha'),rebindInput=pinned({path:option('--rebind-input'),sha256:rebindInputSha256}),receipt=pinned({path:option('--receipt'),sha256:option('--receipt-sha')}),overlay=pinned(receipt.overlay);
  const final=bindReboundOverlayToSpec({spec,preliminary,preliminarySha256,rebindInput,rebindInputSha256,receipt,overlay,overlaySha256:receipt.overlay.sha256,acceptPartial:args.includes('--accept-partial')});
  writePrivate(join(out,'spec.json'),final);console.log(JSON.stringify({status:receipt.isolated?'PARTIAL_SPEC_BOUND_REVIEW_REQUIRED':'FINAL_SPEC_BOUND',sha256:sha(readFileSync(join(out,'spec.json'))),rebound:receipt.rebound,isolated:receipt.isolated,connections:0,targetWrites:0}));return;
 }
 const input=pinned({path:option('--input'),sha256:option('--input-sha')}),out=privatePath(option('--out'),true),toolSha256=sha(readFileSync(fileURLToPath(import.meta.url)));assert(!existsSync(out)&&input.schema==='zzsh.reviewed-skin-overlay-rebind-input.v1','SKIN_REBIND_INPUT_INVALID');
 const round=pinned(input.roundInput),previous=pinned(input.priorOverlay),review=pinned(input.priorRebindReceipt),source=pinned({path:join(round.source.path,'receipt.json'),sha256:round.source.sha256});
 assert(review.status==='SOURCE_AND_TARGET_MAPPING_VERIFIED_NO_WRITES'&&review.overlaySha256===input.priorOverlay.sha256&&review.sourceSha256===previous.sourceReceiptSha256
  &&review.mappingCount===5&&review.rollbackAck===true&&review.closed===true&&review.targetWrites===0
  &&source.status==='CAPTURED_READ_ONLY'&&source.rollbackConfirmed===true&&source.clientClosed===true,'SKIN_REBIND_SOURCE_PROOF_CHANGED');
 const dep=round.dependencyBinding,proof=pinned(dep.proof),layout=inspectRoundDependencyLayout({apiDist:round.apiDist,bundlePath:round.bootstrapEvidence.bundle.path,bundleSha256:round.bootstrapEvidence.bundle.sha256,buildManifestPath:dep.buildManifest.path,buildManifestSha256:dep.buildManifest.sha256,sourceSnapshot:dep.sourceSnapshot,sourceManifestPath:dep.sourceManifest.path,sourceManifestSha256:dep.sourceManifest.sha256});assertRoundDependencyProof(proof,layout);
 process.env.NODE_PATH=layout.moduleDirs.join(delimiter);Module._initPaths();const require=createRequire(join(round.apiDist,'app.js')),{Client}=require('pg');
 const skinPath=join(round.apiDist,'legacy-load/legacy-skin-holdings.js'),hashPath=join(round.apiDist,'supply/content-hash.js');assert.equal(sha(readFileSync(skinPath)),round.buildFiles['legacy-load/legacy-skin-holdings.js']);assert.equal(sha(readFileSync(hashPath)),round.buildFiles['supply/content-hash.js']);
 const skin=require(skinPath),{canonicalize}=require(hashPath);skin.parseLegacySkinMappingOverlay(previous);
 const dictPath=await sourceFile(round.source.path,source.files.skinDictionaryData),typesPath=await sourceFile(round.source.path,source.files.skinDictionaryTypes);await sourceFile(round.source.path,source.files.accountDisplay);
 const dictionary=[],dictIds=new Set();for await(const row of readSourceRows(dictPath)){assert(!dictIds.has(String(row.id)),'SKIN_REBIND_DICTIONARY_DUPLICATE');dictIds.add(String(row.id));dictionary.push(row);}const types=new Map();for await(const row of readSourceRows(typesPath)){assert(!types.has(String(row.id)),'SKIN_REBIND_TYPE_DUPLICATE');types.set(String(row.id),row);}
 assert(dictionary.length===source.files.skinDictionaryData.rows&&types.size===source.files.skinDictionaryTypes.rows,'SKIN_REBIND_SOURCE_COUNT_CHANGED');
 const cp=privatePath(round.credentials),credentials=JSON.parse(readFileSync(cp)),registered=loadRegisteredTarget(cp),rawRegistry=JSON.parse(readFileSync(join(dirname(cp),'resource.json')));rawRegistry.instance=registered.instance;assertRegisteredDistributionTarget(round.target,round.dataset.sha256,rawRegistry);
 assert(credentials.runtime?.name===registered.runtimeRole&&credentials.runtime?.oid===registered.runtimeRoleOid,'SKIN_REBIND_RUNTIME_ROLE_CHANGED');
 const client=new Client({host:registered.host,port:registered.port,database:registered.database,user:credentials.runtime.name,password:credentials.runtime.password,statement_timeout:30000,application_name:'reviewed-skin-overlay-rebind'});let begun=false,closed=false,result;
 try{await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;const identity=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,identity,'runtime');assert.equal(identity.read_only,'on');
  const games=(await client.query("SELECT id,catalog_revision::text revision FROM zzsh_supply.game WHERE code='delta'")).rows;assert.equal(games.length,1,'SKIN_REBIND_GAME_UNAVAILABLE');
  const catalog=(await client.query('SELECT id AS "skinId",game_id AS "gameId",source_field AS "sourceField",source_token AS "sourceToken",naming_state AS "namingState",enabled,form_visible AS "formVisible",source_namespace AS "sourceNamespace",name,owner_kind AS "ownerKind" FROM zzsh_supply.skin WHERE game_id=$1 ORDER BY id',[games[0].id])).rows;
  const mapped=revalidateReviewedSkinMappings(previous,dictionary,types,catalog,games[0].id),overlay=mapped.mappings.length?skin.parseLegacySkinMappingOverlay({...previous,sourceReceiptSha256:round.source.sha256,sourceExtractSha256:source.files.accountDisplay.sha256,sourceDictionarySha256:source.files.skinDictionaryData.sha256,gameId:games[0].id,catalogRevision:games[0].revision,mappings:mapped.mappings}):null;
  result={mapped,overlay,target:{oid:registered.oid,nonce:registered.nonce,instance:registered.instance},catalogRevision:games[0].revision,catalogRows:catalog.length};assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');begun=false;
 }finally{if(begun)await client.query('ROLLBACK').catch(()=>{});await client.end();closed=true;}
 assert(result&&closed,'SKIN_REBIND_READBACK_UNCONFIRMED');assert.equal(sha(readFileSync(fileURLToPath(import.meta.url))),toolSha256,'SKIN_REBIND_TOOL_CHANGED');assertRoundDependencyProof(proof,layout);
 let overlayRef=null;if(result.overlay){writePrivate(join(out,'mapping-overlay.json'),result.overlay);overlayRef={path:join(out,'mapping-overlay.json'),sha256:sha(readFileSync(join(out,'mapping-overlay.json'))),canonicalSha256:sha(canonicalize(result.overlay))};}
 const reasonCounts={};for(const x of result.mapped.isolated)reasonCounts[x.reason]=(reasonCounts[x.reason]??0)+1;
 const receipt={schema:'zzsh.reviewed-skin-overlay-rebind-receipt.v1',status:result.mapped.isolated.length?'PARTIAL_REVIEW_REQUIRED':'ALL_REVIEWED_MAPPINGS_REBOUND',toolSha256,inputSha256:option('--input-sha'),priorOverlaySha256:input.priorOverlay.sha256,sourceSha256:round.source.sha256,
  sourceExtractSha256:source.files.accountDisplay.sha256,sourceDictionarySha256:source.files.skinDictionaryData.sha256,sourceDictionaryTypesSha256:source.files.skinDictionaryTypes.sha256,target:result.target,catalogRevision:result.catalogRevision,catalogRows:result.catalogRows,
  reviewed:5,rebound:result.mapped.mappings.length,isolated:result.mapped.isolated.length,reasonCounts,isolatedMappings:result.mapped.isolated,overlay:overlayRef,readOnlyRollbackAck:true,clientClosed:true,targetWrites:0};
 writePrivate(join(out,'receipt.json'),receipt);console.log(JSON.stringify({status:receipt.status,reviewed:5,rebound:receipt.rebound,isolated:receipt.isolated,reasonCounts,overlay:overlayRef,receiptSha256:sha(readFileSync(join(out,'receipt.json'))),targetWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'SKIN_REBIND_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
