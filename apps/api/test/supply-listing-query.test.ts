import assert from "node:assert/strict";
import test from "node:test";
import {
  LISTING_SEARCH_MAX_LENGTH,
  listingSearchPattern,
  parsePublicListingSearch,
  projectOwnerMediaBinding,
  projectPublicAttributeDisplay,
  projectPublicListingGame,
  projectPublicOffer,
} from "../src/supply/listing-query";

test("listing search trims, bounds length and treats blank as absent", () => {
  assert.equal(parsePublicListingSearch(null), null);
  assert.equal(parsePublicListingSearch("   "), null);
  assert.equal(parsePublicListingSearch("\n\t"), null);
  assert.equal(parsePublicListingSearch("  三角洲  "), "三角洲");
  assert.equal(parsePublicListingSearch("\u0041\u0301"), "\u00C1");
  assert.throws(() => parsePublicListingSearch("x".repeat(LISTING_SEARCH_MAX_LENGTH + 1)), {
    status: 400,
  });
  assert.throws(() => parsePublicListingSearch("ok\u0000bad"), { status: 400 });
  assert.equal(parsePublicListingSearch("%_\\'"), "%_\\'");
});

test("listing search patterns treat % and _ as literals", () => {
  assert.equal(listingSearchPattern("%"), "%\\%%");
  assert.equal(listingSearchPattern("_"), "%\\_%");
  assert.equal(listingSearchPattern("a\\b"), "%a\\\\b%");
});

test("public offer keeps snapshot codes and null names without inventing zeros", () => {
  assert.deepEqual(
    projectPublicOffer({
      attributes: {},
      termOptionCode: "",
      boundTerm: null,
    }),
    { safeBox: null, termOption: null },
  );
  assert.deepEqual(
    projectPublicOffer({
      attributes: { safe_box_code: "" },
      termOptionCode: "daily-10m",
      boundTerm: null,
    }),
    {
      safeBox: null,
      termOption: {
        code: "daily-10m",
        displayName: null,
        dailyConsumption: null,
      },
    },
  );
  assert.deepEqual(
    projectPublicOffer({
      attributes: { safe_box_code: "box-a" },
      termOptionCode: "daily-10m",
      boundTerm: {
        code: "daily-10m",
        name: "日消耗 10M",
        dailyConsumption: "10000000",
      },
    }),
    {
      safeBox: { code: "box-a", displayName: null },
      termOption: {
        code: "daily-10m",
        displayName: "日消耗 10M",
        dailyConsumption: { quantity: "10000000", unit: "HAFF_BASE" },
      },
    },
  );
  assert.equal(
    projectPublicOffer({
      attributes: { safe_box_code: "box-a" },
      termOptionCode: "daily-10m",
      boundTerm: {
        code: "daily-20m",
        name: "other",
        dailyConsumption: "0",
      },
    }).termOption?.dailyConsumption,
    null,
    "a mismatched catalog row must not rewrite the version code or invent a quantity",
  );
});

test("public attribute projection keeps stable codes beside confirmed labels", () => {
  assert.deepEqual(
    projectPublicAttributeDisplay({
      safe_box_code: "safe_box_3x3",
      grading_code: 6,
      login_method_code: "legacy_login_wechat",
      service_window_start_minute: 9 * 60,
      service_window_end_minute: 23 * 60,
    }),
    {
      safeBox: { code: "safe_box_3x3", displayName: "顶级安全箱(3*3)", mappingStatus: "CONFIRMED", issueCode: null },
      grading: { code: "6", displayName: "钻石", mappingStatus: "CONFIRMED", issueCode: null },
      loginMethod: { code: "legacy_login_wechat", displayName: "微信扫码", mappingStatus: "CONFIRMED", issueCode: null },
      serviceWindow: { startMinute: 540, endMinute: 1380, displayName: "09:00–23:00" },
    },
  );
  assert.deepEqual(
    projectPublicAttributeDisplay({ safe_box_code: "box-unknown", grading_code: "gold", login_method_code: "steam_cn", service_window_start_minute: 1_441, service_window_end_minute: 60 }),
    {
      safeBox: { code: "box-unknown", displayName: null, mappingStatus: "UNCONFIRMED", issueCode: "SAFE_BOX_CODE_UNMAPPED" },
      grading: { code: "gold", displayName: null, mappingStatus: "UNCONFIRMED", issueCode: "GRADING_CODE_UNMAPPED" },
      loginMethod: { code: "steam_cn", displayName: null, mappingStatus: "UNCONFIRMED", issueCode: "LOGIN_METHOD_CODE_UNMAPPED" },
      serviceWindow: null,
    },
  );
  assert.deepEqual(
    projectPublicAttributeDisplay({ login_method_code: "legacy_login_steam_cn" }).loginMethod,
    { code: "legacy_login_steam_cn", displayName: "Steam国服", mappingStatus: "CONFIRMED", issueCode: null },
  );
  assert.deepEqual(
    projectPublicAttributeDisplay({ login_method_code: "legacy_login_steam_global" }).loginMethod,
    { code: "legacy_login_steam_global", displayName: "Steam国际服", mappingStatus: "CONFIRMED", issueCode: null },
  );
});

test("owner media status does not infer public readability from approval alone", () => {
  const live = {
    listingPublic: true,
    displayAssetIds: new Set(["asset_display"]),
    ownerUserId: "user_1",
  };
  const displayRow = {
    assetId: "asset_display",
    position: 0,
    purpose: "ACCOUNT_DISPLAY" as const,
    byteHash: "a".repeat(64),
    reviewState: "APPROVED",
    accessClass: "PUBLIC_DISPLAY",
    publicStorageKey: "b".repeat(64),
    ownerUserId: "user_1",
  };
  const displayApprovedPublic = projectOwnerMediaBinding(displayRow, live);
  assert.equal(displayApprovedPublic.reviewState, "APPROVED");
  assert.equal(displayApprovedPublic.publicDisplayEligible, true);
  assert.equal(displayApprovedPublic.publiclyReadable, true);
  const paused = projectOwnerMediaBinding(displayRow, {
    ...live,
    listingPublic: false,
  });
  assert.equal(paused.publicDisplayEligible, true);
  assert.equal(paused.publiclyReadable, false);
  const draftOnly = projectOwnerMediaBinding(
    { ...displayRow, assetId: "asset_draft_only" },
    live,
  );
  assert.equal(draftOnly.publicDisplayEligible, true);
  assert.equal(draftOnly.publiclyReadable, false);
  const revoked = projectOwnerMediaBinding(
    { ...displayRow, accessClass: "PRIVATE_REVIEW" },
    live,
  );
  assert.equal(revoked.reviewState, "APPROVED");
  assert.equal(revoked.publicDisplayEligible, false);
  assert.equal(revoked.publiclyReadable, false);
  const evidence = projectOwnerMediaBinding(
    {
      assetId: "asset_evidence",
      position: 1,
      purpose: "ACCOUNT_EVIDENCE",
      byteHash: "c".repeat(64),
      reviewState: "APPROVED",
      accessClass: "PRIVATE_REVIEW",
      publicStorageKey: null,
      ownerUserId: "user_1",
    },
    {
      listingPublic: true,
      displayAssetIds: new Set(["asset_evidence"]),
      ownerUserId: "user_1",
    },
  );
  assert.equal(evidence.purpose, "ACCOUNT_EVIDENCE");
  assert.equal(evidence.reviewState, "APPROVED");
  assert.equal(evidence.publicDisplayEligible, false);
  assert.equal(evidence.publiclyReadable, false);
  const missing = projectOwnerMediaBinding(
    {
      assetId: "asset_gone",
      position: 2,
      purpose: null,
      byteHash: null,
      reviewState: null,
      accessClass: null,
      publicStorageKey: null,
      ownerUserId: null,
    },
    live,
  );
  assert.equal(missing.reviewState, "UNAVAILABLE");
  assert.equal(missing.publiclyReadable, false);
  assert.equal(
    projectOwnerMediaBinding(
      {
        assetId: "asset_pending",
        position: 3,
        purpose: "ACCOUNT_DISPLAY",
        byteHash: "d".repeat(64),
        reviewState: "PENDING",
        accessClass: "PRIVATE_REVIEW",
        publicStorageKey: null,
        ownerUserId: "user_1",
      },
      live,
    ).reviewState,
    "PENDING",
  );
});

test("public listing game projection keeps identity and falls back to null", () => {
  assert.deepEqual(
    projectPublicListingGame({ id: "game_1", code: "delta", name: "三角洲行动" }),
    { id: "game_1", code: "delta", name: "三角洲行动" },
  );
  for (const row of [null, undefined, {}, { id: "game_1" }, { id: "game_1", code: "delta" }, { id: "game_1", name: "x" }, { code: "delta", name: "x" }, { id: "", code: "delta", name: "x" }]) {
    assert.equal(projectPublicListingGame(row as never), null);
  }
});
