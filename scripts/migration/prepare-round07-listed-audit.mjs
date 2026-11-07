import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { readSourceRows } from './local-source-adapter.mjs';
import { verifyLegacyListedPolicyDump } from './verify-legacy-listed-policy-dump.mjs';
import { isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted'),sha=x=>createHash('sha256').update(x).digest('hex');
function inside(base,value,output=false){assert(typeof value==='string'&&isAbsolute(value),'R07_LISTED_AUDIT_PATH_REQUIRED');const p=resolve(value),r=relative(base,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'R07_LISTED_AUDIT_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_LISTED_AUDIT_LINK_REFUSED');return p;}
function pinned(ref,base=restricted){const path=inside(base,ref?.path),bytes=readFileSync(path);assert(/^[a-f0-9]{64}$/.test(ref.sha256??'')&&sha(bytes)===ref.sha256,'R07_LISTED_AUDIT_INPUT_CHANGED');return JSON.parse(bytes);}
async function fileHash(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
async function dataFile(dir,entry,digest){assert(entry&&entry.file===basename(entry.file),'R07_LISTED_AUDIT_SOURCE_INVALID');const p=inside(restricted,join(dir,entry.file));assert.equal(await fileHash(p),digest,'R07_LISTED_AUDIT_SOURCE_CHANGED');return p;}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 if(!args.includes('--prepare')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--prepare','--input','--input-sha','--out'],connections:0,targetWrites:0}));return;}
 const input=pinned({path:option('--input'),sha256:option('--input-sha')}),out=inside(restricted,option('--out'),true);assert(!existsSync(out)&&input.schema==='zzsh.round07-listed-audit-input.v1','R07_LISTED_AUDIT_INPUT_INVALID');
 const round=pinned(input.roundInput),rebind=pinned(input.skinRebind),overlay=pinned(input.overlay),priorAudit=pinned(input.priorAudit),priorSkin=pinned(input.priorSkinAudit),oldPolicy=pinned(input.priorPolicy),oldAuthority=pinned(input.priorAuthority),sourceBinding=pinned(input.sourceBinding,resolve('D:/CodexWorktrees'));
 assert(round.target?.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'&&rebind.status==='SOURCE_AND_TARGET_MAPPING_VERIFIED_NO_WRITES'
  &&rebind.sourceSha256===round.source.sha256&&rebind.overlaySha256===input.overlay.sha256&&rebind.priorAuditSha256===input.priorAudit.sha256
  &&rebind.priorSkinAuditSha256===input.priorSkinAudit.sha256&&rebind.target?.oid===round.target.oid&&rebind.target?.nonce===round.target.nonce
  &&JSON.stringify(rebind.target?.instance)===JSON.stringify(round.target.instance)&&priorAudit.status==='OFFLINE_INPUT_COMPATIBLE_TARGET_NOT_RUN'
  &&oldAuthority.decision==='OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY'&&oldAuthority.scope==='LOCAL_AND_TEST_SERVER'&&oldAuthority.runtimeCacheKnowledge==='UNKNOWN',
 'R07_LISTED_AUDIT_EVIDENCE_CHANGED');
 const api=isolatedDistributionBuild(root,round.apiDist),require=createRequire(join(root,'apps/api/package.json')),load=name=>{const p=join(api,name+'.js');assert.equal(sha(readFileSync(p)),round.buildFiles?.[name+'.js'],'R07_LISTED_AUDIT_BUILD_CHANGED');return require(p);};
 const {canonicalize}=load('supply/content-hash'),{listingSnapshot}=load('legacy-load/user-order-offline-plan'),{parseLegacyDisplaySnapshot,convertLegacyDisplayFields}=load('supply/legacy-display-snapshot'),
  {parseLegacyImagePaths}=load('supply/legacy-path-media'),{readLegacyListedPolicy}=load('supply/legacy-listed-policy'),{buildLegacyListedSourceQuote}=load('supply/legacy-listed-source-quote'),
  {DELTA_LEGACY_RESOURCES}=load('supply/legacy-observation'),{applyTotalDiscountToQuote}=load('auth/membership-total-discount');
 const eq=(a,b,code)=>assert.equal(canonicalize(a),canonicalize(b),code),oldPolicySha=sha(canonicalize(oldPolicy)),oldAuthoritySha=sha(canonicalize(oldAuthority));
 assert(oldPolicySha===priorAudit.policyBundleCanonicalSha256&&oldAuthoritySha===priorAudit.policyAuthorityCanonicalSha256
  &&oldAuthority.policyBundleSha256===oldPolicySha&&oldAuthority.sourceBindingSha256===input.sourceBinding.sha256
  &&oldPolicy.supplement?.sourceReceiptSha256===priorAudit.sourceReceiptSha256,'R07_LISTED_AUDIT_PRIOR_DECISION_CHANGED');
 const sourceDir=inside(restricted,round.source.path),receipt=pinned({path:join(sourceDir,'receipt.json'),sha256:round.source.sha256}),datasetDir=inside(restricted,round.dataset.path),dataset=pinned({path:join(datasetDir,'manifest.json'),sha256:round.dataset.sha256});
 assert(receipt.status==='CAPTURED_READ_ONLY'&&receipt.rollbackConfirmed&&receipt.clientClosed&&receipt.containerId===sourceBinding.container?.id
  &&receipt.database===sourceBinding.source?.database&&dataset.sourceReceiptSha256===round.source.sha256&&dataset.sourceOrigin?.bindingSha256===input.sourceBinding.sha256,'R07_LISTED_AUDIT_SOURCE_BINDING_CHANGED');
 const dump=await verifyLegacyListedPolicyDump(sourceBinding.restoreRecord,'1');eq(dump,oldPolicy.dumpVerification,'R07_LISTED_AUDIT_DUMP_POLICY_CHANGED');
 const accountsFile=await dataFile(sourceDir,receipt.files.accounts,receipt.files.accounts.sha256),settingsFile=await dataFile(sourceDir,receipt.files.tradePolicy,receipt.files.tradePolicy.sha256);
 const settings=[];for await(const row of readSourceRows(settingsFile))if(row.type==='expendConfig')settings.push(row);
 const sortRows=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));eq(sortRows(settings),sortRows(oldPolicy.supplement.settingRows.filter(r=>r.type==='expendConfig')),'R07_LISTED_AUDIT_MATERIAL_POLICY_CHANGED');
 const expected=new Map((rebind.accounts??[]).map(r=>[r.sourceId,r.sourceDigest]));assert(expected.size===10&&expected.size===rebind.accounts.length,'R07_LISTED_AUDIT_EXPECTED_SET_CHANGED');
 const raw=new Map();let listed=0;for await(const row of readSourceRows(accountsFile)){if(row.status==='3'&&row.is_delete==='0'){listed++;assert(expected.has(row.id),'R07_LISTED_AUDIT_NEW_LISTED_ACCOUNT');}if(expected.has(row.id))raw.set(row.id,row);}
 assert(raw.size===expected.size&&listed===expected.size,'R07_LISTED_AUDIT_LISTED_SET_CHANGED');for(const [id,digest] of expected)assert.equal(sha(canonicalize(raw.get(id))),digest,'R07_LISTED_AUDIT_ACCOUNT_CHANGED');
 const accountFile=await dataFile(datasetDir,dataset.files.accounts,dataset.files.accounts.sha256),userFile=await dataFile(datasetDir,dataset.files.users,dataset.files.users.sha256),displayDir=inside(restricted,round.display.path),display=pinned({path:join(displayDir,'manifest.json'),sha256:round.display.sha256}),
  pathsDir=inside(restricted,round.paths.path),paths=pinned({path:join(pathsDir,'receipt.json'),sha256:round.paths.sha256});
 assert(display.datasetSha256===round.dataset.sha256&&paths.datasetSha256===round.dataset.sha256&&display.extractSha256===receipt.files.accountDisplay.sha256,'R07_LISTED_AUDIT_PLAN_CHANGED');
 const displayFile=await dataFile(displayDir,{file:display.file},display.sha256),pathsFile=await dataFile(pathsDir,{file:paths.file},paths.fileSha256),accountRows=new Map(),displayRows=new Map(),pathRows=new Map(),users=new Map();
 for await(const row of readSourceRows(accountFile))if(expected.has(row.sourceId))accountRows.set(row.sourceId,row);
 for await(const row of readSourceRows(displayFile))if(expected.has(row.sourceId))displayRows.set(row.sourceId,row);
 for await(const row of readSourceRows(pathsFile))if(expected.has(row.legacyId))pathRows.set(row.legacyId,row);
 assert([accountRows,displayRows,pathRows].every(m=>m.size===expected.size),'R07_LISTED_AUDIT_TARGET_SOURCE_MISSING');
 const owners=new Set([...accountRows.values()].map(x=>x.ownerLegacyId));for await(const row of readSourceRows(userFile))if(owners.has(row.sourceId))users.set(row.sourceId,row);assert.equal(users.size,owners.size,'R07_LISTED_AUDIT_OWNER_MISSING');
 const verifierPath=fileURLToPath(new URL('./verify-legacy-listed-policy-dump.mjs',import.meta.url)),verifierSha256=sha(readFileSync(verifierPath)),accountSourceDigests=[...expected].map(([id,digest])=>({id,sha256:digest}));
 const supplement={...oldPolicy.supplement,sourceReceiptSha256:round.source.sha256,baseCaptureStartedAt:receipt.startedAt,baseCaptureFinishedAt:receipt.finishedAt,
  comparison:'EXACT_LISTED_ROWS_AND_CAPTURED_MATERIAL_POLICY_IDENTICAL',accountSourceDigests,
  rebindEvidence:{priorSourceReceiptSha256:priorAudit.sourceReceiptSha256,priorAuditSha256:input.priorAudit.sha256,skinRebindSha256:input.skinRebind.sha256,sourceComparison:'ALL_PRIOR_FIELDS_MATCHED'}};
 const policy={...oldPolicy,verifierPath,verifierSha256,dumpVerification:dump,supplement,supplementSha256:sha(canonicalize(supplement))},policyCanonical=canonicalize(policy),policySha=sha(policyCanonical);
 const authority={...oldAuthority,sourceReceiptSha256:round.source.sha256,policyBundleSha256:policySha},authorityCanonical=canonicalize(authority),authoritySha=sha(authorityCanonical);
 const skinRows=new Map((priorSkin.rows??[]).map(row=>[row.sourceId,row])),details=[],discountCounts=Object.fromEntries(['1','0.98','0.96','0.94','0.92'].map(x=>[x,0]));
 for(const [id,digest] of expected){const row=raw.get(id),account=accountRows.get(id),d=displayRows.get(id),p=pathRows.get(id),owner=users.get(account.ownerLegacyId),skin=skinRows.get(id);
  assert(account.ready===true&&account.sourceDigest===digest&&account.ownerLegacyId===row.user_id&&account.ownerUserId===owner.userId&&account.ownerSourceDigest===owner.sourceDigest,'R07_LISTED_AUDIT_OWNER_CHANGED');
  const historical=listingSnapshot(row);assert(historical.snapshot,'R07_LISTED_AUDIT_SNAPSHOT_MISSING');eq(account.snapshot,historical.snapshot,'R07_LISTED_AUDIT_SNAPSHOT_CHANGED');
  const converted=parseLegacyDisplaySnapshot(convertLegacyDisplayFields(row));assert.equal(d.baseSourceDigest,digest,'R07_LISTED_AUDIT_DISPLAY_CHANGED');eq(d.snapshot,converted,'R07_LISTED_AUDIT_DISPLAY_CHANGED');
  const images=parseLegacyImagePaths(row.img_paths),penalty=parseLegacyImagePaths(row.punishment_img_url);assert(p.sourceDigest===digest&&p.legacyOwnerId===row.user_id&&p.ownerUserId===owner.userId,'R07_LISTED_AUDIT_PATH_CHANGED');eq(p.displayPaths,images,'R07_LISTED_AUDIT_PATH_CHANGED');eq(p.penaltyPaths,penalty,'R07_LISTED_AUDIT_PATH_CHANGED');
  assert(skin?.complete===true&&skin.tokenMappings.every(x=>x.complete&&x.unresolved.length===0&&x.pending.length===0),'R07_LISTED_AUDIT_SKIN_INCOMPLETE');
  const policyBinding={proofSha256:policySha,sourceReceiptSha256:round.source.sha256,sourceBindingSha256:input.sourceBinding.sha256,dumpSha256:sourceBinding.restoreRecord.dumpSha256,dumpVerifierSha256:verifierSha256,sourceId:id,sourceDigest:digest,legacyGameId:row.game_id,expectedAccountCount:expected.size,authorityCanonical,authoritySha256:authoritySha};readLegacyListedPolicy(policyCanonical,policyBinding);
  const catalog=DELTA_LEGACY_RESOURCES.map(([field,codes])=>({id:codes[0],code:codes[0],unit:converted.resources.find(x=>x.field===field).unit,quantityScale:0})),inventory=DELTA_LEGACY_RESOURCES.map(([field,codes])=>({itemId:codes[0],quantity:converted.resources.find(x=>x.field===field).quantity}));
  const built=buildLegacyListedSourceQuote({sourceCanonical:canonicalize(row),source:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_rental_accounts',legacyId:id,sourceDigest:digest,observationVersionId:'synthetic-observation'},policyCanonical,policyBinding,display:d.snapshot,catalog,declaredInventory:inventory,termOption:{dailyConsumption:(BigInt(row.default_consume_type)*10000000n).toString(),durationRounding:'CEIL_DAY'},priceVersionId:'synthetic-price',ruleReleaseId:'synthetic-release',publisherBailRequirementCents:'0',expiryDisclosures:[]});
  assert.equal(built.quote.lines.length,8,'R07_LISTED_AUDIT_QUOTE_INVALID');for(const ratio of Object.keys(discountCounts)){const q=applyTotalDiscountToQuote(built.quote,ratio);assert(q&&q.quote.ownerTotal.amount===built.quote.ownerTotal.amount,'R07_LISTED_AUDIT_DISCOUNT_CHANGED');discountCounts[ratio]++;}
  details.push({sourceId:id,sourceDigest:digest,sourceAndTargetAccountMapping:true,ownerPresent:true,historicalSnapshotMatches:true,displayMatches:true,displayPathCount:images.length,penaltyPathCount:penalty.length,legacySkinTokens:skin.tokenCount,legacySkinAuditComplete:true,sourceMode:row.ratio_type,fullPayout:row.is_full_payout,depositYuan:row.deposit_amount,rentalDays:row.rental_days,baseQuote:built.quote});
 }
 const usedBuildModules=Object.fromEntries(Object.keys(require.cache).filter(path=>resolve(path).toLowerCase().startsWith(api.toLowerCase()+'\\')).map(path=>{
  const name=relative(api,path).replaceAll('\\','/'),digest=sha(readFileSync(path));assert.equal(round.buildFiles?.[name],digest,'R07_LISTED_AUDIT_BUILD_CHANGED');return[name,digest];
 }).sort(([a],[b])=>a<b?-1:a>b?1:0));
 assert(Object.hasOwn(usedBuildModules,'supply/legacy-listed-source-quote.js'),'R07_LISTED_AUDIT_MODULE_TRACE_MISSING');
 writePrivate(join(out,'policy-bundle.json'),policy);writePrivate(join(out,'policy-authority.json'),authority);
 const report={schema:'zzsh.round07-listed-input-audit.v1',status:'OFFLINE_INPUT_COMPATIBLE_TARGET_NOT_RUN',sourceReceiptSha256:round.source.sha256,sourceBindingSha256:input.sourceBinding.sha256,
  policyBundleCanonicalSha256:policySha,policyAuthorityCanonicalSha256:authoritySha,r06DatasetManifestSha256:round.dataset.sha256,r06AccountsSha256:dataset.files.accounts.sha256,
  r06DisplayFileSha256:display.sha256,r06PathsFileSha256:paths.fileSha256,supplementalOverlaySha256:input.overlay.sha256,skinRebindReceiptSha256:input.skinRebind.sha256,
  accounts:details,discountCounts,usedBuildModules,dbConnections:0,targetWrites:0,ossWrites:0,limitations:['Target skin holdings still require separate controlled completion and readback.','Quotes use test source rules and do not prove current channel state.']};
 writePrivate(join(out,'receipt.json'),report);console.log(JSON.stringify({status:report.status,accounts:details.length,policyBundleSha256:policySha,policyAuthoritySha256:authoritySha,receiptSha256:sha(readFileSync(join(out,'receipt.json'))),dbConnections:0,targetWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_LISTED_AUDIT_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
