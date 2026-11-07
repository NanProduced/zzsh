import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { writeLoadCheckpoint } from './local-load-checkpoint.mjs';
import { loadRegisteredTarget, targetIdentityQuery, assertLiveTarget } from './local-target-registry.mjs';
import { inspectRoundDependencyLayout, assertRoundDependencyProof } from './local-round-dependencies.mjs';
import { assertQualificationRecoveryPreimage } from './local-distribution-qualification-runner.mjs';
import { reviewedDistributionActor } from './local-distribution-qualification-plan.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=value=>createHash('sha256').update(value).digest('hex'),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
function privatePath(value,output=false){
 assert(typeof value==='string'&&isAbsolute(value),'UPGRADE_PRIVATE_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'UPGRADE_PRIVATE_PATH_REQUIRED');
 for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'UPGRADE_LINK_REFUSED');return p;
}
function pinned(ref){const path=privatePath(ref?.path),bytes=readFileSync(path);assert(hex(ref.sha256)&&sha(bytes)===ref.sha256,'UPGRADE_INPUT_CHANGED');return JSON.parse(bytes);}
function pin(path){path=privatePath(path);return{path,sha256:sha(readFileSync(path))};}
function files(dir,prefix=''){return Object.fromEntries(readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
 assert(!e.isSymbolicLink(),'UPGRADE_LINK_REFUSED');const name=prefix+e.name,p=join(dir,e.name);
 return e.isDirectory()?Object.entries(files(p,name+'/')):e.isFile()?[[name,sha(readFileSync(p))]]:[];
}));}
function sourceBody(sql,start){const from=sql.indexOf(start);assert(from>=0,'UPGRADE_FUNCTION_SOURCE_MISSING');const text=sql.slice(from),a=text.indexOf('AS $$'),b=text.indexOf('END $$;',a);assert(a>=0&&b>a,'UPGRADE_FUNCTION_SOURCE_MISSING');return text.slice(a+5,b+4);}
function migrationSources(){
 const base=join(root,'apps/api/migrations'),tree=files(base),business=join(base,'business'),journal=JSON.parse(readFileSync(join(business,'meta/_journal.json'))),last=journal.entries?.at(-1),prior=journal.entries?.at(-2);
 assert(last?.idx===161&&last.tag==='0161_distribution_relation_guard_indexed'&&prior?.idx===160,'UPGRADE_JOURNAL_NOT_EXACT');
 const sql=readFileSync(join(business,last.tag+'.sql'),'utf8'),old=readFileSync(join(business,'0061_distribution_policy_and_relations.sql'),'utf8');
 return{base,business,tree,digest:sha(canonical(tree)),journalSha256:tree['business/meta/_journal.json'],migrationSha256:sha(sql),when:last.when,previousWhen:prior.when,
  previousFunctionSha256:sha(sourceBody(old,'CREATE FUNCTION zzsh_order.check_distribution_relation_knowledge()')),
  expectedFunctionSha256:sha(sourceBody(sql,'CREATE OR REPLACE FUNCTION zzsh_order.check_distribution_relation_knowledge()'))};
}
export function validateUpgradeEvidence({round,previousPlan,previousInput,previousAuthority,failure,inspection,synthetic,refs,sources}){
 const target=round.target,fail='UPGRADE_EVIDENCE_CHANGED',same=(a,b)=>canonical(a)===canonical(b);
 assert(target?.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'&&previousInput.target?.oid===target.oid&&previousInput.target.nonce===target.nonce&&same(previousInput.target.instance,target.instance)
  &&previousInput.dataset?.sha256===round.dataset?.sha256&&previousInput.source?.sha256===round.source?.sha256&&previousPlan.datasetSha256===round.dataset?.sha256&&previousPlan.sourceDigest===round.source?.sha256
  &&previousPlan.inputSha256===refs.previousInput.sha256&&previousAuthority.inputSha256===refs.previousInput.sha256&&previousAuthority.planSha256===refs.previousPlan.sha256
  &&failure?.status==='STOPPED'&&failure.error?.code==='57014'&&failure.transaction?.status==='ROLLBACK_ACKNOWLEDGED'&&failure.rollbackAck===true&&failure.lockReleased===true&&failure.clientsClosed===true&&failure.financialWrites===0
  &&failure.inputSha256===refs.previousInput.sha256&&failure.target?.oid===target.oid&&failure.target.nonce===target.nonce&&same(failure.target.instance,target.instance)
  &&failure.batches?.length===previousPlan.batches?.length&&failure.batches.length===175&&failure.batches.every((row,i)=>row.status==='ACK_IN_OPEN_TRANSACTION'&&row.bodyDigest===previousPlan.batches[i].bodyDigest),fail);
 assert(inspection?.schema==='zzsh.r07-qualification-constraint-analysis.v1'&&inspection.status==='READ_ONLY_CONSTRAINT_ANALYSIS_COMPLETE'
  &&inspection.previous?.plan===refs.previousPlan.sha256&&inspection.previous.input===refs.previousInput.sha256&&inspection.previous.authority===refs.previousAuthority.sha256&&inspection.previous.failure===refs.failure.sha256
  &&inspection.target?.oid===target.oid&&inspection.target.nonce===target.nonce&&same(inspection.target.instance,target.instance)
  &&inspection.preimage?.counts?.participants===174846&&inspection.preimage.counts.receipts===0&&inspection.preimage.counts.audits===0&&inspection.preimage.counts.policy_heads===1
  &&['accepted','ineligible','unresolved'].every(k=>inspection.preimage.mismatches?.[k]===0)&&inspection.rollbackAck===true&&inspection.clientClosed===true&&inspection.targetWrites===0,fail);
 assert(synthetic?.status==='SYNTHETIC_TRIGGER_PROOF_PASS'&&synthetic.syntheticOnly===true&&synthetic.migrationSha256===sources.migrationSha256&&synthetic.migrationReplay===2
  &&['replica-only-participant-guard','replica-only-relation-guard','replica-session','incomplete-trigger-events','mismatched-inviter','mismatched-leader'].every(x=>synthetic.cases?.includes(x)),fail);
}
export function validateUpgradeAuthority(authority,planSha256,target,now=Date.now()){
 const start=Date.parse(authority?.notBefore),end=Date.parse(authority?.expiresAt);
 assert(authority?.schema==='zzsh.r07-0161-upgrade-authority.v1'&&authority.approvedBy==='Root'&&authority.status==='APPROVED'&&authority.planSha256===planSha256
  &&canonical(authority.target)===canonical(target)&&authority.operation==='APPLY_0161_ONLY'&&authority.maxMigrations===1&&authority.lock==='806006'&&authority.allowFinancialWrites===false
  &&/^[A-Za-z0-9._:-]{1,179}$/.test(authority.approvalRef??'')&&/^[A-Za-z0-9._:-]{1,179}$/.test(authority.attempt??'')
  &&Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end&&end>start&&end-start<=20*60000,'UPGRADE_AUTHORITY_CHANGED_OR_EXPIRED');
}

async function main(){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 const modes=['--prepare','--sign','--execute'].filter(x=>args.includes(x));if(!modes.length){console.log(JSON.stringify({status:'PLAN_ONLY',connections:0,targetWrites:0}));return;}
 assert.equal(modes.length,1,'ONE_UPGRADE_ACTION_REQUIRED');const mode=modes[0],out=privatePath(option('--out'),true);assert(!existsSync(out),'UPGRADE_OUTPUT_EXISTS');
 const refs=Object.fromEntries(['round','previous-plan','previous-input','previous-authority','failure','inspection','synthetic'].map(name=>[name.replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),{path:privatePath(option('--'+name)),sha256:option('--'+name+'-sha')}]));
 const data=Object.fromEntries(Object.entries(refs).map(([k,v])=>[k,pinned(v)])),sources=migrationSources(),toolSha256=sha(readFileSync(fileURLToPath(import.meta.url)));validateUpgradeEvidence({...data,refs,sources});
 const target=data.round.target,credentialsPath=privatePath(data.round.credentials),registered=loadRegisteredTarget(credentialsPath),creds=JSON.parse(readFileSync(credentialsPath));
 assert(registered.port===55433&&registered.oid===target.oid&&registered.nonce===target.nonce&&canonical(registered.instance)===canonical(target.instance)
  &&registered.database==='zzsh_test_regression'&&registered.lockKey==='806006'&&creds.migration.name===registered.migrationRole&&creds.migration.oid===registered.migrationRoleOid,'UPGRADE_TARGET_CHANGED');
 const binding=data.round.dependencyBinding,proof=pinned(binding.proof),layout=inspectRoundDependencyLayout({apiDist:data.round.apiDist,bundlePath:data.round.bootstrapEvidence.bundle.path,bundleSha256:data.round.bootstrapEvidence.bundle.sha256,buildManifestPath:binding.buildManifest.path,buildManifestSha256:binding.buildManifest.sha256,sourceSnapshot:binding.sourceSnapshot,sourceManifestPath:binding.sourceManifest.path,sourceManifestSha256:binding.sourceManifest.sha256});
 assertRoundDependencyProof(proof,layout);process.env.NODE_PATH=layout.moduleDirs.join(delimiter);Module._initPaths();
 const require=createRequire(join(data.round.apiDist,'app.js')),{Client}=require('pg'),{prepareBusinessInitial}=require(join(data.round.apiDist,'database/business-initial.js')),
  {assertBusinessMigrationPrefix}=require(join(data.round.apiDist,'database/business-migrations.js')),{readMigrationFiles}=require('drizzle-orm/migrator'),{drizzle}=require('drizzle-orm/node-postgres'),{migrate}=require('drizzle-orm/node-postgres/migrator');
 const sourceBefore=canonical(sources.tree),recheck=()=>{assert(canonical(migrationSources().tree)===sourceBefore,'UPGRADE_MIGRATIONS_CHANGED');assertRoundDependencyProof(proof,layout);};
 const prepared=prepareBusinessInitial(sources.business,join(sources.base,'initial/release_production_0153'));let connection,lock,locked=false;
 const result={schema:'zzsh.r07-0161-upgrade-receipt.v1',status:'STARTED',mode,startedAt:new Date().toISOString(),target:{oid:target.oid,nonce:target.nonce,instance:target.instance},financialWrites:0,automaticRetry:false};
 try{
  const local=readMigrationFiles({migrationsFolder:prepared.folder});assert(local.at(-1)?.folderMillis===sources.when&&local.at(-1)?.hash===sources.migrationSha256,'UPGRADE_MIGRATION_HASH_CHANGED');
  const validateLive=async(c,expectedOrdinal)=>{
   const identity=(await c.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,identity,'migration');
   await assertBusinessMigrationPrefix(c,prepared.folder);const history=(await c.query('SELECT hash,created_at::text AS "createdAt" FROM zzsh_business_meta.migrations ORDER BY id')).rows;
   const expected=expectedOrdinal===160?local.slice(0,-1):local;assert(history.length===expected.length&&history.at(-1)?.createdAt===String(expectedOrdinal===160?sources.previousWhen:sources.when),'UPGRADE_HISTORY_CHANGED');
   const row=(await c.query("SELECT prosrc,pg_get_userbyid(proowner) AS owner,prosecdef,proconfig,current_setting('session_replication_role') AS role FROM pg_proc WHERE oid=to_regprocedure('zzsh_order.check_distribution_relation_knowledge()')")).rows[0];
   const expectedFunction=expectedOrdinal===160?sources.previousFunctionSha256:sources.expectedFunctionSha256;
   assert(row&&sha(row.prosrc)===expectedFunction&&row.owner===registered.migrationRole&&row.prosecdef===false&&row.proconfig===null&&['origin','local'].includes(row.role),'UPGRADE_FUNCTION_CHANGED');
   const triggers=(await c.query("SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgdeferrable,t.tginitdeferred,t.tgfoid=to_regprocedure('zzsh_order.check_distribution_relation_knowledge()') AS same_function FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='zzsh_order' AND t.tgname IN ('distribution_participant_knowledge_guard','invitation_relation_knowledge_guard') AND NOT t.tgisinternal ORDER BY t.tgname")).rows;
   assert(triggers.length===2&&triggers.every(t=>['O','A'].includes(t.tgenabled)&&t.tgdeferrable&&t.tginitdeferred&&t.same_function
    &&(t.tgname==='distribution_participant_knowledge_guard'?t.relname==='distribution_participant'&&t.tgtype===21:t.relname==='invitation_relation'&&t.tgtype===5)),'UPGRADE_TRIGGER_CHANGED');
   const actor=reviewedDistributionActor(pinned(data.previousInput.actor),target,data.previousAuthority.actor),preimage=await assertQualificationRecoveryPreimage(c,data.previousPlan,actor);
   return{historyCount:history.length,historySha256:sha(canonical(history)),functionSha256:sha(row.prosrc),preimage};
  };
  const base={host:registered.host,port:registered.port,user:creds.migration.name,password:creds.migration.password,statement_timeout:30000,lock_timeout:1000,connectionTimeoutMillis:3000};
  if(mode==='--sign'){
   const planRef={path:privatePath(option('--plan')),sha256:option('--plan-sha')},plan=pinned(planRef),now=Date.now(),notBefore=option('--not-before'),expiresAt=option('--expires-at');
   assert(plan.schema==='zzsh.r07-0161-upgrade-plan.v1'&&plan.toolSha256===toolSha256&&canonical(plan.refs)===canonical(refs)&&plan.migrationsDigest===sources.digest&&plan.previousFunctionSha256===sources.previousFunctionSha256&&plan.migrationSha256===sources.migrationSha256,'UPGRADE_PLAN_CHANGED');
   const authority={schema:'zzsh.r07-0161-upgrade-authority.v1',approvedBy:'Root',status:'APPROVED',planSha256:planRef.sha256,target:plan.target,operation:'APPLY_0161_ONLY',maxMigrations:1,lock:'806006',allowFinancialWrites:false,notBefore,expiresAt,approvalRef:option('--review-ref'),attempt:option('--attempt')};
   assert(/^[A-Za-z0-9._:-]{1,179}$/.test(authority.approvalRef??'')&&/^[A-Za-z0-9._:-]{1,179}$/.test(authority.attempt??''),'UPGRADE_REVIEW_REQUIRED');validateUpgradeAuthority(authority,planRef.sha256,plan.target,now);
   writePrivate(join(out,'authority.json'),authority);console.log(JSON.stringify({status:'UPGRADE_AUTHORITY_SEALED',sha256:sha(readFileSync(join(out,'authority.json'))),notBefore,expiresAt,operation:authority.operation}));return;
  }
  connection=new Client({...base,database:registered.database,application_name:'r07-0161-upgrade'});await connection.connect();
  if(mode==='--prepare'){
   await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const before=await validateLive(connection,160);assert.equal((await connection.query('ROLLBACK')).command,'ROLLBACK');
   const plan={schema:'zzsh.r07-0161-upgrade-plan.v1',status:'READ_ONLY_PREPARED',toolSha256,target:{oid:target.oid,nonce:target.nonce,instance:target.instance,database:registered.database,marker:registered.marker,migrationRoleOid:registered.migrationRoleOid},refs,migrationsDigest:sources.digest,journalSha256:sources.journalSha256,migrationSha256:sources.migrationSha256,previousFunctionSha256:sources.previousFunctionSha256,expectedFunctionSha256:sources.expectedFunctionSha256,when:sources.when,before,readOnlyRollbackAck:true,connectionsClosed:true,targetWrites:0};
   await connection.end();connection=null;recheck();writePrivate(join(out,'plan.json'),plan);console.log(JSON.stringify({status:plan.status,planSha256:sha(readFileSync(join(out,'plan.json'))),migrationSha256:plan.migrationSha256,targetWrites:0}));return;
  }
  const planRef={path:privatePath(option('--plan')),sha256:option('--plan-sha')},plan=pinned(planRef),authority=pinned({path:option('--authority'),sha256:option('--authority-sha')});
  assert(plan.schema==='zzsh.r07-0161-upgrade-plan.v1'&&plan.toolSha256===toolSha256&&canonical(plan.refs)===canonical(refs)&&plan.migrationsDigest===sources.digest&&plan.migrationSha256===sources.migrationSha256&&plan.readOnlyRollbackAck===true&&plan.connectionsClosed===true&&plan.targetWrites===0
    &&canonical(plan.target)===canonical({oid:target.oid,nonce:target.nonce,instance:target.instance,database:registered.database,marker:registered.marker,migrationRoleOid:registered.migrationRoleOid}),'UPGRADE_PLAN_CHANGED');
  validateUpgradeAuthority(authority,planRef.sha256,plan.target);writePrivate(join(out,'receipt.json'),result);const save=()=>writeLoadCheckpoint(join(out,'receipt.json'),result);
  lock=new Client({...base,database:'postgres',application_name:'r07-0161-upgrade-lock'});await lock.connect();locked=(await lock.query('SELECT pg_try_advisory_lock(806006) AS ok')).rows[0]?.ok===true;assert(locked,'UPGRADE_LOCK_BUSY');
  await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const before=await validateLive(connection,160);assert.equal(canonical(before),canonical(plan.before),'UPGRADE_PREIMAGE_CHANGED');assert.equal((await connection.query('ROLLBACK')).command,'ROLLBACK');
  recheck();validateUpgradeAuthority(authority,planRef.sha256,plan.target);result.status='MIGRATION_INTENT';save();
  const query=connection.query.bind(connection);let armed=true;
  connection.query=async(...params)=>{const text=typeof params[0]==='string'?params[0]:params[0]?.text;const command=typeof text==='string'?text.trim().toUpperCase():'';
   if(armed&&/^COMMIT\b/.test(command)){validateUpgradeAuthority(authority,planRef.sha256,plan.target);result.commitRequested=true;save();}
   const response=await query(...params);if(armed&&/^COMMIT\b/.test(command)){result.commitAck=response.command==='COMMIT';save();}if(armed&&/^ROLLBACK\b/.test(command)){result.rollbackAck=response.command==='ROLLBACK';save();}return response;};
  try{await migrate(drizzle(connection),{migrationsFolder:prepared.folder,migrationsSchema:'zzsh_business_meta',migrationsTable:'migrations'});}finally{armed=false;}
  assert(result.commitAck===true,'UPGRADE_COMMIT_ACK_REQUIRED');result.status='COMMIT_ACK_READBACK_PENDING';save();
  await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const after=await validateLive(connection,161);assert.equal((await connection.query('ROLLBACK')).command,'ROLLBACK');
  recheck();result.after=after;result.readbackRollbackAck=true;result.status='UPGRADE_READBACK_PASSED';
 }catch(error){result.status=result.commitRequested&&!result.commitAck?'COMMIT_UNKNOWN':result.commitAck?'COMMIT_ACK_READBACK_REQUIRED':'STOPPED';result.error=/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name;process.exitCode=1;}
 finally{
  if(connection)try{await connection.end();result.clientClosed=true;}catch{result.clientClosed=false;}
  if(lock){try{if(locked)result.unlockAck=(await lock.query('SELECT pg_advisory_unlock(806006) AS ok')).rows[0]?.ok===true;}catch{result.unlockAck=false;}try{await lock.end();result.lockClosed=true;}catch{result.lockClosed=false;}}
  prepared.cleanup();
  if(mode==='--execute'){if(result.status==='UPGRADE_READBACK_PASSED'&&(!result.clientClosed||!result.unlockAck||!result.lockClosed)){result.status='COMMIT_ACK_READBACK_REQUIRED';process.exitCode=1;}
   result.finishedAt=new Date().toISOString();writeLoadCheckpoint(join(out,'receipt.json'),result);console.log(JSON.stringify({status:result.status,commitAck:result.commitAck,rollbackAck:result.rollbackAck,readbackRollbackAck:result.readbackRollbackAck,unlockAck:result.unlockAck,clientClosed:result.clientClosed,financialWrites:0}));}
  else if(process.exitCode===1)console.error(JSON.stringify({status:'UPGRADE_READ_ONLY_PREPARE_FAILED',code:result.error}));
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'UPGRADE_STOPPED_BEFORE_INTENT',code:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
