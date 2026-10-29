import sharp from "sharp";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { Pool } from "pg";

import {
  assertImageWithinBounds,
  createLocalMediaStorage,
  createUnavailableMediaStorage,
  inspectImage,
  decodeImage,
  MediaValidationError,
  prepareMediaUpload,
  type ImageMime,
} from "../src/supply/media";
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
