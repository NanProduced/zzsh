import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { attachLegacyPathImages, authorizeLegacyPublicSlot, readNativeLegacyPathReference } from "../src/supply/legacy-path-projection";
import { canonicalize } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import { readLegacyImage, type LegacyMediaRecord } from "../src/supply/legacy-path-media";

test("admitted legacy projection uses account slots without exposing source paths", async () => {
  let sql = "";
  const client = { async query(text: string) { if (text.includes("unnest")) return { rows: [] }; sql = text; return { rows: [{ accountId: "account_1", observationVersionId: "version_1", displayPaths: ["accountsImage/20261103/a.png", "accountsImage/20261103/b.jpg"] }] }; } } as unknown as PoolClient;
  const original = [{ id: "account_1", versionId: "version_1", source: "LEGACY_READ_ONLY", media: [] }];
  const [row] = await attachLegacyPathImages(client, original);
  assert.match(sql, /m\.source_digest=p\.source_digest/);
  assert.match(sql, /m\.version_id=p\.observation_version_id/);
  assert.deepEqual((row as Record<string, unknown>).legacyImages, [
    { position: 0, url: "/api/v1/supply/listings/account_1/legacy-images/0" },
    { position: 1, url: "/api/v1/supply/listings/account_1/legacy-images/1" },
  ]);
  assert.doesNotMatch(JSON.stringify(row), /accountsImage|penaltyPaths/);
  const [wrongVersion] = await attachLegacyPathImages(client, [{ ...original[0], versionId: "other_version" }]);
  assert.equal((wrongVersion as Record<string, unknown>).legacyImages, undefined);
});

test("a path used as any private penalty image is never projected publicly", async () => {
  const client = { async query(text: string) { return text.includes("unnest") ? { rows: [{ path: "accountsImage/20261103/a.png" }] } : { rows: [{ accountId: "account_1", observationVersionId: "version_1", displayPaths: ["accountsImage/20261103/a.png", "accountsImage/20261103/b.jpg"] }] }; } } as unknown as PoolClient;
  const [row] = await attachLegacyPathImages(client, [{ id: "account_1", versionId: "version_1", source: "LEGACY_READ_ONLY", media: [] }]);
  assert.deepEqual((row as Record<string, unknown>).legacyImages, [{ position: 1, url: "/api/v1/supply/listings/account_1/legacy-images/1" }]);
});

test("native or already bound images are not replaced and unsafe source paths stay hidden", async () => {
  let calls = 0;
  const client = { async query() { calls++; return { rows: [{ accountId: "account_1", observationVersionId: "version_1", displayPaths: ["../private.png"] }] }; } } as unknown as PoolClient;
  const protectedRows = [{ id: "native", media: [] }, { id: "existing", source: "LEGACY_READ_ONLY", media: [{ assetId: "a" }] }];
  assert.deepEqual(await attachLegacyPathImages(client, protectedRows), protectedRows); assert.equal(calls, 0);
  const [row] = await attachLegacyPathImages(client, [{ id: "account_1", versionId: "version_1", source: "LEGACY_READ_ONLY", media: [] }]);
  assert.equal((row as Record<string, unknown>).legacyImages, undefined);
});

function nativeFixture() {
  const source = { ownerUserId: "user_1", gameId: "game_1", observationVersionId: "obs_1", sourceDigest: "a".repeat(64), legacyId: "11", gradingCode: "8",
    displayPaths: ["accountsImage/20261103/a.png", "accountsImage/20261103/b.jpg"], blockedPaths: [] as string[] };
  const digest = (accountId = "account_1") => sha256Hex(canonicalize(["LEGACY_PUBLISHED_REFERENCE", accountId, source.ownerUserId, source.gameId, source.observationVersionId, source.sourceDigest, source.legacyId, source.displayPaths]));
  const version = { accountId: "account_1", versionId: "published_1", marker: digest(), payloadMarker: digest() };
  let helperCalls = 0, markerSql = "";
  const client = { async query(text: string, values: unknown[] = []) {
    if (text.includes("JOIN unnest")) { markerSql = text; return { rows: [version] }; }
    if (text.includes("gradingCode")) { helperCalls++; return { rows: values[0] === "account_1" ? [source] : [] }; }
    throw new Error("UNEXPECTED_SQL");
  } } as unknown as PoolClient;
  const listing: Record<string, unknown> = { id: "account_1", versionId: "published_1", media: [], canCreateOrder: true };
  return { client, source, version, listing, digest, helperCalls: () => helperCalls, markerSql: () => markerSql };
}

test("a verified native publication projects old slots without making the account unavailable", async () => {
  const f = nativeFixture();
  const [listing] = await attachLegacyPathImages(f.client, [f.listing]);
  assert.deepEqual(listing!.legacyImages, [
    { position: 0, url: "/api/v1/supply/listings/account_1/legacy-images/0" },
    { position: 1, url: "/api/v1/supply/listings/account_1/legacy-images/1" },
  ]);
  assert.equal(listing!.canCreateOrder, true);
  assert.doesNotMatch(JSON.stringify(listing), /accountsImage|legacy_published_reference/);
  assert.match(f.markerSql(), /p\.version_id=v\.id/);
  assert.match(f.markerSql(), /jsonb_array_length\(v\.payload#>'\{declaration,mediaBindings\}'\)=0/);
  assert.match(f.markerSql(), /NOT EXISTS \(SELECT 1 FROM zzsh_supply\.listing_media/);
  assert.doesNotMatch(f.markerSql(), /current_version_id/, "a private current draft must not hide the public version");
  const reference = await readNativeLegacyPathReference(f.client, f.listing);
  assert.equal(reference?.observationVersionId, "obs_1");
  const row: LegacyMediaRecord = { accountId: "account_1", ownerUserId: "user_1", observationVersionId: "obs_1", currentVersionId: "private_draft", sourceDigest: "a".repeat(64), currentSourceDigest: "a".repeat(64), displayPaths: f.source.displayPaths, penaltyPaths: [] };
  assert.equal(await authorizeLegacyPublicSlot(f.client, listing!, row, 0), "obs_1");
  assert.equal(await authorizeLegacyPublicSlot(f.client, listing!, { ...row, accountId: "other" }, 0), null);
  assert.equal(await authorizeLegacyPublicSlot(f.client, listing!, { ...row, displayPaths: ["accountsImage/20261103/other.png"] }, 0), null);
  const reader = { get: async () => { throw Object.assign(new Error("missing"), { code: "NoSuchKey", status: 404 }); }, head: async () => ({}) };
  assert.deepEqual(await readLegacyImage(reader, "test/", row, "account_1", "display", 0, { realm: "public", admitted: true, versionId: reference!.observationVersionId }), { state: "MIGRATING" });
  assert.equal(listing!.canCreateOrder, true, "a missing object does not change rentability");
});

test("native fallback requires the exact marker in both persisted version fields", async () => {
  const f = nativeFixture();
  const [authorized] = await attachLegacyPathImages(f.client, [f.listing]);
  const row: LegacyMediaRecord = { accountId: "account_1", ownerUserId: "user_1", observationVersionId: "obs_1", currentVersionId: "private_draft", sourceDigest: "a".repeat(64), currentSourceDigest: "a".repeat(64), displayPaths: f.source.displayPaths, penaltyPaths: [] };
  const before = f.helperCalls();
  f.version.marker = null as unknown as string;
  assert.equal(await authorizeLegacyPublicSlot(f.client, authorized!, row, 0), null);
  assert.deepEqual(await attachLegacyPathImages(f.client, [f.listing]), [f.listing]); assert.equal(f.helperCalls(), before);
  f.version.marker = f.digest(); f.version.payloadMarker = "b".repeat(64);
  assert.deepEqual(await attachLegacyPathImages(f.client, [f.listing]), [f.listing]); assert.equal(f.helperCalls(), before);
  f.version.payloadMarker = f.version.marker; f.version.accountId = "different_account";
  assert.deepEqual(await attachLegacyPathImages(f.client, [f.listing]), [f.listing]); assert.equal(f.helperCalls(), before);
});

test("another account's marker or changed source and paths cannot qualify", async () => {
  const f = nativeFixture();
  f.version.marker = f.digest("different_account"); f.version.payloadMarker = f.version.marker;
  assert.deepEqual(await attachLegacyPathImages(f.client, [f.listing]), [f.listing]);
  f.version.marker = f.digest(); f.version.payloadMarker = f.version.marker;
  f.source.sourceDigest = "b".repeat(64);
  assert.deepEqual(await attachLegacyPathImages(f.client, [f.listing]), [f.listing]);
  f.source.sourceDigest = "a".repeat(64); f.source.displayPaths = ["accountsImage/20261103/changed.png"];
  assert.deepEqual(await attachLegacyPathImages(f.client, [f.listing]), [f.listing]);
});

test("private penalty slots are withheld and genuine new assets win", async () => {
  const f = nativeFixture(); f.source.blockedPaths = [f.source.displayPaths[1]!];
  const [listing] = await attachLegacyPathImages(f.client, [f.listing]);
  assert.deepEqual(listing!.legacyImages, [{ position: 0, url: "/api/v1/supply/listings/account_1/legacy-images/0" }]);
  const row: LegacyMediaRecord = { accountId: "account_1", ownerUserId: "user_1", observationVersionId: "obs_1", currentVersionId: "private_draft", sourceDigest: "a".repeat(64), currentSourceDigest: "a".repeat(64), displayPaths: f.source.displayPaths, penaltyPaths: [f.source.displayPaths[1]!] };
  assert.equal(await authorizeLegacyPublicSlot(f.client, listing!, row, 1), null);
  const before = f.helperCalls(), withNewMedia = { ...f.listing, media: [{ assetId: "new_asset", url: "/api/v1/supply/listings/account_1/media/new_asset" }] };
  assert.deepEqual(await attachLegacyPathImages(f.client, [withNewMedia]), [withNewMedia]); assert.equal(f.helperCalls(), before);
});
