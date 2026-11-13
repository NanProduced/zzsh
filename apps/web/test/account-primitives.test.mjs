import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSavedTheme } from "../src/lib/theme.ts";
import { isPublicCount } from "../src/lib/public-activity.ts";
import { safeReturnTo } from "../src/lib/safe-return.ts";
import {
  consumeAccountReturnSnapshot,
  readAccountListingState,
  rememberAccountListingState,
  rememberAccountReturn,
} from "../src/lib/account-return.ts";
import {
  accountStatusLabel,
  ageStatusLabel,
  cancellationFailureMessage,
  identityStatusLabel,
  protectedActionReason,
  providerAvailability,
} from "../src/app/user-account-status.ts";
import { parseNetworkInfo } from "../src/lib/network-info-client.ts";

test("public counts accept zero and hide missing, invalid or unsafe values", () => {
  for (const v of [0, 12580]) assert.equal(isPublicCount(v), true);
  for (const v of [null, undefined, -1, NaN, Infinity, 1.2, "20", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isPublicCount(v), false);
  }
});

test("saved system preference and invalid values fall back to dark", () => {
  for (const value of [null, "system", "invalid", "dark"]) assert.equal(resolveSavedTheme(value), "dark");
  assert.equal(resolveSavedTheme("light"), "light");
});

test("only same-site absolute paths survive as post-login return targets", () => {
  for (const value of [
    "https://evil.invalid/account",
    "http://evil.invalid",
    "//evil.invalid/account",
    "/\\evil.invalid",
    "javascript:alert(1)",
    "/account\u0000",
    "/account\nx",
    `/${"a".repeat(600)}`,
    "account",
    "",
    null,
    undefined,
  ]) {
    assert.equal(safeReturnTo(value), undefined, `must reject ${JSON.stringify(value)}`);
  }
  for (const value of ["/", "/accounts/42", "/publish?mode=fast", "/account?view=favorites#list"]) {
    assert.equal(safeReturnTo(value), value);
  }
  assert.equal(safeReturnTo("  /accounts/42  "), "/accounts/42");
});

test("account list state is versioned by game and falls back to memory when storage is unavailable", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const storage = new Map();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  });
  try {
    const state = {
      filters: { regions: [{ province: "甲省", city: "甲市" }] },
      q: null,
      sort: "latest",
      direction: "DESC",
      coreItemId: null,
      limit: 20,
      viewMode: "grid",
    };
    rememberAccountListingState("game_state_a", state);
    assert.deepEqual(readAccountListingState("game_state_a"), state);
    assert.equal(JSON.parse(storage.get("zzsh:account-list-state:v1:game_state_a")).version, 1);
    assert.equal(readAccountListingState("game_state_b"), null);

    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
        removeItem: () => { throw new Error("blocked"); },
      },
    });
    rememberAccountListingState("game_memory_a", state);
    assert.deepEqual(readAccountListingState("game_memory_a"), state);
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  }
});

test("detail return snapshot restores only for its exact filter digest", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const storage = new Map();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  });
  try {
    const location = { pathname: "/accounts", search: "?game=game_delta" };
    const snapshot = { scrollY: 480, pageCursors: [null, "cursor_1"], filterKey: "filter-digest-a", viewMode: "grid" };
    rememberAccountReturn("return_filter_mismatch", location, snapshot);
    assert.equal(consumeAccountReturnSnapshot("/accounts?game=game_delta", "filter-digest-b"), null);
    rememberAccountReturn("return_filter_match", location, snapshot);
    assert.deepEqual(consumeAccountReturnSnapshot("/accounts?game=game_delta", "filter-digest-a"), snapshot);
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  }
});

test("identity fixtures expose adult, minor, rejection, and unavailable reasons", () => {
  const adult = { identityStatus: "VERIFIED", ageStatus: "ADULT", eligibleForProtectedTrade: true, provider: "fake" };
  const minor = { identityStatus: "VERIFIED", ageStatus: "MINOR", eligibleForProtectedTrade: false, provider: "fake" };
  const rejected = { identityStatus: "REJECTED", ageStatus: "UNKNOWN", eligibleForProtectedTrade: false, provider: "fake" };
  const unavailable = { identityStatus: "UNKNOWN", ageStatus: "UNKNOWN", eligibleForProtectedTrade: false, provider: "none" };

  assert.match(protectedActionReason(adult), /满足身份与年龄要求/);
  assert.match(protectedActionReason(minor), /年龄不满足/);
  assert.match(protectedActionReason(rejected), /实名校验未通过/);
  assert.match(protectedActionReason(unavailable), /实名服务暂时无法确认/);
  assert.match(providerAvailability(unavailable), /实名状态暂未确认/);
  assert.match(providerAvailability(adult), /不代表真实实名通过/);
  assert.equal(identityStatusLabel(adult.identityStatus), "实名已验证");
  assert.equal(ageStatusLabel(adult.ageStatus), "已确认成年人");
});

test("cancellation feedback distinguishes pending obligations from unknown checks", () => {
  assert.match(cancellationFailureMessage(409, "CONFLICT"), /仍有未完成事项/);
  assert.match(cancellationFailureMessage(503, "INTERNAL_ERROR"), /无法确认未完成事项/);
  assert.equal(accountStatusLabel("CANCELLED"), "账号已注销");
  assert.equal(accountStatusLabel("FROZEN"), "账号已冻结");
  assert.equal(accountStatusLabel("FUTURE_UNKNOWN"), "账号状态待确认");
  assert.equal(identityStatusLabel("FUTURE_UNKNOWN"), "实名状态待确认");
  assert.equal(ageStatusLabel("FUTURE_UNKNOWN"), "年龄状态待确认");
});

test("解析接受 IPv4 与 IPv6 字面量，拒绝非 IP 的返回", () => {
  assert.equal(parseNetworkInfo({ ip: "203.0.113.195", country_name: "中国", region: "浙江", city: "杭州", org: "AS4134" })?.ip, "203.0.113.195");
  assert.equal(parseNetworkInfo({ ip: "2001:db8::1", country_name: "中国" })?.ip, "2001:db8::1");
  assert.equal(parseNetworkInfo({ ip: "not-an-ip" }), null);
  assert.equal(parseNetworkInfo(null), null);
});



/* --- Profile Avatar Client Primitives Tests --- */

import { parseAvatarState, parseAvatarUploadResult, ProfileAvatarError, readAvatarState, selectDefaultAvatar, uploadAvatar, createAvatarUploadIntent, readAvatarOperationResult } from "../src/lib/profile-avatar-client.ts";

const AVATAR_PRESETS = [
  { presetId: "avatar-strike", version: 1, url: "/api/v1/profile/avatars/presets/avatar-strike/1/content", width: 256, height: 256 },
  { presetId: "avatar-night", version: 1, url: "/api/v1/profile/avatars/presets/avatar-night/1/content", width: 256, height: 256 },
  { presetId: "avatar-frost", version: 1, url: "/api/v1/profile/avatars/presets/avatar-frost/1/content", width: 256, height: 256 },
  { presetId: "avatar-aurora", version: 1, url: "/api/v1/profile/avatars/presets/avatar-aurora/1/content", width: 256, height: 256 },
];
const AVATAR_STATE = {
  revision: "3",
  updatedAt: "2026-11-01T00:00:00.000Z",
  current: { kind: "DEFAULT", assetId: null, presetId: "avatar-strike", url: "/api/v1/profile/avatars/user/user_1/2", currentVersion: "2" },
  defaultPresetId: "avatar-strike",
  presets: AVATAR_PRESETS,
  pending: { assetId: "asset_1", submittedAt: "2026-11-01T00:01:00.000Z", reviewState: "PENDING", width: 256, height: 256, byteSize: "15002" },
  lastReview: { assetId: "asset_0", state: "REJECTED", reason: "不清晰", reviewedAt: "2026-10-31T00:00:00.000Z", applied: false },
};

test('avatar policy only enables direct display with an available boolean policy and positive revision',()=>{
 for(const policy of [undefined,null,{requiresReview:false,available:false,revision:'2'},{requiresReview:'false',available:true,revision:'2'},{requiresReview:false,available:true,revision:'0'}])assert.deepEqual(parseAvatarState({...AVATAR_STATE,policy}).policy,{requiresReview:true,available:false,revision:'0'});
 assert.deepEqual(parseAvatarState({...AVATAR_STATE,policy:{requiresReview:false,available:true,revision:'2'}}).policy,{requiresReview:false,available:true,revision:'2'});
 const review=parseAvatarState({...AVATAR_STATE,lastReview:{...AVATAR_STATE.lastReview,state:'APPROVED',reason:null,applied:true,source:'SYSTEM_POLICY',policyRevision:'2'}}).lastReview;assert.equal(review.source,'SYSTEM_POLICY');assert.equal(review.policyRevision,'2');
});

test('upload dispositions retain server truth and reject contradictory or unbound policy approvals',()=>{
 const applied={assetId:'asset_new',avatarSubmission:{disposition:'APPLIED_BY_POLICY',requiresReview:false,policyRevision:'2',approvalSource:'SYSTEM_POLICY'}};
 assert.equal(parseAvatarUploadResult(applied).avatarSubmission.disposition,'APPLIED_BY_POLICY');
 assert.equal(parseAvatarUploadResult({assetId:'asset_old'}).avatarSubmission,null);
 assert.equal(parseAvatarUploadResult({...applied,avatarSubmission:{disposition:'PENDING_REVIEW',requiresReview:true,policyRevision:'0',approvalSource:'MANUAL_REVIEW_REQUIRED'}}).avatarSubmission.disposition,'PENDING_REVIEW');
 for(const bad of [{...applied,assetId:null},{...applied,avatarSubmission:{...applied.avatarSubmission,requiresReview:true}},{...applied,avatarSubmission:{...applied.avatarSubmission,approvalSource:'HUMAN_REVIEW'}},{...applied,avatarSubmission:{...applied.avatarSubmission,policyRevision:'0'}}])assert.throws(()=>parseAvatarUploadResult(bad),ProfileAvatarError);
});

test("avatar state parsing keeps version and pending facts separate from the current image", () => {
  const state = parseAvatarState(AVATAR_STATE);
  assert.equal(state.revision, "3");
  assert.equal(state.current.kind, "DEFAULT");
  assert.equal(state.current.url, "/api/v1/profile/avatars/user/user_1/2");
  assert.equal(state.pending?.assetId, "asset_1");
  assert.equal(state.lastReview?.state, "REJECTED");
  assert.equal(state.presets.length, 4);
});

test("avatar state parsing rejects incomplete or malformed contracts", () => {
  assert.throws(() => parseAvatarState({ ...AVATAR_STATE, presets: AVATAR_PRESETS.slice(0, 3) }), ProfileAvatarError);
  assert.throws(() => parseAvatarState({ ...AVATAR_STATE, current: { ...AVATAR_STATE.current, kind: "REMOTE" } }), ProfileAvatarError);
  assert.throws(() => parseAvatarState({ ...AVATAR_STATE, lastReview: { ...AVATAR_STATE.lastReview, state: "UNKNOWN" } }), ProfileAvatarError);
});

test("select and upload send the same keys and tokens the server contract requires", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/default")) return new Response(JSON.stringify({ ...AVATAR_STATE, changed: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).includes("/uploads/")) return new Response(JSON.stringify({ assetId: "asset_2" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(AVATAR_STATE), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await readAvatarState();
    const selected = await selectDefaultAvatar("avatar-night", "3", "avatar-default-key");
    assert.equal(selected.changed, true);
    const file = new File([new Uint8Array([1, 2, 3])], "avatar.png", { type: "image/png" });
    await uploadAvatar("upload_1", "token_1", file, "avatar-upload-key");
    assert.equal(calls.length, 3);
    assert.equal(calls[1].init.headers["idempotency-key"], "avatar-default-key");
    assert.equal(JSON.parse(calls[1].init.body).expectedRevision, "3");
    assert.equal(calls[2].init.headers["x-upload-token"], "token_1");
    assert.equal(calls[2].init.headers["content-type"], "image/png");
    assert.equal(calls[2].init.headers["idempotency-key"], "avatar-upload-key");
  } finally {
    globalThis.fetch = original;
  }
});

test("upload intent fetch carries the frozen revision before the AbortSignal", async () => {
  const calls = [], original = globalThis.fetch, signal = new AbortController().signal;
  globalThis.fetch = async (url, init) => { calls.push({url:String(url),init}); return Response.json({intentId:"upload_fixture",uploadToken:"synthetic-token"}); };
  try {
    const file = new File([new Uint8Array([1,2,3])],"avatar.png",{type:"image/png"});
    await createAvatarUploadIntent(file,"avatar-intent-original-key","0",signal);
    assert.equal(calls.length,1); assert.equal(calls[0].url,"/api/v1/profile/avatar/upload-intents"); assert.equal(calls[0].init.method,"POST");
    assert.deepEqual(JSON.parse(calls[0].init.body),{mime:"image/png",size:3,expectedRevision:"0"});
    assert.equal(calls[0].init.headers["idempotency-key"],"avatar-intent-original-key"); assert.equal(calls[0].init.signal,signal);
  } finally { globalThis.fetch = original; }
});

test("default operation recovery stays GET with the same key and zero revision", async () => {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({url:String(url),init}); return Response.json({receipt:"RECORDED",responseStatus:200,result:AVATAR_STATE}); };
  try {
    await readAvatarOperationResult("avatar-default-original-key","avatar-night","0");
    const call=calls[0], url=new URL(call.url,"https://fixture.test");
    assert.equal(call.init.method,"GET"); assert.equal(call.init.body,undefined); assert.equal(call.init.headers["idempotency-key"],"avatar-default-original-key");
    assert.equal(url.pathname,"/api/v1/profile/avatar/operation-result");
    assert.deepEqual(Object.fromEntries(url.searchParams),{operation:"profile.avatar.default.select",presetId:"avatar-night",expectedRevision:"0"});
  } finally { globalThis.fetch = original; }
});
