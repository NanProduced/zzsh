import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { isAccountMediaBinding } from "../src/supply/listing-query";
import { createListingDraft, readDeclaration, saveListingDraft, type ListingVersion, type PublishingAccount, type ListingMediaAssetRow } from "../src/supply/publishing";

function fixture(patch: Partial<ListingMediaAssetRow> = {}, missing = false) {
  const account: PublishingAccount = { id: "account", owner_user_id: "owner", game_id: "game", current_version_id: "version", owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "NONE", lifecycle: "ACTIVE", revision: "1", display_no: null };
  const version = { id: "version", account_id: "account", review_state: "DRAFT", origin: "NATIVE", attributes: {}, revision: "1", title: "draft", description: null, term_option_code: "", pricing_option_code: "", payload: null } as unknown as ListingVersion;
  const asset: ListingMediaAssetRow = { id: "asset", account_id: account.id, owner_user_id: account.owner_user_id, game_id: account.game_id, purpose: "ACCOUNT_DISPLAY", ownership_kind: "USER_SUPPLY", content_hash: "a".repeat(64), review_state: "PENDING", technical_state: "READY", public_storage_key: "display", access_class: "PUBLIC_DISPLAY", source_note: null, ...patch };
  const writes: string[] = [], queries: string[] = [];
  const client = { query: async (sql: string, args: unknown[] = []) => {
    queries.push(sql); let rows: unknown[] = [];
    if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) writes.push(sql);
    if (sql.includes('FROM "zzsh_auth_user"."user"')) rows = [{ suspended: false }];
    else if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) rows = [{ accountStatus: "ACTIVE" }];
    else if (sql.includes("game_service_operation")) rows = [{ id: "service", gameId: "game", gameCode: "delta", gameEnabled: true, enabled: true, revision: "1" }];
    else if (sql.includes("SELECT * FROM zzsh_supply.listing_version")) rows = [version];
    else if (sql.includes("SELECT * FROM zzsh_supply.media_asset")) rows = !missing && (args[0] as string[]).includes(asset.id) && (!sql.includes("AND account_id=$2") || asset.account_id === args[1] && asset.owner_user_id === args[2] && asset.game_id === args[3]) ? [asset] : [];
    else if (sql.includes('m.asset_id AS "assetId"')) {
      const projected = { assetId: asset.id, byteHash: asset.content_hash, purpose: asset.purpose, position: 0 };
      rows = sql.includes("binding_account_id") ? [{ ...projected, ...asset, ...(missing ? { purpose: null, ownership_kind: null } : {}), binding_account_id: account.id, binding_owner_user_id: account.owner_user_id, binding_game_id: account.game_id }] : [projected];
    } else if (sql.includes("RETURNING revision::text")) rows = [{ revision: "2" }];
    return { rows, rowCount: rows.length };
  } } as unknown as PoolClient;
  const body = { expectedRevision: "1", title: "draft", mediaBindings: [{ assetId: "asset", position: 0 }] };
  const gate = async () => ({ publisherBail: "NOT_REQUIRED" as const, occupancy: "FREE" as const, reference: "fixture" });
  return { account, version, asset, client, body, gate, writes, queries };
}

test("own draft display and private evidence can be saved before review, without a frozen quote", async () => {
  for (const purpose of ["ACCOUNT_DISPLAY", "ACCOUNT_EVIDENCE"]) {
    const f = fixture({ purpose, access_class: purpose === "ACCOUNT_EVIDENCE" ? "PRIVATE_REVIEW" : "PUBLIC_DISPLAY" });
    await saveListingDraft(f.client, f.account, f.body, f.gate);
    assert(f.writes.some(sql => sql.includes("INSERT INTO zzsh_supply.listing_media")));
    assert.equal(f.account.revision, "2");
  }
});
test("empty draft needs neither media nor a publication-ready picture", async () => {
  const f = fixture(); await saveListingDraft(f.client, f.account, { ...f.body, mediaBindings: [] }, f.gate);
  assert(!f.queries.some(sql => sql.includes("SELECT * FROM zzsh_supply.media_asset")));
});
for (const [label, patch] of [
  ["another owner", { owner_user_id: "other" }], ["another account", { account_id: "other" }], ["another game", { game_id: "other" }],
  ["foreign private evidence", { purpose: "ACCOUNT_EVIDENCE", owner_user_id: "other", access_class: "PRIVATE_REVIEW" }],
  ["catalog picture", { purpose: "SKIN_MEDIA", ownership_kind: "PLATFORM_CATALOG" }],
] as Array<[string, Partial<ListingMediaAssetRow>]>) {
  test("draft rejects " + label + " before changing any binding or revision", async () => {
    const f = fixture(patch);
    await assert.rejects(saveListingDraft(f.client, f.account, f.body, f.gate), (e: any) => e.status === 400 && e.details?.[0]?.path === "mediaBindings");
    assert.deepEqual(f.writes, []); assert.equal(f.account.revision, "1");
  });
  test("stored " + label + " cannot disclose draft media metadata", async () => {
    const f = fixture(patch); await assert.rejects(readDeclaration(f.client, f.version), (e: any) => e.status === 404); assert.deepEqual(f.writes, []);
  });
}
test("missing asset is refused before mutation and cannot disappear in a declaration JOIN", async () => {
  const f = fixture({}, true);
  await assert.rejects(saveListingDraft(f.client, f.account, f.body, f.gate), (e: any) => e.status === 400);
  await assert.rejects(readDeclaration(f.client, f.version), (e: any) => e.status === 404); assert.deepEqual(f.writes, []);
});
test("valid declaration media exposes only the existing four-field contract", async () => {
  const f = fixture(), declaration = await readDeclaration(f.client, f.version);
  assert.deepEqual(declaration.mediaBindings, [{ assetId: "asset", byteHash: "a".repeat(64), purpose: "ACCOUNT_DISPLAY", position: 0 }]);
});
test("missing identity context never becomes an equal-undefined ownership match", () => {
  assert.equal(isAccountMediaBinding({ ownership_kind: "USER_SUPPLY", purpose: "ACCOUNT_DISPLAY", account_id: undefined, owner_user_id: undefined, game_id: undefined }, { id: undefined, owner_user_id: undefined, game_id: undefined }), false);
});
test("copying a previous draft cannot propagate stored foreign media", async () => {
  const f = fixture({ owner_user_id: "foreign" }); f.version.review_state = "REJECTED";
  await assert.rejects(createListingDraft(f.client, f.account, "1", f.gate), (e: any) => e.status === 404);
  assert.deepEqual(f.writes, []);
});
