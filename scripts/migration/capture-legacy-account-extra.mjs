import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCapturedSourceOrigin, assertSourceSupplementFields, sourceJsonLine } from './local-source-adapter.mjs';

export const ACCOUNT_EXTRA_FIELDS = Object.freeze(['awm_number','helmet','armor','is_sayyid']);
const sha = value => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const sourceIdPattern = /^[1-9]\d{0,23}$/;

/** A missing column is distinct from a captured SQL NULL. */
export function assertAccountExtraColumns(columns) {
  if (!columns || ACCOUNT_EXTRA_FIELDS.some(field => !columns.has(field))) throw Error('SOURCE_ACCOUNT_EXTRA_COLUMNS_MISSING');
}

function captureIdentity(receipt) {
  const identity=receipt?.identity;
  return receipt?.schema==='zzsh.legacy-source-capture.v1' && receipt.status==='CAPTURED_READ_ONLY'
    && receipt.rollbackConfirmed===true && receipt.clientClosed===true && receipt.client?.code===0
    && receipt.clientStderrPresent===false && receipt.database==='sg_zzsh_restore'
    && digestPattern.test(receipt.containerId??'') && identity?.database===receipt.database
    && identity.principal==='root@localhost' && identity.readOnly===1 && identity.isolation==='REPEATABLE-READ'
    && identity.accessMode==='READ ONLY' && identity.txState==='ACTIVE';
}
function validTimes(receipt) {
  const start=Date.parse(receipt?.startedAt??''),end=Date.parse(receipt?.finishedAt??'');
  return Number.isFinite(start)&&Number.isFinite(end)&&start<=end;
}
function validateFileEntry(entry, expectedFile) {
  if (!entry || entry.file!==expectedFile || entry.table!=='la_rental_accounts' || !digestPattern.test(entry.sha256??'')
    || !Number.isSafeInteger(entry.rows) || entry.rows<0 || !Array.isArray(entry.fields)
    || entry.fields.some(field=>typeof field!=='string') || new Set(entry.fields).size!==entry.fields.length || !entry.fields.includes('id')) throw Error('ACCOUNT_CAPTURE_FILE_CONTRACT_INVALID');
}

/** Matching a registered restore and common fields does not prove when omitted fields last changed. */
export function validateCaptureBindings(base, supplement, binding, bindingSha) {
  if (!captureIdentity(base)||!captureIdentity(supplement)||!validTimes(base)||!validTimes(supplement)) throw Error('SOURCE_CAPTURE_IDENTITY_OR_ROLLBACK_INVALID');
  if (Date.parse(supplement.startedAt)<Date.parse(base.finishedAt)) throw Error('SUPPLEMENT_CAPTURE_TIME_INVALID');
  const old=binding?.schema==='zzsh.local-source-origin.v1'&&binding.container?.name==='zzsh-mysql-restore';
  const next=binding?.schema==='zzsh.local-source-origin.v2'&&/^zzsh-migration-mysql-[a-z0-9-]+$/.test(binding.container?.name??'');
  if ((!old&&!next)
    || binding.container.id!==base.containerId || binding.container.id!==supplement.containerId
    || binding.source?.database!==base.database || binding.source.database!==supplement.database
    || !digestPattern.test(binding.restoreRecord?.dumpSha256??'') || !isAbsolute(binding.restoreRecord?.dumpPath??'')
    || !Number.isFinite(Date.parse(binding.restoreRecord?.exportStartedAt??'')) || !Number.isFinite(Date.parse(binding.restoreRecord?.cutoff??''))
    || Date.parse(binding.restoreRecord.exportStartedAt)>Date.parse(binding.restoreRecord.cutoff)
    || Date.parse(binding.restoreRecord.cutoff)>Date.parse(base.startedAt)
    || typeof binding.restoreRecord.cutoffMeaning!=='string' || !binding.restoreRecord.cutoffMeaning) throw Error('REGISTERED_RESTORE_BINDING_INVALID');
  if(next){assertCapturedSourceOrigin(base,binding,bindingSha);assertCapturedSourceOrigin(supplement,binding,bindingSha);}
  validateFileEntry(base.files?.accounts,'accounts.jsonl');
  validateFileEntry(supplement.files?.accountDisplay,'accountDisplay.jsonl');
  const prior=base.files.accounts,extra=supplement.files.accountDisplay;
  if (!Array.isArray(base.physicalColumns?.la_rental_accounts) || !Array.isArray(supplement.physicalColumns?.la_rental_accounts)) throw Error('SOURCE_PHYSICAL_COLUMNS_UNAVAILABLE');
  assertAccountExtraColumns(new Set(base.physicalColumns.la_rental_accounts));
  assertAccountExtraColumns(new Set(supplement.physicalColumns.la_rental_accounts));
  if (prior.fields.some(field=>!extra.fields.includes(field)) || ACCOUNT_EXTRA_FIELDS.some(field=>!extra.fields.includes(field))
    || (extra.missingFields??[]).some(field=>ACCOUNT_EXTRA_FIELDS.includes(field))) throw Error('SUPPLEMENT_COMMON_OR_EXTRA_FIELDS_MISSING');
}

export function validateSupplementTool(supplement, expected) {
  if (!expected || !digestPattern.test(expected.toolSha256??'') || !digestPattern.test(expected.supportToolSha256??'') || !digestPattern.test(expected.accountExtraToolSha256??'')
    || supplement?.toolSha256!==expected.toolSha256 || supplement?.supportToolSha256!==expected.supportToolSha256 || supplement?.accountExtraToolSha256!==expected.accountExtraToolSha256) throw Error('SUPPLEMENT_CAPTURE_TOOL_CHANGED');
}

function rowShape(row, fields) {
  return row && typeof row==='object' && !Array.isArray(row) && typeof row.id==='string' && sourceIdPattern.test(row.id)
    && Object.keys(row).length===fields.length && fields.every(field=>Object.hasOwn(row,field)
      && (row[field]===null||typeof row[field]==='string'||typeof row[field]==='boolean'||Number.isSafeInteger(row[field])));
}

/** Inputs are already hashed streams. Partial output is quarantined unless finish returns success. */
export async function compareAccountRows(baseRows, supplementRows, baseFields, supplementFields, canonicalize, write) {
  const counts={baseRows:0,supplementRows:0,matchedRows:0,duplicateIds:0,missingIds:0,unexpectedIds:0,changedCommonFields:0,invalidRows:0};
  const originals=new Map(),seen=new Set();
  for await (const row of baseRows) {
    counts.baseRows++;
    if (!rowShape(row,baseFields)) { counts.invalidRows++; continue; }
    if (originals.has(row.id)) { counts.duplicateIds++; continue; }
    originals.set(row.id,row);
  }
  for await (const row of supplementRows) {
    counts.supplementRows++;
    if (!rowShape(row,supplementFields)) { counts.invalidRows++; continue; }
    if (seen.has(row.id)) { counts.duplicateIds++; continue; }
    seen.add(row.id);
    const original=originals.get(row.id);
    if (!original) { counts.unexpectedIds++; continue; }
    originals.delete(row.id);
    try { assertSourceSupplementFields(original,row); }
    catch { counts.changedCommonFields+=Object.keys(original).filter(field=>!Object.hasOwn(row,field)||original[field]!==row[field]).length || 1; continue; }
    if (ACCOUNT_EXTRA_FIELDS.some(field=>!Object.hasOwn(row,field)||(row[field]!==null&&typeof row[field]!=='string'))) { counts.invalidRows++; continue; }
    const fields=Object.fromEntries(ACCOUNT_EXTRA_FIELDS.map(field=>[field,row[field]]));
    await write({legacyId:row.id,baseSourceDigest:sha(canonicalize(original)),fields});
    counts.matchedRows++;
  }
  counts.missingIds=originals.size;
  if (counts.duplicateIds||counts.missingIds||counts.unexpectedIds||counts.changedCommonFields||counts.invalidRows
    || counts.baseRows!==counts.supplementRows||counts.matchedRows!==counts.baseRows) throw Object.assign(Error('ACCOUNT_SOURCE_COMPARISON_FAILED'),{counts});
  return counts;
}

/** Parse the very bytes whose digest is checked; LF framing preserves embedded U+2028/U+2029. */
export async function* verifiedSourceRows(file, expectedSha) {
  const hash=createHash('sha256'),decoder=new StringDecoder('utf8');let pending='';
  for await (const bytes of createReadStream(file)) {
    hash.update(bytes);pending+=decoder.write(bytes);let at;
    while ((at=pending.indexOf('\n'))>=0) { const line=pending.slice(0,at);pending=pending.slice(at+1);if(line.trim())yield JSON.parse(line); }
  }
  pending+=decoder.end();if(pending.trim())yield JSON.parse(pending);
  if (hash.digest('hex')!==expectedSha) throw Error('SOURCE_CAPTURE_FILE_SHA_CHANGED');
}

async function fileHash(path) { const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex'); }
function noLinks(path) {
  let at=resolve(path);
  while (true) { if (existsSync(at)&&lstatSync(at).isSymbolicLink()) throw Error('SOURCE_PATH_LINK_REFUSED');const up=dirname(at);if(up===at)break;at=up; }
}
function absolute(path) { if(!path||!isAbsolute(path))throw Error('ABSOLUTE_PATH_REQUIRED');noLinks(path);return resolve(path); }
function privatePath(path, root) { const value=absolute(path);if(!value.toLowerCase().startsWith(root.toLowerCase()+'\\'))throw Error('PRIVATE_PATH_REQUIRED');return value; }
function readBoundJson(path, expected) { if(!digestPattern.test(expected??''))throw Error('BOUND_SHA_REQUIRED');const bytes=readFileSync(path);if(sha(bytes)!==expected)throw Error('BOUND_JSON_SHA_CHANGED');return JSON.parse(bytes); }
function createPrivateDirectory(path) {
  if(existsSync(path))throw Error('NEW_PRIVATE_OUTPUT_REQUIRED');
  const sid=/S-1-5-[0-9-]+/.exec(spawnSync('whoami',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true,timeout:5000}).stdout)?.[0];
  if(!sid)throw Error('CURRENT_SID_UNAVAILABLE');mkdirSync(path,{recursive:false});
  if(spawnSync('icacls',[path,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true,timeout:5000}).status!==0)throw Error('PRIVATE_OUTPUT_ACL_FAILED');
}

async function main() {
  const args=process.argv.slice(2),names=['--base-source','--base-sha','--supplement-source','--supplement-sha','--source-binding','--source-binding-sha','--canonicalizer','--canonicalizer-sha','--out'];
  const required=['--prepare',...names];
  if(!args.includes('--prepare')) { console.log(JSON.stringify({action:'PLAN',captureCommand:'capture-local-source.mjs --capture --account-display-only',required,dbConnections:0,credentialReads:0,targetWrites:0}));return; }
  if(process.version!=='v24.20.0')throw Error('NODE_BASELINE_MISMATCH');
  if(args.length!==1+2*names.length || args[0]!=='--prepare' || names.some(name=>args.filter(x=>x===name).length!==1))throw Error('EXACT_ARGUMENTS_REQUIRED');
  const option=name=>args[args.indexOf(name)+1];
  const root=realpathSync('E:/zzsh-local-state/restricted');
  const baseDir=privatePath(option('--base-source'),root),supplementDir=privatePath(option('--supplement-source'),root),out=privatePath(option('--out'),root);
  const bindingPath=absolute(option('--source-binding')),canonicalizerPath=absolute(option('--canonicalizer'));
  if(basename(canonicalizerPath)!=='content-hash.js')throw Error('CANONICALIZER_FILE_REQUIRED');
  createPrivateDirectory(out);
  const receipt={schema:'zzsh.legacy-account-extra-capture.v1',status:'STARTED',targetWrites:0,supplementAsOf:'SUPPLEMENT_CAPTURE_SNAPSHOT',intermediateChange:'UNKNOWN',comparison:'NOT_COMPLETED',startedAt:new Date().toISOString(),toolSha256:sha(readFileSync(fileURLToPath(import.meta.url))),adapterSha256:sha(readFileSync(new URL('./local-source-adapter.mjs',import.meta.url)))};
  let fd;
  try {
    const baseReceiptPath=join(baseDir,'receipt.json'),supplementReceiptPath=join(supplementDir,'receipt.json');noLinks(baseReceiptPath);noLinks(supplementReceiptPath);
    const base=readBoundJson(baseReceiptPath,option('--base-sha')),supplement=readBoundJson(supplementReceiptPath,option('--supplement-sha')),binding=readBoundJson(bindingPath,option('--source-binding-sha'));
    validateCaptureBindings(base,supplement,binding,option('--source-binding-sha'));
    const captureToolSha=sha(readFileSync(new URL('./capture-local-source.mjs',import.meta.url)));
    validateSupplementTool(supplement,{toolSha256:captureToolSha,supportToolSha256:receipt.adapterSha256,accountExtraToolSha256:receipt.toolSha256});
    const dumpPath=absolute(binding.restoreRecord.dumpPath),dumpSha=await fileHash(dumpPath);
    if(dumpSha!==binding.restoreRecord.dumpSha256)throw Error('SOURCE_DUMP_SHA_CHANGED');
    const canonicalizerSha=await fileHash(canonicalizerPath);
    if(canonicalizerSha!==option('--canonicalizer-sha'))throw Error('CANONICALIZER_SHA_CHANGED');
    const canonicalize=createRequire(import.meta.url)(canonicalizerPath).canonicalize;
    if(typeof canonicalize!=='function'||await fileHash(canonicalizerPath)!==canonicalizerSha)throw Error('CANONICALIZER_CHANGED_OR_UNAVAILABLE');
    const baseFile=join(baseDir,base.files.accounts.file),supplementFile=join(supplementDir,supplement.files.accountDisplay.file);noLinks(baseFile);noLinks(supplementFile);
    Object.assign(receipt,{baseCaptureReceiptSha256:option('--base-sha'),baseAccountsSha256:base.files.accounts.sha256,supplementCaptureReceiptSha256:option('--supplement-sha'),supplementAccountsSha256:supplement.files.accountDisplay.sha256,sourceBindingSha256:option('--source-binding-sha'),sourceDumpSha256:dumpSha,canonicalizerSha256:canonicalizerSha,
      baseCapture:{startedAt:base.startedAt,finishedAt:base.finishedAt},supplementCapture:{startedAt:supplement.startedAt,finishedAt:supplement.finishedAt,toolSha256:captureToolSha},sourceIdentity:{containerId:binding.container.id,database:binding.source.database,principal:base.identity.principal,sourceCutoff:binding.restoreRecord.cutoff,sourceCutoffMeaning:binding.restoreRecord.cutoffMeaning,provenance:binding.schema==='zzsh.local-source-origin.v2'?'RESTORE_BOUND_EXPORT_CONSISTENCY_NOT_VERIFIED':'REGISTERED_RESTORE_BINDING_NOT_FRESH_RESTORE_ATTESTATION'},rollbackConfirmed:true,clientClosed:true});
    const partial=join(out,'account-extra.jsonl.partial'),digest=createHash('sha256');let rows=0;fd=openSync(partial,'wx');
    receipt.counts=await compareAccountRows(verifiedSourceRows(baseFile,base.files.accounts.sha256),verifiedSourceRows(supplementFile,supplement.files.accountDisplay.sha256),base.files.accounts.fields,supplement.files.accountDisplay.fields,canonicalize,row=>{const bytes=Buffer.from(sourceJsonLine(row));writeFileSync(fd,bytes);digest.update(bytes);rows++;});
    if(receipt.counts.baseRows!==base.files.accounts.rows||receipt.counts.supplementRows!==supplement.files.accountDisplay.rows)throw Error('CAPTURE_RECEIPT_ROW_COUNT_CHANGED');
    fsyncSync(fd);closeSync(fd);fd=undefined;const outputSha=digest.digest('hex');
    if(await fileHash(partial)!==outputSha)throw Error('OUTPUT_READBACK_SHA_CHANGED');
    renameSync(partial,join(out,'account-extra.jsonl'));
    receipt.file={file:'account-extra.jsonl',sha256:outputSha,rows};receipt.comparison='ALL_CAPTURED_COMMON_FIELDS_EQUAL';receipt.status='EXTRA_FIELDS_SOURCE_MATCHED';
  } catch(error) {
    if(error?.counts)receipt.counts=error.counts;receipt.status='FAILED_STOPPED';
    const code=String(error?.message??'');receipt.failure=/^[A-Z][A-Z0-9_]*$/.test(code)?code:'SOURCE_PREPARATION_ERROR';process.exitCode=1;
  } finally {
    if(fd!==undefined)closeSync(fd);receipt.finishedAt=new Date().toISOString();
    writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({status:receipt.status,counts:receipt.counts??null,failure:receipt.failure??null}));
  }
}
if (process.argv[1] && resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()) await main();
