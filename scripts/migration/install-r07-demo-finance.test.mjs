import test from 'node:test';import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {validateLocalDemoTarget,validateLocalDemoProofs,validateLocalDemoAuthority,validateLocalDemoEnvironment,validateInstallClaim} from './install-r07-demo-finance.mjs';
const sha='a'.repeat(64),sha2='b'.repeat(64),nonce='62ca9c4e419e1039f500ac1e';
function fixture(){
 const target={host:'127.0.0.1',port:55434,database:'zzsh_test_r07_delivery_20261108',oid:'16391',marker:'zzsh:r07-delivery-clone:v1',nonce,
  instance:{host:'127.0.0.1',port:55434,systemIdentifier:'7705473419326033954'},owner:'zzsh',migrationRole:'zzsh_regression_migration',migrationRoleOid:'16389',
  runtimeRole:'zzsh_regression_runtime',runtimeRoleOid:'16390',lockKey:'806007'};
 const credentials={migration:{name:target.migrationRole,oid:target.migrationRoleOid},runtime:{name:target.runtimeRole,oid:target.runtimeRoleOid}};
 const restore={schema:'zzsh.r07-demo-clone-restored.v1',status:'RESTORED_AND_VERIFIED',target:{host:target.host,port:target.port,database:target.database,oid:target.oid,
  systemIdentifier:target.instance.systemIdentifier,marker:target.marker,nonce,owner:{name:'zzsh',oid:'16388'},migration:{name:target.migrationRole,oid:target.migrationRoleOid},runtime:{name:target.runtimeRole,oid:target.runtimeRoleOid}},
  verification:{sameExportedSnapshot:true,dataSummaryMatched:true,keySetsMatched:true,objectAclMatched:true,roleSecurityMatchedWithDeclaredExceptions:true,rlsAndDefinerMatched:true,runtimeAccessTested:true,sourceWrites:0}};
 const seal={schema:'zzsh.r07-delivery-clean-export.v1',status:'CLEAN_EXPORT_COMPLETE_WITH_KNOWN_LIMITATIONS',sourceWrites:0,rollbackAck:true,connectionClosed:true,
  snapshot:{preflightStateMatched:true,mockTablesPresent:0},source:{database:target.database,oid:target.oid,systemIdentifier:target.instance.systemIdentifier,marker:target.marker,
   owner:'zzsh',ownerOid:'16388',migrationRole:target.migrationRole,migrationRoleOid:target.migrationRoleOid,runtimeRole:target.runtimeRole,runtimeRoleOid:target.runtimeRoleOid},
  dump:{sha256:'6300b631507364517b43ec73bc88b87be514661700ce4266d21397c86148f75f'},acl:{sha256:'670c242af9927f671614bb80917b5f5033ea3a7e2fc0fbf6b00553d330523c17'}};
 const bound=validateLocalDemoTarget(target,credentials,restore,seal),cloneRestore={schema:'zzsh.r07-clean-clone-restore-verification.v1',status:'CLEAN_CLONE_RESTORE_VERIFIED',
  sourceExportReceiptSha256:sha,sourceArchiveSha256:seal.dump.sha256,aclMatched:true,criticalRowsMatched:true,readOnlyRollbackAck:true,sourceWrites:0,
  source:{database:bound.database,oid:bound.oid,systemIdentifier:bound.systemIdentifier,marker:bound.marker},isolatedRestore:{systemIdentifier:'123456'}};
 const boss={schema:'zzsh.r07-local-demo-boss.v1',status:'ACTIVE_AND_VERIFIED',administratorId:'admin_'+('a'.repeat(32)),exportReceiptSha256:sha,cloneRestoreVerificationSha256:sha2,
  target:{host:bound.host,port:bound.port,database:bound.database,oid:bound.oid,systemIdentifier:bound.systemIdentifier,marker:bound.marker,nonce:bound.nonce,runtimeRole:bound.runtimeRole,runtimeRoleOid:bound.runtimeRoleOid},
  auditVerified:true,enrollmentVerified:true,readbackRollbackAck:true,unlockAck:true,connectionsClosed:true,existingIdentityPreserved:true,userAccountsUnchanged:true,financialFactsUnchanged:true,businessFactsUnchanged:true,financialWrites:0,providerCalls:0};
 return {target,credentials,restore,seal,bound,cloneRestore,boss};
}
test('only exact 55434 identity and sealed pre-simulation export are accepted',()=>{
 const x=fixture();assert.equal(validateLocalDemoTarget(x.target,x.credentials,x.restore,x.seal).oid,'16391');
 for(const mutate of [y=>y.target.oid='16390',y=>y.target.port=55433,y=>y.target.instance.systemIdentifier='different',y=>y.restore.target.nonce='bad',
  y=>y.restore.verification.sourceWrites=1,y=>y.seal.snapshot.mockTablesPresent=1,y=>y.seal.dump.sha256='f'.repeat(64),y=>y.seal.rollbackAck=false]){
  const y=fixture();mutate(y);assert.throws(()=>validateLocalDemoTarget(y.target,y.credentials,y.restore,y.seal));
 }
});
test('independently restored sealed archive and fully verified new Boss are mandatory',()=>{
 const x=fixture();assert.equal(validateLocalDemoProofs(x.bound,{sha256:sha},x.cloneRestore,x.boss,sha2),x.boss.administratorId);
 for(const mutate of [y=>y.cloneRestore.status='IN_PROGRESS',y=>y.cloneRestore.sourceExportReceiptSha256=sha2,y=>y.cloneRestore.aclMatched=false,
  y=>y.cloneRestore.isolatedRestore.systemIdentifier=y.bound.systemIdentifier,y=>y.cloneRestore.sourceArchiveSha256=sha,y=>y.cloneRestore.readOnlyRollbackAck=false,
  y=>y.boss.status='PENDING',y=>y.boss.target.oid='1',
  y=>y.boss.financialFactsUnchanged=false,y=>y.boss.providerCalls=1]){
  const y=fixture();mutate(y);assert.throws(()=>validateLocalDemoProofs(y.bound,{sha256:sha},y.cloneRestore,y.boss,sha2));
 }
});
test('authorization is pinned to plan, target, registration, attempt and a bounded UTC window',()=>{
 const x=fixture(),now=Date.parse('2026-11-08T12:00:00.000Z'),base={schema:'zzsh.r07-demo-finance-install-authority.v1',status:'APPROVED',operation:'INSTALL_LOCAL_DEMO_FINANCE',
  planSha256:sha,target:x.bound,registrationDigest:sha2,providerCalls:false,approvalRef:'synthetic',attempt:'synthetic_once',notBefore:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
 assert.doesNotThrow(()=>validateLocalDemoAuthority(base,sha,x.bound,sha2,now));
 for(const patch of [{planSha256:sha2},{registrationDigest:sha},{target:{...x.bound,oid:'1'}},{providerCalls:true},{attempt:''},{notBefore:new Date(now+1000).toISOString()},
  {expiresAt:new Date(now).toISOString()},{expiresAt:new Date(now+1800000).toISOString()}])assert.throws(()=>validateLocalDemoAuthority({...base,...patch},sha,x.bound,sha2,now));
});
test('local runtime settings require explicit four-provider shutdown and original receipt',()=>{
 const x=fixture(),reference='demo_test',restoreRef={path:resolve('synthetic-restore.json'),sha256:sha},appDir=resolve('apps/api');
 const env={APP_PROFILE:'dev',NODE_ENV:'development',PROVIDER_MODE:'fake',LOCAL_DEMO_CLONE_FINANCE_ENABLED:'true',ENABLE_TEST_OPERATIONS:'false',
  JOINPAY_COLLECTION_ENABLED:'false',JOINPAY_REFUND_ENABLED:'false',JOINPAY_PAYOUT_ENABLED:'false',JOINPAY_ACCOUNTS_ENABLED:'false',
  HOST:'127.0.0.1',PORT:'4232',DB_TARGET:'local-compose',DB_HOST:'127.0.0.1',DB_PORT:'55434',DB_NAME:x.bound.database,DB_USER:x.bound.runtimeRole,
  AUTH_API_ORIGIN:'http://127.0.0.1:4232',AUTH_USER_ORIGIN:'http://127.0.0.1:4230',AUTH_ADMIN_ORIGIN:'http://127.0.0.1:4231',
  LOCAL_DEMO_FINANCE_REFERENCE:reference,LOCAL_DEMO_FINANCE_ADMIN_ID:x.boss.administratorId,LOCAL_DEMO_CLONE_RECEIPT_FILE:restoreRef.path,
  LOCAL_DEMO_CLONE_RECEIPT_SHA256:sha,YUNXIN_ENABLED:'true',YUNXIN_APP_KEY:'synthetic-app'};
 assert.doesNotThrow(()=>validateLocalDemoEnvironment(env,x.bound,reference,x.boss.administratorId,restoreRef,appDir));
 for(const patch of [{JOINPAY_REFUND_ENABLED:'true'},{JOINPAY_ACCOUNTS_ENABLED:undefined},{ECS_TEST_DEMO_FINANCE_ENABLED:'true'},
  {DB_PORT:'55433'},{LOCAL_DEMO_CLONE_RECEIPT_SHA256:sha2},{YUNXIN_ENABLED:'false'},{AUTH_USER_ORIGIN:'https://example.test'}])
  assert.throws(()=>validateLocalDemoEnvironment({...env,...patch},x.bound,reference,x.boss.administratorId,restoreRef,appDir));
});
test('unknown commit may only read back the original claimed plan and attempt',()=>{
 const x=fixture(),applied={attempt:'original',approvalRef:'review'},claim={schema:'zzsh.r07-demo-finance-install-claim.v1',planSha256:sha,target:x.bound,
  registrationDigest:sha2,attempt:applied.attempt,approvalRef:applied.approvalRef};
 assert.doesNotThrow(()=>validateInstallClaim(claim,applied,sha,x.bound,sha2));
 for(const changed of [{attempt:'new'},{approvalRef:'other'},{registrationDigest:sha},{target:{...x.bound,oid:'123'}}])
  assert.throws(()=>validateInstallClaim({...claim,...changed},applied,sha,x.bound,sha2));
});
