import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import * as resource from "../src/finance/ecs-test-demo-resource";
import { assertDemoWithdrawalIdentity } from "../src/finance/demo-withdrawal-identity";

test("demo withdrawal requires an adult verified identity; fake identity is local only",async t=>{
  const demo={} as resource.DemoFinanceResource, now=new Date("2026-01-02T00:00:00Z");
  let scope:"ECS_TEST_SIMULATED"|"LOCAL_DEMO_SIMULATED"="ECS_TEST_SIMULATED";
  t.mock.method(resource,"demoFinanceScope",()=>scope);
  let row={account_status:"ACTIVE",identity_status:"VERIFIED",age_status:"ADULT",provider:"aliyun-id2meta",provider_reference:"real-ref-1",verified_at:new Date("2026-01-01T00:00:00Z"),now};
  const client={query:async(_sql:string,values:unknown[])=>{assert.deepEqual(values,["user_1"]);return{rows:[row]};}} as unknown as PoolClient;
  await assert.doesNotReject(assertDemoWithdrawalIdentity(client,"user_1",demo));
  for(const [changed,code] of [[{identity_status:"UNVERIFIED"},"DEMO_WITHDRAW_IDENTITY_REQUIRED"],
    [{age_status:"MINOR"},"DEMO_WITHDRAW_ADULT_REQUIRED"],[{age_status:"UNKNOWN"},"DEMO_WITHDRAW_ADULT_REQUIRED"],
    [{account_status:"FROZEN"},"DEMO_WITHDRAW_IDENTITY_REQUIRED"],[{provider:"fake",provider_reference:"fake_123"},"DEMO_WITHDRAW_IDENTITY_SOURCE_UNCONFIRMED"],
    [{provider_reference:"test_reference"},"DEMO_WITHDRAW_IDENTITY_SOURCE_UNCONFIRMED"],[{verified_at:new Date("2026-01-03T00:00:00Z")},"DEMO_WITHDRAW_IDENTITY_SOURCE_UNCONFIRMED"]] as const){
    const before=row;row={...row,...changed};await assert.rejects(assertDemoWithdrawalIdentity(client,"user_1",demo),error=>(error as {code?:string}).code===code);row=before;
  }
  scope="LOCAL_DEMO_SIMULATED";row={...row,provider:"fake",provider_reference:"fake_123"};
  await assert.doesNotReject(assertDemoWithdrawalIdentity(client,"user_1",demo));
});
