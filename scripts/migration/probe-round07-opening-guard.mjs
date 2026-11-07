import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../local-auth.mjs';
import { openingReviewResource } from './local-target-opening.mjs';
import { advisoryLockSql, assertLiveTarget, loadRegisteredTarget, maintenanceConnection, targetConnection, targetIdentityQuery } from './local-target-registry.mjs';
import { isolatedDistributionBuild } from './local-distribution-qualification-plan.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted');
const sha=x=>createHash('sha256').update(x).digest('hex'),hex=x=>/^[a-f0-9]{64}$/.test(x??'');
function privatePath(value,output=false){assert(typeof value==='string'&&isAbsolute(value),'OPENING_PROBE_PATH_REQUIRED');const p=resolve(value),r=relative(restricted,p);
 assert(r&&!r.startsWith('..')&&!isAbsolute(r),'OPENING_PROBE_PATH_REQUIRED');for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'OPENING_PROBE_LINK_REFUSED');return p;}
export function compareOpeningConnection(resource,connection){
 return Boolean(connection&&resource&&connection.host===resource.host&&connection.port===resource.port&&connection.database===resource.database&&connection.user===resource.role);
}
async function main(){
 const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
 if(!args.includes('--probe')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--probe','--credentials','--credentials-sha','--resource-sha','--oid','--nonce','--system-id','--api-dist','--module-sha','--out'],connections:0,targetWrites:0}));return;}
 assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
 const path=privatePath(option('--credentials')),bytes=readFileSync(path),registered=loadRegisteredTarget(path),out=privatePath(option('--out'),true);
 assert(!existsSync(out)&&hex(option('--credentials-sha'))&&sha(bytes)===option('--credentials-sha')&&hex(option('--resource-sha'))
  &&sha(readFileSync(registered.sourceFile))===option('--resource-sha')&&registered.port===55433&&registered.oid===option('--oid')
  &&registered.nonce===option('--nonce')&&registered.instance?.systemIdentifier===option('--system-id')&&!registered.pendingReset,
 'OPENING_PROBE_TARGET_CHANGED');
 const api=isolatedDistributionBuild(root,option('--api-dist')),modulePath=join(api,'finance/personal-finance-maintenance.js'),moduleBytes=readFileSync(modulePath);
 assert(hex(option('--module-sha'))&&sha(moduleBytes)===option('--module-sha'),'OPENING_PROBE_BUILD_CHANGED');
 const require=createRequire(join(root,'apps/api/package.json')),{Client}=require('pg'),{assertFinanceMaintenanceResource,isReviewedFinanceMaintenanceResource}=require(modulePath),credentials=JSON.parse(bytes);
 assert(credentials.migration?.name===registered.migrationRole&&credentials.migration?.oid===registered.migrationRoleOid,'OPENING_PROBE_ROLE_CHANGED');
 const common={connectionTimeoutMillis:3000,statement_timeout:15000,lock_timeout:1000},maintenance=new Client(maintenanceConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password})),
  db=new Client(targetConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password}));
 let held=false,begun=false,rollback=false,closed=false,unlock=false,maintenanceClosed=false,error,result;
 try{
  await maintenance.connect();held=(await maintenance.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(held,'OPENING_PROBE_RESOURCE_BUSY');
  await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  const actual=(await db.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,actual);assert.equal(actual.read_only,'on','OPENING_PROBE_NOT_READ_ONLY');
  const resource=openingReviewResource({targetPort:registered.port,state:{binding:{oid:registered.oid},resource:actual}});
  const cp=db.connectionParameters,connection={host:cp.host,port:cp.port,database:cp.database,user:cp.user};
  assert(compareOpeningConnection(resource,connection),'OPENING_PROBE_CONNECTION_DIFFERED');assert(isReviewedFinanceMaintenanceResource(resource),'OPENING_PROBE_RESOURCE_SHAPE_REJECTED');
  const actor={userId:'opening-guard-probe',sessionId:'opening-guard-probe'},review={actor,resource,notBefore:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
  await assertFinanceMaintenanceResource(db,actor,review);
  let rejected=false;try{await assertFinanceMaintenanceResource(db,actor,{...review,resource:{...resource,port:55432}});}catch(e){rejected=e.message==='Opening connection does not match reviewed local resource';}
  assert(rejected,'OPENING_PROBE_WRONG_PORT_NOT_REJECTED');
  result={schema:'zzsh.round07-opening-connection-probe.v1',status:'READ_ONLY_OPENING_CONNECTION_GUARD_PASSED',resource,connection,
   systemIdentifier:registered.instance.systemIdentifier,resourceSha256:option('--resource-sha'),moduleSha256:option('--module-sha'),
   exactGuardPassed:true,wrongPortRejected:true,actor:'SYNTHETIC_NO_AUTHORITY',businessWrites:0};
  rollback=(await db.query('ROLLBACK')).command==='ROLLBACK';begun=false;
 }catch(e){error=e;}
 finally{
  try{if(begun)await db.query('ROLLBACK');}catch{rollback=false;}try{await db.end();closed=true;}catch{closed=false;}
  try{if(held)unlock=(await maintenance.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{unlock=false;}
  try{await maintenance.end();maintenanceClosed=true;}catch{maintenanceClosed=false;}
 }
 const receipt={...(result??{schema:'zzsh.round07-opening-connection-probe.v1',status:'OPENING_CONNECTION_GUARD_FAILED',error:/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:error?.code??error?.name}),rollback,closed,unlock,maintenanceClosed,businessWrites:0};
 if(!result||!rollback||!closed||!unlock||!maintenanceClosed){receipt.status='OPENING_CONNECTION_GUARD_UNCONFIRMED';process.exitCode=1;}
 writePrivate(join(out,'receipt.json'),receipt);console.log(JSON.stringify({status:receipt.status,receipt:join(out,'receipt.json'),sha256:sha(readFileSync(join(out,'receipt.json'))),businessWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'OPENING_PROBE_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
