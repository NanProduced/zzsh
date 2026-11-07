import assert from "node:assert/strict";
import test from "node:test";
import { assertCaptureAuthority, assertCaptureCloneBinding } from "./complete-r07-account-capture.mjs";

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
