import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { acquireMigrationSessionFence, advisoryLockSql, assertLiveTarget, assertMigrationFenceHeld, captureMaintenanceLockEpoch, isRegisteredMigrationInstance, NEXT_INITIAL_BASELINE, NEXT_MIGRATION_PROFILE, loadRegisteredTarget, maintenanceConnection, releaseMigrationSessionFence, targetConnection, targetIdentityQuery } from './local-target-registry.mjs';
import { isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';
import { writeLoadCheckpoint } from './local-load-checkpoint.mjs';
import { INITIAL_SEED_TABLES, CANONICAL_AUTHORIZATION_TABLES, assertCanonicalSeedProof, assertCanonicalSeedRows, assertInitialSingleton, initialSeedRowsDigest } from './business-initial-seeds.mjs';
import { POST_TAIL_SEED_TABLES, loadInitialTailSeedProof, matchesKnown0155LineEndings } from './business-initial-tail-seeds.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex'),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),privateRoot=resolve('E:/zzsh-local-state/restricted'),secretRoot=resolve('E:/zzsh/zzsh/apps/api/.secrets');
function checkedPath(value,output=false,base=privateRoot){
  assert(typeof value==='string'&&isAbsolute(value),'SCHEMA_PRIVATE_PATH_REQUIRED');const p=resolve(value),rel=relative(base,p);
  assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'SCHEMA_PRIVATE_PATH_REQUIRED');
  for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'SCHEMA_LINK_REFUSED');return p;
}
function checkedSecret(value){
  assert(typeof value==='string'&&isAbsolute(value),'SCHEMA_PRIVATE_PATH_REQUIRED');const rel=relative(secretRoot,resolve(value));
  return rel&&!rel.startsWith('..')&&!isAbsolute(rel)?checkedPath(value,false,secretRoot):checkedPath(value);
}
function pinned(ref){const p=checkedPath(ref?.path),bytes=readFileSync(p);assert(hex(ref.sha256)&&sha(bytes)===ref.sha256,'SCHEMA_INPUT_CHANGED');return JSON.parse(bytes);}
export function files(rootDir,extensions=null){
  const result={};function walk(dir,prefix=''){for(const entry of readdirSync(dir,{withFileTypes:true})){
    assert(!entry.isSymbolicLink(),'SCHEMA_LINK_REFUSED');const name=prefix+entry.name,p=join(dir,entry.name);
    if(entry.isDirectory())walk(p,name+'/');else if(entry.isFile()&&(!extensions||extensions.some(x=>name.endsWith(x))))result[name]=sha(readFileSync(p));
  }}walk(rootDir);return result;
}
function buildPath(value){const api=isolatedDistributionBuild(root,value);for(let x=api;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'SCHEMA_LINK_REFUSED');return api;}
const canonical=value=>JSON.stringify(value,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const LEGACY_BASELINE='release_production_0153', TEST_SERVER_BASELINE=NEXT_INITIAL_BASELINE;

const TAIL_SCHEMA_TOOLS=['install-round07-schema.mjs','business-initial-seeds.mjs','business-initial-tail-seeds.mjs',
  'local-target-registry.mjs','local-distribution-qualification-plan.mjs','local-load-checkpoint.mjs','../local-auth.mjs',
  '../../apps/api/src/database/business-migration-compat.ts'];
const validCommit=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
function schemaToolHashes(){
  return Object.fromEntries(TAIL_SCHEMA_TOOLS.map(name=>{const file=join(root,'scripts/migration',name),stat=lstatSync(file);
    assert(stat.isFile()&&!stat.isSymbolicLink(),'SCHEMA_TOOL_UNSAFE');return [name,sha(readFileSync(file))];}));
}
export function assertSchemaToolBinding(expected,actual){
  assert.deepEqual(Object.keys(expected??{}).sort(),[...TAIL_SCHEMA_TOOLS].sort(),'SCHEMA_TOOL_BINDING_INVALID');
  for(const name of TAIL_SCHEMA_TOOLS)assert(hex(expected[name])&&expected[name]===actual?.[name],'SCHEMA_TOOL_CHANGED');
}
/** Compare migration bytes with an independently selected, reviewed Git commit. */
export function assertApprovedMigrationRelease(repo,commit,migrationHashes){
  assert(validCommit(commit),'SCHEMA_RELEASE_COMMIT_REQUIRED');
  const git=(args,code='SCHEMA_RELEASE_COMMIT_INVALID',binary=false)=>{
    const result=spawnSync('git',args,{cwd:repo,encoding:binary?null:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
    assert(result.status===0,code);return result.stdout;
  };
  assert.equal(git(['rev-parse','--verify',commit+'^{commit}']).trim(),commit,'SCHEMA_RELEASE_COMMIT_INVALID');
  const prefix='apps/api/migrations/',entries=git(['ls-tree','-r','-z',commit,'--','apps/api/migrations']).split('\0').filter(Boolean);
  const expected={};
  for(const entry of entries){
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    assert(match&&match[3].startsWith(prefix),'SCHEMA_RELEASE_TREE_INVALID');
    const name=match[3].slice(prefix.length);assert(name&&!Object.hasOwn(expected,name),'SCHEMA_RELEASE_TREE_INVALID');expected[name]=match[2];
  }
  assert(entries.length>0&&canonical(Object.keys(expected).sort())===canonical(Object.keys(migrationHashes).sort()),'SCHEMA_RELEASE_FILES_CHANGED');
  for(const [name,blob] of Object.entries(expected)){
    const bytes=readFileSync(join(repo,prefix,name));
    const gitBlob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    let known0155=false;
    if(gitBlob!==blob&&name==='business/0155_legacy_rental_distribution_policy.sql'){
      const journal=JSON.parse(readFileSync(join(repo,prefix,'business/meta/_journal.json')));
      const entry=journal.entries?.find(item=>item.tag==='0155_legacy_rental_distribution_policy');
      const approved=git(['show',commit+':'+prefix+name],'SCHEMA_RELEASE_COMMIT_INVALID',true);
      known0155=matchesKnown0155LineEndings(entry?.tag,String(entry?.when),bytes,sha(approved));
    }
    assert((gitBlob===blob||known0155)&&sha(bytes)===migrationHashes[name],'SCHEMA_RELEASE_FILES_CHANGED');
  }
  const toolPaths=TAIL_SCHEMA_TOOLS.map(name=>relative(repo,join(repo,'scripts/migration',name)).replaceAll('\\','/'));
  const tools=git(['ls-tree','-r','-z',commit,'--',...toolPaths]).split('\0').filter(Boolean);
  const tracked=tools.map(entry=>/^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry)?.[2]).sort();
  assert.deepEqual(tracked,[...toolPaths].sort(),'SCHEMA_RELEASE_TOOLS_CHANGED');
  git(['diff','--quiet','--no-ext-diff',commit,'--',...toolPaths],'SCHEMA_RELEASE_TOOLS_CHANGED');
}

/** Re-emit the approved API source in memory so schema installation cannot use a stale build. */
export function committedApiBuild(repo,commit){
  assert(validCommit(commit),'SCHEMA_RELEASE_COMMIT_REQUIRED');
  const git=(args,reason)=>{const result=spawnSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
    assert(result.status===0,reason);return result.stdout;};
  const paths=['apps/api/src','apps/api/test','apps/api/tsconfig.json','tsconfig.base.json','package.json','package-lock.json','packages/content'];
  const verifySource=()=>git(['diff','--quiet','--no-ext-diff',commit,'--',...paths],'SCHEMA_RELEASE_API_SOURCE_CHANGED');
  verifySource();
  const tracked=new Set(git(['ls-tree','-r','-z','--name-only',commit,'--',...paths],'SCHEMA_RELEASE_COMMIT_INVALID').split('\0').filter(Boolean));
  for(const path of ['apps/api/tsconfig.json','tsconfig.base.json','package.json','package-lock.json'])
    assert(tracked.has(path),'SCHEMA_RELEASE_API_SOURCE_INCOMPLETE');
  const ts=createRequire(import.meta.url)('typescript'),apiRoot=join(repo,'apps/api'),configPath=join(apiRoot,'tsconfig.json');
  const configured=ts.readConfigFile(configPath,ts.sys.readFile);
  assert(!configured.error,'SCHEMA_RELEASE_API_CONFIG_INVALID');
  const config=ts.parseJsonConfigFileContent(configured.config,ts.sys,apiRoot,undefined,configPath);
  assert(config.errors.length===0&&config.fileNames.length>0&&!config.options.noEmit,'SCHEMA_RELEASE_API_CONFIG_INVALID');
  for(const file of config.fileNames){
    const name=relative(repo,file).replaceAll('\\','/');
    assert(tracked.has(name),'SCHEMA_RELEASE_API_SOURCE_UNTRACKED');
  }
  const sourceOutput=join(apiRoot,'dist','src'),output={};
  const program=ts.createProgram(config.fileNames,config.options);
  assert(ts.getPreEmitDiagnostics(program).length===0,'SCHEMA_RELEASE_API_BUILD_FAILED');
  const emitted=program.emit(undefined,(file,content,bom)=>{
    const name=relative(sourceOutput,file);
    if(!name.startsWith('..')&&!isAbsolute(name)&&name.endsWith('.js')){
      const normalized=name.replaceAll('\\','/');
      assert(!Object.hasOwn(output,normalized),'SCHEMA_RELEASE_API_BUILD_INVALID');
      output[normalized]=sha((bom?'\uFEFF':'')+content);
    }
  });
  assert(!emitted.emitSkipped&&Object.keys(output).length>0,'SCHEMA_RELEASE_API_BUILD_FAILED');
  verifySource();
  return output;
}
export function assertCommittedApiBuild(repo,commit,buildFiles){
  assert.equal(canonical(committedApiBuild(repo,commit)),canonical(buildFiles),'SCHEMA_RELEASE_API_BUILD_CHANGED');
}
function sealedTailSeedProof(baselineName,migrationHashes){
  if(baselineName!==TEST_SERVER_BASELINE)return null;
  const migrations=join(root,'apps/api/migrations'),initial=join(migrations,'initial',baselineName);
  const manifestBytes=readFileSync(join(initial,'manifest.json')),proofBytes=readFileSync(join(initial,'CANONICAL-SEED-PROOF.json'));
  assert.equal(sha(manifestBytes),migrationHashes[`initial/${baselineName}/manifest.json`],'SCHEMA_BASELINE_BINDING_INVALID');
  const journalBytes=readFileSync(join(migrations,'business/meta/_journal.json'));
  assert.equal(sha(journalBytes),migrationHashes['business/meta/_journal.json'],'INITIAL_TAIL_JOURNAL_CHANGED');
  return loadInitialTailSeedProof(migrations,JSON.parse(manifestBytes),proofBytes,journalBytes,migrationHashes);
}


/** Drizzle uses both pool.query and a checked-out client; both must stay on the fenced backend. */
export function guardedSchemaMigrationPool(pool,pid,verify){
  assert(typeof pool?.connect==='function'&&Number.isInteger(pid)&&pid>0&&typeof verify==='function','SCHEMA_FENCED_POOL_INVALID');
  class SchemaFencedPool {
    async connect(){
      const client=await pool.connect();
      try{assert.equal(client.processID,pid,'SCHEMA_FENCE_SESSION_CHANGED');assert.equal(client.getTransactionStatus?.(),'I','SCHEMA_FENCE_SESSION_NOT_IDLE');await verify(client);}
      catch(error){client.release(true);throw error;}
      const query=client.query.bind(client);
      return new Proxy(client,{get(target,key){
        if(key==='query')return async (...args)=>{
          const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
          assert(typeof sql==='string','SCHEMA_FENCE_QUERY_INVALID');
          const rollback=/^\s*rollback\s*;?\s*$/i.test(sql),commit=/^\s*commit\s*;?\s*$/i.test(sql);
          if(!rollback&&(target.getTransactionStatus?.()==='I'||commit))await verify(target);
          const result=await query(...args);
          if(commit)assert.equal(result?.command,'COMMIT','SCHEMA_COMMIT_ACK_NOT_CONFIRMED');
          if(rollback)assert.equal(result?.command,'ROLLBACK','SCHEMA_ROLLBACK_ACK_NOT_CONFIRMED');
          return result;
        };
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
    }
    async query(...args){
      const client=await this.connect();let discard=false;
      try{const result=await client.query(...args);assert.equal(client.getTransactionStatus?.(),'I','SCHEMA_POOL_QUERY_LEFT_TRANSACTION_OPEN');return result;}
      catch(error){discard=true;throw error;}finally{client.release(discard?true:undefined);}
    }
  }
  return new SchemaFencedPool();
}

export function schemaInitialBaseline(request){
  if(request?.initialBaseline===undefined){assert(request?.initialBaselineManifestSha256===undefined,'SCHEMA_BASELINE_BINDING_INVALID');return LEGACY_BASELINE;}
  assert([LEGACY_BASELINE,TEST_SERVER_BASELINE].includes(request.initialBaseline)&&hex(request.initialBaselineManifestSha256),'SCHEMA_BASELINE_BINDING_INVALID');
  return request.initialBaseline;
}
export function assertSchemaBaselineHistory(history,baseline,last){
  assert(Array.isArray(history)&&history.length>0&&baseline?.profile==='PRODUCTION'&&hex(baseline.migrationHash)
    &&history[0]?.hash===baseline.migrationHash&&history[0]?.createdAt===String(baseline.when)
    &&history.at(-1)?.createdAt===String(last.when),'SCHEMA_BASELINE_HISTORY_MISMATCH');
}
/** Read-only proof for the new empty database; no existing operational policy is changed. */
export async function assertInitialDatabaseReadback(client,baseline,seedProof,tailSeeds){
  assertCanonicalSeedProof(seedProof,baseline.sourceChain);
  const expected=new Map((baseline.seedCounts??[]).map(row=>[row.table,row.count]));
  assert(expected.size===INITIAL_SEED_TABLES.size&&[...INITIAL_SEED_TABLES].every(name=>Number.isSafeInteger(expected.get(name))), 'SCHEMA_SEED_MANIFEST_INVALID');
  const schemas=['zzsh_iam','zzsh_auth_user','zzsh_auth_admin','zzsh_supply','zzsh_content','zzsh_order','zzsh_credit'];
  if(tailSeeds)schemas.push('zzsh_docs');
  if(tailSeeds){
    const namespaces=(await client.query(`SELECT nspname name FROM pg_namespace WHERE left(nspname,5)='zzsh_' ORDER BY nspname`)).rows.map(row=>row.name);
    assert.deepEqual(namespaces,[...schemas,'zzsh_business_meta'].sort(),'SCHEMA_UNEXPECTED_BUSINESS_SCHEMA');
  }
  const tables=(await client.query(`SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY 1,2`,[schemas])).rows;
  const quote=name=>{assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),'SCHEMA_IDENTIFIER_INVALID');return '"'+name+'"'};
  const seedTables=tailSeeds?POST_TAIL_SEED_TABLES:INITIAL_SEED_TABLES;
  if(tailSeeds)assert.deepEqual(Object.keys(tailSeeds).sort(),[...seedTables].sort(),'INITIAL_TAIL_SEED_TABLES_MISMATCH');
  const seen=new Set();for(const table of tables){
    const name=table.schema+'.'+table.name,n=(await client.query(`SELECT count(*)::int n FROM ${quote(table.schema)}.${quote(table.name)}`)).rows[0].n;
    if(seedTables.has(name)){
      assert.equal(n,tailSeeds?tailSeeds[name].count:expected.get(name),'SCHEMA_SEED_COUNT_DRIFT:'+name);
      if(tailSeeds){const rows=(await client.query(`SELECT to_jsonb(t)-ARRAY['created_at','updated_at'] AS row FROM ${quote(table.schema)}.${quote(table.name)} t`)).rows.map(row=>row.row);
        assert.equal(initialSeedRowsDigest(rows),tailSeeds[name].sha256,'SCHEMA_SEED_ROWS_DRIFT:'+name);}
      seen.add(name);
    }
    else assert.equal(n,0,'SCHEMA_UNEXPECTED_INITIAL_BUSINESS_ROWS:'+name);
  }
  assert.equal(seen.size,seedTables.size,'SCHEMA_SEED_TABLE_MISSING');
  if(!tailSeeds)for(const name of CANONICAL_AUTHORIZATION_TABLES){const [schema,table]=name.split('.');
    const rows=(await client.query(`SELECT to_jsonb(t)-ARRAY['created_at','updated_at'] AS row FROM ${quote(schema)}.${quote(table)} t`)).rows.map(row=>row.row);
    assertCanonicalSeedRows(seedProof,name,rows);
  }
  const singletons=[
    ['zzsh_supply.profile_avatar_policy','SELECT singleton,requires_review,revision::text,updated_by_admin_id FROM zzsh_supply.profile_avatar_policy'],
    ['zzsh_order.settlement_refund_policy','SELECT singleton,normal_days,early_days,revision::text,updated_by_admin_id FROM zzsh_order.settlement_refund_policy'],
    ['zzsh_order.legacy_duty_finance_contract','SELECT singleton,contract_version,enabled,approval_ref,approval_digest FROM zzsh_order.legacy_duty_finance_contract'],
  ];
  if(!tailSeeds)for(const [name,query] of singletons)assertInitialSingleton(name,(await client.query(query)).rows,true);
  const obsolete=(await client.query(`SELECT to_regclass('zzsh_order.legacy_owner_guarantee_observation') IS NULL AS observation_absent,
    to_regclass('zzsh_order.legacy_owner_guarantee_coverage') IS NULL AS coverage_absent`)).rows[0];
  assert(obsolete?.observation_absent===true&&obsolete?.coverage_absent===true,'SCHEMA_RETIRED_LEGACY_DEPOSIT_PRESENT');
  const comments=(await client.query(`SELECT CASE WHEN a.attname IS NULL THEN obj_description(c.oid,'pg_class') ELSE col_description(c.oid,a.attnum) END description
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL
    (SELECT NULL::name attname,0 attnum UNION ALL SELECT attname,attnum FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped) a
    WHERE c.relkind IN ('r','p') AND (n.nspname=ANY($1::text[]) OR (n.nspname='zzsh_business_meta' AND c.relname='migrations'))`,[schemas])).rows;
  assert(comments.length>0&&comments.every(row=>/\p{Script=Han}/u.test(row.description??'')),'SCHEMA_CHINESE_COMMENTS_INCOMPLETE');
  return {status:'INITIAL_SEEDS_AND_COMMENTS_VERIFIED',seedTables:seen.size,businessTables:tables.length,commentedObjects:comments.length,otherBusinessRows:0};
}

export function validateR07SchemaRequest(request,registered){
  const baseline=schemaInitialBaseline(request);
  assert(registered?.migrationProfile!==NEXT_MIGRATION_PROFILE || baseline===TEST_SERVER_BASELINE,'SCHEMA_NEXT_BASELINE_REQUIRED');
  if(registered?.migrationProfile===NEXT_MIGRATION_PROFILE){
    assertSchemaToolBinding(request.schemaTools,request.schemaTools);
    assert(validCommit(request.releaseCommit),'SCHEMA_RELEASE_COMMIT_REQUIRED');
  }
  const t=request?.target,protectedData=registered?.protectedDataset;
  assert(request?.schema==='zzsh.round07-schema-install-request.v1'&&hex(request.datasetSha256)&&hex(request.migrationsDigest)&&hex(request.credentialsSha256)&&hex(request.registrySha256)
    && isRegisteredMigrationInstance(registered)&&registered.database==='zzsh_test_regression'
    && registered.marker==='zzsh:regression-test:v1'&&registered.owner==='zzsh'&&!registered.pendingReset
    && registered.migrationRoleOid&&registered.runtimeRoleOid&&registered.lockKey==='806006'&&registered.maintenanceDatabase==='postgres'
    && t?.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'&&t.oid===registered.oid&&t.nonce===registered.nonce
    && t.migrationRoleOid===registered.migrationRoleOid&&canonical(t.instance)===canonical(registered.instance)
    && (t.migrationProfile??null)===(registered.migrationProfile??null)
    && protectedData?.status==='ROUND07_BOOTSTRAP_RESERVED'&&protectedData.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'
    && protectedData.manifestSha256===request.datasetSha256&&protectedData.epoch?.oid===t.oid&&protectedData.epoch?.nonce===t.nonce,
  'SCHEMA_REGISTERED_TARGET_CHANGED');
}
export function assertR07RegistrationReceipt(receipt,registered){
  assert(receipt?.status===(registered.migrationProfile===NEXT_MIGRATION_PROFILE?'MIGRATION_TARGET_REGISTERED':'R07_TARGET_REGISTERED')&&receipt.oid===registered.oid&&receipt.nonce===registered.nonce
    &&canonical(receipt.instance)===canonical(registered.instance)&&receipt.roleReadback===true&&receipt.unlockAck===true&&receipt.maintenanceClosed===true,
  'SCHEMA_TARGET_REGISTRATION_UNCONFIRMED');
}

export function validateR07FinalJournal(journal,migrationFiles){
  const last=journal?.entries?.at(-1);
  assert(Number.isSafeInteger(last?.idx)&&last.idx>=161&&Number.isSafeInteger(last.when)&&last.when>0
    &&typeof last.tag==='string'&&new RegExp('^'+String(last.idx).padStart(4,'0')+'_[a-z0-9_]+$').test(last.tag)
    &&hex(migrationFiles?.['business/'+last.tag+'.sql']),'SCHEMA_JOURNAL_NOT_FINAL');
  return last;
}

async function main(){
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  assert(!(args.includes('--prepare')&&args.includes('--execute')),'ONE_SCHEMA_ACTION_REQUIRED');
  if(args.includes('--prepare')){
    const credentials=checkedPath(option('--credentials')),registered=loadRegisteredTarget(credentials),dataset=checkedPath(option('--dataset')),
      datasetBytes=readFileSync(join(dataset,'manifest.json')),datasetSha256=option('--dataset-sha'),api=buildPath(option('--api-dist')),
      secretPath=checkedSecret(option('--maintenance-secret')),out=checkedPath(option('--out'),true);
    const registrationPath=checkedPath(join(dirname(credentials),'receipt.json')),registrationBytes=readFileSync(registrationPath);
    assertR07RegistrationReceipt(JSON.parse(registrationBytes),registered);
    assert(!existsSync(out)&&hex(datasetSha256)&&sha(datasetBytes)===datasetSha256,'SCHEMA_PREPARATION_INPUT_CHANGED');
    const manifest=JSON.parse(datasetBytes);assert(manifest.status==='FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN'&&manifest.population?.mode==='SELECTED_BUSINESS_SCOPE','SCHEMA_DATASET_SCOPE_REQUIRED');
    const buildFiles=files(api,['.js']),sourceMigrations=files(join(root,'apps/api/migrations')),runtimeMigrations=files(resolve(api,'../../migrations'));
    assert(Object.keys(buildFiles).length>0&&canonical(sourceMigrations)===canonical(runtimeMigrations),'SCHEMA_BUILD_CHANGED');
    const selected=option('--initial-baseline');
    if(selected!==undefined)assert([LEGACY_BASELINE,TEST_SERVER_BASELINE].includes(selected),'SCHEMA_BASELINE_BINDING_INVALID');
    const tailSeed=registered.migrationProfile===NEXT_MIGRATION_PROFILE?sealedTailSeedProof(selected,sourceMigrations):null;
    const releaseCommit=option('--release-commit');
    if(tailSeed){assertApprovedMigrationRelease(root,releaseCommit,sourceMigrations);assertCommittedApiBuild(root,releaseCommit,buildFiles);}
    const request={schema:'zzsh.round07-schema-install-request.v1',credentials,credentialsSha256:sha(readFileSync(credentials)),registrySha256:sha(readFileSync(registered.sourceFile)),registrationReceipt:{path:registrationPath,sha256:sha(registrationBytes)},datasetPath:dataset,datasetSha256,apiDist:api,buildFiles,migrationsDigest:sha(canonical(sourceMigrations)),
      ...(selected===undefined?{}:{initialBaseline:selected,initialBaselineManifestSha256:sourceMigrations[`initial/${selected}/manifest.json`]}),
      ...(tailSeed?{initialTailSeedProofSha256:tailSeed.sha256,schemaTools:schemaToolHashes(),releaseCommit}:{}),
      maintenanceSecret:{path:secretPath,sha256:sha(readFileSync(secretPath))},target:{oid:registered.oid,nonce:registered.nonce,instance:registered.instance,migrationRoleOid:registered.migrationRoleOid,
        ...(registered.migrationProfile?{migrationProfile:registered.migrationProfile}:{}),bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED'}};
    validateR07SchemaRequest(request,registered);writePrivate(join(out,'request.json'),request);
    console.log(JSON.stringify({status:'R07_SCHEMA_REQUEST_SEALED_NOT_EXECUTED',request:join(out,'request.json'),requestSha256:sha(readFileSync(join(out,'request.json'))),connections:0,targetWrites:0}));return;
  }
  if(!args.includes('--execute')){console.log(JSON.stringify({status:'PLAN_ONLY',prepare:['--prepare','--credentials','--dataset','--dataset-sha','--api-dist','--maintenance-secret','--initial-baseline <explicit production baseline>','--release-commit <reviewed commit for NEXT>','--out'],execute:['--execute','--request','--request-sha','--out'],connections:0,targetWrites:0}));return;}
  assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
  const request=pinned({path:option('--request'),sha256:option('--request-sha')}),out=checkedPath(option('--out'),true);
  assert(!existsSync(out),'SCHEMA_OUTPUT_EXISTS');const credentialsPath=checkedPath(request.credentials),registered=loadRegisteredTarget(credentialsPath);
  validateR07SchemaRequest(request,registered);
  if(registered.migrationProfile===NEXT_MIGRATION_PROFILE)assertSchemaToolBinding(request.schemaTools,schemaToolHashes());
  assert(sha(readFileSync(credentialsPath))===request.credentialsSha256&&sha(readFileSync(registered.sourceFile))===request.registrySha256,'SCHEMA_RESOURCE_FILE_CHANGED');
  assertR07RegistrationReceipt(pinned(request.registrationReceipt),registered);
  const credentials=JSON.parse(readFileSync(credentialsPath));
  for(const kind of ['migration','runtime'])assert(credentials[kind]?.name===registered[kind+'Role']&&credentials[kind]?.oid===registered[kind+'RoleOid'],'SCHEMA_CREDENTIAL_ROLE_CHANGED');
  const datasetPath=checkedPath(request.datasetPath);assert(sha(readFileSync(join(datasetPath,'manifest.json')))===request.datasetSha256,'SCHEMA_DATASET_CHANGED');
  const api=buildPath(request.apiDist),build=files(api,['.js']);
  assert(Object.keys(build).length>0&&canonical(build)===canonical(request.buildFiles),'SCHEMA_BUILD_CHANGED');
  const sourceMigrations=files(join(root,'apps/api/migrations')),runtimeMigrations=files(resolve(api,'../../migrations'));
  assert(sha(canonical(sourceMigrations))===request.migrationsDigest&&canonical(sourceMigrations)===canonical(runtimeMigrations),'SCHEMA_MIGRATION_FILES_CHANGED');
  const initialBaseline=schemaInitialBaseline(request),initialManifestPath=join(root,'apps/api/migrations/initial',initialBaseline,'manifest.json');
  if(registered.migrationProfile===NEXT_MIGRATION_PROFILE){
    assertApprovedMigrationRelease(root,request.releaseCommit,sourceMigrations);assertCommittedApiBuild(root,request.releaseCommit,build);
  }
  const initialManifestBytes=readFileSync(initialManifestPath),initialManifest=JSON.parse(initialManifestBytes);
  assert(initialManifest.baseline===initialBaseline&&initialManifest.profile==='PRODUCTION'
    &&sourceMigrations[`initial/${initialBaseline}/manifest.json`]===sha(initialManifestBytes)
    &&(request.initialBaseline===undefined||request.initialBaselineManifestSha256===sha(initialManifestBytes)),'SCHEMA_BASELINE_BINDING_INVALID');
  function verifyBoundFiles(){
    if(registered.migrationProfile===NEXT_MIGRATION_PROFILE){
      assertSchemaToolBinding(request.schemaTools,schemaToolHashes());
      assertApprovedMigrationRelease(root,request.releaseCommit,sourceMigrations);
    }
    assert(sha(readFileSync(credentialsPath))===request.credentialsSha256&&sha(readFileSync(registered.sourceFile))===request.registrySha256
      &&sha(readFileSync(join(datasetPath,'manifest.json')))===request.datasetSha256&&canonical(files(api,['.js']))===canonical(build)
      &&canonical(files(join(root,'apps/api/migrations')))===canonical(sourceMigrations)&&canonical(files(resolve(api,'../../migrations')))===canonical(sourceMigrations),
    'SCHEMA_BOUND_FILES_CHANGED');
  }
  const journalBytes=readFileSync(join(root,'apps/api/migrations/business/meta/_journal.json')),journal=JSON.parse(journalBytes),last=journal.entries?.at(-1);
  validateR07FinalJournal(journal,sourceMigrations);
  const tailSeed=registered.migrationProfile===NEXT_MIGRATION_PROFILE?sealedTailSeedProof(initialBaseline,sourceMigrations):null;
  if(tailSeed)assert.equal(request.initialTailSeedProofSha256,tailSeed.sha256,'SCHEMA_TAIL_SEED_PROOF_CHANGED');
  const secretFile=checkedSecret(request.maintenanceSecret?.path),secret=readFileSync(secretFile);
  assert(hex(request.maintenanceSecret.sha256)&&sha(secret)===request.maintenanceSecret.sha256,'SCHEMA_MAINTENANCE_SECRET_CHANGED');
  const require=createRequire(join(root,'apps/api/package.json')),{Client,Pool}=require('pg'),modulePath=join(api,'database/business-migrations.js');
  assert(build['database/business-migrations.js'],'SCHEMA_BUILD_MODULE_MISSING');
  const {runBusinessMigrations,assertBusinessMigrationPrefix}=require(modulePath),{assertBusinessMigrationIdentity}=require(join(api,'database/business.js'));
  assert(build['database/business.js']&&build['supply/content-hash.js'],'SCHEMA_BUILD_MODULE_MISSING');
  const {canonicalize}=require(join(api,'supply/content-hash.js'));
  const common={connectionTimeoutMillis:3000,statement_timeout:120000,lock_timeout:1000},maintenance=new Client(maintenanceConnection(registered,{...common,user:'zzsh',password:secret.toString('utf8').trim(),applicationName:'r07-schema-lock'})),
    pool=new Pool(targetConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password,max:1,idleTimeoutMillis:0,applicationName:'r07-schema-migration'}));
  const result={status:'STARTED',...request.target,initialBaseline,initialBaselineManifestSha256:sha(initialManifestBytes),journalSha256:sha(journalBytes),finalOrdinal:last.idx,
    ...(tailSeed?{releaseCommit:request.releaseCommit,initialTailSeedProofSha256:tailSeed.sha256}:{}),startedAt:new Date().toISOString(),targetWrites:0};
  writePrivate(join(out,'receipt.json'),result);const save=()=>writeLoadCheckpoint(join(out,'receipt.json'),result);
  let held=false,client,runtime,begin=false,migrationStarted=false,fenceEpoch,fencePid,fenceAcquired=false,workPool=pool,maintenanceError,poolError;
  maintenance.on('error',error=>{maintenanceError=error;});pool.on('error',error=>{poolError=error;});
  try{
    await maintenance.connect();held=(await maintenance.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(held,'SCHEMA_RESOURCE_BUSY');
    if(registered.migrationProfile===NEXT_MIGRATION_PROFILE){
      fenceEpoch=await captureMaintenanceLockEpoch(maintenance,registered);const lease=await pool.connect();let discard=false;
      try{assertLiveTarget(registered,(await lease.query(targetIdentityQuery())).rows[0]);await acquireMigrationSessionFence(lease,registered,fenceEpoch);
        fenceAcquired=true;fencePid=lease.processID;assert(Number.isInteger(fencePid)&&fencePid>0,'SCHEMA_FENCE_SESSION_UNAVAILABLE');}
      catch(error){discard=true;throw error;}finally{lease.release(discard?true:undefined);}
      workPool=guardedSchemaMigrationPool(pool,fencePid,async target=>{assert(!maintenanceError&&!poolError,'SCHEMA_MAINTENANCE_CONNECTION_LOST');
        await assertMigrationFenceHeld(target,registered,fenceEpoch);assert(!maintenanceError&&!poolError,'SCHEMA_MAINTENANCE_CONNECTION_LOST');});
      result.targetFence='HELD_ACROSS_SCHEMA_AND_ACL';save();
    }
    client=await workPool.connect();await client.query('BEGIN READ ONLY');begin=true;
    const identity=(await client.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,identity);
    const empty=(await client.query("SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'zzsh\\_%' ESCAPE '\\'")).rows[0]?.count;
    assert.equal(empty,0,'SCHEMA_TARGET_NOT_EMPTY');assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');begin=false;client.release();client=null;
    await assertBusinessMigrationIdentity(workPool,{database:{name:registered.database,user:registered.migrationRole,runtimeUser:registered.runtimeRole}});
    verifyBoundFiles();result.status='MIGRATION_INTENT';save();migrationStarted=true;
    await runBusinessMigrations(workPool,{runtimeUser:registered.runtimeRole,initialInstall:true,initialBaseline});
    result.commitAck=true;result.migrationAck=true;result.targetWrites=1;result.status='MIGRATION_ACK_READBACK_PENDING';save();
    client=await workPool.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begin=true;
    assertLiveTarget(registered,(await client.query(targetIdentityQuery())).rows[0]);await assertBusinessMigrationPrefix(client);
    const history=(await client.query('SELECT hash,created_at::text AS "createdAt" FROM zzsh_business_meta.migrations ORDER BY id')).rows;
    assertSchemaBaselineHistory(history,initialManifest,last);
    if(initialBaseline===TEST_SERVER_BASELINE){
      const doc=(initialManifest.documents??[]).find(row=>row.file==='CANONICAL-SEED-PROOF.json');
      const proofBytes=readFileSync(join(dirname(initialManifestPath),'CANONICAL-SEED-PROOF.json'));
      assert(doc&&sha(proofBytes)===doc.sha256,'SCHEMA_SEED_PROOF_CHANGED');
      result.initialSeedReadback=await assertInitialDatabaseReadback(client,initialManifest,JSON.parse(proofBytes),tailSeed?.tables);
    }
    result.hashes=history.map(row=>row.hash);result.historySha256=sha(canonicalize(history));
    assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');begin=false;result.readbackRollbackAck=true;client.release();client=null;
    runtime=new Client(targetConnection(registered,{...common,user:credentials.runtime.name,password:credentials.runtime.password,applicationName:'r07-schema-runtime-proof'}));
    await runtime.connect();await runtime.query('BEGIN READ ONLY');
    assertLiveTarget(registered,(await runtime.query(targetIdentityQuery())).rows[0],'runtime');
    const acl=(await runtime.query("SELECT has_function_privilege(current_user,'pg_catalog.pg_control_system()','EXECUTE') AS control_read,has_schema_privilege(current_user,'zzsh_supply','USAGE') AS supply_usage,has_schema_privilege(current_user,'zzsh_supply','CREATE') AS supply_create")).rows[0];
    assert(acl?.control_read===true&&acl?.supply_usage===true&&acl?.supply_create===false,'SCHEMA_RUNTIME_ACL_INVALID');
    assert.equal((await runtime.query('ROLLBACK')).command,'ROLLBACK');await runtime.end();runtime=null;result.runtimeAclReadback=true;verifyBoundFiles();
    if(fenceAcquired){const proof=await workPool.connect();proof.release();}
  }catch(error){
    result.status=migrationStarted&&!result.commitAck?'MIGRATION_OR_ACL_OUTCOME_UNKNOWN':'SCHEMA_STOPPED';
    result.error=/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:error?.code??error?.name;process.exitCode=1;
  }finally{
    if(client){try{if(begin)result.rollbackAck=(await client.query('ROLLBACK')).command==='ROLLBACK';}catch{result.rollbackAck=false;}client.release(begin&&result.rollbackAck!==true?true:undefined);}
    if(runtime){try{await runtime.end();}catch{process.exitCode=1;}}
    if(fenceAcquired){let lease,discard=false;try{lease=await pool.connect();assert.equal(lease.processID,fencePid,'SCHEMA_FENCE_SESSION_CHANGED');await releaseMigrationSessionFence(lease,registered);result.targetFenceReleased=true;}
      catch{result.targetFenceReleased=false;discard=true;process.exitCode=1;}finally{if(lease)lease.release(discard?true:undefined);}}
    try{await pool.end();result.readbackClientClosed=true;}catch{result.readbackClientClosed=false;process.exitCode=1;}
    try{if(held)result.unlockAck=(await maintenance.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{result.unlockAck=false;process.exitCode=1;}
    try{await maintenance.end();result.maintenanceClosed=true;}catch{result.maintenanceClosed=false;process.exitCode=1;}
    if(result.commitAck&&result.readbackRollbackAck&&result.readbackClientClosed&&result.runtimeAclReadback&&result.unlockAck&&result.maintenanceClosed
      &&(registered.migrationProfile!==NEXT_MIGRATION_PROFILE||result.targetFence==='HELD_ACROSS_SCHEMA_AND_ACL'&&result.targetFenceReleased===true)&&process.exitCode!==1)result.status='CLEAN_SCHEMA_INSTALLED';
    result.finishedAt=new Date().toISOString();save();secret.fill(0);
  }
  console.log(JSON.stringify({status:result.status,receipt:join(out,'receipt.json'),journalSha256:result.journalSha256,historySha256:result.historySha256,finalOrdinal:result.finalOrdinal}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'SCHEMA_STOPPED_BEFORE_OR_AFTER_INTENT',code:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
