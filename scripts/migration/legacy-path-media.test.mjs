import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { isLegacyImagePath, legacyImageHttpResult, legacyImageObjectKey, parseLegacyImagePaths, readLegacyImage, selectLegacyImagePath } from "../../apps/api/src/supply/legacy-path-media.ts";
import { assertNoOverwriteSupport, transferLegacyObject, uploadLegacyManifestBatch } from "./legacy-path-media-upload.mjs";

const first = "accountsImage/20261103/first.png", second = "accountsImage/20261102/second.jpg", prefix = "zzsh-rebuild/dev/media-oss-relocation-1/";
const source = { accountId: "account_1", ownerUserId: "user_1", observationVersionId: "version_1", currentVersionId: "version_1", sourceDigest: "a".repeat(64), currentSourceDigest: "a".repeat(64), displayPaths: [first], penaltyPaths: [second] };
const missing = () => Object.assign(new Error("missing"), { code: "NoSuchKey", status: 404 });

test("source arrays preserve the original path and first order, without accepting arbitrary paths", () => {
  assert.deepEqual(parseLegacyImagePaths(` ${first},,${second},${first} `), [first, second]);
  assert.deepEqual(parseLegacyImagePaths(null), []);
  assert.equal(legacyImageObjectKey(prefix, first), `${prefix}legacy/${first}`);
  for (const value of ["../secret.png", "accountsImage/20261103/../x.png", "https://x.invalid/a.png", "accountsImage/20261103/%2f.png", "AccountsImage/20261103/a.png"]) {
    assert.equal(isLegacyImagePath(value), false); assert.throws(() => parseLegacyImagePaths(value), /LEGACY_IMAGE_PATHS_INVALID/);
  }
});

test("public, owner and scoped admin access stay separate from private penalty paths", () => {
  const pub = { realm: "public", admitted: true, versionId: "version_1" }, owner = { realm: "user", userId: "user_1" }, admin = { realm: "admin", canReview: true, inGameScope: true };
  assert.equal(selectLegacyImagePath(source, "account_1", "display", 0, pub), first);
  assert.equal(selectLegacyImagePath(source, "account_1", "penalty", 0, pub), null);
  assert.equal(selectLegacyImagePath(source, "account_1", "penalty", 0, owner), second);
  assert.equal(selectLegacyImagePath(source, "account_1", "penalty", 0, admin), second);
  assert.equal(selectLegacyImagePath(source, "account_1", "display", 0, { realm: "user", userId: "other" }), null);
  assert.equal(selectLegacyImagePath(source, "account_1", "display", 0, { ...admin, inGameScope: false }), null);
  assert.equal(selectLegacyImagePath({ ...source, currentVersionId: "private_draft" }, "account_1", "display", 0, pub), first);
  assert.equal(selectLegacyImagePath(source, "account_1", "display", 0, { ...pub, versionId: "other_version" }), null);
  assert.equal(selectLegacyImagePath({ ...source, currentSourceDigest: "b".repeat(64) }, "account_1", "display", 0, owner), null);
  assert.equal(selectLegacyImagePath(source, "account_2", "display", 0, owner), null);
});

test("only an authorized NoSuchKey is a migration placeholder; other errors are unavailable", async () => {
  let calls = 0;
  const reader = { head: async () => { calls++; throw missing(); }, get: async () => { calls++; throw missing(); } };
  assert.deepEqual(await readLegacyImage(reader, prefix, source, "account_1", "penalty", 0, { realm: "public", admitted: true, versionId: "version_1" }), { state: "NOT_FOUND" });
  assert.equal(calls, 0);
  assert.deepEqual(await readLegacyImage(reader, prefix, source, "account_1", "display", 0, { realm: "public", admitted: true, versionId: "version_1" }), { state: "MIGRATING" });
  assert.deepEqual(await readLegacyImage(reader, prefix, source, "account_1", "display", 0, { realm: "public", admitted: true, versionId: "version_1" }, true), { state: "MIGRATING" });
  assert.equal(legacyImageHttpResult({ state: "MIGRATING" }).headers["x-zzsh-legacy-missing"], "1");
  assert.equal(legacyImageHttpResult({ state: "NOT_FOUND" }).headers["x-zzsh-legacy-missing"], undefined);
  assert.equal(legacyImageHttpResult({ state: "UNAVAILABLE" }).status, 503);
  reader.get = async () => { throw Object.assign(new Error("bucket"), { code: "NoSuchBucket", status: 404 }); };
  assert.deepEqual(await readLegacyImage(reader, prefix, source, "account_1", "display", 0, { realm: "public", admitted: true, versionId: "version_1" }), { state: "UNAVAILABLE" });
  reader.get = async () => ({ content: Buffer.from("not an image") });
  assert.deepEqual(await readLegacyImage(reader, prefix, source, "account_1", "display", 0, { realm: "public", admitted: true, versionId: "version_1" }), { state: "UNAVAILABLE" });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  reader.get = async () => ({ content: bytes });
  assert.deepEqual(await readLegacyImage(reader, prefix, source, "account_1", "display", 0, { realm: "public", admitted: true, versionId: "version_1" }), { state: "FOUND", bytes, mime: "image/png" });
});

test("transfer skips identical bytes, reports conflicts and never silently overwrites", async () => {
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
  let object = null, puts = 0, options;
  const client = { get: async () => { if (!object) throw missing(); return object; }, put: async (_key, value, opts) => { puts++; options = opts; object = { content: value, res: { headers: { "content-type": opts.mime } } }; return { res: { status: 200, headers: {} } }; }, head: async () => ({ status: 200, res: { headers: { "content-type": "image/png", "content-length": String(bytes.length), etag: `"${createHash("md5").update(bytes).digest("hex")}"` } } }) };
  assert.equal((await transferLegacyObject(client, prefix, first, bytes)).status, "UPLOADED");
  assert.equal(options.headers["x-oss-forbid-overwrite"], "true");
  assert.equal(options.headers["Content-MD5"], createHash("md5").update(bytes).digest("base64"));
  assert.equal((await transferLegacyObject(client, prefix, first, bytes)).status, "SKIPPED_IDENTICAL");
  assert.equal(puts, 1);
  object = { content: Buffer.from("different"), res: { headers: { "content-type": "image/png" } } };
  assert.equal((await transferLegacyObject(client, prefix, first, bytes)).status, "CONFLICT");
  object = { content: bytes, res: { headers: { "content-type": "text/plain" } } };
  assert.equal((await transferLegacyObject(client, prefix, first, bytes)).status, "CONFLICT");
  assert.equal(puts, 1);
});

test("encrypted or unknown ETag falls back to an actual read; unknown PUT is reconciled at the same key", async () => {
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
  let object = null, reads = 0;
  const client = { get: async () => { reads++; if (!object) throw missing(); return object; },
    put: async (_key, value, opts) => { object = { content: value, res: { headers: { "content-type": opts.mime } } }; return { res: { status: 200, headers: {} } }; },
    head: async () => ({ status: 200, res: { headers: { "content-type": "image/png", "content-length": String(bytes.length), etag: '"multipart-2"', "x-oss-server-side-encryption": "AES256" } } }) };
  const result = await transferLegacyObject(client, prefix, first, bytes);
  assert.equal(result.status, "UPLOADED"); assert.equal(result.fullReadback, true); assert.equal(result.etagVerified, false); assert.equal(reads, 2);
  object = null; let puts = 0; const events = [], keys = [];
  client.put = async (key, value, opts) => { puts++; keys.push(key); object = { content: value, res: { headers: { "content-type": opts.mime } } }; throw new Error("timeout after write"); };
  assert.equal((await transferLegacyObject(client, prefix, first, bytes, { onEvent: event => events.push(event.status) })).status, "CONFIRMED_AFTER_PUT_ERROR");
  assert.equal(puts, 1); assert.deepEqual(events, ["PUT_UNKNOWN"]); assert.equal(keys[0], `${prefix}legacy/${first}`);
});

test("versioning and unknown errors fail closed", async () => {
  await assertNoOverwriteSupport({ getBucketVersioning: async () => ({ status: 200 }) }, "bucket");
  await assert.rejects(assertNoOverwriteSupport({ getBucketVersioning: async () => ({ status: 200, versionStatus: "Enabled" }) }, "bucket"), /BUCKET_VERSIONING_NOT_UNVERSIONED/);
  await assert.rejects(assertNoOverwriteSupport({ getBucketVersioning: async () => ({ status: 200, versionStatus: "Suspended" }) }, "bucket"), /BUCKET_VERSIONING_NOT_UNVERSIONED/);
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "black" } }).png().toBuffer();
  assert.equal((await transferLegacyObject({ get: async () => { throw Object.assign(new Error(), { code: "NoSuchBucket", status: 404 }); } }, prefix, first, bytes)).status, "UNKNOWN");
});

test("a sealed batch uses at most four concurrent uploads and logs each result", async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "black" } }).png().toBuffer();
  const records = Array.from({ length: 9 }, (_, i) => ({ sourcePath: `accountsImage/20261103/${i}.png`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mime: "image/png", status: "EXTRACTED" }));
  const objects = new Map(), logs = []; let active = 0, maxActive = 0;
  const client = {
    get: async key => { if (!objects.has(key)) throw missing(); return { content: objects.get(key), res: { headers: { "content-type": "image/png" } } }; },
    put: async (key, value) => { active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 5)); objects.set(key, value); active--; return { res: { status: 200, headers: {} } }; },
    head: async key => ({ status: 200, res: { headers: { "content-type": "image/png", "content-length": String(objects.get(key).length), etag: `"${createHash("md5").update(objects.get(key)).digest("hex")}"` } } }),
  };
  const result = await uploadLegacyManifestBatch({ records, client, prefix, readBytes: async () => bytes, log: entry => logs.push(entry) });
  assert.equal(result.status, "COMPLETE"); assert.equal(result.uploaded, 9); assert.equal(result.headVerified, 9);
  assert.equal(maxActive, 4); assert.equal(logs.filter(entry => entry.status === "UPLOADED").length, 9);
});
