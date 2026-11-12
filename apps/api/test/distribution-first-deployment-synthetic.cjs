const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { Client } = require('pg');

const system=process.env.FIRST_DISTRIBUTION_SYSTEM,oid=process.env.FIRST_DISTRIBUTION_OID;
if (process.env.FIRST_DISTRIBUTION_SYNTHETIC !== '1' || !/^[0-9]+$/.test(system??'') || !/^[0-9]+$/.test(oid??''))
  throw Error('EXACT_SYNTHETIC_TARGET_REQUIRED');

const installed=process.env.FIRST_DISTRIBUTION_FIXTURE === 'initial-tail';
const database=installed?'zzsh_synth_initial_tail_20261111':'zzsh_synth_initial_distribution_20261111';
const marker=installed?'zzsh:synthetic:initial-tail-distribution:v1':'zzsh:synthetic:initial-distribution:v1';
const client = user => new Client({host:'127.0.0.1',port:55439,database,user,statement_timeout:20000,lock_timeout:10000});
const owner=client('zzsh_synth_migrator'),race=client('zzsh_synth_migrator'),monitor=client('zzsh_synth_migrator'),runtime=client('zzsh_synth_runtime');
const {initializeFirstDistributionPolicy,readFirstDistributionPolicy}=require('../dist/src/finance/distribution-first-deployment.js');
const {parseDistributionPolicyChange,initialDistributionPolicyConfig}=require('../dist/src/finance/distribution-policy-change.js');
const {readDistributionPolicyRowInTransaction}=require('../dist/src/finance/distribution-policy-store.js');
const {canonicalize}=require('../dist/src/supply/content-hash.js');
const sha=value=>createHash('sha256').update(value).digest('hex');
const source='a'.repeat(64),input={sourceReceiptSha256:source,requestId:'synthetic-first-policy',change:{schema:'distribution-policy-initialize.v2',reason:'合成首版政策',config:{
  schema:'distribution-policy.v3',scope:'NATIVE',enabled:true,participation:'AUTO_AT_REGISTRATION',depth:1,selfRebate:false,
  accountModes:['ordinary','custom'],minimumAccrualCents:'1',settlementDelayDays:7,
  levels:[{code:'legacy_1',rank:1,default:true,renterPercent:'20',ownerPercent:'20',upgrade:null}],
  legacySource:{receiptSha256:source,configurationSha256:'b'.repeat(64),levelsSha256:'c'.repeat(64),levelNames:{legacy_1:'合成等级'}}}}};
const policy=initialDistributionPolicyConfig(parseDistributionPolicyChange(input.change),'NATIVE');
const canonical=canonicalize(policy),digest=sha(canonical),policyId='distribution_policy_'+sha(canonicalize(['NATIVE','1',digest])).slice(0,40);
let stage='CONNECT',pending;
const rollback=async c=>{if(['T','E'].includes(c.getTransactionStatus()))await c.query('ROLLBACK');};
async function identity(c){
  const row=(await c.query(`SELECT (pg_control_system()).system_identifier::text AS system,d.oid::text AS oid,
    pg_get_userbyid(d.datdba) AS owner,shobj_description(d.oid,'pg_database') AS marker
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.deepEqual(row,{system,oid,owner:'zzsh_synth_migrator',marker});
}
async function read(c,value=input){
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{return await readFirstDistributionPolicy(c,value);}finally{await rollback(c);}
}
(async()=>{try{
  await owner.connect();await identity(owner);
  const others=(await owner.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n;
  assert.equal(others,0);await race.connect();await monitor.connect();await runtime.connect();
  await identity(race);await identity(monitor);
  stage='SCHEMA';
  const prior=(await owner.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='zzsh_order' AND table_name='distribution_policy_version' AND column_name='initial_source_receipt_sha256') AS present")).rows[0];
  assert.equal(prior.present,installed);
  if (!installed) {
    const sql=readFileSync(resolve(__dirname,'../migrations/business/0209_initial_distribution_source.sql'),'utf8');
    await owner.query('BEGIN');await owner.query(sql);assert.equal((await owner.query('COMMIT')).command,'COMMIT');
  }
  const grants=(await owner.query("SELECT has_column_privilege('zzsh_synth_runtime','zzsh_order.distribution_policy_version','initial_source_receipt_sha256','INSERT') AS source_insert")).rows[0];
  assert.equal(grants.source_insert,false);
  stage='EMPTY_AND_RUNTIME';assert.deepEqual(await read(owner),{knowledge:'UNKNOWN'});
  await runtime.query('BEGIN');await assert.rejects(initializeFirstDistributionPolicy(runtime,input));await rollback(runtime);
  await runtime.query('BEGIN');
  await assert.rejects(runtime.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id,initial_source_receipt_sha256)
    VALUES($1,1,'NATIVE',$2,$3,$4,NULL,$5)`,[policyId,policy.schema,canonical,digest,source]),e=>e.code==='42501');await rollback(runtime);
  const mismatch=structuredClone(input);mismatch.sourceReceiptSha256='d'.repeat(64);
  await owner.query('BEGIN');await assert.rejects(initializeFirstDistributionPolicy(owner,mismatch));await rollback(owner);
  stage='VERIFIED_SOURCE_POLICY';
  const {loadLegacyDistributionPrerequisite}=await import(pathToFileURL(resolve(__dirname,'../../../scripts/migration/local-distribution-qualification-plan.mjs')));
  const dir=mkdtempSync(join(tmpdir(),'zzsh-first-distribution-source-'));
  const configPath=join(dir,'config.jsonl'),levelsPath=join(dir,'levels.jsonl'),receiptPath=join(dir,'receipt.json');
  try{
    const settings={open:'1',level:'1',openCondition:'1',isSelfRebate:'0',settlementTiming:'1',settlementTime:'7.0'};
    const config=Buffer.from(Object.entries(settings).map(([name,value])=>JSON.stringify({name,value,is_delete:'0'})).join('\n')+'\n');
    const levels=Buffer.from(JSON.stringify({id:'1',weights:'1',is_default:'1',first_ratio:'20.00',second_ratio:'20.00',name:'合成等级',is_delete:'0'})+'\n');
    const receipt={status:'CAPTURED_READ_ONLY',rollbackConfirmed:true,clientClosed:true,files:{
      distributionConfig:{file:'config.jsonl',sha256:sha(config),rows:6},distributionLevels:{file:'levels.jsonl',sha256:sha(levels),rows:1}}};
    const receiptBytes=Buffer.from(JSON.stringify(receipt));
    writeFileSync(configPath,config);writeFileSync(levelsPath,levels);writeFileSync(receiptPath,receiptBytes);
    const options={sourceDir:dir,receipt,sourceSha256:sha(receiptBytes),canonicalize,parsePolicy:parseDistributionPolicyChange};
    const bound=await loadLegacyDistributionPrerequisite(options);
    await owner.query('BEGIN');
    const result=await initializeFirstDistributionPolicy(owner,{sourceReceiptSha256:options.sourceSha256,requestId:'synthetic-source-policy',change:bound.payload});
    assert.equal(result.policyDigest,bound.summary.policyDigest);await rollback(owner);
    writeFileSync(levelsPath,Buffer.concat([levels,Buffer.from('\n')]));
    await assert.rejects(loadLegacyDistributionPrerequisite(options),/SOURCE_STREAM_CHANGED/);
  }finally{for(const path of [configPath,levelsPath,receiptPath])try{unlinkSync(path);}catch{};rmdirSync(dir);}
  stage='EXISTING_USER';await owner.query('BEGIN');
  await owner.query(`INSERT INTO zzsh_auth_user."user" (id,name,email,"createdAt","updatedAt") VALUES('synthetic-user','合成用户','synthetic@example.invalid',clock_timestamp(),clock_timestamp())`);
  await assert.rejects(initializeFirstDistributionPolicy(owner,input),/target is not empty/);await rollback(owner);
  await owner.query('BEGIN');
  await owner.query(`INSERT INTO zzsh_auth_user."user" (id,name,email,"createdAt","updatedAt") VALUES('synthetic-user','合成用户','synthetic@example.invalid',clock_timestamp(),clock_timestamp())`);
  await assert.rejects(owner.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id,initial_source_receipt_sha256)
    VALUES($1,1,'NATIVE',$2,$3,$4,NULL,$5)`,[policyId,policy.schema,canonical,digest,source]),e=>e.code==='23514');await rollback(owner);
  stage='MISSING_SYSTEM_AUDIT';await owner.query('BEGIN');
  await owner.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id,initial_source_receipt_sha256)
    VALUES($1,1,'NATIVE',$2,$3,$4,NULL,$5)`,[policyId,policy.schema,canonical,digest,source]);
  await owner.query("INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES('NATIVE',1,$1)",[policyId]);
  await assert.rejects(owner.query('SET CONSTRAINTS ALL IMMEDIATE'),e=>e.code==='23514');await rollback(owner);
  stage='CONCURRENT_INITIALIZATION';await owner.query('BEGIN');const first=await initializeFirstDistributionPolicy(owner,input);
  await race.query('BEGIN');pending=initializeFirstDistributionPolicy(race,input).then(value=>({value}),error=>({error}));
  let waited=false;for(let i=0;i<100;i++){
    const blockers=(await monitor.query('SELECT pg_blocking_pids($1) AS pids',[race.processID])).rows[0].pids;
    if(blockers.includes(owner.processID)){waited=true;break;}await new Promise(done=>setTimeout(done,30));
  }
  assert.equal(waited,true,'SECOND_INITIALIZER_DID_NOT_WAIT');assert.equal((await owner.query('COMMIT')).command,'COMMIT');
  const second=await pending;pending=null;assert.match(second.error?.message??'',/target is not empty/);await rollback(race);
  stage='READBACK';const readback=await read(owner);
  assert.deepEqual(readback,{knowledge:'KNOWN',policyId:first.policyId,policyDigest:first.policyDigest,sourceReceiptSha256:source});
  const wrong=structuredClone(input);wrong.requestId='different-request';await assert.rejects(read(owner,wrong),/evidence differs/);
  await runtime.query('BEGIN READ ONLY');
  const live=await readDistributionPolicyRowInTransaction(runtime,false,'NATIVE');
  assert.equal(live.knowledge,'KNOWN');assert.equal(live.policy.versionId,first.policyId);assert.equal(live.policy.digest,first.policyDigest);
  await rollback(runtime);
  const counts=(await owner.query(`SELECT (SELECT count(*)::int FROM zzsh_order.distribution_policy_version WHERE scope='NATIVE') AS versions,
    (SELECT count(*)::int FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE') AS heads,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE action='distribution.policy.system_initialized') AS audits,
    (SELECT count(*)::int FROM zzsh_iam.approval_request WHERE operation_code='distribution.policy.publish') AS approvals`)).rows[0];
  assert.deepEqual(counts,{versions:1,heads:1,audits:1,approvals:0});
  stage='ADMIN_VERSION_COMPATIBILITY';await owner.query('BEGIN');
  await owner.query(`INSERT INTO zzsh_auth_admin."user" (id,name,email,"createdAt","updatedAt") VALUES('synthetic-admin','合成管理员','admin@example.invalid',clock_timestamp(),clock_timestamp())`);
  await owner.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id)
    VALUES('synthetic-admin-policy',2,'NATIVE',$1,$2,$3,'synthetic-admin')`,[policy.schema,canonical,digest]);
  await owner.query("UPDATE zzsh_order.distribution_policy_head SET revision=2,current_version_id='synthetic-admin-policy' WHERE scope='NATIVE'");
  await owner.query('SET CONSTRAINTS ALL IMMEDIATE');assert.equal((await readDistributionPolicyRowInTransaction(owner,false,'NATIVE')).policy.revision,'2');await rollback(owner);
  stage='IMMUTABILITY';await owner.query('BEGIN');await assert.rejects(owner.query("UPDATE zzsh_order.distribution_policy_version SET canonical_config=canonical_config WHERE id=$1",[policyId]));await rollback(owner);
  assert.equal((await read(owner)).knowledge,'KNOWN');
  console.log(JSON.stringify({status:'SYNTHETIC_PASS',policyVersions:1,systemAudits:1,approvalRequests:0,
    sourceValidation:true,originalReadback:true,runtimeRead:true,existingUserRejected:true,runtimeRejected:true,systemAuditRequired:true,
    actualLockWait:true,adminVersionSchemaCompatible:true,immutable:true,realProviderCalls:0}));
}catch(error){console.error(JSON.stringify({status:'SYNTHETIC_FAILED',stage,code:error?.code??'CHECK_FAILED',message:error?.message?.slice(0,160)}));process.exitCode=1;}
finally{for(const c of [owner,race,monitor,runtime])try{await rollback(c);}catch{process.exitCode=1;}if(pending)await pending.catch(()=>{});for(const c of [owner,race,monitor,runtime])try{await c.end();}catch{process.exitCode=1;}}})();
