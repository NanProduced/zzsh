import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import sharp from "sharp";

import { createAccountImageCdn, loadAccountImageCdnTarget, type AccountImageDelivery } from "../src/supply/account-image-cdn";
import { projectPublicListingImages } from "../src/supply/legacy-path-projection";
import { runAccountImageCdnBatch } from "../src/supply/account-image-cdn-worker";
import type { AccountMediaVariant } from "../src/supply/account-media-oss";
import { createUnavailableMediaStorage } from "../src/supply/media";
import { unknownSupplyGate } from "../src/supply/publishing";
import { createLegacyImageCdn, parseLegacyImageCdnManifest, type LegacyImageCdn, type LegacyImageCdnDelivery, type LegacyImageProof } from "../src/supply/legacy-image-cdn";
import { synchronizeLegacyImages } from "../src/supply/legacy-image-cdn-worker";

const options = { bucket: "cdn-test-bucket", objectPrefix: "isolated/", region: "oss-cn-shenzhen", endpoint: "https://oss-cn-shenzhen.aliyuncs.com" };
const origin = "https://cdn.example.com";
const published = { id: `cdn_${"a".repeat(32)}`, accountId: "account_fixture", assetId: "asset_fixture" };
const sample = Buffer.from("sample verified bytes");
const variants: AccountMediaVariant[] = ([640, 1920] as const).map(maxEdge => ({ maxEdge, objectKey: `private/account-variants/${"b".repeat(32)}/${maxEdge}.webp`,
  sha256: createHash("sha256").update(sample).digest("hex"), byteSize: sample.length, width: 320, height: 180, watermarkRevision: "1" }));

test("account CDN only uses the fixed public listing prefix, verifies byte integrity, and deletes before refresh", async () => {
  assert.equal(loadAccountImageCdnTarget({ OSS_ACCOUNT_IMAGE_CDN_ORIGIN: origin }), undefined);
  assert.throws(() => loadAccountImageCdnTarget({ OSS_ACCOUNT_IMAGE_CDN_MODE: "serve", OSS_ACCOUNT_IMAGE_CDN_ORIGIN: "https://cdn.example.com/path" }), /CDN_ORIGIN/);
  const activity: string[] = [];
  let corrupt = false, unavailable = false;
  const cdn = createAccountImageCdn({ mode: "serve", origin }, options, {
    async copy(target, from, bucket, request) {
      activity.push(`copy:${target}`);
      assert.equal(bucket, options.bucket);
      assert.equal(from, options.objectPrefix + variants[0]!.objectKey);
      assert.equal(request.headers["content-type"], "image/webp");
      assert.match(request.headers["cache-control"]!, /max-age=0, s-maxage=300/);
    },
    async getStream(key) {
      activity.push(`verify:${key}`);
      return { stream: Readable.from([corrupt ? Buffer.alloc(sample.length) : sample]), res: { headers: { "content-type": "image/webp" } } };
    },
    async delete(key) {
      activity.push(`delete:${key}`);
      if (unavailable && key.endsWith("/1920.webp")) throw new Error("must not leak SDK detail");
      return { res: {} };
    },
  }, async urls => {
    assert.deepEqual(urls, [cdn.url(published, 640), cdn.url(published, 1920)]);
    activity.push("refresh");
    return "247";
  });
  const prefix = `isolated/public/listing/account_fixture/asset_fixture/${published.id}`;
  assert.equal(cdn.url(published, 640), `${origin}/${prefix}/640.webp`);
  await cdn.publish(published, variants[0]!);
  assert.deepEqual(activity, [`copy:${prefix}/640.webp`, `verify:${prefix}/640.webp`]);
  corrupt = true;
  await assert.rejects(cdn.publish(published, variants[0]!), /could not be published and verified/);
  const before = activity.length;
  await assert.rejects(cdn.publish(published, { ...variants[0]!, objectKey: "private/account-upload/secret" }), /variant is invalid/);
  assert.equal(activity.length, before);
  unavailable = true;
  await assert.rejects(cdn.revoke(published), /could not be removed/);
  assert.equal(activity.includes("refresh"), false);
  unavailable = false;
  assert.equal(await cdn.revoke(published), "247");
  assert.deepEqual(activity.slice(-3), [`delete:${prefix}/640.webp`, `delete:${prefix}/1920.webp`, "refresh"]);
});

test("the worker keeps partial publication undisclosed, retires the attempt, and never reuses its URL", async () => {
  type Row = AccountImageDelivery & { state: "PUBLISHING" | "READY" | "REVOKING" | "REVOKED"; removable: boolean };
  const deliveryRows: Row[] = [];
  const events: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    release() {},
    async query(sql: string, args: unknown[]) {
      let rows: unknown[] = [];
      let rowCount = 0;
      if (sql.includes("pg_try_advisory_lock")) rows = [{ acquired: true }];
      else if (sql.includes("pg_advisory_unlock")) rows = [{ unlocked: true }];
      else if (sql.startsWith("SELECT q.account_id")) rows = [{ accountId: published.accountId, revision: "2" }];
      else if (sql.startsWith("SELECT id, account_id") && sql.includes("state='READY'")) rows = deliveryRows.filter(row => row.state === "READY");
      else if (sql.startsWith("SELECT id, account_id")) rows = deliveryRows.filter(row => row.state !== "REVOKED").map(row => ({ ...row }));
      else if (sql.startsWith("SELECT max_edge")) rows = variants;
      else if (sql.startsWith("INSERT INTO zzsh_supply.account_image_cdn_delivery")) {
        deliveryRows.push({ id: String(args[0]), accountId: String(args[1]), assetId: String(args[2]), state: "PUBLISHING", removable: false });
        rowCount = 1;
      } else if (sql.startsWith("WITH q AS MATERIALIZED")) {
        const row = deliveryRows.find(row => row.id === args[0] && row.state === "PUBLISHING");
        if (row) { row.state = "READY"; row.removable = true; rowCount = 1; }
      } else if (sql.includes("state='REVOKED', purge_task_id")) {
        deliveryRows.find(row => row.id === args[0])!.state = "REVOKED";
        events.push(`record:${args[1]}`);
      } else if (sql.includes("WHERE id=$1 AND state='PUBLISHING'")) {
        deliveryRows.find(row => row.id === args[0])!.state = "REVOKING";
      } else if (sql.includes("WHERE account_id=$1 AND (state='PUBLISHING'")) {
        for (const row of deliveryRows) if (row.state === "PUBLISHING" || row.state === "READY" && !(args[1] as string[]).includes(row.assetId)) row.state = "REVOKING";
      } else if (!sql.startsWith("UPDATE zzsh_supply.account_image_cdn_queue SET due_at")) throw new Error("Unexpected test query");
      return { rows, rowCount: rowCount || rows.length };
    },
  });
  let fail = true, loseEligibility = false, desired = [published.assetId];
  const cdn = {
    mode: "serve" as const,
    url: (row: AccountImageDelivery, edge: number) => `${origin}/${row.id}/${edge}.webp`,
    async publish(row: AccountImageDelivery, variant: AccountMediaVariant) {
      assert.equal(deliveryRows.find(attempt => attempt.id === row.id)?.state, "PUBLISHING");
      events.push(`publish:${variant.maxEdge}`);
      if (fail && variant.maxEdge === 1920) throw new Error("expected copy failure");
      if (loseEligibility) desired = [];
    },
    async revoke(row: AccountImageDelivery) { events.push(`revoke:${row.id}`); return "246"; },
  };
  const batch = () => runAccountImageCdnBatch({ pool: { connect: async () => client } as unknown as Pool, storage: createUnavailableMediaStorage(), cdn, gate: unknownSupplyGate }, () => false, async () => desired);
  const oldUrl = "/api/v1/supply/listings/account_fixture/media/asset_fixture";
  const listing = { id: published.accountId, versionId: "version_fixture", media: [{ assetId: published.assetId, url: oldUrl }] };
  const project = async () => (await projectPublicListingImages(client as unknown as PoolClient, [listing], cdn))[0]!;
  await batch();
  assert.equal(deliveryRows[0]?.state, "REVOKING");
  assert.deepEqual((await project()).media, listing.media);
  await batch();
  assert.deepEqual(events, ["publish:640", "publish:1920"]);
  fail = false; deliveryRows[0]!.removable = true;
  await batch();
  assert.equal(deliveryRows[0]?.state, "REVOKED");
  assert.equal(deliveryRows[1]?.state, "READY");
  assert.notEqual(deliveryRows[0]?.id, deliveryRows[1]?.id);
  assert.deepEqual((await project()).media, [{ assetId: published.assetId, url: oldUrl, coverUrl: cdn.url(deliveryRows[1]!, 640), detailUrl: cdn.url(deliveryRows[1]!, 1920) }]);
  desired = [];
  await batch();
  assert.equal(deliveryRows[1]?.state, "REVOKED");
  assert.deepEqual((await project()).media, listing.media);
  desired = [published.assetId]; loseEligibility = true;
  await batch();
  assert.equal(deliveryRows[2]?.state, "REVOKING");
  assert.deepEqual((await project()).media, listing.media);
});

test("legacy CDN verifies the sealed approved byte proof, retains the source path, and distinguishes missing from outage", async () => {
  const png = await sharp({ create: { width: 48, height: 24, channels: 3, background: "red" } }).png().toBuffer();
  const path = "accountsImage/20261112/showcase.png";
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const entry = { path, sha256: digest(png), mime: "image/png", byteSize: png.length };
  const manifest = Buffer.from(JSON.stringify({ schema: "zzsh.legacy-image-cdn.v1", images: [entry] }));
  assert.throws(() => parseLegacyImageCdnManifest(manifest, "0".repeat(64)), /SHA-256/);
  const proofs = parseLegacyImageCdnManifest(manifest, digest(manifest));
  const proof = proofs.get(path)!;
  assert.deepEqual(proof, entry);
  let outage = false;
  const sourceKey = `isolated/legacy/${path}`;
  const events: string[] = [];
  const objects = new Map<string, Buffer>();
  const legacy = createLegacyImageCdn({ mode: "serve", origin }, options, {
    async getStream(key) {
      if (outage) throw Object.assign(new Error("backend unavailable"), { status: 503 });
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error("missing"), { code: "NoSuchKey", status: 404 });
      return { stream: Readable.from([bytes]), res: { headers: { "content-type": "image/png" } } };
    },
    async copy(target, source, bucket) {
      assert.equal(bucket, options.bucket);
      assert.equal(source, sourceKey);
      events.push(`copy:${target}`);
      objects.set(target, objects.get(source)!);
    },
    async delete(key) { events.push(`delete:${key}`); objects.delete(key); return { res: {} }; },
  }, async urls => { events.push(`refresh:${urls[0]}`); return "257"; }, proofs);
  assert.equal(await legacy.inspectSource(proof), "PENDING_IMPORT");
  outage = true;
  assert.equal(await legacy.inspectSource(proof), "UNAVAILABLE");
  outage = false;
  objects.set(sourceKey, Buffer.alloc(png.length));
  assert.equal(await legacy.inspectSource(proof), "UNAVAILABLE");
  objects.set(sourceKey, png);
  assert.equal(await legacy.inspectSource(proof), "READY");
  const delivery = { id: published.id, accountId: published.accountId, versionId: "observation_1", position: 0, sourcePath: path };
  await assert.rejects(legacy.publish({ ...delivery, sourcePath: "accountsImage/20261112/penalty.png" }, proof), /unapproved/);
  const distributed = `isolated/public/legacy/${delivery.id}/${path}`;
  await legacy.publish(delivery, proof);
  assert.equal(legacy.url(delivery), `${origin}/${distributed}`);
  await legacy.revoke(delivery);
  assert.deepEqual(events, [`copy:${distributed}`, `delete:${distributed}`, `refresh:${origin}/${distributed}`]);
  assert.equal(objects.get(sourceKey), png);
  assert.notEqual(legacy.url(delivery), legacy.url({ ...delivery, id: `cdn_${"b".repeat(32)}` }));

  const listing = { id: delivery.accountId, versionId: delivery.versionId, media: [{ assetId: "media_fixture", url: "/native-url" }], legacyImages: [{ position: 0, url: "/authorized-old-url" }, { position: 1, url: "/other-authorized-url" }] };
  const db = { query: async (sql: string) => ({ rows: sql.includes("account_image_cdn_delivery") ? [
    { id: "delivery_native", accountId: listing.id, assetId: "media_fixture" },
  ] : [
    { ...delivery, ...proof, state: "PENDING_IMPORT" },
    { ...delivery, ...proof, state: "READY", position: 1, versionId: "other_version" },
    { ...delivery, ...proof, state: "READY", position: 2 },
  ] }) } as unknown as PoolClient;
  const projection = await projectPublicListingImages(db, [listing], { mode: "serve", legacy, url: (item, edge) => `${origin}/${item.id}/${edge}.webp`, async publish() {}, async revoke() { return ""; } });
  assert.deepEqual(projection[0]?.media, [{ ...listing.media[0], coverUrl: `${origin}/delivery_native/640.webp`, detailUrl: `${origin}/delivery_native/1920.webp` }]);
  assert.deepEqual(projection[0]?.legacyImages, [{ ...listing.legacyImages[0], state: "PENDING_IMPORT" }, listing.legacyImages[1]]);
});

test("a confirmed missing legacy object remains private until a subsequent verified import and loses its URL on revocation", async () => {
  const proof: LegacyImageProof = { path: "accountsImage/20261112/showcase.png", sha256: "a".repeat(64), byteSize: 128, mime: "image/png" };
  const slot = { versionId: "observation_1", position: 0, proof };
  type Row = LegacyImageCdnDelivery & LegacyImageProof & { state: string; removable: boolean };
  const rows: Row[] = [];
  let source: "PENDING_IMPORT" | "READY" = "PENDING_IMPORT";
  let eligible = true;
  const events: string[] = [];
  const cdn: LegacyImageCdn = {
    enabled: true, proof: () => proof, inspectSource: async () => source, url: row => `${origin}/${row.id}`,
    async publish(row) { events.push(`publish:${row.id}`); assert.equal(rows.find(item => item.id === row.id)?.state, "PUBLISHING"); },
    async revoke(row) { events.push(`revoke:${row.id}`); return "fixture"; },
  };
  const client = { async query(sql: string, args: unknown[]) {
    if (sql.startsWith("SELECT id, account_id")) return { rows: rows.filter(row => row.state !== "REVOKED").map(row => ({ ...row })) };
    if (sql.startsWith("INSERT INTO zzsh_supply.legacy_image_cdn_delivery")) {
      rows.push({ ...proof, id: String(args[0]), accountId: String(args[1]), versionId: String(args[3]), position: Number(args[4]), sourcePath: String(args[5]), state: String(args[9]), removable: false });
      return { rowCount: 1 };
    }
    const row = rows.find(item => item.id === args[0])!;
    assert.ok(row, sql);
    if (sql.startsWith("WITH q AS MATERIALIZED")) { row.state = "READY"; row.removable = true; }
    else if (sql.includes("SET state='REVOKED'")) row.state = "REVOKED";
    else if (sql.includes("SET state='REVOKING'")) row.state = "REVOKING";
    else if (sql.includes("SET state=$2")) row.state = String(args[1]);
    else throw new Error("Unexpected legacy test query");
    return { rowCount: 1 };
  } } as unknown as PoolClient;
  const sync = () => synchronizeLegacyImages(client, { accountId: published.accountId, revision: "3" }, cdn, { gate: unknownSupplyGate }, () => false, async () => eligible ? [slot] : []);
  await sync();
  await sync();
  assert.deepEqual(rows.map(row => row.state), ["PENDING_IMPORT"]);
  assert.deepEqual(events, []);
  source = "READY";
  await sync();
  assert.deepEqual(rows.map(row => row.state), ["REVOKED", "READY"]);
  const publicVersion = rows[1]!.id;
  eligible = false;
  await sync();
  assert.equal(rows[1]?.state, "REVOKED");
  assert.deepEqual(events, [`publish:${publicVersion}`, `revoke:${publicVersion}`]);
  eligible = true;
  await sync();
  assert.equal(rows[2]?.state, "READY");
  assert.notEqual(rows[2]?.id, publicVersion);
});
