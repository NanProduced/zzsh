import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";

import { attachAccountImageCdn, createAccountImageCdn, loadAccountImageCdnTarget, type AccountImageDelivery } from "../src/supply/account-image-cdn";
import { runAccountImageCdnBatch } from "../src/supply/account-image-cdn-worker";
import type { AccountMediaVariant } from "../src/supply/account-media-oss";
import { createUnavailableMediaStorage } from "../src/supply/media";
import { unknownSupplyGate } from "../src/supply/publishing";

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
  const listing: Record<string, unknown> = { id: published.accountId, media: [{ assetId: published.assetId, url: oldUrl }] };
  const project = async () => (await attachAccountImageCdn(client as unknown as PoolClient, [listing], cdn))[0]!;
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
