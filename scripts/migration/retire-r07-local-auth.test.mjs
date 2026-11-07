import assert from 'node:assert/strict';import test from 'node:test';import {assertAuthHandoffAuthority,assertAuthHandoffApplyReceipt,authHandoffFailureStatus} from './retire-r07-local-auth.mjs';
test('local auth handoff requires exact roster counts, target, plan and bounded window',()=>{
 const now=Date.parse('2026-11-08T00:00:00Z'),target={oid:'1'},plan={target,snapshot:{actors:[1,2,3,4],userSessions:[1],userVerifications:[1]}},hash='a'.repeat(64);
 const a={schema:'zzsh.r07-auth-handoff-authority.v1',status:'APPROVED',operation:'RETIRE_LOCAL_AUTH_MATERIAL',planSha256:hash,target,admins:4,userSessions:1,userVerifications:1,
  allowFinancialWrites:false,approvalRef:'review',attempt:'once',notBefore:new Date(now).toISOString(),expiresAt:new Date(now+1800000).toISOString()};
 assert.doesNotThrow(()=>assertAuthHandoffAuthority(a,plan,hash,now+1));
 for(const p of [{target:{oid:'2'}},{admins:3},{userSessions:0},{userVerifications:0},{allowFinancialWrites:true},{attempt:''},{planSha256:'b'.repeat(64)},{expiresAt:new Date(now+1800001).toISOString()}])
  assert.throws(()=>assertAuthHandoffAuthority({...a,...p},plan,hash,now+1),/AUTH_HANDOFF_AUTHORITY_CHANGED/);
 assert.throws(()=>assertAuthHandoffAuthority(a,plan,hash,now+1800000),/AUTH_HANDOFF_AUTHORITY_CHANGED/);
});
test('unknown commit and rollback never become a clean stop',()=>{
 assert.equal(authHandoffFailureStatus('--execute',undefined,'ADMIN_HANDOFF_ROLLBACK_UNKNOWN',false,false),'ROLLBACK_UNKNOWN');
 assert.equal(authHandoffFailureStatus('--execute',undefined,'ADMIN_HANDOFF_COMMIT_UNKNOWN',true,false),'COMMIT_UNKNOWN');
 assert.equal(authHandoffFailureStatus('--readback','COMMIT_UNKNOWN','MISSING',false,false),'COMMIT_UNKNOWN_UNRESOLVED');
 assert.equal(authHandoffFailureStatus('--execute',undefined,'ERROR',true,true),'COMMIT_ACK_READBACK_REQUIRED');
});
test('auth handoff recovery requires original commit receipt and completed connection cleanup',()=>{
 const target={oid:'1'},hash='a'.repeat(64),a={schema:'zzsh.r07-auth-handoff-receipt.v1',status:'COMMIT_ACK_READBACK_REQUIRED',commitSent:true,commitAck:true,planSha256:hash,target,
  handoffDigest:'b'.repeat(64),approvalRef:'review',attempt:'once',notBefore:'2026-11-08T00:00:00.000Z',expiresAt:'2026-11-08T00:30:00.000Z',unlockAck:true,connectionsClosed:true};
 assert.doesNotThrow(()=>assertAuthHandoffApplyReceipt(a,hash,target));assert.doesNotThrow(()=>assertAuthHandoffApplyReceipt({...a,status:'COMMIT_UNKNOWN',commitAck:false},hash,target));
 for(const p of [{status:'STOPPED'},{status:'COMMIT_REQUESTED'},{commitSent:false},{commitAck:false},{unlockAck:false},{connectionsClosed:false},
  {handoffDigest:'bad'},{target:{oid:'2'}},{expiresAt:'2026-11-08T00:30:00.001Z'}])assert.throws(()=>assertAuthHandoffApplyReceipt({...a,...p},hash,target),/AUTH_HANDOFF_APPLY_UNCONFIRMED/);
});
