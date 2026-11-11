import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';

const restricted=resolve('E:/zzsh-local-state/restricted'),secretRoot=resolve('E:/zzsh/zzsh/apps/api/.secrets');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function within(base,path,output=false){
 assert(typeof path==='string'&&isAbsolute(path),'R07_CONTAINER_PATH_REQUIRED');const p=resolve(path),r=relative(base,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r)&&!/[\r\n,]/.test(p),'R07_CONTAINER_PATH_REQUIRED');
 for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'R07_CONTAINER_LINK_REFUSED');return p;
}
export function assertR07Image(image,id){
 assert(/^sha256:[a-f0-9]{64}$/.test(id??'')&&image?.Id===id&&image.Os==='linux'&&image.Architecture==='amd64'
   &&Array.isArray(image.RepoTags)&&image.RepoTags.includes('postgres:16-alpine')
   &&Array.isArray(image.Config?.Env)&&image.Config.Env.includes('PG_MAJOR=16')&&image.Config.Env.includes('PGDATA=/var/lib/postgresql/data'),
 'R07_CONTAINER_IMAGE_INVALID');
}
export function validateR07ContainerPlan(plan){
 const legacy=plan?.schema==='zzsh.round07-postgres-container-plan.v1',next=plan?.schema==='zzsh.local-migration-postgres-container-plan.v1';
 const containerPrefix=legacy?'zzsh-r07-postgres-':'zzsh-migration-postgres-',volumePrefix=legacy?'zzsh-r07-pgdata-':'zzsh-migration-pgdata-';
 const secretPrefix=legacy?'round07-postgres-':'migration-postgres-';
 assert((legacy||next)&&/^[a-z0-9][a-z0-9-]{2,45}$/.test(plan.nameSuffix??'')
   &&plan.containerName===containerPrefix+plan.nameSuffix&&plan.volumeName===volumePrefix+plan.nameSuffix
   &&/^sha256:[a-f0-9]{64}$/.test(plan.imageId??'')&&plan.host==='127.0.0.1'
   &&(legacy?plan.port===55433:Number.isInteger(plan.port)&&plan.port>=1024&&plan.port<=65535&&![55432,55433,55434].includes(plan.port))
   &&plan.taskLabel===(legacy?'round07-migration':'local-migration-next')&&hex(plan.password?.sha256)&&typeof plan.password?.path==='string'
   &&resolve(plan.password.path).toLowerCase()===resolve(secretRoot,secretPrefix+plan.nameSuffix,'postgres_password').toLowerCase()
   &&plan.databaseUser==='zzsh'&&plan.automaticCleanup===false,'R07_CONTAINER_PLAN_INVALID');
}
export function assertNoR07NameCollision(containerNames,volumeNames,plan){
 assert(Array.isArray(containerNames)&&Array.isArray(volumeNames)&&!containerNames.includes(plan.containerName)&&!volumeNames.includes(plan.volumeName),'R07_CONTAINER_RESOURCE_EXISTS');
}
export function assertR07Volume(value,plan){
 assert(value?.Name===plan.volumeName&&value.Labels?.['zzsh.task']===plan.taskLabel&&value.Driver==='local','R07_VOLUME_INSPECTION_MISMATCH');
}
function docker(args){const result=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 assert(result.status===0&&result.signal===null,'R07_DOCKER_COMMAND_FAILED');return result.stdout.trim();}
function inspectImage(id){const rows=JSON.parse(docker(['image','inspect',id]));assert(Array.isArray(rows)&&rows.length===1,'R07_CONTAINER_IMAGE_INVALID');assertR07Image(rows[0],id);}
function assertResourcesFree(plan){
 const containers=docker(['ps','--all','--filter','name=^/'+plan.containerName+'$','--format','{{.Names}}']).split(/\r?\n/).filter(Boolean);
 const volumes=docker(['volume','ls','--filter','name=^'+plan.volumeName+'$','--format','{{.Name}}']).split(/\r?\n/).filter(Boolean);
 assertNoR07NameCollision(containers,volumes,plan);
}
async function assertPortFree(port){
 const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port,exclusive:true},resolve);});
 await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
}
function normalizeMount(path){
 let p=String(path??'').replaceAll('\\','/').toLowerCase().replace(/\/+$/,'');
 p=p.replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//,'$1:/');return p;
}
export function assertR07ContainerCreated(value,plan,id){
 const ports=value?.NetworkSettings?.Ports?.['5432/tcp'],mounts=value?.Mounts??[],env=value?.Config?.Env??[];
 assert(/^[a-f0-9]{64}$/.test(id??'')&&value?.Id===id&&value.Image===plan.imageId&&value.State?.Running===true
   &&value.Config?.Labels?.['zzsh.task']===plan.taskLabel&&value.HostConfig?.AutoRemove===false&&value.HostConfig?.Privileged===false
   &&Array.isArray(ports)&&ports.length===1&&ports[0].HostIp==='127.0.0.1'&&ports[0].HostPort===String(plan.port)
   &&mounts.filter(m=>m.Type==='volume'&&m.Name===plan.volumeName&&m.Destination==='/var/lib/postgresql/data'&&m.RW===true).length===1
   &&mounts.filter(m=>m.Type==='bind'&&m.Destination==='/run/secrets/r07-pg-password'&&m.RW===false&&normalizeMount(m.Source)===normalizeMount(plan.password.path)).length===1
   &&env.includes('POSTGRES_PASSWORD_FILE=/run/secrets/r07-pg-password')&&!env.some(x=>x.startsWith('POSTGRES_PASSWORD=')),
 'R07_CONTAINER_INSPECTION_MISMATCH');
}
/** Per-step INTENT survives a failed or timed-out Docker command; no cleanup/retry is implicit. */
export function createR07Container({plan,run,save}){
 const receipt={status:'STARTED',containerName:plan.containerName,volumeName:plan.volumeName,imageId:plan.imageId,steps:[]};
 const step=(name,args,check)=>{receipt.steps.push({name,status:'INTENT'});receipt.status='INTENT';save(receipt);
   const output=run(args);check(output);receipt.steps.at(-1).status='ACK';receipt.status='IN_PROGRESS';save(receipt);return output;};
 step('volume',['volume','create','--label','zzsh.task='+plan.taskLabel,plan.volumeName],x=>assert.equal(x,plan.volumeName,'R07_VOLUME_CREATE_REPLY_INVALID'));
 const id=step('container',['create','--name',plan.containerName,'--label','zzsh.task='+plan.taskLabel,'--publish','127.0.0.1:'+plan.port+':5432',
  '--mount','type=volume,src='+plan.volumeName+',dst=/var/lib/postgresql/data',
  '--mount','type=bind,src='+plan.password.path+',dst=/run/secrets/r07-pg-password,readonly',
  '--env','POSTGRES_USER=zzsh','--env','POSTGRES_DB=postgres','--env','POSTGRES_PASSWORD_FILE=/run/secrets/r07-pg-password',plan.imageId],
 x=>assert(/^[a-f0-9]{64}$/.test(x),'R07_CONTAINER_CREATE_REPLY_INVALID'));
 receipt.containerId=id;save(receipt);
 step('start',['start',id],x=>assert(x===id||x===plan.containerName,'R07_CONTAINER_START_REPLY_INVALID'));
 return receipt;
}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 assert(!(args.includes('--prepare')&&args.includes('--execute')),'R07_CONTAINER_ONE_MODE_REQUIRED');
 assert(args.filter(value=>value==='--port').length<=1&&(!args.includes('--execute')||!args.includes('--port')),'R07_CONTAINER_PORT_INVALID');
 if(!args.includes('--prepare')&&!args.includes('--execute')){console.log(JSON.stringify({status:'PLAN_ONLY',prepare:['--prepare','--image-id','--suffix','--out','optional: --port'],execute:['--execute','--plan','--plan-sha','--out'],dbConnections:0,containersCreated:0,automaticCleanup:false}));return;}
 assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 if(args.includes('--prepare')){
  const out=within(restricted,option('--out'),true),nameSuffix=option('--suffix'),imageId=option('--image-id'),rawPort=option('--port'),next=args.includes('--port');
  assert(!next||/^[1-9][0-9]{3,4}$/.test(rawPort),'R07_CONTAINER_PORT_INVALID');
  const prefix=next?'migration':'round07',port=next?Number(rawPort):55433;
  assert(dirname(out).toLowerCase()===restricted.toLowerCase()&&new RegExp('^'+prefix+'-container-[a-z0-9-]+$').test(basename(out))&&!existsSync(out),'R07_CONTAINER_OUTPUT_EXISTS');
  const secretDir=join(secretRoot,prefix+'-postgres-'+nameSuffix),password=join(secretDir,'postgres_password');
  assert(!existsSync(secretDir),'R07_CONTAINER_SECRET_EXISTS');
  const plan={schema:next?'zzsh.local-migration-postgres-container-plan.v1':'zzsh.round07-postgres-container-plan.v1',nameSuffix,
   containerName:'zzsh-'+(next?'migration':'r07')+'-postgres-'+nameSuffix,volumeName:'zzsh-'+(next?'migration':'r07')+'-pgdata-'+nameSuffix,
   imageId,host:'127.0.0.1',port,taskLabel:next?'local-migration-next':'round07-migration',databaseUser:'zzsh',automaticCleanup:false,password:{path:password,sha256:'0'.repeat(64)}};
  validateR07ContainerPlan(plan);within(secretRoot,secretDir,true);inspectImage(imageId);assertResourcesFree(plan);await assertPortFree(plan.port);
  writePrivate(join(secretDir,'resource.json'),{schema:next?'zzsh.local-migration-postgres-secret.v1':'zzsh.round07-postgres-secret.v1',containerName:plan.containerName});
  const secret=randomBytes(32).toString('base64url')+'\n';writeFileSync(password,secret,{flag:'wx',mode:0o600});plan.password.sha256=sha(readFileSync(password));
  writePrivate(join(out,'plan.json'),plan);console.log(JSON.stringify({status:next?'MIGRATION_CONTAINER_PLAN_SEALED_NOT_CREATED':'R07_CONTAINER_PLAN_SEALED_NOT_CREATED',plan:join(out,'plan.json'),sha256:sha(readFileSync(join(out,'plan.json'))),imageId,containerName:plan.containerName,volumeName:plan.volumeName,dbConnections:0,containersCreated:0}));return;
 }
 const planPath=within(restricted,option('--plan')),bytes=readFileSync(planPath),out=within(restricted,option('--out'),true);
 assert(hex(option('--plan-sha'))&&sha(bytes)===option('--plan-sha')&&!existsSync(out),'R07_CONTAINER_PLAN_CHANGED');const plan=JSON.parse(bytes);validateR07ContainerPlan(plan);
 const password=within(secretRoot,plan.password.path);assert(sha(readFileSync(password))===plan.password.sha256,'R07_CONTAINER_SECRET_CHANGED');
 inspectImage(plan.imageId);assertResourcesFree(plan);await assertPortFree(plan.port);
 let receipt={status:'STARTED',planSha256:option('--plan-sha'),startedAt:new Date().toISOString(),steps:[]};writePrivate(join(out,'receipt.json'),receipt);
 const save=x=>{receipt={...receipt,...x,planSha256:option('--plan-sha')};writePrivate(join(out,'receipt.json'),receipt);};
 try{
  const created=createR07Container({plan,run:docker,save}),rows=JSON.parse(docker(['inspect','--type','container',created.containerId]));
  assert(Array.isArray(rows)&&rows.length===1,'R07_CONTAINER_INSPECTION_MISMATCH');assertR07ContainerCreated(rows[0],plan,created.containerId);
  const volumes=JSON.parse(docker(['volume','inspect',plan.volumeName]));assert(Array.isArray(volumes)&&volumes.length===1,'R07_VOLUME_INSPECTION_MISMATCH');assertR07Volume(volumes[0],plan);
  assert(sha(readFileSync(password))===plan.password.sha256,'R07_CONTAINER_SECRET_CHANGED');save({...created,status:plan.schema==='zzsh.local-migration-postgres-container-plan.v1'?'MIGRATION_POSTGRES_CONTAINER_RUNNING_NOT_REGISTERED':'R07_POSTGRES_CONTAINER_RUNNING_NOT_REGISTERED',inspectionAck:true,finishedAt:new Date().toISOString()});
 }catch(error){save({...receipt,status:receipt.steps.at(-1)?.status==='INTENT'?'R07_CONTAINER_OUTCOME_UNKNOWN':'R07_CONTAINER_STOPPED_PRESERVE',error:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name,finishedAt:new Date().toISOString()});process.exitCode=1;}
 console.log(JSON.stringify({status:receipt.status,receipt:join(out,'receipt.json'),containerId:receipt.containerId??null,automaticCleanup:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'R07_CONTAINER_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
