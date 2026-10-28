// SYNTHETIC_COMPONENT_MODEL：注入无socket替身；提交丢ACK仅控制流模型，不是真PG或真实商户证据。
import test from "node:test";
import assert from "node:assert/strict";
import type {Pool,PoolClient} from "pg";
import {exchangePayoutRequest,executeJoinpayPayout,queryJoinpayPayout,PayoutCommitUnknown,receiveJoinpayPayoutNotification} from "../src/finance/joinpay-payout-attempt";
import {handleJoinpayPayoutNotification,JOINPAY_PAYOUT_NOTIFICATION_PATH} from "../src/finance/joinpay-payout-notification-routes";
const H="a".repeat(64),profileModule=()=>require("../src/finance/joinpay-payout-profile");
test("任意对象、旧Synthetic form或JSON克隆没有私有outbound能力",async()=>{
 for(const request of [{},{operation:"SUBMIT",sendable:true},{operation:"QUERY",evidenceLevel:"OFFICIAL"}])await assert.rejects(exchangePayoutRequest(request as any));
});
test("SYNTHETIC_COMPONENT_MODEL：合成目的对fake/global/wrapper一律0send，依赖getter也不读取",async t=>{
 const p=profileModule();t.mock.method(p,"readPayoutOutbound",()=>({purpose:"SYNTHETIC_PROTOCOL",endpoint:"https://example.invalid",body:"{}"}));let gets=0,sends=0;
 const deps={get fetch(){gets++;return(async()=>{sends++;return new Response("{}");}) as typeof fetch;}};
 for(const d of [deps,{fetch:globalThis.fetch},{fetch:(...a:any[])=>globalThis.fetch(a[0],a[1])}])await assert.rejects(exchangePayoutRequest({} as any,d as any),/PAYOUT_SYNTHETIC_TRANSPORT_FORBIDDEN/);assert.equal(gets,0);assert.equal(sends,0);
});
test("SYNTHETIC_COMPONENT_MODEL：JSON原字节一次发送、fetch getter一次、非200完整及超限前缀如实保留",async t=>{
 const p=profileModule(),body='{"amount":0.00,"hmac":"fixture"}';t.mock.method(p,"readPayoutOutbound",()=>({purpose:"MERCHANT_PAYOUT",endpoint:"https://example.invalid/singlePay",body}));let reads=0,calls=0;
 const deps={get fetch(){reads++;return(async(url:unknown,init:any)=>{calls++;assert.equal(url,"https://example.invalid/singlePay");assert.equal(init.body,body);assert.equal(init.method,"POST");assert.equal(init.redirect,"error");assert.equal(init.credentials,"omit");assert.equal(init.headers["content-type"],"application/json; charset=UTF-8");return new Response("fixture",{status:503});}) as typeof fetch;}};
 const r=await exchangePayoutRequest({} as any,deps);assert.equal(calls,1);assert.equal(reads,1);assert.equal(r.failure,"HTTP_STATUS");assert.equal(r.responseComplete,true);assert.equal(Buffer.from(r.body!).toString(),"fixture");assert.equal(r.evidenceLevel,"SYNTHETIC_PROTOCOL");
 const huge=await exchangePayoutRequest({} as any,{fetch:(async()=>new Response(new Uint8Array(70000))) as typeof fetch});assert.equal(huge.failure,"BODY_TOO_LARGE");assert.equal(huge.responseComplete,false);assert.equal(huge.body!.length,65536);assert.equal(huge.receivedBytes,70000);
 const no=await exchangePayoutRequest({} as any,{fetch:(async()=>{throw Error("SYNTHETIC_PRIVATE_DETAIL");}) as typeof fetch});assert.equal(no.failure,"NETWORK_ERROR");assert.equal(no.body,null);assert.equal(JSON.stringify(no).includes("PRIVATE"),false);
});
test("SYNTHETIC_COMPONENT_MODEL：timer尚未回调但单调deadline已过，不能验成完整成功",async t=>{
 t.mock.method(profileModule(),"readPayoutOutbound",()=>({purpose:"MERCHANT_PAYOUT",endpoint:"https://example.invalid",body:"{}"}));let now=0;t.mock.method(performance,"now",()=>now);
 const r=await exchangePayoutRequest({} as any,{fetch:(async()=>{now=8001;return new Response("late");}) as typeof fetch});assert.equal(r.failure,"TIMEOUT");assert.equal(r.responseComplete,false);assert.equal(r.body,null);
});
test("SYNTHETIC_COMPONENT_MODEL：CLAIM/RESULT未知不重发，重启后只QUERY原号；fake不占serial/不核销",async t=>{
 const store=require("../src/finance/native-withdrawal-store"),p=profileModule(),source=require("../src/finance/joinpay-payout-source");let fault="NONE",commits=0,send=0,capture=0,claims:string[]=[],permission=0,keyFailure=false,leaseCurrent=true,late=false,unrelated=false,ready=true,keys=0;
 const state:any={row:{id:"fixture_intent",user_id:"fixture_user",state:"RESERVED",lease_version:"0",lease_owner:null,lease_until:null,requires_review:false,operation_version:"0",funds_disposition:"RESERVED",platform_serial_no:null,terminal_evidence_id:null},attempts:[],obs:[],audit:[]};let before:any,committed=false;
 const c={release(){},async query(sql:string,a:any[]=[]):Promise<any>{
  if(sql==="BEGIN"){before=structuredClone(state);committed=false;return{rows:[]};}if(sql==="ROLLBACK"){if(!committed)Object.assign(state,before);return{rows:[]};}if(sql==="COMMIT"){committed=true;commits++;if(fault==="CLAIM"&&commits===1||fault==="RESULT"&&commits===2)throw Error("MODEL_COMMIT_ACK_LOST");return{rows:[]};}
  if(sql.includes("to_regclass"))return{rows:[{ready:true}]};if(sql.includes(" AS now"))return{rows:[{now:"2026-10-24T10:00:00.000Z"}]};
  if(sql.startsWith("UPDATE zzsh_order.joinpay_withdrawal_intent")&&sql.includes("lease_version=lease_version+1")){state.row.state=state.row.state==="RESERVED"?"SUBMITTING":state.row.state;state.row.lease_version=String(BigInt(state.row.lease_version)+1n);state.row.lease_owner=a[1];state.row.operation_version=String(BigInt(state.row.operation_version)+1n);claims.push(a[2]);return{rows:[structuredClone(state.row)]};}
  if(sql.includes("INSERT INTO zzsh_order.joinpay_payout_attempt")){state.attempts.push(a);return{rows:[]};}if(sql.includes(" AS current FROM zzsh_order.joinpay_withdrawal_intent"))return{rows:[{current:leaseCurrent}]};
  if(sql.startsWith("SAVEPOINT")||sql.startsWith("RELEASE SAVEPOINT")||sql.startsWith("ROLLBACK TO SAVEPOINT"))return{rows:[]};
  if(sql.includes("INSERT INTO zzsh_order.joinpay_payout_observation")){if(unrelated){unrelated=false;leaseCurrent=false;throw Object.assign(Error("MODEL_UNRELATED_CHECK"),{code:"23514",constraint:"another_guard"});}if(late){late=false;leaseCurrent=false;throw Object.assign(Error("MODEL_LIVE_LEASE"),{code:"23514",constraint:"joinpay_payout_live_lease"});}state.obs.push(a);return{rows:[]};}
  if(sql.startsWith("UPDATE zzsh_order.joinpay_withdrawal_intent")){state.row.state=a[1];state.row.requires_review=state.row.requires_review||a[2];state.row.platform_serial_no=a[3];state.row.operation_version=String(BigInt(state.row.operation_version)+1n);return{rows:[],rowCount:1};}
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){state.audit.push(a);return{rows:[]};}throw Error("UNEXPECTED_ATTEMPT_COMPONENT_SQL");
 }} as unknown as PoolClient;
 t.mock.method(store,"lockNativeWithdrawal",async()=>({row:structuredClone(state.row),revision:"3"}));t.mock.method(store,"nativePayoutBinding",()=>Object.freeze({intentId:state.row.id,merchantOrderNo:"WITHDRAW202610240001"}));t.mock.method(store,"assertNativeWithdrawalExecution",async()=>{permission++;});
 t.mock.method(store,"assertNativePayoutExecutionReady",async()=>{if(!ready)throw Error("MODEL_SCHEMA_NOT_READY");});t.mock.method(p,"preflightPayoutProfile",()=>({ok:true,reason:"COMPONENT_ASSUMPTION"}));
 t.mock.method(p,"describePayoutProfile",(_p:unknown,op:string)=>({operation:op,profileId:"profile_fixture",profileSha256:H,keyVersionRef:op==="SUBMIT"?"initial_key":"rotated_query_key"}));t.mock.method(p,"assertPayoutProfile",()=>{});t.mock.method(p,"assertPayoutSubmitBinding",()=>{});t.mock.method(p,"readPayoutScope",()=>({sha256:H,canonical:"{}"}));t.mock.method(p,"readPayoutProfileEvidence",()=>"{}");t.mock.method(p,"producePayoutRequest",(_p:unknown,op:string,b:any)=>({operation:op,requestSha256:H,wireOriginal:b.merchantOrderNo}));t.mock.method(p,"readPayoutOutbound",(r:any)=>({purpose:"MERCHANT_PAYOUT",endpoint:"https://example.invalid",body:JSON.stringify({operation:r.operation,merchantOrderNo:r.wireOriginal})}));
 t.mock.method(p,"inspectPayoutProfile",()=>({signature:"MATCH",binding:"MATCH",decision:"CHANNEL_REPORTED_SUCCEEDED",platformSerialNo:"fake_trx",providerStatus:"205"}));t.mock.method(p,"eligiblePayoutTerminal",()=>"PAID");t.mock.method(source,"capturePayoutFact",async()=>{capture++;throw Error("FAKE_MUST_NOT_CAPTURE");});
 const o:any={pool:{connect:async()=>c},scope:{},profileFor:()=>({}),keyFor:()=>{keys++;if(keyFailure)throw Error("SYNTHETIC_SECRET_MESSAGE");return"SYNTHETIC_KEY";},fetch:async()=>{send++;return new Response("{}");}};
 fault="CLAIM";await assert.rejects(executeJoinpayPayout(o,state.row.id,"worker1"),(e:any)=>e instanceof PayoutCommitUnknown&&e.phase==="CLAIM");assert.equal(send,0);assert.equal(state.attempts.length,1);assert.equal(state.row.state,"SUBMITTING");
 fault="NONE";const recovered=await executeJoinpayPayout(o,state.row.id,"worker2");assert.ok(recovered);assert.deepEqual(claims,["SUBMIT","QUERY"]);assert.equal(send,1);assert.equal(permission,1);assert.equal(state.obs[0][20],"SYNTHETIC_PROTOCOL");assert.equal(state.row.platform_serial_no,null);assert.equal(state.row.funds_disposition,"RESERVED");assert.equal(capture,0);
 const request=JSON.parse(Buffer.from(state.attempts[1][11]).toString());assert.equal(request.merchantOrderNo,"WITHDRAW202610240001");assert.equal(state.attempts[1][8],"rotated_query_key");
 commits=0;fault="RESULT";const sent=send;await assert.rejects(executeJoinpayPayout(o,state.row.id,"worker3"),(e:any)=>e instanceof PayoutCommitUnknown&&e.phase==="RESULT");assert.equal(send,sent+1);assert.equal(capture,0);assert.equal(state.obs.length,2);
 fault="NONE";keyFailure=true;const sent2=send;await assert.rejects(executeJoinpayPayout(o,state.row.id,"worker4"),(e:any)=>e.code==="PAYOUT_KEY_UNAVAILABLE"&&!e.message.includes("SECRET"));assert.equal(send,sent2);keyFailure=false;
 leaseCurrent=false;await executeJoinpayPayout(o,state.row.id,"worker5");assert.equal(state.obs.at(-1)[16],"STALE");assert.equal(capture,0);
 leaseCurrent=true;late=true;await executeJoinpayPayout(o,state.row.id,"worker6");assert.equal(state.obs.at(-1)[16],"STALE");assert.equal(capture,0);
 leaseCurrent=true;unrelated=true;const prior=state.obs.length;await assert.rejects(executeJoinpayPayout(o,state.row.id,"worker7"),/MODEL_UNRELATED_CHECK/);assert.equal(state.obs.length,prior);
 // 假设协议reader只返回受信PROCESSING，测试独立receipt位与COMMIT，不创建终态事实。
 t.mock.method(p,"inspectPayoutProfile",()=>({signature:"MATCH",binding:"MATCH",decision:"PROCESSING",platformSerialNo:null}));t.mock.method(p,"eligiblePayoutTerminal",()=>null);t.mock.method(p,"payoutAcknowledgement",(_p:unknown,ok:boolean)=>ok?'{"statusCode":"2001"}':'{"statusCode":"2002"}');
 t.mock.method(p,"preflightPayoutProfile",()=>({ok:false,reason:"MISSING_STATUS_OR_HMAC"}));const keyBefore=keys,stateBefore=state.row.state;const invalid=await receiveJoinpayPayoutNotification(o,state.row.id,Buffer.from('{"userNo":"888000000000001"}'),"notify_bad");assert.equal(keys,keyBefore);assert.equal(invalid.receiptAccepted,false);assert.equal(invalid.ackBody,'{"statusCode":"2002"}');assert.equal(state.row.state,stateBefore);assert.equal(state.obs.at(-1)[17],"INVALID");assert.equal(state.obs.at(-1)[18],"NOT_CHECKED");assert.equal(state.obs.at(-1)[19],"NOT_CHECKED");assert.equal(capture,0);
 t.mock.method(p,"preflightPayoutProfile",()=>({ok:true,reason:"COMPONENT_ASSUMPTION"}));
 const received=await receiveJoinpayPayoutNotification(o,state.row.id,Buffer.from("{\"component\":true}"),"notify_fixture");assert.equal(received.receiptAccepted,true);assert.equal(received.accepted,false);assert.equal(received.ackBody,'{"statusCode":"2001"}');assert.equal(capture,0);assert.equal(state.row.funds_disposition,"RESERVED");
 commits=0;fault="CLAIM";await assert.rejects(receiveJoinpayPayoutNotification(o,state.row.id,Buffer.from("{\"component\":true}"),"notify_unknown"),(e:any)=>e instanceof PayoutCommitUnknown&&e.phase==="RESULT");fault="NONE";
 ready=false;const k0=keys,s0=send;await assert.rejects(executeJoinpayPayout(o,state.row.id,"worker_not_ready"),/MODEL_SCHEMA_NOT_READY/);await assert.rejects(receiveJoinpayPayoutNotification(o,state.row.id,Buffer.from("{}"),"notify_not_ready"),/MODEL_SCHEMA_NOT_READY/);assert.equal(keys,k0);assert.equal(send,s0);assert.equal(state.row.funds_disposition,"RESERVED");
 // 只模拟默认transport失败分支，不供应可信响应；已有成功候选不被网络错误降级。
 ready=true;leaseCurrent=true;state.row.state="CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE";state.row.platform_serial_no="fixture_serial";o.fetch=undefined;t.mock.method(globalThis,"fetch",async()=>{throw Error("MODEL_NETWORK_FAILURE");});const observations=state.obs.length;await executeJoinpayPayout(o,state.row.id,"worker_network");assert.equal(state.row.state,"CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE");assert.equal(state.row.funds_disposition,"RESERVED");assert.equal(state.row.platform_serial_no,"fixture_serial");assert.equal(state.obs.length,observations+1);assert.equal(capture,0);
});
test("薄POST通知拒绝重建body/坏或重复JSON/未知原单，未知输入0key",async()=>{
 let key=0,connects=0;const o:any={pool:{connect:async()=>{connects++;throw Error("MODEL_NO_OBJECT");}},scope:{},keyFor:()=>{key++;return"SYNTHETIC";}};
 const response=()=>{const r:any={body:"",statusCode:200,status(n:number){this.statusCode=n;return this;},setHeader(){},send(v:string){this.body=v;}};return r;};
 for(const req of [{method:"GET"},{method:"POST",body:{userNo:"1"}},{method:"POST",rawBody:Buffer.from('{"userNo":"1","userNo":"2"}')},{method:"POST",rawBody:new Uint8Array(65537)},{method:"POST",rawBody:Buffer.from('{"userNo":123,"merchantOrderNo":"WITHDRAW202610240001"}')}]){const r=response();assert.equal(await handleJoinpayPayoutNotification({url:JOINPAY_PAYOUT_NOTIFICATION_PATH,...req} as any,r,o),true);assert.match(r.body,/2002/);}assert.equal(connects,0);assert.equal(key,0);
 const r=response();await handleJoinpayPayoutNotification({url:JOINPAY_PAYOUT_NOTIFICATION_PATH,method:"POST",rawBody:Buffer.from('{"userNo":"888000000000001","merchantOrderNo":"WITHDRAW202610240001"}')} as any,r,o);assert.match(r.body,/2002/);assert.equal(connects,1);assert.equal(key,0);
 const unmatched=response();assert.equal(await handleJoinpayPayoutNotification({url:"/other"} as any,unmatched,o),false);
});


// ---------- QUERY-only 内核（SYNTHETIC_COMPONENT_MODEL） ----------
function queryModel(t:any){
 const store=require("../src/finance/native-withdrawal-store"),p=profileModule(),source=require("../src/finance/joinpay-payout-source");
 const state:any={now:0,row:{id:"fixture_intent",user_id:"fixture_user",state:"RESERVED",lease_version:"0",lease_owner:null,lease_until:null,requires_review:false,
   operation_version:"0",funds_disposition:"RESERVED",platform_serial_no:null,terminal_evidence_id:null},attempts:[] as any[],obs:[] as any[],audits:[] as any[],sends:[] as string[],keys:0,intervalOk:true,withinWindow:true,permission:0,captured:0};
 const order:string[]=[]; let leaseCurrent=true;
 const client:any={release(){},async query(sql:string,a:any[]=[]):Promise<any>{
  if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK")return{rows:[]};
  if(sql.startsWith("SAVEPOINT")||sql.startsWith("RELEASE SAVEPOINT")||sql.startsWith("ROLLBACK TO SAVEPOINT"))return{rows:[]};
  if(sql.includes(" AS active")){
   const active=state.row.lease_until===null?null:state.row.lease_until>state.now;
   return{rows:[{active:/COALESCE\(lease_until\s*>\s*clock_timestamp\(\),\s*false\)/.test(sql)?active??false:active,within_window:state.withinWindow}]};
  }
  if(sql.includes("EXISTS(SELECT 1 FROM zzsh_order.joinpay_payout_attempt"))return{rows:[{dispatched:state.attempts.some((x:any[])=>x[2]==="SUBMIT")}]};
  if(sql.includes("count(*) FILTER(WHERE operation='QUERY')::text AS queries"))return{rows:[{queries:String(state.attempts.filter((x:any[])=>x[2]==="QUERY").length),interval_ok:state.intervalOk}]};
  if(sql.startsWith("UPDATE zzsh_order.joinpay_withdrawal_intent")&&sql.includes("lease_version=lease_version+1")){
   state.row.state=state.row.state==="RESERVED"?"SUBMITTING":state.row.state==="SUBMITTING"?"UNKNOWN":state.row.state;
   state.row.lease_version=String(BigInt(state.row.lease_version)+1n);state.row.lease_owner=a[1];state.row.lease_until=state.now+30;
   state.row.operation_version=String(BigInt(state.row.operation_version)+1n);return{rows:[structuredClone(state.row)]};}
  if(sql.includes("INSERT INTO zzsh_order.joinpay_payout_attempt")){state.attempts.push(a);return{rows:[]};}
  if(sql.includes(" AS current FROM zzsh_order.joinpay_withdrawal_intent"))return{rows:[{current:leaseCurrent&&state.row.lease_version===a[1]&&state.row.lease_owner===a[2]&&state.row.lease_until>state.now}]};
  if(sql.includes("INSERT INTO zzsh_order.joinpay_payout_observation")){state.obs.push(a);return{rows:[]};}
  if(sql.startsWith("UPDATE zzsh_order.joinpay_withdrawal_intent")){state.row.state=a[1];state.row.requires_review=state.row.requires_review||a[2];state.row.platform_serial_no=a[3];state.row.operation_version=String(BigInt(state.row.operation_version)+1n);return{rows:[],rowCount:1};}
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){state.audits.push(a);return{rows:[]};}
  if(sql.includes(" AS now"))return{rows:[{now:"2026-10-24T10:00:00.000Z"}]};
  throw Error("UNEXPECTED_QUERY_ONLY_SQL: "+sql.slice(0,90));
 }};
 t.mock.method(store,"lockNativeWithdrawal",async()=>{order.push("lock");return{row:structuredClone(state.row),revision:"3"};});
 t.mock.method(store,"nativePayoutBinding",()=>Object.freeze({intentId:state.row.id,merchantOrderNo:"WITHDRAW202610240001"}));
 t.mock.method(store,"assertNativeWithdrawalExecution",async()=>{state.permission++;});
 t.mock.method(store,"assertNativePayoutExecutionReady",async()=>{});
 t.mock.method(p,"readPayoutScope",()=>({sha256:H,canonical:"{}"}));
 t.mock.method(p,"describePayoutProfile",(_x:unknown,op:string)=>({operation:op,profileId:"profile_fixture",profileSha256:H,keyVersionRef:op==="SUBMIT"?"initial_key":"query_key"}));
 t.mock.method(p,"assertPayoutProfile",()=>{});t.mock.method(p,"assertPayoutSubmitBinding",()=>{});t.mock.method(p,"readPayoutProfileEvidence",()=>"{}");
 t.mock.method(p,"producePayoutRequest",(_x:unknown,op:string,b:any)=>({operation:op,requestSha256:H,wireOriginal:b.merchantOrderNo}));
 t.mock.method(p,"readPayoutOutbound",(r:any)=>({purpose:"MERCHANT_PAYOUT",endpoint:"https://example.invalid/queryPayout",body:JSON.stringify({operation:r.operation,merchantOrderNo:r.wireOriginal})}));
 t.mock.method(p,"inspectPayoutProfile",()=>({signature:"MATCH",binding:"MATCH",decision:"PROCESSING",platformSerialNo:null}));
 t.mock.method(p,"eligiblePayoutTerminal",()=>null);
 t.mock.method(source,"capturePayoutFact",async()=>{state.captured++;throw Error("MODEL_MUST_NOT_CAPTURE");});
 const options:any={pool:{connect:async()=>client},scope:{},profileFor:()=>({}),keyFor:()=>{state.keys++;return"SYNTHETIC_KEY";},fetch:async()=>{state.sends.push("send");return new Response("{}");}};
 return{state,options,order,setLeaseCurrent:(v:boolean)=>{leaseCurrent=v;}};
}
test("SYNTHETIC_QUERY_ONLY：RESERVED/0未派发0钥0attempt0外呼，authorize先于资金锁",async t=>{
 const m=queryModel(t);let auth:any=null;
 const r=await queryJoinpayPayout(m.options,"fixture_intent","worker_q",{minimumIntervalSeconds:60,authorize:async(client,id)=>{auth=client;m.order.push("authorize");if(id!=="fixture_intent")throw Error("WRONG_OBJECT");}});
 assert.deepEqual(r,{kind:"NOT_DISPATCHED",intentId:"fixture_intent",state:"RESERVED"});
 assert.equal(typeof auth.query,"function");assert.deepEqual(m.order,["authorize","lock"]);
 assert.equal(m.state.keys,0);assert.equal(m.state.sends.length,0);assert.equal(m.state.attempts.length,0);assert.equal(m.state.audits.length,0);assert.equal(m.state.permission,0);
 assert.equal(m.state.row.lease_version,"0");assert.equal(m.state.row.lease_owner,null);
});
test("SYNTHETIC_QUERY_ONLY：已持久SUBMIT不再次SUBMIT，沿原商户号QUERY",async t=>{
 const m=queryModel(t);m.state.attempts.push(["existing_submit","fixture_intent","SUBMIT"]);
 m.state.row.state="UNKNOWN";m.state.row.lease_version="1";m.state.row.lease_owner="old";m.state.row.lease_until=1;m.state.now=31;
 const r=await queryJoinpayPayout(m.options,"fixture_intent","worker_q",{minimumIntervalSeconds:60});
 assert.equal(r.kind,"OBSERVED");assert.equal(m.state.sends.length,1);assert.equal(m.state.attempts.length,2);assert.equal(m.state.attempts[1][2],"QUERY");
 assert.equal(m.state.attempts.filter((x:any[])=>x[2]==="SUBMIT").length,1);
 assert.equal(JSON.parse(Buffer.from(m.state.attempts[1][11]).toString()).merchantOrderNo,"WITHDRAW202610240001");
 assert.equal(r.terminal,null);assert.equal(m.state.permission,0);assert.equal(m.state.captured,0);
});
test("SYNTHETIC_QUERY_ONLY：终态/待接纳/复核/活跃lease/节流/预算分别不取钥外呼",async t=>{
 const m=queryModel(t),id="fixture_intent",call=()=>queryJoinpayPayout(m.options,id,"worker_q",{minimumIntervalSeconds:60});
 const reset=()=>{m.state.row={id,user_id:"fixture_user",state:"UNKNOWN",lease_version:"1",lease_owner:"old",lease_until:1,requires_review:false,operation_version:"2",funds_disposition:"RESERVED",platform_serial_no:null,terminal_evidence_id:null};m.state.attempts=[];m.state.now=31;m.state.intervalOk=true;m.state.withinWindow=true;};
 reset();m.state.row.state="SUCCEEDED";assert.deepEqual(await call(),{kind:"SKIPPED",intentId:id,state:"SUCCEEDED",reason:"TERMINAL"});
 reset();m.state.row.state="CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE";assert.deepEqual(await call(),{kind:"SKIPPED",intentId:id,state:"CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE",reason:"PENDING_ACCEPTANCE"});
 reset();m.state.row.requires_review=true;assert.deepEqual(await call(),{kind:"SKIPPED",intentId:id,state:"UNKNOWN",reason:"REVIEW_REQUIRED"});
 reset();m.state.row.lease_until=61;assert.deepEqual(await call(),{kind:"SKIPPED",intentId:id,state:"UNKNOWN",reason:"ACTIVE_LEASE"});
 reset();m.state.attempts=[["s",id,"SUBMIT"]];m.state.withinWindow=false;assert.deepEqual(await call(),{kind:"SKIPPED",intentId:id,state:"UNKNOWN",reason:"OUTSIDE_QUERY_WINDOW"});
 reset();m.state.attempts=[["s",id,"SUBMIT"],["q",id,"QUERY"]];m.state.intervalOk=false;assert.deepEqual(await call(),{kind:"SKIPPED",intentId:id,state:"UNKNOWN",reason:"THROTTLED"});
 reset();m.state.attempts=[["s",id,"SUBMIT"],...Array.from({length:10},(_,i)=>["q"+i,id,"QUERY"])];assert.deepEqual(await call(),{kind:"SKIPPED",intentId:id,state:"UNKNOWN",reason:"BUDGET_EXHAUSTED"});
 assert.equal(m.state.keys,0);assert.equal(m.state.sends.length,0);assert.equal(m.state.audits.length,0);assert.equal(m.state.permission,0);
});
test("SYNTHETIC_QUERY_ONLY：authorize拒绝在资金锁前回滚，0lease0attempt0钥0外呼",async t=>{
 const m=queryModel(t);
 await assert.rejects(queryJoinpayPayout(m.options,"fixture_intent","worker_q",{minimumIntervalSeconds:60,authorize:async()=>{m.order.push("authorize");throw Object.assign(Error("DENIED"),{code:"FORBIDDEN"});}}),(e:any)=>e.code==="FORBIDDEN");
 assert.deepEqual(m.order,["authorize"]);assert.equal(m.state.keys,0);assert.equal(m.state.sends.length,0);assert.equal(m.state.attempts.length,0);
 assert.equal(m.state.audits.length,0);assert.equal(m.state.row.lease_version,"0");assert.equal(m.state.row.lease_owner,null);
});
test("SYNTHETIC_QUERY_ONLY：错签名不核销；旧lease只STALE；关闭新准入仍QUERY",async t=>{
 const m=queryModel(t),store=require("../src/finance/native-withdrawal-store"),p=profileModule();
 m.state.row.state="UNKNOWN";m.state.row.lease_version="1";m.state.row.lease_owner="old";m.state.row.lease_until=1;m.state.now=31;m.state.attempts.push(["s","fixture_intent","SUBMIT"]);
 t.mock.method(p,"inspectPayoutProfile",()=>({signature:"MISMATCH",binding:"MISMATCH",decision:"UNKNOWN",platformSerialNo:null}));
 const bad=await queryJoinpayPayout(m.options,"fixture_intent","worker_q",{minimumIntervalSeconds:60});
 assert.equal(bad.kind,"OBSERVED");assert.equal(bad.terminal,null);assert.equal(m.state.obs.at(-1)[18],"MISMATCH");assert.equal(m.state.captured,0);
 assert.equal(m.state.row.state,"UNKNOWN");
 t.mock.method(p,"inspectPayoutProfile",()=>({signature:"MATCH",binding:"MATCH",decision:"PROCESSING",platformSerialNo:null}));
 m.state.now=31;m.state.row.lease_until=1;m.setLeaseCurrent(false);const normalFetch=m.options.fetch;
 m.options.fetch=async()=>{m.state.now=200;return new Response("{}");};
 const stale=await queryJoinpayPayout(m.options,"fixture_intent","worker_q",{minimumIntervalSeconds:60});
 assert.equal(stale.kind,"OBSERVED");assert.equal(stale.event,"STALE");assert.equal(m.state.obs.at(-1)[16],"STALE");
 t.mock.method(store,"assertNativeWithdrawalExecution",async()=>{throw Error("NEW_SUBMIT_CLOSED");});
 m.options.fetch=normalFetch;m.setLeaseCurrent(true);m.state.row.lease_until=1;m.state.now=31;m.state.attempts.push(["s3","fixture_intent","SUBMIT"]);
 const recovered=await queryJoinpayPayout(m.options,"fixture_intent","worker_q",{minimumIntervalSeconds:60});
 assert.equal(recovered.kind,"OBSERVED");
});


test("SYNTHETIC_QUERY_ONLY：RESERVED枚举但锁内已有SUBMIT attempt时仍不首派", async t => {
  const m = queryModel(t); m.state.attempts.push(["existing_submit", "fixture_intent", "SUBMIT"]); m.state.now = 31;
  const r = await queryJoinpayPayout(m.options, "fixture_intent", "worker_q", { minimumIntervalSeconds: 60 });
  assert.equal(r.kind, "OBSERVED"); assert.equal(m.state.sends.length, 1); assert.equal(m.state.attempts.length, 2);
  assert.equal(m.state.attempts[1][2], "QUERY"); assert.equal(m.state.attempts.filter((x: any[]) => x[2] === "SUBMIT").length, 1);
  assert.equal(m.state.row.state, "SUBMITTING");
});

test("SYNTHETIC_SQL_NULL_MODEL：首派NULL lease保留NOT_DISPATCHED且无副作用",async t=>{
 const m=queryModel(t),before=structuredClone(m.state.row);
 assert.deepEqual(await queryJoinpayPayout(m.options,"fixture_intent","worker_q",{minimumIntervalSeconds:60}),
  {kind:"NOT_DISPATCHED",intentId:"fixture_intent",state:"RESERVED"});
 assert.deepEqual(m.state.row,before);assert.equal(m.state.keys,0);assert.equal(m.state.sends.length,0);
 assert.equal(m.state.attempts.length,0);assert.equal(m.state.audits.length,0);assert.equal(m.state.permission,0);
});

test("SYNTHETIC_RECOVERY_GAP：非初始状态与正lease版本不能充当已派发证据",async t=>{
 const m=queryModel(t);m.state.now=31;
 for(const [state,version] of [["RESERVED","1"],["UNKNOWN","1"],["PROCESSING","2"]]){
  Object.assign(m.state.row,{state,lease_version:version,lease_until:1});const before=structuredClone(m.state.row);
  assert.deepEqual(await queryJoinpayPayout(m.options,"fixture_intent","worker_q",{minimumIntervalSeconds:60}),
   {kind:"NOT_DISPATCHED",intentId:"fixture_intent",state});
  assert.deepEqual(m.state.row,before);
 }
 assert.equal(m.state.keys,0);assert.equal(m.state.sends.length,0);assert.equal(m.state.attempts.length,0);assert.equal(m.state.audits.length,0);
});
