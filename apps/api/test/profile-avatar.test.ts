import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import type { PoolClient } from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  avatarImagePath,
  avatarReviewDisposition,
  ensureInitialProfileAvatar,
  isAvatarAssetPubliclyEligible,
  profileAvatarStateView,
  selectDefaultAvatar,
} from "../src/profile/profile-avatar";
import {
  deterministicPresetId,
  isProfileAvatarPresetId,
  loadPresetBytes,
  presetContentPath,
  profileAvatarPreset,
  PROFILE_AVATAR_PRESETS,
  randomPresetId,
} from "../src/profile/profile-avatar-presets";
import { createMediaUploadIntent } from "../src/supply/media";
import { createLocalMediaStorage } from "../src/supply/media";
import { handleProfileAvatarUserRoute } from "../src/profile/profile-avatar-routes";

test("the checked-in preset manifest matches the executable manifest and asset bytes", async () => {
  const manifest = JSON.parse(await readFile(resolve(__dirname, "../../assets/profile-avatars/manifest.json"), "utf8")) as {
    presets: Array<Record<string, unknown>>;
  };
  assert.equal(manifest.presets.length, 4);
  assert.equal(PROFILE_AVATAR_PRESETS.length, 4);
  for (const [index, preset] of PROFILE_AVATAR_PRESETS.entries()) {
    const documented = manifest.presets[index]!;
    assert.equal(documented.presetId, preset.presetId);
    assert.equal(documented.version, preset.version);
    assert.equal(documented.file, preset.assetFile);
    assert.equal(documented.mime, preset.mime);
    assert.equal(documented.width, preset.width);
    assert.equal(documented.height, preset.height);
    assert.equal(documented.byteSize, preset.byteSize);
    assert.equal(documented.contentHash, preset.contentHash);
    assert.equal(documented.originalSha256, preset.originalSha256);
    const bytes = await loadPresetBytes(preset);
    assert.equal(bytes.length, preset.byteSize);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), preset.contentHash);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 256);
    assert.equal(metadata.height, 256);
    assert.equal(metadata.exif, undefined);
    assert.equal(presetContentPath(preset), `/api/v1/profile/avatars/presets/${preset.presetId}/1/content`);
  }
});

test("preset selection is stable per subject and random defaults stay in the registered set", () => {
  const ids = new Set(PROFILE_AVATAR_PRESETS.map((preset) => preset.presetId));
  assert.equal(deterministicPresetId("user", "user_a"), deterministicPresetId("user", "user_a"));
  assert.ok(ids.has(deterministicPresetId("user", "user_a")));
  assert.ok(ids.has(deterministicPresetId("admin", "admin_a")));
  for (let index = 0; index < 100; index += 1) assert.ok(ids.has(randomPresetId()));
  assert.equal(isProfileAvatarPresetId("avatar-strike"), true);
  assert.equal(isProfileAvatarPresetId("avatar-unknown"), false);
  assert.equal(profileAvatarPreset("avatar-strike").width, 256);
});

test("rowless subjects display a deterministic default but keep revision zero", () => {
  const view = profileAvatarStateView(null, "user", "user_a");
  assert.equal(view.revision, "0");
  assert.equal(view.current.currentVersion, "0");
  assert.equal(view.current.kind, "DEFAULT");
  assert.equal(view.current.url, avatarImagePath("user", "user_a", "0"));
  assert.equal(view.presets.length, 4);
});

test("a late review only applies while its asset is still the latest pending choice", () => {
  assert.deepEqual(
    avatarReviewDisposition({ pendingAssetId: "asset_a", currentAssetId: null, assetId: "asset_a", decision: "APPROVE" }),
    { apply: true, clearPending: true, fallback: false },
  );
  assert.deepEqual(
    avatarReviewDisposition({ pendingAssetId: "asset_b", currentAssetId: null, assetId: "asset_a", decision: "APPROVE" }),
    { apply: false, clearPending: false, fallback: false },
    "A approved after B was submitted must not replace B",
  );
  assert.deepEqual(
    avatarReviewDisposition({ pendingAssetId: null, currentAssetId: "asset_a", assetId: "asset_a", decision: "APPROVE" }),
    { apply: false, clearPending: false, fallback: false },
    "switching to a default clears pending, so a late approval is only recorded",
  );
  for (const decision of ["REJECT", "QUARANTINE", "WITHDRAW"] as const) {
    assert.deepEqual(
      avatarReviewDisposition({ pendingAssetId: "asset_a", currentAssetId: "asset_a2", assetId: "asset_a", decision }),
      { apply: false, clearPending: true, fallback: false },
    );
    assert.deepEqual(
      avatarReviewDisposition({ pendingAssetId: null, currentAssetId: "asset_a", assetId: "asset_a", decision }),
      { apply: false, clearPending: false, fallback: true },
    );
  }
});

test("public avatar eligibility requires an approved ready derivative", () => {
  const asset = {
    purpose: "AVATAR",
    ownershipKind: "USER_AVATAR" as const,
    reviewState: "APPROVED",
    accessClass: "PUBLIC_DISPLAY",
    technicalState: "READY",
    publicStorageKey: "a".repeat(64),
  };
  assert.equal(isAvatarAssetPubliclyEligible(asset), true);
  for (const patch of [
    { reviewState: "PENDING" },
    { accessClass: "PRIVATE_REVIEW" },
    { technicalState: "FAILED" },
    { publicStorageKey: null },
    { purpose: "ACCOUNT_DISPLAY" },
    { ownershipKind: "USER_SUPPLY" as const },
  ]) assert.equal(isAvatarAssetPubliclyEligible({ ...asset, ...patch }), false, JSON.stringify(patch));
});

test("avatar upload intents carry realm ownership without forging game or account ids", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; },
  } as unknown as PoolClient;
  const user = await createMediaUploadIntent(client, { realm: "user", userId: "user_1" }, { purpose: "AVATAR", mime: "image/png", size: 1024 });
  assert.ok(user.intentId.startsWith("upload_"));
  const userInsert = calls[0]!;
  assert.match(userInsert.sql, /media_upload_intent/);
  assert.deepEqual(userInsert.values.slice(2, 10), [null, null, "AVATAR", "USER_AVATAR", "user_1", "user", "user_1", null]);

  calls.length = 0;
  await createMediaUploadIntent(client, { realm: "admin", adminUserId: "admin_1" }, { purpose: "AVATAR", mime: "image/webp", size: 2048 });
  const adminInsert = calls[0]!;
  assert.deepEqual(adminInsert.values.slice(2, 10), [null, null, "AVATAR", "ADMIN_AVATAR", null, "admin", null, "admin_1"]);

  const before = calls.length;
  await assert.rejects(
    () => createMediaUploadIntent(client, { realm: "user", userId: "user_1" }, { purpose: "AVATAR", gameId: "game_1", mime: "image/png", size: 1024 }),
    /cannot target a game/,
  );
  await assert.rejects(
    () => createMediaUploadIntent(client, { realm: "admin", adminUserId: "admin_1" }, { purpose: "AVATAR", accountId: "account_1", mime: "image/png", size: 1024 }),
    /cannot target a game or rental account/,
  );
  assert.equal(calls.length, before, "rejected avatar intents never reach the database");
});

function captureResponse() {
  const headers = new Map<string, unknown>();
  let statusCode = 0;
  let body: unknown;
  let jsonBody: unknown;
  let sent = false;
  const response = {
    get headersSent() { return sent; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return response; },
    status(value: number) { statusCode = value; return response; },
    json(value: unknown) { jsonBody = value; sent = true; return response; },
    send(value: unknown) { body = value; sent = true; return response; },
  };
  return { response, headers, get statusCode() { return statusCode; }, get body() { return body; }, get jsonBody() { return jsonBody; } };
}

function fakeAvatarPool(input: { profile?: Record<string, unknown> | null; image?: string | null; asset?: Record<string, unknown> | null }) {
  const client = {
    async query(sql: string) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM "zzsh_supply"."profile_avatar"')) return { rows: input.profile ? [input.profile] : [], rowCount: input.profile ? 1 : 0 };
      if (sql.includes('SELECT "image" FROM "zzsh_auth_user"."user"')) return { rows: input.image === undefined ? [] : [{ image: input.image }], rowCount: input.image === undefined ? 0 : 1 };
      if (sql.includes('FROM "zzsh_supply"."media_asset"')) return { rows: input.asset ? [input.asset] : [], rowCount: input.asset ? 1 : 0 };
      throw new Error(`unexpected avatar route query: ${sql.slice(0, 90)}`);
    },
    release() {},
  };
  return { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) };
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    realm: "user", subjectId: "user_1", defaultPresetId: "avatar-strike", currentKind: "DEFAULT",
    currentPresetId: "avatar-strike", currentAssetId: null, pendingAssetId: null,
    revision: "1", currentVersion: "1", lastReviewAssetId: null, lastReviewState: null,
    lastReviewReason: null, lastReviewedAt: null, lastReviewApplied: false, updatedAt: new Date(),
    ...overrides,
  };
}

function avatarAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset_1", gameId: null, accountId: null, purpose: "AVATAR", ownershipKind: "USER_AVATAR",
    ownerUserId: "user_1", uploadedByRealm: "user", uploadedByUserId: "user_1", uploadedByAdminId: null,
    storageKey: "1".repeat(64), publicStorageKey: "2".repeat(64), contentHash: "1".repeat(64),
    mime: "image/webp", byteSize: "15002", width: 256, height: 256, accessClass: "PUBLIC_DISPLAY",
    reviewState: "APPROVED", technicalState: "READY", reviewReason: null, revision: "2", createdAt: new Date(),
    ...overrides,
  };
}

test("public preset and current-avatar reads only serve the expected derivative and version", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-avatar-"));
  try {
    const storage = createLocalMediaStorage(root);
    const preset = PROFILE_AVATAR_PRESETS[0]!;
    const presetBytes = await loadPresetBytes(preset);
    await storage.write(presetBytes, preset.contentHash, preset.mime);

    const presetResponse = captureResponse();
    await handleProfileAvatarUserRoute(
      { method: "GET", url: "/api/v1/profile/avatars/presets/avatar-strike/1/content", headers: {} } as never,
      presetResponse.response as never,
      { pool: fakeAvatarPool({}), mediaStorage: storage } as never,
    );
    assert.equal(presetResponse.statusCode, 200);
    assert.equal(presetResponse.headers.get("content-type"), "image/webp");
    assert.deepEqual(presetResponse.body, presetBytes);

    const currentResponse = captureResponse();
    await handleProfileAvatarUserRoute(
      { method: "GET", url: "/api/v1/profile/avatars/user/user_1/1", headers: {} } as never,
      currentResponse.response as never,
      { pool: fakeAvatarPool({ profile: profileRow(), image: avatarImagePath("user", "user_1", "1") }), mediaStorage: storage } as never,
    );
    assert.equal(currentResponse.statusCode, 200);
    assert.deepEqual(currentResponse.body, presetBytes);

    const stale = captureResponse();
    await handleProfileAvatarUserRoute(
      { method: "GET", url: "/api/v1/profile/avatars/user/user_1/2", headers: {} } as never,
      stale.response as never,
      { pool: fakeAvatarPool({ profile: profileRow(), image: avatarImagePath("user", "user_1", "1") }), mediaStorage: storage } as never,
    );
    assert.equal(stale.statusCode, 404, "旧版本地址必须失效");

    const mismatchedImage = captureResponse();
    await handleProfileAvatarUserRoute(
      { method: "GET", url: "/api/v1/profile/avatars/user/user_1/1", headers: {} } as never,
      mismatchedImage.response as never,
      { pool: fakeAvatarPool({ profile: profileRow(), image: null }), mediaStorage: storage } as never,
    );
    assert.equal(mismatchedImage.statusCode, 404, "image 字段与当前绑定不一致时不得公开");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an approved current custom avatar serves only its public derivative; a pending current falls back to the default", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-avatar-custom-"));
  try {
    const storage = createLocalMediaStorage(root);
    const preset = PROFILE_AVATAR_PRESETS[0]!;
    const presetBytes = await loadPresetBytes(preset);
    await storage.write(presetBytes, preset.contentHash, preset.mime);
    const publicKey = "2".repeat(64);
    const customBytes = Buffer.from("custom-public-derivative");
    await storage.write(customBytes, publicKey, "image/webp");
    const image = avatarImagePath("user", "user_1", "1");
    const profile = profileRow({ currentKind: "CUSTOM", currentPresetId: null, currentAssetId: "asset_1" });

    const approved = captureResponse();
    await handleProfileAvatarUserRoute(
      { method: "GET", url: "/api/v1/profile/avatars/user/user_1/1", headers: {} } as never,
      approved.response as never,
      { pool: fakeAvatarPool({ profile, image, asset: avatarAsset() }), mediaStorage: storage } as never,
    );
    assert.equal(approved.statusCode, 200);
    assert.deepEqual(approved.body, customBytes);

    const pending = captureResponse();
    await handleProfileAvatarUserRoute(
      { method: "GET", url: "/api/v1/profile/avatars/user/user_1/1", headers: {} } as never,
      pending.response as never,
      { pool: fakeAvatarPool({ profile, image, asset: avatarAsset({ reviewState: "PENDING", accessClass: "PRIVATE_REVIEW" }) }), mediaStorage: storage } as never,
    );
    assert.equal(pending.statusCode, 200);
    assert.deepEqual(pending.body, presetBytes, "不合格的当前自定义图回退默认头像");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default selection is CAS-protected and updates the compatibility image in the same call", async () => {
  const row = profileRow({ revision: "2", currentVersion: "3" });
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM "zzsh_supply"."profile_avatar"')) return { rows: [row], rowCount: 1 };
      if (sql.startsWith('UPDATE "zzsh_supply"."profile_avatar"')) return { rows: [profileRow({ currentPresetId: "avatar-night", revision: "3", currentVersion: "4" })], rowCount: 1 };
      if (sql.startsWith('UPDATE "zzsh_auth_user"."user" SET "image"')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected avatar selection query: ${sql.slice(0, 80)}`);
    },
  } as unknown as PoolClient;
  const actor = { realm: "user" as const, id: "user_1" };

  await assert.rejects(
    () => selectDefaultAvatar(client, "user", "user_1", { presetId: "avatar-night", expectedRevision: "1" }, actor, "req_cas"),
    (error: unknown) => (error as { status?: number }).status === 409,
  );
  assert.equal(calls.length, 1, "版本不符时不得写 profile 或 image");

  calls.length = 0;
  const result = await selectDefaultAvatar(client, "user", "user_1", { presetId: "avatar-night", expectedRevision: "2" }, actor, "req_ok");
  assert.equal(result.changed, true);
  assert.equal(result.state.current.presetId, "avatar-night");
  const profileUpdate = calls.find((call) => call.sql.startsWith('UPDATE "zzsh_supply"."profile_avatar"'))!;
  assert.deepEqual(profileUpdate.values, ["user", "user_1", "avatar-night", "4", "3"]);
  const imageUpdate = calls.find((call) => call.sql.startsWith('UPDATE "zzsh_auth_user"."user" SET "image"'))!;
  assert.deepEqual(imageUpdate.values, ["user_1", "/api/v1/profile/avatars/user/user_1/4"]);

  calls.length = 0;
  const row2 = profileRow({ revision: "2", currentVersion: "3", currentPresetId: "avatar-night" });
  const noopClient = { async query(sql: string, values: unknown[] = []) { calls.push({ sql, values }); return { rows: [row2], rowCount: 1 }; } } as unknown as PoolClient;
  const noop = await selectDefaultAvatar(noopClient, "user", "user_1", { presetId: "avatar-night", expectedRevision: "2" }, actor, "req_noop");
  assert.equal(noop.changed, false);
  assert.equal(calls.length, 1, "同一默认头像不产生写或审计");
});

test("default allocation persists once and a replay never re-rolls the avatar or image", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let inserted = false;
  const stored = profileRow({ currentPresetId: "avatar-frost", revision: "1", currentVersion: "1" });
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.startsWith('INSERT INTO "zzsh_supply"."profile_avatar"')) {
        if (inserted) return { rows: [], rowCount: 0 };
        inserted = true;
        return { rows: [stored], rowCount: 1 };
      }
      if (sql.includes('FROM "zzsh_supply"."profile_avatar"')) return { rows: [stored], rowCount: 1 };
      if (sql.startsWith('UPDATE "zzsh_auth_user"."user" SET "image"')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('INSERT INTO "zzsh_iam"."audit_event"')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected avatar allocation query: ${sql.slice(0, 80)}`);
    },
  } as unknown as PoolClient;
  const first = await ensureInitialProfileAvatar(client, "user", "user_1", "req_first");
  const imagesAfterFirst = calls.filter((call) => call.sql.startsWith('UPDATE "zzsh_auth_user"."user" SET "image"')).length;
  assert.equal(first.created, true);
  inserted = true;
  const replay = await ensureInitialProfileAvatar(client, "user", "user_1", "req_replay");
  assert.equal(replay.created, false);
  assert.equal(replay.presetId, "avatar-frost", "重放返回已持久化的默认头像");
  assert.equal(calls.filter((call) => call.sql.startsWith('UPDATE "zzsh_auth_user"."user" SET "image"')).length, imagesAfterFirst, "重放不得再次写 image");
});
