import assert from "node:assert/strict";
import { test } from "node:test";

import { AdminAvatarError, parseAdminAvatarState, parseAdminAvatarUploadResult, readAdminAvatarReviews, reviewAdminAvatar } from "../src/views/self-settings/avatar-api.ts";

const PRESETS = [
  { presetId: "avatar-strike", version: 1, url: "/api/v1/profile/avatars/presets/avatar-strike/1/content", width: 256, height: 256 },
  { presetId: "avatar-night", version: 1, url: "/api/v1/profile/avatars/presets/avatar-night/1/content", width: 256, height: 256 },
  { presetId: "avatar-frost", version: 1, url: "/api/v1/profile/avatars/presets/avatar-frost/1/content", width: 256, height: 256 },
  { presetId: "avatar-aurora", version: 1, url: "/api/v1/profile/avatars/presets/avatar-aurora/1/content", width: 256, height: 256 },
];
const STATE = {
  revision: "4",
  updatedAt: null,
  current: { kind: "CUSTOM", assetId: "asset_1", presetId: null, url: "/api/v1/profile/avatars/admin/admin_1/3", currentVersion: "3" },
  defaultPresetId: "avatar-night",
  presets: PRESETS,
  pending: null,
  lastReview: { assetId: "asset_1", state: "APPROVED", reason: null, reviewedAt: "2026-11-01T00:00:00.000Z", applied: true },
};

test('admin avatar policy safely falls back to review and preserves system source without calling it human',()=>{
 for(const policy of [undefined,null,{requiresReview:false,available:false,revision:'2'},{requiresReview:'false',available:true,revision:'2'},{requiresReview:false,available:true,revision:'0'}])assert.deepEqual(parseAdminAvatarState({...STATE,policy}).policy,{requiresReview:true,available:false,revision:'0'});
 assert.equal(parseAdminAvatarState({...STATE,policy:{requiresReview:false,available:true,revision:'2'}}).policy.requiresReview,false);
 const review=parseAdminAvatarState({...STATE,lastReview:{...STATE.lastReview,source:'SYSTEM_POLICY',policyRevision:'2'}}).lastReview;assert.equal(review.source,'SYSTEM_POLICY');assert.equal(review.policyRevision,'2');
});

test('admin upload receipt refuses a fake or unbound automatic approval',()=>{
 const result={assetId:'asset_new',avatarSubmission:{disposition:'APPLIED_BY_POLICY',requiresReview:false,policyRevision:'2',approvalSource:'SYSTEM_POLICY'}};
 assert.equal(parseAdminAvatarUploadResult(result).avatarSubmission.disposition,'APPLIED_BY_POLICY');assert.equal(parseAdminAvatarUploadResult({assetId:'legacy_asset'}).avatarSubmission,null);
 for(const bad of [{...result,assetId:null},{...result,avatarSubmission:{...result.avatarSubmission,requiresReview:true}},{...result,avatarSubmission:{...result.avatarSubmission,approvalSource:'HUMAN_REVIEW'}},{...result,avatarSubmission:{...result.avatarSubmission,policyRevision:'0'}}])assert.throws(()=>parseAdminAvatarUploadResult(bad),AdminAvatarError);
});

test('review queue keeps only known approval sources and a real policy revision',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({items:[{assetId:'asset_system',mime:'image/webp',reviewState:'APPROVED',width:512,height:512,byteSize:'1200',realm:'user',subjectId:'user_A',submittedAt:'2026-11-03T00:00:00Z',revision:'2',approvalSource:'SYSTEM_POLICY',policyRevision:'2'},{assetId:'asset_unknown',mime:'image/webp',reviewState:'APPROVED',width:512,height:512,byteSize:'1200',realm:'user',subjectId:'user_A',submittedAt:'2026-11-03T00:00:00Z',revision:'2',approvalSource:'mystery',policyRevision:'unknown'}],nextCursor:null});
 try{const result=await readAdminAvatarReviews('APPROVED',null);assert.equal(result.items[0].approvalSource,'SYSTEM_POLICY');assert.equal(result.items[0].policyRevision,'2');assert.equal(result.items[1].approvalSource,undefined);assert.equal(result.items[1].policyRevision,null)}finally{globalThis.fetch=old}
});

test("admin avatar state parsing keeps the current custom avatar and review result distinct", () => {
  const state = parseAdminAvatarState(STATE);
  assert.equal(state.current.kind, "CUSTOM");
  assert.equal(state.current.assetId, "asset_1");
  assert.equal(state.lastReview?.applied, true);
  assert.equal(state.presets.length, 4);
  assert.throws(() => parseAdminAvatarState({ ...STATE, presets: [] }), AdminAvatarError);
});

test("review and queue requests use the BFF paths, CAS revision and idempotency key", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/profile-avatars?")) {
      return new Response(JSON.stringify({ items: [{ assetId: "asset_1", realm: "user", subjectId: "user_1", subjectName: "测试用户", submittedAt: "2026-11-01T00:00:00.000Z", width: 256, height: 256, byteSize: "15002", mime: "image/webp", reviewState: "PENDING", reviewReason: null, revision: "1" }], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ asset: { id: "asset_1" }, review: { applied: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const queue = await readAdminAvatarReviews("PENDING", null);
    assert.equal(queue.items.length, 1);
    assert.match(calls[0].url, /^\/api\/bff\/admin\/profile-avatars\?/);
    await reviewAdminAvatar("asset_1", "APPROVE", null, "1", "review-key");
    assert.equal(calls[1].url, "/api/bff/admin/profile-avatars/asset_1/review");
    assert.equal(calls[1].init.headers["idempotency-key"], "review-key");
    assert.deepEqual(JSON.parse(calls[1].init.body), { decision: "APPROVE", expectedRevision: "1" });
  } finally {
    globalThis.fetch = original;
  }
});


test("admin intent includes expectedRevision and default recovery remains same-key GET", async () => {
  const { createAdminAvatarUploadIntent, readAdminAvatarOperationResult } = await import("../src/views/self-settings/avatar-api.ts");
  const calls=[], original=globalThis.fetch, signal=new AbortController().signal;
  globalThis.fetch=async (url,init)=>{calls.push({url:String(url),init});return Response.json(String(url).includes("/upload-intents")?{intentId:"upload_fixture",uploadToken:"synthetic-token"}:{receipt:"RECORDED",responseStatus:200,result:STATE});};
  try {
    const file=new File([new Uint8Array([1,2,3,4])],"avatar.webp",{type:"image/webp"});
    await createAdminAvatarUploadIntent(file,"admin-intent-original-key","0",signal);
    assert.equal(calls[0].url,"/api/bff/admin/profile/avatar/upload-intents"); assert.equal(calls[0].init.method,"POST");
    assert.deepEqual(JSON.parse(calls[0].init.body),{mime:"image/webp",size:4,expectedRevision:"0"});
    assert.equal(calls[0].init.headers["idempotency-key"],"admin-intent-original-key"); assert.equal(calls[0].init.signal,signal);
    await readAdminAvatarOperationResult({actorId:"admin_1",slot:"default",key:"admin-default-original-key",presetId:"avatar-night",expectedRevision:"0"});
    const call=calls[1],url=new URL(call.url,"https://fixture.test");
    assert.equal(call.init.method,"GET"); assert.equal(call.init.body,undefined); assert.equal(call.init.headers["idempotency-key"],"admin-default-original-key");
    assert.equal(url.pathname,"/api/bff/admin/profile/avatar/operation-result");
    assert.deepEqual(Object.fromEntries(url.searchParams),{operation:"profile.avatar.default.select",presetId:"avatar-night",expectedRevision:"0"});
  } finally { globalThis.fetch=original; }
});

test("review recovery POST preserves original body/key and withdraw omits decision", async () => {
  const { readAdminAvatarOperationResult } = await import("../src/views/self-settings/avatar-api.ts");
  const calls=[],original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({receipt:"RECORDED",responseStatus:200,result:{asset:{id:"asset_original"},review:{applied:true}}});};
  try {
    const base={actorId:"admin_1",slot:"review",assetId:"asset_original",reason:"仅正文中的审核理由",expectedRevision:"7"};
    await readAdminAvatarOperationResult({...base,key:"review-original-key",action:"REJECT"});
    await readAdminAvatarOperationResult({...base,key:"withdraw-original-key",action:"WITHDRAW"});
    for(const call of calls){const url=new URL(call.url,"https://fixture.test");assert.equal(call.init.method,"POST");assert.equal(url.pathname,"/api/bff/admin/profile-avatars/operation-result");assert.equal(url.search,"");assert.equal(call.url.includes(base.reason),false);}
    assert.equal(calls[0].init.headers["idempotency-key"],"review-original-key");
    assert.deepEqual(JSON.parse(calls[0].init.body),{operation:"profile.avatar.review",assetId:"asset_original",decision:"REJECT",reason:base.reason,expectedRevision:"7"});
    assert.equal(calls[1].init.headers["idempotency-key"],"withdraw-original-key");
    assert.deepEqual(JSON.parse(calls[1].init.body),{operation:"profile.avatar.withdraw",assetId:"asset_original",reason:base.reason,expectedRevision:"7"});
    assert.equal(Object.hasOwn(JSON.parse(calls[1].init.body),"decision"),false);
  } finally { globalThis.fetch=original; }
});
