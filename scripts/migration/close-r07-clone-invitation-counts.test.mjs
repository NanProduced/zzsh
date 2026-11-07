import assert from 'node:assert/strict';import test from 'node:test';import {assertCloneCountsTarget,assertCloneCountsAuthority,assertCloneCountsApplyReceipt} from './close-r07-clone-invitation-counts.mjs';
test('only the separately registered delivery clone and its exact actor can close counts',()=>{
 const sha='a'.repeat(64),t={instance:{host:'127.0.0.1',port:55434,systemIdentifier:'123'},database:'zzsh_test_r07_delivery_20261108',marker:'zzsh:r07-delivery-clone:v1',
  oid:'50',nonce:'b'.repeat(24),owner:'zzsh',migrationRole:'zzsh_regression_migration',migrationRoleOid:'51',runtimeRoleOid:'52',protectedDataset:{manifestSha256:sha},pendingReset:null};
 const c={migration:{name:t.migrationRole,oid:'51'}},a={realm:'admin',id:'boss',sessionId:'session',resourceOid:'50',nonce:t.nonce};
 assert.doesNotThrow(()=>assertCloneCountsTarget(t,c,a,sha));
 for(const p of [{instance:{...t.instance,systemIdentifier:'7704972584346443810'}},{instance:{...t.instance,port:55433}},{marker:'zzsh:regression-test:v1'},
  {database:'zzsh_test_regression'},{oid:'49'},{owner:'other'},{pendingReset:{}},{protectedDataset:{manifestSha256:'c'.repeat(64)}}])
  assert.throws(()=>assertCloneCountsTarget({...t,...p},c,a,sha),/INVITE_CLONE_TARGET_REQUIRED/);
 assert.throws(()=>assertCloneCountsTarget(t,c,{...a,sessionId:''},sha),/INVITE_CLONE_TARGET_REQUIRED/);
});
test('readback only accepts original acknowledged or unknown commit receipts',()=>{
 const target={oid:'50'},sha='a'.repeat(64),receipt={schema:'zzsh.r07-clone-invitation-counts-receipt.v1',status:'COMMIT_ACK_READBACK_REQUIRED',commitSent:true,commitAck:true,
  planSha256:sha,target,unlockAck:true,connectionsClosed:true,approvalRef:'review',attempt:'once',notBefore:'2026-11-08T00:00:00.000Z',expiresAt:'2026-11-08T00:30:00.000Z'};
 assert.doesNotThrow(()=>assertCloneCountsApplyReceipt(receipt,sha,target));
 assert.doesNotThrow(()=>assertCloneCountsApplyReceipt({...receipt,status:'COMMIT_UNKNOWN',commitAck:false},sha,target));
 for(const p of [{status:'STOPPED'},{status:'COMMIT_REQUESTED'},{commitSent:false},{commitAck:false},{planSha256:'b'.repeat(64)},
  {target:{oid:'51'}},{unlockAck:false},{connectionsClosed:false},{expiresAt:'2026-11-08T00:30:00.001Z'}])
  assert.throws(()=>assertCloneCountsApplyReceipt({...receipt,...p},sha,target),/INVITE_CLONE_APPLY_RECEIPT_INVALID/);
});
test('count closure window binds the exact plan, clone and packet count',()=>{
 const now=Date.parse('2026-11-08T00:00:00.000Z'),target={oid:'50'},plan={target,packetHashes:['a','b']},planSha='a'.repeat(64);
 const a={schema:'zzsh.r07-clone-invitation-counts-authority.v1',status:'APPROVED',operation:'CLOSE_PROVEN_INVITATION_COUNTS',planSha256:planSha,target,
  maxPackets:2,allowFinancialWrites:false,approvalRef:'review',attempt:'once',notBefore:new Date(now).toISOString(),expiresAt:new Date(now+1800000).toISOString()};
 assert.doesNotThrow(()=>assertCloneCountsAuthority(a,plan,planSha,now+1));
 for(const p of [{target:{oid:'51'}},{maxPackets:1},{allowFinancialWrites:true},{planSha256:'b'.repeat(64)},{attempt:''},{expiresAt:new Date(now+1800001).toISOString()}])
  assert.throws(()=>assertCloneCountsAuthority({...a,...p},plan,planSha,now+1),/INVITE_CLONE_AUTHORITY_CHANGED/);
 assert.throws(()=>assertCloneCountsAuthority(a,plan,planSha,now+1800000),/INVITE_CLONE_AUTHORITY_CHANGED/);
});
