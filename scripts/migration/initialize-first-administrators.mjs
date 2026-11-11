import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import Module,{createRequire} from 'node:module';
import {delimiter,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {defaultStore,writePrivate} from '../local-auth.mjs';
import {writeLoadCheckpoint} from './local-load-checkpoint.mjs';
import {CANONICAL_AUTHORIZATION_TABLES,initialSeedRowsDigest} from './business-initial-seeds.mjs';
import {isolatedDistributionBuild,privateDistributionPath} from './local-distribution-qualification-plan.mjs';
import {assertApprovedMigrationRelease,assertCommittedApiBuild,assertR07RegistrationReceipt,files,validateR07SchemaRequest} from './install-round07-schema.mjs';
import {FirstAdminTransactionError,readFirstAdministratorsSnapshot,writeFirstAdministrators} from './local-first-admin-transaction.mjs';
import {acquireMigrationTransactionFence,advisoryLockSql,assertLiveTarget,assertMigrationFenceHeld,captureMaintenanceLockEpoch,
  hasVerifiedNextInitialSchema,loadRegisteredTarget,maintenanceConnection,NEXT_MIGRATION_PROFILE,targetConnection,targetIdentityQuery} from './local-target-registry.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),hex=value=>/^[a-f0-9]{64}$/.test(value??'');
function noLinks(path){for(let p=resolve(path);p!==dirname(p);p=dirname(p))assert(!lstatSync(p).isSymbolicLink(),'FIRST_ADMIN_LINK_REFUSED');return resolve(path);}
function privatePath(value,output=false){
  const path=privateDistributionPath(restricted,value);noLinks(output?dirname(path):path);return path;
}
function secretPath(value){
  assert(typeof value==='string'&&isAbsolute(value),'FIRST_ADMIN_SECRET_PATH_REQUIRED');
  const path=resolve(value),roots=[restricted,resolve(dirname(defaultStore()))];
  assert(roots.some(base=>{const part=relative(base,path);return part&&!part.startsWith('..')&&!isAbsolute(part);}), 'FIRST_ADMIN_SECRET_PATH_REQUIRED');
  return noLinks(path);
}
function pinned(ref){
  assert(hex(ref?.sha256),'FIRST_ADMIN_INPUT_SHA_REQUIRED');const path=privatePath(ref.path),bytes=readFileSync(path);
  assert.equal(sha(bytes),ref.sha256,'FIRST_ADMIN_INPUT_CHANGED');return JSON.parse(bytes);
}
function syncFile(path){const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
function credentialsFor(target,request){
  const path=secretPath(request.credentials),bytes=readFileSync(path),registered=loadRegisteredTarget(path);
  assert.equal(sha(bytes),request.credentialsSha256,'FIRST_ADMIN_CREDENTIAL_CHANGED');
  assert.equal(sha(readFileSync(noLinks(registered.sourceFile))),request.registrySha256,'FIRST_ADMIN_TARGET_CHANGED');
  const credentials=JSON.parse(bytes);validateR07SchemaRequest(request,registered);
  assert.equal(registered.migrationProfile,NEXT_MIGRATION_PROFILE,'FIRST_ADMIN_NEXT_PROFILE_REQUIRED');
  assert.equal(JSON.stringify(request.target),JSON.stringify(target),'FIRST_ADMIN_TARGET_CHANGED');
  assert(credentials.database===registered.database&&credentials.migration?.name===registered.migrationRole
    &&credentials.migration?.oid===registered.migrationRoleOid,'FIRST_ADMIN_CREDENTIAL_CHANGED');
  return {registered,credentials};
}

/** An old activated-admin or different database receipt cannot initialize a new target. */
export function assertFirstAdminSchemaBinding(request,receipt){
  assert(hasVerifiedNextInitialSchema(receipt),'FIRST_ADMIN_SCHEMA_NOT_READY');
  for(const key of ['oid','nonce','migrationRoleOid','migrationProfile','bootstrapReservation'])
    assert.equal(receipt[key],request.target?.[key],'FIRST_ADMIN_SCHEMA_TARGET_CHANGED');
  assert.deepEqual(receipt.instance,request.target?.instance,'FIRST_ADMIN_SCHEMA_TARGET_CHANGED');
  for(const key of ['initialBaseline','initialBaselineManifestSha256','initialTailSeedProofSha256','releaseCommit'])
    assert.equal(receipt[key],request[key],'FIRST_ADMIN_SCHEMA_SOURCE_CHANGED');
  assert(hex(receipt.historySha256)&&hex(receipt.journalSha256),'FIRST_ADMIN_SCHEMA_HISTORY_REQUIRED');
}

/** Prove the installed role and permission seeds still match the sealed release. */
export async function assertFirstAdminAuthorizationSeeds(client,proof,lockForWrite=false){
  assert.equal(client.getTransactionStatus?.(),'T','FIRST_ADMIN_AUTHORIZATION_TRANSACTION_REQUIRED');
  if(lockForWrite)await client.query('LOCK TABLE '+CANONICAL_AUTHORIZATION_TABLES.join(',')+' IN SHARE MODE');
  for(const name of CANONICAL_AUTHORIZATION_TABLES){
    const expected=proof?.[name];
    assert(Number.isSafeInteger(expected?.count)&&expected.count>=0&&hex(expected.sha256),'FIRST_ADMIN_AUTHORIZATION_PROOF_INVALID');
    const rows=(await client.query(`SELECT to_jsonb(t)-ARRAY['created_at','updated_at'] AS row FROM ${name} t`)).rows.map(item=>item.row);
    assert(rows.length===expected.count&&initialSeedRowsDigest(rows)===expected.sha256,'FIRST_ADMIN_AUTHORIZATION_SEEDS_CHANGED');
  }
}

function verifySource(request,receipt){
  const api=isolatedDistributionBuild(root,request.apiDist);noLinks(api);
  assert.deepEqual(files(api,['.js']),request.buildFiles,'FIRST_ADMIN_BUILD_CHANGED');
  assertCommittedApiBuild(root,request.releaseCommit,request.buildFiles);
  const migrations=files(join(root,'apps/api/migrations'));
  assertApprovedMigrationRelease(root,request.releaseCommit,migrations);
  assert.deepEqual(files(resolve(api,'../../migrations')),migrations,'FIRST_ADMIN_MIGRATIONS_CHANGED');
  assert.equal(sha(readFileSync(join(root,'apps/api/migrations/business/meta/_journal.json'))),receipt.journalSha256,'FIRST_ADMIN_JOURNAL_CHANGED');
  const proofBytes=readFileSync(join(root,'apps/api/migrations/initial/seed-contracts',request.initialBaseline+'.json'));
  assert.equal(sha(proofBytes),request.initialTailSeedProofSha256,'FIRST_ADMIN_AUTHORIZATION_PROOF_CHANGED');
  const authorizationSeeds=JSON.parse(proofBytes).tables;
  const paths=['scripts/migration/initialize-first-administrators.mjs','scripts/migration/local-first-admin-transaction.mjs','scripts/migration/business-initial-seeds.mjs',
    'scripts/migration/install-round07-schema.mjs','scripts/migration/local-target-registry.mjs','scripts/migration/local-load-checkpoint.mjs',
    'scripts/migration/local-distribution-qualification-plan.mjs','scripts/local-auth.mjs'];
  const git=args=>spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
  assert.equal(git(['diff','--quiet','--no-ext-diff',request.releaseCommit,'--',...paths]).status,0,'FIRST_ADMIN_SCRIPT_CHANGED');
  const tracked=git(['ls-tree','-r','--name-only',request.releaseCommit,'--',...paths]);
  assert.equal(tracked.status,0,'FIRST_ADMIN_RELEASE_UNAVAILABLE');const names=new Set(tracked.stdout.split(/\r?\n/));
  assert(paths.every(path=>names.has(path)),'FIRST_ADMIN_SCRIPT_NOT_IN_RELEASE');
  return{api,migrations,authorizationSeeds,scriptHashes:Object.fromEntries(paths.map(path=>[path,sha(readFileSync(noLinks(join(root,path))))]))};
}
function verifyRequest(refs,{source=false}={}){
  const request=pinned(refs.schemaRequest),receipt=pinned(refs.schemaReceipt);
  const {registered,credentials}=credentialsFor(request.target,request);
  assertFirstAdminSchemaBinding(request,receipt);
  assertR07RegistrationReceipt(pinned(request.registrationReceipt),registered);
  const secret=readFileSync(secretPath(request.maintenanceSecret?.path));
  try{assert(hex(request.maintenanceSecret.sha256)&&sha(secret)===request.maintenanceSecret.sha256,'FIRST_ADMIN_MAINTENANCE_SECRET_CHANGED');}
  finally{secret.fill(0);}
  const verifiedSource=source?verifySource(request,receipt):null;
  return{request,receipt,registered,credentials,...verifiedSource};
}
function randomAccounts(){
  const account=name=>({name,password:randomBytes(18).toString('base64url')});
  return{bosses:[account('初始负责人一'),account('初始负责人二')],operations:[account('初始运营一'),account('初始运营二')]};
}

async function prepare(v){
  const refs={schemaRequest:{path:privatePath(v['schema-request']),sha256:v['schema-request-sha']},
    schemaReceipt:{path:privatePath(v['schema-receipt']),sha256:v['schema-receipt-sha']}};
  const {request}=verifyRequest(refs,{source:true}),out=privatePath(v.out,true);
  try{mkdirSync(out,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error('FIRST_ADMIN_ATTEMPT_EXISTS');throw error;}
  const accountsFile=join(out,'initial-passwords.json');writePrivate(accountsFile,randomAccounts());syncFile(accountsFile);
  const prepared={schema:'zzsh.first-admin-initialization.v1',requestId:'initial-admin-'+randomUUID(),refs,target:request.target,
    accountsSha256:sha(readFileSync(accountsFile)),preparedAt:new Date().toISOString()};
  const file=join(out,'prepared.json');writePrivate(file,prepared);syncFile(file);
  console.log(JSON.stringify({status:'FIRST_ADMIN_PREPARED_NOT_EXECUTED',attempt:out,preparedSha256:sha(readFileSync(file)),passwordFile:accountsFile,connections:0,targetWrites:0}));
}

async function execute(v,mode){
  const attempt=privatePath(v.attempt),preparedFile=privatePath(join(attempt,'prepared.json'));
  const prepared=pinned({path:preparedFile,sha256:v['prepared-sha']});
  assert(prepared.schema==='zzsh.first-admin-initialization.v1'&&/^initial-admin-[a-f0-9-]{36}$/.test(prepared.requestId??''),'FIRST_ADMIN_ATTEMPT_INVALID');
  const accountsPath=privatePath(join(attempt,'initial-passwords.json'));
  const readAccounts=()=>{const bytes=readFileSync(accountsPath);assert.equal(sha(bytes),prepared.accountsSha256,'FIRST_ADMIN_PASSWORD_FILE_CHANGED');return JSON.parse(bytes);};
  const input=readAccounts(),bound=verifyRequest(prepared.refs,{source:true}),{request,receipt,registered,credentials,api,migrations,authorizationSeeds,scriptHashes}=bound;
  assert.deepEqual(prepared.target,request.target,'FIRST_ADMIN_TARGET_CHANGED');
  const claim=join(attempt,'claim.json'),resultFile=join(attempt,mode==='initialize'?'result.json':`readback-${randomUUID()}.json`);
  if(mode==='initialize'){
    const fd=openSync(claim,'wx',0o600);try{writeFileSync(fd,JSON.stringify({schema:'zzsh.first-admin-claim.v1',preparedSha256:v['prepared-sha'],requestId:prepared.requestId})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  }else{
    const saved=JSON.parse(readFileSync(privatePath(claim),'utf8'));
    assert(saved.schema==='zzsh.first-admin-claim.v1'&&saved.preparedSha256===v['prepared-sha']&&saved.requestId===prepared.requestId,'FIRST_ADMIN_ORIGINAL_CLAIM_REQUIRED');
  }
  let status='CLAIMED',commitAcknowledged=false,locked=false,writer,reader,fenceEpoch,transactionResult,readbackAccounts,lockClosed=false,writerClosed=true,readerClosed=true,unlockAck=false;
  const save=value=>{status=value.status;writeLoadCheckpoint(resultFile,{schema:'zzsh.first-admin-result.v1',preparedSha256:v['prepared-sha'],requestId:prepared.requestId,
    target:request.target,commitAcknowledged,...(readbackAccounts?{accounts:readbackAccounts}:{}),...value});};
  save({status});
  process.env.NODE_PATH=[join(root,'apps/api/node_modules'),join(root,'node_modules')].join(delimiter);Module._initPaths();
  const require=createRequire(join(root,'apps/api/package.json')),{Client}=require('pg');
  const moduleFile=join(api,'auth/initial-administrators.js');assert(hex(request.buildFiles?.['auth/initial-administrators.js']),'FIRST_ADMIN_BUILD_MODULE_MISSING');
  const {initializeFirstAdministrators,readFirstAdministrators}=require(moduleFile);
  const {hashPassword,verifyPassword}=await import(pathToFileURL(require.resolve('better-auth/crypto')).href);
  const passwordBytes=readFileSync(secretPath(request.maintenanceSecret.path));let connectionError;
  assert.equal(sha(passwordBytes),request.maintenanceSecret.sha256,'FIRST_ADMIN_MAINTENANCE_SECRET_CHANGED');
  const common={connectionTimeoutMillis:3000,statement_timeout:120000,lock_timeout:1000};
  const lock=new Client(maintenanceConnection(registered,{...common,user:registered.owner,password:passwordBytes.toString('utf8').trim(),applicationName:'first-admin-lock'}));passwordBytes.fill(0);
  lock.on('error',()=>{connectionError=true;});
  const newClient=label=>{const c=new Client(targetConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password,applicationName:label}));c.on('error',()=>{connectionError=true;});return c;};
  async function recheck(client){
    assert(!connectionError,'FIRST_ADMIN_CONNECTION_LOST');readAccounts();verifyRequest(prepared.refs);
    assert.deepEqual(files(api,['.js']),request.buildFiles,'FIRST_ADMIN_BUILD_CHANGED');
    assert.deepEqual(files(join(root,'apps/api/migrations')),migrations,'FIRST_ADMIN_MIGRATIONS_CHANGED');
    assert.deepEqual(files(resolve(api,'../../migrations')),migrations,'FIRST_ADMIN_MIGRATIONS_CHANGED');
    for(const [path,digest] of Object.entries(scriptHashes))assert.equal(sha(readFileSync(noLinks(join(root,path)))),digest,'FIRST_ADMIN_SCRIPT_CHANGED');
    const live=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,live);
    await assertMigrationFenceHeld(client,registered,fenceEpoch);
    const history=(await client.query('SELECT hash,created_at::text AS "createdAt" FROM zzsh_business_meta.migrations ORDER BY id')).rows;
    const {canonicalize}=require(join(api,'supply/content-hash.js'));
    assert.equal(sha(canonicalize(history)),receipt.historySha256,'FIRST_ADMIN_SCHEMA_HISTORY_CHANGED');
    await assertFirstAdminAuthorizationSeeds(client,authorizationSeeds,mode==='initialize');
  }
  const fence=async client=>{assertLiveTarget(registered,(await client.query(targetIdentityQuery())).rows[0]);await acquireMigrationTransactionFence(client,registered,fenceEpoch);};
  let failure;
  try{
    await lock.connect();locked=(await lock.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(locked,'FIRST_ADMIN_TARGET_BUSY');
    fenceEpoch=await captureMaintenanceLockEpoch(lock,registered);
    if(mode==='initialize'){
      writer=newClient('first-admin-write');writerClosed=false;await writer.connect();
      transactionResult=await writeFirstAdministrators({client:writer,input,requestId:prepared.requestId,hashPassword,initialize:initializeFirstAdministrators,
        acquireFence:fence,checkBinding:recheck,record:async value=>{if(value.status==='COMMIT_ACK_READBACK_REQUIRED')commitAcknowledged=true;save(value);}});
      commitAcknowledged=true;
      await writer.end();writerClosed=true;writer=null;
    }
    reader=newClient('first-admin-readback');readerClosed=false;await reader.connect();
    const result=await readFirstAdministratorsSnapshot({client:reader,input,requestId:prepared.requestId,verifyPassword,read:readFirstAdministrators,acquireFence:fence,checkBinding:recheck});
    assert(!transactionResult||JSON.stringify(result.accounts)===JSON.stringify(transactionResult),'FIRST_ADMIN_READBACK_DIFFERS');
    readbackAccounts=result.accounts;save({status:result.knowledge==='KNOWN'?'READBACK_KNOWN_CLEANUP_PENDING':'READBACK_UNKNOWN',knowledge:result.knowledge});
    await reader.end();readerClosed=true;reader=null;
  }catch(error){failure=error;
    if(error instanceof FirstAdminTransactionError&&error.outcome==='COMMITTED_READBACK_REQUIRED')commitAcknowledged=true;
    const outcome=commitAcknowledged?'COMMITTED_READBACK_REQUIRED':error instanceof FirstAdminTransactionError?error.outcome:'STOPPED_REVIEW_REQUIRED';
    try{save({status:outcome});}catch{/* retain last durable state */}
  }finally{
    if(writer)try{await writer.end();writerClosed=true;}catch{}
    if(reader)try{await reader.end();readerClosed=true;}catch{}
    if(locked)try{unlockAck=(await lock.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{}
    try{await lock.end();lockClosed=true;}catch{}
  }
  if(failure||!writerClosed||!readerClosed||!unlockAck||!lockClosed){
    try{save({status:status==='READBACK_KNOWN_CLEANUP_PENDING'?'READBACK_KNOWN_CLEANUP_UNCONFIRMED':status,writerClosed,readerClosed,unlockAck,lockClosed});}catch{}
    throw failure??Error('FIRST_ADMIN_CLEANUP_UNCONFIRMED');
  }
  if(status==='READBACK_KNOWN_CLEANUP_PENDING')save({status:'FIRST_ADMIN_READBACK_KNOWN',writerClosed,readerClosed,unlockAck,lockClosed});
  console.log(JSON.stringify({status,attempt,receipt:resultFile,writerClosed,readerClosed,unlockAck,lockClosed,targetWrites:mode==='initialize'?1:0}));
  if(status==='READBACK_UNKNOWN')process.exitCode=2;
}

async function main(){
  const {values:v}=parseArgs({options:{prepare:{type:'boolean'},execute:{type:'boolean'},readback:{type:'boolean'},'schema-request':{type:'string'},
    'schema-request-sha':{type:'string'},'schema-receipt':{type:'string'},'schema-receipt-sha':{type:'string'},out:{type:'string'},attempt:{type:'string'},'prepared-sha':{type:'string'}}});
  if(!v.prepare&&!v.execute&&!v.readback){console.log(JSON.stringify({status:'PLAN_ONLY',prepare:['--prepare','--schema-request','--schema-request-sha','--schema-receipt','--schema-receipt-sha','--out'],
    execute:['--execute','--attempt','--prepared-sha'],readback:['--readback','--attempt','--prepared-sha'],connections:0,targetWrites:0}));return;}
  assert.equal([v.prepare,v.execute,v.readback].filter(Boolean).length,1,'FIRST_ADMIN_ONE_MODE_REQUIRED');
  assert.equal(process.version,'v24.20.0','FIRST_ADMIN_NODE_BASELINE_MISMATCH');
  if(v.prepare)return prepare(v);
  return execute(v,v.execute?'initialize':'readback');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  const code=/^FIRST_ADMIN_[A-Z_]+$/.test(error.message??'')?error.message:undefined;
  console.error(JSON.stringify({status:'FIRST_ADMIN_STOPPED',outcome:error instanceof FirstAdminTransactionError?error.outcome:'REVIEW_REQUIRED',...(code?{code}:{})}));process.exitCode=1;
});
