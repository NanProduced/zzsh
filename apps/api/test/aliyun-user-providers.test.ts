import assert from "node:assert/strict";
import test from "node:test";
import { SendSmsResponse,SendSmsResponseBody } from "@alicloud/dysmsapi20170525";
import { Id2MetaVerifyResponse,Id2MetaVerifyResponseBody,Id2MetaVerifyResponseBodyResultObject } from "@alicloud/cloudauth20190307";
import { createAliyunRealNameProvider,createAliyunUserSmsSender,UserSmsDeliveryError,verifiedMainlandAgeStatus } from "../src/auth/aliyun-user-providers";

const credentials={accessKeyId:"SYNTHETIC_KEY",accessKeySecret:"SYNTHETIC_SECRET_NOT_REAL_1234"};
const input={userId:"synthetic-user",fullName:"合成用户",documentNumber:"110105199001011232"};

test("Aliyun SMS uses official SDK models, a single submission and no provider call at factory time",async()=>{
 let calls=0;
 const sender=createAliyunUserSmsSender({credentials,signName:"合成签名",templateCode:"SMS_123"},{sendSmsWithOptions:async(request,runtime)=>{
  calls++;assert.equal(request.phoneNumbers,"+8613800138000");assert.equal(request.templateParam,JSON.stringify({code:"123456"}));
  assert.equal(runtime.autoretry,false);assert.equal(runtime.maxAttempts,1);assert.ok(runtime.readTimeout!>=1000);
  return new SendSmsResponse({body:new SendSmsResponseBody({code:"OK",requestId:"request-1"})});
 }});
 assert.equal(calls,0);await sender("13800138000","123456");assert.equal(calls,1);
});

test("Aliyun SMS freezes validated trimmed configuration and rejects control characters",async()=>{
 const input={credentials,signName:" 合成签名 ",templateCode:" SMS_123 "};
 const sent:Array<{signName:string|undefined;templateCode:string|undefined}>=[];
 const sender=createAliyunUserSmsSender(input,{sendSmsWithOptions:async request=>{
  sent.push({signName:request.signName,templateCode:request.templateCode});return new SendSmsResponse({body:new SendSmsResponseBody({code:"OK"})});
 }});
 input.signName="外部已修改";input.templateCode="SMS_456";await sender("13800138000","123456");
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
 await assert.rejects(rejected("13800138000","123456"),(error:unknown)=>error instanceof UserSmsDeliveryError&&error.outcome==="REJECTED"&&!JSON.stringify(error).includes("PII"));
 const lost=createAliyunUserSmsSender({credentials,signName:"合成签名",templateCode:"SMS_123"},{sendSmsWithOptions:async()=>{
  calls++;throw new Error("SIGNED_URL AK OTP NAME ID SYNTHETIC_PII_SHOULD_NOT_ESCAPE");
 }});
 await assert.rejects(lost("13800138000","123456"),(error:unknown)=>error instanceof UserSmsDeliveryError&&error.outcome==="UNKNOWN"&&!JSON.stringify(error).includes("PII")&&!error.message.includes("AK"));
 assert.equal(calls,2);
 await assert.rejects(lost("13800138000","bad"));assert.equal(calls,2);
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
