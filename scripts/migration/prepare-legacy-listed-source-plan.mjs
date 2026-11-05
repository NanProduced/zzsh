import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readSourceRows } from './local-source-adapter.mjs';
import { verifyRoundBoundSourcePlan } from './legacy-listed-round-source.mjs';

const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]};
if(!args.includes('--prepare')){console.log(JSON.stringify({action:'PLAN',requires:['--prepare','--round-input','--round-input-sha','--core-receipt','--core-receipt-sha','--scope-audit','--scope-audit-sha','--source-binding','--policy-bundle','--policy-authority','--oid','--expected-count','--not-before','--expires-at','--out'],connections:0,credentialReads:0}));process.exit(0)}
const root=resolve('E:/zzsh-local-state/restricted'),privatePath=x=>{const p=resolve(x??'');if(!isAbsolute(x??'')||!p.toLowerCase().startsWith(root.toLowerCase()+'\\'))throw new Error('PRIVATE_PATH_REQUIRED');return p};
const sha=x=>createHash('sha256').update(x).digest('hex'),read=x=>JSON.parse(readFileSync(x,'utf8'));
const require=createRequire(import.meta.url),assert=(x,m)=>{if(!x)throw new Error(m)};
const started=performance.now(),roundFile=privatePath(option('--round-input')),roundBytes=readFileSync(roundFile),roundSha=sha(roundBytes);
assert(roundSha===option('--round-input-sha'),'ROUND_INPUT_SHA_CHANGED');const round=JSON.parse(roundBytes);
const coreFile=privatePath(option('--core-receipt')),coreBytes=readFileSync(coreFile),auditFile=privatePath(option('--scope-audit')),auditBytes=readFileSync(auditFile);
assert(sha(coreBytes)===option('--core-receipt-sha')&&sha(auditBytes)===option('--scope-audit-sha'),'INPUT_RECEIPT_SHA_CHANGED');
const audit=JSON.parse(auditBytes),policyFile=privatePath(option('--policy-bundle')),authorityFile=privatePath(option('--policy-authority'));
const bindingFile=resolve(option('--source-binding')??''),out=privatePath(option('--out'));
assert(isAbsolute(option('--source-binding')??'')&&!existsSync(out),'NEW_PRIVATE_OUTPUT_REQUIRED');
assert(/^\d+$/.test(option('--oid')??'')&&round.target?.oid===option('--oid'),'EXPECTED_TARGET_OID_REQUIRED');
const count=Number(option('--expected-count'));assert(Number.isSafeInteger(count)&&count>0&&count===audit.accounts?.length,'EXPECTED_SOURCE_COUNT_REQUIRED');
assert(isAbsolute(round.apiDist??'')&&round.buildFiles&&typeof round.buildFiles==='object','ROUND_BUILD_REQUIRED');
const compiled={};for(const [name,expected] of Object.entries(round.buildFiles)){
 assert(name.endsWith('.js')&&!name.includes('..')&&!isAbsolute(name),'ROUND_BUILD_PATH_INVALID');
 const actual=sha(readFileSync(join(round.apiDist,name)));assert(actual===expected,'ROUND_BUILD_CHANGED');compiled[name.slice(0,-3)]=actual;
}
const loaderPath=fileURLToPath(new URL('./load-legacy-listed-accounts.mjs',import.meta.url)),helperPath=fileURLToPath(new URL('./legacy-listed-round-source.mjs',import.meta.url));
compiled.loader=sha(readFileSync(loaderPath));
const {canonicalize}=require(join(round.apiDist,'supply/content-hash.js'));
const policy=read(policyFile),authority=read(authorityFile),policySha=sha(canonicalize(policy)),authoritySha=sha(canonicalize(authority));
assert(policySha===audit.policyBundleCanonicalSha256&&authoritySha===audit.policyAuthorityCanonicalSha256,'SOURCE_POLICY_CHANGED');
const binding={schema:'zzsh.legacy-listed-round-binding.v1',roundInputFile:roundFile,roundInputSha256:roundSha,coreReceiptFile:coreFile,coreReceiptSha256:sha(coreBytes),scopeAuditFile:auditFile,scopeAuditSha256:sha(auditBytes),sourceDir:round.source.path,window:{notBefore:option('--not-before'),expiresAt:option('--expires-at')},sourceBindingFile:bindingFile,sourceBindingSha256:sha(readFileSync(bindingFile)),policyBundleFile:policyFile,policyBundleSha256:policySha,policyAuthorityFile:authorityFile,policyAuthoritySha256:authoritySha,loaderSha256:compiled.loader,helperSha256:sha(readFileSync(helperPath)),creditGuaranteeEnabled:args.includes('--credit-guarantee'),expectedAccountCount:count};
const temporary={roundBinding:binding},ctx={oid:round.target.oid,nonce:round.target.nonce,credentials:round.credentials,actorFile:round.actor.path,apiDist:round.apiDist,creditGuaranteeEnabled:binding.creditGuaranteeEnabled,compiled};
const verified=verifyRoundBoundSourcePlan(temporary,ctx,canonicalize);
assert(policy.supplement?.sourceReceiptSha256===round.source.sha256&&authority.policyBundleSha256===policySha,'SOURCE_POLICY_BINDING_CHANGED');
const candidates=policy.supplement.accountSourceDigests;assert(Array.isArray(candidates)&&candidates.length===count,'POLICY_SOURCE_COUNT_CHANGED');
const wanted=new Map(candidates.map(x=>[x.id,x.sha256])),audited=new Map(verified.audit.accounts.map(x=>[x.sourceId,x.sourceDigest]));
assert(wanted.size===count&&audited.size===count&&[...wanted].every(([id,d])=>audited.get(id)===d),'AUDITED_ACCOUNT_SET_CHANGED');
const receipt=read(join(round.source.path,'receipt.json'));assert(receipt.files?.accounts?.file==='accounts.jsonl','SOURCE_ACCOUNT_FILE_INVALID');
const sourceFile=join(round.source.path,receipt.files.accounts.file),digest=createHash('sha256');
for await(const c of createReadStream(sourceFile))digest.update(c);assert(digest.digest('hex')===receipt.files.accounts.sha256,'SOURCE_ACCOUNTS_CHANGED');
const raw=new Map();for await(const row of readSourceRows(sourceFile))if(wanted.has(row.id)){assert(!raw.has(row.id),'SOURCE_ACCOUNT_DUPLICATE');raw.set(row.id,row)}
assert(raw.size===count,'SOURCE_ACCOUNT_MISSING');const listings=[];
for(const [id,expected] of wanted){
 const row=raw.get(id),sourceDigest=sha(canonicalize(row));assert(sourceDigest===expected&&row.status==='3'&&row.is_delete==='0','SOURCE_FACT_CHANGED');
 assert(['0','1'].includes(row.is_full_payout)&&['default','custom','fast'].includes(row.ratio_type),'SOURCE_LISTING_INVALID');
 const ownerRatioB=row.ratio_type==='default'?null:row.base_bot;
 const evidence=canonicalize({sourceSystem:'legacy_mysql_restore',sourceEntity:'la_rental_accounts',legacyId:id,baseSourceDigest:sourceDigest,deposit_amount:row.deposit_amount,is_full_payout:row.is_full_payout,ownerRatioB,sourceStatus:'3',sourceDeleted:'0',processing_time_start:row.processing_time_start,processing_time_end:row.processing_time_end});
 listings.push({sourceId:id,sourceDigest,depositYuan:row.deposit_amount,fullPayout:row.is_full_payout,ownerRatioB,sourceFieldEvidenceDigest:sha(evidence)});
}
const plan={schema:'zzsh.listed-source-continuity-plan.v2',createdAt:new Date().toISOString(),roundBinding:binding,listings};
mkdirSync(out);const who=spawnSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}),sid=/S-1-5-[0-9-]+/.exec(who.stdout)?.[0];assert(who.status===0&&sid,'CURRENT_SID_REQUIRED');
assert(spawnSync('icacls',[out,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true}).status===0,'OUTPUT_ACL_FAILED');
const bytes=JSON.stringify(plan,null,2)+'\n';writeFileSync(join(out,'source-plan.json'),bytes,{flag:'wx'});
const receiptOut={status:'SOURCE_PLAN_PREPARED_NO_DATABASE',sourcePlanSha256:sha(bytes),roundInputSha256:roundSha,coreReceiptSha256:sha(coreBytes),scopeAuditSha256:sha(auditBytes),accounts:count,wallMs:performance.now()-started,dbConnections:0,credentialReads:0,targetWrites:0};
writeFileSync(join(out,'receipt.json'),JSON.stringify(receiptOut,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(receiptOut));
