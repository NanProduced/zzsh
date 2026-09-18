import assert from "node:assert/strict";
import { test } from "node:test";
import { ORDER_TEAM_CONFIGURATION, YunxinServerApiClient, validateOrderTeamInput } from "../src/im/yunxin-provider";
import { OrderTeamTransport } from "./order-team-fixtures";
const input={appId:"fixture",orderId:"order_1",name:"三角洲行动|订单:ZZ260918-000001",ownerAccountId:"sys",memberAccountIds:["buyer","owner","staff"],membersLimit:200};
test("order wrapper uses its own name/marker/capacity and reads actual configuration and all member roles",async()=>{
  const wire=new OrderTeamTransport();const created=await wire.client.createOrderTeam(input);const team=await wire.client.readOrderTeam(created.teamId);
  assert.equal(wire.creates[0]!.name,input.name);assert.equal(wire.creates[0]!.members_limit,200);
  assert.deepEqual(JSON.parse(wire.creates[0]!.server_extension),{schema:"zzsh.im-order.v1",appId:"fixture",orderId:"order_1"});
  assert.deepEqual(team?.configuration,ORDER_TEAM_CONFIGURATION);assert.deepEqual(team?.members.map(m=>m.role),[1,0,0,0]);
  assert.equal(wire.calls.filter(c=>c.startsWith("GET")).length,2);
  wire.partial=true;const partial=await wire.client.createOrderTeam(input);assert.equal(partial.partial,true);assert.ok(partial.teamId);
  assert.throws(()=>validateOrderTeamInput({...input,name:"长".repeat(65)}));assert.throws(()=>validateOrderTeamInput({...input,membersLimit:5001}));
});
test("order read fails closed on malformed/missing fields, duplicate members, wrong IDs and non-Team absence",async()=>{
  for(const tweak of [
    (t:any)=>{delete t.info.configuration.invite_mode;},(t:any)=>{t.info.team_id="999";},
    (t:any)=>{t.info.clientCustom="conflicting marker";},(t:any)=>{t.members[1]=t.members[0];},
    (t:any)=>{t.members[0].team_id="999";},(t:any)=>{t.info.member_count=5;},
  ]){const w=new OrderTeamTransport();w.tweak=tweak;const made=await w.client.createOrderTeam(input);await assert.rejects(w.client.readOrderTeam(made.teamId));}
  for(const code of [109404,414,500,undefined]){
    const client=new YunxinServerApiClient({appKey:"fixture",appSecret:"fixture",fetch:async()=>Response.json({code})});await assert.rejects(client.readOrderTeam("123"));
  }
  const client=new YunxinServerApiClient({appKey:"fixture",appSecret:"fixture",fetch:async()=>Response.json({code:108404})});assert.equal(await client.readOrderTeam("123"),null);
});
