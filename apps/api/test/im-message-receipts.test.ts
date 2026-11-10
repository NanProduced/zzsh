import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImReceipt, parseImSendIntent, imFactId, insertImSentFact, planImRevoke, finishImRevoke, readImHistoryFilters, storeImSendIntent } from "../src/im/message-receipts";
import { parseSupportSettings, supportSettings, readSupportWelcome } from "../src/im/support-settings";

const actor={realm:"admin" as const,userId:"staff",sessionId:"session"};
const message={messageClientId:"cid",messageServerId:"4301564702653153301",conversationId:"staff|2|9001",senderId:"staff",createTime:20,messageType:0};
test("receipt boundary accepts only canonical metadata and separates hidden system messages from sent media",()=>{
  assert.deepEqual(parseImReceipt({kind:"receipt",action:"sent",message}).message,message);
  assert.equal(parseImSendIntent(undefined,undefined),undefined);
  for(const bad of [{...message,messageServerId:4301564702653153301},{...message,messageType:4},{...message,createTime:0},{...message,text:"unsent B"},{...message,conversationId:"staff|1|other"}])assert.throws(()=>parseImReceipt({kind:"receipt",action:"sent",message:bad}));
  assert.equal(parseImReceipt({kind:"receipt",action:"hidden",message:{...message,messageType:100}}).message.messageType,100);
  for(const type of [0,1,2,3,6])assert.equal(parseImSendIntent("cid",type)?.messageType,type);
});
test("append-only send facts and authorization keep the original round on replay and reject scope substitution",async()=>{
  const facts=new Map<string,any>();
  const client={query:async(sql:string,v:any[]=[])=>{
    if(sql.startsWith("INSERT")){if(facts.has(v[0]))return {rows:[],rowCount:0};facts.set(v[0],{details:JSON.parse(v.at(-1))});return {rows:[{id:v[0]}],rowCount:1};}
    return {rows:facts.has(v[0])?[facts.get(v[0])]:[]};
  }};
  const intent={appId:"app",threadId:"thread",roundId:"old-round",conversationId:message.conversationId,accountId:"staff",actorId:"staff",realm:"admin" as const,messageClientId:"cid",messageType:0};
  await storeImSendIntent(client as never,intent,actor);await storeImSendIntent(client as never,{...intent,roundId:"new-round"},actor);
  assert.equal(facts.get(imFactId("send_intent","app","staff","cid")).details.roundId,"old-round");
  await assert.rejects(storeImSendIntent(client as never,{...intent,threadId:"other"},actor));
  assert.equal(await insertImSentFact(client as never,"app","staff",actor,message,"old-round"),true);
  assert.equal(await insertImSentFact(client as never,"app","staff",actor,message,"old-round"),false);
  await assert.rejects(insertImSentFact(client as never,"app","staff",actor,{...message,messageServerId:"2"},"old-round"));
});
test("unknown revoke prevents replay and history resurrection; only the matching request may settle it",async()=>{
  let last:any=null;const facts=new Map<string,any>();
  const client={query:async(sql:string,v:any[]=[])=>{
    if(sql.includes("pg_try_advisory"))return {rows:[{locked:true}]};
    if(sql.includes("SELECT DISTINCT ON"))return {rows:last?[{object_id:imFactId("revoke_guard","app","system",message.messageServerId),...last}]:[]};
    if(sql.includes("SELECT action"))return {rows:last?[last]:[]};
    if(sql.startsWith("INSERT")){
      if(sql.includes("'im.message.revoke.started'"))last={action:"im.message.revoke.started",request_id:v[5]};
      else if(sql.includes("'im_message_revoke'"))last={action:v[4],request_id:v[7]};
      else facts.set(v[0],{id:v[0],object_id:v[4]});
      return {rows:[],rowCount:1};
    }
    return {rows:[...facts.values()]};
  }};
  assert.equal(await planImRevoke(client as never,"app","staff",actor,message,"request-a"),"STARTED");
  assert.equal(await planImRevoke(client as never,"app","staff",actor,message,"request-b"),"UNKNOWN");
  assert.ok((await readImHistoryFilters(client as never,"app","staff",[message.messageServerId])).revoked.has(message.messageServerId),
    "an unresolved revoke hides only that message instead of failing the whole page");
  await assert.rejects(finishImRevoke(client as never,"app","staff",actor,message,"request-b",true));
  await finishImRevoke(client as never,"app","staff",actor,message,"request-a",true);
  assert.equal(await planImRevoke(client as never,"app","staff",actor,message,"request-b"),"SUCCEEDED");
  assert.ok((await readImHistoryFilters(client as never,"app","staff",[message.messageServerId])).revoked.has(message.messageServerId));
});
test("assistant configuration requires a separate write grant, CAS and operation replay; defaults stay available",async()=>{
  let row:any=null,permissions=["im.support.management.read"],writes=0;
  const query=async(sql:string,v:any[]=[])=>{
    if(sql.includes('"zzsh_auth_admin"."session"'))return {rows:[{locked:false,twoFactorEnabled:true,suspended:false}]};
    if(sql.includes('"zzsh_iam"."admin_security"'))return {rows:[{status:"ACTIVE",isBoss:false,passwordChangeRequired:false}]};
    if(sql.includes("WITH role_permissions"))return {rows:permissions.map(permissionCode=>({permissionCode}))};
    if(sql.includes("pg_try_advisory"))return {rows:[{locked:true}]};
    if(sql.startsWith("SELECT")&&sql.includes("im_support_settings"))return {rows:row?[row]:[]};
    if(sql.startsWith("INSERT INTO zzsh_iam.im_support_settings")){writes++;row={version:v[1],serviceMessage:v[2],complaintMessage:v[3],updatedBy:v[4],operationId:v[5],updatedAt:new Date(20)};return {rows:[row]};}
    return {rows:[]};
  };
  const options={pool:{query,connect:async()=>({query,release(){}})},appId:"app"} as never;
  const context={userId:"staff",sessionId:"session"} as never,input={version:0,operationId:"operation_00000001",serviceMessage:"欢迎\n请留言",complaintMessage:"请描述问题"};
  assert.equal((await supportSettings(options,context,undefined,"read")).version,0);
  assert.equal((await readSupportWelcome({query} as never,"app","SERVICE")).length,2);
  await assert.rejects(supportSettings(options,context,input,"write"));assert.equal(writes,0);
  permissions.push("im.support.configure");assert.equal((await supportSettings(options,context,input,"write")).version,1);
  assert.equal((await supportSettings(options,context,input,"retry")).version,1);assert.equal(writes,1);
  await assert.rejects(supportSettings(options,context,{...input,operationId:"operation_00000002"},"stale"));
  assert.deepEqual(await readSupportWelcome({query} as never,"app","SERVICE"),[input.serviceMessage]);
  for(const bad of [""," ","${fxCode}","x".repeat(1001),"\u0000"] )assert.throws(()=>parseSupportSettings({...input,serviceMessage:bad}));
});
