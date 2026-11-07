import assert from 'node:assert/strict';

// This is a one-time, local-only handoff for the already sealed R07 delivery clone.
// It is deliberately not a general bootstrap capability or an ECS deployment path.
export const R07_CLONE_BOSS_TARGET = Object.freeze({
  database:'zzsh_test_r07_delivery_20261108',oid:'16391',nonce:'62ca9c4e419e1039f500ac1e',
  marker:'zzsh:r07-delivery-clone:v1',host:'127.0.0.1',port:55434,systemIdentifier:'7705473419326033954',
  owner:'zzsh',ownerOid:'16388',migrationRole:'zzsh_regression_migration',migrationRoleOid:'16389',
  runtimeRole:'zzsh_regression_runtime',runtimeRoleOid:'16390',lockKey:'806007',
});
export const R07_CLEAN_EXPORT_SHA='2f939ceba823cb5710f807cd91cd2913b8ec8a1e6a5258a7bbc4c77bb1ab38a4';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const equalTarget=(actual,expected)=>actual&&Object.entries(expected).every(([key,value])=>actual[key]===value);

export function assertCloneBossGrant({request,requestSha256,grant,registered,exportReceipt,exportReceiptSha256,cloneRestoreReceipt,cloneRestoreVerificationSha256,now=Date.now()}){
 const t=R07_CLONE_BOSS_TARGET;
 assert(request?.schema==='zzsh.r07-local-demo-boss-request.v1'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(request.attempt??'')
  &&typeof request.name==='string'&&request.name.trim().length>0&&request.name.length<=120&&!/[\u0000-\u001f\u007f]/.test(request.name)
  &&request.resource==='r07_delivery_clone'&&request.apiOrigin==='http://127.0.0.1:4242'&&request.adminOrigin==='http://127.0.0.1:4231'
  &&hex(requestSha256)&&hex(request.buildSha256)&&hex(request.credentialsSha256)&&hex(request.cloneRestoreVerificationSha256),'R07_BOSS_REQUEST_INVALID');
 assert(registered?.database===t.database&&registered.oid===t.oid&&registered.nonce===t.nonce&&registered.marker===t.marker&&registered.owner===t.owner
  &&registered.host===t.host&&registered.port===t.port&&registered.instance?.systemIdentifier===t.systemIdentifier
  &&registered.migrationRole===t.migrationRole&&registered.migrationRoleOid===t.migrationRoleOid
  &&registered.runtimeRole===t.runtimeRole&&registered.runtimeRoleOid===t.runtimeRoleOid&&registered.lockKey===t.lockKey&&!registered.pendingReset,
 'R07_BOSS_TARGET_CHANGED');
 assert(exportReceiptSha256===R07_CLEAN_EXPORT_SHA&&exportReceipt?.schema==='zzsh.r07-delivery-clean-export.v1'
  &&exportReceipt.status==='CLEAN_EXPORT_COMPLETE_WITH_KNOWN_LIMITATIONS'&&exportReceipt.sourceWrites===0&&exportReceipt.rollbackAck===true
  &&exportReceipt.connectionClosed===true&&exportReceipt.source?.oid===t.oid&&exportReceipt.source?.systemIdentifier===t.systemIdentifier
  &&exportReceipt.source?.database===t.database&&exportReceipt.source?.marker===t.marker,'R07_BOSS_EXPORT_EVIDENCE_INVALID');
 assert(hex(cloneRestoreVerificationSha256)&&request.cloneRestoreVerificationSha256===cloneRestoreVerificationSha256&&cloneRestoreReceipt?.schema==='zzsh.r07-clean-clone-restore-verification.v1'
  &&cloneRestoreReceipt.status==='CLEAN_CLONE_RESTORE_VERIFIED'&&cloneRestoreReceipt.sourceExportReceiptSha256===R07_CLEAN_EXPORT_SHA
  &&cloneRestoreReceipt.source?.database===t.database&&cloneRestoreReceipt.source?.oid===t.oid&&cloneRestoreReceipt.source?.systemIdentifier===t.systemIdentifier
  &&cloneRestoreReceipt.source?.marker===t.marker&&cloneRestoreReceipt.aclMatched===true&&cloneRestoreReceipt.criticalRowsMatched===true
  &&cloneRestoreReceipt.readOnlyRollbackAck===true&&cloneRestoreReceipt.sourceWrites===0,'R07_BOSS_CLONE_RESTORE_EVIDENCE_INVALID');
 const start=Date.parse(grant?.notBefore??''),end=Date.parse(grant?.expiresAt??'');
 assert(grant?.schema==='zzsh.r07-local-demo-boss-window.v1'&&grant.status==='APPROVED'&&grant.action==='LOCAL_CLONE_BOSS_BOOTSTRAP_ONLY'
  &&/^[A-Za-z0-9._:-]{1,128}$/.test(grant.approvalRef??'')&&grant.financialWrites===false&&grant.providerCalls===false&&grant.recovery==='READ_ONLY_ONLY_NO_RETRY'
  &&grant.attempt===request.attempt&&grant.requestSha256===requestSha256&&grant.exportReceiptSha256===R07_CLEAN_EXPORT_SHA
  &&grant.cloneRestoreVerificationSha256===cloneRestoreVerificationSha256&&equalTarget(grant.target,t)
  &&Number.isFinite(start)&&Number.isFinite(end)&&new Date(start).toISOString()===grant.notBefore&&new Date(end).toISOString()===grant.expiresAt
  &&end>start&&end-start<=30*60_000&&now>=start&&now<end,'R07_BOSS_WINDOW_INVALID');
 return Object.freeze({attempt:request.attempt,expiresAt:end,target:t});
}

export function assertBootstrapOnlyAuth(auth){
 assert(auth&&auth.settlementRecordingEnabled===false&&!auth.testOperationsEnabled&&!auth.userSmsSender&&!auth.realNameProvider
  &&!auth.yunxin&&!auth.orderImEvents&&!auth.localFinancialSandbox&&!auth.localControlledPayments&&!auth.ecsTestDemo
  &&!auth.joinpayCollection&&!auth.joinpayRefund&&!auth.joinpayPayout&&!auth.joinpayAccountRead
  &&!auth.distributionScope&&!auth.distributionReadScope&&!auth.distributionManagement,'R07_BOSS_CAPABILITY_NOT_CLOSED');
}
