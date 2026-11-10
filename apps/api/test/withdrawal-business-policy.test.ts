import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWithdrawalBusinessPolicyMatches, loadWithdrawalBusinessPolicy, parseWithdrawalBusinessPolicy, quoteWithdrawalBusinessAmounts, TEAM_TEST_WITHDRAWAL_POLICY } from "../src/finance/withdrawal-business-policy";

test("real and simulated payouts share exact amount, balance and quota limits",()=>{
 const base={amountCents:"10000",availableCents:"10000",used:0,minCents:"200",maxCents:"1000000",maxIntents:2,fee:{kind:"FIXED" as const,cents:"100"}};
 assert.deepEqual(quoteWithdrawalBusinessAmounts(base),{grossCents:"10000",netCents:"9900",feeCents:"100"});
 for(const patch of [{amountCents:"199"},{amountCents:"1000001"},{amountCents:"0"},{availableCents:"9999"},{used:2}])
  assert.throws(()=>quoteWithdrawalBusinessAmounts({...base,...patch}),(e:any)=>e.status===409);
 for(const patch of [{availableCents:"-1"},{used:"unknown"},{minCents:"0"}])
  assert.throws(()=>quoteWithdrawalBusinessAmounts({...base,...patch}),(e:any)=>e.status===503);
});

test("approved test withdrawal values have one validated business policy",()=>{
  const policy=parseWithdrawalBusinessPolicy(TEAM_TEST_WITHDRAWAL_POLICY);
  assert.deepEqual([policy.minCents,policy.maxCents,policy.fee,policy.maxIntents,policy.quotaUtcOffsetMinutes],
    ["200","1000000",{kind:"FIXED",cents:"100"},2,480]);
  assert.equal(policy.frequencyBasis,"ACTIVE_OR_SUCCEEDED");
  assert.equal(policy.reviewStrategy,"VERIFIED_DIRECT_EXECUTION");
  assert.equal(Object.isFrozen(policy),true);
  assert.equal(Object.isFrozen(policy.fee),true);
});

test("shared withdrawal policy rejects malformed limits, fee, quota and configuration",()=>{
  for(const patch of [
    {minCents:"0"},{minCents:"1000001"},{maxCents:"0"},{maxIntents:0},{maxIntents:1.5},
    {quotaUtcOffsetMinutes:841},{frequencyBasis:"UNKNOWN"},{reviewStrategy:"UNKNOWN"},{fee:{kind:"FIXED",cents:"200"}},
    {fee:{kind:"RATIO",numerator:"1",denominator:"0",rounding:"HALF_UP_CENT"}},{unexpected:true},
  ])assert.throws(()=>parseWithdrawalBusinessPolicy({...TEAM_TEST_WITHDRAWAL_POLICY,...patch}),/USER_WITHDRAWAL_POLICY_INVALID/);
  assert.equal(loadWithdrawalBusinessPolicy({},"."),undefined);
  assert.throws(()=>loadWithdrawalBusinessPolicy({USER_WITHDRAWAL_POLICY:"{}",USER_WITHDRAWAL_POLICY_FILE:"x"},"."),/USER_WITHDRAWAL_POLICY_INVALID/);
  assert.throws(()=>loadWithdrawalBusinessPolicy({USER_WITHDRAWAL_POLICY:"not-json"},"."),/USER_WITHDRAWAL_POLICY_INVALID/);
});

test("formal payout rules must match the same business values without replacing reviewed evidence",()=>{
  const input={...TEAM_TEST_WITHDRAWAL_POLICY,fee:{cents:"100",kind:"FIXED" as const}};
  const policy=loadWithdrawalBusinessPolicy({USER_WITHDRAWAL_POLICY:JSON.stringify(input)},".");assert(policy);
  assert.doesNotThrow(()=>assertWithdrawalBusinessPolicyMatches(policy,input));
  for(const patch of [{version:"other"},{minCents:"300"},{maxIntents:3},{reviewStrategy:"MERCHANT_REVIEW_REQUIRED" as const},{fee:{kind:"FIXED" as const,cents:"50"}},{quotaUtcOffsetMinutes:0}])
    assert.throws(()=>assertWithdrawalBusinessPolicyMatches(policy,{...input,...patch}),/USER_WITHDRAWAL_POLICY_MISMATCH/);
});
