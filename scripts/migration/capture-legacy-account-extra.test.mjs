import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_EXTRA_FIELDS, assertAccountExtraColumns, compareAccountRows, validateCaptureBindings, validateSupplementTool, verifiedSourceRows } from './capture-legacy-account-extra.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex'), digest='a'.repeat(64), container='b'.repeat(64);
const baseFields=['id','user_id','is_demulan','high_risk_owner'], supplementFields=[...baseFields,...ACCOUNT_EXTRA_FIELDS];
const first=()=>({id:'1',user_id:'77',is_demulan:'0',high_risk_owner:0});
const other=()=>({id:'2',user_id:'78',is_demulan:'1',high_risk_owner:null});
const extra=row=>({...row,awm_number:'0002',helmet:null,armor:'',is_sayyid:'1'});
const canonicalize=row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a<b?-1:a>b?1:0)));
const identity={database:'sg_zzsh_restore',principal:'root@localhost',readOnly:1,isolation:'REPEATABLE-READ',accessMode:'READ ONLY',txState:'ACTIVE'};
const receipt=(fields,file,startedAt,finishedAt)=>({schema:'zzsh.legacy-source-capture.v1',status:'CAPTURED_READ_ONLY',containerId:container,database:'sg_zzsh_restore',identity,startedAt,finishedAt,rollbackConfirmed:true,clientClosed:true,client:{code:0},clientStderrPresent:false,physicalColumns:{la_rental_accounts:supplementFields},files:{[file==='accounts.jsonl'?'accounts':'accountDisplay']:{file,table:'la_rental_accounts',fields,missingFields:[],rows:2,sha256:digest}}});
const base=()=>receipt(baseFields,'accounts.jsonl','2026-11-03T09:00:00.000Z','2026-11-03T09:01:00.000Z');
const supplement=()=>receipt(supplementFields,'accountDisplay.jsonl','2026-11-05T09:00:00.000Z','2026-11-05T09:01:00.000Z');
const binding=()=>({schema:'zzsh.local-source-origin.v1',container:{name:'zzsh-mysql-restore',id:container},source:{database:'sg_zzsh_restore'},restoreRecord:{dumpPath:resolve('synthetic-source-dump.sql'),dumpSha256:digest,exportStartedAt:'2026-11-03T07:00:00Z',cutoff:'2026-11-03T07:01:00Z',cutoffMeaning:'EXPORT_COMPLETED_NOT_PROVEN_STOP_WRITE'}});
const asyncRows=rows=>(async function*(){yield*rows;})();
const compare=async (oldRows,newRows)=>{const output=[];const counts=await compareAccountRows(asyncRows(oldRows),asyncRows(newRows),baseFields,supplementFields,canonicalize,row=>output.push(row));return{counts,output};};

test('new capture and display plan both contain all four original account columns',()=>{
  const path=fileURLToPath(new URL('./capture-local-source.mjs',import.meta.url));
  const run=flags=>{const result=spawnSync(process.execPath,[path,'--plan',...flags],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  const full=run([]),display=run(['--account-display-only']);
  assert.deepEqual(full.fieldsByDomain.accounts,full.fieldsByDomain.accountDisplay);
  for(const field of [...ACCOUNT_EXTRA_FIELDS,'is_demulan']) { assert(full.fieldsByDomain.accounts.includes(field));assert(display.fieldsByDomain.accountDisplay.includes(field)); }
  assert.equal(full.dbConnections,0);assert.equal(display.dbConnections,0);assert.equal(full.credentialReads,0);
  assert.doesNotThrow(()=>assertAccountExtraColumns(new Set(ACCOUNT_EXTRA_FIELDS)));
  for(const missing of ACCOUNT_EXTRA_FIELDS)assert.throws(()=>assertAccountExtraColumns(new Set(ACCOUNT_EXTRA_FIELDS.filter(field=>field!==missing))),/SOURCE_ACCOUNT_EXTRA_COLUMNS_MISSING/);
});

test('same-source binding requires original and later read-only transactions, closed clients, physical columns and registered restore',()=>{
  assert.doesNotThrow(()=>validateCaptureBindings(base(),supplement(),binding()));
  for(const mutate of [
    (a,b,c)=>{a.rollbackConfirmed=false;},(a,b,c)=>{b.clientClosed=false;},(a,b,c)=>{b.identity={...b.identity,readOnly:0};},
    (a,b,c)=>{b.containerId='c'.repeat(64);},(a,b,c)=>{c.source.database='other';},(a,b,c)=>{c.restoreRecord.dumpSha256='bad';},
    (a,b,c)=>{c.restoreRecord.cutoff='2026-11-04T00:00:00Z';},(a,b,c)=>{b.startedAt='2026-11-03T08:00:00Z';},
    (a,b,c)=>{a.physicalColumns.la_rental_accounts=a.physicalColumns.la_rental_accounts.filter(field=>field!=='is_sayyid');},
    (a,b,c)=>{b.files.accountDisplay.fields=b.files.accountDisplay.fields.filter(field=>field!=='armor');},
    (a,b,c)=>{b.files.accountDisplay.fields=b.files.accountDisplay.fields.filter(field=>field!=='is_demulan');},
  ]){const a=base(),b=supplement(),c=binding();mutate(a,b,c);assert.throws(()=>validateCaptureBindings(a,b,c));}
});

test('supplement receipt must identify the exact capture, adapter and extra-checking code',()=>{
  const expected={toolSha256:'a'.repeat(64),supportToolSha256:'b'.repeat(64),accountExtraToolSha256:'c'.repeat(64)};
  assert.doesNotThrow(()=>validateSupplementTool({...supplement(),...expected},expected));
  for(const key of Object.keys(expected))assert.throws(()=>validateSupplementTool({...supplement(),...expected,[key]:'0'.repeat(64)},expected),/SUPPLEMENT_CAPTURE_TOOL_CHANGED/);
});

test('matched account extras retain source strings/null and bind the original canonical digest',async()=>{
  const a=first(),b=other(),result=await compare([a,b],[extra(b),extra(a)]);
  assert.deepEqual(result.counts,{baseRows:2,supplementRows:2,matchedRows:2,duplicateIds:0,missingIds:0,unexpectedIds:0,changedCommonFields:0,invalidRows:0});
  const item=result.output.find(row=>row.legacyId==='1');
  assert.deepEqual(item,{legacyId:'1',baseSourceDigest:hash('{"high_risk_owner":0,"id":"1","is_demulan":"0","user_id":"77"}'),fields:{awm_number:'0002',helmet:null,armor:'',is_sayyid:'1'}});
  assert.equal(a.is_demulan,'0');assert.equal(item.fields.is_sayyid,'1');
});

test('missing, unexpected, duplicate, changed, absent and incorrectly typed facts never produce a matched batch',async()=>{
  const a=first(),b=other(),ea=extra(a),eb=extra(b);
  const cases=[
    {old:[a,b],new:[ea],expected:'missingIds'},
    {old:[a,b],new:[ea,extra({...b,id:'3'})],expected:'unexpectedIds'},
    {old:[a,a],new:[ea,ea],expected:'duplicateIds'},
    {old:[a,b],new:[{...ea,is_demulan:'1'},eb],expected:'changedCommonFields'},
    {old:[a,b],new:[{...ea,high_risk_owner:null},eb],expected:'changedCommonFields'},
    {old:[a,b],new:[(({helmet,...rest})=>rest)(ea),eb],expected:'invalidRows'},
    {old:[a,b],new:[{...ea,awm_number:2},eb],expected:'invalidRows'},
    {old:[a,b],new:[{...ea,id:'01'},eb],expected:'invalidRows'},
  ];
  for(const entry of cases){let result;try{await compare(entry.old,entry.new);}catch(error){result=error;}assert.equal(result?.message,'ACCOUNT_SOURCE_COMPARISON_FAILED');assert(result.counts[entry.expected]>0,entry.expected);}
});

test('JSONL verification hashes exactly the parsed UTF-8 bytes and rejects drift',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zzsh-account-extra-')),path=join(dir,'source.jsonl');
  try{const rows=[{id:'1',text:'A'.repeat(65520)+'\u2028中文\u2029'}, {id:'2',text:null}],bytes=Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');writeFileSync(path,bytes);
    const result=[];for await(const row of verifiedSourceRows(path,hash(bytes)))result.push(row);assert.deepEqual(result,rows);
    await assert.rejects(async()=>{for await(const _ of verifiedSourceRows(path,'0'.repeat(64))){}},/SOURCE_CAPTURE_FILE_SHA_CHANGED/);
  }finally{assert.equal(dirname(dir),tmpdir());unlinkSync(path);rmdirSync(dir);}
});

test('supplement entry plan does not read credentials or connect to a database',()=>{
  const path=fileURLToPath(new URL('./capture-legacy-account-extra.mjs',import.meta.url)),result=spawnSync(process.execPath,[path,'--plan'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);const plan=JSON.parse(result.stdout);assert.equal(plan.action,'PLAN');assert.equal(plan.dbConnections,0);assert.equal(plan.credentialReads,0);assert.equal(plan.targetWrites,0);assert(plan.required.includes('--source-binding-sha'));assert(plan.required.includes('--canonicalizer-sha'));
});
