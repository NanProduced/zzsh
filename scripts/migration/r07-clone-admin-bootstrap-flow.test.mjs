import test from 'node:test';import assert from 'node:assert/strict';import {assertFinanceRootEventUnchanged,createBootstrapGateway,readFinanceRootEventDigest,runCloneBossEnrollment} from './r07-clone-admin-bootstrap-flow.mjs';
const id='admin_'+'a'.repeat(32),request={attempt:'test-attempt',name:'测试管理员',resource:'r07_delivery_clone',adminOrigin:'http://127.0.0.1:4231'};
function fixture({failPath,throwPath,expireBefore}={}){
 const calls=[],saved=[],staged={bootstrapSecret:'b'.repeat(40),temporaryPassword:'a'.repeat(40),password:'c'.repeat(40)},receipt={steps:[]};let currentId='',windowCount=0;
 const sessionFactory=()=>({async request(path,body){calls.push({path,requestId:currentId});if(path===throwPath)throw Error('NETWORK_LOST');
  if(path===failPath)return {status:403,body:{}};
  const bodyByPath={'/api/v1/admin/security/bootstrap':{adminUserId:id,username:'zz00005',isBoss:true,status:'PENDING_ENROLLMENT',passwordChangeRequired:true},
   '/api/auth/admin/two-factor/enable':{totpURI:'otpauth://totp/test?secret=JBSWY3DPEHPK3PXP'},
   '/api/v1/admin/security/enrollment/activate':{status:'ACTIVE'},'/api/auth/admin/get-session':{user:{id,twoFactorEnabled:true,suspended:false}}};
  return {status:200,body:bodyByPath[path]??{}};}});
 return {calls,saved,staged,receipt,options:{request,staged,receipt,sessionFactory,setRequestId:v=>currentId=v,
  save:async()=>saved.push({pending:receipt.pendingStep,status:receipt.status,steps:receipt.steps.map(x=>({...x}))}),
  assertWindow:()=>{windowCount++;if(windowCount===expireBefore)throw Error('WINDOW_EXPIRED');}}};
}
test('uses formal bootstrap, forced password change, TOTP, activation and sign-out in order',async()=>{
 const f=fixture(),r=await runCloneBossEnrollment(f.options);assert.equal(r.administratorId,id);assert.equal(r.profile.actors.admin.userId,id);
 assert.deepEqual(f.calls.map(x=>x.path),['/api/v1/admin/security/bootstrap','/api/auth/admin/sign-in/username','/api/auth/admin/change-password','/api/auth/admin/sign-out','/api/auth/admin/sign-in/username',
  '/api/auth/admin/two-factor/enable','/api/auth/admin/two-factor/verify-totp','/api/v1/admin/security/enrollment/activate','/api/auth/admin/get-session','/api/auth/admin/sign-out']);
 assert(f.calls.every(x=>x.requestId.startsWith('r07boss-test-attempt-')));assert(f.saved.some(x=>x.pending==='bootstrap'));
 assert(f.receipt.steps.every(x=>x.status==='HTTP_ACK'));assert.equal(f.receipt.pendingStep,undefined);
});
test('unknown HTTP outcome preserves original pending command and does not retry',async()=>{
 const f=fixture({throwPath:'/api/v1/admin/security/bootstrap'});await assert.rejects(()=>runCloneBossEnrollment(f.options),/NETWORK_LOST/);
 assert.equal(f.calls.length,1);assert.equal(f.receipt.pendingStep,'bootstrap');assert.equal(f.receipt.status,'STOPPED_COMMAND_OUTCOME_UNKNOWN');assert.equal(f.receipt.steps[0].status,'INTENT');
});
test('known failure and expired window never trigger a later command',async()=>{
 const rejected=fixture({failPath:'/api/auth/admin/change-password'});await assert.rejects(()=>runCloneBossEnrollment(rejected.options),/R07_BOSS_HTTP_CHANGE_PASSWORD_REJECTED/);
 assert.equal(rejected.calls.length,3);assert.equal(rejected.receipt.steps.at(-1).status,'HTTP_ACK');
 const expired=fixture({expireBefore:3});await assert.rejects(()=>runCloneBossEnrollment(expired.options),/WINDOW_EXPIRED/);assert.equal(expired.calls.length,2);
});
test('temporary gateway rejects unknown routes and requests without its process token',async()=>{
 const token='a'.repeat(64);let calls=0;const gateway=createBootstrapGateway((req,res)=>{calls++;assert.equal(req.headers['x-r07-bootstrap-gate'],undefined);res.writeHead(204);res.end();},token);
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+gateway.address().port;
 try{assert.equal((await fetch(origin+'/api/auth/admin/get-session')).status,404);
  assert.equal((await fetch(origin+'/api/auth/admin/get-session',{headers:{'X-R07-Bootstrap-Gate':'b'.repeat(64)}})).status,404);
  assert.equal((await fetch(origin+'/api/auth/user/get-session',{headers:{'X-R07-Bootstrap-Gate':token}})).status,404);
  assert.equal((await fetch(origin+'/api/auth/admin/get-session',{method:'POST',headers:{'X-R07-Bootstrap-Gate':token}})).status,404);
  assert.equal((await fetch(origin+'/api/auth/admin/get-session',{headers:{'X-R07-Bootstrap-Gate':token}})).status,204);assert.equal(calls,1);
 }finally{await new Promise((resolve,reject)=>gateway.close(error=>error?reject(error):resolve()));}
});
test('economic root and event contents, not just row counts, must remain identical',async()=>{
 const before=[{name:'finance_economic_root',count:'1',digest:'a'.repeat(64)},{name:'finance_event',count:'1',digest:'b'.repeat(64)}];
 let query='';const snapshot=await readFinanceRootEventDigest({query:async sql=>{query=sql;return {rows:[{result:before}]};}});
 assert.match(query,/zzsh_order\.finance_economic_root/);assert.match(query,/zzsh_order\.finance_event/);assert.match(query,/sha256\(convert_to\(to_jsonb\(t\)::text/);
 assert.doesNotThrow(()=>assertFinanceRootEventUnchanged(snapshot,structuredClone(before)));
 const changed=structuredClone(before);changed[0].digest='c'.repeat(64);assert.throws(()=>assertFinanceRootEventUnchanged(snapshot,changed),/R07_BOSS_FINANCE_FACTS_CHANGED/);
});
