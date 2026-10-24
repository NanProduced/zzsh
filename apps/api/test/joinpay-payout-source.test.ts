// SYNTHETIC_CONFIGURATION_MODEL/拒绝分支；不以虚构KAT、假fetch或假PG铸造正式终态fact。
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {bindPayoutProfile,createPayoutScope,createWithdrawalAdmission,describePayoutProfile,eligiblePayoutTerminal,inspectPayoutProfile,readPayoutProfileEvidence,readPayoutScope,readWithdrawalAdmission,
 assertPayoutStart,assertInitialPayoutScope,assertPayoutReviewStrategy,producePayoutRequest,readPayoutOutbound,type PayoutProfileInput,type PayoutBinding} from "../src/finance/joinpay-payout-profile";
import {computeJoinpayPayoutRequest,type PayoutWireRules} from "../src/finance/joinpay-payout-protocol";
import {assertNativeWithdrawalFact,capturePayoutFact,payoutTerminalConflicts,readVerifiedPayoutFact} from "../src/finance/joinpay-payout-source";
const KEY="SYNTHETIC_PAYOUT_KEY_NO_REAL_ACCOUNT",H="a".repeat(64),B={merchantIdentityId:"merchant_fixture",userNo:"888000000000001",merchantOrderNo:"WITHDRAW202610240001",receiverAccountNoEnc:"SYNTHETIC_ENC_ACCOUNT",receiverNameEnc:"SYNTHETIC_ENC_NAME",netCents:"9900"};
const R:PayoutWireRules={dataEncoding:"OBJECT",statusCodeToken:"STRING",statusToken:"NUMBER",amountToken:"NUMBER",feeToken:"NUMBER",accountTypeToken:"NUMBER",optionalSigning:"ABSENT_EMPTY_NULL_EQUIVALENT",numericSigning:"RAW_JSON_TOKEN",unknownFields:"REJECT",notFoundShape:"IDENTITY_ONLY_214",targetBinding:"EXACT_RECORDED_OPAQUE_VALUE",providerFeeUnit:"CNY_YUAN"};
const W={productCode:"BANK_PAY_DAILY_ORDER",isChecked:"202" as const,paidDesc:"合成提现",paidUse:"201",callbackUrl:"https://example.invalid/notify"};
const SUBMIT=["userNo","tradeMerchantNo","productCode","requestTime","merchantOrderNo","receiverAccountNoEnc","receiverNameEnc","receiverAccountType","receiverBankChannelNo","paidAmount","currency","isChecked","paidDesc","paidUse","callbackUrl","firstProductCode"],SYNC=["statusCode","message","errorCode","errorDesc","userNo","merchantOrderNo"],QUERY=["statusCode","message","status","errorCode","errorDesc","userNo","tradeMerchantNo","merchantOrderNo","platformSerialNo","receiverAccountNoEnc","receiverNameEnc","paidAmount","fee"],NOTIFY=["status","errorCode","errorCodeDesc","userNo","tradeMerchantNo","merchantOrderNo","platformSerialNo","receiverAccountNoEnc","receiverNameEnc","paidAmount","fee"];
const hash=(s:string)=>createHash("sha256").update(s).digest("hex"),md5=(order:readonly string[],v:Record<string,unknown>)=>createHash("md5").update(order.map(k=>v[k]??"").join("")+KEY).digest("hex");
function response(op:"SUBMIT"|"QUERY"|"NOTIFY",status="205",fee:string|undefined="0.50"){
 const v:Record<string,unknown>=op==="SUBMIT"?{statusCode:"2001",message:"fixture",userNo:B.userNo,merchantOrderNo:B.merchantOrderNo}:{...(op==="QUERY"?{statusCode:"2001",message:"fixture"}:{}),status,userNo:B.userNo,merchantOrderNo:B.merchantOrderNo,platformSerialNo:"FIXTURE_TRX_1",receiverAccountNoEnc:B.receiverAccountNoEnc,receiverNameEnc:B.receiverNameEnc,paidAmount:"99.00",...(fee==="ABSENT"?{}:{fee})};
 const hmac=md5(op==="SUBMIT"?SYNC:op==="QUERY"?QUERY:NOTIFY,v),encode=(o:Record<string,unknown>)=>"{"+Object.entries(o).map(([k,x])=>JSON.stringify(k)+":"+(["status","paidAmount","fee"].includes(k)?String(x):JSON.stringify(x))).join(",")+"}";
 if(op==="NOTIFY")return encode({...v,hmac});const{statusCode,message,...data}=v;return '{"statusCode":'+JSON.stringify(statusCode)+',"message":'+JSON.stringify(message)+',"data":'+encode({...data,hmac})+'}';
}
function config(op:"SUBMIT"|"QUERY"|"NOTIFY",purpose:"MERCHANT_PAYOUT"|"SYNTHETIC_PROTOCOL"="MERCHANT_PAYOUT"):Omit<PayoutProfileInput,"knownAnswer"> & {knownAnswer:Exclude<PayoutProfileInput["knownAnswer"],"NOT_OBTAINED">}{
 const request={...B,...W,requestTime:"2026-10-24 10:00:00",receiverAccountType:"201" as const},body=response(op);
 const requestHmac=op==="SUBMIT"?md5(SUBMIT,{...request,paidAmount:"99.00",currency:"201"}):op==="QUERY"?md5(["userNo","merchantOrderNo"],B):undefined;
 return{operation:op,purpose,profileId:`reviewed_${op}_fixture`,keyVersionRef:"key_fixture_v1",merchantIdentityId:B.merchantIdentityId,userNo:B.userNo,database:"zzsh_fixture",runtimeUser:"zzsh_fixture_r",reviewRef:"review://unit/provider",reviewSha256:H,
 wire:W,rules:R,requestUtcOffsetMinutes:0,targetRules:{encodingRuleRef:"review://unit/encoding",encodingRuleSha256:H,encodingImplementationRef:"review://unit/codec",encodingImplementationSha256:H,targetEchoRuleRef:"review://unit/echo",targetEchoRuleSha256:H,binding:"EXACT_RECORDED_OPAQUE_VALUE"},
 feePolicy:{reference:"review://unit/fee",sha256:H,providerUnit:"CNY_YUAN",merchantBearsFee:true,maxProviderFeeCents:"100",unpaidGuarantee:null},...(op==="NOTIFY"?{acknowledgement:{reference:"review://unit/ack",sha256:H,rule:"JSON_STATUS_2001_2002" as const,semantic:"VERIFIED_BOUND_OBSERVATION_COMMITTED" as const}}:{}),
 knownAnswer:{reference:"review://unit/kat",rawSha256:hash(body),vectorKey:KEY,binding:B,...(op==="SUBMIT"?{requestInput:request}:{}),...(requestHmac?{requestHmac}:{}),responseBody:body,expectedDecision:op==="SUBMIT"?"APPLICATION_ACCEPTED":"CHANNEL_REPORTED_SUCCEEDED"}};
}
function binding(p:ReturnType<typeof bindPayoutProfile>):PayoutBinding{const d=describePayoutProfile(p),{binding:_,...rules}=d.targetRules;return{...B,...rules,intentId:"fixture_intent",userId:"fixture_user",grossCents:"10000",feeCents:"100",currency:"CNY",targetFingerprint:H,receiverAccountType:"201",initialProfileId:d.profileId,initialProfileSha256:d.profileSha256,initialKeyVersionRef:d.keyVersionRef};}
test("模型KAT只验证计算，canonical不持久vectorKey/raw响应/目标；三操作分别绑定",()=>{
 const ps=(["SUBMIT","QUERY","NOTIFY"] as const).map(o=>bindPayoutProfile(config(o)));const scope=createPayoutScope({reference:"review://unit/scope",reviewSha256:H,database:"zzsh_fixture",runtimeUser:"zzsh_fixture_r",merchantIdentityId:B.merchantIdentityId,userNo:B.userNo,profiles:ps});assertPayoutStart(scope);
 for(const p of ps){const raw=readPayoutProfileEvidence(p);assert.equal(raw.includes(KEY),false);assert.equal(raw.includes("vectorKey"),false);assert.equal(raw.includes("responseBody"),false);assert.ok(Object.isFrozen(p));}
 const q=ps[1]!,calc=inspectPayoutProfile(q,"QUERY",response("QUERY"),binding(ps[0]!),KEY);assert.equal(calc.signature,"MATCH");assert.equal(calc.providerFeeCents,"50");assert.equal(eligiblePayoutTerminal(q,calc),"PAID");
 assert.equal(readPayoutScope(scope).acceptedProfiles.length,3); // 没有调用source capture，无正式事实或账务。
});

test("三操作可显式记录未取得样例，缺样例不自证官方校验或资金终态",()=>{
 for(const op of ["SUBMIT","QUERY","NOTIFY"] as const){const profile=bindPayoutProfile({...config(op),knownAnswer:"NOT_OBTAINED"} as any),text=readPayoutProfileEvidence(profile);assert.equal(JSON.parse(text).knownAnswer,"NOT_OBTAINED");assert.equal(text.includes(KEY),false);assert.equal(text.includes("responseBody"),false);}
});

test("无样例仍须真实回包验签，A2/无目的地规则/错误已给样例继续拒绝",()=>{
 const profile=bindPayoutProfile({...config("QUERY"),knownAnswer:"NOT_OBTAINED"} as any),b=binding(profile);
 const bad=response("QUERY").replace(/"hmac":"[a-fA-F0-9]+"/,'"hmac":"'+"0".repeat(32)+'"');const calculation=inspectPayoutProfile(profile,"QUERY",bad,b,KEY);assert.notEqual(calculation.signature,"MATCH");assert.equal(eligiblePayoutTerminal(profile,calculation),null);
 for(const patch of [{userNo:"888100000002340"},{targetRules:{}},{knownAnswer:undefined},{knownAnswer:{...config("QUERY").knownAnswer,rawSha256:"0".repeat(64)}}])assert.throws(()=>bindPayoutProfile({...config("QUERY"),knownAnswer:"NOT_OBTAINED",...patch} as any));
});
test("205费用缺失/超上限与204无未执行保证均不能成为资金终态",()=>{
 const p=bindPayoutProfile(config("QUERY")),b=binding(p);for(const [status,fee] of [["205","ABSENT"],["205","1.01"],["204","0.00"],["208","0.50"]] as const){const d=inspectPayoutProfile(p,"QUERY",response("QUERY",status,fee),b,KEY);assert.equal(eligiblePayoutTerminal(p,d),null);}
});
test("政策复核策略201/202精确匹配，无隐式直出；目标/初始profile/原号不可换",()=>{
 const p=bindPayoutProfile(config("SUBMIT")),b=binding(p);assertPayoutReviewStrategy(p,"VERIFIED_DIRECT_EXECUTION");assert.throws(()=>assertPayoutReviewStrategy(p,"MERCHANT_REVIEW_REQUIRED"));
 const request=producePayoutRequest(p,"SUBMIT",b,KEY,"2026-10-24T10:00:00.000Z");assert.ok(readPayoutOutbound(request).body.includes(B.merchantOrderNo));
 for(const patch of [{initialKeyVersionRef:"other"},{userNo:"888000000000002"},{currency:"USD"},{receiverAccountNoEnc:"bad\n"}])assert.throws(()=>producePayoutRequest(p,"SUBMIT",{...b,...patch} as any,KEY,"2026-10-24T10:00:00.000Z"));
 for(const bad of ["2026-02-30T00:00:00.000Z","2026-10-24 10:00:00","2026-10-24T10:00:00.000000Z"])assert.throws(()=>producePayoutRequest(p,"SUBMIT",b,KEY,bad));
 assert.throws(()=>producePayoutRequest(p,"NOTIFY" as any,b,KEY,"2026-10-24T10:00:00.000Z"));
 assert.deepEqual(computeJoinpayPayoutRequest({...config("SUBMIT").knownAnswer.requestInput!},KEY,R).body,readPayoutOutbound(request).body);
});
test("空模板/未知规则/孤立代理/getter/稀疏数组/hash强转/A2均拒绝且getter不调用",()=>{
 for(const patch of [{wire:{}},{userNo:"888100000002340"},{reviewSha256:[H]},{knownAnswer:{...config("QUERY").knownAnswer,responseBody:"\ud800"}},{feePolicy:{...config("QUERY").feePolicy,providerUnit:"UNKNOWN"}}])assert.throws(()=>bindPayoutProfile({...config("QUERY"),...patch} as any));
 let calls=0;const c={...config("QUERY"),get reviewRef(){calls++;return"review://unit/provider";}};assert.throws(()=>bindPayoutProfile(c));assert.equal(calls,0);
 const base={reference:"review://unit/read",reviewSha256:H,database:"zzsh_fixture",runtimeUser:"zzsh_fixture_r",merchantIdentityId:B.merchantIdentityId,userNo:B.userNo,profiles:[]};const s=createPayoutScope(base);assert.throws(()=>assertPayoutStart(s));assert.throws(()=>assertInitialPayoutScope(s,"other",H));
 for(const history of [[,{reference:"review://old",sha256:H}],[{reference:"review://old",sha256:H,vectorKey:KEY}]])assert.throws(()=>createPayoutScope({...base,historicalScopes:history as any}));
 const synthetic=bindPayoutProfile(config("QUERY","SYNTHETIC_PROTOCOL"));assert.throws(()=>createPayoutScope({...base,profiles:[synthetic]}));
});
test("新资格必须真实KYC来源、独立目标证明；当前VERIFIED或fake标签不足",()=>{
 const scope=createPayoutScope({reference:"review://unit/read",reviewSha256:H,database:"zzsh_fixture",runtimeUser:"zzsh_fixture_r",merchantIdentityId:B.merchantIdentityId,userNo:B.userNo,profiles:[]});
 const a:any={reference:"review://unit/business",reviewSha256:H,userId:"fixture_user",policy:{version:"p1",reference:"review://unit/policy",sha256:H,minCents:"100",maxCents:"10000",fee:{kind:"FIXED",cents:"0"},frequencyBasis:"ACCEPTED_INTENT",quotaStart:"2026-10-24T00:00:00.000Z",quotaEnd:"2026-10-25T00:00:00.000Z",maxIntents:3,reviewStrategy:"MERCHANT_REVIEW_REQUIRED",validFrom:"2026-10-24T00:00:00.000Z",expiresAt:"2026-10-25T00:00:00.000Z"},identity:{provider:"reviewed_kyc",providerReference:"provider_fixture",version:1,proofReference:"review://unit/kyc",proofSha256:H,validUntil:"2026-10-25T00:00:00.000Z"},target:{destinationId:"target_fixture",revision:"1",userId:"fixture_user",mask:"模型尾号",fingerprint:H,bankOwnershipReference:"review://unit/owner",bankOwnershipSha256:H,...config("SUBMIT").targetRules,receiverAccountNoEnc:B.receiverAccountNoEnc,receiverNameEnc:B.receiverNameEnc,receiverAccountType:"201"}};delete a.target.binding;
 const admitted=createWithdrawalAdmission(scope,a);assert.ok(Object.isFrozen(readWithdrawalAdmission(admitted).target));
 for(const patch of [{identity:{...a.identity,provider:"fake"}},{target:{...a.target,userId:"other"}},{target:{...a.target,bankOwnershipSha256:undefined}},{policy:{...a.policy,reviewStrategy:undefined}},{identity:{...a.identity,proofReference:"SYNTHETIC_KYC"}}])assert.throws(()=>createWithdrawalAdmission(scope,{...a,...patch}));
});
test("HTTP/克隆/旧LOCAL/合成事实都不能越过同client+xid私有品牌，0SQL",async()=>{
 let sql=0;const c={query:async()=>{sql++;throw Error("UNEXPECTED");}} as unknown as PoolClient;
 for(const v of [{},null,{source:"JOINPAY",verified:true,terminal:"PAID"},{evidenceLevel:"SYNTHETIC_PROTOCOL"},{source:"LOCAL_CONTROLLED"}])await assert.rejects(assertNativeWithdrawalFact(c,v));assert.equal(sql,0);
});
test("持久合成/截断/错hash/STALE原件一律不取钥、不mint事实",async t=>{
 const store=require("../src/finance/native-withdrawal-store"),scope={} as any,row={id:"intent_fixture",requires_review:false,terminal_evidence_id:null} as any;
 t.mock.method(store,"assertNativePayoutResource",async()=>"10");t.mock.method(store,"lockNativeWithdrawal",async()=>({row,revision:"1"}));t.mock.method(store,"nativePayoutBinding",()=>B);
 let keys=0,profiles=0;const options={scope,profileFor:()=>{profiles++;throw Error("MUST_NOT_LOAD");},keyFor:()=>{keys++;return KEY;}};
 for(const patch of [{evidence_level:"SYNTHETIC_PROTOCOL"},{response_complete:false},{raw_sha256:H},{event:"STALE"}]){
  const raw=Buffer.from(response("QUERY")),obs={id:"obs_fixture",intent_id:row.id,operation:"QUERY",response_complete:true,evidence_level:"PROVIDER_RESPONSE",transport_failure:null,http_status:200,event:"PENDING_TERMINAL",raw_body:raw,raw_sha256:hash(raw.toString()),profile_canonical:"{}",profile_sha256:hash("{}"),...patch};
  const c={query:async()=>({rows:[obs]})} as unknown as PoolClient;assert.equal(await capturePayoutFact(c,options,row.id,obs.id),null);
 }assert.equal(keys,0);assert.equal(profiles,0);
 row.requires_review=true;assert.equal(await capturePayoutFact({} as PoolClient,options,row.id,"obs_fixture"),null);
 await assert.rejects(readVerifiedPayoutFact({query:async()=>({rows:[{facts_canonical:"{}",facts_digest:H}]})} as any,options,"evidence_fixture"));
});
test("终态相反/异流水/费用原文变化只冲突，不改原账或推断银行到账",()=>{
 const a={terminal:"PAID",platformSerialNo:"trx1",providerFeeRaw:"0.00",providerFeeCents:"0"};assert.equal(payoutTerminalConflicts(a,{...a}),false);for(const patch of [{terminal:"UNPAID_CONFIRMED"},{platformSerialNo:"trx2"},{providerFeeRaw:"0.0"},{providerFeeCents:"1"}])assert.equal(payoutTerminalConflicts(a,{...a,...patch}),true);
});
