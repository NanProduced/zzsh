import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import * as filePromises from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import sharp from "sharp";
import { createLocalMediaStorage, decodeImage, MediaStorageError, type MediaStorage } from "../src/supply/media";
import { createOssMediaStorage } from "../src/supply/media-oss";
import { PROFILE_AVATAR_PRESETS, deterministicPresetId, loadPresetBytes, presetContentPath } from "../src/profile/profile-avatar-presets";

type Event = Record<string, unknown>;
const cliPath = resolve("src/profile/profile-avatar-presets-cli.ts");
const cliSource = transpileModule(readFileSync(cliPath, "utf8"), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText.replace("void main().catch", "globalThis.cliDone = main().catch");
const nativeRequire = createRequire(cliPath);

async function cli(mode: string, options: {
  existing?: Iterable<[string, Buffer]>; readError?: Error; writeError?: Error;
  wrongReadback?: boolean; kind?: "local" | "oss"; args?: string[];
} = {}) {
  const store = new Map(options.existing), events: Event[] = [], writes: Array<{ key: string; mime: string }> = [], reads: string[] = [];
  let resolved = 0;
  const storage: MediaStorage = {
    available: true, kind: options.kind ?? "local",
    read: async key => {
      reads.push(key);
      if (options.readError) throw options.readError;
      const value = store.get(key);
      if (value === undefined) throw Object.assign(new MediaStorageError("SYNTHETIC missing"), { code: "MEDIA_OBJECT_NOT_FOUND" });
      return value;
    },
    write: async (bytes, key, mime) => {
      writes.push({ key, mime });
      if (options.writeError) throw options.writeError;
      store.set(key, options.wrongReadback ? Buffer.from("SYNTHETIC conflicting bytes") : Buffer.from(bytes));
      return { storageKey: key };
    },
  };
  const processStub = { argv: ["node", "avatar-presets", mode, ...(options.args ?? [])], env: {}, cwd: () => resolve("."), exitCode: 0 };
  const context: Record<string, unknown> = {
    exports: {}, Buffer, process: processStub,
    console: { log: (row: string) => events.push(JSON.parse(row) as Event), error: (row: string) => events.push(JSON.parse(row) as Event) },
    require: (id: string) => id === "../supply/media" ? { decodeImage, MediaStorageError }
      : id === "../supply/media-oss" ? { resolveMediaStorage: () => { resolved++; return storage; } }
        : id === "./profile-avatar-presets" ? { loadPresetBytes, PROFILE_AVATAR_PRESETS } : nativeRequire(id),
  };
  runInNewContext(cliSource, context);
  await context.cliDone;
  return { events, writes, reads, exitCode: processStub.exitCode, store, resolved };
}

async function storedPresets() {
  return Promise.all(PROFILE_AVATAR_PRESETS.map(async p => [p.contentHash, await loadPresetBytes(p)] as [string, Buffer]));
}

test("avatar presets: missing check, first upload and replay readback use the actual CLI", async () => {
  const missing = await cli("check"); assert.equal(missing.exitCode, 1); assert.equal(missing.writes.length, 0);
  assert.equal(missing.events.filter(x => x.status === "FAILED").length, 4);
  const first = await cli("upload"); assert.equal(first.exitCode, 0); assert.equal(first.writes.length, 4);
  assert(first.writes.every(x => x.mime === "image/webp"));
  const replay = await cli("upload", { existing: first.store }); assert.equal(replay.exitCode, 0); assert.equal(replay.writes.length, 0);
  assert.equal(replay.events.filter(x => x.status === "PRESENT").length, 4);
});

test("avatar presets: byte conflict cannot become a missing object or trigger later writes", async () => {
  const first = PROFILE_AVATAR_PRESETS[0];
  const result = await cli("upload", { existing: [[first.contentHash, Buffer.from("SYNTHETIC conflict")]] });
  assert.equal(result.exitCode, 1); assert.equal(result.writes.length, 0); assert.equal(result.reads.length, 1);
  assert.equal(result.events[0]!.status, "CONFLICT"); assert.equal(result.events.filter(x => x.status === "NOT_ATTEMPTED").length, 3);
});

test("avatar presets: read dependency failure never grants upload admission", async () => {
  const result = await cli("upload", { readError: new MediaStorageError("SYNTHETIC_PRIVATE_CANARY") });
  assert.equal(result.exitCode, 1); assert.equal(result.writes.length, 0); assert.equal(result.reads.length, 1);
  assert(!JSON.stringify(result.events).includes("SYNTHETIC_PRIVATE_CANARY"));
});

test("avatar presets: unknown write keeps the original key and never retries", async () => {
  const result = await cli("upload", { writeError: new Error("SYNTHETIC_PRIVATE_CANARY") });
  assert.equal(result.exitCode, 1); assert.equal(result.writes.length, 1); assert.equal(result.events[0]!.status, "UNKNOWN");
  assert.equal(result.events[0]!.storageKey, PROFILE_AVATAR_PRESETS[0].contentHash);
  assert.equal(result.events.filter(x => x.status === "NOT_ATTEMPTED").length, 3);
  assert(!JSON.stringify(result.events).includes("SYNTHETIC_PRIVATE_CANARY"));
});

test("avatar presets: acknowledged write with conflicting readback is not success", async () => {
  const result = await cli("upload", { wrongReadback: true });
  assert.equal(result.exitCode, 1); assert.equal(result.writes.length, 1); assert.equal(result.events[0]!.status, "CONFLICT");
  assert.equal(result.events[0]!.writeAcknowledged, true);
});

test("avatar presets: source MIME is never represented as observed remote metadata", async () => {
  const result = await cli("check", { kind: "oss", existing: await storedPresets() });
  assert.equal(result.exitCode, 0); assert.equal(result.writes.length, 0);
  assert(result.events.filter(x => x.presetId).every(x => x.storedMetadataVerification === "NOT_OBSERVED"));
  assert.equal(result.events.at(-1)!.result, "OBJECT_BYTES_VERIFIED");
});

test("avatar presets: unsupported arguments stop before storage resolution", async () => {
  const result = await cli("upload", { args: ["SYNTHETIC_UNSUPPORTED"] });
  assert.equal(result.exitCode, 1); assert.equal(result.resolved, 0); assert.equal(result.writes.length, 0);
});

test("avatar presets: four shipped assets match the registry and manifest without EXIF", async () => {
  const manifest = JSON.parse(readFileSync(resolve("assets/profile-avatars/manifest.json"), "utf8"));
  assert.equal(manifest.presets.length, 4);
  assert.equal(PROFILE_AVATAR_PRESETS.length, 4);
  for (const [index, preset] of PROFILE_AVATAR_PRESETS.entries()) {
    const row = manifest.presets[index];
    assert(row);
    assert.equal(row.presetId, preset.presetId);
    assert.equal(row.version, preset.version);
    assert.equal(row.file, preset.assetFile);
    assert.equal(row.mime, preset.mime);
    assert.equal(row.width, preset.width);
    assert.equal(row.height, preset.height);
    assert.equal(row.contentHash, preset.contentHash);
    const bytes = await loadPresetBytes(preset);
    assert.equal(row.byteSize, preset.byteSize);
    assert.equal(bytes.length, preset.byteSize);
    assert.equal(presetContentPath(preset), `/api/v1/profile/avatars/presets/${preset.presetId}/1/content`);
    const metadata = await sharp(bytes).metadata();
    assert.equal(createHash("sha256").update(bytes).digest("hex"), preset.contentHash);
    assert.equal(row.originalSha256, preset.originalSha256); assert.match(row.originalSha256, /^[a-f0-9]{64}$/);
    assert.equal(metadata.format, "webp"); assert.equal(metadata.width, 256); assert.equal(metadata.height, 256);
    assert.equal(metadata.pages ?? 1, 1); assert.equal(metadata.exif, undefined);
  }
});

test("avatar presets: both rollback candidates match the UTF-8 Node default-selection algorithm", () => {
  for (const file of ["dry-run.sql", "backfill.sql"]) {
    const sql = readFileSync(resolve("migrations/candidates/profile-avatars", file), "utf8");
    assert(!sql.includes("md5("));
    assert(sql.includes("get_byte(sha256(convert_to('user:' || u.\"id\", 'UTF8')), 3) % 4"));
    assert(sql.includes("get_byte(sha256(convert_to('admin:' || a.\"id\", 'UTF8')), 3) % 4"));
    const expressions = [...sql.matchAll(/\(ARRAY\[([^\]]+)\]\)\[1 \+ get_byte\(sha256\(convert_to\('(user|admin):' \|\| ([ua])\."id", 'UTF8'\)\), 3\) % 4\]/g)];
    assert.equal(expressions.length, 2);
    assert.deepEqual(expressions.map(x => x[2]), ["user", "admin"]);
    for (const expression of expressions) {
      assert.deepEqual([...expression[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]), PROFILE_AVATAR_PRESETS.map(x => x.presetId));
      assert.equal(expression[3], expression[2] === "user" ? "u" : "a");
    }
    if (file === "backfill.sql") assert.match(sql, /\bROLLBACK;\s*$/);
  }
  for (const realm of ["user", "admin"] as const) for (const id of ["u1", "user_fixture_0001", "uuid-0123", "with:separator", "with.dot", ...Array.from({ length: 101 }, (_, n) => "synthetic_" + n)]) {
    const digest = createHash("sha256").update(realm + ":" + id, "utf8").digest();
    assert.equal(digest[3]! % 4, digest.readUInt32BE(0) % 4);
    assert.equal(PROFILE_AVATAR_PRESETS[digest[3]! % 4]!.presetId, deterministicPresetId(realm, id));
  }
});

test("avatar presets: local adapter reports a real missing file as NOT_FOUND", async () => {
  const folder = resolve(tmpdir(), "zzsh-avatar-missing-" + randomUUID());
  assert(!existsSync(folder));
  await assert.rejects(createLocalMediaStorage(folder).read("a".repeat(64)), (error: unknown) => error instanceof MediaStorageError && error.code === "MEDIA_OBJECT_NOT_FOUND");
  assert(!existsSync(folder));
});

test("avatar presets: local read permission failure remains unavailable", async () => {
  const sourcePath = resolve("src/supply/media.ts"), native = createRequire(resolve("dist/src/supply/media.js")), exports: Record<string, any> = {};
  const source = transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  runInNewContext(source, { exports, Buffer, process: { env: {} }, console, require: (id: string) => id === "node:fs/promises"
    ? { ...filePromises, readFile: async () => { throw Object.assign(new Error("SYNTHETIC permission fault"), { code: "EACCES" }); } } : native(id) });
  await assert.rejects(exports.createLocalMediaStorage(resolve(tmpdir(), "zzsh-avatar-never-written")).read("a".repeat(64)),
    (error: any) => error instanceof exports.MediaStorageError && error.code === "MEDIA_STORAGE_UNAVAILABLE");
});

for (const [name, failure, expected] of [
  ["missing key", { code: "NoSuchKey", status: 404 }, "MEDIA_OBJECT_NOT_FOUND"],
  ["missing bucket", { code: "NoSuchBucket", status: 404 }, "MEDIA_STORAGE_UNAVAILABLE"],
  ["denied", { code: "AccessDenied", status: 403 }, "MEDIA_STORAGE_UNAVAILABLE"],
] as const) {
  test(`avatar presets: OSS adapter distinguishes ${name} without real cloud access`, async () => {
    const client = { get: async () => { throw failure; }, head: async () => { throw new Error("HEAD_NOT_USED"); }, put: async () => { throw new Error("PUT_NOT_USED"); } };
    const storage = createOssMediaStorage({ bucket: "synthetic-bucket", region: "oss-cn-shenzhen", endpoint: "https://oss-cn-shenzhen.aliyuncs.com", objectPrefix: "synthetic-avatar/" },
      { accessKeyId: "SYNTHETIC_TEST_ONLY", accessKeySecret: "SYNTHETIC_TEST_ONLY" }, { createClient: () => client });
    await assert.rejects(storage.read("a".repeat(64)), (error: unknown) => error instanceof MediaStorageError && error.code === expected);
  });
}


test("avatar presets: new user-avatar SQL tuples require an explicit uploader", () => {
  const sql = readFileSync(resolve("migrations/business/0124_profile_avatars.sql"), "utf8");
  const tuples = [...sql.matchAll(/OR \("uploaded_by_realm" = 'user' AND "ownership_kind" = 'USER_AVATAR'[\s\S]*?\)/g)].map(x => x[0]);
  assert.equal(tuples.length, 2);
  assert(tuples.every(x => x.includes('"uploaded_by_user_id" IS NOT NULL')));
});
