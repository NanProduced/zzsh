import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile, writePrivate } from '../local-auth.mjs';
import { advisoryLockSql, assertLiveTarget, loadRegisteredTarget, maintenanceConnection, targetConnection, targetIdentityQuery } from './local-target-registry.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),restricted=resolve('E:/zzsh-local-state/restricted'),runtime=resolve('E:/zzsh-local-state/runtime');
const sha=x=>createHash('sha256').update(x).digest('hex');
function pathInRestricted(path,output=false,base=restricted){
  assert(typeof path==='string'&&isAbsolute(path),'BOOTSTRAP_READBACK_PATH_REQUIRED');
  const p=resolve(path),r=relative(base,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'BOOTSTRAP_READBACK_PATH_REQUIRED');
  for(let x=output?dirname(p):p;x!==dirname(x);x=dirname(x))assert(!lstatSync(x).isSymbolicLink(),'BOOTSTRAP_READBACK_LINK_REFUSED');
  return p;
}
function pin(ref,base=restricted){const path=pathInRestricted(ref?.path,false,base),bytes=readFileSync(path);assert(/^[a-f0-9]{64}$/.test(ref.sha256??'')&&sha(bytes)===ref.sha256,'BOOTSTRAP_READBACK_INPUT_CHANGED');return JSON.parse(bytes);}
function sameTarget(value,target){return value&&value.database===target.database&&String(value.oid??value.resourceOid)===target.oid&&value.nonce===target.nonce
  &&value.instance?.host===target.instance.host&&value.instance?.port===target.instance.port&&value.instance?.systemIdentifier===target.instance.systemIdentifier;}

export function validateR07BootstrapProofInputs(input,registered,profile,receipts){
  const t=input?.target;
  assert(input?.schema==='zzsh.round07-bootstrap-readback-request.v1'&&t?.bootstrapReservation==='ROUND07_BOOTSTRAP_RESERVED'
    &&t.instance?.host==='127.0.0.1'&&t.instance?.port===55433&&/^[0-9]+$/.test(t.instance.systemIdentifier??'')
    &&registered?.port===55433&&!registered.pendingReset&&registered.lockKey==='806006'&&sameTarget(t,registered)
    &&t.migrationRoleOid===registered.migrationRoleOid&&registered.runtimeRoleOid,'BOOTSTRAP_READBACK_TARGET_CHANGED');
  validateProfile(profile);const names=['boss-one','boss-two','operations','support'];
  assert(Object.keys(profile.actors).sort().join()===names.sort().join()&&new Set(names.map(n=>profile.actors[n].userId)).size===4
    &&names.every(n=>profile.actors[n].realm==='admin'&&profile.actors[n].origin==='http://127.0.0.1:4241')
    &&profile.actors['boss-one'].username==='zz00001'&&profile.actors['boss-two'].username==='zz00002','BOOTSTRAP_READBACK_PROFILE_CHANGED');
  for(const stage of ['bosses','staff']){const r=receipts[stage];assert(r?.stage===stage&&r.status==='FORMAL_INITIALIZATION_COMPLETED'&&sameTarget(r.target,t)
    &&r.serverBindingSha256===input.runtimeBinding.sha256&&r.finalReadbackRollbackAck===true&&r.maintenanceClosed===true&&r.unlock===true
    &&r.oldAdminRowsImported===false,'BOOTSTRAP_READBACK_ADMIN_RECEIPT_CHANGED');}
  const r=receipts.policy;assert(r?.status==='FORMAL_LOCAL_POLICY_INITIALIZED'&&r.executionStatus==='SUCCEEDED'&&r.oldApprovalsCopied===false
    &&sameTarget(r.target,t)&&r.provenance?.runtimeBindingSha256===input.runtimeBinding.sha256&&r.approvalRequestId&&r.policyId
    &&Number.isFinite(Date.parse(r.effectiveAtUtc)),'BOOTSTRAP_READBACK_POLICY_RECEIPT_CHANGED');
}

/** The booleans are calculated from the database rows, never inferred from receipts. */
export function verifyR07BootstrapRows(profile,policyReceipt,admins,oldSessions,policyRows){
  const actors=Object.values(profile.actors),boss1=profile.actors['boss-one'],boss2=profile.actors['boss-two'];
  assert(admins.length===actors.length&&admins.filter(a=>a.is_boss===true).length===2
    &&admins.every(a=>a.status==='ACTIVE'&&a.suspended===false&&a.two_factor===true&&!a.password_change_required
      &&actors.some(x=>x.userId===a.id&&x.username===a.username))
    &&admins.find(a=>a.id===boss1.userId)?.is_boss===true&&admins.find(a=>a.id===boss2.userId)?.is_boss===true
    &&oldSessions===0,'BOOTSTRAP_READBACK_ADMINS_DIFFER');
  const p=policyRows.length===1?policyRows[0]:null;
  const effectiveAtMs=p?.effective_at instanceof Date?p.effective_at.getTime():Date.parse(p?.effective_at);
  assert(p&&p.id===policyReceipt.policyId&&p.status==='APPROVED'&&p.effective_now===true&&p.current_policy===true
    &&Number.isFinite(effectiveAtMs)&&effectiveAtMs===Date.parse(policyReceipt.effectiveAtUtc)&&p.approval_request_id===policyReceipt.approvalRequestId
    &&p.request_status==='EXECUTED'&&p.decision==='APPROVED'&&p.execution_status==='SUCCEEDED'
    &&p.operation_code==='membership.benefit.policy.publish'&&p.result_code==='MEMBERSHIP_POLICY_PUBLISHED'&&p.result_detail===p.id
    &&p.requested_by===boss1.userId&&p.approver===boss2.userId&&p.executed_by===boss1.userId&&p.approved_by===boss1.userId,
  'BOOTSTRAP_READBACK_POLICY_DIFFERS');
  return {admins:{count:admins.length,allActive:true,twoFactor:true,onlyNewUids:true,oldSessions},policy:{id:p.id,status:p.status,
    effectiveAtUtc:new Date(p.effective_at).toISOString(),effectiveNow:true,newApprovalRequestId:p.approval_request_id,
    requestStatus:p.request_status,decision:p.decision,executionStatus:p.execution_status,onlyNewBossRelations:true}};
}

async function main(){
  const args=process.argv.slice(2),option=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
  if(!args.includes('--readback')){console.log(JSON.stringify({status:'PLAN_ONLY',required:['--readback','--input','--input-sha','--out'],connections:0,targetWrites:0}));return;}
  assert.equal(process.version,'v24.20.0','NODE_BASELINE_MISMATCH');
  const input=pin({path:option('--input'),sha256:option('--input-sha')}),out=pathInRestricted(option('--out'),true);assert(!existsSync(out),'BOOTSTRAP_READBACK_OUTPUT_EXISTS');
  const credentialsPath=pathInRestricted(input.credentials?.path),credentialsBytes=readFileSync(credentialsPath);
  assert(sha(credentialsBytes)===input.credentials.sha256,'BOOTSTRAP_READBACK_CREDENTIALS_CHANGED');
  const registered=loadRegisteredTarget(credentialsPath),registrySha=sha(readFileSync(registered.sourceFile)),credentials=JSON.parse(credentialsBytes),profile=pin(input.profile);
  const receipts={bosses:pin(input.bosses),staff:pin(input.staff),policy:pin(input.policy)},binding=pin(input.runtimeBinding,runtime);
  validateR07BootstrapProofInputs(input,registered,profile,receipts);
  assert(binding.status==='R07_BOOTSTRAP_API_LISTENING'&&sameTarget(binding.resource,input.target)&&sameTarget(binding.actualResource,input.target)
    &&binding.NoIM===true&&binding.financialCommandCapabilities===false&&binding.workersEnabled===false,'BOOTSTRAP_READBACK_RUNTIME_CHANGED');
  for(const role of ['migration','runtime'])assert(credentials[role]?.name===registered[role+'Role']&&credentials[role]?.oid===registered[role+'RoleOid'],'BOOTSTRAP_READBACK_ROLE_CHANGED');
  const require=createRequire(join(root,'apps/api/package.json')),{Client}=require('pg'),common={connectionTimeoutMillis:3000,statement_timeout:15000,lock_timeout:1000};
  const maintenance=new Client(maintenanceConnection(registered,{...common,user:credentials.migration.name,password:credentials.migration.password}));
  const db=new Client(targetConnection(registered,{...common,user:credentials.runtime.name,password:credentials.runtime.password}));let held=false,begun=false,rollbackAck=false,clientClosed=false,unlock=false,maintenanceClosed=false,result;
  try{
    await maintenance.connect();held=(await maintenance.query(advisoryLockSql(registered,'try'))).rows[0]?.ok===true;assert(held,'BOOTSTRAP_READBACK_RESOURCE_BUSY');
    await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
    const identity=(await db.query(targetIdentityQuery())).rows[0];assertLiveTarget(registered,identity,'runtime');assert.equal(identity.read_only,'on','BOOTSTRAP_READBACK_NOT_READ_ONLY');
    const admins=(await db.query('SELECT u.id,u.username,u.suspended,u."twoFactorEnabled" two_factor,s.is_boss,s.status,s.password_change_required FROM zzsh_auth_admin."user" u LEFT JOIN zzsh_iam.admin_security s ON s.admin_user_id=u.id ORDER BY u.username')).rows;
    const sessions=(await db.query('SELECT count(*)::int n FROM zzsh_auth_admin.session WHERE "userId"<>ALL($1::text[])',[Object.values(profile.actors).map(a=>a.userId)])).rows[0].n;
    const policy=(await db.query(`SELECT p.id,p.status,p.effective_at,p.effective_at<=transaction_timestamp() AS effective_now,
      p.id=(SELECT current_policy.id FROM zzsh_iam.membership_growth_policy current_policy WHERE current_policy.status='APPROVED' AND current_policy.effective_at<=transaction_timestamp() ORDER BY current_policy.effective_at DESC,current_policy.version DESC LIMIT 1) AS current_policy,
      p.approval_request_id,p.approved_by_admin_id approved_by,
      r.status request_status,r.requested_by,r.operation_code,d.decision,d.approver_admin_id approver,e.status execution_status,e.result_code,e.result_detail,e.executed_by
      FROM zzsh_iam.membership_growth_policy p JOIN zzsh_iam.approval_request r ON r.id=p.approval_request_id
      JOIN zzsh_iam.approval_decision d ON d.request_id=r.id JOIN zzsh_iam.approval_execution e ON e.request_id=r.id WHERE p.id=$1`,[receipts.policy.policyId])).rows;
    result={identity:{database:identity.database,oid:String(identity.oid),nonce:identity.nonce,marker:identity.marker,read_only:identity.read_only,instance:registered.instance},...verifyR07BootstrapRows(profile,receipts.policy,admins,sessions,policy)};
    assert.equal((await db.query('ROLLBACK')).command,'ROLLBACK');begun=false;rollbackAck=true;
    assert(sha(readFileSync(credentialsPath))===input.credentials.sha256&&sha(readFileSync(registered.sourceFile))===registrySha,'BOOTSTRAP_READBACK_FILES_CHANGED');
    for(const ref of [input.profile,input.bosses,input.staff,input.policy])pin(ref);pin(input.runtimeBinding,runtime);
  }finally{
    try{if(begun)await db.query('ROLLBACK');}catch{rollbackAck=false;}
    try{await db.end();clientClosed=true;}catch{clientClosed=false;}
    try{if(held)unlock=(await maintenance.query(advisoryLockSql(registered,'unlock'))).rows[0]?.ok===true;}catch{unlock=false;}
    try{await maintenance.end();maintenanceClosed=true;}catch{maintenanceClosed=false;}
  }
  assert(result&&rollbackAck&&clientClosed&&unlock&&maintenanceClosed,'BOOTSTRAP_READBACK_CLEANUP_UNCONFIRMED');
  writePrivate(join(out,'readback.json'),{...result,rollbackAck,clientClosed,unlock,maintenanceClosed,targetWrites:0});
  console.log(JSON.stringify({status:'R07_BOOTSTRAP_READBACK_PASSED',readback:join(out,'readback.json'),sha256:sha(readFileSync(join(out,'readback.json'))),targetWrites:0}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({status:'BOOTSTRAP_READBACK_STOPPED',code:/^[A-Z][A-Z0-9_]+$/.test(e.message??'')?e.message:e.code??e.name}));process.exitCode=1;});
