import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAvatarState, ProfileAvatarError, readAvatarState, selectDefaultAvatar, uploadAvatar } from "../src/lib/profile-avatar-client.ts";

const PRESETS = [
  { presetId: "avatar-strike", version: 1, url: "/api/v1/profile/avatars/presets/avatar-strike/1/content", width: 256, height: 256 },
  { presetId: "avatar-night", version: 1, url: "/api/v1/profile/avatars/presets/avatar-night/1/content", width: 256, height: 256 },
  { presetId: "avatar-frost", version: 1, url: "/api/v1/profile/avatars/presets/avatar-frost/1/content", width: 256, height: 256 },
  { presetId: "avatar-aurora", version: 1, url: "/api/v1/profile/avatars/presets/avatar-aurora/1/content", width: 256, height: 256 },
];
const STATE = {
  revision: "3",
  updatedAt: "2026-11-01T00:00:00.000Z",
  current: { kind: "DEFAULT", assetId: null, presetId: "avatar-strike", url: "/api/v1/profile/avatars/user/user_1/2", currentVersion: "2" },
  defaultPresetId: "avatar-strike",
  presets: PRESETS,
  pending: { assetId: "asset_1", submittedAt: "2026-11-01T00:01:00.000Z", reviewState: "PENDING", width: 256, height: 256, byteSize: "15002" },
  lastReview: { assetId: "asset_0", state: "REJECTED", reason: "不清晰", reviewedAt: "2026-10-31T00:00:00.000Z", applied: false },
};

test("avatar state parsing keeps version and pending facts separate from the current image", () => {
  const state = parseAvatarState(STATE);
  assert.equal(state.revision, "3");
  assert.equal(state.current.kind, "DEFAULT");
  assert.equal(state.current.url, "/api/v1/profile/avatars/user/user_1/2");
  assert.equal(state.pending?.assetId, "asset_1");
  assert.equal(state.lastReview?.state, "REJECTED");
  assert.equal(state.presets.length, 4);
});

test("avatar state parsing rejects incomplete or malformed contracts", () => {
  assert.throws(() => parseAvatarState({ ...STATE, presets: PRESETS.slice(0, 3) }), ProfileAvatarError);
  assert.throws(() => parseAvatarState({ ...STATE, current: { ...STATE.current, kind: "REMOTE" } }), ProfileAvatarError);
  assert.throws(() => parseAvatarState({ ...STATE, lastReview: { ...STATE.lastReview, state: "UNKNOWN" } }), ProfileAvatarError);
});

test("select and upload send the same keys and tokens the server contract requires", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/default")) return new Response(JSON.stringify({ ...STATE, changed: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).includes("/uploads/")) return new Response(JSON.stringify({ assetId: "asset_2" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(STATE), { status: 200, headers: { "content-type": "application/json" } });
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
  const { createAvatarUploadIntent } = await import("../src/lib/profile-avatar-client.ts");
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
  const { readAvatarOperationResult } = await import("../src/lib/profile-avatar-client.ts");
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({url:String(url),init}); return Response.json({receipt:"RECORDED",responseStatus:200,result:STATE}); };
  try {
    await readAvatarOperationResult("avatar-default-original-key","avatar-night","0");
    const call=calls[0], url=new URL(call.url,"https://fixture.test");
    assert.equal(call.init.method,"GET"); assert.equal(call.init.body,undefined); assert.equal(call.init.headers["idempotency-key"],"avatar-default-original-key");
    assert.equal(url.pathname,"/api/v1/profile/avatar/operation-result");
    assert.deepEqual(Object.fromEntries(url.searchParams),{operation:"profile.avatar.default.select",presetId:"avatar-night",expectedRevision:"0"});
  } finally { globalThis.fetch = original; }
});
