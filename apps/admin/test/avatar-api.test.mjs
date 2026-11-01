import assert from "node:assert/strict";
import { test } from "node:test";

import { AdminAvatarError, parseAdminAvatarState, readAdminAvatarReviews, reviewAdminAvatar } from "../src/views/self-settings/avatar-api.ts";

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
