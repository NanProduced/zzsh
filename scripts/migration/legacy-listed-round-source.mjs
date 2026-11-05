import { createHash } from 'node:crypto';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

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
function bound(file,expected){fail(/^[a-f0-9]{64}$/.test(expected??'')&&digest(file)===expected,'LISTED_BOUND_FILE_CHANGED');return read(file)}

/** Pure contract used by the generator and loader. Inputs are already read/hash-verified. */
export function validateRoundSourceProof(binding, round, core, audit, observed, canonicalize){
 const failBinding=()=>{throw new Error('LISTED_ROUND_BINDING_CHANGED')};
 if(!binding||binding.schema!=='zzsh.legacy-listed-round-binding.v1'||round?.schema!=='zzsh.local-round.v1'
   ||!['DATASET_AND_GROWTH_ACK_READBACK_PASS','DATASET_AND_GROWTH_REVALIDATED_PASS'].includes(core?.status)
   ||core.completion?.status!=='COMPLETE'||core.inputSha256!==binding.roundInputSha256
   ||core.datasetSha256!==round.dataset?.sha256||canonicalize(core.target)!==canonicalize(round.target)
   ||audit?.status!=='OFFLINE_INPUT_COMPATIBLE_TARGET_NOT_RUN'||audit.dbConnections!==0||audit.targetWrites!==0
   ||audit.sourceReceiptSha256!==round.source?.sha256||audit.r06DatasetManifestSha256!==round.dataset?.sha256
   ||audit.sourceBindingSha256!==binding.sourceBindingSha256||audit.policyBundleCanonicalSha256!==binding.policyBundleSha256
   ||audit.policyAuthorityCanonicalSha256!==binding.policyAuthoritySha256
   ||!Array.isArray(audit.accounts)||audit.accounts.length!==binding.expectedAccountCount
   ||!Number.isSafeInteger(binding.expectedAccountCount)||binding.expectedAccountCount<1
   ||round.target?.bootstrapReservation!=='ROUND06_BOOTSTRAP_RESERVED'||!/^\d+$/.test(round.target?.oid??'')
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
export function verifyRoundBoundSourcePlan(plan,ctx,canonicalize){
 const b=plan.roundBinding;fail(b?.schema==='zzsh.legacy-listed-round-binding.v1','LISTED_ROUND_BINDING_REQUIRED');
 const round=bound(privatePath(b.roundInputFile),b.roundInputSha256),core=bound(privatePath(b.coreReceiptFile),b.coreReceiptSha256),audit=bound(privatePath(b.scopeAuditFile),b.scopeAuditSha256);
 const actorFile=privatePath(round.actor?.path),sourceDir=privatePath(round.source?.path),datasetDir=privatePath(round.dataset?.path);
 const displayDir=privatePath(round.display?.path),pathsDir=privatePath(round.paths?.path),overlayFile=privatePath(round.holdingOverlay?.path);
 const dataset=read(join(datasetDir,'manifest.json')),display=read(join(displayDir,'manifest.json')),paths=read(join(pathsDir,'receipt.json'));
 const localFile=(directory,name)=>{fail(typeof name==='string'&&name===basename(name),'LISTED_UNSAFE_FILE');return privatePath(join(directory,name))};
 const policy=read(privatePath(b.policyBundleFile)),authority=read(privatePath(b.policyAuthorityFile));
 const observed={oid:ctx.oid,nonce:ctx.nonce,credentials:ctx.credentials,actorFile:ctx.actorFile,apiDist:ctx.apiDist,
  actorSha256:digest(actorFile),resource:read(join(dirname(ctx.credentials),'resource.json')),
  sourceReceiptSha256:digest(join(sourceDir,'receipt.json')),datasetManifestSha256:digest(join(datasetDir,'manifest.json')),
  displayManifestSha256:digest(join(displayDir,'manifest.json')),pathsReceiptSha256:digest(join(pathsDir,'receipt.json')),
  accountFileSha256:digest(localFile(datasetDir,dataset.files?.accounts?.file)),datasetAccountSha256:dataset.files?.accounts?.sha256,
  userFileSha256:digest(localFile(datasetDir,dataset.files?.users?.file)),datasetUserSha256:dataset.files?.users?.sha256,
  displayFileSha256:digest(localFile(displayDir,display.file)),pathsFileSha256:digest(localFile(pathsDir,paths.file)),holdingOverlaySha256:digest(overlayFile),
  sourceBindingSha256:digest(b.sourceBindingFile),policyBundleSha256:sha(canonicalize(policy)),policyAuthoritySha256:sha(canonicalize(authority)),
  loaderSha256:ctx.compiled.loader,helperSha256:digest(new URL('./legacy-listed-round-source.mjs',import.meta.url)),
  creditGuaranteeEnabled:ctx.creditGuaranteeEnabled,compiled:ctx.compiled,allowExpiredReadOnly:ctx.allowExpiredReadOnly===true,now:Date.now()};
 validateRoundSourceProof(b,round,core,audit,observed,canonicalize);
 if(plan.listings||plan.rows) validateRoundAccountSet(plan,audit,policy,b.expectedAccountCount);
 if(ctx.sourceDir&&!samePath(ctx.sourceDir,sourceDir))throw new Error('LISTED_SOURCE_ARGUMENT_CHANGED');
 if(ctx.sourceReceiptSha&&ctx.sourceReceiptSha!==round.source.sha256)throw new Error('LISTED_SOURCE_ARGUMENT_CHANGED');
 if(ctx.policyBundle&&!samePath(ctx.policyBundle,b.policyBundleFile)||ctx.policyBundleSha&&ctx.policyBundleSha!==b.policyBundleSha256
   ||ctx.policyAuthority&&!samePath(ctx.policyAuthority,b.policyAuthorityFile)||ctx.policyAuthoritySha&&ctx.policyAuthoritySha!==b.policyAuthoritySha256
   ||ctx.sourceBinding&&!samePath(ctx.sourceBinding,b.sourceBindingFile))throw new Error('LISTED_POLICY_ARGUMENT_CHANGED');
 return {round,core,audit,policy,authority,sourceDir};
}

/** The v2 execution must follow a fully rolled-back trial of this exact plan and target. */
export function validateRoundTrialReceipt(receipt,inputSha,target,rows,canonicalize){
 if(!receipt||receipt.inputSha!==inputSha||canonicalize(receipt.target)!==canonicalize(target)
   ||!Array.isArray(receipt.results)||receipt.results.length!==rows.length||receipt.rollbackAcknowledged!==rows.length
   ||receipt.results.some((r,i)=>r.sourceId!==rows[i].sourceId||!['READY','ALREADY_PUBLISHED'].includes(r.state)))
   throw new Error('LISTED_TRIAL_RECEIPT_NOT_COMPLETE');
 return true;
}
