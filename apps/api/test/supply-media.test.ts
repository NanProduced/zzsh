import sharp from "sharp";
import OSS from "ali-oss";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Pool } from "pg";

import {
  assertImageWithinBounds,
  createLocalMediaStorage,
  createUnavailableMediaStorage,
  inspectImage,
  decodeImage,
  MediaValidationError,
  finalizeMediaUpload,
  prepareMediaUpload,
  type ImageMime,
} from "../src/supply/media";
import { createOssAccountMedia } from "../src/supply/account-media-oss";
import {
  createOssMediaStorage,
  loadOssCredentials,
  loadOssMediaStorageOptions,
  ossObjectKey,
  resolveMediaStorage,
  type OssObjectClient,
} from "../src/supply/media-oss";
import { ConfigurationError } from "../src/config/config";

test("full decoder accepts real formats and rejects fake headers, truncation and metadata in derivatives", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } }).withExif({ IFD0: { Artist: "private evidence marker" } }).toFormat(format).toBuffer();
    assert.deepEqual(await inspectImage(bytes), { mime: "image/" + format, width: 64, height: 32 });
    await assert.rejects(() => inspectImage(bytes.subarray(0, Math.floor(bytes.length / 2))), MediaValidationError);
    const derivative = await decodeImage(bytes);
    assert.equal((await sharp(derivative.publicBytes).metadata()).exif, undefined);
    assert.ok((await sharp(bytes).metadata()).exif, "original evidence still has its metadata");
  }
  const fake = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(fake); fake.write("IHDR",12); fake.writeUInt32BE(1,16); fake.writeUInt32BE(1,20);
  for (const bytes of [fake, Buffer.from("<svg></svg>"), Buffer.from("GIF89a"), Buffer.alloc(11 * 1024 * 1024)]) await assert.rejects(() => inspectImage(bytes), MediaValidationError);
  const tooWide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(() => inspectImage(tooWide), MediaValidationError);
});

test("pixel and size bounds reject oversized images", () => {
  assert.throws(() => assertImageWithinBounds({ mime: "image/png", width: 9000, height: 100 }, 1000), MediaValidationError);
  assert.throws(() => assertImageWithinBounds({ mime: "image/png", width: 8000, height: 8000 }, 1000), MediaValidationError);
  assert.throws(() => assertImageWithinBounds({ mime: "image/png", width: 100, height: 100 }, 0), MediaValidationError);
  assert.throws(() => assertImageWithinBounds({ mime: "image/png", width: 100, height: 100 }, 11 * 1024 * 1024), MediaValidationError);
  assert.doesNotThrow(() => assertImageWithinBounds({ mime: "image/png", width: 1920, height: 1080 }, 1024));
});

test("EXIF orientation is applied to the derivative without changing original evidence", async () => {
  const original = await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const before = Buffer.from(original);
  const result = await decodeImage(original);
  assert.deepEqual(original, before);
  assert.equal((await sharp(original).metadata()).orientation, 6);
  assert.deepEqual(result.info, { mime: "image/jpeg", width: 40, height: 80 });
  const derivative = await sharp(result.publicBytes).metadata();
  assert.equal(derivative.width, 40); assert.equal(derivative.height, 80);
  assert.equal(derivative.orientation, undefined); assert.equal(derivative.exif, undefined);
});

test("local storage is content addressed, repeatable, and rejects invalid keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "zzsh-media-"));
  try {
    const storage = createLocalMediaStorage(root);
    assert.equal(storage.available, true);
    const bytes = Buffer.from("storage fixture");
    const hash = "a".repeat(64);
    await storage.write(bytes, hash, "image/png");
    await storage.write(bytes, hash, "image/png");
    assert.deepEqual(await storage.read(hash), bytes);
    await assert.rejects(() => storage.read("../../escape"), /storage key is invalid/);
    await assert.rejects(() => storage.read("f".repeat(64)), /unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfigured storage reports itself unavailable instead of pretending to work", async () => {
  const storage = createUnavailableMediaStorage();
  assert.equal(storage.available, false);
  await assert.rejects(() => storage.write(Buffer.from("x"), "a".repeat(64), "image/png"));
});

type FakeOssState = { objects: Map<string, Buffer>; puts: number; heads: number; mimes?: Map<string, ImageMime>; failsNextWith?: Error; failGetFor?: Set<string> };

function fakeOssClient(state: FakeOssState): OssObjectClient {
  const missing = () => {
    const error = new Error("secret host header detail") as Error & { code: string; status: number };
    error.code = "NoSuchKey";
    error.status = 404;
    return error;
  };
  return {
    async head(objectKey) {
      state.heads += 1;
      if (state.failsNextWith) {
        const error = state.failsNextWith;
        state.failsNextWith = undefined;
        throw error;
      }
      if (!state.objects.has(objectKey)) throw missing();
    },
    async put(objectKey, bytes, options) {
      state.puts += 1;
      if (state.failsNextWith) {
        const error = state.failsNextWith;
        state.failsNextWith = undefined;
        throw error;
      }
      state.objects.set(objectKey, Buffer.from(bytes));
      (state.mimes ??= new Map()).set(objectKey, options.mime);
    },
    async get(objectKey) {
      if (state.failGetFor?.has(objectKey)) throw new Error("SDK request id and signature must not leak");
      const content = state.objects.get(objectKey);
      if (!content) throw missing();
      return { content };
    },
  };
}

const OSS_OPTIONS = { bucket: "zzsh-dev", region: "oss-cn-shenzhen", endpoint: "https://oss-cn-shenzhen.aliyuncs.com", objectPrefix: "zzsh-rebuild/dev/" };
const OSS_CREDENTIALS = { accessKeyId: "test-key-id", accessKeySecret: "test-secret" };

test("oss storage is content addressed, skips existing objects and reads them back", async () => {
  const state: FakeOssState = { objects: new Map(), puts: 0, heads: 0 };
  const storage = createOssMediaStorage(OSS_OPTIONS, OSS_CREDENTIALS, { createClient: () => fakeOssClient(state) });
  assert.equal(storage.available, true);
  assert.equal(storage.kind, "oss");
  const bytes = Buffer.from("synthetic object");
  const hash = "ab".padEnd(64, "0");
  const objectKey = ossObjectKey(OSS_OPTIONS.objectPrefix, hash);
  assert.equal(objectKey, "zzsh-rebuild/dev/ab/ab00000000000000000000000000000000000000000000000000000000000000");
  await storage.write(bytes, hash, "image/png");
  await storage.write(bytes, hash, "image/png");
  assert.equal(state.puts, 1, "repeat writes of the same content must only upload once");
  assert.deepEqual(await storage.read(hash), bytes);
  await assert.rejects(() => storage.write(bytes, "not-a-hash", "image/png"), /content hash is invalid/);
  await assert.rejects(() => storage.read("../escape"), /storage key is invalid/);
  await assert.rejects(() => storage.read("f".repeat(64)), /stored media is unavailable/);
});

test("oss storage maps transport failures to generic messages without SDK details", async () => {
  const state: FakeOssState = { objects: new Map(), puts: 0, heads: 0 };
  const storage = createOssMediaStorage(OSS_OPTIONS, OSS_CREDENTIALS, { createClient: () => fakeOssClient(state) });
  const hash = "c".repeat(64);
  state.failsNextWith = Object.assign(new Error("ConnectionTimeoutError signed-url detail"), { code: "ConnectionTimeoutError", status: -2 });
  await assert.rejects(() => storage.write(Buffer.from("x"), hash, "image/png"), /media storage operation failed/);
  // An unknown-outcome failure must not block a retry: the next attempt re-runs.
  await storage.write(Buffer.from("x"), hash, "image/png");
  assert.equal(state.puts, 1);
  state.failGetFor = new Set([ossObjectKey(OSS_OPTIONS.objectPrefix, hash)]);
  await assert.rejects(() => storage.read(hash), (error: unknown) => error instanceof Error && !/signed-url|ConnectionTimeout/.test(error.message));
});

for (const format of ["png", "jpeg", "webp"] as const) {
  test(`upload preparation passes decoded ${format} MIME to both original and public OSS objects`, async () => {
    const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "red" } })
      .withExif({ IFD0: { Artist: "private marker" } }).toFormat(format).toBuffer();
    const token = "synthetic-upload-token";
    const mime: ImageMime = `image/${format}`;
    const intent = {
      tokenHash: createHash("sha256").update(token).digest("hex"),
      uploadedByRealm: "user", uploadedByUserId: "synthetic-owner", uploadedByAdminId: null,
      declaredMime: mime, declaredSize: String(bytes.length),
      expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
    };
    const pool = { query: async () => ({ rows: [intent] }) } as unknown as Pool;
    const state: FakeOssState = { objects: new Map(), puts: 0, heads: 0 };
    const storage = createOssMediaStorage(OSS_OPTIONS, OSS_CREDENTIALS, { createClient: () => fakeOssClient(state) });
    const prepared = await prepareMediaUpload(pool, storage, { realm: "user", userId: "synthetic-owner" }, "intent", token, bytes);
    assert.equal(state.puts, 2);
    for (const key of [prepared.contentHash, prepared.publicHash]) {
      assert.equal(state.mimes?.get(ossObjectKey(OSS_OPTIONS.objectPrefix, key)), mime);
      assert.equal((await sharp(await storage.read(key)).metadata()).format, format);
    }
    await prepareMediaUpload(pool, storage, { realm: "user", userId: "synthetic-owner" }, "intent", token, bytes);
    assert.equal(state.puts, 2, "same content still reuses existing objects");
    intent.declaredMime = format === "png" ? "image/jpeg" : "image/png";
    await assert.rejects(() => prepareMediaUpload(pool, storage, { realm: "user", userId: "synthetic-owner" }, "intent", token, bytes), /declared image type/);
    assert.equal(state.puts, 2, "unverified MIME cannot reach OSS");
  });
}

test("oss rejects missing or unsupported MIME before any network call", async () => {
  const state: FakeOssState = { objects: new Map(), puts: 0, heads: 0 };
  const storage = createOssMediaStorage(OSS_OPTIONS, OSS_CREDENTIALS, { createClient: () => fakeOssClient(state) });
  for (const mime of [undefined, "text/html", "image/svg+xml", "image/png\r\nx-test: bad"]) {
    await assert.rejects(() => storage.write(Buffer.from("x"), "a".repeat(64), mime as ImageMime), /image MIME is invalid/);
  }
  assert.equal(state.heads, 0);
  assert.equal(state.puts, 0);
});

test("oss configuration validates target, prefix and credential gaps by name only", () => {
  const fullEnv = {
    OSS_BUCKET: "zzsh-dev",
    OSS_REGION: "oss-cn-shenzhen",
    OSS_ENDPOINT: "https://oss-cn-shenzhen.aliyuncs.com",
    OSS_OBJECT_PREFIX: "zzsh-rebuild/dev/",
  };
  assert.deepEqual(loadOssMediaStorageOptions(fullEnv), { bucket: "zzsh-dev", region: "oss-cn-shenzhen", endpoint: "https://oss-cn-shenzhen.aliyuncs.com", objectPrefix: "zzsh-rebuild/dev/" });
  assert.throws(() => loadOssMediaStorageOptions({ ...fullEnv, OSS_BUCKET: undefined }), /OSS_BUCKET/);
  for (const endpoint of ["http://oss-cn-shenzhen.aliyuncs.com", "https://evil.example.com", "https://oss-cn-shenzhen.aliyuncs.com/path", "not-a-url"]) {
    assert.throws(() => loadOssMediaStorageOptions({ ...fullEnv, OSS_ENDPOINT: endpoint }), ConfigurationError, endpoint);
  }
  for (const prefix of ["zzsh-rebuild/dev", "/zzsh-rebuild/dev/", "zzsh-rebuild/../dev/", ""]) {
    assert.throws(() => loadOssMediaStorageOptions({ ...fullEnv, OSS_OBJECT_PREFIX: prefix }), ConfigurationError, prefix);
  }
  assert.deepEqual(loadOssCredentials({ ALIBABA_CLOUD_ACCESS_KEY_ID: "id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret", ALIBABA_CLOUD_SECURITY_TOKEN: "token" }), { accessKeyId: "id", accessKeySecret: "secret", stsToken: "token" });
  assert.throws(() => loadOssCredentials({}), /ALIBABA_CLOUD_ACCESS_KEY_ID, ALIBABA_CLOUD_ACCESS_KEY_SECRET/);
});

test("media storage selection is explicit, defaults to local and never reads cloud credentials for local", () => {
  const directory = "/tmp/zzsh-media-selection";
  assert.equal(resolveMediaStorage({}, directory).kind, "local");
  assert.equal(resolveMediaStorage({ MEDIA_STORAGE: "local" }, directory).kind, "local");
  assert.equal(resolveMediaStorage({ MEDIA_STORAGE: "oss", ...fullOssEnv(), ...fullCredentialEnv() }, directory).kind, "oss");
  assert.throws(() => resolveMediaStorage({ MEDIA_STORAGE: "cloud" }, directory), /MEDIA_STORAGE must be local or oss/);
  assert.throws(() => resolveMediaStorage({ MEDIA_STORAGE: "oss", ...fullOssEnv() }, directory), /ALIBABA_CLOUD_ACCESS_KEY_ID/);
  function fullOssEnv() {
    return { OSS_BUCKET: "zzsh-dev", OSS_REGION: "oss-cn-shenzhen", OSS_ENDPOINT: "https://oss-cn-shenzhen.aliyuncs.com", OSS_OBJECT_PREFIX: "zzsh-rebuild/dev/" };
  }
  function fullCredentialEnv() {
    return { ALIBABA_CLOUD_ACCESS_KEY_ID: "id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret" };
  }
});

const OSS_TEST_INTENT_ID = "upload_" + "1".repeat(32);
const OSS_TEST_ORIGIN = "https://images.example.com";
const ossDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("OSS form scope binds one key, exact declared length, MIME and expiration using SDK V4 signing", async () => {
  const date = new Date("2026-11-12T23:59:00Z"), expiresAt = "2026-11-13T00:09:00.000Z";
  const env = { MEDIA_STORAGE: "oss", OSS_BUCKET: OSS_OPTIONS.bucket, OSS_REGION: OSS_OPTIONS.region,
    OSS_ENDPOINT: OSS_OPTIONS.endpoint, OSS_OBJECT_PREFIX: OSS_OPTIONS.objectPrefix, ALIBABA_CLOUD_ACCESS_KEY_ID: OSS_CREDENTIALS.accessKeyId,
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: OSS_CREDENTIALS.accessKeySecret, ALIBABA_CLOUD_SECURITY_TOKEN: "synthetic-sts" };
  assert.equal(resolveMediaStorage(env, ".").accountMedia, undefined);
  assert.throws(() => resolveMediaStorage({ ...env, OSS_ACCOUNT_MEDIA_DIRECT: "1" }, "."), /BROWSER_ORIGIN/);
  assert.throws(() => resolveMediaStorage({ ...env, MEDIA_STORAGE: "local", OSS_ACCOUNT_MEDIA_DIRECT: "1", OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN: OSS_TEST_ORIGIN }, "."), /requires MEDIA_STORAGE=oss/);
  const sdk = new OSS({ ...OSS_OPTIONS, ...OSS_CREDENTIALS, authorizationV4: true });
  const direct = createOssAccountMedia(OSS_OPTIONS, { ...OSS_CREDENTIALS, stsToken: "synthetic-sts" }, OSS_TEST_ORIGIN, sdk, async () => "https://other.example.com", () => date);
  const signed = direct.createUpload(OSS_TEST_INTENT_ID, expiresAt, "image/png", 128);
  assert.equal(signed.method, "POST");
  assert.equal(signed.url, OSS_TEST_ORIGIN);
  const policy = JSON.parse(Buffer.from(signed.fields.policy!, "base64").toString("utf8"));
  assert.equal(policy.expiration, expiresAt);
  assert.deepEqual(policy.conditions, [
    { bucket: OSS_OPTIONS.bucket }, ["content-length-range", 128, 128], { key: `${OSS_OPTIONS.objectPrefix}private/account-upload/${OSS_TEST_INTENT_ID}` },
    { "x-oss-signature-version": "OSS4-HMAC-SHA256" }, { "x-oss-credential": `${OSS_CREDENTIALS.accessKeyId}/20261112/cn-shenzhen/oss/aliyun_v4_request` },
    { "x-oss-date": "20261112T235900Z" }, { "x-oss-content-type": "image/png" }, { "x-oss-object-acl": "private" }, { "x-oss-forbid-overwrite": "true" },
    { success_action_status: "204" }, { "x-oss-security-token": "synthetic-sts" },
  ]);
  assert.equal(signed.fields["x-oss-signature"], sdk.signPostObjectPolicyV4(policy, date));
  assert.throws(() => direct.createUpload("../bad", expiresAt, "image/png", 128), /invalid/);
  await assert.rejects(() => direct.signOriginal("a".repeat(64)), /operation failed/);
  const accountMedia = resolveMediaStorage({ ...env, OSS_ACCOUNT_MEDIA_DIRECT: "1", OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN: OSS_TEST_ORIGIN }, ".").accountMedia!;
  const signedRead = new URL(await accountMedia.signOriginal("a".repeat(64)));
  assert.equal(signedRead.origin, OSS_TEST_ORIGIN);
  assert.equal(signedRead.pathname, `/${OSS_OPTIONS.objectPrefix}aa/${"a".repeat(64)}`);
  assert.equal(signedRead.searchParams.get("x-oss-expires"), "120");
  assert.equal(signedRead.searchParams.get("response-cache-control"), "private, no-store");
});

test("direct display bytes are authorized, decoded and hashed before OSS processing, and both variants are attached in finalization", async () => {
  const bytes = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "red" } }).withExif({ IFD0: { Artist: "private" } }).png().toBuffer();
  const token = "fixture-upload-token";
  const actor = { realm: "user", userId: "owner" } as const;
  const intent = { tokenHash: ossDigest(Buffer.from(token)), accountId: "account_1", gameId: "game_1", purpose: "ACCOUNT_DISPLAY", ownershipKind: "USER_SUPPLY", ownerUserId: "owner",
    uploadedByRealm: "user", uploadedByUserId: "owner", uploadedByAdminId: null, declaredMime: "image/png", declaredSize: String(bytes.length),
    expiresAt: new Date(Date.now() + 60_000), consumedAt: null, directOss: true };
  const logo = "f".repeat(64), policy = { revision: "3", enabled: true, logoAssetId: "asset_logo", position: "se", sizePercent: 12, opacityPercent: 55, marginPercent: 2 };
  const dbWrites: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[]) => {
    if (sql.includes("FROM \"zzsh_supply\".\"media_upload_intent\"")) return { rows: [intent] };
    if (sql.includes("FROM zzsh_supply.account_image_watermark")) return { rows: [policy] };
    if (sql.includes("SELECT public_storage_key")) return { rows: [{ storageKey: logo }] };
    dbWrites.push({ sql, values }); return { rows: [] };
  };
  const pool = { query } as unknown as Pool;
  const staged = `${OSS_OPTIONS.objectPrefix}private/account-upload/${OSS_TEST_INTENT_ID}`;
  let stagedReads = 0, badCover = false;
  const generated = new Map<string, Buffer>();
  const processes: Array<{ from: string; target: string; process: string }> = [];
  const direct = createOssAccountMedia(OSS_OPTIONS, OSS_CREDENTIALS, OSS_TEST_ORIGIN, {
    signPostObjectPolicyV4: () => "offline-unused",
    async getStream(key) {
      if (key === staged) { stagedReads++; return { stream: Readable.from([bytes]), res: { headers: { "content-type": "image/png" } } }; }
      assert.ok(generated.has(key));
      return { stream: Readable.from([generated.get(key)!]), res: { headers: { "content-type": "image/webp" } } };
    },
    async processObjectSave(from, target, process, bucket) {
      assert.equal(bucket, OSS_OPTIONS.bucket);
      processes.push({ from, target, process });
      const cover = target.endsWith("/640.webp");
      generated.set(target, await sharp({ create: { width: cover && !badCover ? 640 : 1200, height: cover ? 320 : 600, channels: 3, background: "blue" } }).webp().toBuffer());
      return { status: 200 };
    },
  }, async () => "unused");
  const state: FakeOssState = { objects: new Map(), puts: 0, heads: 0 };
  const storage = createOssMediaStorage(OSS_OPTIONS, OSS_CREDENTIALS, { createClient: () => fakeOssClient(state), accountMedia: direct });
  const upload = { contentHash: ossDigest(bytes) };
  await assert.rejects(() => prepareMediaUpload(pool, storage, { ...actor, userId: "other" }, OSS_TEST_INTENT_ID, token, upload), /not found/);
  await assert.rejects(() => prepareMediaUpload(pool, storage, actor, OSS_TEST_INTENT_ID, "wrong", upload), /token is invalid/);
  await assert.rejects(() => prepareMediaUpload(pool, storage, actor, OSS_TEST_INTENT_ID, token, bytes), /transport does not match/);
  assert.equal(stagedReads, 0);
  await assert.rejects(() => prepareMediaUpload(pool, storage, actor, OSS_TEST_INTENT_ID, token, { contentHash: "f".repeat(64) }), /SHA-256 does not match/);
  await assert.rejects(() => direct.readUpload(OSS_TEST_INTENT_ID, bytes.length - 1), /size is invalid/);
  assert.equal(state.puts, 0);
  const prepared = await prepareMediaUpload(pool, storage, actor, OSS_TEST_INTENT_ID, token, upload);
  assert.equal(prepared.contentHash, upload.contentHash);
  assert.deepEqual(await storage.read(prepared.contentHash), bytes);
  assert.equal((await sharp(await storage.read(prepared.publicHash)).metadata()).exif, undefined);
  assert.deepEqual(prepared.variants.map(variant => [variant.maxEdge, variant.width, variant.height]), [[640, 640, 320], [1920, 1200, 600]]);
  for (const operation of processes) {
    assert.equal(operation.from, ossObjectKey(OSS_OPTIONS.objectPrefix, prepared.publicHash));
    assert.match(operation.target, /\/private\/account-variants\//);
    const encodedLogo = /watermark,image_([^,]+)/.exec(operation.process)?.[1];
    assert.equal(Buffer.from(encodedLogo!, "base64url").toString(), `${ossObjectKey(OSS_OPTIONS.objectPrefix, logo)}?x-oss-process=image/resize,P_12`);
    assert.match(operation.process, /t_55,g_se,x_(?:6|12),y_(?:6|12)\/format,webp\/quality,Q_86/);
  }
  const finalized = await finalizeMediaUpload(pool as unknown as Parameters<typeof finalizeMediaUpload>[0], actor, prepared,
    async (_client, accountId) => { assert.equal(accountId, "account_1"); });
  assert.equal(finalized.contentHash, upload.contentHash);
  const variantWrite = dbWrites.find(write => write.sql.includes("account_image_variant"));
  assert.equal(variantWrite?.values[0], finalized.assetId);
  assert.deepEqual(JSON.parse(variantWrite?.values[1] as string), prepared.variants.map(variant => ({ ...variant, sha256: ossDigest(generated.get(OSS_OPTIONS.objectPrefix + variant.objectKey)!) })));
  assert.ok(prepared.variants.every(variant => variant.watermarkRevision === "3"));
  badCover = true;
  await assert.rejects(() => direct.generateVariants(prepared.publicHash, prepared.image, { ...policy, position: "se", logoStorageKey: logo }, () => {}), /variant is unavailable or invalid/);
});
