import assert from "node:assert/strict";
import { test } from "node:test";
import { createNimReceiptReporter, NimReceiptActionError } from "../../../packages/im-client/src/message-receipts.ts";
import { nimMessageView } from "../../../packages/im-client/src/nim-web-client.ts";

test("server history reuses SDK media validation and strips revoked or unsafe attachments",()=>{
  const raw={messageClientId:"file",messageType:6,attachment:{name:"fixture.txt",size:52,url:"https://nos.example/fixture.txt"}};
  assert.equal(nimMessageView(raw).media.kind,"file");assert.equal(nimMessageView(raw).media.mimeType,"text/plain");
  assert.equal(nimMessageView({...raw,attachment:{...raw.attachment,url:"javascript:alert(1)"}}).media,undefined);
  assert.equal(nimMessageView({...raw,revoked:true}).attachment,undefined);assert.equal(nimMessageView({...raw,revoked:true}).media,undefined);
});

function storage(){const data=new Map();return {data,get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
const message={messageClientId:"client-1",messageServerId:"4301564702653153301",conversationId:"user|2|9001",senderId:"user",createTime:20,messageType:0};
const receipt={kind:"receipt",action:"sent",message};
test("SDK success registration survives an offline reload, stays scoped, and accepts only a recorded acknowledgement",async()=>{
  const disk=storage(),statuses=[],bodies=[];let online=false;
  const options={endpoint:"/api/im/messages",scope:"app:user",storage:disk,status:s=>statuses.push(s),fetch:async(_,init)=>{bodies.push(JSON.parse(init.body));return Response.json(online?{recorded:true}:{recorded:false},{status:online?200:503});}};
  const first=createNimReceiptReporter(options);first.record(receipt);await first.flush();first.close();
  assert.equal(disk.length,1);assert.equal(statuses.at(-1).failed,true);assert.equal(statuses.at(-1).pending,1);
  assert.deepEqual(Object.keys(bodies[0].message).sort(),Object.keys(message).sort());assert.doesNotMatch(JSON.stringify(bodies),/text|url|token|cookie/);
  const other=createNimReceiptReporter({...options,scope:"app:other"});await other.flush();assert.equal(bodies.length,1);other.close();
  online=true;const next=createNimReceiptReporter(options);try{await next.flush();assert.equal(disk.length,0);assert.equal(statuses.at(-1).pending,0);assert.deepEqual(bodies[1],receipt);}finally{next.close();}
});
test("a lost ACK can be replayed with the identical identity; a late old-client SDK result is stored without sending as the new actor",async()=>{
  const disk=storage(),sent=[];let calls=0;
  const report=createNimReceiptReporter({endpoint:"/api/im/messages",scope:"app:old",storage:disk,fetch:async(_,init)=>{sent.push(JSON.parse(init.body));if(++calls===1)throw new TypeError("ACK lost");return Response.json({recorded:true});}});
  report.record(receipt);await report.flush();await report.flush();report.close();assert.deepEqual(sent,[receipt,receipt]);assert.equal(disk.length,0);
  report.record({...receipt,message:{...message,messageClientId:"late"}});await report.flush();assert.equal(sent.length,2);assert.equal(disk.length,1);
});
test("quota failure is visible; malformed saved state is retained; separate writers do not overwrite one another",async()=>{
  const disk=storage(),states=[];const opts={endpoint:"/api/im/messages",scope:"app:user",storage:disk,fetch:async()=>Response.json({},{status:503})};
  const a=createNimReceiptReporter(opts),b=createNimReceiptReporter(opts);a.record(receipt);b.record({...receipt,message:{...message,messageClientId:"other",messageServerId:"2"}});a.close();b.close();assert.equal(disk.length,2);
  const key=[...disk.data.keys()][0];disk.setItem(key,"malformed");const bad=createNimReceiptReporter({...opts,status:s=>states.push(s)});bad.close();assert.equal(disk.getItem(key),"malformed");assert.equal(states.at(-1).failed,true);
  const full=createNimReceiptReporter({...opts,storage:{...disk,setItem(){throw Error("quota");}},status:s=>states.push(s)});full.record(receipt);assert.equal(states.at(-1).persistent,false);full.close();
});
test("revoke UNKNOWN is exposed and never retried by the reporter",async()=>{
  let calls=0;const reporter=createNimReceiptReporter({endpoint:"/api/im/messages",scope:"app:user",storage:storage(),fetch:async()=>{calls++;return Response.json({outcome:"UNKNOWN"},{status:503});}});
  try{await assert.rejects(reporter.revoke(message),e=>e instanceof NimReceiptActionError&&e.unknown);await reporter.flush();assert.equal(calls,1);}finally{reporter.close();}
});
