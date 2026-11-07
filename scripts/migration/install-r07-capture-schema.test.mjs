import assert from 'node:assert/strict';import test from 'node:test';import {assertSchemaAuthority,assertSchemaApplyReceipt} from './install-r07-capture-schema.mjs';
test('schema install authority binds exact target, plan and bounded nonfinancial window',()=>{
 const now=Date.parse('2026-11-08T00:00:00Z'),target={oid:'1'},plan={target},hash='a'.repeat(64),a={schema:'zzsh.r07-capture-schema-authority.v1',status:'APPROVED',
  operation:'INSTALL_0174_0175_CAPTURE_SCHEMA',planSha256:hash,target,migrations:2,allowFinancialWrites:false,approvalRef:'review',attempt:'once',
  notBefore:new Date(now).toISOString(),expiresAt:new Date(now+1800000).toISOString()};
 assert.doesNotThrow(()=>assertSchemaAuthority(a,plan,hash,now+1));
 for(const p of [{target:{oid:'2'}},{migrations:1},{allowFinancialWrites:true},{planSha256:'b'.repeat(64)},{attempt:''},{expiresAt:new Date(now+1800001).toISOString()}])
  assert.throws(()=>assertSchemaAuthority({...a,...p},plan,hash,now+1),/SCHEMA_AUTHORITY_CHANGED/);
 assert.throws(()=>assertSchemaAuthority(a,plan,hash,now+1800000),/SCHEMA_AUTHORITY_CHANGED/);
});
test('schema readback accepts only acknowledged or uncertain original commit',()=>{
 const target={oid:'1'},hash='a'.repeat(64),r={schema:'zzsh.r07-capture-schema-receipt.v1',status:'COMMIT_ACK_READBACK_REQUIRED',commitSent:true,commitAck:true,
  planSha256:hash,target,approvalRef:'review',attempt:'once',notBefore:'2026-11-08T00:00:00.000Z',expiresAt:'2026-11-08T00:30:00.000Z',unlockAck:true,connectionsClosed:true};
 assert.doesNotThrow(()=>assertSchemaApplyReceipt(r,hash,target));assert.doesNotThrow(()=>assertSchemaApplyReceipt({...r,status:'COMMIT_UNKNOWN',commitAck:false},hash,target));
 for(const p of [{status:'STOPPED'},{status:'COMMIT_REQUESTED'},{commitSent:false},{commitAck:false},{unlockAck:false},{connectionsClosed:false},
  {target:{oid:'2'}},{planSha256:'b'.repeat(64)},{expiresAt:'2026-11-08T00:30:00.001Z'}])assert.throws(()=>assertSchemaApplyReceipt({...r,...p},hash,target),/SCHEMA_APPLY_UNCONFIRMED/);
});
