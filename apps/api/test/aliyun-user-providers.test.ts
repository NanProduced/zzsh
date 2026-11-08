import assert from "node:assert/strict";
import test from "node:test";
import { SendSmsResponse,SendSmsResponseBody } from "@alicloud/dysmsapi20170525";
import { Id2MetaVerifyResponse,Id2MetaVerifyResponseBody,Id2MetaVerifyResponseBodyResultObject } from "@alicloud/cloudauth20190307";
import { createAliyunRealNameProvider,createAliyunSmsChannel,createAliyunUserSmsSender,UserSmsDeliveryError,verifiedMainlandAgeStatus } from "../src/auth/aliyun-user-providers";
import { isUserVerificationCode,makeUserVerificationCode,USER_SMS_CODE_LENGTH } from "../src/auth/user-verification-code";
import { buildUserSecurityPlugin } from "../src/auth/user-security";
import type { Pool } from "pg";

const credentials={accessKeyId:"SYNTHETIC_KEY",accessKeySecret:"SYNTHETIC_SECRET_NOT_REAL_1234"};
const input={userId:"synthetic-user",fullName:"合成用户",documentNumber:"110105199001011232"};

test("Aliyun SMS uses official SDK models, a single submission and no provider call at factory time",async()=>{
 let calls=0;
 const sender=createAliyunUserSmsSender({credentials,signName:"合成签名",templateCode:"SMS_123"},{sendSmsWithOptions:async(request,runtime)=>{
  calls++;assert.equal(request.phoneNumbers,"+8613800138000");assert.equal(request.templateParam,JSON.stringify({code:"1234"}));
  assert.equal(runtime.autoretry,false);assert.equal(runtime.maxAttempts,1);assert.ok(runtime.readTimeout!>=1000);
  return new SendSmsResponse({body:new SendSmsResponseBody({code:"OK",requestId:"request-1"})});
 }});
 assert.equal(calls,0);await sender("13800138000","1234","LOGIN");assert.equal(calls,1);
});

test("Aliyun SMS freezes validated trimmed configuration and rejects control characters",async()=>{
 const input={credentials,signName:" 合成签名 ",templateCode:" SMS_123 "};
 const sent:Array<{signName:string|undefined;templateCode:string|undefined}>=[];
 const sender=createAliyunUserSmsSender(input,{sendSmsWithOptions:async request=>{
  sent.push({signName:request.signName,templateCode:request.templateCode});return new SendSmsResponse({body:new SendSmsResponseBody({code:"OK"})});
 }});
 input.signName="外部已修改";input.templateCode="SMS_456";await sender("13800138000","1234","LOGIN");
 assert.deepEqual(sent,[{signName:"合成签名",templateCode:"SMS_123"}]);
 for(const signName of ["合成\n签名","合成\u0000签名","合成\r签名"]){
  assert.throws(()=>createAliyunUserSmsSender({credentials,signName,templateCode:"SMS_123"}));
 }
});

test("Aliyun SMS distinguishes known rejection from unknown delivery without leaking SDK content or retrying",async()=>{
 let calls=0;
 const rejected=createAliyunUserSmsSender({credentials,signName:"合成签名",templateCode:"SMS_123"},{sendSmsWithOptions:async()=>{
  calls++;return new SendSmsResponse({body:new SendSmsResponseBody({code:"isv.BUSINESS_LIMIT_CONTROL",message:"SYNTHETIC_PII_SHOULD_NOT_ESCAPE"})});
 }});
 await assert.rejects(rejected("13800138000","1234","LOGIN"),(error:unknown)=>error instanceof UserSmsDeliveryError&&error.outcome==="REJECTED"&&!JSON.stringify(error).includes("PII"));
 const lost=createAliyunUserSmsSender({credentials,signName:"合成签名",templateCode:"SMS_123"},{sendSmsWithOptions:async()=>{
  calls++;throw new Error("SIGNED_URL AK OTP NAME ID SYNTHETIC_PII_SHOULD_NOT_ESCAPE");
 }});
 await assert.rejects(lost("13800138000","1234","LOGIN"),(error:unknown)=>error instanceof UserSmsDeliveryError&&error.outcome==="UNKNOWN"&&!JSON.stringify(error).includes("PII")&&!error.message.includes("AK"));
 assert.equal(calls,2);
 await assert.rejects(lost("13800138000","bad","LOGIN"));assert.equal(calls,2);
 await assert.rejects(lost("13800138000","123456","LOGIN"));assert.equal(calls,2);
});

test("SMS verification scenes select separate templates; business notices stay unconnected",async()=>{
 const requests:Array<{template:string|undefined;params:string|undefined}>=[];
 const channel=createAliyunSmsChannel({credentials,signName:"合成签名",templateCode:"SMS_FALLBACK",templates:{
  IDENTITY:"SMS_99",REGISTER:"SMS_100",LOGIN:"SMS_101",BIND:"SMS_102",CHANGE_MOBILE:"SMS_103",FORGOT_PASSWORD:"SMS_104",RENTAL_EXPIRY:"SMS_201",OWNER_ORDER_PAID:"SMS_202",
 }},{sendSmsWithOptions:async(request)=>{requests.push({template:request.templateCode,params:request.templateParam});return new SendSmsResponse({body:new SendSmsResponseBody({code:"OK"})});}});
 for(const scene of ["IDENTITY","REGISTER","LOGIN","BIND","CHANGE_MOBILE","FORGOT_PASSWORD"] as const)await channel.sendVerification("13800138000","1234",scene);
 assert.deepEqual(requests.map(r=>r.template),["SMS_99","SMS_100","SMS_101","SMS_102","SMS_103","SMS_104"]);
 assert.deepEqual(requests.map(r=>JSON.parse(r.params!)),Array.from({length:6},()=>({code:"1234"})));
 assert.equal(channel.configuration.scenes.LOGIN.source,"SCENE");
 await assert.rejects(channel.sendVerification("13800138000","1234","OWNER_ORDER_PAID" as never));
 assert.equal(channel.configuration.scenes.RENTAL_EXPIRY.templateCode,"SMS_201");assert.equal(requests.length,6);
 const shared=createAliyunSmsChannel({credentials,signName:"合成签名",templateCode:"SMS_SHARED"},{sendSmsWithOptions:async()=>{throw Error("must not send");}});
 assert.equal(shared.configuration.scenes.LOGIN.source,"SHARED");assert.equal(shared.configuration.scenes.OWNER_ORDER_PAID.source,"NOT_CONFIGURED");
 assert.equal(shared.configuration.scenes.CHANGE_MOBILE.source,"SHARED");assert.equal(shared.configuration.scenes.FORGOT_PASSWORD.source,"SHARED");
 const related=createAliyunSmsChannel({credentials,signName:"合成签名",templates:{IDENTITY:"SMS_ID",REGISTER:"SMS_REG",LOGIN:"SMS_LOGIN",BIND:"SMS_BIND"}},{sendSmsWithOptions:async()=>{throw Error("must not send");}});
 assert.deepEqual(related.configuration.scenes.CHANGE_MOBILE,{templateCode:"SMS_BIND",source:"RELATED"});
 assert.deepEqual(related.configuration.scenes.FORGOT_PASSWORD,{templateCode:"SMS_ID",source:"RELATED"});
 assert.equal("sendNotice" in shared,false);
});

test("contact verification keeps SMS four digits and email six digits",()=>{
 assert.equal(USER_SMS_CODE_LENGTH,4);
 for(const channel of ["phone","email"] as const){
  for(let n=0;n<100;n++) assert.equal(isUserVerificationCode(channel,makeUserVerificationCode(channel)),true);
  assert.equal(isUserVerificationCode(channel,makeUserVerificationCode(channel,true)),true);
 }
 assert.equal(isUserVerificationCode("phone","123456"),false);
 assert.equal(isUserVerificationCode("email","1234"),false);
 assert.equal(isUserVerificationCode("phone","12x4"),false);
 assert.equal(isUserVerificationCode("phone","0001"),true);
});

test("offline security endpoints send and verify per channel, with cooldown and attempt limits",async()=>{
 const user={id:"fixture",name:"fixture",phoneNumber:"+8613800138000",email:"fixture@example.invalid",emailVerified:true,suspended:false,accountStatus:"ACTIVE",securityVersion:1};
 const records=new Map<string,{id:string;value:string;expiresAt:Date;createdAt:Date}>();
 const client={
  async query(sql:string,params:unknown[]=[]){
   if(/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))return{rows:[]};
   if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
   if(sql.includes("SELECT u.id,u.name"))return{rows:[user]};
   if(sql.includes("FROM zzsh_auth_user.account"))return{rows:[]};
   if(sql.includes("FROM zzsh_auth_user.\"user\" WHERE"))return{rows:[{id:user.id}]};
   if(sql.includes("legacy_phone"))return{rows:[{blocked:false}]};
   if(sql.startsWith("SELECT \"createdAt\" FROM zzsh_auth_user.verification")){const row=records.get(String(params[0]));return{rows:row?[row]:[]};}
   if(sql.startsWith("DELETE FROM zzsh_auth_user.verification")){records.delete(String(params[0]));return{rows:[]};}
   if(sql.startsWith("INSERT INTO zzsh_auth_user.verification")){
    const hasValue=sql.includes("$3,$4,$5,$5"),id=String(params[0]),identifier=String(params[1]);
    records.set(identifier,{id,value:hasValue?String(params[2]):"{}",expiresAt:params[hasValue?3:2] as Date,createdAt:params[hasValue?4:3] as Date});return{rows:[]};
   }
   if(sql.startsWith("SELECT id,value,\"expiresAt\" FROM zzsh_auth_user.verification")){const row=records.get(String(params[0]));return{rows:row?[row]:[]};}
   if(sql.startsWith("UPDATE zzsh_auth_user.verification SET value=")){const row=[...records.values()].find(item=>item.id===params[0]);assert.ok(row);row.value=String(params[1]);return{rows:[]};}
   throw new Error("Unexpected fixture query");
  },release(){}
 };
 const pool={connect:async()=>client} as unknown as Pool;
 const outbox=new Map();let smsCode="",smsScene="";
 const plugin=await buildUserSecurityPlugin({pool,outbox,localMock:false,smsSender:async(_phone,code,scene)=>{smsCode=code;smsScene=scene;}});
 const invoke=async(name:"userSecuritySend"|"userSecurityVerify",body:Record<string,unknown>)=>
  (plugin.endpoints[name] as unknown as (input:unknown)=>Promise<any>)({method:"POST",body,headers:new Headers(),context:{}});
 for(const channel of ["phone","email"] as const){
  const sent=await invoke("userSecuritySend",{purpose:"recovery",channel,stage:"current",contact:channel==="phone"?user.phoneNumber:user.email});
  const code=channel==="phone"?smsCode:outbox.get(sent.challengeId)?.code;
  if(channel==="phone")assert.equal(smsScene,"FORGOT_PASSWORD");
  assert.equal(isUserVerificationCode(channel,code),true);
  await assert.rejects(invoke("userSecuritySend",{purpose:"recovery",channel,stage:"current",contact:channel==="phone"?user.phoneNumber:user.email}));
  await assert.rejects(invoke("userSecurityVerify",{challengeId:sent.challengeId,code:channel==="phone"?"123456":"1234"}));
  const verified=await invoke("userSecurityVerify",{challengeId:sent.challengeId,code});
  assert.equal(verified.status,true);
  const saved=JSON.parse(records.get(`user-security:${sent.challengeId}`)!.value);
  assert.equal(saved.verified,true);assert.equal(saved.attempts,1);
 }
 records.clear();
 const locked=await invoke("userSecuritySend",{purpose:"recovery",channel:"phone",stage:"current",contact:user.phoneNumber});
 const valid=smsCode,wrong=valid==="0000"?"0001":"0000";
 for(let i=0;i<3;i++)await assert.rejects(invoke("userSecurityVerify",{challengeId:locked.challengeId,code:wrong}));
 await assert.rejects(invoke("userSecurityVerify",{challengeId:locked.challengeId,code:valid}));
 assert.equal(JSON.parse(records.get(`user-security:${locked.challengeId}`)!.value).attempts,3);
 records.clear();
 const expired=await invoke("userSecuritySend",{purpose:"recovery",channel:"phone",stage:"current",contact:user.phoneNumber});
 records.get(`user-security:${expired.challengeId}`)!.expiresAt=new Date(0);
 await assert.rejects(invoke("userSecurityVerify",{challengeId:expired.challengeId,code:smsCode}));
});

test("verified identity age is based on a valid birth calendar in China time, never assumed adult",()=>{
 assert.equal(verifiedMainlandAgeStatus("110105199001011232",new Date("2026-11-01T16:00:00Z")),"ADULT");
 assert.equal(verifiedMainlandAgeStatus("110105200811030001",new Date("2026-11-01T16:00:00Z")),"MINOR");
 assert.equal(verifiedMainlandAgeStatus("110105200811020001",new Date("2026-11-01T16:00:00Z")),"ADULT");
 assert.equal(verifiedMainlandAgeStatus("110105200802300001",new Date("2026-11-01T16:00:00Z")),"UNKNOWN");
 assert.equal(verifiedMainlandAgeStatus("110105209901010001",new Date("2026-11-01T16:00:00Z")),"UNKNOWN");
});

test("Aliyun identity requires both envelope 200 and exact consistent result with trace reference",async()=>{
 for(const [bizCode,status] of [["1","VERIFIED"],["2","REJECTED"],["3","UNKNOWN"]] as const){
  let calls=0;
  const provider=createAliyunRealNameProvider(credentials,{id2MetaVerifyWithOptions:async(request,runtime)=>{
   calls++;assert.equal(request.paramType,"normal");assert.equal(request.identifyNum,input.documentNumber);assert.equal(request.userName,input.fullName);
   assert.equal(runtime.autoretry,false);assert.equal(runtime.maxAttempts,1);
   return new Id2MetaVerifyResponse({body:new Id2MetaVerifyResponseBody({code:"200",requestId:"request-identity",resultObject:new Id2MetaVerifyResponseBodyResultObject({bizCode})})});
  }},()=>new Date("2026-11-02T00:00:00Z"));
  assert.equal(calls,0);const result=await provider.verify(input);assert.equal(calls,1);assert.equal(result.status,status);
  assert.equal(result.provider,"aliyun-id2meta");assert.equal(result.providerReference,"request-identity");
  assert.equal(result.ageStatus,status==="VERIFIED"?"ADULT":"UNKNOWN");
 }
});

test("Aliyun identity malformed or lost response is a sanitized dependency failure, not verified",async()=>{
 for(const response of [
  new Id2MetaVerifyResponseBody({code:"500",requestId:"request",resultObject:new Id2MetaVerifyResponseBodyResultObject({bizCode:"1"})}),
  new Id2MetaVerifyResponseBody({code:"200",requestId:"request",resultObject:new Id2MetaVerifyResponseBodyResultObject({bizCode:"other"})}),
  new Id2MetaVerifyResponseBody({code:"200",resultObject:new Id2MetaVerifyResponseBodyResultObject({bizCode:"1"})}),
 ]){
  const provider=createAliyunRealNameProvider(credentials,{id2MetaVerifyWithOptions:async()=>new Id2MetaVerifyResponse({body:response})});
  await assert.rejects(provider.verify(input),(error:unknown)=>(error as Error).message==="REAL_NAME_DEPENDENCY_UNAVAILABLE");
 }
 const provider=createAliyunRealNameProvider(credentials,{id2MetaVerifyWithOptions:async()=>{throw new Error("SYNTHETIC_NAME_DOCUMENT_KEY_NOT_FOR_LOGGING");}});
 await assert.rejects(provider.verify(input),(error:unknown)=>(error as Error).message==="REAL_NAME_DEPENDENCY_UNAVAILABLE");
});
