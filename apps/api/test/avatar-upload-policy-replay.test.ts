import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
import {transpileModule,ModuleKind,ScriptTarget} from "typescript";
import {recordAudit} from "../src/auth/security-core";

function fixture(){
 const real=createRequire(resolve(__dirname,"../src/supply/supply-routes.js")),media=real("./media");
 const receipts=new Map<string,any>(),audits:any[]=[],queries:string[]=[];let before:any,prepares=0,finalizes=0;
 const asset:any={assetId:"asset_1",gameId:null,purpose:"AVATAR",ownershipKind:"USER_AVATAR",mime:"image/webp",byteSize:"32",width:256,height:256,contentHash:"a".repeat(64),reviewState:"PENDING",accessClass:"PRIVATE_REVIEW"};
 const client:any={async query(sql:string,values:any[]=[]){queries.push(sql);
  if(sql==="BEGIN"){before={audits:[...audits],receipts:new Map(receipts)};return {rows:[],rowCount:0};}
  if(sql==="ROLLBACK"){audits.splice(0,audits.length,...before.audits);receipts.clear();for(const [k,v]of before.receipts)receipts.set(k,v);return {rows:[],rowCount:0};}
  if(sql==="COMMIT"||sql.includes("set_config")||sql.includes("pg_advisory_xact_lock"))return {rows:[],rowCount:0};
  if(sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')){audits.push({actor:values[1],action:values[4],details:JSON.parse(values.at(-1))});return {rows:[],rowCount:1};}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){receipts.set(JSON.stringify(values.slice(0,2)),{requestFingerprint:values[2],responseStatus:values[3],responseBody:JSON.parse(values[4]),publishRequired:values[5]});return {rows:[],rowCount:1};}
  if(sql.includes("idempotency_record")){const row=receipts.get(JSON.stringify(values));return {rows:row?[row]:[],rowCount:row?1:0};}
  throw new Error("unexpected media replay SQL "+sql.slice(0,100));
 },release(){}};
 const exports:any={};const source=readFileSync(resolve(__dirname,"../../src/supply/supply-routes.ts"),"utf8");
 runInNewContext(transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{exports,require:(id:string)=>id==="./media"?{...media,prepareMediaUpload:async()=>{prepares++;return {writtenStorageKeys:[]};},finalizeMediaUpload:async()=>{finalizes++;return {...asset};},logOrphanedMediaObjects:()=>undefined}:real(id),Buffer,URL,URLSearchParams,console,process});
 const pool:any={connect:async()=>client,query:client.query.bind(client)};
 const call=async(afterFinalize:any)=>{const response:any={headersSent:false,status(n:number){this.statusCode=n;return this;},setHeader(){return this;},json(body:unknown){this.body=body;this.headersSent=true;}};
  await exports.runMediaUpload({pool,mediaStorage:{}},{headers:{"idempotency-key":"avatar-upload-original-01"}},response,"r",{actor:{realm:"user",id:"user_1",sessionId:"session_1"},mediaActor:{realm:"user",userId:"user_1"},intentId:"intent_1",uploadToken:"token-fixture",bytes:Buffer.from("bytes"),authorize:async()=>undefined,afterFinalize});return response;};
 return {call,client,audits,queries,receipts,get prepares(){return prepares;},get finalizes(){return finalizes;}};
}
test("upload creation audit stays initial PENDING while system policy approval is a separate durable fact; replay retains original policy",async()=>{
 const f=fixture();let callbacks=0;
 const first=await f.call(async(client:any,asset:any)=>{callbacks++;await recordAudit(client,{actorType:"system",action:"profile.avatar.policy.applied",objectType:"profile_avatar",objectId:"user_1",outcome:"SUCCESS",requestId:"r",details:{policyRevision:"5",approvalSource:"SYSTEM_POLICY"}});return {...asset,reviewState:"APPROVED",accessClass:"PUBLIC_DISPLAY",avatarSubmission:{disposition:"APPLIED_BY_POLICY",policyRevision:"5"}};});
 assert.equal(first.body.reviewState,"APPROVED");const creation=f.audits.find(a=>a.action==="supply.media.uploaded");assert.equal(creation.details.after.reviewState,"PENDING");assert.equal(creation.details.after.accessClass,"PRIVATE_REVIEW");assert.equal(creation.details.after.revision,"1");assert.equal(f.audits.filter(a=>a.actor==="system").length,1);
 const replay=await f.call(async()=>{throw new Error("policy must not be reevaluated on replay");});assert.equal(replay.body.avatarSubmission.policyRevision,"5");assert.equal(callbacks,1);assert.equal(f.prepares,1);assert.equal(f.finalizes,1);
});
test("trusted post-finalize callback cannot replace asset identity and transaction rolls back",async()=>{for(const field of ["assetId","purpose","contentHash","ownershipKind"]){const f=fixture();await assert.rejects(f.call(async(client:any,asset:any)=>{await recordAudit(client,{actorType:"system",action:"profile.avatar.policy.applied",objectType:"profile_avatar",objectId:"user_1",outcome:"SUCCESS",requestId:"r"});if(field==="assetId"){asset.assetId="wrong";return;}return {...asset,[field]:"wrong"};}),/Media finalization changed asset identity/);assert.equal(f.receipts.size,0);assert.equal(f.audits.length,0);assert(f.queries.includes("ROLLBACK"));assert.equal(f.queries.at(-1),"ROLLBACK");}});
