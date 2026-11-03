import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

// Keep the real router, domain, transaction and idempotency code; only identity and SQL/I/O are fixtures.
function fixture(targetRealm: "user" | "admin" = "user") {
  const real = createRequire(resolve(__dirname, "../src/profile/profile-avatar-routes.js"));
  const supply = real("../supply/supply-routes"), util = real("../supply/supply-util");
  const receipts = new Map<string, any>();
  let policy={requiresReview:true,revision:"1"};
  let profile: any = null, image: string | null = null;
  const queries: Array<{sql:string; values:any[]}> = [];
  let reads = 0;
  const asset = {id:"asset_1",gameId:null,accountId:null,purpose:"AVATAR",ownershipKind:"USER_AVATAR",ownerUserId:"user_1",uploadedByRealm:"user",uploadedByUserId:"user_1",uploadedByAdminId:null,revision:"3",reviewState:"PENDING",accessClass:"PRIVATE_REVIEW",technicalState:"READY",publicStorageKey:"a".repeat(64),mime:"image/webp",width:256,height:256,byteSize:"32",createdAt:new Date("2026-11-01T00:00:00Z")};
  if(targetRealm === "admin") Object.assign(asset,{ownershipKind:"ADMIN_AVATAR",ownerUserId:null,uploadedByRealm:"admin",uploadedByUserId:null,uploadedByAdminId:"admin_0",reviewState:"REJECTED"});
  const row = (realm:string,id:string,preset:string) => ({realm,subjectId:id,defaultPresetId:preset,currentKind:"DEFAULT",currentPresetId:preset,currentAssetId:null,pendingAssetId:null,latestUploadIntentId:null,revision:"1",currentVersion:"1",lastReviewAssetId:null,lastReviewState:null,lastReviewReason:null,lastReviewedAt:null,lastReviewApplied:false,updatedAt:new Date("2026-11-01T00:00:00Z")});
  const client:any = {
    async query(sql:string, values:any[] = []) {
      queries.push({sql,values});
      if(sql.includes("to_regclass('zzsh_supply.profile_avatar_policy')"))return {rows:[{available:true}]};
      if(sql.includes("FROM zzsh_supply.profile_avatar_policy"))return {rows:[{...policy}]};
      if(sql.startsWith("UPDATE zzsh_supply.profile_avatar_policy")){policy={requiresReview:values[0],revision:String(BigInt(policy.revision)+1n)};return {rows:[{...policy}]};}
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("pg_advisory_xact_lock") || sql.includes("set_config") || sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')) return {rows:[],rowCount:0};
      if (sql.includes('FROM "zzsh_supply"."idempotency_record"')) { const found=receipts.get(JSON.stringify(values));return {rows:found?[found]:[],rowCount:found?1:0}; }
      if (sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')) {receipts.set(JSON.stringify(values.slice(0,2)),{requestFingerprint:values[2],responseStatus:values[3],responseBody:JSON.parse(values[4]),publishRequired:values[5]});return {rows:[],rowCount:1};}
      if (sql.includes('FROM "zzsh_supply"."profile_avatar"')) return {rows:profile?[structuredClone(profile)]:[],rowCount:profile?1:0};
      if (sql.startsWith('INSERT INTO "zzsh_supply"."profile_avatar"')) {if(profile)return {rows:[],rowCount:0};profile=row(values[0],values[1],values[3]);return {rows:[structuredClone(profile)],rowCount:1};}
      if (sql.startsWith('UPDATE "zzsh_supply"."profile_avatar"') && sql.includes('"latest_upload_intent_id"=$3')) {profile.latestUploadIntentId=values[2];profile.pendingAssetId=null;profile.revision=String(BigInt(profile.revision)+1n);return {rows:[],rowCount:1};}
      if (sql.startsWith('UPDATE "zzsh_auth_user"."user" SET "image"') || sql.startsWith('UPDATE "zzsh_auth_admin"."user" SET "image"')) {image=values[1];return {rows:[],rowCount:1};}
      if (sql.includes('FROM "zzsh_auth_admin"."user"') && sql.includes('ANY($1::text[])')) return {rows:values[0].map((id:string)=>({id})),rowCount:values[0].length};
      if (sql.startsWith('SELECT "id" FROM "zzsh_auth_')) return {rows:[{id:values[0]}],rowCount:1};
      if (sql.includes('FROM "zzsh_supply"."media_asset"')) return {rows:[asset],rowCount:1};
      if (sql.startsWith('INSERT INTO "zzsh_supply"."media_upload_intent"')) return {rows:[],rowCount:1};
      throw new Error("unexpected avatar route SQL: "+sql.slice(0,100));
    }, release() {},
  };
  const pool:any={connect:async()=>client,query:client.query.bind(client)};
  const access={status:"ACTIVE",isBoss:true,permissions:new Set(["profile.avatar.review","profile.avatar.policy.manage"])};
  const identity={readAdminContext:async()=>({userId:"admin_1",sessionId:"admin_session"}),assertAdminContextInTransaction:async()=>undefined};
  const exports:Record<string,any>={};
  const load=(id:string)=>id==="../auth/auth-security"?identity:id==="../auth/user-identity"?{readUserContext:async()=>({userId:"user_1",sessionId:"user_session"}),assertUserContextInTransaction:async()=>undefined}:id==="../supply/supply-routes"?{...supply,requireAdminAccess:async()=>access}:real(id);
  const source=readFileSync(resolve(__dirname,"../../src/profile/profile-avatar-routes.ts"),"utf8");
  runInNewContext(transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText,{exports,require:load,Buffer,URL,URLSearchParams,console,process,__dirname:resolve(__dirname,"../../src/profile")});
  const options:any={pool,userOrigin:"https://user.fixture.test",adminOrigin:"https://admin.fixture.test",apiOrigin:"https://api.fixture.test",mediaStorage:{kind:"local",available:true,write:async()=>undefined,read:async()=>{reads++;return Buffer.from("fixture bytes");}}};
  async function call(kind:"user"|"self"|"review", method:string, path:string, body?:unknown, key="avatar-route-key-0001") {
    const request:any={method,url:path,originalUrl:path,headers:{origin:kind==="user"?options.userOrigin:options.adminOrigin,"idempotency-key":key,"x-request-id":"req_avatar_route"},body};
    const response:any={headersSent:false,statusCode:0,body:null,headers:{} as Record<string,string>,status(n:number){this.statusCode=n;return this;},setHeader(k:string,v:string){this.headers[k]=v;return this;},json(value:unknown){this.body=value;this.headersSent=true;return this;}};
    await exports[kind==="user"?"handleProfileAvatarUserRoute":kind==="self"?"handleProfileAvatarAdminSelfRoute":"handleProfileAvatarAdminReviewRoute"](request,response,options);
    return {status:response.statusCode,body:JSON.parse(JSON.stringify(response.body)),url:request.url};
  }
  const seed=(operation:string,resource:string|null,body:unknown,result:unknown,key:string)=>{const scope=JSON.stringify(["admin","admin_1",operation,resource]);receipts.set(JSON.stringify([scope,key]),{requestFingerprint:util.fingerprintRequest(operation,resource??undefined,body),responseStatus:200,responseBody:result,publishRequired:false});};
  return {access,call,queries,receipts,seed,get profile(){return profile;},get image(){return image;},get reads(){return reads;}};
}

test("actual user/default route accepts revision zero and reads the same original receipt",async()=>{
  const f=fixture(),key="avatar-default-zero-0001";
  const selected=await f.call("user","POST","/api/v1/profile/avatar/default",{presetId:"avatar-night",expectedRevision:"0"},key);
  assert.equal(selected.status,200);assert.equal(selected.body.revision,"1");assert.equal(f.image,"/api/v1/profile/avatars/user/user_1/1");
  const recovered=await f.call("user","GET","/api/v1/profile/avatar/operation-result?operation=profile.avatar.default.select&presetId=avatar-night&expectedRevision=0",undefined,key);
  assert.equal(recovered.status,200);assert.equal(recovered.body.receipt,"RECORDED");assert.equal(recovered.body.result.current.presetId,"avatar-night");assert.equal(f.reads,1);
});

test("actual admin default route also accepts the zero bootstrap revision",async()=>{
  const f=fixture();const selected=await f.call("self","POST","/api/v1/admin/profile-avatar/default",{presetId:"avatar-frost",expectedRevision:"0"});
  assert.equal(selected.status,200);assert.equal(selected.body.current.presetId,"avatar-frost");assert.equal(f.image,"/api/v1/profile/avatars/admin/admin_1/1");
});

test("review commands require CAS before any write, including withdraw",async()=>{
  for(const action of ["review","withdraw"]){const f=fixture();const r=await f.call("review","POST",`/api/v1/admin/profile-avatars/asset_1/${action}`,action==="review"?{decision:"REJECT",reason:"missing revision"}:{reason:"missing revision"});assert.equal(r.status,400);assert.equal(f.queries.filter(x=>/^(INSERT|UPDATE|DELETE)/.test(x.sql)).length,0);}
});

test("POST result recovery uses the original body and never puts the reason in the URL",async()=>{
  const f=fixture(),key="avatar-review-recovery-0001",body={decision:"REJECT",reason:"private reviewer reason",expectedRevision:"3"};
  f.seed("profile.avatar.review","asset_1",body,{review:{state:"REJECTED",applied:false}},key);
  const recovered=await f.call("review","POST","/api/v1/admin/profile-avatars/operation-result",{operation:"profile.avatar.review",assetId:"asset_1",...body},key);
  assert.equal(recovered.status,200);assert.equal(recovered.body.receipt,"RECORDED");assert.equal(recovered.body.result.review.state,"REJECTED");assert.equal(recovered.url,"/api/v1/admin/profile-avatars/operation-result");assert(!recovered.url.includes(body.reason));assert.equal(f.queries.filter(x=>/^(INSERT|UPDATE|DELETE)/.test(x.sql)).length,0);
  const changed=await f.call("review","POST","/api/v1/admin/profile-avatars/operation-result",{operation:"profile.avatar.review",assetId:"asset_1",...body,reason:"another reason"},key);assert.equal(changed.status,409);
});

test("result recovery refuses reason query parameters and the former GET shape",async()=>{
  const f=fixture();const body={operation:"profile.avatar.review",assetId:"asset_1",decision:"REJECT",reason:"private",expectedRevision:"3"};
  assert.equal((await f.call("review","POST","/api/v1/admin/profile-avatars/operation-result?reason=private",body)).status,400);
  assert.equal((await f.call("review","GET","/api/v1/admin/profile-avatars/operation-result?reason=private")).status,404);
});

test("intent returns its token once, persists only nonsecret receipt, and replay cannot recover the token",async()=>{
  const f=fixture(),key="avatar-intent-token-0001",body={mime:"image/png",size:32,expectedRevision:"0"};
  const first=await f.call("user","POST","/api/v1/profile/avatar/upload-intents",body,key);assert.equal(first.status,200);assert.equal(typeof first.body.uploadToken,"string");assert(first.body.uploadToken.length>20);
  const stored=[...f.receipts.values()][0].responseBody;assert.equal(stored.intentId,first.body.intentId);assert.equal(stored.uploadToken,undefined);assert(!JSON.stringify(stored).includes(first.body.uploadToken));
  const intentInsert=f.queries.find(x=>x.sql.startsWith('INSERT INTO "zzsh_supply"."media_upload_intent"'))!;assert.equal(intentInsert.values[1].length,64);assert.notEqual(intentInsert.values[1],first.body.uploadToken);
  const replay=await f.call("user","POST","/api/v1/profile/avatar/upload-intents",body,key);assert.equal(replay.status,409);assert.equal(replay.body.error.reason,"UPLOAD_TOKEN_NOT_RECOVERABLE");assert.equal(f.queries.filter(x=>x.sql.startsWith('INSERT INTO "zzsh_supply"."media_upload_intent"')).length,1);
});


test("admin-target review replay locks both admin subjects in sorted order before the asset",async()=>{
 const f=fixture("admin"),key="avatar-sorted-review-0001",body={decision:"REJECT",reason:"review fixture",expectedRevision:"3"};
 f.seed("profile.avatar.review","asset_1",body,{review:{state:"REJECTED",applied:true}},key);
 const result=await f.call("review","POST","/api/v1/admin/profile-avatars/asset_1/review",body,key);
 assert.equal(result.status,200);
 const adminIndex=f.queries.findIndex(q=>q.sql.includes('FROM "zzsh_auth_admin"."user"')&&q.sql.includes('ANY($1::text[])'));
 assert(adminIndex>=0);assert.deepEqual([...f.queries[adminIndex]!.values[0]],["admin_0","admin_1"]);
 const assetIndex=f.queries.findIndex(q=>q.sql.includes('FROM "zzsh_supply"."media_asset"')&&q.sql.includes("FOR UPDATE"));
 assert(assetIndex>adminIndex);assert.equal(f.queries.filter(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)).length,0);
});


test("avatar policy update uses original CAS and exact-key recovery without reapplying after policy changes",async()=>{
 const f=fixture(),body={requiresReview:false,expectedRevision:"1"},key="avatar-policy-original-01";
 const first=await f.call("review","POST","/api/v1/admin/profile-avatars/policy",body,key);
 assert.equal(first.status,200);assert.equal(first.body.policy.requiresReview,false);assert.equal(first.body.policy.revision,"2");
 assert.equal((await f.call("review","POST","/api/v1/admin/profile-avatars/policy",{requiresReview:true,expectedRevision:"2"},"avatar-policy-second-01")).status,200);
 const replay=await f.call("review","POST","/api/v1/admin/profile-avatars/policy",body,key);assert.equal(replay.body.policy.revision,"2");assert.equal(replay.body.policy.requiresReview,false);
 const recovered=await f.call("review","GET","/api/v1/admin/profile-avatars/policy/operation-result?requiresReview=false&expectedRevision=1",undefined,key);
 assert.equal(recovered.status,200);assert.equal(recovered.body.receipt,"RECORDED");assert.equal(recovered.body.result.policy.revision,"2");
 assert.equal(f.queries.filter(q=>q.sql.startsWith("UPDATE zzsh_supply.profile_avatar_policy")).length,2);
 assert.equal((await f.call("review","GET","/api/v1/admin/profile-avatars/policy/operation-result?requiresReview=true&expectedRevision=1",undefined,key)).status,409);
});
test("avatar reviewer can read policy but cannot change it; delegated policy manager has no review grant",async()=>{
 const f=fixture();f.access.isBoss=false;f.access.permissions=new Set(["profile.avatar.review"]);
 assert.equal((await f.call("review","GET","/api/v1/admin/profile-avatars/policy")).body.canManage,false);
 assert.equal((await f.call("review","POST","/api/v1/admin/profile-avatars/policy",{requiresReview:false,expectedRevision:"1"})).status,403);
 f.access.permissions=new Set(["profile.avatar.policy.manage"]);
 assert.equal((await f.call("review","GET","/api/v1/admin/profile-avatars/policy")).body.canManage,true);
 assert.equal((await f.call("review","GET","/api/v1/admin/profile-avatars")).status,403);
 assert.equal((await f.call("review","POST","/api/v1/admin/profile-avatars/policy",{requiresReview:false,expectedRevision:"1"},"avatar-policy-delegated-01")).status,200);
});
test("avatar policy rejects missing CAS, forged fields and stale revisions before mutation",async()=>{
 const f=fixture();for(const body of [{requiresReview:false},{requiresReview:false,expectedRevision:"1",approved:true},{requiresReview:false,expectedRevision:"0"}])assert.equal((await f.call("review","POST","/api/v1/admin/profile-avatars/policy",body)).status,400);
 assert.equal((await f.call("review","POST","/api/v1/admin/profile-avatars/policy",{requiresReview:false,expectedRevision:"9"})).status,409);
 for(const forged of [{requiresReview:false},{approved:true},{approvalSource:"SYSTEM_POLICY"}])assert.equal((await f.call("user","POST","/api/v1/profile/avatar/upload-intents",{mime:"image/webp",size:32,expectedRevision:"0",...forged})).status,400);
 assert.equal(f.queries.filter(q=>q.sql.startsWith("UPDATE zzsh_supply.profile_avatar_policy")).length,0);
});
