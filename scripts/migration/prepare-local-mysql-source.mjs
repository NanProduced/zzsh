import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { writeLoadCheckpoint } from './local-load-checkpoint.mjs';

const restricted=resolve('E:/zzsh-local-state/restricted'),archive=resolve('E:/zzsh/.archive'),secretRoot=resolve('E:/zzsh/zzsh/apps/api/.secrets');
const sha=value=>createHash('sha256').update(value).digest('hex'),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const task='local-migration-mysql-source';
const date=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
 &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19);

function within(base,path,output=false){
 assert(typeof path==='string'&&isAbsolute(path),'MYSQL_SOURCE_PATH_REQUIRED');
 const p=resolve(path),r=relative(base,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r)&&!/[\r\n,]/.test(p),'MYSQL_SOURCE_PATH_REQUIRED');
 for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'MYSQL_SOURCE_LINK_REFUSED');
 return p;
}
function checkedDump(path){
 let p;try{p=within(restricted,path);}catch{p=within(archive,path);}
 assert(lstatSync(p).isFile(),'MYSQL_SOURCE_DUMP_REQUIRED');return p;
}
export async function hashDump(path){const h=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(path)){h.update(chunk);bytes+=chunk.length;}return {sha256:h.digest('hex'),bytes};}
function docker(args,input){const result=spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 assert(result.status===0&&result.signal===null,'MYSQL_SOURCE_DOCKER_FAILED');return result.stdout.trim();}
function dockerJson(args){return JSON.parse(docker(args));}
function normalize(path){return String(path??'').replaceAll('\\','/').toLowerCase().replace(/\/+$/,'').replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//,'$1:/');}
export function validateMysqlSourcePlan(plan){
 const suffix=plan?.suffix,dir=resolve(secretRoot,'migration-mysql-'+suffix);
 assert(plan?.schema==='zzsh.local-mysql-source-plan.v1'&&/^[a-z0-9][a-z0-9-]{2,40}$/.test(suffix??'')
  &&plan.containerName==='zzsh-migration-mysql-'+suffix&&plan.volumeName==='zzsh-migration-mysql-data-'+suffix
  &&plan.taskLabel===task&&/^[a-f0-9]{32}$/.test(plan.resourceNonce??'')&&/^sha256:[a-f0-9]{64}$/.test(plan.imageId??'')&&hex(plan.toolSha256)&&hex(plan.checkpointToolSha256)
  &&plan.database==='sg_zzsh_restore'&&plan.automaticCleanup===false&&hex(plan.dump?.sha256)&&Number.isSafeInteger(plan.dump.bytes)&&plan.dump.bytes>0
  &&isAbsolute(plan.dump.path??'')&&date(plan.dump.exportStartedAt)&&date(plan.dump.cutoff)
  &&Date.parse(plan.dump.exportStartedAt)<=Date.parse(plan.dump.cutoff)&&plan.dump.cutoffMeaning==='EXPORT_COMPLETED_NOT_PROVEN_STOP_WRITE'
  &&resolve(plan.credentials?.passwordFile??'').toLowerCase()===resolve(dir,'root-password').toLowerCase()
  &&resolve(plan.credentials?.clientFile??'').toLowerCase()===resolve(dir,'client.cnf').toLowerCase()
  &&hex(plan.credentials.passwordSha256)&&hex(plan.credentials.clientSha256),'MYSQL_SOURCE_PLAN_INVALID');
}
export function assertMysqlImage(image,id){
 assert(image?.Id===id&&image.Os==='linux'&&image.Architecture==='amd64'&&image.RepoTags?.includes('mysql:8.0.45')
  &&image.Config?.Env?.includes('MYSQL_MAJOR=8.0')&&image.Config.Env.includes('MYSQL_VERSION=8.0.45-1.el9'),'MYSQL_SOURCE_IMAGE_INVALID');
}
export function assertMysqlContainer(container,plan,id,expectedStartedAt){
 const mounts=container?.Mounts??[],env=container?.Config?.Env??[],cmd=container?.Config?.Cmd??[];
 assert(/^[a-f0-9]{64}$/.test(id??'')&&container?.Id===id&&container.Name==='/'+plan.containerName&&container.Image===plan.imageId
  &&container.State?.Running===true&&Number.isFinite(Date.parse(container.State.StartedAt??''))&&container.Config?.Labels?.['zzsh.task']===plan.taskLabel
  &&container.Config.Labels?.['zzsh.nonce']===plan.resourceNonce&&container.HostConfig?.NetworkMode==='none'
  &&container.HostConfig?.Privileged===false&&container.HostConfig?.AutoRemove===false
  &&Object.values(container.NetworkSettings?.Ports??{}).every(value=>value===null)
  &&container.HostConfig?.Tmpfs?.['/run/zzsh-source']==='rw,noexec,nosuid,nodev,mode=0700'
  &&mounts.length===2&&mounts.some(m=>m.Type==='volume'&&m.Name===plan.volumeName&&m.Destination==='/var/lib/mysql'&&m.RW===true)
  &&mounts.some(m=>m.Type==='bind'&&normalize(m.Source)===normalize(plan.credentials.passwordFile)&&m.Destination==='/run/secrets/mysql-password'&&m.RW===false)
  &&env.includes('MYSQL_ROOT_PASSWORD_FILE=/run/secrets/mysql-password')&&env.includes('MYSQL_DATABASE=sg_zzsh_restore')
  &&!env.some(x=>x.startsWith('MYSQL_ROOT_PASSWORD='))
  &&['--skip-networking=ON','--event-scheduler=DISABLED','--local-infile=OFF'].every(x=>cmd.includes(x)),'MYSQL_SOURCE_CONTAINER_CHANGED');
 if(expectedStartedAt!==undefined)assert.equal(container.State.StartedAt,expectedStartedAt,'MYSQL_SOURCE_CONTAINER_RESTARTED');
}
export function assertMysqlVolume(volume,plan){assert(volume?.Name===plan.volumeName&&volume.Driver==='local'
 &&volume.Labels?.['zzsh.task']===plan.taskLabel&&volume.Labels?.['zzsh.nonce']===plan.resourceNonce,'MYSQL_SOURCE_VOLUME_CHANGED');}
export function assertMysqlFrozen(row){
 assert(row?.database==='sg_zzsh_restore'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.serverUuid??'')
  &&row.readOnly===1&&row.superReadOnly===1&&row.skipNetworking===1&&row.localInfile===0&&row.eventScheduler==='DISABLED'
  &&row.requiredTables===4,'MYSQL_SOURCE_NOT_FROZEN');
}
function mysqlArgs(id){return ['exec','-i',id,'mysql','--defaults-extra-file=/run/zzsh-source/client.cnf','--user=root','--protocol=SOCKET',
 '--skip-reconnect','--local-infile=0','--default-character-set=utf8mb4','--batch','--raw','--skip-column-names','--binary-mode','sg_zzsh_restore'];}
const frozenQuery="SELECT JSON_OBJECT('database',DATABASE(),'serverUuid',@@server_uuid,'readOnly',@@global.read_only,'superReadOnly',@@global.super_read_only,'skipNetworking',@@global.skip_networking,'localInfile',@@global.local_infile,'eventScheduler',@@global.event_scheduler,'requiredTables',(SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('la_user','la_order','la_rental_accounts','la_pay_order')));";
function inspectFrozen(id,freeze=false){const row=JSON.parse(docker([...mysqlArgs(id),'-e',(freeze?'SET GLOBAL super_read_only=ON; ':'')+frozenQuery]));assertMysqlFrozen(row);return row;}
function inspectImage(id){const list=dockerJson(['image','inspect',id]);assert(Array.isArray(list)&&list.length===1,'MYSQL_SOURCE_IMAGE_INVALID');assertMysqlImage(list[0],id);}
export function assertMysqlClientFile(metadata,digest,expected){assert(metadata==='600:0:regular file'&&digest===expected,'MYSQL_SOURCE_CLIENT_FILE_CHANGED');}
function inspectResources(plan,id,expectedStartedAt){const containers=dockerJson(['inspect','--type','container',id]),volumes=dockerJson(['volume','inspect',plan.volumeName]);
 assert(containers.length===1&&volumes.length===1,'MYSQL_SOURCE_RESOURCE_CHANGED');assertMysqlContainer(containers[0],plan,id,expectedStartedAt);assertMysqlVolume(volumes[0],plan);
 const metadata=docker(['exec',id,'stat','-c','%a:%u:%F','/run/zzsh-source/client.cnf']);
 const digest=docker(['exec',id,'sha256sum','/run/zzsh-source/client.cnf']).split(/\s+/)[0];assertMysqlClientFile(metadata,digest,plan.credentials.clientSha256);
 return {startedAt:containers[0].State.StartedAt};}
export function assertMysqlSourceBinding(plan,receipt,binding,planSha,bindingSha,containerId){
 validateMysqlSourcePlan(plan);const record=binding?.restoreRecord,source=binding?.source,container=binding?.container;
 assert(binding?.schema==='zzsh.local-source-origin.v2'&&binding.planSha256===planSha&&binding.toolSha256===plan.toolSha256&&binding.checkpointToolSha256===plan.checkpointToolSha256
  &&receipt?.schema==='zzsh.local-mysql-source-restore.v1'&&receipt.status==='MYSQL_SOURCE_RESTORED_READ_ONLY'
  &&receipt.planSha256===planSha&&receipt.bindingSha256===bindingSha&&receipt.containerId===containerId
  &&container?.id===containerId&&container.name===plan.containerName&&container.imageId===plan.imageId&&container.volumeName===plan.volumeName&&container.resourceNonce===plan.resourceNonce
  &&Number.isFinite(Date.parse(container.startedAt??''))&&receipt.containerStartedAt===container.startedAt
  &&source?.database===plan.database&&source.network==='none'&&source.readOnly===true&&source.superReadOnly===true&&source.eventScheduler==='DISABLED'
  &&source.clientFile==='/run/zzsh-source/client.cnf'&&source.clientSha256===plan.credentials.clientSha256
  &&record?.dumpPath===plan.dump.path&&record.dumpSha256===plan.dump.sha256&&record.dumpBytes===plan.dump.bytes
  &&record.exportStartedAt===plan.dump.exportStartedAt&&record.cutoff===plan.dump.cutoff&&record.cutoffMeaning===plan.dump.cutoffMeaning
  &&record.consumedSha256===plan.dump.sha256&&record.importClientExitCode===0&&record.sourceExportConsistency==='NOT_VERIFIED_BY_RESTORE'
  &&receipt.imported?.sha256===plan.dump.sha256&&receipt.imported?.bytes===plan.dump.bytes&&receipt.imported?.clientExitCode===0
  &&receipt.imported?.warningObserved===false&&receipt.imported?.stderrPresent===false,'MYSQL_SOURCE_BINDING_INVALID');
}
/** Recheck the sealed restore, current server and original dump; this does not prove the online export was consistent. */
export async function verifyBoundMysqlSource(bindingPath,bindingSha,containerId){
 assert(hex(bindingSha)&&/^[a-f0-9]{64}$/.test(containerId??''),'MYSQL_SOURCE_BINDING_REQUIRED');
 const file=within(restricted,bindingPath),bytes=readFileSync(file);assert(sha(bytes)===bindingSha,'MYSQL_SOURCE_BINDING_CHANGED');
 const binding=JSON.parse(bytes),execution=dirname(file),planPath=within(restricted,join(dirname(execution),'plan.json')),
  receiptPath=within(restricted,join(execution,'receipt.json')),planBytes=readFileSync(planPath),plan=JSON.parse(planBytes),receipt=JSON.parse(readFileSync(receiptPath));
 assert(basename(file)==='source-binding.json'&&basename(execution)==='execution'
  &&dirname(planPath).toLowerCase()===resolve(restricted,'migration-mysql-source-'+plan.suffix).toLowerCase(),'MYSQL_SOURCE_BINDING_PATH_INVALID');
 const planSha=sha(planBytes);assertMysqlSourceBinding(plan,receipt,binding,planSha,bindingSha,containerId);
 assert(sha(readFileSync(fileURLToPath(import.meta.url)))===plan.toolSha256,'MYSQL_SOURCE_TOOL_CHANGED');
 assert(sha(readFileSync(new URL('./local-load-checkpoint.mjs',import.meta.url)))===plan.checkpointToolSha256,'MYSQL_SOURCE_CHECKPOINT_TOOL_CHANGED');
 assertSecrets(plan);inspectImage(plan.imageId);inspectResources(plan,containerId,binding.container.startedAt);
 assert.equal(docker(['exec',containerId,'cat','/proc/1/comm']),'mysqld','MYSQL_SOURCE_SERVER_NOT_MAIN');
 const current=inspectFrozen(containerId);assert(current.serverUuid===binding.source.serverUuid,'MYSQL_SOURCE_SERVER_CHANGED');
 const dump=await hashDump(checkedDump(plan.dump.path));assert(dump.sha256===plan.dump.sha256&&dump.bytes===plan.dump.bytes,'MYSQL_SOURCE_DUMP_CHANGED');
 return {containerId,bindingSha256:bindingSha,serverUuid:current.serverUuid,clientFile:binding.source.clientFile,sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE'};
}
function assertNamesFree(plan){
 const containers=docker(['ps','--all','--filter','name=^/'+plan.containerName+'$','--format','{{.Names}}']).split(/\r?\n/).filter(Boolean);
 const volumes=docker(['volume','ls','--filter','name=^'+plan.volumeName+'$','--format','{{.Name}}']).split(/\r?\n/).filter(Boolean);
 assert(!containers.includes(plan.containerName)&&!volumes.includes(plan.volumeName),'MYSQL_SOURCE_RESOURCE_EXISTS');
}
export function createMysqlSourceContainer({plan,run,save,clientConfig}){
 const receipt={status:'STARTED',containerName:plan.containerName,volumeName:plan.volumeName,steps:[]};
 const step=(name,args,check,input)=>{receipt.steps.push({name,status:'INTENT'});save(receipt);const reply=run(args,input);check(reply);receipt.steps.at(-1).status='ACK';save(receipt);return reply;};
 const labels=['--label','zzsh.task='+plan.taskLabel,'--label','zzsh.nonce='+plan.resourceNonce];
 step('volume',['volume','create',...labels,plan.volumeName],x=>assert.equal(x,plan.volumeName,'MYSQL_SOURCE_VOLUME_REPLY_INVALID'));
 const id=step('container',['create','--name',plan.containerName,...labels,'--network','none','--tmpfs','/run/zzsh-source:rw,noexec,nosuid,nodev,mode=0700',
  '--mount','type=volume,src='+plan.volumeName+',dst=/var/lib/mysql',
  '--mount','type=bind,src='+plan.credentials.passwordFile+',dst=/run/secrets/mysql-password,readonly',
  '--env','MYSQL_ROOT_PASSWORD_FILE=/run/secrets/mysql-password','--env','MYSQL_DATABASE=sg_zzsh_restore',plan.imageId,
  '--skip-networking=ON','--event-scheduler=DISABLED','--local-infile=OFF'],x=>assert(/^[a-f0-9]{64}$/.test(x),'MYSQL_SOURCE_CONTAINER_REPLY_INVALID'));
 receipt.containerId=id;save(receipt);step('start',['start',id],x=>assert(x===id||x===plan.containerName,'MYSQL_SOURCE_START_REPLY_INVALID'));
 step('client-config',['exec','-i',id,'install','-m','600','/dev/stdin','/run/zzsh-source/client.cnf'],()=>{},clientConfig);return receipt;
}
/** The hash covers the bytes actually sent to mysql; failed imports are never retried automatically. */
export async function restoreMysqlDump({containerId,dumpPath,expectedSha256,expectedBytes,spawnProcess=spawn}){
 assert(/^[a-f0-9]{64}$/.test(containerId??'')&&hex(expectedSha256)&&Number.isSafeInteger(expectedBytes)&&expectedBytes>0,'MYSQL_SOURCE_RESTORE_INPUT_INVALID');
 const child=spawnProcess('docker',[...mysqlArgs(containerId),'--show-warnings'],{windowsHide:true,stdio:['pipe','pipe','pipe']}),hash=createHash('sha256');let bytes=0,stderrPresent=false,warningObserved=false,tail='',stderrTail='';
 child.stdout.on('data',chunk=>{const text=tail+chunk.toString('utf8');if(/(?:^|[\r\n])Warning\s*\(Code\s+\d+\):/i.test(text))warningObserved=true;tail=text.slice(-256);});
 child.stderr.on('data',chunk=>{stderrPresent=true;stderrTail=(stderrTail+chunk.toString('utf8')).slice(-8192);});
 const closed=new Promise(resolveClose=>{child.once('error',()=>resolveClose({code:null,signal:'SPAWN_ERROR'}));child.once('close',(code,signal)=>resolveClose({code,signal}));});
 let streamFailed=false;try{await pipeline(createReadStream(dumpPath),new Transform({transform(chunk,_enc,done){bytes+=chunk.length;hash.update(chunk);done(null,chunk);}}),child.stdin);}catch{streamFailed=true;}
 const result=await closed,consumed=hash.digest('hex');
 if(streamFailed||result.code!==0||result.signal!==null){
  const match=/ERROR\s+(\d{1,5})\b/.exec(stderrTail),stderrClass=match?'MYSQL_ERROR_'+match[1]:/lost connection|server has gone away/i.test(stderrTail)?'CONNECTION_LOST':stderrPresent?'CLIENT_ERROR':'NOT_AVAILABLE';
  throw Object.assign(Error('MYSQL_SOURCE_IMPORT_FAILED_PRESERVE'),{importAttempt:{bytes,consumedSha256:consumed,clientExitCode:result.code,signal:result.signal,streamFailed,stderrClass}});
 }
 assert(bytes===expectedBytes&&consumed===expectedSha256,'MYSQL_SOURCE_CONSUMED_BYTES_CHANGED');
 assert(!warningObserved&&!stderrPresent,'MYSQL_SOURCE_IMPORT_OUTPUT_REVIEW');
 return {bytes,sha256:consumed,clientExitCode:result.code,stderrPresent,warningObserved};
}
export function mysqlMainProcessReady(processName,result){return processName==='mysqld'&&result?.status===0&&result.stdout?.trim()==='1';}
async function waitForMysql(id){
 for(let i=0;i<120;i++){
  const process=spawnSync('docker',['exec',id,'cat','/proc/1/comm'],{encoding:'utf8',windowsHide:true,timeout:5000});
  if(process.status===0&&process.stdout.trim()==='mysqld'){
   const query=spawnSync('docker',[...mysqlArgs(id),'-e','SELECT 1'],{encoding:'utf8',windowsHide:true,timeout:5000});
   if(mysqlMainProcessReady(process.stdout.trim(),query))return;
  }
  await sleep(500);
 }
 throw Error('MYSQL_SOURCE_STARTUP_NOT_READY');
}
function assertSecrets(plan){for(const [file,expected] of [[plan.credentials.passwordFile,plan.credentials.passwordSha256],[plan.credentials.clientFile,plan.credentials.clientSha256]])
 assert(sha(readFileSync(within(secretRoot,file)))===expected,'MYSQL_SOURCE_SECRET_CHANGED');}
function option(args,name){const indexes=args.flatMap((x,i)=>x===name?[i]:[]);assert(indexes.length<=1,'MYSQL_SOURCE_DUPLICATE_OPTION');return indexes.length?args[indexes[0]+1]:undefined;}
async function main(){
 const args=process.argv.slice(2),prepare=args.includes('--prepare'),execute=args.includes('--execute');assert(!(prepare&&execute),'MYSQL_SOURCE_ONE_MODE_REQUIRED');
 if(!prepare&&!execute){console.log(JSON.stringify({status:'PLAN_ONLY',prepare:['--prepare','--suffix','--image-id','--dump','--export-start','--cutoff'],execute:['--execute','--plan','--plan-sha'],network:'none',automaticCleanup:false,dbConnections:0}));return;}
 assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 if(prepare){
  const names=['--suffix','--image-id','--dump','--export-start','--cutoff'];
  assert(args[0]==='--prepare'&&args.length===1+2*names.length&&names.every(name=>args.filter(x=>x===name).length===1),'MYSQL_SOURCE_ARGUMENTS_INVALID');
  const suffix=option(args,'--suffix'),imageId=option(args,'--image-id'),dumpPath=checkedDump(option(args,'--dump')),
   exportStartedAt=option(args,'--export-start'),cutoff=option(args,'--cutoff');
  assert(/^[a-z0-9][a-z0-9-]{2,40}$/.test(suffix??'')&&date(exportStartedAt)&&date(cutoff)&&Date.parse(exportStartedAt)<=Date.parse(cutoff)
   &&Date.parse(cutoff)<=Date.now(),'MYSQL_SOURCE_INPUT_INVALID');
  const out=join(restricted,'migration-mysql-source-'+suffix),secretDir=join(secretRoot,'migration-mysql-'+suffix);
  within(restricted,out,true);within(secretRoot,secretDir,true);assert(!existsSync(out)&&!existsSync(secretDir),'MYSQL_SOURCE_OUTPUT_EXISTS');
  const dump=await hashDump(dumpPath),passwordFile=join(secretDir,'root-password'),clientFile=join(secretDir,'client.cnf');
  const plan={schema:'zzsh.local-mysql-source-plan.v1',suffix,containerName:'zzsh-migration-mysql-'+suffix,volumeName:'zzsh-migration-mysql-data-'+suffix,toolSha256:sha(readFileSync(fileURLToPath(import.meta.url))),checkpointToolSha256:sha(readFileSync(new URL('./local-load-checkpoint.mjs',import.meta.url))),
   taskLabel:task,resourceNonce:randomBytes(16).toString('hex'),imageId,database:'sg_zzsh_restore',automaticCleanup:false,
   dump:{path:dumpPath,...dump,exportStartedAt,cutoff,cutoffMeaning:'EXPORT_COMPLETED_NOT_PROVEN_STOP_WRITE'},
   credentials:{passwordFile,clientFile,passwordSha256:'0'.repeat(64),clientSha256:'0'.repeat(64)}};
  validateMysqlSourcePlan(plan);inspectImage(imageId);assertNamesFree(plan);
  writePrivate(join(secretDir,'resource.json'),{schema:'zzsh.local-mysql-source-secret.v1',containerName:plan.containerName});
  const password=randomBytes(32).toString('base64url');writeFileSync(passwordFile,password+'\n',{flag:'wx',mode:0o600});
  writeFileSync(clientFile,'[client]\nuser=root\npassword='+password+'\nprotocol=SOCKET\n',{flag:'wx',mode:0o600});
  plan.credentials.passwordSha256=sha(readFileSync(passwordFile));plan.credentials.clientSha256=sha(readFileSync(clientFile));
  mkdirSync(out);writePrivate(join(out,'plan.json'),plan);
  console.log(JSON.stringify({status:'MYSQL_SOURCE_PLAN_SEALED_NOT_CREATED',plan:join(out,'plan.json'),sha256:sha(readFileSync(join(out,'plan.json'))),dumpSha256:dump.sha256,bytes:dump.bytes,automaticCleanup:false}));return;
 }
 assert(args[0]==='--execute'&&args.length===5&&['--plan','--plan-sha'].every(name=>args.filter(x=>x===name).length===1),'MYSQL_SOURCE_ARGUMENTS_INVALID');
 const planPath=within(restricted,option(args,'--plan')),planBytes=readFileSync(planPath),planSha=option(args,'--plan-sha');
 assert(hex(planSha)&&sha(planBytes)===planSha,'MYSQL_SOURCE_PLAN_CHANGED');const plan=JSON.parse(planBytes);validateMysqlSourcePlan(plan);
 assert(dirname(planPath).toLowerCase()===resolve(restricted,'migration-mysql-source-'+plan.suffix).toLowerCase()&&basename(planPath)==='plan.json','MYSQL_SOURCE_PLAN_PATH_INVALID');
 assert(sha(readFileSync(fileURLToPath(import.meta.url)))===plan.toolSha256,'MYSQL_SOURCE_TOOL_CHANGED');
 assert(sha(readFileSync(new URL('./local-load-checkpoint.mjs',import.meta.url)))===plan.checkpointToolSha256,'MYSQL_SOURCE_CHECKPOINT_TOOL_CHANGED');
 assertSecrets(plan);inspectImage(plan.imageId);assertNamesFree(plan);const original=await hashDump(checkedDump(plan.dump.path));
 assert(original.sha256===plan.dump.sha256&&original.bytes===plan.dump.bytes,'MYSQL_SOURCE_DUMP_CHANGED');
 const out=join(dirname(planPath),'execution');mkdirSync(out);const claim=join(dirname(planPath),'execute.claim'),fd=openSync(claim,'wx',0o600);
 try{writeSync(fd,planSha+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 let receipt={schema:'zzsh.local-mysql-source-restore.v1',status:'STARTED',planSha256:planSha,startedAt:new Date().toISOString(),steps:[]};
 const receiptPath=join(out,'receipt.json');writePrivate(receiptPath,receipt);
 const save=value=>{receipt={...receipt,...value,planSha256:planSha};writeLoadCheckpoint(receiptPath,receipt);};save(receipt);
 try{
  const created=createMysqlSourceContainer({plan,run:docker,save,clientConfig:readFileSync(plan.credentials.clientFile)}),initial=inspectResources(plan,created.containerId);
  save({containerStartedAt:initial.startedAt});assertSecrets(plan);await waitForMysql(created.containerId);
  inspectResources(plan,created.containerId,initial.startedAt);
  save({...created,status:'IMPORT_INTENT'});const imported=await restoreMysqlDump({containerId:created.containerId,dumpPath:plan.dump.path,expectedSha256:plan.dump.sha256,expectedBytes:plan.dump.bytes});
  save({status:'IMPORT_ACK',imported});const after=await hashDump(checkedDump(plan.dump.path));
  assert(after.sha256===plan.dump.sha256&&after.bytes===plan.dump.bytes,'MYSQL_SOURCE_DUMP_CHANGED_AFTER_IMPORT');
  inspectResources(plan,created.containerId,initial.startedAt);assertSecrets(plan);const identity=inspectFrozen(created.containerId,true);
  inspectResources(plan,created.containerId,initial.startedAt);
  const binding={schema:'zzsh.local-source-origin.v2',container:{name:plan.containerName,id:created.containerId,imageId:plan.imageId,volumeName:plan.volumeName,resourceNonce:plan.resourceNonce,startedAt:initial.startedAt},
   source:{database:plan.database,serverUuid:identity.serverUuid,network:'none',readOnly:true,superReadOnly:true,eventScheduler:'DISABLED',clientFile:'/run/zzsh-source/client.cnf',clientSha256:plan.credentials.clientSha256},
   restoreRecord:{dumpPath:plan.dump.path,dumpSha256:plan.dump.sha256,dumpBytes:plan.dump.bytes,exportStartedAt:plan.dump.exportStartedAt,cutoff:plan.dump.cutoff,
    cutoffMeaning:plan.dump.cutoffMeaning,consumedSha256:imported.sha256,importClientExitCode:0,sourceExportConsistency:'NOT_VERIFIED_BY_RESTORE'},planSha256:planSha,toolSha256:plan.toolSha256,checkpointToolSha256:plan.checkpointToolSha256};
  writePrivate(join(out,'source-binding.json'),binding);save({status:'MYSQL_SOURCE_RESTORED_READ_ONLY',bindingSha256:sha(readFileSync(join(out,'source-binding.json'))),finishedAt:new Date().toISOString()});
 }catch(error){save({status:'MYSQL_SOURCE_STOPPED_PRESERVE',failure:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name,...(error.importAttempt?{importAttempt:error.importAttempt}:{}),finishedAt:new Date().toISOString()});process.exitCode=1;}
 console.log(JSON.stringify({status:receipt.status,receipt:join(out,'receipt.json'),binding:receipt.bindingSha256?join(out,'source-binding.json'):null,automaticCleanup:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({status:'MYSQL_SOURCE_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??error.name}));process.exitCode=1;});
