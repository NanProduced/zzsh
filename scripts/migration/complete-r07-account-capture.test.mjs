import assert from "node:assert/strict";
import test from "node:test";
import { assertCaptureAuthority, assertCaptureCloneBinding, assertCaptureRestoreBinding, assertCaptureApplyReceipt } from "./complete-r07-account-capture.mjs";

test("account capture maintenance refuses R07, unregistered targets and changed source identities",()=>{
  const dataset="a".repeat(64),target={instance:{systemIdentifier:"1234"},marker:"zzsh:r07-delivery-clone:v1",oid:"123",nonce:"n",
    owner:"owner",migrationRole:"migration",migrationRoleOid:"42",runtimeRoleOid:"43",protectedDataset:{manifestSha256:dataset},pendingReset:null};
  const credentials={migration:{name:"migration",oid:"42"}},actor={realm:"admin",resourceOid:"123",nonce:"n",id:"admin",sessionId:"session"};
  assert.doesNotThrow(()=>assertCaptureCloneBinding(target,credentials,actor,dataset));
  for(const patch of [{instance:{systemIdentifier:"7704972584346443810"}},{instance:null},{marker:"zzsh:regression-test:v1"},
    {pendingReset:{}},{oid:"999"},{protectedDataset:{manifestSha256:"b".repeat(64)}},{migrationRoleOid:null}])
    assert.throws(()=>assertCaptureCloneBinding({...target,...patch},credentials,actor,dataset),/CAPTURE_CLONE_BINDING_REQUIRED/);
  assert.throws(()=>assertCaptureCloneBinding(target,credentials,{...actor,sessionId:""},dataset),/CAPTURE_CLONE_BINDING_REQUIRED/);
});

test("capture requires the sealed clone restore proof with exact target identities",()=>{
 const target={database:"zzsh_test_r07_delivery_20261108",instance:{systemIdentifier:"123"},oid:"50",nonce:"n",marker:"zzsh:r07-delivery-clone:v1",host:"127.0.0.1",port:55434,
  owner:"zzsh",migrationRole:"migration",migrationRoleOid:"51",runtimeRole:"runtime",runtimeRoleOid:"52"};
 const checks={sameExportedSnapshot:true,dataSummaryMatched:true,keySetsMatched:true,objectAclMatched:true,roleSecurityMatchedWithDeclaredExceptions:true,rlsAndDefinerMatched:true,runtimeAccessTested:true,sourceWrites:0};
 const proof={schema:"zzsh.r07-demo-clone-restored.v1",status:"RESTORED_AND_VERIFIED",source:{database:"zzsh_test_regression",systemIdentifier:"7704972584346443810",oid:"16390",marker:"zzsh:regression-test:v1",archiveSha256:"a".repeat(64),aclSha256:"b".repeat(64)},
  target:{database:target.database,systemIdentifier:"123",oid:"50",nonce:"n",marker:target.marker,host:target.host,port:target.port,owner:{name:"zzsh",oid:"49"},migration:{name:"migration",oid:"51"},runtime:{name:"runtime",oid:"52"}},verification:checks};
 assert.doesNotThrow(()=>assertCaptureRestoreBinding(proof,target));
 for(const p of [{status:"STARTED"},{source:{...proof.source,systemIdentifier:"4"}},{target:{...proof.target,oid:"51"}},
  {target:{...proof.target,runtime:{name:"runtime",oid:"53"}}},{verification:{...checks,keySetsMatched:false}},{verification:{...checks,sourceWrites:1}}])
  assert.throws(()=>assertCaptureRestoreBinding({...proof,...p},target),/CAPTURE_RESTORE_BINDING_REQUIRED/);
});

test("capture readback accepts only the original acknowledged or uncertain commit",()=>{
 const target={oid:"50"},planSha="a".repeat(64),receipt={schema:"zzsh.r07-capture-fact-receipt.v1",status:"COMMIT_ACK_READBACK_REQUIRED",commitSent:true,commitAck:true,
  target,planSha256:planSha,approvalRef:"review",attempt:"once",notBefore:"2026-11-08T00:00:00.000Z",expiresAt:"2026-11-08T00:30:00.000Z",unlockAck:true,connectionsClosed:true};
 assert.doesNotThrow(()=>assertCaptureApplyReceipt(receipt,planSha,target));
 assert.doesNotThrow(()=>assertCaptureApplyReceipt({...receipt,status:"COMMIT_UNKNOWN",commitAck:false},planSha,target));
 for(const p of [{status:"STOPPED"},{status:"COMMIT_REQUESTED"},{commitSent:false},{commitAck:false},{unlockAck:false},{connectionsClosed:false},
  {planSha256:"b".repeat(64)},{target:{oid:"51"}},{expiresAt:"2026-11-08T00:30:00.001Z"}])
  assert.throws(()=>assertCaptureApplyReceipt({...receipt,...p},planSha,target),/CAPTURE_APPLY_UNCONFIRMED/);
});

test("review window is tied to the exact clone, plan, count and nonfinancial operation",()=>{
  const start=Date.parse("2026-11-07T00:00:00Z"),target={oid:"1"},plan={target,facts:[{},{}]},planSha="a".repeat(64);
  const authority={schema:"zzsh.r07-capture-fact-authority.v1",status:"APPROVED",operation:"APPEND_SOURCE_BOUND_ACCOUNT_CAPTURE",
    planSha256:planSha,target,maxAccounts:2,allowFinancialWrites:false,approvalRef:"review-1",attempt:"attempt-1",
    notBefore:new Date(start).toISOString(),expiresAt:new Date(start+1800000).toISOString()};
  assert.doesNotThrow(()=>assertCaptureAuthority(authority,plan,planSha,start+1000));
  for(const patch of [{target:{oid:"2"}},{planSha256:"b".repeat(64)},{maxAccounts:1},{allowFinancialWrites:true},
    {approvalRef:""},{attempt:""},{expiresAt:new Date(start+1800001).toISOString()}])
    assert.throws(()=>assertCaptureAuthority({...authority,...patch},plan,planSha,start+1000),/CAPTURE_AUTHORITY_CHANGED/);
  assert.throws(()=>assertCaptureAuthority(authority,plan,planSha,start+1800000),/CAPTURE_AUTHORITY_CHANGED/);
});
