import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisplayCaptureRow, inspectLegacyListedPricingCapture, readSourceRows, readVerifiedSourceRows } from './local-source-adapter.mjs';
import { assertListedRunnerScripts, assertRoundDependencyProof, inspectRoundDependencyLayout } from './local-round-dependencies.mjs';
import { NEXT_MIGRATION_PROFILE } from './local-target-registry.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=(ok,message)=>{if(!ok)throw new Error(message)};
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&resolve(a).toLowerCase()===resolve(b).toLowerCase();
const digest=(file)=>sha(readFileSync(file));
const read=(file)=>JSON.parse(readFileSync(file,'utf8'));
function privatePath(value){
 const base=resolve('E:/zzsh-local-state/restricted'),p=resolve(value??'');
 fail(isAbsolute(value??'')&&p.toLowerCase().startsWith(base.toLowerCase()+'\\'),'LISTED_PRIVATE_PATH_REQUIRED');
 for(let x=p;;x=dirname(x)){if(existsSync(x)&&lstatSync(x).isSymbolicLink())throw new Error('LISTED_REPARSE_POINT_REFUSED');if(dirname(x)===x)break}
 return p;
}
function safeAbsolute(value){
 fail(typeof value==='string'&&isAbsolute(value),'LISTED_SOURCE_BINDING_PATH_REQUIRED');const p=resolve(value);
 for(let x=p;x!==dirname(x);x=dirname(x))if(lstatSync(x).isSymbolicLink())throw new Error('LISTED_REPARSE_POINT_REFUSED');
 return p;
}
function bound(file,expected){fail(/^[a-f0-9]{64}$/.test(expected??'')&&digest(file)===expected,'LISTED_BOUND_FILE_CHANGED');return read(file)}

/** Derive the listed set from the whole capture; an optional reviewed set must match exactly. */
export async function collectListedAccounts(rows,canonicalize,expected=null){
 if(expected!==null&&!(expected instanceof Map)||typeof canonicalize!=='function')throw new Error('LISTED_SOURCE_SET_INVALID');
 for(const [id,digest] of expected??[])if(typeof id!=='string'||!id||!/^[a-f0-9]{64}$/.test(digest??''))throw new Error('LISTED_SOURCE_SET_INVALID');
 const seen=new Set(),matched=new Map(),digests=new Map();
 for await(const row of rows){
  if(typeof row?.id!=='string'||!row.id||!['0','1','2','3','4','5','6'].includes(row.status)||!['0','1'].includes(row.is_delete))throw new Error('LISTED_SOURCE_ACCOUNT_INVALID');
  if(seen.has(row.id))throw new Error('LISTED_SOURCE_ACCOUNT_DUPLICATE');seen.add(row.id);
  const listed=row.status==='3'&&row.is_delete==='0';
  if(expected&&listed&&!expected.has(row.id))throw new Error('LISTED_SOURCE_ACCOUNT_OMITTED');
  if(expected&&!listed&&expected.has(row.id))throw new Error('LISTED_SOURCE_ACCOUNT_NOT_LISTED');
  if(listed){const digest=sha(canonicalize(row));if(expected&&digest!==expected.get(row.id))throw new Error('LISTED_SOURCE_ACCOUNT_DIGEST_CHANGED');matched.set(row.id,row);digests.set(row.id,digest);}
 }
 if(expected&&matched.size!==expected.size)throw new Error('LISTED_SOURCE_ACCOUNT_MISSING');
 return {accounts:matched,digests,captured:seen.size};
}

/** Recheck the complete captured account stream, not just the IDs supplied by a prior audit. */
export async function collectVerifiedListedAccounts(rows,expected,canonicalize){
 if(!(expected instanceof Map))throw new Error('LISTED_SOURCE_SET_INVALID');
 const {accounts,captured}=await collectListedAccounts(rows,canonicalize,expected);
 return {accounts,captured};
}

/** Hash the exact source bytes being parsed; reject changed contents or a different denominator. */
export async function readBoundListedAccounts(file,entry,expected,canonicalize){
 if(!entry||!/^[a-f0-9]{64}$/.test(entry.sha256??'')||!Number.isSafeInteger(entry.rows)||entry.rows<0)throw new Error('LISTED_SOURCE_ENTRY_INVALID');
 const hash=createHash('sha256');
 const rows=readSourceRows(file,chunk=>hash.update(chunk));
 const scanned=expected===null?await collectListedAccounts(rows,canonicalize):await collectVerifiedListedAccounts(rows,expected,canonicalize);
 if(hash.digest('hex')!==entry.sha256||scanned.captured!==entry.rows)throw new Error('LISTED_SOURCE_FILE_CHANGED');
 return scanned;
}

/** The caller must first verify the receipt and each file digest before passing their contents here. */
export function verifySameCaptureListedPolicySource(policy,receipt,games,settings,canonicalize,parseInteger){
 const p=policy?.supplement, identity=receipt?.identity;
 if(policy?.schema!=='legacy-listed-policy-evidence-v2'||policy.temporalLimit!=='SAME_MYSQL_SNAPSHOT_RUNTIME_REDIS_NOT_CAPTURED'
   ||p?.schema!=='legacy-listed-policy-capture-v2'||p.comparison!=='ACCOUNTS_AND_POLICY_SAME_CAPTURE'||p.temporalLimit!=='RUNTIME_REDIS_NOT_CAPTURED'
   ||inspectLegacyListedPricingCapture(receipt,games,settings,parseInteger).status!=='MYSQL_CAPTURE_VALUES_VALIDATED'
   ||receipt.schema!=='zzsh.legacy-source-capture.v1'||receipt.database!=='sg_zzsh_restore'
   ||identity?.database!==receipt.database||identity.readOnly!==1||identity.isolation!=='REPEATABLE-READ'
   ||identity.accessMode!=='READ ONLY'||identity.txState!=='ACTIVE'
   ||p.containerId!==receipt.containerId||p.baseCaptureStartedAt!==receipt.startedAt||p.baseCaptureFinishedAt!==receipt.finishedAt
   ||p.rollbackConfirmed!==receipt.rollbackConfirmed||p.clientClosed!==receipt.clientClosed
   ||canonicalize(p.identity)!==canonicalize(identity))throw new Error('LISTED_POLICY_CAPTURE_BINDING_CHANGED');
 const names=['barrettBullet','bullet','awm','armor','helmet','coffee','experienceCard',
  'barrettBulletSale','bulletSale','awmSale','armorSale','helmetSale','coffeeSale','experienceCardSale'];
 const sourceSettings=settings.filter(row=>row?.type==='expendConfig'||row?.type==='game'&&row?.name==='profitFirstDot');
 const material=sourceSettings.filter(row=>row.type==='expendConfig');
 if(!Array.isArray(p.gameRows)||!Array.isArray(p.settingRows)||sourceSettings.length!==15||material.length!==14||new Set(material.map(row=>row.name)).size!==14
   ||names.some(name=>!material.some(row=>row.name===name))
   ||sourceSettings.some(row=>typeof row.id!=='string'||typeof row.value!=='string')
   ||new Set(sourceSettings.map(row=>row.id)).size!==15)throw new Error('LISTED_POLICY_SOURCE_SETTINGS_INVALID');
 const sort=rows=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
 const game=games.filter(row=>row.id==='1'&&row.is_delete==='0').map(row=>({id:row.id,profitDot:row.profit_dot}));
 if(canonicalize(p.gameRows)!==canonicalize(game)||canonicalize(sort(p.settingRows??[]))!==canonicalize(sort(sourceSettings)))
  throw new Error('LISTED_POLICY_CAPTURE_VALUES_CHANGED');
 return true;
}

/** Build a bounded policy from a complete, already hash-verified same-snapshot source scan. */
export function buildSameCaptureListedPolicy({receipt,sourceReceiptSha256,sourceBindingSha256,dumpSha256,verifierSha256,dump,scan,games,settings,canonicalize,parseInteger}){
 const hex=value=>/^[a-f0-9]{64}$/.test(value??'');
 if(![sourceReceiptSha256,sourceBindingSha256,dumpSha256,verifierSha256].every(hex)
   ||typeof canonicalize!=='function'||!Array.isArray(games)||!Array.isArray(settings)||!(scan?.accounts instanceof Map)||!(scan?.digests instanceof Map)
   ||scan.accounts.size!==scan.digests.size||scan.captured!==receipt?.files?.accounts?.rows
   ||games.length!==receipt?.files?.games?.rows||settings.length!==receipt?.files?.tradePolicy?.rows
   ||!Number.isFinite(Date.parse(receipt?.startedAt??''))||!Number.isFinite(Date.parse(receipt?.finishedAt??''))
   ||Date.parse(receipt.startedAt)>Date.parse(receipt.finishedAt))throw new Error('LISTED_POLICY_CAPTURE_INPUT_INVALID');
 const accountSourceDigests=[...scan.digests].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,digest])=>{
  const row=scan.accounts.get(id);
  if(!/^[1-9]\d{0,23}$/.test(id)||!hex(digest)||row?.id!==id||row.status!=='3'||row.is_delete!=='0'
    ||sha(canonicalize(row))!==digest)throw new Error('LISTED_POLICY_CAPTURE_ACCOUNT_INVALID');
  return {id,sha256:digest};
 });
 const sourceGame=games.filter(row=>row?.id==='1'&&row.is_delete==='0'),fast=settings.filter(row=>row?.type==='game'&&row?.name==='profitFirstDot');
 if(sourceGame.length!==1||fast.length!==1||dump?.schema!=='zzsh.legacy-listing-dump-policy-check.v1'
   ||dump.sourceDumpSha256!==dumpSha256||dump.gameId!=='1'||dump.matchCounts?.game!==1||dump.matchCounts?.fastConfig!==1
   ||dump.sourceCutoffMeaning!=='OWNER_LOCAL_DUMP_EXPORT_COMPLETED_NOT_PROVEN_PRODUCTION_STOP_WRITE_CUTOFF'
   ||!Number.isFinite(Date.parse(dump.sourceCutoff??''))||Date.parse(dump.sourceCutoff)>Date.parse(receipt.startedAt)
   ||dump.ordinaryProfitDot!==sourceGame[0].profit_dot||dump.fastProfitFirstDot!==fast[0].value)throw new Error('LISTED_POLICY_DUMP_MISMATCH');
 const supplement={schema:'legacy-listed-policy-capture-v2',sourceReceiptSha256,sourceBindingSha256,dumpSha256,
  containerId:receipt.containerId,rollbackConfirmed:receipt.rollbackConfirmed,clientClosed:receipt.clientClosed,identity:receipt.identity,
  comparison:'ACCOUNTS_AND_POLICY_SAME_CAPTURE',temporalLimit:'RUNTIME_REDIS_NOT_CAPTURED',
  baseCaptureStartedAt:receipt.startedAt,baseCaptureFinishedAt:receipt.finishedAt,accountSourceDigests,
  gameRows:sourceGame.map(row=>({id:row.id,profitDot:row.profit_dot})),
  settingRows:settings.filter(row=>row.type==='expendConfig'||row.type==='game'&&row.name==='profitFirstDot').sort((a,b)=>a.id.localeCompare(b.id))};
 const policy={schema:'legacy-listed-policy-evidence-v2',supplement,supplementSha256:sha(canonicalize(supplement)),verifierSha256,
  temporalLimit:'SAME_MYSQL_SNAPSHOT_RUNTIME_REDIS_NOT_CAPTURED',dumpVerification:dump};
 verifySameCaptureListedPolicySource(policy,receipt,games,settings,canonicalize,parseInteger);
 if(accountSourceDigests.length===0)return {status:'NO_LISTED_SOURCE_ACCOUNTS',policy:null,capturedAccounts:scan.captured};
 if(accountSourceDigests.length>10000||Buffer.byteLength(canonicalize(policy),'utf8')>32768)throw new Error('LISTED_POLICY_BATCHING_REQUIRED');
 return {status:'SAME_CAPTURE_POLICY_PREPARED_NO_TARGET',policy,capturedAccounts:scan.captured,listedAccounts:accountSourceDigests.length};
}

/** Partition a fully scanned source into bounded proofs and prove their ordered union is exact. */
export function buildSameCaptureListedPolicyBatches(input){
 const {scan,canonicalize}=input;
 if(!(scan?.accounts instanceof Map)||!(scan?.digests instanceof Map)||scan.accounts.size!==scan.digests.size||typeof canonicalize!=='function')throw new Error('LISTED_BATCH_SOURCE_INVALID');
 const entries=[...scan.digests].sort(([a],[b])=>a<b?-1:a>b?1:0),policies=[];
 const make=part=>{
  const subscan={captured:scan.captured,accounts:new Map(part.map(([id])=>[id,scan.accounts.get(id)])),digests:new Map(part)};
  try{return buildSameCaptureListedPolicy({...input,scan:subscan});}
  catch(error){
   if(error?.message!=='LISTED_POLICY_BATCHING_REQUIRED'||part.length<2)throw error;
   const middle=Math.floor(part.length/2);return [make(part.slice(0,middle)),make(part.slice(middle))].flat();
  }
 };
 if(!entries.length)make([]);
 for(let i=0;i<entries.length;i+=200)policies.push(...[make(entries.slice(i,i+200))].flat());
 const digestRows=entries.map(([id,digest])=>({id,sha256:digest}));
 const manifest={schema:'zzsh.listed-same-capture-batches.v1',sourceReceiptSha256:input.sourceReceiptSha256,
  sourceBindingSha256:input.sourceBindingSha256,dumpSha256:input.dumpSha256,capturedAccounts:scan.captured,listedAccounts:entries.length,
  accountSetSha256:sha(canonicalize(digestRows)),batches:policies.map((item,index)=>({index:index+1,count:item.listedAccounts,
   accountSetSha256:sha(canonicalize(item.policy.supplement.accountSourceDigests)),policyCanonicalSha256:sha(canonicalize(item.policy))}))};
 validateSameCaptureListedPolicyBatches(manifest,policies.map(item=>item.policy),input);
 return {status:!entries.length?'NO_LISTED_SOURCE_ACCOUNTS':policies.length===1?'SAME_CAPTURE_POLICY_PREPARED_NO_TARGET':'SAME_CAPTURE_BATCHES_PREPARED_NO_TARGET',manifest,policies:policies.map(item=>item.policy)};
}

/** Revalidate source binding, batch hashes and the complete source-to-batches union. */
export function validateSameCaptureListedPolicyBatches(manifest,policies,{scan,receipt,sourceReceiptSha256,sourceBindingSha256,dumpSha256,verifierSha256,dump,games,settings,canonicalize,parseInteger}){
 const invalid=()=>{throw new Error('LISTED_BATCH_CLOSURE_INVALID')};
 if(manifest?.schema!=='zzsh.listed-same-capture-batches.v1'||manifest.sourceReceiptSha256!==sourceReceiptSha256
   ||manifest.sourceBindingSha256!==sourceBindingSha256||manifest.dumpSha256!==dumpSha256||manifest.capturedAccounts!==scan?.captured
   ||!(scan?.accounts instanceof Map)||!(scan?.digests instanceof Map)||scan.accounts.size!==scan.digests.size
   ||manifest.listedAccounts!==scan.digests.size||!Array.isArray(manifest.batches)||!Array.isArray(policies)
   ||manifest.batches.length!==policies.length)invalid();
 const verifyBatch=rows=>{
  const batchScan={captured:scan.captured,accounts:new Map(rows.map(({id})=>[id,scan.accounts.get(id)])),digests:new Map(rows.map(({id})=>[id,scan.digests.get(id)]))};
  try{return buildSameCaptureListedPolicy({receipt,sourceReceiptSha256,sourceBindingSha256,dumpSha256,verifierSha256,dump,scan:batchScan,games,settings,canonicalize,parseInteger});}
  catch{invalid();}
 };
 if(!policies.length&&verifyBatch([]).status!=='NO_LISTED_SOURCE_ACCOUNTS')invalid();
 const all=[];
 for(let i=0;i<policies.length;i++){
  const policy=policies[i],batch=manifest.batches[i],p=policy?.supplement,rows=p?.accountSourceDigests;
  if(batch?.index!==i+1||!Array.isArray(rows)||!rows.length||rows.length>200||batch.count!==rows.length
    ||batch.accountSetSha256!==sha(canonicalize(rows))||batch.policyCanonicalSha256!==sha(canonicalize(policy))
    ||policy.schema!=='legacy-listed-policy-evidence-v2'||policy.supplementSha256!==sha(canonicalize(p))
    ||policy.verifierSha256!==verifierSha256||canonicalize(policy.dumpVerification)!==canonicalize(dump)
    ||p.sourceReceiptSha256!==sourceReceiptSha256||p.sourceBindingSha256!==sourceBindingSha256||p.dumpSha256!==dumpSha256
    ||Buffer.byteLength(canonicalize(policy),'utf8')>32768)invalid();
  const rebuilt=verifyBatch(rows);
  if(rebuilt.status!=='SAME_CAPTURE_POLICY_PREPARED_NO_TARGET'||canonicalize(rebuilt.policy)!==canonicalize(policy))invalid();
  all.push(...rows);
 }
 const expected=[...scan.digests].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,digest])=>({id,sha256:digest}));
 if(canonicalize(all)!==canonicalize(expected)||manifest.accountSetSha256!==sha(canonicalize(expected)))invalid();
 return true;
}

/** Select a batch only after the complete source-to-batches union has been rebuilt. */
export function selectSameCaptureListedBatch(manifest,policies,input,index,selectedPolicy){
 validateSameCaptureListedPolicyBatches(manifest,policies,input);
 if(!Number.isSafeInteger(index)||index<1||index>policies.length
   ||input.canonicalize(policies[index-1])!==input.canonicalize(selectedPolicy))throw new Error('LISTED_BATCH_SELECTION_CHANGED');
 const accounts=new Map();
 for(const row of policies[index-1].supplement.accountSourceDigests)accounts.set(row.id,input.scan.accounts.get(row.id));
 return {accounts,captured:input.scan.captured};
}

/** Compare listed source facts with the prepared account, owner, display and path records. */
export function auditSameCaptureListedInputs({scan,policies,accounts,users,displays,paths,canonicalize,listingSnapshot,legacyDisplayMatchesSource,parseLegacyImagePaths,requireCaptureFacts=false}){
 if(!(scan?.accounts instanceof Map)||![accounts,users,displays,paths].every(map=>map instanceof Map)
   ||![canonicalize,listingSnapshot,legacyDisplayMatchesSource,parseLegacyImagePaths].every(fn=>typeof fn==='function')||!Array.isArray(policies))
  throw new Error('LISTED_BATCH_AUDIT_INPUT_INVALID');
 const ids=new Set(),results=[];
 for(const policy of policies){
  const items=policy?.supplement?.accountSourceDigests;
  if(!Array.isArray(items)||!items.length)throw new Error('LISTED_BATCH_AUDIT_INPUT_INVALID');
  const rows=[];
  for(const item of items){
   const raw=scan.accounts.get(item.id),account=accounts.get(item.id),display=displays.get(item.id),path=paths.get(item.id);
   const owner=users.get(raw?.user_id),snapshot=raw?listingSnapshot(raw):null;
   if(ids.has(item.id)||!raw||sha(canonicalize(raw))!==item.sha256||raw.status!=='3'||raw.is_delete!=='0'
     ||!account?.ready||account.sourceDigest!==item.sha256||account.ownerLegacyId!==raw.user_id||!owner
     ||account.ownerUserId!==owner.userId||account.ownerSourceDigest!==owner.sourceDigest
     ||!snapshot?.snapshot||canonicalize(snapshot.snapshot)!==canonicalize(account.snapshot)
     ||snapshot.sourceUpdatedAt!==account.sourceUpdatedAt)throw new Error('LISTED_BATCH_ACCOUNT_INPUT_MISMATCH');
   if(!display||display.baseSourceDigest!==item.sha256||display.sourceUpdatedAt!==account.sourceUpdatedAt
     ||!legacyDisplayMatchesSource(raw,display.snapshot))throw new Error('LISTED_BATCH_DISPLAY_INPUT_MISMATCH');
   if(requireCaptureFacts)assertDisplayCaptureRow(display.snapshot);
   if(!path||path.sourceDigest!==item.sha256||path.legacyOwnerId!==raw.user_id||path.ownerUserId!==owner.userId
     ||canonicalize(path.displayPaths)!==canonicalize(parseLegacyImagePaths(raw.img_paths))
     ||canonicalize(path.penaltyPaths)!==canonicalize(parseLegacyImagePaths(raw.punishment_img_url)))throw new Error('LISTED_BATCH_PATH_INPUT_MISMATCH');
   ids.add(item.id);rows.push({sourceId:item.id,sourceDigest:item.sha256});
  }
  results.push(rows);
 }
 if(ids.size!==scan.accounts.size||[accounts,displays,paths].some(map=>map.size!==ids.size))throw new Error('LISTED_BATCH_AUDIT_SET_CHANGED');
 return results;
}

/** Validate every source batch against the original capture before using any one batch. */
export async function readRoundListedBatch(binding,round,policy,sourceDir,canonicalize,parseInteger){
 const batch=binding.batch;
 if(batch?.schema!=='zzsh.listed-same-capture-batch-binding.v1'||!Number.isSafeInteger(batch.index)||batch.index<1
   ||typeof parseInteger!=='function'||!Array.isArray(batch.policyFiles))throw new Error('LISTED_BATCH_BINDING_REQUIRED');
 const manifestFile=privatePath(batch.manifestFile),manifest=bound(manifestFile,batch.manifestSha256),directory=dirname(manifestFile);
 if(basename(manifestFile)!=='batches.json'||!Array.isArray(manifest.batches)||batch.policyFiles.length!==manifest.batches.length||!manifest.batches.length)
  throw new Error('LISTED_BATCH_BINDING_CHANGED');
 const policies=batch.policyFiles.map((ref,index)=>{
  const name=manifest.batches.length===1?'policy.json':`policy-${String(index+1).padStart(4,'0')}.json`;
  if(ref?.file!==name)throw new Error('LISTED_BATCH_BINDING_CHANGED');
  return bound(privatePath(join(directory,name)),ref.sha256);
 });
 const expected=new Map();
 for(const item of policies)for(const row of item?.supplement?.accountSourceDigests??[]){
  if(expected.has(row.id))throw new Error('LISTED_BATCH_CLOSURE_INVALID');expected.set(row.id,row.sha256);
 }
 const receipt=bound(privatePath(join(sourceDir,'receipt.json')),round.source.sha256),files=receipt.files??{};
 const sourceFile=entry=>{if(typeof entry?.file!=='string'||entry.file!==basename(entry.file))throw new Error('LISTED_UNSAFE_FILE');return privatePath(join(sourceDir,entry.file))};
 const accountsFile=sourceFile(files.accounts),scan=await readBoundListedAccounts(accountsFile,files.accounts,expected,canonicalize);
 const after=createHash('sha256');for await(const chunk of createReadStream(accountsFile))after.update(chunk);
 if(after.digest('hex')!==files.accounts.sha256)throw new Error('LISTED_SOURCE_FILE_CHANGED');
 const games=[],settings=[];
 await readVerifiedSourceRows(sourceFile(files.games),files.games,row=>games.push(row));
 await readVerifiedSourceRows(sourceFile(files.tradePolicy),files.tradePolicy,row=>settings.push(row));
 const sourceBinding=bound(safeAbsolute(binding.sourceBindingFile),binding.sourceBindingSha256),dump=policies[0]?.dumpVerification;
 const selected=selectSameCaptureListedBatch(manifest,policies,{
  scan:{...scan,digests:expected},receipt,sourceReceiptSha256:round.source.sha256,sourceBindingSha256:binding.sourceBindingSha256,
  dumpSha256:sourceBinding.restoreRecord?.dumpSha256,verifierSha256:digest(new URL('./verify-legacy-listed-policy-dump.mjs',import.meta.url)),
  dump,games,settings,canonicalize,parseInteger,
 },batch.index,policy);
 if(selected.accounts.size!==binding.expectedAccountCount||digest(manifestFile)!==batch.manifestSha256
   ||batch.policyFiles.some(ref=>digest(privatePath(join(directory,ref.file)))!==ref.sha256))throw new Error('LISTED_BATCH_BINDING_CHANGED');
 return selected;
}

/** Pure contract used by the generator and loader. Inputs are already read/hash-verified. */
export function validateRoundSourceProof(binding, round, core, audit, observed, canonicalize){
 const failBinding=()=>{throw new Error('LISTED_ROUND_BINDING_CHANGED')};
 const auditValid=binding?.batch
  ? audit?.schema==='zzsh.listed-batch-source-audit.v1'&&audit.status==='SOURCE_FACTS_MATCHED_TARGET_NOT_RUN'
    &&audit.batchManifestSha256===binding.batch.manifestSha256&&audit.batchIndex===binding.batch.index
    &&audit.skinTarget==='NOT_ASSESSED'&&audit.quoteTarget==='NOT_ASSESSED'
  : audit?.status==='OFFLINE_INPUT_COMPATIBLE_TARGET_NOT_RUN';
 if(!binding||binding.schema!=='zzsh.legacy-listed-round-binding.v1'||round?.schema!=='zzsh.local-round.v1'
   ||!['DATASET_AND_GROWTH_ACK_READBACK_PASS','DATASET_AND_GROWTH_REVALIDATED_PASS'].includes(core?.status)
   ||core.completion?.status!=='COMPLETE'||core.inputSha256!==binding.roundInputSha256
   ||core.datasetSha256!==round.dataset?.sha256||canonicalize(core.target)!==canonicalize(round.target)
   ||!auditValid||audit.dbConnections!==0||audit.targetWrites!==0
   ||audit.sourceReceiptSha256!==round.source?.sha256||audit.r06DatasetManifestSha256!==round.dataset?.sha256
   ||audit.sourceBindingSha256!==binding.sourceBindingSha256||audit.policyBundleCanonicalSha256!==binding.policyBundleSha256
   ||audit.policyAuthorityCanonicalSha256!==binding.policyAuthoritySha256
   ||!Array.isArray(audit.accounts)||audit.accounts.length!==binding.expectedAccountCount
   ||!Number.isSafeInteger(binding.expectedAccountCount)||binding.expectedAccountCount<1
   ||!['ROUND06_BOOTSTRAP_RESERVED','ROUND07_BOOTSTRAP_RESERVED'].includes(round.target?.bootstrapReservation)||!/^\d+$/.test(round.target?.oid??'')
   ||round.target?.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'&&(!round.target.instance||canonicalize(round.target.instance)!==canonicalize(observed.instance)||canonicalize(round.target.instance)!==canonicalize(observed.resource?.instance))
   ||(round.target?.migrationProfile??null)!==(observed.resource?.migrationProfile??null)
   ||(round.target?.migrationProfile??null)!==(observed.migrationProfile??null)
   ||!/^[a-f0-9]{24}$/.test(round.target?.nonce??'')||round.target.oid!==observed.oid||round.target.nonce!==observed.nonce
   ||!samePath(round.credentials,observed.credentials)||!samePath(round.actor?.path,observed.actorFile)||!samePath(round.apiDist,observed.apiDist)
   ||!samePath(round.source?.path,binding.sourceDir)||round.actor?.sha256!==observed.actorSha256
   ||observed.resource?.database!=='zzsh_test_regression'||observed.resource?.marker!=='zzsh:regression-test:v1'
   ||observed.resource?.oid!==observed.oid||observed.resource?.nonce!==observed.nonce||observed.resource?.pendingReset
   ||String(observed.resource?.roles?.migration?.oid)!==String(round.target?.migrationRoleOid)
   ||observed.sourceReceiptSha256!==round.source?.sha256||observed.datasetManifestSha256!==round.dataset?.sha256
   ||observed.displayManifestSha256!==round.display?.sha256||observed.pathsReceiptSha256!==round.paths?.sha256
   ||observed.accountFileSha256!==audit.r06AccountsSha256||observed.accountFileSha256!==observed.datasetAccountSha256
   ||observed.userFileSha256!==observed.datasetUserSha256
   ||observed.displayFileSha256!==audit.r06DisplayFileSha256||observed.pathsFileSha256!==audit.r06PathsFileSha256
   ||observed.holdingOverlaySha256!==round.holdingOverlay?.sha256||observed.holdingOverlaySha256!==audit.skinOverlaySha256
   ||observed.sourceBindingSha256!==binding.sourceBindingSha256||observed.policyBundleSha256!==binding.policyBundleSha256
   ||observed.policyAuthoritySha256!==binding.policyAuthoritySha256||observed.loaderSha256!==binding.loaderSha256
   ||observed.helperSha256!==binding.helperSha256||observed.creditGuaranteeEnabled!==binding.creditGuaranteeEnabled)failBinding();
 const from=Date.parse(binding.window?.notBefore??''),until=Date.parse(binding.window?.expiresAt??'');
 if(!Number.isFinite(from)||!Number.isFinite(until)||from>=until||observed.now<from||(!observed.allowExpiredReadOnly&&observed.now>=until))throw new Error('LISTED_ROUND_WINDOW_INACTIVE');
 for(const [key,value] of Object.entries(observed.compiled??{})){
   if(key.includes('/')&&round.buildFiles?.[key+'.js']!==value)throw new Error('LISTED_ROUND_BUILD_CHANGED');
 }
 return true;
}

/** All admitted source IDs/digests must agree across the current plan, audit and policy. */
export function validateRoundAccountSet(plan,audit,policy,expectedCount){
 const rows=plan.listings??plan.rows,verified=audit?.accounts,proof=policy?.supplement?.accountSourceDigests;
 if(!Array.isArray(rows)||!Array.isArray(verified)||!Array.isArray(proof)||[rows.length,verified.length,proof.length].some(x=>x!==expectedCount))throw new Error('LISTED_ROUND_ACCOUNT_SET_CHANGED');
 const ids=new Set(),audited=new Map(verified.map(x=>[x.sourceId,x.sourceDigest])),signed=new Map(proof.map(x=>[x.id,x.sha256]));
 if(audited.size!==expectedCount||signed.size!==expectedCount)throw new Error('LISTED_ROUND_ACCOUNT_SET_CHANGED');
 for(const row of rows){const id=row?.sourceId,digest=row?.sourceDigest??row?.body?.intake?.source?.sourceDigest;
  if(typeof id!=='string'||ids.has(id)||!/^[a-f0-9]{64}$/.test(digest??'')||audited.get(id)!==digest||signed.get(id)!==digest)throw new Error('LISTED_ROUND_ACCOUNT_SET_CHANGED');ids.add(id)}
 return true;
}

/** Verify only files and metadata; this function never creates a database connection. */
export async function verifyRoundBoundSourcePlan(plan,ctx,canonicalize){
 const b=plan.roundBinding;fail(b?.schema==='zzsh.legacy-listed-round-binding.v1','LISTED_ROUND_BINDING_REQUIRED');
 const round=bound(privatePath(b.roundInputFile),b.roundInputSha256),core=bound(privatePath(b.coreReceiptFile),b.coreReceiptSha256),audit=bound(privatePath(b.scopeAuditFile),b.scopeAuditSha256);
 const actorFile=privatePath(round.actor?.path),sourceDir=privatePath(round.source?.path),datasetDir=privatePath(round.dataset?.path);
 const displayDir=privatePath(round.display?.path),pathsDir=privatePath(round.paths?.path),overlayFile=round.holdingOverlay?privatePath(round.holdingOverlay.path):null;
 const dataset=read(join(datasetDir,'manifest.json')),display=read(join(displayDir,'manifest.json')),paths=read(join(pathsDir,'receipt.json'));
 const localFile=(directory,name)=>{fail(typeof name==='string'&&name===basename(name),'LISTED_UNSAFE_FILE');return privatePath(join(directory,name))};
 const policy=read(privatePath(b.policyBundleFile)),authority=read(privatePath(b.policyAuthorityFile));
 const observed={oid:ctx.oid,nonce:ctx.nonce,instance:ctx.instance,migrationProfile:ctx.migrationProfile,credentials:ctx.credentials,actorFile:ctx.actorFile,apiDist:ctx.apiDist,
  actorSha256:digest(actorFile),resource:read(join(dirname(ctx.credentials),'resource.json')),
  sourceReceiptSha256:digest(join(sourceDir,'receipt.json')),datasetManifestSha256:digest(join(datasetDir,'manifest.json')),
  displayManifestSha256:digest(join(displayDir,'manifest.json')),pathsReceiptSha256:digest(join(pathsDir,'receipt.json')),
  accountFileSha256:digest(localFile(datasetDir,dataset.files?.accounts?.file)),datasetAccountSha256:dataset.files?.accounts?.sha256,
  userFileSha256:digest(localFile(datasetDir,dataset.files?.users?.file)),datasetUserSha256:dataset.files?.users?.sha256,
  displayFileSha256:digest(localFile(displayDir,display.file)),pathsFileSha256:digest(localFile(pathsDir,paths.file)),holdingOverlaySha256:overlayFile?digest(overlayFile):undefined,
  sourceBindingSha256:digest(safeAbsolute(b.sourceBindingFile)),policyBundleSha256:sha(canonicalize(policy)),policyAuthoritySha256:sha(canonicalize(authority)),
  loaderSha256:ctx.compiled.loader,helperSha256:digest(new URL('./legacy-listed-round-source.mjs',import.meta.url)),
  creditGuaranteeEnabled:ctx.creditGuaranteeEnabled,compiled:ctx.compiled,allowExpiredReadOnly:ctx.allowExpiredReadOnly===true,now:Date.now()};
 validateRoundSourceProof(b,round,core,audit,observed,canonicalize);
 let dependencyLayout=null,dependencyProof=null;
 if(b.batch){
  const dep=round.dependencyBinding;
  fail(dep?.proof&&dep.buildManifest&&dep.sourceManifest&&round.bootstrapEvidence?.bundle,'LISTED_BATCH_DEPENDENCY_PROOF_REQUIRED');
  const proof=bound(privatePath(dep.proof.path),dep.proof.sha256),layout=inspectRoundDependencyLayout({apiDist:ctx.apiDist,
   bundlePath:round.bootstrapEvidence.bundle.path,bundleSha256:round.bootstrapEvidence.bundle.sha256,
   buildManifestPath:dep.buildManifest.path,buildManifestSha256:dep.buildManifest.sha256,sourceSnapshot:dep.sourceSnapshot,
   sourceManifestPath:dep.sourceManifest.path,sourceManifestSha256:dep.sourceManifest.sha256});
  assertRoundDependencyProof(proof,layout);assertListedRunnerScripts(dirname(fileURLToPath(import.meta.url)),layout.scriptFiles);
  dependencyLayout=layout;dependencyProof=proof;
  validateRoundAccountSet({listings:audit.accounts},audit,policy,b.expectedAccountCount);
  if(audit.batchAccountSetSha256!==sha(canonicalize(policy.supplement?.accountSourceDigests)))throw new Error('LISTED_BATCH_BINDING_CHANGED');
 }
 if(plan.listings||plan.rows) validateRoundAccountSet(plan,audit,policy,b.expectedAccountCount);
 const batch=policy.schema==='legacy-listed-policy-evidence-v2'
  ? await readRoundListedBatch(b,round,policy,sourceDir,canonicalize,ctx.parseInteger) : null;
 if(ctx.sourceDir&&!samePath(ctx.sourceDir,sourceDir))throw new Error('LISTED_SOURCE_ARGUMENT_CHANGED');
 if(ctx.sourceReceiptSha&&ctx.sourceReceiptSha!==round.source.sha256)throw new Error('LISTED_SOURCE_ARGUMENT_CHANGED');
 if(ctx.policyBundle&&!samePath(ctx.policyBundle,b.policyBundleFile)||ctx.policyBundleSha&&ctx.policyBundleSha!==b.policyBundleSha256
   ||ctx.policyAuthority&&!samePath(ctx.policyAuthority,b.policyAuthorityFile)||ctx.policyAuthoritySha&&ctx.policyAuthoritySha!==b.policyAuthoritySha256
   ||ctx.sourceBinding&&!samePath(ctx.sourceBinding,b.sourceBindingFile))throw new Error('LISTED_POLICY_ARGUMENT_CHANGED');
 return {round,core,audit,policy,authority,sourceDir,batch,dependencyLayout,dependencyProof,gameBindings:dataset.gameBindings};
}

/** The v2 execution must follow a fully rolled-back trial of this exact plan and target. */
export function validateRoundTrialReceipt(receipt,inputSha,target,rows,canonicalize){
 if(!receipt||receipt.inputSha!==inputSha||canonicalize(receipt.target)!==canonicalize(target)
   ||target?.migrationProfile===NEXT_MIGRATION_PROFILE&&(receipt.targetFence!=='HELD_DURING_OPERATION'||receipt.targetFenceReleased!==true)
   ||!Array.isArray(receipt.results)||receipt.results.length!==rows.length||receipt.rollbackAcknowledged!==rows.length
   ||receipt.results.some((r,i)=>r.sourceId!==rows[i].sourceId||!['READY','ALREADY_PUBLISHED'].includes(r.state)))
   throw new Error('LISTED_TRIAL_RECEIPT_NOT_COMPLETE');
 return true;
}
