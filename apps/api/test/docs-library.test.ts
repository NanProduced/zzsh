// Offline P1a internal documentation library checks: public/private OSS prefix
// gates, docs image feature configuration, the relay storage adapter, server-side
// permission gating and the save merge / revision-conflict decision. Real schema
// constraints, triggers and the trash lifecycle live in the docs PostgreSQL suite.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION } from "../src/auth/admin-authorization";
import { SecurityApiError } from "../src/auth/security-core";
import { API_V1_ERROR_CODES } from "../src/contracts/api-v1";
import {
  assertPublicOssObjectKey,
  assertPublicObjectPrefix,
  INTERNAL_DOCS_OSS_PREFIX,
  ossObjectKey,
} from "../src/supply/media-oss";
import {
  createDocsImageStorage,
  docsImageExtension,
  docsImageObjectKey,
  loadDocsImageFeature,
  type DocsImageObjectClient,
} from "../src/docs/docs-images";
import { authorizeDocs, saveContent, newDocId } from "../src/docs/docs-store";
import type { WriteActor } from "../src/supply/supply-routes";

const ACTOR: WriteActor = { realm: "admin", id: "admin_1", sessionId: "session_1" };

test("public OSS paths reject the internal-docs prefix", () => {
  assert.equal(INTERNAL_DOCS_OSS_PREFIX, "internal-docs/");
  assert.throws(() => assertPublicOssObjectKey("internal-docs/doc_x/dimg_y.png"), /internal-docs/);
  assert.doesNotThrow(() => assertPublicOssObjectKey("zzsh-rebuild/dev/ab/abcdef"));
  assert.throws(() => assertPublicObjectPrefix("internal-docs/"), /overlap/);
  assert.throws(() => assertPublicObjectPrefix("internal-docs/sub/"), /overlap/);
  assert.doesNotThrow(() => assertPublicObjectPrefix("zzsh-rebuild/dev/"));
  // ossObjectKey guards the computed key even if a caller passes a private prefix.
  assert.throws(() => ossObjectKey("internal-docs/", "a".repeat(64)), /internal-docs/);
  assert.equal(ossObjectKey("public/", "ab" + "c".repeat(62)), "public/ab/ab" + "c".repeat(62));
});

test("docs image object keys stay inside internal-docs/ and map MIME to extension", () => {
  const nodeId = newDocId("doc");
  const imageId = newDocId("dimg");
  assert.equal(docsImageExtension("image/png"), "png");
  assert.equal(docsImageExtension("image/jpeg"), "jpg");
  assert.equal(docsImageExtension("image/webp"), "webp");
  const key = docsImageObjectKey(nodeId, imageId, "image/jpeg");
  assert.equal(key, `internal-docs/${nodeId}/${imageId}.jpg`);
  assert.match(key, /^internal-docs\/doc_[0-9a-f]{32}\/dimg_[0-9a-f]{32}\.jpg$/);
});

function fakeOssClient(overrides: Partial<DocsImageObjectClient> = {}): DocsImageObjectClient & { puts: { key: string; options: { mime: string; headers: Record<string, string> } }[] } {
  const puts: { key: string; options: { mime: string; headers: Record<string, string> } }[] = [];
  return {
    puts,
    head: async () => ({ status: 200 }),
    put: async (key, _bytes, options) => { puts.push({ key, options: options as { mime: string; headers: Record<string, string> } }); return { name: key }; },
    get: async () => ({ content: Buffer.from("image-bytes") }),
    delete: async () => ({ res: {} }),
    ...overrides,
  };
}

test("docs relay storage forces a private ACL and rejects out-of-prefix keys", async () => {
  const client = fakeOssClient();
  const storage = createDocsImageStorage(client);
  const key = docsImageObjectKey(newDocId("doc"), newDocId("dimg"), "image/png");
  await storage.writeObject(key, Buffer.from("x"), "image/png");
  assert.equal(client.puts.length, 1);
  assert.equal(client.puts[0]!.options.headers["x-oss-object-acl"], "private");
  await assert.rejects(() => storage.writeObject("public/ab/cd", Buffer.from("x"), "image/png"), /internal-docs/);
  await assert.rejects(() => storage.readObject("internal-docs/../escape"), /internal-docs/);
  assert.deepEqual(await storage.readObject(key), Buffer.from("image-bytes"));
  assert.equal(await storage.headObject(key), true);
  await storage.deleteObject(key);
});

test("docs relay storage treats a missing object as absent, not an error", async () => {
  const missing = Object.assign(new Error("no such key"), { code: "NoSuchKey", status: 404 });
  const storage = createDocsImageStorage(fakeOssClient({ head: async () => { throw missing; }, delete: async () => { throw missing; } }));
  const key = docsImageObjectKey(newDocId("doc"), newDocId("dimg"), "image/webp");
  assert.equal(await storage.headObject(key), false);
  await storage.deleteObject(key); // 404 is success for cleanup
});

test("docs image feature is disabled unless explicitly enabled and configured", () => {
  assert.equal(loadDocsImageFeature({}).enabled, false);
  assert.equal(loadDocsImageFeature({ DOCS_IMAGES_ENABLED: "false" }).enabled, false);
  // Enabled but missing OSS target/credentials -> disabled (documents still work).
  assert.equal(loadDocsImageFeature({ DOCS_IMAGES_ENABLED: "true" }).enabled, false);
  const enabled = loadDocsImageFeature({
    DOCS_IMAGES_ENABLED: "true",
    OSS_BUCKET: "zzsh-dev", OSS_REGION: "oss-cn-shenzhen", OSS_ENDPOINT: "https://oss-cn-shenzhen.aliyuncs.com",
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
  }, { createClient: () => fakeOssClient() });
  assert.equal(enabled.enabled, true);
  if (enabled.enabled) assert.equal(enabled.prefix, "internal-docs/");
  // A non-fixed prefix is a configuration error, not a silent fallback.
  assert.throws(() => loadDocsImageFeature({ DOCS_IMAGES_ENABLED: "true", DOCS_OSS_PREFIX: "other/" }), /internal-docs/);
  // Overlap with the public prefix is refused at startup.
  assert.throws(() => loadDocsImageFeature({
    DOCS_IMAGES_ENABLED: "true", DOCS_OSS_PREFIX: "internal-docs/", OSS_OBJECT_PREFIX: "internal-docs/",
    OSS_BUCKET: "zzsh-dev", OSS_REGION: "oss-cn-shenzhen", OSS_ENDPOINT: "https://oss-cn-shenzhen.aliyuncs.com",
    ALIBABA_CLOUD_ACCESS_KEY_ID: "id", ALIBABA_CLOUD_ACCESS_KEY_SECRET: "secret",
  }), /overlap/);
});

// --- permission gating -----------------------------------------------------
function accessClient(permissions: string[], isBoss = false): PoolClient {
  return {
    query: async (sql: string) => {
      if (sql.includes("admin_security")) return { rows: [{ status: "ACTIVE", isBoss, passwordChangeRequired: false }] };
      if (sql.includes("admin_user_role")) return { rows: permissions.map(permissionCode => ({ permissionCode })) };
      throw new Error("unexpected query in accessClient: " + sql.slice(0, 60));
    },
  } as unknown as PoolClient;
}

test("authorizeDocs maps read/comment/manage to the three server-side codes", async () => {
  const read = accessClient([ADMIN_PERMISSION.docsInternalRead]);
  await authorizeDocs(read, ACTOR, "read");
  await assert.rejects(() => authorizeDocs(read, ACTOR, "comment"), (error: unknown) => error instanceof SecurityApiError && error.status === 403);
  await assert.rejects(() => authorizeDocs(read, ACTOR, "manage"), (error: unknown) => error instanceof SecurityApiError && error.status === 403);
  const comment = accessClient([ADMIN_PERMISSION.docsInternalRead, ADMIN_PERMISSION.docsInternalComment]);
  await authorizeDocs(comment, ACTOR, "comment");
  await assert.rejects(() => authorizeDocs(comment, ACTOR, "manage"), (error: unknown) => error instanceof SecurityApiError && error.status === 403);
  const manage = accessClient([ADMIN_PERMISSION.docsInternalRead, ADMIN_PERMISSION.docsInternalComment, ADMIN_PERMISSION.docsInternalManage]);
  await authorizeDocs(manage, ACTOR, "manage");
  // Boss bypass still requires ACTIVE status.
  await authorizeDocs(accessClient([], true), ACTOR, "manage");
  // A custom role without docs.internal.read is denied even for reads.
  await assert.rejects(() => authorizeDocs(accessClient([ADMIN_PERMISSION.contentRead]), ACTOR, "read"), (error: unknown) => error instanceof SecurityApiError && error.status === 403);
});

// --- save merge / revision conflict ----------------------------------------
type FakeNode = { id: string; revision: string; deletedAt: Date | null; currentVersionId: string | null };
type FakeVersion = { id: string; nodeId: string; seq: number; kind: string; authorAdminId: string; windowStartedAt: Date; document: unknown; digest: string };

function docsClient(options: { permissions: string[]; node: FakeNode | null; latest: FakeVersion | null; readyImages?: string[] }) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const head = sql.trimStart();
      if (sql.includes("admin_security")) return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false }] };
      if (sql.includes("admin_user_role")) return { rows: options.permissions.map(permissionCode => ({ permissionCode })) };
      if (head.startsWith("SELECT") && sql.includes('FROM "zzsh_docs"."doc_node"')) {
        return { rows: options.node && options.node.id === params?.[0] ? [options.node] : [] };
      }
      if (head.startsWith("SELECT") && sql.includes('FROM "zzsh_docs"."doc_image"')) {
        const ids = (params?.[0] as string[]) ?? [];
        return { rows: ids.filter(id => (options.readyImages ?? []).includes(id)).map(id => ({ id })) };
      }
      if (head.startsWith("SELECT") && sql.includes('FROM "zzsh_docs"."doc_version"') && sql.includes("ORDER BY")) {
        return { rows: options.latest ? [options.latest] : [] };
      }
      // P1b reconciliation scans discussions on every save; none registered here.
      if (head.startsWith("SELECT") && sql.includes('FROM "zzsh_docs"."doc_discussion"')) return { rows: [] };
      if (head.startsWith('UPDATE "zzsh_docs"."doc_version"')) return { rows: [] };
      if (head.startsWith('INSERT INTO "zzsh_docs"."doc_version"')) return { rows: [] };
      if (sql.includes("doc_version_image")) return { rows: [] };
      if (head.startsWith('UPDATE "zzsh_docs"."doc_node"') && sql.includes("RETURNING")) {
        return { rows: [{ revision: String(BigInt(options.node!.revision) + 1n) }] };
      }
      throw new Error("unexpected docs query: " + sql.slice(0, 80));
    },
  } as unknown as PoolClient & { calls: { sql: string; params?: unknown[] }[] };
  return client;
}

const VALID_DOC = { format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "p", children: [{ text: "hello" }] }] };
const NODE: FakeNode = { id: "doc_node_1", revision: "5", deletedAt: null, currentVersionId: "docv_old" };
const MANAGE = [ADMIN_PERMISSION.docsInternalRead, ADMIN_PERMISSION.docsInternalManage];

test("saveContent rejects a stale expectedRevision with 409 VERSION_CHANGED and writes nothing", async () => {
  const client = docsClient({ permissions: MANAGE, node: NODE, latest: null });
  await assert.rejects(
    () => saveContent(client, ACTOR, NODE.id, "4", VALID_DOC, new Date()),
    (error: unknown) => error instanceof SecurityApiError && error.status === 409 && error.code === API_V1_ERROR_CODES.VERSION_CHANGED,
  );
  assert.equal(client.calls.some(call => call.sql.startsWith('INSERT INTO "zzsh_docs"."doc_version"') || call.sql.startsWith('UPDATE "zzsh_docs"."doc_version"')), false);
});

test("saveContent rejects an invalid Plate document with 400 before any version write", async () => {
  const client = docsClient({ permissions: MANAGE, node: NODE, latest: null });
  const bad = { format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "script", children: [{ text: "x" }] }] };
  await assert.rejects(
    () => saveContent(client, ACTOR, NODE.id, "5", bad, new Date()),
    (error: unknown) => error instanceof SecurityApiError && error.status === 400,
  );
  assert.equal(client.calls.some(call => call.sql.startsWith('INSERT INTO "zzsh_docs"."doc_version"')), false);
});

test("saveContent merges into the latest EDIT row within the 10-minute same-author window", async () => {
  const now = new Date("2026-11-11T10:10:00Z");
  const latest: FakeVersion = { id: "docv_latest", nodeId: NODE.id, seq: 3, kind: "EDIT", authorAdminId: ACTOR.id, windowStartedAt: new Date("2026-11-11T10:05:00Z"), document: VALID_DOC, digest: "a".repeat(64) };
  const client = docsClient({ permissions: MANAGE, node: NODE, latest });
  const result = await saveContent(client, ACTOR, NODE.id, "5", VALID_DOC, now);
  assert.equal(result.merged, true);
  assert.equal(result.versionId, "docv_latest");
  assert.equal(result.seq, 3);
  assert.equal(result.revision, "6");
  assert.ok(client.calls.some(call => call.sql.startsWith('UPDATE "zzsh_docs"."doc_version"')));
  assert.equal(client.calls.some(call => call.sql.startsWith('INSERT INTO "zzsh_docs"."doc_version"')), false);
});

test("saveContent opens a new EDIT version outside the window, for a different author, or after RESTORE", async () => {
  const now = new Date("2026-11-11T10:10:00Z");
  const base: FakeVersion = { id: "docv_latest", nodeId: NODE.id, seq: 3, kind: "EDIT", authorAdminId: ACTOR.id, windowStartedAt: new Date("2026-11-11T09:59:00Z"), document: VALID_DOC, digest: "a".repeat(64) };
  // 11 minutes elapsed -> new version.
  const expired = docsClient({ permissions: MANAGE, node: NODE, latest: base });
  const r1 = await saveContent(expired, ACTOR, NODE.id, "5", VALID_DOC, now);
  assert.equal(r1.merged, false);
  assert.equal(r1.seq, 4);
  assert.ok(expired.calls.some(call => call.sql.startsWith('INSERT INTO "zzsh_docs"."doc_version"')));
  // Different author -> new version.
  const other = docsClient({ permissions: MANAGE, node: NODE, latest: { ...base, authorAdminId: "admin_2", windowStartedAt: new Date("2026-11-11T10:09:00Z") } });
  const r2 = await saveContent(other, ACTOR, NODE.id, "5", VALID_DOC, now);
  assert.equal(r2.merged, false);
  // Latest is RESTORE -> new EDIT version (rollback then first edit).
  const restored = docsClient({ permissions: MANAGE, node: NODE, latest: { ...base, kind: "RESTORE", windowStartedAt: new Date("2026-11-11T10:09:00Z") } });
  const r3 = await saveContent(restored, ACTOR, NODE.id, "5", VALID_DOC, now);
  assert.equal(r3.merged, false);
});

test("saveContent rejects a document referencing an image that is not READY", async () => {
  const client = docsClient({ permissions: MANAGE, node: NODE, latest: null, readyImages: [] });
  const doc = { format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "img", imageId: "dimg_missing", alt: "x", children: [{ text: "" }] }] };
  await assert.rejects(
    () => saveContent(client, ACTOR, NODE.id, "5", doc, new Date()),
    (error: unknown) => error instanceof SecurityApiError && error.status === 400,
  );
});