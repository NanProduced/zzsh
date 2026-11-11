import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {readFirstDistributionSource} from './local-first-distribution-source.mjs';
import {NEXT_SOURCE_SCRIPTS} from './local-round-dependencies.mjs';
import {NEXT_MIGRATION_PROFILE} from './local-target-registry.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const scripts=dirname(fileURLToPath(import.meta.url)),root=resolve(scripts,'../..');
const require=createRequire(join(root,'apps/api/package.json'));
const {canonicalize}=require(join(root,'apps/api/dist/src/supply/content-hash.js'));
const {parseDistributionPolicyChange}=require(join(root,'apps/api/dist/src/finance/distribution-policy-change.js'));

test('first distribution uses one sealed source workflow and dataset, and rejects changed bytes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'zzsh-first-distribution-binding-'));
  const dirs=['output','output/source','output/finance','output/refund','dataset'].map(name=>join(dir,name));
  for(const path of dirs)mkdirSync(path);
  const files=[];
  t.after(()=>{for(const path of files.reverse())unlinkSync(path);for(const path of dirs.reverse())rmdirSync(path);rmdirSync(dir);});
  const put=(path,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));writeFileSync(path,bytes);files.push(path);return {path,sha256:sha(bytes)};};
  const tools=Object.fromEntries([...NEXT_SOURCE_SCRIPTS,'local-source-adapter.mjs','../local-auth.mjs']
    .map(name=>[name,sha(readFileSync(resolve(scripts,name)))]));
  const containerId='a'.repeat(64),serverUuid='a1234567-1234-1234-1234-123456789012',dump=join(dir,'synthetic.sql'),cutoff='2026-11-03T00:00:00.000Z';
  put(dump,Buffer.from('synthetic dump'));
  const binding={schema:'zzsh.local-source-origin.v2',container:{id:containerId,name:'zzsh-migration-mysql-next-synth-test',imageId:'sha256:'+'b'.repeat(64)},
    source:{database:'legacy',serverUuid,network:'none',readOnly:true,superReadOnly:true,eventScheduler:'DISABLED'},
    restoreRecord:{dumpPath:dump,dumpSha256:'c'.repeat(64),consumedSha256:'c'.repeat(64),importClientExitCode:0,
      exportStartedAt:cutoff,cutoff,sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE'},
    toolSha256:tools['prepare-local-mysql-source.mjs'],checkpointToolSha256:tools['local-load-checkpoint.mjs']};
  const sourceBinding=put(join(dir,'binding.json'),binding);
  const origin={schema:binding.schema,bindingSha256:sourceBinding.sha256,verifiedAfterCapture:true,
    sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE',serverUuid};
  const common={schema:'zzsh.legacy-source-capture.v1',status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,
    client:{code:0},clientStderrPresent:false,sourceOrigin:origin,containerId,database:'legacy',
    identity:{database:'legacy',principal:'root@localhost',readOnly:1,isolation:'REPEATABLE-READ',accessMode:'READ ONLY',txState:'ACTIVE',
      serverUuid,globalReadOnly:1,superReadOnly:1,eventScheduler:'DISABLED'},toolSha256:tools['capture-local-source.mjs'],
    supportToolSha256:tools['local-source-adapter.mjs'],accountExtraToolSha256:tools['capture-legacy-account-extra.mjs']};
  const settings={open:'1',level:'1',openCondition:'1',isSelfRebate:'0',settlementTiming:'1',settlementTime:'7.0'};
  const config=Buffer.from(Object.entries(settings).map(([name,value])=>JSON.stringify({name,value,is_delete:'0'})).join('\n')+'\n');
  const levels=Buffer.from(JSON.stringify({id:'1',weights:'1',is_default:'1',first_ratio:'20.00',second_ratio:'20.00',name:'合成等级',is_delete:'0'})+'\n');
  put(join(dir,'output/source/config.jsonl'),config);const levelsPath=join(dir,'output/source/levels.jsonl');put(levelsPath,levels);
  const sourceReceipt={...common,files:{distributionConfig:{file:'config.jsonl',sha256:sha(config),rows:6},distributionLevels:{file:'levels.jsonl',sha256:sha(levels),rows:1}}};
  const sourceFile=put(join(dir,'output/source/receipt.json'),sourceReceipt),source={path:join(dir,'output/source'),sha256:sourceFile.sha256};
  const supplement={...common,sourceSupplement:{baseReceiptSha256:source.sha256}};
  const fundsFile=put(join(dir,'output/finance/receipt.json'),supplement),refundFile=put(join(dir,'output/refund/receipt.json'),supplement);
  const funds={path:join(dir,'output/finance'),sha256:fundsFile.sha256},refundAttempts={path:join(dir,'output/refund'),sha256:refundFile.sha256};
  const spec={schema:'zzsh.local-source-workflow.v1',suffix:'next-synth-test',imageId:binding.container.imageId,dump,
    exportStartedAt:cutoff,cutoff,out:join(dir,'output')},input=put(join(dir,'input.json'),spec);
  const workflow={schema:'zzsh.local-source-workflow-receipt.v1',status:'SOURCE_CAPTURED_DATASET_NOT_PREPARED',targetWrites:0,automaticCleanup:false,
    input,inputSha256:input.sha256,toolFiles:tools,stages:['prepare','restore','capture','finance','refund','verify'].map(name=>({name,status:'ACK',wallMs:1})),
    result:{source,funds,refundAttempts,sourceBinding,containerId}};
  const workflowRef=put(join(dir,'output/receipt.json'),workflow);
  const dataset={sourceReceiptSha256:source.sha256,sourceCutoff:cutoff,sourceOrigin:{bindingSha256:sourceBinding.sha256,dumpSha256:binding.restoreRecord.dumpSha256}};
  const datasetRef=put(join(dir,'dataset/manifest.json'),dataset);
  const request={target:{migrationProfile:NEXT_MIGRATION_PROFILE},datasetPath:join(dir,'dataset'),datasetSha256:datasetRef.sha256};
  const privatePath=value=>{const path=resolve(value),part=relative(dir,path);assert(part&&!part.startsWith('..'));return path;};
  const args={request,workflowRef,privatePath,canonicalize,parsePolicy:parseDistributionPolicyChange,scriptsDir:scripts};
  const actual=await readFirstDistributionSource(args);
  assert.equal(actual.payload.config.legacySource.receiptSha256,source.sha256);assert.equal(actual.summary.settlementDelayDays,7);
  await assert.rejects(readFirstDistributionSource({...args,request:{...request,datasetSha256:'0'.repeat(64)}}),/FIRST_DISTRIBUTION_SOURCE_CHANGED/);
  writeFileSync(levelsPath,Buffer.concat([levels,Buffer.from('\n')]));
  await assert.rejects(readFirstDistributionSource(args),/SOURCE_STREAM_CHANGED/);
});

test('distribution initialization defaults to a no-connection plan and preserves the original attempt',
  {skip:!existsSync('E:/zzsh-local-state/restricted')},()=>{
  const script=join(scripts,'initialize-first-distribution.mjs'),plan=spawnSync(process.execPath,[script],{encoding:'utf8'});
  assert.equal(plan.status,0);assert.deepEqual(JSON.parse(plan.stdout),{status:'PLAN_ONLY',connections:0,targetWrites:0});
  const dir=mkdtempSync('E:/zzsh-local-state/restricted/first-distribution-claimed-test-'),prepared=join(dir,'prepared.json');
  const bytes=Buffer.from(JSON.stringify({schema:'zzsh.first-distribution-initialization.v1',requestId:'initial-distribution-01234567-89ab-cdef-0123-456789abcdef'}));
  writeFileSync(prepared,bytes);
  try{
    for(const name of ['claim.json','result.json']){
      const path=join(dir,name);writeFileSync(path,'original attempt');
      const run=spawnSync(process.execPath,[script,'--execute','--attempt',dir,'--prepared-sha',sha(bytes)],{encoding:'utf8'});
      assert.equal(run.status,1);assert.equal(JSON.parse(run.stderr).code,'FIRST_DISTRIBUTION_ORIGINAL_ATTEMPT_EXISTS');
      assert.equal(readFileSync(path,'utf8'),'original attempt');unlinkSync(path);
    }
  }finally{unlinkSync(prepared);rmdirSync(dir);}
});
