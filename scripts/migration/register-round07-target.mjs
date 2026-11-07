import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { advisoryLockSql, assertLiveTarget, normalizeRegisteredTarget, targetConnection, targetIdentityQuery } from './local-target-registry.mjs';
import { writeLoadCheckpoint } from './local-load-checkpoint.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),privateRoot=resolve('E:/zzsh-local-state/restricted'),secretRoot=resolve('E:/zzsh/zzsh/apps/api/.secrets');
const database='zzsh_test_regression',marker='zzsh:regression-test:v1',migration='zzsh_regression_migration',runtime='zzsh_regression_runtime';
function privatePath(value,output=false,base=privateRoot){
 assert(typeof value==='string'&&isAbsolute(value),'TARGET_PRIVATE_PATH_REQUIRED');const p=resolve(value);
 const inBase=relative(base,p);assert(inBase&&!inBase.startsWith('..')&&!isAbsolute(inBase),'TARGET_PRIVATE_PATH_REQUIRED');
 for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'TARGET_LINK_REFUSED');return p;
}
function protectedSecret(value){
 assert(typeof value==='string'&&isAbsolute(value),'TARGET_PRIVATE_PATH_REQUIRED');const rel=relative(secretRoot,resolve(value));
 return rel&&!rel.startsWith('..')&&!isAbsolute(rel)?privatePath(value,false,secretRoot):privatePath(value);
}
function inspectContainer(id){
 assert(hex(id),'TARGET_CONTAINER_ID_REQUIRED');const result=spawnSync('docker',['inspect','--type','container',id],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:2*1024*1024});
 assert.equal(result.status,0,'TARGET_CONTAINER_INSPECTION_FAILED');const list=JSON.parse(result.stdout);assert(Array.isArray(list)&&list.length===1,'TARGET_CONTAINER_INSPECTION_FAILED');return list[0];
}
export function assertR07Container(value,id){
 const bindings=value?.NetworkSettings?.Ports?.['5432/tcp'];
 assert(value?.Id===id&&value?.Config?.Labels?.['zzsh.task']==='round07-migration'&&value?.State?.Running===true
   &&Array.isArray(bindings)&&bindings.length===1&&bindings[0]?.HostIp==='127.0.0.1'&&bindings[0]?.HostPort==='55433','TARGET_CONTAINER_MISMATCH');
}
export function assertFreshR07Cluster(identity,expectedSystem){
 assert(identity?.database==='postgres'&&identity.role==='zzsh'&&identity.superuser===true&&identity.version>=160000&&identity.version<170000
   &&/^[0-9]+$/.test(identity.systemIdentifier??'')&&(!expectedSystem||identity.systemIdentifier===expectedSystem)
   &&identity.databaseExists===false&&identity.rolesExist===false,'TARGET_CLUSTER_NOT_FRESH');
}
async function inspectCluster(client,expectedSystem){
 const row=(await client.query(`SELECT current_database() database,current_user role,r.rolsuper superuser,current_setting('server_version_num')::int version,
   (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
   EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS "databaseExists",
   EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])) AS "rolesExist"
   FROM pg_roles r WHERE r.rolname=current_user`,[database,[migration,runtime]])).rows[0];
 assertFreshR07Cluster(row,expectedSystem);return row;
}
/** All changes are forward-only; any error keeps the original intent and never deletes created objects. */
export async function createR07Database(client,passwords,nonce,record){
 assert(/^[A-Za-z0-9_-]{32,}$/.test(passwords?.migration??'')&&/^[A-Za-z0-9_-]{32,}$/.test(passwords?.runtime??'')&&/^[a-f0-9]{24}$/.test(nonce??''),'TARGET_CREATION_INPUT_INVALID');
 const commands=[
  ['migration-role',`CREATE ROLE ${migration} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.migration}'`],
  ['runtime-role',`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.runtime}'`],
  ['database',`CREATE DATABASE ${database} OWNER zzsh`],
  ['database-marker',`COMMENT ON DATABASE ${database} IS '${marker}'`],
  ['database-nonce',`ALTER DATABASE ${database} SET zzsh.regression_run = '${nonce}'`],
  ['migration-grant',`GRANT CONNECT,CREATE ON DATABASE ${database} TO ${migration}`],
  ['runtime-grant',`GRANT CONNECT ON DATABASE ${database} TO ${runtime}`],
 ];
 for(const [stage,sql] of commands){record({stage,status:'INTENT'});await client.query(sql);record({stage,status:'ACK'});}
}
async function main(){
 const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},prepare=args.includes('--prepare'),execute=args.includes('--execute');
 assert(!(prepare&&execute),'ONE_TARGET_ACTION_REQUIRED');
 if(!prepare&&!execute){console.log(JSON.stringify({status:'PLAN_ONLY',prepare:['--prepare','--container-id','--admin-secret','--dataset','--dataset-sha','--out'],execute:['--execute','--plan','--plan-sha','--out'],connections:0,targetWrites:0}));return;}
 assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 const require=createRequire(join(root,'apps/api/package.json')),{Client}=require('pg');
 let plan;
 if(prepare){
  const id=option('--container-id'),secretPath=protectedSecret(option('--admin-secret')),dataset=privatePath(option('--dataset')),datasetSha256=option('--dataset-sha'),out=privatePath(option('--out'),true);
  assert(!existsSync(out)&&hex(datasetSha256),'TARGET_PLAN_INPUT_INVALID');assertR07Container(inspectContainer(id),id);
  const bytes=readFileSync(join(dataset,'manifest.json'));assert.equal(sha(bytes),datasetSha256,'TARGET_DATASET_CHANGED');const manifest=JSON.parse(bytes);
  assert(manifest.status==='FULL_SOURCE_DATASET_PREPARED_TARGET_NOT_RUN'&&manifest.population?.mode==='SELECTED_BUSINESS_SCOPE','TARGET_DATASET_SCOPE_INVALID');
  const secret=readFileSync(secretPath),client=new Client({host:'127.0.0.1',port:55433,database:'postgres',user:'zzsh',password:secret.toString('utf8').trim(),connectionTimeoutMillis:3000,statement_timeout:15000});let began=false,identity;
  try{await client.connect();await client.query('BEGIN READ ONLY');began=true;identity=await inspectCluster(client);assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');began=false;}
  finally{try{if(began)await client.query('ROLLBACK');}finally{await client.end();secret.fill(0);}}
  plan={schema:'zzsh.round07-target-plan.v1',containerId:id,instance:{host:'127.0.0.1',port:55433,systemIdentifier:identity.systemIdentifier},dataset:{path:dataset,sha256:datasetSha256},adminSecret:{path:secretPath,sha256:sha(readFileSync(secretPath))}};
  writePrivate(join(out,'plan.json'),plan);console.log(JSON.stringify({status:'R07_TARGET_PLAN_SEALED_NOT_EXECUTED',plan:join(out,'plan.json'),planSha256:sha(readFileSync(join(out,'plan.json'))),connections:1,targetWrites:0}));return;
 }
 const planPath=privatePath(option('--plan')),planBytes=readFileSync(planPath),expected=option('--plan-sha'),out=privatePath(option('--out'),true);
 assert(hex(expected)&&sha(planBytes)===expected&&!existsSync(out),'TARGET_PLAN_CHANGED');plan=JSON.parse(planBytes);
 assert(plan?.schema==='zzsh.round07-target-plan.v1'&&plan.instance?.host==='127.0.0.1'&&plan.instance.port===55433&&/^[0-9]+$/.test(plan.instance.systemIdentifier??'')&&hex(plan.dataset?.sha256),'TARGET_PLAN_INVALID');
 assertR07Container(inspectContainer(plan.containerId),plan.containerId);
 const dataset=privatePath(plan.dataset.path);assert.equal(sha(readFileSync(join(dataset,'manifest.json'))),plan.dataset.sha256,'TARGET_DATASET_CHANGED');
 const secretPath=protectedSecret(plan.adminSecret.path),secret=readFileSync(secretPath);assert(hex(plan.adminSecret.sha256)&&sha(secret)===plan.adminSecret.sha256,'TARGET_ADMIN_SECRET_CHANGED');
 const nonce=randomBytes(12).toString('hex'),passwords={migration:randomBytes(32).toString('base64url'),runtime:randomBytes(32).toString('base64url')};
 const credentials={database,marker,migration:{name:migration,oid:null,password:passwords.migration},runtime:{name:runtime,oid:null,password:passwords.runtime}};
 writePrivate(join(out,'credentials.json'),credentials);const receipt={status:'STARTED',containerId:plan.containerId,instance:plan.instance,datasetSha256:plan.dataset.sha256,nonce,steps:[]};
 writePrivate(join(out,'receipt.json'),receipt);const save=()=>writeLoadCheckpoint(join(out,'receipt.json'),receipt),record=e=>{receipt.steps.push(e);receipt.status=e.status==='INTENT'?'CREATION_INTENT':'CREATION_IN_PROGRESS';save();};
 const client=new Client({host:plan.instance.host,port:plan.instance.port,database:'postgres',user:'zzsh',password:secret.toString('utf8').trim(),connectionTimeoutMillis:3000,statement_timeout:30000,lock_timeout:1000});let held=false;
 try{
  await client.connect();const lockTarget={lockKey:'806006'};held=(await client.query(advisoryLockSql(lockTarget,'try'))).rows[0]?.ok===true;assert(held,'TARGET_RESOURCE_BUSY');
  await client.query('BEGIN READ ONLY');try{await inspectCluster(client,plan.instance.systemIdentifier);assert.equal((await client.query('ROLLBACK')).command,'ROLLBACK');}catch(error){try{await client.query('ROLLBACK')}catch{}throw error;}
  await client.query("SET log_statement='none'");await client.query("SET log_min_duration_statement=-1");await client.query("SET password_encryption='scram-sha-256'");
  await createR07Database(client,passwords,nonce,record);
  const db=(await client.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1',[database])).rows[0],roles=(await client.query('SELECT rolname,oid::text FROM pg_roles WHERE rolname=ANY($1::text[])',[[migration,runtime]])).rows;
  assert(db?.oid&&roles.length===2,'TARGET_REGISTRATION_READBACK_FAILED');const roleOids=Object.fromEntries(roles.map(row=>[row.rolname,row.oid]));
  credentials.migration.oid=roleOids[migration];credentials.runtime.oid=roleOids[runtime];writePrivate(join(out,'credentials.json'),credentials);
  const resource={database,marker,oid:db.oid,nonce,owner:'zzsh',instance:plan.instance,roles:{migration:{name:migration,oid:roleOids[migration]},runtime:{name:runtime,oid:roleOids[runtime]}},
    lockKey:'806006',protectedDataset:{status:'ROUND07_BOOTSTRAP_RESERVED',bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED',manifestSha256:plan.dataset.sha256,epoch:{oid:db.oid,nonce}}};
  const target=normalizeRegisteredTarget(resource);for(const kind of ['migration','runtime']){
   const c=new Client(targetConnection(target,{user:credentials[kind].name,password:credentials[kind].password,applicationName:'r07-target-role-proof',connectionTimeoutMillis:3000,statement_timeout:15000}));
   try{await c.connect();await c.query('BEGIN READ ONLY');assertLiveTarget(target,(await c.query(targetIdentityQuery())).rows[0],kind);assert.equal((await c.query('ROLLBACK')).command,'ROLLBACK');}finally{await c.end();}
  }
  writePrivate(join(out,'resource.json'),resource);receipt.status='R07_TARGET_REGISTERED';receipt.oid=db.oid;receipt.roleReadback=true;save();
 }catch(error){receipt.status=receipt.steps.at(-1)?.status==='INTENT'?'CREATION_OUTCOME_UNKNOWN':'STOPPED_PRESERVE_TARGET';receipt.error=/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:error?.code??error?.name;process.exitCode=1;}
 finally{
  try{if(held)receipt.unlockAck=(await client.query(advisoryLockSql({lockKey:'806006'},'unlock'))).rows[0]?.ok===true;}catch{receipt.unlockAck=false;process.exitCode=1;}
  try{await client.end();receipt.maintenanceClosed=true;}catch{receipt.maintenanceClosed=false;process.exitCode=1;}
  if(receipt.status==='R07_TARGET_REGISTERED'&&(!receipt.unlockAck||!receipt.maintenanceClosed)){receipt.status='TARGET_CLEANUP_UNCONFIRMED';process.exitCode=1;}
  receipt.finishedAt=new Date().toISOString();save();secret.fill(0);
 }
 console.log(JSON.stringify({status:receipt.status,receipt:join(out,'receipt.json'),resource:receipt.status==='R07_TARGET_REGISTERED'?join(out,'resource.json'):null}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'STOPPED_BEFORE_REGISTRATION',code:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
