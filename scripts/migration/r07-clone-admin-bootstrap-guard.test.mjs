import test from 'node:test';import assert from 'node:assert/strict';
import {assertCloneBossGrant,assertBootstrapOnlyAuth,R07_CLONE_BOSS_TARGET as t,R07_CLEAN_EXPORT_SHA as exportSha} from './r07-clone-admin-bootstrap-guard.mjs';
const hash='a'.repeat(64),mirrorHash='b'.repeat(64),now=Date.parse('2026-11-08T01:00:00Z');
function fixture(){
 const request={schema:'zzsh.r07-local-demo-boss-request.v1',attempt:'r07-local-boss-01',name:'本地演示管理员',resource:'r07_delivery_clone',apiOrigin:'http://127.0.0.1:4242',adminOrigin:'http://127.0.0.1:4231',buildSha256:hash,credentialsSha256:hash,cloneRestoreVerificationSha256:mirrorHash};
 const registered={database:t.database,oid:t.oid,nonce:t.nonce,marker:t.marker,owner:t.owner,host:t.host,port:t.port,instance:{systemIdentifier:t.systemIdentifier},migrationRole:t.migrationRole,migrationRoleOid:t.migrationRoleOid,runtimeRole:t.runtimeRole,runtimeRoleOid:t.runtimeRoleOid,lockKey:t.lockKey};
 const exportReceipt={schema:'zzsh.r07-delivery-clean-export.v1',status:'CLEAN_EXPORT_COMPLETE_WITH_KNOWN_LIMITATIONS',sourceWrites:0,rollbackAck:true,connectionClosed:true,source:{database:t.database,oid:t.oid,systemIdentifier:t.systemIdentifier,marker:t.marker}};
 const cloneRestoreReceipt={schema:'zzsh.r07-clean-clone-restore-verification.v1',status:'CLEAN_CLONE_RESTORE_VERIFIED',sourceExportReceiptSha256:exportSha,source:{database:t.database,oid:t.oid,systemIdentifier:t.systemIdentifier,marker:t.marker},aclMatched:true,criticalRowsMatched:true,readOnlyRollbackAck:true,sourceWrites:0};
 const grant={schema:'zzsh.r07-local-demo-boss-window.v1',status:'APPROVED',action:'LOCAL_CLONE_BOSS_BOOTSTRAP_ONLY',approvalRef:'test-review',financialWrites:false,providerCalls:false,recovery:'READ_ONLY_ONLY_NO_RETRY',attempt:request.attempt,requestSha256:hash,exportReceiptSha256:exportSha,cloneRestoreVerificationSha256:mirrorHash,target:{...t},notBefore:'2026-11-08T00:59:00Z',expiresAt:'2026-11-08T01:10:00Z'};
 return {request,requestSha256:hash,grant,registered,exportReceipt,exportReceiptSha256:exportSha,cloneRestoreReceipt,cloneRestoreVerificationSha256:mirrorHash,now};
}
test('only the completed restore and exact locally registered clone enter the approved window',()=>{assert.equal(assertCloneBossGrant(fixture()).attempt,'r07-local-boss-01');});
for(const [label,mutate] of [
 ['wrong database',x=>x.registered.database='zzsh_test_regression'],['wrong port',x=>x.registered.port=55433],['wrong system',x=>x.registered.instance.systemIdentifier='1'],
 ['wrong oid',x=>x.registered.oid='1'],['wrong nonce',x=>x.registered.nonce='x'],['wrong role',x=>x.registered.runtimeRole='zzsh'],['wrong role oid',x=>x.registered.migrationRoleOid='1'],
 ['wrong marker',x=>x.registered.marker='zzsh:regression-test:v1'],['reset pending',x=>x.registered.pendingReset=true],['wrong output origin',x=>x.request.adminOrigin='https://example.com'],
 ['wrong export',x=>x.exportReceiptSha256=hash],['unclosed export session',x=>x.exportReceipt.connectionClosed=false],['missing restored data evidence',x=>x.cloneRestoreReceipt.criticalRowsMatched=false],
 ['wrong restored source',x=>x.cloneRestoreReceipt.source.oid='1'],['restore transaction not closed',x=>x.cloneRestoreReceipt.readOnlyRollbackAck=false],['different restore hash',x=>x.cloneRestoreVerificationSha256=hash],['wrong action',x=>x.grant.action='OTHER'],
 ['approval missing',x=>delete x.grant.approvalRef],['wrong recovery',x=>x.grant.recovery='RETRY'],['financial authority',x=>x.grant.financialWrites=true],
 ['changed request',x=>x.grant.requestSha256=mirrorHash],['early',x=>x.now=Date.parse('2026-11-08T00:58:59Z')],['expired',x=>x.now=Date.parse('2026-11-08T01:10:00Z')],
 ['excess window',x=>x.grant.expiresAt='2026-11-08T01:30:01Z'],['source mutation',x=>x.cloneRestoreReceipt.sourceWrites=1],
])test('rejects '+label,()=>{const x=fixture();mutate(x);assert.throws(()=>assertCloneBossGrant(x));});
test('rejects payment, provider, worker or management capabilities',()=>{
 const clean={settlementRecordingEnabled:false,testOperationsEnabled:false};assert.doesNotThrow(()=>assertBootstrapOnlyAuth(clean));
 for(const key of ['testOperationsEnabled','userSmsSender','realNameProvider','yunxin','orderImEvents','localFinancialSandbox','localControlledPayments','ecsTestDemo','joinpayCollection','joinpayRefund','joinpayPayout','joinpayAccountRead','distributionScope','distributionReadScope','distributionManagement'])assert.throws(()=>assertBootstrapOnlyAuth({...clean,[key]:true}),key);
 assert.throws(()=>assertBootstrapOnlyAuth({...clean,settlementRecordingEnabled:true}));
});
