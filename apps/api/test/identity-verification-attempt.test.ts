import assert from "node:assert/strict";
import test from "node:test";
import type {AuthSecurityOptions,AuthSecurityNodeRequest,AuthSecurityNodeResponse} from "../src/auth/auth-security";
import {handleUserIdentityRoute,identityAllowsProtectedTrade,type RealNameProvider,type RealNameVerificationResult,type UserIdentityState} from "../src/auth/user-identity";
import {identityVerificationAttempt,identityVerificationKey,MARKET_IDENTITY_PROVIDER_DISCLOSURE} from "../src/auth/identity-verification-attempt";
import {legalDigest} from "../src/legal/legal-documents";

const key=Buffer.alloc(32,6),documentNumber="110105199001011232",privacyBody="SYNTHETIC privacy policy for offline provider tests only";
const privacyAcceptance={accepted:true,versionId:"privacy-synthetic-v1",digest:legalDigest(privacyBody),disclosureVersion:"identity-provider-transfer-v1"};
const body={fullName:"合成姓名",documentNumber,privacyAcceptance};
const verified:RealNameVerificationResult={provider:"aliyun-id2meta",providerReference:"synthetic-reference",status:"VERIFIED",ageStatus:"ADULT"};
const legacy:UserIdentityState={accountStatus:"ACTIVE",identityStatus:"VERIFIED",ageStatus:"UNKNOWN",provider:"legacy_mysql_restore",version:7};

function fixture(provider:RealNameProvider,initial:UserIdentityState={accountStatus:"ACTIVE",identityStatus:"UNVERIFIED",ageStatus:"UNKNOWN",provider:"none",version:0}){
 let state={...initial},snapshot:UserIdentityState|null=null,attempts=new Map<string,Record<string,unknown>>(),savedAttempts:Map<string,Record<string,unknown>>|null=null;
 const statements:Array<{sql:string;values:unknown[]}>=[];
 const control={failProfile:false,profileReady:true,failCommitAfterState:false,commitAppliedButAckLost:false,dailyCount:"0",elapsed:null as string|null,privacyAvailable:true,privacyVersion:"privacy-synthetic-v1",subjectDigest:null as string|null,legacyMatches:true};
 const query=async(sql:string,values:unknown[]=[])=>{
  statements.push({sql,values});
  if(sql==="BEGIN"){snapshot={...state};savedAttempts=new Map([...attempts].map(([k,v])=>[k,{...v}]));}
  if(sql==="ROLLBACK"){if(snapshot)state=snapshot;if(savedAttempts)attempts=savedAttempts;}
  if(sql==="COMMIT"&&control.failCommitAfterState&&state.version!==initial.version){control.failCommitAfterState=false;throw Error("synthetic COMMIT unknown");}
  if(sql==="COMMIT"&&control.commitAppliedButAckLost&&state.version!==initial.version){control.commitAppliedButAckLost=false;snapshot=null;savedAttempts=null;throw Error("synthetic committed but ACK lost");}
  if(sql.includes('COALESCE(s."account_status"'))return{rows:[{suspended:false,accountStatus:"ACTIVE"}],rowCount:1};
  if(sql.startsWith('SELECT "suspended"'))return{rows:[{suspended:false}],rowCount:1};
  if(sql.includes('AS "accountStatus"')&&sql.includes('WHERE "user_id"'))return{rows:[{...state}],rowCount:1};
  if(sql.includes("public-identity-subject-continuity"))return{rows:[{identityStatus:state.identityStatus,subjectDigest:control.subjectDigest,legacyMatches:control.legacyMatches}],rowCount:1};
  if(sql.includes("to_regclass('zzsh_content.legal_document_version')"))return{rows:[{relation:"zzsh_content.legal_document_version"}],rowCount:1};
  if(sql.includes('SELECT DISTINCT ON (v."doc_type")'))return{rows:control.privacyAvailable?[{id:control.privacyVersion,docType:"PLATFORM_PRIVACY",title:"合成隐私政策",body:privacyBody,digest:legalDigest(privacyBody),status:"SEALED"}]:[],rowCount:control.privacyAvailable?1:0};
  if(sql.includes("identity-verification-attempt-read")||sql.includes("identity-verification-attempt-recover"))return{rows:attempts.has(String(values[1]))?[{...attempts.get(String(values[1]))}]:[],rowCount:attempts.has(String(values[1]))?1:0};
  if(sql.startsWith("SELECT 1 FROM zzsh_iam.user_identity_verification_attempt")){
   const occupied=[...attempts.values()].some(row=>row.state==="PENDING"||row.state==="UNKNOWN");return{rows:occupied?[{exists:1}]:[],rowCount:occupied?1:0};
  }
  if(sql.includes("identity-verification-rate"))return{rows:[{dailyCount:control.dailyCount,elapsed:control.elapsed,dayRemaining:"60"}],rowCount:1};
  if(sql.startsWith("INSERT INTO zzsh_iam.user_identity_verification_attempt")){
   attempts.set(String(values[1]),{requestDigest:values[2],state:"PENDING",result:null});return{rows:[],rowCount:1};
  }
  if(sql.startsWith("UPDATE zzsh_iam.user_identity_verification_attempt")){
   const row=attempts.get(String(values[1]));if(!row)return{rows:[],rowCount:0};
   if(sql.startsWith("UPDATE zzsh_iam.user_identity_verification_attempt SET state='UNKNOWN'")){row.state="UNKNOWN";row.providerResult=values[3];}
   else{row.state="COMPLETED";row.result=JSON.parse(String(values[3]));}
   return{rows:[],rowCount:1};
  }
  if(sql.includes("identity-subject-capacity"))return{rows:[{alreadyBound:initial.identityStatus==="VERIFIED",occupied:"0"}],rowCount:1};
  if(sql.includes(" AS ready"))return{rows:[{ready:control.profileReady}],rowCount:1};
  if(sql.startsWith('INSERT INTO "zzsh_iam"."user_identity_state"')){
   state={...state,identityStatus:values[1] as UserIdentityState["identityStatus"],ageStatus:values[2] as UserIdentityState["ageStatus"],provider:String(values[3]),version:state.version+1};
   return{rows:[{...state}],rowCount:1};
  }
  if(sql.startsWith("INSERT INTO zzsh_iam.user_identity_verified_profile")&&control.failProfile)throw Error("synthetic profile failure");
  return{rows:[],rowCount:1};
 };
 const pool={query,connect:async()=>({query,release(){}})};
 const options={pool,userAuth:{api:{getSession:async()=>({user:{id:"synthetic-user"},session:{id:"synthetic-session"}})}},
  apiOrigin:"http://localhost:4222",userOrigin:"http://localhost:4220",realNameProvider:{available:true,...provider},userIdentitySubjectKey:key,userRealNamePolicy:{dailyLimit:3,minIntervalSeconds:60}} as unknown as AuthSecurityOptions;
 async function request(input:Record<string,unknown>=body,commandKey:string|null="verification-opaque-key",recover:boolean|"status"=false){
  let status=0,result:Record<string,any>={},headers:Record<string,unknown>={};
  const response={status(value:number){status=value;return this;},setHeader(name:string,value:unknown){headers[name]=value;return this;},json(value:Record<string,any>){result=value;return this;}} as unknown as AuthSecurityNodeResponse;
  const request={method:recover?"GET":"POST",url:`/api/auth/user/identity/${recover==="status"?"status":recover?"verification-attempt":"verify"}`,headers:{origin:options.userOrigin,...(commandKey?{"idempotency-key":commandKey}:{})},body:input} as AuthSecurityNodeRequest;
  await handleUserIdentityRoute(request,response,options);return{status,result,headers};
 }
 return{request,options,statements,control,get state(){return state;},get attempts(){return attempts;}};
}

test("real identity request identity is purpose HMAC only and invalid/absent keys fail closed",()=>{
 const attempt=identityVerificationAttempt("u","opaque",body.fullName,documentNumber,key);
 assert.match(attempt.keyDigest,/^[a-f0-9]{64}$/);assert.notEqual(attempt.keyDigest,attempt.requestDigest);
 assert.doesNotMatch(JSON.stringify(attempt),/110105|合成|opaque/);
 assert.equal(identityVerificationAttempt("u","opaque",` ${body.fullName} `,documentNumber,key).requestDigest,attempt.requestDigest);
 for(const headers of [{},{"idempotency-key":""},{"idempotency-key":["one","two"]},{"Idempotency-Key":"one","idempotency-key":"two"}])assert.throws(()=>identityVerificationKey(headers));
});

test("real provider requires a key, persists before one call and completed replay/read does not call or expose PII",async()=>{
 let calls=0;const f=fixture({provider:"aliyun-id2meta",verify:async()=>{calls++;assert.equal([...f.attempts.values()][0]?.state,"PENDING");return verified;}});
 assert.equal((await f.request(body,null)).status,400);assert.equal(calls,0);
 const first=await f.request();assert.equal(first.status,200);assert.equal(first.result.status,"VERIFIED");assert.equal(calls,1);
 const replay=await f.request();assert.equal(replay.status,200);assert.equal(replay.result.verificationAttempt.replayed,true);assert.equal(calls,1);
 f.control.privacyVersion="privacy-synthetic-v2";
 assert.equal((await f.request()).status,200,"document updates cannot re-charge a completed original request");assert.equal(calls,1);
 assert.equal((await f.request({...body,fullName:"另一合成姓名"})).status,409);assert.equal(calls,1);
 const recovered=await f.request({},"verification-opaque-key",true);assert.equal(recovered.status,200);assert.equal(calls,1);
 assert.doesNotMatch(JSON.stringify(recovered.result),/110105|合成姓名|providerReference|requestDigest|name_hmac/);
 const receipt=f.statements.filter(row=>row.sql.includes("user_identity_verification_attempt"));
 assert.equal(receipt.some(row=>row.values.includes(documentNumber)||row.values.includes(body.fullName)),false);
 const claim=receipt.find(row=>row.sql.startsWith("INSERT INTO zzsh_iam.user_identity_verification_attempt"))!;
 assert.deepEqual(claim.values.slice(3,6),[privacyAcceptance.versionId,privacyAcceptance.digest,"identity-provider-transfer-v1"]);
 assert.match(claim.sql,/consented_at[\s\S]*clock_timestamp/);
});

test("marketplace verification requires its own disclosure and records the actual provider",async()=>{
 let calls=0;const market={...verified,provider:"aliyun-market-id2" as const};
 const f=fixture({provider:"aliyun-market-id2",verify:async()=>{calls++;return market;}});
 const capability=await f.request({},null,"status");
 assert.equal(capability.result.verificationCapability.real,true);
 assert.equal(capability.result.verificationCapability.disclosure.versionId,MARKET_IDENTITY_PROVIDER_DISCLOSURE.versionId);
 assert.equal((await f.request()).status,400);assert.equal(calls,0);
 const marketBody={...body,privacyAcceptance:{...privacyAcceptance,disclosureVersion:MARKET_IDENTITY_PROVIDER_DISCLOSURE.versionId}};
 assert.equal((await f.request(marketBody)).status,200);assert.equal(calls,1);assert.equal(f.state.provider,"aliyun-market-id2");
 assert.equal((await f.request(marketBody)).status,200);assert.equal(calls,1);
 const saved=f.statements.find(row=>row.sql.startsWith("INSERT INTO zzsh_iam.user_identity_verification_attempt"));
 assert.equal(saved?.values[5],MARKET_IDENTITY_PROVIDER_DISCLOSURE.versionId);
 assert.equal(saved?.values[6],legalDigest(MARKET_IDENTITY_PROVIDER_DISCLOSURE.body));
});

test("a provider identity mismatch remains unresolved and cannot create a verified subject",async()=>{
 let calls=0;const f=fixture({provider:"aliyun-market-id2",verify:async()=>{calls++;return verified;}});
 const marketBody={...body,privacyAcceptance:{...privacyAcceptance,disclosureVersion:MARKET_IDENTITY_PROVIDER_DISCLOSURE.versionId}};
 assert.equal((await f.request(marketBody)).status,202);assert.equal(f.state.identityStatus,"UNVERIFIED");
 assert.equal((await f.request(marketBody)).status,202);assert.equal(calls,1);
});

test("marketplace schema must be ready before a paid provider request",async()=>{
 let calls=0;const f=fixture({provider:"aliyun-market-id2",verify:async()=>{calls++;return {...verified,provider:"aliyun-market-id2"};}});
 f.control.profileReady=false;
 const marketBody={...body,privacyAcceptance:{...privacyAcceptance,disclosureVersion:MARKET_IDENTITY_PROVIDER_DISCLOSURE.versionId}};
 assert.equal((await f.request(marketBody)).status,503);assert.equal(calls,0);assert.equal(f.attempts.size,0);
 const preflight=f.statements.find(row=>row.sql.includes("identity-provider-transfer-market-v1")&&row.sql.includes("pg_get_constraintdef"));
 assert.equal(preflight?.values[0],"aliyun-market-id2");
});

test("in-flight duplicate and unknown provider/commit remain read-only without a second paid request",async()=>{
 let calls=0,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const f=fixture({provider:"aliyun-id2meta",verify:async()=>{calls++;await held;throw Error("SYNTHETIC_PII must be dropped");}});
 const first=f.request();while(!calls)await new Promise(resolve=>setImmediate(resolve));
 const pending=await f.request();assert.equal(pending.status,202);assert.equal(pending.result.verificationAttempt.state,"PENDING");
 release();const failed=await first;assert.equal(failed.status,202);assert.equal(failed.result.verificationAttempt.noReissue,true);
 assert.equal((await f.request()).status,202);assert.equal((await f.request({},"verification-opaque-key",true)).status,202);assert.equal(calls,1);
 assert.equal((await f.request(body,"a-new-key-in-another-device")).status,409);assert.equal(calls,1);
 assert.equal(f.state.identityStatus,"UNVERIFIED");
 assert.doesNotMatch(JSON.stringify(failed.result),/SYNTHETIC_PII/);
});

test("provider success followed by profile or commit failure never re-calls and does not grant partial eligibility",async()=>{
 for(const failure of ["profile","commit"]){
  let calls=0;const f=fixture({provider:"aliyun-id2meta",verify:async()=>{calls++;return verified;}});
  if(failure==="profile")f.control.failProfile=true;else f.control.failCommitAfterState=true;
  assert.equal((await f.request()).status,202);assert.equal(f.state.identityStatus,"UNVERIFIED");
  assert.equal((await f.request()).status,202);assert.equal(calls,1);
  assert.equal([...f.attempts.values()][0]?.state,"UNKNOWN");
 }
});

test("a final COMMIT whose acknowledgement is lost recovers the completed original result without charging twice",async()=>{
 let calls=0;const f=fixture({provider:"aliyun-id2meta",verify:async()=>{calls++;return verified;}});
 f.control.commitAppliedButAckLost=true;
 assert.equal((await f.request()).status,202,"the caller must not claim success before confirmation");
 assert.equal(f.state.identityStatus,"VERIFIED","a lost acknowledgement does not prove rollback");
 const recovered=await f.request({},"verification-opaque-key",true);assert.equal(recovered.status,200);assert.equal(recovered.result.verificationAttempt.replayed,true);
 assert.equal((await f.request()).status,200);assert.equal(calls,1);assert.equal(f.state.version,1);
});

test("configured UTC-day/interval admission and missing policy prevent new paid calls",async()=>{
 for(const kind of ["day","interval","policy"]){
  let calls=0;const f=fixture({provider:"aliyun-id2meta",verify:async()=>{calls++;return verified;}});
  if(kind==="day")f.control.dailyCount="3";
  if(kind==="interval")f.control.elapsed="10.1";
  if(kind==="policy")f.options.userRealNamePolicy=undefined;
  const result=await f.request();assert.equal(result.status,kind==="policy"?503:429);assert.equal(calls,0);assert.equal(f.attempts.size,0);
  if(kind!=="policy")assert.ok(Number(result.headers["Retry-After"])>=1);
 }
});

test("failed re-verification preserves previous verified legacy facts and eligibility, while first failure is recorded",async()=>{
 for(const status of ["REJECTED","UNKNOWN"] as const){
  const result={...verified,status,ageStatus:"UNKNOWN" as const};
  const f=fixture({provider:"aliyun-id2meta",verify:async()=>result},legacy);
  const response=await f.request();assert.equal(response.status,status==="UNKNOWN"?202:200);assert.equal(response.result.status,status);
  if(status==="REJECTED")assert.equal(response.result.previousIdentityPreserved,true);
  assert.deepEqual(f.state,legacy);assert.equal(identityAllowsProtectedTrade(f.state),true);
  assert.equal(f.statements.some(row=>row.sql.startsWith('INSERT INTO "zzsh_iam"."user_identity_state"')||row.sql.startsWith("INSERT INTO zzsh_iam.user_identity_subject")||row.sql.startsWith("INSERT INTO zzsh_iam.user_identity_verified_profile")),false);
 }
 const first=fixture({verify:async()=>({...verified,provider:"fake",status:"REJECTED",ageStatus:"UNKNOWN"})});
 assert.equal((await first.request(body,null)).status,200);assert.equal(first.state.identityStatus,"REJECTED");
 const success=fixture({provider:"aliyun-id2meta",verify:async()=>verified},legacy);
 assert.equal((await success.request()).status,200);assert.equal(success.state.provider,"aliyun-id2meta");assert.equal(success.state.version,8);
 assert.equal(success.statements.some(row=>row.sql.startsWith("INSERT INTO zzsh_iam.user_identity_verified_profile")),true);
});

test("self identity capability comes from channel assembly, not the user historical provider",async()=>{
 const f=fixture({provider:"aliyun-id2meta",verify:async()=>verified});
 const enabled=await f.request({},null,"status");assert.equal(enabled.status,200);assert.equal(enabled.result.provider,"none");
 assert.equal(enabled.result.verificationCapability.available,true);assert.equal(enabled.result.verificationCapability.real,true);assert.equal(enabled.result.verificationCapability.idempotencyRequired,true);
 assert.equal(enabled.result.verificationCapability.privacy.versionId,privacyAcceptance.versionId);assert.equal(enabled.result.verificationCapability.disclosure.versionId,"identity-provider-transfer-v1");
 f.options.realNameProvider.available=false;
 assert.equal((await f.request({},null,"status")).result.verificationCapability.available,false);
 f.options.realNameProvider={...f.options.realNameProvider,provider:"fake",available:true};
 f.options.testOperationsEnabled=false;
 assert.deepEqual((await f.request({},null,"status")).result.verificationCapability,{available:false,real:false,idempotencyRequired:false,privacy:null});
 f.options.testOperationsEnabled=true;assert.equal((await f.request({},null,"status")).result.verificationCapability.available,true);
});

test("native transfer requires this attempt's explicit current privacy consent and cannot use login acceptance",async()=>{
 let calls=0;const f=fixture({provider:"aliyun-id2meta",verify:async()=>{calls++;return verified;}});
 for(const consent of [undefined,{...privacyAcceptance,accepted:false},{...privacyAcceptance,disclosureVersion:"old-version"}]){
  assert.equal((await f.request({...body,privacyAcceptance:consent})).status,400);
 }
 assert.equal((await f.request({...body,privacyAcceptance:{...privacyAcceptance,versionId:"privacy-obsolete"}})).status,409);
 f.control.privacyAvailable=false;
 assert.equal((await f.request()).status,503);assert.equal((await f.request({},null,"status")).result.verificationCapability.available,false);
 assert.equal(calls,0);assert.equal(f.attempts.size,0);
 assert.equal(f.statements.some(row=>row.sql.includes('INSERT INTO "zzsh_content"."document_acceptance"')),false);
});

test("public native verification cannot switch a verified subject or charge when the old subject is not provable",async()=>{
 for(const defect of ["different","unrecorded"]){
  let calls=0;const f=fixture({provider:"aliyun-id2meta",verify:async()=>{calls++;return verified;}},legacy);
  f.control.legacyMatches=false;if(defect==="different")f.control.subjectDigest="f".repeat(64);
  assert.equal((await f.request()).status,403);assert.equal(calls,0);assert.equal(f.attempts.size,0);assert.deepEqual(f.state,legacy);
 }
 let calls=0;const changed=fixture({provider:"aliyun-id2meta",verify:async()=>{calls++;changed.control.subjectDigest="e".repeat(64);return verified;}},legacy);
 assert.equal((await changed.request()).status,202);assert.equal(calls,1);assert.deepEqual(changed.state,legacy);
 assert.equal([...changed.attempts.values()][0]?.state,"UNKNOWN","a concurrent trusted rebind cannot be overwritten by a stale external response");
});
