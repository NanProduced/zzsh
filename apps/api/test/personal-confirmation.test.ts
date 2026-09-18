import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { signConfirmation, verifyConfirmation } from "../src/order/confirmation-token";
import { parseMembershipChange } from "../src/auth/rental-membership";
import { confirmationInput } from "../src/order/personal-confirmation";
import { personalOrderInput } from "../src/order/personal-order";

const key={keyId:"fixture",secret:"isolated-fixture-only-not-production-key"};
const binding={userId:"user-1",sessionId:"session-1",accountId:"account-1",versionId:"version-1",releaseId:"release-1",listingHash:"a".repeat(64),quoteDigest:"b".repeat(64)};
test("personal confirmation fixed HMAC, strict claims, expiry and rebuilt evidence binding",()=>{
  const signed=signConfirmation(binding,1000,key);
  assert.equal(verifyConfirmation(signed.token,binding,1001,key).confirmationId,signed.claims.confirmationId);
  assert.throws(()=>signConfirmation(binding,1000,undefined),(e:any)=>e.status===503);
  for(const name of Object.keys(binding) as (keyof typeof binding)[])assert.throws(()=>verifyConfirmation(signed.token,{...binding,[name]:name.endsWith("Hash")||name.endsWith("Digest")?"c".repeat(64):"other"},1001,key));
  assert.throws(()=>verifyConfirmation(signed.token,binding,1300,key),(e:any)=>e.code==="CONFIRMATION_EXPIRED");
  for(const token of [null,"",signed.token+"a","x".repeat(4097),signed.token.replace(/^./,"x")])assert.throws(()=>verifyConfirmation(token,binding,1001,key));
  assert.throws(()=>verifyConfirmation(signed.token,binding,1001,{...key,secret:"wrong-"+key.secret}));
  const resign=(claims:unknown)=>{const bytes=Buffer.from(JSON.stringify(claims)).toString("base64url");return bytes+"."+createHmac("sha256",key.secret).update(bytes).digest("base64url");};
  for(const patch of [{alg:"none"},{schema:"unknown"},{keyId:"other"},{audience:"other"},{issuedAt:1002,expiresAt:1302},{expiresAt:1400},{ownerAmount:"secret"}])assert.throws(()=>verifyConfirmation(resign({...signed.claims,...patch}),binding,1001,key));
  const decoded=JSON.parse(Buffer.from(signed.token.split(".")[0]!,"base64url").toString());
  assert.deepEqual(Object.keys(decoded).sort(),[...Object.keys(binding),"schema","audience","keyId","confirmationId","issuedAt","expiresAt"].sort());
  for(const field of ["tier","sourceRef","ownerAmount","platformFullProfit","publisherBailRequirementCents","inventory"])assert.equal(field in decoded,false);
});
test("membership and confirmation inputs reject client-controlled prices and invalid tier/version",()=>{
  const change={tier:"VIP",expectedVersion:"0",sourceRef:"fixture:grant",reason:"isolated grant"};
  assert.equal(parseMembershipChange(change).tier,"VIP");
  for(const tier of [null,0,{},"PREFERENTIAL","ADMIN",""])assert.throws(()=>parseMembershipChange({...change,tier}));
  for(const expectedVersion of [null,1,"-1","1.1","01"])assert.throws(()=>parseMembershipChange({...change,expectedVersion}));
  assert.throws(()=>parseMembershipChange({...change,extra:true}));
  assert.throws(()=>parseMembershipChange({...change,reason:""}));
  const input={accountId:"account-1",versionId:"version-1",releaseId:"release-1"};
  for(const extra of [{tier:"VIP"},{tenantDeposit:0},{userId:"other"},{V:"2"},{confirmationToken:"x"}])assert.throws(()=>confirmationInput({...input,...extra}));
});

test("v2 creation bounds the original credential body without pre-validating successful replays",()=>{
  assert.deepEqual(personalOrderInput({confirmationToken:"opaque-original"}),{confirmationToken:"opaque-original"});
  for(const confirmationToken of [null,0,{},"","x".repeat(4097)])assert.throws(()=>personalOrderInput({confirmationToken}));
  for(const extra of [{tier:"VIP"},{rentalAmountCents:"0"},{accountId:"other"}])assert.throws(()=>personalOrderInput({confirmationToken:"opaque-original",...extra}));
});
