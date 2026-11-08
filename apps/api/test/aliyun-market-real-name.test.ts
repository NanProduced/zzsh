import assert from "node:assert/strict";
import test from "node:test";
import { createAliyunMarketRealNameProvider } from "../src/auth/aliyun-market-real-name";

const input={userId:"synthetic-user",fullName:"合成姓名",documentNumber:"110105199001011232"};
const appCode="synthetic_appcode_123456789";
const clock=()=>new Date("2026-11-02T00:00:00Z");

test("marketplace provider posts the legacy fields once and interprets match and mismatch",async()=>{
  for(const [value,status] of [[1,"VERIFIED"],[2,"REJECTED"],[9,"UNKNOWN"]] as const){
    let calls=0;
    const send:typeof fetch=async(url,init)=>{
      calls++;assert.equal(String(url),"https://sfzybx.market.alicloudapi.com/idcard/verify");
      assert.equal(init?.method,"POST");assert.equal(init?.redirect,"error");
      assert.equal(new Headers(init?.headers).get("authorization"),`APPCODE ${appCode}`);
      assert.equal(String(init?.body),new URLSearchParams({idcard:input.documentNumber,name:input.fullName}).toString());
      return Response.json({code:200,requestid:"market-request-1",data:{result:value}});
    };
    const provider=createAliyunMarketRealNameProvider(appCode,send,clock);
    assert.equal(calls,0);const result=await provider.verify(input);
    assert.equal(calls,1);assert.equal(result.status,status);assert.equal(result.provider,"aliyun-market-id2");
    assert.equal(result.providerReference,"market-request-1");assert.equal(result.ageStatus,status==="VERIFIED"?"ADULT":"UNKNOWN");
  }
});

test("marketplace mismatch example is rejected while preserving the request reference",async()=>{
  const provider=createAliyunMarketRealNameProvider(appCode,async()=>Response.json({code:200,requestid:"1400000000000000000",message:"成功",data:{result:2,msg:"核验不一致"}}),clock);
  const result=await provider.verify(input);
  assert.equal(result.status,"REJECTED");assert.equal(result.providerReference,"1400000000000000000");assert.equal(result.ageStatus,"UNKNOWN");
});

test("missing product request id uses the explicitly labeled API Gateway request id",async()=>{
  const provider=createAliyunMarketRealNameProvider(appCode,async()=>Response.json({code:200,data:{result:1}},{headers:{"X-Ca-Request-Id":"gateway-fixture-123"}}),clock);
  const result=await provider.verify(input);
  assert.equal(result.status,"VERIFIED");assert.equal(result.providerReference,"gateway:gateway-fixture-123");
});

test("marketplace provider fails closed without retrying or exposing identity and credentials",async()=>{
  for(const reply of [
    ()=>new Response("unavailable",{status:503}),
    ()=>Response.json({code:400,requestid:"market-request",data:{result:1}}),
    ()=>Response.json({code:200,data:{result:1}}),
    ()=>Response.json({code:200,requestid:"bad id",data:{result:1}},{headers:{"X-Ca-Request-Id":"gateway-fixture-123"}}),
    ()=>Response.json({code:200,data:{result:1}},{headers:{"X-Ca-Request-Id":"x".repeat(249)}}),
    ()=>Response.json({code:200,requestid:"market-request",data:null}),
    ()=>{throw new Error("synthetic identity and appcode must not escape");},
  ]){
    let calls=0;const send:typeof fetch=async()=>{calls++;return reply();};
    const provider=createAliyunMarketRealNameProvider(appCode,send,clock);
    await assert.rejects(provider.verify(input),(error:unknown)=>error instanceof Error&&error.message==="REAL_NAME_DEPENDENCY_UNAVAILABLE");
    assert.equal(calls,1);
  }
  let calls=0;const provider=createAliyunMarketRealNameProvider(appCode,async()=>{calls++;throw Error();},clock);
  assert.equal((await provider.verify({...input,documentNumber:"invalid"})).status,"REJECTED");assert.equal(calls,0);
  assert.throws(()=>createAliyunMarketRealNameProvider("bad\ncredential"));
});
