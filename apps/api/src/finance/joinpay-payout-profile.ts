import {createHash} from "node:crypto";
import {computeJoinpayPayoutRequest,computeJoinpayPayoutQuery,computeJoinpayPayoutResponse,preflightJoinpayPayoutResponse,validateJoinpayPayoutSubmitInput,validateJoinpayPayoutWireTemplate,JOINPAY_PAYOUT_WIRE_TEMPLATE_FIELDS,
  type JoinpayPayoutBinding,type JoinpayPayoutSubmitInput,type PayoutWireRules,type PayoutCalculation} from "./joinpay-payout-protocol";
import {calculateWithdrawalAmounts,type WithdrawalFee} from "./withdrawal-ledger";
const sha=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex"),ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,isSha=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown,n=128):v is string=>typeof v==="string"&&v.length>0&&v.trim()===v&&Buffer.byteLength(v)<=n&&!/\p{Cs}/u.test(v);
const positive=(v:unknown):v is string=>typeof v==="string"&&/^[1-9][0-9]{0,15}$/.test(v)&&BigInt(v)<=9999999999999999n;
const nonnegative=(v:unknown):v is string=>v==="0"||positive(v);
export class PayoutProfileError extends Error{constructor(readonly code:string){super(code);}}
function fail(code="PAYOUT_PROFILE_UNAVAILABLE"):never{throw new PayoutProfileError(code);}
/** 配置只接受稳定数据快照；不执行getter/iterator/toJSON，也不把hash当官方真实性认证。 */
function data(v:unknown):any{
 if(typeof v==="string"){if(/\p{Cs}/u.test(v))fail();return v;}if(v===null||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v))return v;
 if(!v||typeof v!=="object"||![Object.prototype,Array.prototype].includes(Object.getPrototypeOf(v)))return fail();
 const ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(ds);if(keys.some(k=>typeof k!=="string"))fail();const array=Array.isArray(v),out:any=array?[]:{};
 if(array){const len=ds.length?.value;if(!Number.isInteger(len)||len<0||len>256||keys.length!==len+1)fail();for(let i=0;i<len;i++)if(!ds[String(i)]||!("value" in ds[String(i)]!)||!ds[String(i)]!.enumerable)fail();}
 for(const k of keys as string[]){if(array&&k==="length")continue;const d=ds[k]!;if(!("value" in d)||!d.enumerable||k==="__proto__"||/\p{Cs}/u.test(k))fail();out[k]=data(d.value);}return Object.freeze(out);
}
function only(v:object,keys:readonly string[]){if(Object.keys(v).some(k=>!keys.includes(k)))fail();}
const utc=(v:unknown):v is string=>typeof v==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const actualRef=(v:unknown):v is string=>text(v,512)&&!/SYNTHETIC|MODEL|LOCAL_CONTROLLED/i.test(v);
export type PayoutProfileOperation="SUBMIT"|"QUERY"|"NOTIFY";
export type PayoutTargetRules=Readonly<{encodingRuleRef:string;encodingRuleSha256:string;encodingImplementationRef:string;encodingImplementationSha256:string;targetEchoRuleRef:string;targetEchoRuleSha256:string;binding:"EXACT_RECORDED_OPAQUE_VALUE"}>;
export type PayoutFeePolicy=Readonly<{reference:string;sha256:string;providerUnit:"CNY_YUAN";merchantBearsFee:true;maxProviderFeeCents:string;
 unpaidGuarantee:null|{reference:string;sha256:string;statuses:readonly string[];transferredCents:"0";chargedUserFeeCents:"0";requiredProviderFeeCents:"0";paidAmountMeaning:"REQUESTED_NET"}}>;
export type PayoutProfileInput=Readonly<{operation:PayoutProfileOperation;purpose:"MERCHANT_PAYOUT"|"SYNTHETIC_PROTOCOL";profileId:string;keyVersionRef:string;merchantIdentityId:string;userNo:string;tradeMerchantNo?:string;database:string;runtimeUser:string;reviewRef:string;reviewSha256:string;
 wire:Readonly<{productCode:string;isChecked:"201"|"202";paidDesc:string;paidUse:string;callbackUrl?:string;firstProductCode?:string}>;
 rules:PayoutWireRules;requestUtcOffsetMinutes:number;targetRules:PayoutTargetRules;feePolicy:PayoutFeePolicy;acknowledgement?:Readonly<{reference:string;sha256:string;rule:"JSON_STATUS_2001_2002";semantic:"VERIFIED_BOUND_OBSERVATION_COMMITTED"}>;
 knownAnswer:Readonly<{reference:string;rawSha256:string;vectorKey:string;binding:JoinpayPayoutBinding;requestInput?:JoinpayPayoutSubmitInput;requestHmac?:string;responseBody:string;expectedDecision:PayoutCalculation["decision"]}>|"NOT_OBTAINED"}>;
export type BoundPayoutProfile=Readonly<{kind:"BOUND_JOINPAY_PAYOUT_PROFILE"}>;
type Profile=PayoutProfileInput&{canonical:string;sha256:string};const profiles=new WeakMap<object,Profile>();
function get(p:BoundPayoutProfile):Profile{return profiles.get(p)??fail("PAYOUT_PROFILE_NOT_BOUND");}
function targetRules(r:PayoutTargetRules){if(!r||r.binding!=="EXACT_RECORDED_OPAQUE_VALUE")fail();only(r,["encodingRuleRef","encodingRuleSha256","encodingImplementationRef","encodingImplementationSha256","targetEchoRuleRef","targetEchoRuleSha256","binding"]);
 for(const k of ["encodingRule","encodingImplementation","targetEchoRule"] as const)if(!text(r[`${k}Ref`],512)||!isSha(r[`${k}Sha256`]))fail();}
export function bindPayoutProfile(input:PayoutProfileInput):BoundPayoutProfile{
 const p=data(input) as PayoutProfileInput;only(p,["operation","purpose","profileId","keyVersionRef","merchantIdentityId","userNo","tradeMerchantNo","database","runtimeUser","reviewRef","reviewSha256","wire","rules","requestUtcOffsetMinutes","targetRules","feePolicy","acknowledgement","knownAnswer"]);
 if(!["SUBMIT","QUERY","NOTIFY"].includes(p.operation)||!["MERCHANT_PAYOUT","SYNTHETIC_PROTOCOL"].includes(p.purpose)||![p.profileId,p.keyVersionRef,p.merchantIdentityId].every(v=>typeof v==="string"&&ID.test(v))
  ||typeof p.userNo!=="string"||!/^\d{1,32}$/.test(p.userNo)||p.userNo==="888100000002340"||p.tradeMerchantNo!==undefined&&!text(p.tradeMerchantNo))fail();
 if(![p.database,p.runtimeUser].every(v=>typeof v==="string"&&/^[a-z][a-z0-9_]{0,62}$/.test(v))||!text(p.reviewRef,512)||!isSha(p.reviewSha256)||!Number.isInteger(p.requestUtcOffsetMinutes)||Math.abs(p.requestUtcOffsetMinutes)>840)fail();
 try{validateJoinpayPayoutWireTemplate(p.wire);}catch{fail("PAYOUT_WIRE_UNAVAILABLE");}
 only(p.rules,["dataEncoding","statusCodeToken","statusToken","amountToken","feeToken","accountTypeToken","optionalSigning","numericSigning","unknownFields","notFoundShape","targetBinding","providerFeeUnit"]);
 targetRules(p.targetRules);const f=p.feePolicy;if(!f||!text(f.reference,512)||!isSha(f.sha256)||f.providerUnit!=="CNY_YUAN"||p.rules.providerFeeUnit!==f.providerUnit||f.merchantBearsFee!==true||!nonnegative(f.maxProviderFeeCents))fail();
 only(f,["reference","sha256","providerUnit","merchantBearsFee","maxProviderFeeCents","unpaidGuarantee"]);
 if(f.unpaidGuarantee){const n=f.unpaidGuarantee;only(n,["reference","sha256","statuses","transferredCents","chargedUserFeeCents","requiredProviderFeeCents","paidAmountMeaning"]);if(!text(n.reference,512)||!isSha(n.sha256)||!Array.isArray(n.statuses)||!n.statuses.length||n.statuses.some(v=>v!=="204"&&v!=="208")||n.transferredCents!=="0"||n.chargedUserFeeCents!=="0"||n.requiredProviderFeeCents!=="0"||n.paidAmountMeaning!=="REQUESTED_NET")fail();}
 if(p.operation==="NOTIFY"){const a=p.acknowledgement;if(!a||!text(a.reference,512)||!isSha(a.sha256)||a.rule!=="JSON_STATUS_2001_2002"||a.semantic!=="VERIFIED_BOUND_OBSERVATION_COMMITTED")fail("PAYOUT_ACK_RULE_UNAVAILABLE");only(a,["reference","sha256","rule","semantic"]);}else if(p.acknowledgement!==undefined)fail();
 const k=p.knownAnswer;
 // 显式未取得样例不自证官方通过，也不免除真实响应签名/目标/金额校验。
 if(k!=="NOT_OBTAINED"){
 if(!k||!text(k.reference,512)||!text(k.vectorKey,4096)||typeof k.responseBody!=="string"||Buffer.byteLength(k.responseBody)>65536||!isSha(k.rawSha256)||sha(k.responseBody)!==k.rawSha256||k.binding.merchantIdentityId!==p.merchantIdentityId||k.binding.userNo!==p.userNo||k.binding.tradeMerchantNo!==p.tradeMerchantNo)fail("PAYOUT_KAT_REQUIRED");
 if(p.operation==="SUBMIT"){if(!k.requestInput)fail("PAYOUT_REQUEST_KAT_REQUIRED");const form=computeJoinpayPayoutRequest(k.requestInput!,k.vectorKey,p.rules);if(form.hmac!==k.requestHmac?.toLowerCase())fail("PAYOUT_KAT_MISMATCH");for(const name of JOINPAY_PAYOUT_WIRE_TEMPLATE_FIELDS)if(k.requestInput![name]!==p.wire[name])fail("PAYOUT_WIRE_KAT_MISMATCH");}
 else if(p.operation==="QUERY"&&computeJoinpayPayoutQuery(k.binding,k.vectorKey,p.rules).hmac!==k.requestHmac?.toLowerCase())fail("PAYOUT_KAT_MISMATCH");
 const result=computeJoinpayPayoutResponse(p.operation==="SUBMIT"?"SYNC":p.operation,k.responseBody,{binding:k.binding,key:k.vectorKey,rules:p.rules,leaseCurrent:true});
 if(result.signature!=="MATCH"||result.binding!=="MATCH"||result.decision!==k.expectedDecision)fail("PAYOUT_KAT_MISMATCH");
 }
 const canonical=JSON.stringify({kind:"JOINPAY_PAYOUT_PROFILE_V1",...p,knownAnswer:k==="NOT_OBTAINED"?k:{reference:k.reference,rawSha256:k.rawSha256,expectedDecision:k.expectedDecision}}),token=Object.freeze({kind:"BOUND_JOINPAY_PAYOUT_PROFILE" as const});profiles.set(token,Object.freeze({...p,canonical,sha256:sha(canonical)}));return token;
}
export function describePayoutProfile(p:BoundPayoutProfile,operation?:PayoutProfileOperation){const v=get(p);if(operation&&v.operation!==operation)fail("PAYOUT_OPERATION_MISMATCH");return Object.freeze({operation:v.operation,purpose:v.purpose,profileId:v.profileId,profileSha256:v.sha256,keyVersionRef:v.keyVersionRef,merchantIdentityId:v.merchantIdentityId,userNo:v.userNo,tradeMerchantNo:v.tradeMerchantNo,database:v.database,runtimeUser:v.runtimeUser,targetRules:v.targetRules});}
export const readPayoutProfileEvidence=(p:BoundPayoutProfile)=>get(p).canonical;
export type PayoutScope=Readonly<{kind:"JOINPAY_PAYOUT_SCOPE"}>;
type Accepted={operation:PayoutProfileOperation;profileId:string;profileSha256:string;keyVersionRef:string};
export type PayoutScopeView=Readonly<{reference:string;sha256:string;canonical:string;database:string;runtimeUser:string;merchantIdentityId:string;userNo:string;tradeMerchantNo?:string;acceptedProfiles:readonly Accepted[];historicalScopes:readonly {reference:string;sha256:string}[]}>;
const scopes=new WeakMap<object,PayoutScopeView>();
/** 来源真实性由受信后台审核；本构造只封稳定配置，不从客户端JSON或OFFICIAL字串认证商户。 */
export function createPayoutScope(input:{reference:string;reviewSha256:string;database:string;runtimeUser:string;merchantIdentityId:string;userNo:string;tradeMerchantNo?:string;profiles:readonly BoundPayoutProfile[];historicalScopes?:readonly {reference:string;sha256:string}[]}):PayoutScope{
 const ds=Object.getOwnPropertyDescriptors(input);for(const d of Object.values(ds))if(!("value" in d))fail();
 const m=data({reference:ds.reference?.value,reviewSha256:ds.reviewSha256?.value,database:ds.database?.value,runtimeUser:ds.runtimeUser?.value,merchantIdentityId:ds.merchantIdentityId?.value,userNo:ds.userNo?.value,...(ds.tradeMerchantNo?.value===undefined?{}:{tradeMerchantNo:ds.tradeMerchantNo.value}),history:ds.historicalScopes?.value??[]});
 if(!actualRef(m.reference)||!isSha(m.reviewSha256)||![m.database,m.runtimeUser].every(v=>typeof v==="string"&&/^[a-z][a-z0-9_]{0,62}$/.test(v))||typeof m.merchantIdentityId!=="string"||!ID.test(m.merchantIdentityId)||typeof m.userNo!=="string"||!/^\d{1,32}$/.test(m.userNo)||m.userNo==="888100000002340")fail();
 const supplied=ds.profiles?.value;if(!Array.isArray(supplied)||supplied.length>64||Object.getPrototypeOf(supplied)!==Array.prototype)return fail();
 const accepted:Accepted[]=[];for(let i=0;i<supplied.length;i++){const d=Object.getOwnPropertyDescriptor(supplied,String(i));if(!d||!("value" in d))return fail();const p=get(d.value as BoundPayoutProfile),s=describePayoutProfile(d.value as BoundPayoutProfile);
  if(p.purpose!=="MERCHANT_PAYOUT"||![p.profileId,p.reviewRef,...(p.knownAnswer==="NOT_OBTAINED"?[]:[p.knownAnswer.reference]),p.targetRules.encodingRuleRef,p.targetRules.encodingImplementationRef,p.targetRules.targetEchoRuleRef,p.feePolicy.reference,...(p.feePolicy.unpaidGuarantee?[p.feePolicy.unpaidGuarantee.reference]:[]),...(p.acknowledgement?[p.acknowledgement.reference]:[])].every(actualRef)||s.database!==m.database||s.runtimeUser!==m.runtimeUser||s.merchantIdentityId!==m.merchantIdentityId||s.userNo!==m.userNo||s.tradeMerchantNo!==m.tradeMerchantNo)fail("PAYOUT_FORMAL_PROFILE_UNAVAILABLE");
  accepted.push(Object.freeze({operation:p.operation,profileId:p.profileId,profileSha256:p.sha256,keyVersionRef:p.keyVersionRef}));}
 const history=Object.freeze(m.history.map((h:any)=>{only(h,["reference","sha256"]);if(!actualRef(h.reference)||!isSha(h.sha256))fail();return Object.freeze({reference:h.reference as string,sha256:h.sha256 as string});}));
 const body={kind:"JOINPAY_PAYOUT_SERVER_SCOPE",reference:m.reference,reviewSha256:m.reviewSha256,database:m.database,runtimeUser:m.runtimeUser,merchantIdentityId:m.merchantIdentityId,userNo:m.userNo,...(m.tradeMerchantNo===undefined?{}:{tradeMerchantNo:m.tradeMerchantNo}),acceptedProfiles:accepted,historicalScopes:history};
 const canonical=JSON.stringify(body),token=Object.freeze({kind:"JOINPAY_PAYOUT_SCOPE" as const});scopes.set(token,Object.freeze({...body,sha256:sha(canonical),canonical,acceptedProfiles:Object.freeze(accepted)}));return token;
}
export const readPayoutScope=(s:PayoutScope):PayoutScopeView=>scopes.get(s)??fail("PAYOUT_SCOPE_NOT_BOUND");
export function assertPayoutProfile(s:PayoutScope,p:BoundPayoutProfile,operation:PayoutProfileOperation){const a=readPayoutScope(s),v=describePayoutProfile(p,operation);if(v.purpose!=="MERCHANT_PAYOUT"||v.database!==a.database||v.runtimeUser!==a.runtimeUser||v.merchantIdentityId!==a.merchantIdentityId||v.userNo!==a.userNo||v.tradeMerchantNo!==a.tradeMerchantNo||!a.acceptedProfiles.some(x=>x.operation===operation&&x.profileId===v.profileId&&x.profileSha256===v.profileSha256&&x.keyVersionRef===v.keyVersionRef))fail("PAYOUT_PROFILE_NOT_ADMITTED");return a;}
export function assertPayoutStart(s:PayoutScope){const a=readPayoutScope(s);for(const o of ["SUBMIT","QUERY","NOTIFY"])if(!a.acceptedProfiles.some(p=>p.operation===o))fail("PAYOUT_NEW_EXECUTION_UNAVAILABLE");}
export function assertInitialPayoutScope(s:PayoutScope,reference:string,digest:string){const a=readPayoutScope(s);if(!(a.reference===reference&&a.sha256===digest)&&!a.historicalScopes.some(x=>x.reference===reference&&x.sha256===digest))fail("PAYOUT_INITIAL_SCOPE_UNAVAILABLE");}
export type WithdrawalPolicy=Readonly<{version:string;reference:string;sha256:string;minCents:string;maxCents:string;fee:WithdrawalFee;frequencyBasis:"ACCEPTED_INTENT"|"ACTIVE_OR_SUCCEEDED";quotaStart:string;quotaEnd:string;maxIntents:number;reviewStrategy:"VERIFIED_DIRECT_EXECUTION"|"MERCHANT_REVIEW_REQUIRED";validFrom:string;expiresAt:string}>;
export type WithdrawalTarget=Readonly<{destinationId:string;revision:string;userId:string;mask:string;fingerprint:string;bankOwnershipReference:string;bankOwnershipSha256:string;encodingRuleRef:string;encodingRuleSha256:string;encodingImplementationRef:string;encodingImplementationSha256:string;targetEchoRuleRef:string;targetEchoRuleSha256:string;receiverAccountNoEnc:string;receiverNameEnc:string;receiverAccountType:"201"|"204";receiverBankChannelNo?:string}>;
export type WithdrawalAdmissionInput=Readonly<{reference:string;reviewSha256:string;userId:string;policy:WithdrawalPolicy;identity:{provider:string;providerReference:string;version:number;proofReference:string;proofSha256:string;validUntil:string};target:WithdrawalTarget}>;
export type WithdrawalAdmission=Readonly<{kind:"REVIEWED_WITHDRAWAL_ADMISSION"}>;
type Admission=WithdrawalAdmissionInput&{scopeReference:string;scopeSha256:string;canonical:string;sha256:string};const admissions=new WeakMap<object,Admission>();
export function createWithdrawalAdmission(scope:PayoutScope,input:WithdrawalAdmissionInput):WithdrawalAdmission{
 const a=readPayoutScope(scope),v=data(input) as WithdrawalAdmissionInput;only(v,["reference","reviewSha256","userId","policy","identity","target"]);
 if(!actualRef(v.reference)||!isSha(v.reviewSha256)||typeof v.userId!=="string"||!ID.test(v.userId))fail("WITHDRAWAL_BUSINESS_SOURCE_UNAVAILABLE");
 const p=v.policy,t=v.target,k=v.identity;
 if(!p||!t||!k)fail();
 only(p,["version","reference","sha256","minCents","maxCents","fee","frequencyBasis","quotaStart","quotaEnd","maxIntents","reviewStrategy","validFrom","expiresAt"]);
 only(k,["provider","providerReference","version","proofReference","proofSha256","validUntil"]);
 only(t,["destinationId","revision","userId","mask","fingerprint","bankOwnershipReference","bankOwnershipSha256","encodingRuleRef","encodingRuleSha256","encodingImplementationRef","encodingImplementationSha256","targetEchoRuleRef","targetEchoRuleSha256","receiverAccountNoEnc","receiverNameEnc","receiverAccountType","receiverBankChannelNo"]);
 only(p.fee,p.fee.kind==="FIXED"?["kind","cents"]:["kind","numerator","denominator","rounding"]);
 if(!p||!text(p.version)||!actualRef(p.reference)||!isSha(p.sha256)||!positive(p.minCents)||!positive(p.maxCents)||BigInt(p.minCents)>BigInt(p.maxCents)||!["ACCEPTED_INTENT","ACTIVE_OR_SUCCEEDED"].includes(p.frequencyBasis)||!Number.isSafeInteger(p.maxIntents)||p.maxIntents<1||!["VERIFIED_DIRECT_EXECUTION","MERCHANT_REVIEW_REQUIRED"].includes(p.reviewStrategy)||![p.quotaStart,p.quotaEnd,p.validFrom,p.expiresAt].every(utc)||p.quotaStart>=p.quotaEnd||p.validFrom>=p.expiresAt)fail("WITHDRAWAL_POLICY_UNAVAILABLE");
 calculateWithdrawalAmounts(p.minCents,p.fee);
 if(!k||!actualRef(k.provider)||/^(fake|none|legacy.*)$/i.test(k.provider)||!text(k.providerReference,512)||!Number.isSafeInteger(k.version)||k.version<1||!actualRef(k.proofReference)||!isSha(k.proofSha256)||!utc(k.validUntil))fail("WITHDRAWAL_KYC_UNAVAILABLE");
 if(!t||t.userId!==v.userId||!text(t.destinationId)||!text(t.revision)||!text(t.mask,100)||!isSha(t.fingerprint)||!actualRef(t.bankOwnershipReference)||!isSha(t.bankOwnershipSha256)||!text(t.receiverAccountNoEnc,8192)||!text(t.receiverNameEnc,8192)||!["201","204"].includes(t.receiverAccountType)||t.receiverAccountType==="204"&&!text(t.receiverBankChannelNo))fail("WITHDRAWAL_TARGET_UNAVAILABLE");
 targetRules({encodingRuleRef:t.encodingRuleRef,encodingRuleSha256:t.encodingRuleSha256,encodingImplementationRef:t.encodingImplementationRef,encodingImplementationSha256:t.encodingImplementationSha256,targetEchoRuleRef:t.targetEchoRuleRef,targetEchoRuleSha256:t.targetEchoRuleSha256,binding:"EXACT_RECORDED_OPAQUE_VALUE"});
 const canonical=JSON.stringify({kind:"JOINPAY_WITHDRAWAL_BUSINESS_ADMISSION",...v,scopeReference:a.reference,scopeSha256:a.sha256}),token=Object.freeze({kind:"REVIEWED_WITHDRAWAL_ADMISSION" as const});admissions.set(token,Object.freeze({...v,scopeReference:a.reference,scopeSha256:a.sha256,canonical,sha256:sha(canonical)}));return token;
}
export function readWithdrawalAdmission(a:WithdrawalAdmission){return admissions.get(a)??fail("WITHDRAWAL_ADMISSION_NOT_BOUND");}
export type PayoutBinding=JoinpayPayoutBinding&Readonly<{intentId:string;userId:string;grossCents:string;feeCents:string;currency:"CNY";targetFingerprint:string;receiverAccountType:"201"|"204";receiverBankChannelNo?:string;initialProfileId:string;initialProfileSha256:string;initialKeyVersionRef:string;encodingRuleRef:string;encodingRuleSha256:string;encodingImplementationRef:string;encodingImplementationSha256:string;targetEchoRuleRef:string;targetEchoRuleSha256:string}>;
function submission(p:Profile,b:PayoutBinding,requestTime:string):JoinpayPayoutSubmitInput{return{...b,...p.wire,requestTime};}
function sameMerchant(p:Profile,b:PayoutBinding){if(p.merchantIdentityId!==b.merchantIdentityId||p.userNo!==b.userNo||p.tradeMerchantNo!==b.tradeMerchantNo||b.currency!=="CNY")fail("PAYOUT_ORIGINAL_BINDING_MISMATCH");}
export function payoutRequestTime(p:BoundPayoutProfile,iso:string):string{if(!utc(iso))return fail("PAYOUT_REQUEST_CLOCK_UNAVAILABLE");return new Date(Date.parse(iso)+get(p).requestUtcOffsetMinutes*60000).toISOString().slice(0,19).replace("T"," ");}
export function assertPayoutReviewStrategy(profile:BoundPayoutProfile,strategy:WithdrawalPolicy["reviewStrategy"]){const expected=strategy==="VERIFIED_DIRECT_EXECUTION"?"202":strategy==="MERCHANT_REVIEW_REQUIRED"?"201":null;if(!expected||get(profile).wire.isChecked!==expected)fail("PAYOUT_REVIEW_STRATEGY_MISMATCH");}
export function assertPayoutSubmitBinding(profile:BoundPayoutProfile,b:PayoutBinding,iso:string){const p=get(profile);sameMerchant(p,b);if(p.operation!=="SUBMIT"||p.profileId!==b.initialProfileId||p.sha256!==b.initialProfileSha256||p.keyVersionRef!==b.initialKeyVersionRef)fail("PAYOUT_INITIAL_PROFILE_MISMATCH");for(const k of ["encodingRuleRef","encodingRuleSha256","encodingImplementationRef","encodingImplementationSha256","targetEchoRuleRef","targetEchoRuleSha256"] as const)if(b[k]!==p.targetRules[k])fail("PAYOUT_TARGET_RULE_MISMATCH");validateJoinpayPayoutSubmitInput(submission(p,b,payoutRequestTime(profile,iso)),p.rules);}
export type PayoutOutbound=Readonly<{operation:"SUBMIT"|"QUERY";requestSha256:string}>;const outbounds=new WeakMap<object,{endpoint:string;body:string;purpose:PayoutProfileInput["purpose"]}>();
export function producePayoutRequest(profile:BoundPayoutProfile,operation:"SUBMIT"|"QUERY",b:PayoutBinding,key:string,iso:string):PayoutOutbound{
 const p=get(profile);sameMerchant(p,b);if(p.operation!==operation||!["SUBMIT","QUERY"].includes(operation))fail("PAYOUT_OUTBOUND_OPERATION_INVALID");
 if(operation==="SUBMIT")assertPayoutSubmitBinding(profile,b,iso);const wire=operation==="SUBMIT"?computeJoinpayPayoutRequest(submission(p,b,payoutRequestTime(profile,iso)),key,p.rules):computeJoinpayPayoutQuery(b,key,p.rules);
 const token=Object.freeze({operation,requestSha256:sha(wire.body)});outbounds.set(token,Object.freeze({endpoint:operation==="SUBMIT"?"https://www.joinpay.com/payment/pay/singlePay":"https://www.joinpay.com/payment/pay/singlePayQuery",body:wire.body,purpose:p.purpose}));return token;
}
export const readPayoutOutbound=(o:PayoutOutbound)=>outbounds.get(o)??fail("PAYOUT_OUTBOUND_NOT_BOUND");
export function payoutAcknowledgement(profile:BoundPayoutProfile,accepted:boolean){const p=get(profile);if(p.operation!=="NOTIFY"||p.acknowledgement?.rule!=="JSON_STATUS_2001_2002")fail("PAYOUT_ACK_RULE_UNAVAILABLE");return accepted?'{"statusCode":"2001"}':'{"statusCode":"2002","message":"not accepted"}';}
export function preflightPayoutProfile(profile:BoundPayoutProfile,operation:PayoutProfileOperation,body:string|Uint8Array,binding:PayoutBinding){const p=get(profile);sameMerchant(p,binding);if(p.operation!==operation)fail("PAYOUT_OPERATION_MISMATCH");return preflightJoinpayPayoutResponse(operation==="SUBMIT"?"SYNC":operation,body,{rules:p.rules});}
export function inspectPayoutProfile(profile:BoundPayoutProfile,operation:PayoutProfileOperation,body:string|Uint8Array,binding:PayoutBinding,key:string){const p=get(profile);sameMerchant(p,binding);if(p.operation!==operation)fail("PAYOUT_OPERATION_MISMATCH");return computeJoinpayPayoutResponse(operation==="SUBMIT"?"SYNC":operation,body,{binding,key,rules:p.rules,leaseCurrent:true});}
/** 这里只算接纳资格；无私有来源品牌，不能记钱。 */
export function eligiblePayoutTerminal(profile:BoundPayoutProfile,r:PayoutCalculation):"PAID"|"UNPAID_CONFIRMED"|null{
 const p=get(profile),f=p.feePolicy;if(r.signature!=="MATCH"||r.binding!=="MATCH"||r.providerFeeCents===null||r.providerFeeRaw===null||BigInt(r.providerFeeCents)>BigInt(f.maxProviderFeeCents)||p.rules.providerFeeUnit!=="CNY_YUAN")return null;
 if(r.decision==="CHANNEL_REPORTED_SUCCEEDED"&&r.providerStatus==="205"&&r.platformSerialNo&&r.paidCents!==null)return"PAID";
 const n=f.unpaidGuarantee;if(r.decision==="CHANNEL_REPORTED_FAILED"&&n&&n.statuses.includes(r.providerStatus??"")&&r.platformSerialNo&&r.providerFeeCents==="0")return"UNPAID_CONFIRMED";return null;
}
