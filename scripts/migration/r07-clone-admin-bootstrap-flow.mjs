import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {totp,validateProfile} from '../local-auth.mjs';

const paths=new Set([
 'POST /api/v1/admin/security/bootstrap','POST /api/auth/admin/sign-in/username','POST /api/auth/admin/change-password',
 'POST /api/auth/admin/sign-out','POST /api/auth/admin/two-factor/enable','POST /api/auth/admin/two-factor/verify-totp',
 'POST /api/v1/admin/security/enrollment/activate','GET /api/auth/admin/get-session',
]);

// Snapshot the complete existing economic roots/events; matching row counts alone cannot
// prove the already-posted opening facts stayed unchanged during administrator bootstrap.
export async function readFinanceRootEventDigest(client){
 const rows=['finance_economic_root','finance_event'].map(name=>`SELECT '${name}' name,count(*)::text count,encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'),'' ORDER BY t.id::text COLLATE "C"),''),'UTF8')),'hex') digest FROM zzsh_order.${name} t`).join(' UNION ALL ');
 const result=(await client.query(`SELECT jsonb_agg(to_jsonb(x) ORDER BY x.name) result FROM (${rows}) x`)).rows[0]?.result;
 assert(Array.isArray(result)&&result.length===2,'R07_BOSS_FINANCE_SNAPSHOT_INVALID');return result;
}
export function assertFinanceRootEventUnchanged(before,after){assert.deepEqual(after,before,'R07_BOSS_FINANCE_FACTS_CHANGED');}

// The short-lived local listener exposes only the formal enrollment routes to this process.
export function createBootstrapGateway(handler,gate){
 assert.equal(typeof handler,'function');assert(/^[a-f0-9]{64}$/.test(gate??''));const expected=Buffer.from(gate,'ascii');
 return createServer((request,response)=>{
  const received=request.headers['x-r07-bootstrap-gate'];const bytes=typeof received==='string'?Buffer.from(received,'ascii'):Buffer.alloc(0);
  const path=(request.url??'').split('?',1)[0];
  if(bytes.length!==expected.length||!timingSafeEqual(bytes,expected)||!paths.has(`${request.method} ${path}`)){response.writeHead(404);response.end();return;}
  delete request.headers['x-r07-bootstrap-gate'];handler(request,response);
 });
}

// All secrets in `staged` are kept only in the caller's restricted files.
// Every command records its intent before the HTTP call; the caller never retries it automatically.
export async function runCloneBossEnrollment({request,staged,receipt,sessionFactory,setRequestId,save,assertWindow}){
 const call=async(name,session,path,body)=>{
  assertWindow();const requestId=`r07boss-${request.attempt}-${name}`;assert(/^[A-Za-z0-9._:-]{1,127}$/.test(requestId));
  setRequestId(requestId);const step={name,path,requestId,status:'INTENT'};receipt.steps.push(step);receipt.pendingStep=name;await save();
  let response;try{response=await session.request(path,body);}catch(error){receipt.status='STOPPED_COMMAND_OUTCOME_UNKNOWN';await save();throw error;}
  step.httpStatus=response.status;step.status='HTTP_ACK';delete receipt.pendingStep;await save();
  assert.equal(response.status,200,`R07_BOSS_HTTP_${name.toUpperCase().replaceAll('-','_')}_REJECTED`);return response.body;
 };
 const first=sessionFactory();
 const created=await call('bootstrap',first,'/api/v1/admin/security/bootstrap',{bootstrapSecret:staged.bootstrapSecret,name:request.name,password:staged.temporaryPassword});
 assert(/^admin_[a-f0-9]{32}$/.test(created?.adminUserId??'')&&/^zz[0-9]{5,}$/.test(created?.username??'')
  &&created.isBoss===true&&created.status==='PENDING_ENROLLMENT'&&created.passwordChangeRequired===true,'R07_BOSS_BOOTSTRAP_RESPONSE_INVALID');
 staged.administratorId=created.adminUserId;staged.username=created.username;receipt.administratorId=created.adminUserId;await save();
 await call('initial-sign-in',first,'/api/auth/admin/sign-in/username',{username:created.username,password:staged.temporaryPassword});
 await call('change-password',first,'/api/auth/admin/change-password',{currentPassword:staged.temporaryPassword,newPassword:staged.password,revokeOtherSessions:true});
 await call('sign-out-initial',first,'/api/auth/admin/sign-out',{});
 const enrolled=sessionFactory();await call('new-sign-in',enrolled,'/api/auth/admin/sign-in/username',{username:created.username,password:staged.password});
 const enabled=await call('enable-totp',enrolled,'/api/auth/admin/two-factor/enable',{password:staged.password});
 let uri;try{uri=new URL(enabled?.totpURI);}catch{throw new Error('R07_BOSS_TOTP_RESPONSE_INVALID');}
 const secret=uri.searchParams.get('secret');assert(uri.protocol==='otpauth:'&&typeof secret==='string'&&/^[A-Z2-7]+=*$/i.test(secret),'R07_BOSS_TOTP_RESPONSE_INVALID');
 staged.totp={encoding:'base32',secret};await save();
 await call('verify-totp',enrolled,'/api/auth/admin/two-factor/verify-totp',{code:totp(staged.totp)});
 const activated=await call('activate',enrolled,'/api/v1/admin/security/enrollment/activate',{});assert.equal(activated?.status,'ACTIVE');
 const current=await call('get-session',enrolled,'/api/auth/admin/get-session');
 assert(current?.user?.id===created.adminUserId&&current.user.suspended!==true&&current.user.twoFactorEnabled===true,'R07_BOSS_SESSION_CHANGED');
 await call('sign-out',enrolled,'/api/auth/admin/sign-out',{});
 const profile={version:1,localTest:true,resource:request.resource,actors:{admin:{realm:'admin',origin:request.adminOrigin,userId:created.adminUserId,username:created.username,password:staged.password,totp:staged.totp}}};
 validateProfile(profile);return {administratorId:created.adminUserId,profile};
}
