import {test} from "node:test";
import assert from "node:assert/strict";
import type {Pool} from "pg";
import {mountOrderHandlers,type OrderRuntimeOptions} from "../src/order/order-routes";
import {parseLegacyContinuationPath} from "../src/order/legacy-continuation-routes";
import {legacyBinding,legacyEvidence,legacySource,legacyQuantities} from "./legacy-continuation-fixture";
import {conflict,notFound,type SupplyNodeRequest} from "../src/supply/supply-util";
import {initialLegacyFacts,projectLegacyContinuation} from "../src/order/legacy-continuation-model";
import type {SupplyResponse} from "../src/supply/supply-routes";
const e: typeof import("../src/order/legacy-continuation-evidence")=require("../src/order/legacy-continuation-evidence"),c: typeof import("../src/order/legacy-continuation-command")=require("../src/order/legacy-continuation-command");
function response(){return {headersSent:false,statusCode:0,payload:undefined as unknown,status(n:number){this.statusCode=n;return this;},setHeader(){return this;},json(body:unknown){this.payload=body;this.headersSent=true;return this;}};}
test("real mounted legacy GET/receipt and POST preserve actor/key/body; no test-operation switch is required",async t=>{
 const user:typeof import("../src/auth/user-identity")=require("../src/auth/user-identity");t.mock.method(user,"readUserContext",async()=>({userId:legacyBinding.ownerUserId,sessionId:"session_fixture"}));
 const seen:unknown[][]=[],records=new Map<string,{requestFingerprint:string;responseStatus:number;responseBody:unknown;publishRequired:boolean}>();
 const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
  if(sql.includes('"request_fingerprint" AS'))return {rows:records.has(String(v[1]))?[records.get(String(v[1]))]:[],rowCount:records.has(String(v[1]))?1:0};
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){records.set(String(v[1]),{requestFingerprint:String(v[2]),responseStatus:Number(v[3]),responseBody:JSON.parse(String(v[4])),publishRequired:false});}
  if(sql.includes("response_status AS status")){const r=records.get(String(v[1]));return {rows:r?[{status:r.responseStatus,body:r.responseBody,fingerprint:r.requestFingerprint}]:[],rowCount:r?1:0};}return {rows:[],rowCount:0};
 }})} as unknown as Pool;
 let allowed=true,authorizationCount=0;
 t.mock.method(c,"authorizeLegacyMutation",async(...[_client,actor,id]:Parameters<typeof c.authorizeLegacyMutation>)=>{authorizationCount++;if(!allowed)throw conflict("REVOKED");seen.push(["authorize",actor,id]);return {binding:legacyBinding,userIds:[legacyBinding.ownerUserId,legacyBinding.renterUserId].sort(),actor};});
 t.mock.method(c,"applyLegacyContinuationCommand",async(...[_client,actor,id,input]:Parameters<typeof c.applyLegacyContinuationCommand>)=>{seen.push(["apply",actor,id,input]);return {status:200,body:{orderId:id,command:input.kind,revision:"1",versionId:"version_fixture",inputEvidenceId:input.inputEvidenceId,resultEvidenceId:"result_fixture",stage:"4",channelState:"UNKNOWN"}};});
 t.mock.method(e,"readLegacyContinuation",async(...[_client,actor,id]:Parameters<typeof e.readLegacyContinuation>)=>{seen.push(["read",actor,id]);return {continuation:{schema:"legacy-continuation.v1"}} as Awaited<ReturnType<typeof e.readLegacyContinuation>>;});
 const handlers=new Map<string,(q:SupplyNodeRequest,r:SupplyResponse)=>Promise<void>>(),app={getHttpAdapter:()=>({getInstance:()=>({use:(p:string,h:(q:SupplyNodeRequest,r:SupplyResponse)=>Promise<void>)=>handlers.set(p,h)})})};
 mountOrderHandlers(app as Parameters<typeof mountOrderHandlers>[0],{pool,apiOrigin:"http://api.invalid",userOrigin:"http://user.invalid"} as OrderRuntimeOptions);
 const handler=handlers.get("/api/v1/orders");assert(handler);
 const call=async(method:string,suffix:string,body:Record<string,unknown>={},origin="http://user.invalid")=>{const r=response();await handler({method,originalUrl:"/api/v1/orders/legacy/"+legacyBinding.id+"/continuation"+suffix,headers:{origin,"idempotency-key":"ORIGINAL_KEY","x-request-id":"req_fixture"},body},r);return r;};
 assert.equal((await call("GET","")).statusCode,200);
 const body={expectedRevision:null,inputEvidenceId:"fixture_evidence",planFingerprint:"f".repeat(64)};
 assert.equal((await call("POST","/confirm",body)).statusCode,200);assert.equal((await call("POST","/confirm",body)).statusCode,200);
 assert.equal(seen.filter(x=>x[0]==="apply").length,1);assert.equal(authorizationCount,2);assert.deepEqual(seen.find(x=>x[0]==="apply")?.[3],{kind:"confirm",...body});
 const receipt=await call("GET","/receipt?command=confirm&key=ORIGINAL_KEY");assert.equal(receipt.statusCode,200);assert.equal((receipt.payload as {state:string}).state,"KNOWN_SUCCESS");
 allowed=false;assert.equal((await call("POST","/confirm",body)).statusCode,409);assert.equal(seen.filter(x=>x[0]==="apply").length,1);
 assert.equal((await call("POST","/confirm",body,"http://foreign.invalid")).statusCode,403);
 assert.equal((await call("GET","/receipt?command=confirm&command=confirm&key=ORIGINAL_KEY")).statusCode,400);
 assert.equal((await call("GET","/confirm")).statusCode,404);
});
test("mapped source-qualified route rejects native IDs, path traversal, double encoding and encoded slash",()=>{
 assert.equal(parseLegacyContinuationPath("/legacy/"+legacyBinding.id+"/continuation")?.orderId,legacyBinding.id);
 for(const id of ["7","order_native","history%3Aid","legacy_order_%252f","legacy_order_%2F","legacy_order_"+"f".repeat(40)+"%2Fextra"]){assert.throws(()=>parseLegacyContinuationPath("/legacy/"+id+"/continuation"));}
 assert.equal(parseLegacyContinuationPath("/legacy/"+legacyBinding.id+"/continuation/confirm/extra"),null);
});

test("mounted legacy parties receive filtered fresh/replay/race/receipt output without changing original stored bodies",async parent=>{
 for(const who of ["owner","renter"] as const)await parent.test(who,async t=>{
  const user:typeof import("../src/auth/user-identity")=require("../src/auth/user-identity");let currentUser=who==="owner"?legacyBinding.ownerUserId:legacyBinding.renterUserId;
  t.mock.method(user,"readUserContext",async()=>({userId:currentUser,sessionId:"fixture_session"}));
  const amounts={payMoney:"901.23",saleEarnings:"163.27",ownerNet:"150.21",returnOrderMoney:"517.89",refundNet:"506.82",fullPayoutMoney:"13.06",commissionPool:"220.07"};
  const raw={orderId:legacyBinding.id,revision:"7",stage:"4",outcome:"ACCEPTED",amounts,previewAmounts:amounts,proposalAmounts:amounts,source:{accountPrices:{coffee:"77.31"}},facts:{privatePrice:"99.17"}};
  const rawBefore=JSON.stringify(raw),records=new Map<string,any>();let applies=0,raceInserted=false,allowed=true;
  const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
   if(sql.includes('"request_fingerprint" AS')){const row=records.get(String(v[1]));return{rows:row?[row]:[],rowCount:row?1:0};}
   if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){
    const key=String(v[1]);records.set(key,{requestFingerprint:v[2],responseStatus:v[3],responseBody:JSON.parse(String(v[4])),publishRequired:false});
    if(key==="RACE_KEY"&&!raceInserted){raceInserted=true;throw Object.assign(new Error("other transaction won"),{code:"23505"});}
   }
   if(sql.includes("response_status AS status")){const row=records.get(String(v[1]));return{rows:row?[{status:row.responseStatus,body:row.responseBody,fingerprint:row.requestFingerprint}]:[]};}
   return{rows:[],rowCount:0};
  }})} as unknown as Pool;
  t.mock.method(c,"authorizeLegacyMutation",async(...[_client,actor]:Parameters<typeof c.authorizeLegacyMutation>)=>{if(!allowed||![legacyBinding.ownerUserId,legacyBinding.renterUserId].includes(actor.userId))throw notFound();return{binding:legacyBinding,userIds:[],actor};});
  t.mock.method(c,"applyLegacyContinuationCommand",async()=>{applies++;return{status:200,body:structuredClone(raw)};});
  const facts=initialLegacyFacts(legacySource({saleEarnings:"13.27",returnOrderMoney:"73.19"})),row=legacyEvidence(facts);
  t.mock.method(e,"readLegacyContinuation",async(...[_client,actor]:Parameters<typeof e.readLegacyContinuation>)=>({continuation:projectLegacyContinuation(legacyBinding,actor,row,null,[])}));
  t.mock.method(e,"readLegacyContinuationBinding",async()=>legacyBinding);t.mock.method(e,"authorizeLegacyContinuation",async()=>({canOperate:false,canReadCommission:false}));
  t.mock.method(e,"readLegacyContinuationHead",async()=>null);t.mock.method(e,"readLegacyContinuationEvidence",async()=>row);
  const handlers=new Map<string,any>(),app={getHttpAdapter:()=>({getInstance:()=>({use:(p:string,h:any)=>handlers.set(p,h)})})};
  mountOrderHandlers(app as Parameters<typeof mountOrderHandlers>[0],{pool,apiOrigin:"http://api.invalid",userOrigin:"http://user.invalid"} as OrderRuntimeOptions);
  const handler=handlers.get("/api/v1/orders"),body={expectedRevision:null,inputEvidenceId:"fixture_evidence",planFingerprint:"f".repeat(64)};
  const call=async(method:string,suffix:string,payload:Record<string,unknown>=body,key="ORIGINAL_KEY")=>{const r=response();await handler({method,originalUrl:`/api/v1/orders/legacy/${legacyBinding.id}/continuation${suffix}`,headers:{origin:"http://user.invalid","idempotency-key":key},body:payload},r);return r;};
  const assertBag=(bag:any)=>{assert.equal(Object.hasOwn(bag,who==="owner"?"payMoney":"saleEarnings"),false);assert.equal(Object.hasOwn(bag,who==="owner"?"saleEarnings":"payMoney"),true);assert.equal(Object.hasOwn(bag,"commissionPool"),false);};
  const first=await call("POST","/confirm");assert.equal(first.statusCode,200);assertBag((first.payload as any).amounts);assert.equal(Object.hasOwn(first.payload as object,"source"),false);
  const storedBefore=JSON.stringify(records.get("ORIGINAL_KEY"));assert.equal(records.get("ORIGINAL_KEY").responseBody.amounts.payMoney,"901.23");assert.equal(records.get("ORIGINAL_KEY").responseBody.amounts.saleEarnings,"163.27");
  const replay=await call("POST","/confirm");assert.equal(replay.statusCode,200);assertBag((replay.payload as any).amounts);assert.equal(applies,1);
  const receipt=await call("GET","/receipt?command=confirm&key=ORIGINAL_KEY");assert.equal(receipt.statusCode,200);assert.equal((receipt.payload as any).state,"KNOWN_SUCCESS");assertBag((receipt.payload as any).receipt.amounts);assert.equal(Object.hasOwn((receipt.payload as any).receipt,"facts"),false);
  const race=await call("POST","/confirm",body,"RACE_KEY");assert.equal(race.statusCode,200);assert.equal(raceInserted,true);assertBag((race.payload as any).amounts);assert.equal(applies,2);
  const get=await call("GET","");assert.equal(get.statusCode,200);assertBag((get.payload as any).continuation.amounts);
  const preview=await call("POST","/preview",{quantities:legacyQuantities("1.00")});assert.equal(preview.statusCode,200);assertBag((preview.payload as any).previewAmounts);assertBag((preview.payload as any).proposalAmounts);
  const absent=await call("GET","/receipt?command=confirm&key=ABSENT_KEY");assert.equal((absent.payload as any).state,"UNKNOWN");assert.equal(applies,2);
  currentUser="non_party";assert.equal((await call("GET","")).statusCode,404);assert.equal((await call("GET","/receipt?command=confirm&key=ORIGINAL_KEY")).statusCode,404);
  currentUser=who==="owner"?legacyBinding.ownerUserId:legacyBinding.renterUserId;allowed=false;assert.equal((await call("POST","/confirm")).statusCode,404);assert.equal(applies,2);
  assert.equal(JSON.stringify(records.get("ORIGINAL_KEY")),storedBefore);assert.equal(JSON.stringify(raw),rawBefore);
 });
});
