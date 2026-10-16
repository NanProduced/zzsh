import {test} from "node:test";
import assert from "node:assert/strict";
import type {Pool} from "pg";
import {mountOrderHandlers,type OrderRuntimeOptions} from "../src/order/order-routes";
import {parseLegacyContinuationPath} from "../src/order/legacy-continuation-routes";
import {legacyBinding} from "./legacy-continuation-fixture";
import {conflict,type SupplyNodeRequest} from "../src/supply/supply-util";
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
