import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import Module,{createRequire} from 'node:module';
import {delimiter,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {writePrivate} from '../local-auth.mjs';
import {writeLoadCheckpoint} from './local-load-checkpoint.mjs';
import {readInitialization,writeInitialization} from './local-initialization-transaction.mjs';
import {readFirstDistributionSource} from './local-first-distribution-source.mjs';
import {NEXT_SOURCE_SCRIPTS} from './local-round-dependencies.mjs';
import {firstDeploymentPrivatePath as privatePath,firstDeploymentPinned as pinned,firstDeploymentSecretPath as secretPath,
  firstDeploymentNoLinks as noLinks,verifyFirstDeploymentRequest as verifyRequest} from './initialize-first-administrators.mjs';
import {acquireMigrationTransactionFence,advisoryLockSql,assertLiveTarget,assertMaintenanceLockHeld,assertMigrationFenceHeld,
  captureMaintenanceLockEpoch,maintenanceConnection,targetConnection,targetIdentityQuery} from './local-target-registry.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),scripts=join(root,'scripts/migration');
const sha=value=>createHash('sha256').update(value).digest('hex'),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const releasePaths=['initialize-first-distribution.mjs','local-first-distribution-source.mjs','local-initialization-transaction.mjs',
  'local-round-contract.mjs','local-round-dependencies.mjs','local-source-adapter.mjs','local-growth-packages.mjs','business-reference-readiness.mjs',...NEXT_SOURCE_SCRIPTS]
  .map(name=>'scripts/migration/'+name);
const exists=path=>{try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
function syncFile(path){const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
class FirstDistributionError extends Error {
  constructor(outcome,rollbackAcknowledged=false){super('FIRST_DISTRIBUTION_'+outcome);this.outcome=outcome;this.rollbackAcknowledged=rollbackAcknowledged;}
}

function apiModules(api,request){
  const require=createRequire(join(root,'apps/api/package.json'));
  for(const name of ['finance/distribution-first-deployment.js','finance/distribution-policy-change.js','supply/content-hash.js'])
    assert(hex(request.buildFiles?.[name]),'FIRST_DISTRIBUTION_BUILD_MODULE_MISSING');
  return {...require(join(api,'finance/distribution-first-deployment.js')),...require(join(api,'finance/distribution-policy-change.js')),
    ...require(join(api,'supply/content-hash.js')),Client:require('pg').Client};
}
async function sourceFor(bound,workflowRef,modules){
  return readFirstDistributionSource({request:bound.request,workflowRef,privatePath,canonicalize:modules.canonicalize,
    parsePolicy:modules.parseDistributionPolicyChange,scriptsDir:scripts});
}
function verify(refs){return verifyRequest(refs,{source:true,extraPaths:releasePaths});}

async function prepare(v){
  const refs={schemaRequest:{path:privatePath(v['schema-request']),sha256:v['schema-request-sha']},
    schemaReceipt:{path:privatePath(v['schema-receipt']),sha256:v['schema-receipt-sha']},
    workflow:{path:privatePath(v['source-workflow']),sha256:v['source-workflow-sha']}};
  const bound=verify(refs),modules=apiModules(bound.api,bound.request),source=await sourceFor(bound,refs.workflow,modules);
  const out=privatePath(v.out,true);
  try{mkdirSync(out,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error('FIRST_DISTRIBUTION_ATTEMPT_EXISTS');throw error;}
  const prepared={schema:'zzsh.first-distribution-initialization.v1',requestId:'initial-distribution-'+randomUUID(),refs,target:bound.request.target,
    source:{workflowSha256:source.workflowSha256,sourceReceiptSha256:source.sourceReceiptSha256,datasetSha256:source.datasetSha256,summary:source.summary},
    preparedAt:new Date().toISOString()};
  const path=join(out,'prepared.json');writePrivate(path,prepared);syncFile(path);
  console.log(JSON.stringify({status:'FIRST_DISTRIBUTION_PREPARED_NOT_EXECUTED',attempt:out,preparedSha256:sha(readFileSync(path)),connections:0,targetWrites:0}));
}

async function execute(v,mode){
  const attempt=privatePath(v.attempt),preparedFile=privatePath(join(attempt,'prepared.json'));
  const prepared=pinned({path:preparedFile,sha256:v['prepared-sha']});
  assert(prepared.schema==='zzsh.first-distribution-initialization.v1'
    &&/^initial-distribution-[a-f0-9-]{36}$/.test(prepared.requestId??''),'FIRST_DISTRIBUTION_ATTEMPT_INVALID');
  const claim=join(attempt,'claim.json'),resultFile=join(attempt,mode==='initialize'?'result.json':`readback-${randomUUID()}.json`);
  if(mode==='initialize')assert(!exists(claim)&&!exists(resultFile),'FIRST_DISTRIBUTION_ORIGINAL_ATTEMPT_EXISTS');
  else{
    const original=JSON.parse(readFileSync(privatePath(claim),'utf8'));
    assert(original.schema==='zzsh.first-distribution-claim.v1'&&original.preparedSha256===v['prepared-sha']
      &&original.requestId===prepared.requestId,'FIRST_DISTRIBUTION_ORIGINAL_CLAIM_REQUIRED');
  }
  const bound=verify(prepared.refs),{request,receipt,registered,credentials,api,migrations,scriptHashes}=bound;
  assert.deepEqual(prepared.target,request.target,'FIRST_DISTRIBUTION_TARGET_CHANGED');
  process.env.NODE_PATH=[join(root,'apps/api/node_modules'),join(root,'node_modules')].join(delimiter);Module._initPaths();
  const modules=apiModules(api,request),source=await sourceFor(bound,prepared.refs.workflow,modules);
  const expected={workflowSha256:source.workflowSha256,sourceReceiptSha256:source.sourceReceiptSha256,datasetSha256:source.datasetSha256,summary:source.summary};
  assert.deepEqual(expected,prepared.source,'FIRST_DISTRIBUTION_SOURCE_CHANGED');
  const input={requestId:prepared.requestId,sourceReceiptSha256:source.sourceReceiptSha256,change:source.payload};
  let status='CLAIMED',committed=false,locked=false,writer,reader,lock,epoch,writerClosed=true,readerClosed=true,lockClosed=true,unlockAck=false,connectionError,claimCreated=false,resultReserved=false,policyEvidence;
  const save=value=>{status=value.status;writeLoadCheckpoint(resultFile,{schema:'zzsh.first-distribution-result.v1',preparedSha256:v['prepared-sha'],
    requestId:prepared.requestId,target:request.target,commitAcknowledged:committed,...policyEvidence,...value});};
  async function recheck(client){
    assert(!connectionError,'FIRST_DISTRIBUTION_CONNECTION_LOST');pinned({path:preparedFile,sha256:v['prepared-sha']});
    const fresh=verify(prepared.refs);
    assert.deepEqual(fresh.migrations,migrations,'FIRST_DISTRIBUTION_MIGRATIONS_CHANGED');
    for(const [path,digest] of Object.entries(scriptHashes))assert.equal(sha(readFileSync(noLinks(join(root,path)))),digest,'FIRST_DISTRIBUTION_SCRIPT_CHANGED');
    const latest=await sourceFor(fresh,prepared.refs.workflow,modules);
    assert.deepEqual({workflowSha256:latest.workflowSha256,sourceReceiptSha256:latest.sourceReceiptSha256,datasetSha256:latest.datasetSha256,summary:latest.summary},prepared.source,'FIRST_DISTRIBUTION_SOURCE_CHANGED');
    assert.equal(modules.canonicalize(latest.payload),modules.canonicalize(input.change),'FIRST_DISTRIBUTION_SOURCE_CHANGED');
    assertLiveTarget(registered,(await client.query(targetIdentityQuery())).rows[0]);
    await assertMigrationFenceHeld(client,registered,epoch);
    const history=(await client.query('SELECT hash,created_at::text AS "createdAt" FROM zzsh_business_meta.migrations ORDER BY id')).rows;
    assert.equal(sha(modules.canonicalize(history)),receipt.historySha256,'FIRST_DISTRIBUTION_SCHEMA_HISTORY_CHANGED');
  }
  const fence=async client=>{assertLiveTarget(registered,(await client.query(targetIdentityQuery())).rows[0]);await acquireMigrationTransactionFence(client,registered,epoch);};
  let failure,readback;
  try{
    if(mode==='readback'){
      const fd=openSync(resultFile,'wx',0o600);resultReserved=true;closeSync(fd);save({status:'READBACK_STARTED'});
    }
    const secret=readFileSync(secretPath(request.maintenanceSecret.path)),common={connectionTimeoutMillis:3000,statement_timeout:120000,lock_timeout:1000};
    try{
      assert.equal(sha(secret),request.maintenanceSecret.sha256,'FIRST_DISTRIBUTION_MAINTENANCE_SECRET_CHANGED');
      lock=new modules.Client(maintenanceConnection(registered,{...common,user:registered.owner,password:secret.toString('utf8').trim(),applicationName:'first-distribution-lock'}));lockClosed=false;
    }finally{secret.fill(0);}
    lock.on('error',()=>{connectionError=true;});
    const newClient=label=>{const client=new modules.Client(targetConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password,applicationName:label}));
      client.on('error',()=>{connectionError=true;});return client;};
    await lock.connect();locked=(await lock.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;
    assert(locked,'FIRST_DISTRIBUTION_TARGET_BUSY');epoch=await captureMaintenanceLockEpoch(lock,registered);
    if(mode==='initialize'){
      writer=newClient('first-distribution-write');writerClosed=false;await writer.connect();
      assertLiveTarget(registered,(await writer.query(targetIdentityQuery())).rows[0]);await assertMaintenanceLockHeld(lock,registered);
      const fd=openSync(claim,'wx',0o600);claimCreated=true;
      try{writeFileSync(fd,JSON.stringify({schema:'zzsh.first-distribution-claim.v1',preparedSha256:v['prepared-sha'],requestId:prepared.requestId})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
      const resultFd=openSync(resultFile,'wx',0o600);resultReserved=true;closeSync(resultFd);save({status:'CLAIMED'});
      await writeInitialization({client:writer,initialize:client=>modules.initializeFirstDistributionPolicy(client,input),acquireFence:fence,checkBinding:recheck,
        record:async value=>{if(value.status==='COMMIT_ACK_READBACK_REQUIRED')committed=true;save(value);},errorType:FirstDistributionError});
      committed=true;await writer.end();writerClosed=true;writer=null;
    }
    reader=newClient('first-distribution-readback');readerClosed=false;await reader.connect();
    readback=await readInitialization({client:reader,read:client=>modules.readFirstDistributionPolicy(client,input),acquireFence:fence,checkBinding:recheck,errorType:FirstDistributionError});
    if(readback.knowledge==='KNOWN')policyEvidence={policyId:readback.policyId,policyDigest:readback.policyDigest};
    save({status:readback.knowledge==='KNOWN'?'READBACK_KNOWN_CLEANUP_PENDING':'READBACK_UNKNOWN',knowledge:readback.knowledge,
      ...(readback.knowledge==='KNOWN'?{policyId:readback.policyId,policyDigest:readback.policyDigest}: {})});
    await reader.end();readerClosed=true;reader=null;
  }catch(error){failure=error;
    if(error instanceof FirstDistributionError&&error.outcome==='COMMITTED_READBACK_REQUIRED')committed=true;
    if(resultReserved)try{save({status:committed?'COMMITTED_READBACK_REQUIRED':error instanceof FirstDistributionError?error.outcome:'STOPPED_REVIEW_REQUIRED'});}catch{}
  }finally{
    if(writer)try{await writer.end();writerClosed=true;}catch{}
    if(reader)try{await reader.end();readerClosed=true;}catch{}
    if(locked)try{unlockAck=(await lock.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{}
    if(lock)try{await lock.end();lockClosed=true;}catch{}
  }
  if(failure||!writerClosed||!readerClosed||!unlockAck||!lockClosed){
    if(resultReserved)try{save({status:status==='READBACK_KNOWN_CLEANUP_PENDING'?'READBACK_KNOWN_CLEANUP_UNCONFIRMED':status,writerClosed,readerClosed,unlockAck,lockClosed});}catch{}
    if(claimCreated&&!resultReserved)throw Error('FIRST_DISTRIBUTION_CLAIM_REVIEW_REQUIRED');
    throw failure??Error('FIRST_DISTRIBUTION_CLEANUP_UNCONFIRMED');
  }
  if(status==='READBACK_KNOWN_CLEANUP_PENDING')save({status:'FIRST_DISTRIBUTION_READBACK_KNOWN',knowledge:'KNOWN',policyId:readback.policyId,
    policyDigest:readback.policyDigest,writerClosed,readerClosed,unlockAck,lockClosed});
  console.log(JSON.stringify({status,attempt,receipt:resultFile,writerClosed,readerClosed,unlockAck,lockClosed,targetWrites:mode==='initialize'?1:0}));
  if(status==='READBACK_UNKNOWN')process.exitCode=2;
}

async function main(){
  const {values:v}=parseArgs({options:{prepare:{type:'boolean'},execute:{type:'boolean'},readback:{type:'boolean'},'schema-request':{type:'string'},
    'schema-request-sha':{type:'string'},'schema-receipt':{type:'string'},'schema-receipt-sha':{type:'string'},'source-workflow':{type:'string'},
    'source-workflow-sha':{type:'string'},out:{type:'string'},attempt:{type:'string'},'prepared-sha':{type:'string'}}});
  if(!v.prepare&&!v.execute&&!v.readback){console.log(JSON.stringify({status:'PLAN_ONLY',connections:0,targetWrites:0}));return;}
  assert.equal([v.prepare,v.execute,v.readback].filter(Boolean).length,1,'FIRST_DISTRIBUTION_ONE_MODE_REQUIRED');
  assert.equal(process.version,'v24.20.0','FIRST_DISTRIBUTION_NODE_BASELINE_MISMATCH');
  if(v.prepare)return prepare(v);
  return execute(v,v.execute?'initialize':'readback');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  const code=/^FIRST_DISTRIBUTION_[A-Z_]+$/.test(error.message??'')?error.message:undefined;
  console.error(JSON.stringify({status:'FIRST_DISTRIBUTION_STOPPED',outcome:error instanceof FirstDistributionError?error.outcome:'REVIEW_REQUIRED',...(code?{code}:{})}));process.exitCode=1;
});
