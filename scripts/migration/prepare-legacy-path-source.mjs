import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createReadStream,existsSync,lstatSync,mkdirSync,openSync,writeSync,closeSync,readFileSync,realpathSync,statSync,chmodSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {readBoundSourceRows,sourceJsonLine} from './local-source-adapter.mjs';
import {parseLegacyImagePaths} from '../../apps/api/src/supply/legacy-path-media.ts';

const sha=x=>createHash('sha256').update(x).digest('hex');
async function fileSha(file){const h=createHash('sha256');for await(const part of createReadStream(file))h.update(part);return h.digest('hex')}
function assertPrivatePath(root,value){
 if(!isAbsolute(value??''))throw new Error('ABSOLUTE_PRIVATE_PATH_REQUIRED');
 const p=resolve(value),rel=relative(root,p);
 if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('PRIVATE_PATH_REQUIRED');
 let t=existsSync(p)?p:dirname(p);
 for(;;){if(lstatSync(t).isSymbolicLink())throw new Error('REPARSE_POINT_REFUSED');const parent=dirname(t);if(parent===t)break;t=parent}
 return p;
}
function privateDirectory(out){
 mkdirSync(out,{mode:0o700});
 if(process.platform==='win32'){
  const who=spawnSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:5000}),sid=/S-1-5-[0-9-]+/.exec(who.stdout)?.[0];
  if(who.status!==0||!sid)throw new Error('CURRENT_SID_REQUIRED');
  if(spawnSync('icacls',[out,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true,timeout:5000}).status!==0)throw new Error('PRIVATE_OUTPUT_ACL_FAILED');
  const check="$a=Get-Acl -LiteralPath $env:ZZSH_MEDIA_ACL_PATH;if(!$a.AreAccessRulesProtected){exit 2};$allowed=@($env:ZZSH_MEDIA_ACL_SID,'S-1-5-18','S-1-5-32-544');foreach($r in $a.Access){$s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;if($s -notin $allowed){exit 3}}";
  if(spawnSync('pwsh.exe',['-NoProfile','-Command',check],{env:{...process.env,ZZSH_MEDIA_ACL_PATH:out,ZZSH_MEDIA_ACL_SID:sid},windowsHide:true,timeout:5000}).status!==0)throw new Error('PRIVATE_OUTPUT_ACL_UNVERIFIED');
 }else{
  chmodSync(out,0o700);const info=statSync(out);
  if((info.mode&0o077)!==0||typeof process.getuid==='function'&&info.uid!==process.getuid())throw new Error('PRIVATE_OUTPUT_MODE_UNVERIFIED');
 }
}
function fieldReference(row,field){
 if(!Object.hasOwn(row,field))return {field:{observation:'ABSENT'},references:[]};
 const raw=row[field];if(raw===null)return {field:{observation:'NULL',raw},references:[]};
 if(typeof raw!=='string')return {field:{observation:'INVALID',raw},references:[]};
 try{const paths=parseLegacyImagePaths(raw);return {field:{observation:paths.length?'PRESENT':'EMPTY',raw},references:paths.map(sourceToken=>({field,sourceToken}))}}
 catch{return {field:{observation:'INVALID',raw},references:[]}}
}
/** Only source references are produced: no media assets, READY flags, DB or OSS. */
export function planLegacyPathSourceRow(row,sourceSnapshotSha256){
 if(!/^[a-f0-9]{64}$/.test(sourceSnapshotSha256??'')||!row||typeof row.id!=='string'||typeof row.user_id!=='string'||!/^[1-9]\d*$/.test(row.id)||!/^[1-9]\d*$/.test(row.user_id))throw new Error('SOURCE_IDENTITY_REQUIRED');
 const display=fieldReference(row,'img_paths'),penalty=fieldReference(row,'punishment_img_url');
 return {schema:'legacy-path-source-reference-v1',sourceSnapshotSha256,legacyAccountId:row.id,legacyOwnerId:row.user_id,
  fields:{img_paths:display.field,punishment_img_url:penalty.field},references:[...display.references,...penalty.references]};
}
function writeAll(fd,bytes){let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);if(n<=0)throw new Error('PRIVATE_OUTPUT_WRITE_FAILED');at+=n}}

/** Seal a new compatible source-reference package; an existing output is never overwritten. */
export async function prepareLegacyPathSource({privateRoot,sourceDir,receiptSha256,out}){
 if(!isAbsolute(privateRoot??'')||!/^[a-f0-9]{64}$/.test(receiptSha256??''))throw new Error('EXACT_PRIVATE_INPUT_REQUIRED');
 const root=realpathSync(privateRoot),source=assertPrivatePath(root,sourceDir),output=assertPrivatePath(root,out);
 if(existsSync(output))throw new Error('NEW_OUTPUT_REQUIRED');
 const within=(parent,child)=>{const r=relative(parent,child);return !r||r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)};
 if(within(source,output)||within(output,source))throw new Error('SOURCE_OUTPUT_OVERLAP');
 const receiptFile=assertPrivatePath(root,resolve(source,'receipt.json')),receiptBytes=readFileSync(receiptFile);
 if(sha(receiptBytes)!==receiptSha256)throw new Error('SOURCE_RECEIPT_SHA_MISMATCH');
 const capture=JSON.parse(receiptBytes),accountFile=capture.files?.accounts;
 if(capture.status!=='CAPTURED_READ_ONLY'||capture.rollbackConfirmed!==true||capture.clientClosed!==true||!accountFile
   ||typeof accountFile.file!=='string'||accountFile.file!==basename(accountFile.file)||!/^[a-f0-9]{64}$/.test(accountFile.sha256??'')
   ||!Number.isSafeInteger(accountFile.rows)||accountFile.rows<0||!Array.isArray(accountFile.fields)
   ||!['id','user_id','img_paths','punishment_img_url'].every(f=>accountFile.fields.includes(f)))throw new Error('SOURCE_CAPTURE_NOT_BOUND');
 const input=assertPrivatePath(root,resolve(source,accountFile.file));
 if(await fileSha(input)!==accountFile.sha256)throw new Error('SOURCE_FILE_SHA_MISMATCH');
 const startedAt=new Date().toISOString(),started=performance.now();privateDirectory(output);
 let refs,quarantine;
 const rh=createHash('sha256'),qh=createHash('sha256'),seen=new Set();
 const counts={rows:0,plannedRows:0,quarantinedRows:0,displayPaths:0,penaltyPaths:0,absentFields:0,invalidFields:0};
 try{
  refs=openSync(resolve(output,'references.jsonl'),'wx',0o600);quarantine=openSync(resolve(output,'quarantine.jsonl'),'wx',0o600);
  for await(const row of readBoundSourceRows(input,accountFile)){
   counts.rows++;let record;
   try{record=planLegacyPathSourceRow(row,accountFile.sha256)}catch(error){if(error.message!=='SOURCE_IDENTITY_REQUIRED')throw error;
    const b=Buffer.from(sourceJsonLine({sourceRow:counts.rows,reason:'SOURCE_IDENTITY_INVALID'}));writeAll(quarantine,b);qh.update(b);counts.quarantinedRows++;continue}
   if(seen.has(record.legacyAccountId))throw new Error('SOURCE_ACCOUNT_DUPLICATE');seen.add(record.legacyAccountId);
   for(const [field,value] of Object.entries(record.fields)){if(value.observation==='ABSENT')counts.absentFields++;if(value.observation==='INVALID')counts.invalidFields++;
    if(field==='img_paths')counts.displayPaths+=record.references.filter(x=>x.field===field).length;else counts.penaltyPaths+=record.references.filter(x=>x.field===field).length}
   const b=Buffer.from(sourceJsonLine(record));writeAll(refs,b);rh.update(b);counts.plannedRows++;
  }
 }finally{if(refs!==undefined)closeSync(refs);if(quarantine!==undefined)closeSync(quarantine)}
 if(counts.rows!==accountFile.rows)throw new Error('SOURCE_ROW_COUNT_MISMATCH');
 if(sha(readFileSync(receiptFile))!==receiptSha256)throw new Error('SOURCE_CHANGED_DURING_PREPARATION');
 const receipt={schema:'legacy-path-source-extract-v1',status:'SOURCE_REFERENCES_PLANNED_TARGET_NOT_RUN',sourceReceiptSha256:receiptSha256,
  sourceAccountsSha256:accountFile.sha256,...counts,referencesSha256:rh.digest('hex'),quarantineSha256:qh.digest('hex'),
  startedAt,finishedAt:new Date().toISOString(),wallMs:performance.now()-started,dbConnections:0,storageWrites:0,targetWrites:0};
 const bytes=JSON.stringify(receipt,null,2)+'\n';writeFileSync(resolve(output,'receipt.json'),bytes,{flag:'wx',mode:0o600});
 return {...receipt,receiptSha256:sha(bytes)};
}

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1]};
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(!args.includes('--prepare'))console.log(JSON.stringify({action:'PLAN',required:['--prepare','--private-root','--source-dir','--receipt-sha','--out'],dbConnections:0,storageWrites:0,targetWrites:0}));
 else try{console.log(JSON.stringify(await prepareLegacyPathSource({privateRoot:option('--private-root'),sourceDir:option('--source-dir'),receiptSha256:option('--receipt-sha'),out:option('--out')})))}catch(error){console.error(error.message);process.exitCode=1}
}
