import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { scanOrderEscalations, type OrderTeamOptions } from "../src/im/order-team";
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
test("same-Team add and fixed bot notice use the signed server APIs with no client message text",async()=>{
  const wire=new OrderTeamTransport();const created=await wire.client.createOrderTeam(input);
  await wire.client.addSupportTeamMember(created.teamId,"sys","replacement");
  await wire.client.sendOrderTeamNotice(created.teamId,"sys");
  assert.equal(wire.calls.filter(call=>call.includes("/im/v2/team_members")).length,1);
  assert.deepEqual(wire.adds[0],{operator_id:"sys",team_id:Number(created.teamId),team_type:1,invite_account_ids:["replacement"],msg:"洲洲商行客服咨询转交"});
  assert.match(wire.calls.find(call=>call.includes("/im/v2/conversations/"))??"",/\/im\/v2\/conversations\/sys%7C2%7C\d+\/messages$/);
  assert.deepEqual(wire.notices[0],{message:{message_type:0,text:"客服正在为您安排接待，请稍候。"}});
  const invalid=new YunxinServerApiClient({appKey:"fixture",appSecret:"fixture",fetch:async()=>Response.json({code:200,data:{
    message_client_id:"notice",sender_id:"other",conversation_type:2,receiver_id:created.teamId,create_time:Date.now(),message_type:0,
  }})});
  await assert.rejects(invalid.sendOrderTeamNotice(created.teamId,"sys"));
});

test("Server API bot routing is an opt-in top-level route_config, independent from SDK params",async()=>{
  const calls:{url:string;body:unknown}[]=[];
  const client=new YunxinServerApiClient({appKey:"fixture",appSecret:"fixture",fetch:async(input,init)=>{
    const url=String(input),body=JSON.parse(String(init?.body));calls.push({url,body});
    return Response.json({code:200,data:{message_client_id:"notice-1",sender_id:"sys",conversation_type:2,receiver_id:"9001",create_time:Date.now(),message_type:0}});
  }});
  await client.sendOrderTeamNotice("9001","sys");
  await client.sendOrderTeamNotice("9001","sys",{routeEnabled:true,routeEnvironment:"oim4d-test"});
  assert.deepEqual(calls.map(call=>call.body),[
    {message:{message_type:0,text:"客服正在为您安排接待，请稍候。"}},
    {message:{message_type:0,text:"客服正在为您安排接待，请稍候。"},route_config:{route_enabled:true,route_environment:"oim4d-test"}},
  ]);
  assert.ok(calls.every(call=>call.url.endsWith("/im/v2/conversations/sys%7C2%7C9001/messages")));
});

test("small escalation budgets rotate across all phases and the default keeps its full budget",async()=>{
  const phases=["expired","reminder","due","pending","recoverable"];
  const runner=(appId:string)=>{
    const calls:{phase:string;limit:number}[]=[];
    const pool={query:async(sql:string,params?:unknown[])=>{
      const phase=sql.includes("op.lease_until<=")?"expired":sql.includes("g.remind_due_at<=")?"reminder"
        :sql.includes("g.next_add_due_at<=")?"due":sql.includes("op.state='PENDING'")?"pending":"recoverable";
      calls.push({phase,limit:Number(params?.[1])});return{rows:[]};
    }} as unknown as Pool;
    const options={pool,appId,provider:{},identities:{},membersLimit:4,firstResponseEnabled:true,escalationEnabled:true} as OrderTeamOptions;
    return{calls,options};
  };
  for(const limit of [1,2,3,4]){
    const run=runner(`budget-${limit}`);
    for(let tick=0;tick<5;tick++){
      const start=run.calls.length;await scanOrderEscalations(run.options,limit);
      assert.equal(run.calls.slice(start).reduce((sum,call)=>sum+call.limit,0),limit);
    }
    assert.deepEqual([...new Set(run.calls.map(call=>call.phase))].sort(),phases.slice().sort());
  }
  const run=runner("budget-default");await scanOrderEscalations(run.options);
  assert.deepEqual(Object.fromEntries(run.calls.map(call=>[call.phase,call.limit])),Object.fromEntries(phases.map(phase=>[phase,2])));
});
