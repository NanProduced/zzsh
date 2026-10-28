import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertDeltaResourceUnit, DELTA_GRADING_DIVISIONS, DELTA_RESOURCE_UNITS, isDeltaGradingDivision, normalizeDeltaAttributes, validateDeltaPublicationAttributes } from "../src/supply/delta-rental";
import { canonicalize } from "../src/supply/content-hash";
import { projectPublicAttributeDisplay, publicGradingOptions, publicGradingRankOptions, publicLoginMethodOptions } from "../src/supply/listing-query";
import { parseFilterConfig, parseListingFilters, parseListingQueryV2 } from "../src/supply/listing-filter-contract";
import { validateConfigCatalog, validateListingQuery, publicFilterMetadata } from "../src/supply/listing-filter-config";
import { buildListingCandidates } from "../src/supply/listing-candidates";
import { buildMixedListingCandidates } from "../src/supply/legacy-listing-read";
import { acceptListingRules, quoteListing, reviewListing, saveListingDraft, submitListing, type LegacyTakeoverGradingContext } from "../src/supply/publishing";
import { publicListingAttributes } from "../src/supply/publishing";
import * as deltaRental from "../src/supply/delta-rental";

const publicationAttributes = { next_season_pass: false, demulan_unlocked: false, grading_code: "4", grading_division: 3, login_method_code: "login_qq_qr", vit_level: 4, bear_level: 7, dive_level: 0,
  service_window_start_minute: 540, service_window_end_minute: 1380, service_window_cross_midnight: false, service_window_timezone: "Asia/Shanghai" };
const legacyAttributes = { ...publicationAttributes, grading_division: null, login_method_code: "legacy_login_qq" };
const query = (filters: unknown) => parseListingQueryV2(new URLSearchParams({ queryVersion: "2", gameId: "game", filters: JSON.stringify(filters) }), "/listings");

test("supplements: new declarations preserve omission, strict three-state flags and private attribution", () => {
  const old = normalizeDeltaAttributes({ grading_code: "4", info_source: "old free text" });
  const digest = (value: unknown) => createHash("sha256").update(canonicalize(value)).digest("hex");
  assert.equal(Object.hasOwn(old, "next_season_pass"), false);
  assert.equal(Object.hasOwn(old, "demulan_unlocked"), false);
  for (const field of ["next_season_pass", "demulan_unlocked"] as const) {
    for (const value of [null, false, true]) {
      const normalized = normalizeDeltaAttributes({ ...old, [field]: value });
      assert.equal(normalized[field], value);
      assert.notEqual(digest(normalized), digest(old));
      const publicAttrs = publicListingAttributes(normalized);
      assert.equal(publicAttrs[field], value);
      assert.equal(Object.hasOwn(publicAttrs, "info_source"), false);
    }
    for (const value of [0, 1, "false", "true", [], {}]) assert.throws(() => normalizeDeltaAttributes({ [field]: value }));
  }
  assert.equal(publicListingAttributes({ isSayyid: true }).demulan_unlocked, null);
  for (const field of ["isSayyid", "isDemulan", "isNextSeasonPass"]) assert.throws(() => normalizeDeltaAttributes({ [field]: true }));
  assert.equal(old.info_source, "old free text");
});

test("supplements: new publication needs both explicit answers while verified legacy validation may retain unknown", () => {
  const complete = { ...publicationAttributes, next_season_pass: false, demulan_unlocked: true };
  assert.doesNotThrow(() => validateDeltaPublicationAttributes(complete));
  for (const field of ["next_season_pass", "demulan_unlocked"] as const) {
    for (const value of [undefined, null, "false", 0]) assert.throws(() => validateDeltaPublicationAttributes({ ...complete, [field]: value }), (error: any) => error.status === 400 && error.details?.[0]?.path === `attributes.${field}`);
  }
  const old = { ...complete } as Record<string, unknown>; delete old.next_season_pass; delete old.demulan_unlocked;
  assert.doesNotThrow(() => validateDeltaPublicationAttributes(old, { requireSupplementalDeclarations: false } as never));
});

test("supplements: authoring term guard trusts bound daily consumption, not option names or client hints", () => {
  const validate = (deltaRental as any).validateDeltaRentalTerm;
  assert.equal(typeof validate, "function");
  const custom = { rentalMode: "custom", ownerRatioB: "44" };
  assert.doesNotThrow(() => validate(custom, { code: "unrelated-name", dailyConsumption: "10000000" }, "unrelated-name"));
  for (const dailyConsumption of ["20000000", "30000000", "10000000.0", null]) assert.throws(() => validate(custom, { code: "daily-10m", dailyConsumption }, "daily-10m"), (error: any) => error.status === 400 && error.details?.[0]?.path === "termOptionCode");
  assert.throws(() => validate(custom, null, "daily-10m"));
  assert.throws(() => validate(custom, { code: "different", dailyConsumption: "10000000" }, "selected"));
  for (const rentalMode of ["ordinary", "fast"]) assert.doesNotThrow(() => validate({ rentalMode, ...(rentalMode === "fast" ? { ownerRatioB: "55" } : {}) }, { code: "daily-20m", dailyConsumption: "20000000" }, "daily-20m"));
});

test("the new turtle backpack has a fixed PIECE base unit and no fractional stock scale", () => {
  assert.equal(DELTA_RESOURCE_UNITS.df_billable_turtle_backpack_45, "PIECE");
  assert.doesNotThrow(() => assertDeltaResourceUnit("df_billable_turtle_backpack_45", "PIECE", 0));
  for (const [unit, scale] of [["DAY", 0], ["ROUND", 0], ["PIECE", 1]] as const)
    assert.throws(() => assertDeltaResourceUnit("df_billable_turtle_backpack_45", unit, scale), { status: 400 });
});

test("QQ QR is a distinct real code; legacy QQ and unknown source codes keep their meaning", () => {
  const options = publicLoginMethodOptions();
  assert.equal(options.find(x => x.code === "login_qq_qr")?.displayName, "QQ扫码");
  assert.equal(options.find(x => x.code === "legacy_login_qq")?.displayName, "QQ账密");
  assert.equal(projectPublicAttributeDisplay({ login_method_code: "login_qq_qr" }).loginMethod?.displayName, "QQ扫码");
  assert.equal(normalizeDeltaAttributes({ login_method_code: "login_qq_qr" }).login_method_code, "login_qq_qr");
  assert.doesNotThrow(() => validateDeltaPublicationAttributes(publicationAttributes));
  for (const code of ["qq", "UNKNOWN", "toString", null]) {
    assert.throws(() => validateDeltaPublicationAttributes({ ...publicationAttributes, login_method_code: code }), { status: 400 });
    assert.notEqual(projectPublicAttributeDisplay({ login_method_code: code }).loginMethod?.displayName, "QQ扫码");
  }
});

test("all 25 exact ranks validate and project their own division, peak stays division-free", () => {
  const ranks = publicGradingRankOptions(); assert.equal(ranks.length, 25); assert.equal(new Set(ranks.map(x => x.code)).size, 25);
  for (const option of publicGradingOptions()) assert.deepEqual(option.divisions, DELTA_GRADING_DIVISIONS[option.code]);
  for (const rank of ranks) {
    const [major, division] = rank.code.split(":");
    const attributes = { ...publicationAttributes, grading_code: major, ...(division ? { grading_division: Number(division) } : { grading_division: null }) };
    assert.doesNotThrow(() => validateDeltaPublicationAttributes(attributes));
    assert.doesNotThrow(() => normalizeDeltaAttributes(attributes));
    const shown = projectPublicAttributeDisplay(attributes).grading!;
    assert.equal(shown.displayName, rank.displayName);
    assert.equal(shown.division, division ? Number(division) : undefined);
  }
  assert.doesNotThrow(() => validateDeltaPublicationAttributes({ ...publicationAttributes, grading_code: "1", grading_division: null }));
});

test("illegal explicit pairs never normalize; missing historical division stays unknown, new publication requires it", () => {
  for (const [major, division] of [["2", 4], ["4", 5], ["6", 6], ["8", 1], ["1", 1], ["4", 0], ["4", -1], ["4", 1.5], ["4", "3"], ["toString", 1]] as const) {
    assert.throws(() => normalizeDeltaAttributes({ grading_code: major, grading_division: division }));
    assert.throws(() => validateDeltaPublicationAttributes({ ...publicationAttributes, grading_code: major, grading_division: division }), { status: 400 });
    assert.equal(isDeltaGradingDivision(major, division), false);
  }
  const old = normalizeDeltaAttributes({ grading_code: "4", login_method_code: "legacy_login_qq" });
  assert.equal(Object.hasOwn(old, "grading_division"), false);
  assert.equal(projectPublicAttributeDisplay(old).grading?.displayName, "黄金");
  assert.equal(projectPublicAttributeDisplay(old).grading?.division, undefined);
  assert.throws(() => validateDeltaPublicationAttributes(legacyAttributes), { status: 400 });
  assert.doesNotThrow(() => validateDeltaPublicationAttributes(legacyAttributes, { requireGradingDivision: false }));
  assert.throws(() => validateDeltaPublicationAttributes({ ...legacyAttributes, grading_division: 5 }, { requireGradingDivision: false }), { status: 400 });
});

test("old normalized declaration bytes retain their pre-change SHA; a real division changes the hash", () => {
  const attrs = { grading_code: "4", login_method_code: "legacy_login_qq" };
  const digest = (value: unknown) => createHash("sha256").update(canonicalize(value)).digest("hex");
  assert.equal(digest(normalizeDeltaAttributes(attrs)), "f70f49c3c9edfc0e7c4cbc155ec857e66dedc050bb47f3ddc4807cc266df61d7");
  assert.notEqual(digest(normalizeDeltaAttributes({ ...attrs, grading_division: 3 })), digest(normalizeDeltaAttributes(attrs)));
  assert.notEqual(digest(normalizeDeltaAttributes({ ...attrs, grading_division: 3 })), digest(normalizeDeltaAttributes({ ...attrs, grading_division: 2 })));
});

test("exact rank filter is closed to 25 legal pairs; broad major remains an independent intersection", () => {
  const all = publicGradingRankOptions().map(x => x.code);
  assert.equal(parseListingFilters({ gradingRanks: all }).gradingRanks?.length, 25);
  assert.deepEqual(parseListingFilters({ gradingCodes: ["4"], gradingRanks: ["6:2", "4:3"] }), { gradingCodes: ["4"], gradingRanks: ["4:3", "6:2"] });
  for (const tokens of [["2:4"], ["4:5"], ["6:6"], ["8:1"], ["4:0"], ["4:03"], ["4"], ["1"], ["4:3", "4:3"], [...all, "8"]])
    assert.throws(() => parseListingFilters({ gradingRanks: tokens }), { status: 400 });
  for (const build of [buildListingCandidates, buildMixedListingCandidates]) {
    const sql = build(query({ gradingCodes: ["4"], gradingRanks: ["4:3", "6:2", "8"], loginMethodCodes: ["login_qq_qr"] }), null);
    assert.match(sql.text, /grading_code'\s*=ANY\(/); assert.match(sql.text, /AND \(\(.*grading_code'/s);
    assert.match(sql.text, /jsonb_typeof\(.*grading_division'\)='number'/s);
    assert.match(sql.text, /grading_division'='null'::jsonb/);
    assert(sql.values.some(v => Array.isArray(v) && v[0] === "4"));
    assert(sql.values.includes("4") && sql.values.includes(3) && sql.values.includes("6") && sql.values.includes(2));
    assert(sql.values.some(v => Array.isArray(v) && v[0] === "login_qq_qr"));
  }
});

test("configured options expose exact ranks and QQ QR without auto-enabling an old config", async () => {
  const field = { key: "gradingRanks", operator: "PAIRS_ANY", label: "精确段位", enabled: true, order: 0, options: [{ value: "4:3", label: "黄金3" }, { value: "8", label: "巅峰" }] };
  const config = parseFilterConfig({ schemaVersion: 1, fields: [field, { key: "loginMethodCodes", operator: "ANY", label: "登录方式", enabled: true, order: 1, options: [{ value: "login_qq_qr", label: "QQ扫码" }] }], sorts: [{ key: "latest", label: "最新发布", enabled: true, order: 0 }] });
  const catalog: any = { game: { id: "game", rule: {}, catalogRevision: "1", ruleReleaseId: "release" }, items: [], categories: [] };
  validateConfigCatalog(config, catalog);
  assert.throws(() => validateConfigCatalog({ ...config, fields: [{ ...field, options: [{ value: "2:4", label: "invalid" }] }] } as any, catalog), { status: 400 });
  const state: any = { catalog, config, legacyReadOnly: false, allowLegacyOptions: false, filterRevision: "1", catalogRevision: "1", ruleReleaseId: "release" };
  const noQueries = { query: () => { throw Error("not a skin query"); } } as any;
  await validateListingQuery(noQueries, query({ gradingRanks: ["4:3"], loginMethodCodes: ["login_qq_qr"] }), state);
  await assert.rejects(validateListingQuery(noQueries, query({ gradingRanks: ["6:2"] }), state), { status: 400 });
  await assert.rejects(validateListingQuery(noQueries, query({ gradingRanks: ["4:3"] }), { ...state, config: { ...config, fields: [] } }), { status: 400 });
  const metadata = publicFilterMetadata(state, true);
  assert.equal(metadata.fields.find(f => f.key === "gradingRanks")?.options?.length, 2);
  assert.equal(publicFilterMetadata({ ...state, config: { ...config, fields: [] } }, true).fields.length, 0);
});

function publishingFixture(attributes: Record<string, unknown>, submitted = false) {
  const calls: string[] = [];
  const account: any = { id: "account", game_id: "game", owner_user_id: "owner", revision: "1", current_version_id: "version", lifecycle: "ACTIVE", legacy_hold: "NONE" };
  const version: any = { id: "version", account_id: "account", origin: "NATIVE", review_state: submitted ? "SUBMITTED" : "DRAFT", attributes, rule_release_id: "release", content_hash: "f".repeat(64), payload: { declaration: { attributes }, ruleRefs: { catalogRevision: "1" } } };
  const client: any = { query: async (sql: string) => {
    calls.push(sql);
    if (sql === "SELECT 1 FROM zzsh_order.rental_order WHERE account_id=$1 AND status='COMPLETED' LIMIT 1") return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT "suspended"')) return { rows: [{ suspended: false }] };
    if (sql.includes('user_identity_state')) return { rows: [] };
    if (sql.includes('"game_service_operation"')) return { rows: [{ id: "service", gameCode: "delta", gameEnabled: true, enabled: true }] };
    if (sql.includes("SELECT * FROM zzsh_supply.listing_version")) return { rows: [version] };
    if (sql.includes("SELECT current_release_id,catalog_revision")) return { rows: [{ current_release_id: "release", catalog_revision: "1" }] };
    if (sql.includes("SELECT item_id AS") || sql.includes("SELECT skin_id FROM") || sql.includes("SELECT entitlement_id AS") || sql.includes("SELECT m.asset_id AS")) return { rows: [] };
    throw Error("AFTER_ATTRIBUTE_VALIDATION");
  } };
  return { calls, account, client, version };
}
const legacyContext: LegacyTakeoverGradingContext = { kind: "VERIFIED_LEGACY_TAKEOVER", accountId: "account", sourceDigest: "a".repeat(64), observationVersionId: "observation", gradingCode: "4", gradingDivision: null };

test("new quote rejects unknown division; only matching verified takeover context reaches subsequent quote logic", async () => {
  const f = publishingFixture(legacyAttributes);
  await assert.rejects(quoteListing(f.client, f.account, "1"), { status: 400 });
  await assert.rejects(quoteListing(f.client, f.account, "1", legacyContext), /AFTER_ATTRIBUTE_VALIDATION/);
  for (const changes of [{ accountId: "foreign" }, { gradingCode: "6" }, { gradingDivision: 3 }, { sourceDigest: "invalid" }, { observationVersionId: "" }])
    await assert.rejects(quoteListing(f.client, f.account, "1", { ...legacyContext, ...changes }), { status: 409 });
  const invalid = publishingFixture({ ...legacyAttributes, grading_division: 5 });
  await assert.rejects(quoteListing(invalid.client, invalid.account, "1", { ...legacyContext, gradingDivision: 5 }), { status: 400 });
  assert.equal(f.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
});

test("review approval enforces the same new versus verified legacy boundary before any decision write", async () => {
  const f = publishingFixture(legacyAttributes, true);
  const body = { expectedRevision: "1", versionId: "version", releaseId: "release", contentHash: f.version.content_hash, decision: "APPROVE", reason: "reviewed" };
  await assert.rejects(reviewListing(f.client, f.account, "admin", body, async () => ({} as any)), { status: 400 });
  await assert.rejects(reviewListing(f.client, f.account, "admin", body, async () => ({} as any), legacyContext), /AFTER_ATTRIBUTE_VALIDATION/);
  assert.equal(f.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
});

test("old clients cannot silently remove a previously explicit valid division", async () => {
  const f = publishingFixture(publicationAttributes);
  const body = { expectedRevision: "1", title: "Synthetic", attributes: { ...publicationAttributes } };
  delete (body.attributes as Record<string, unknown>).grading_division;
  await assert.rejects(saveListingDraft(f.client, f.account, body, async () => ({ occupancy: "FREE" } as any)), { status: 409 });
  assert.equal(f.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
});

test("supplements: old clients cannot silently erase previously answered supplemental flags", async () => {
  for (const field of ["next_season_pass", "demulan_unlocked"] as const) {
    const f = publishingFixture(publicationAttributes);
    const attributes = { ...publicationAttributes } as Record<string, unknown>; delete attributes[field];
    await assert.rejects(saveListingDraft(f.client, f.account, { expectedRevision: "1", attributes }, async () => ({ occupancy: "FREE" } as any)), { status: 409 });
    assert.equal(f.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
  }
});

test("supplements: quote, acceptance, direct submit and review reject custom20/30 before authoring writes", async () => {
  for (const dailyConsumption of ["20000000", "30000000"]) for (const action of ["quote", "accept", "submit", "review"] as const) {
    const f = publishingFixture({ ...publicationAttributes, rentalPricing: { rentalMode: "custom", ownerRatioB: "44" } }, action === "review");
    f.version.term_option_code = "daily-10m";
    const read = f.client.query;
    f.client.query = async (sql: string) => {
      if (sql.includes("FROM zzsh_supply.term_option") || sql.includes("JOIN zzsh_supply.term_option")) { f.calls.push(sql); return { rows: [{ code: "daily-10m", dailyConsumption }], rowCount: 1 }; }
      if (sql.includes("SELECT 1 FROM zzsh_supply.billable_item")) { f.calls.push(sql); return { rows: [], rowCount: 0 }; }
      if (sql.includes("SELECT r.*,g.catalog_revision")) { f.calls.push(sql); return { rows: [{ id: "release", term_version_id: "term" }], rowCount: 1 }; }
      return read(sql);
    };
    const body = { expectedRevision: "1", versionId: "version", releaseId: "release", contentHash: f.version.content_hash, decision: "APPROVE", reason: "reviewed" };
    const result = action === "quote" ? quoteListing(f.client, f.account, "1") : action === "accept" ? acceptListingRules(f.client, f.account, body) : action === "submit" ? submitListing(f.client, f.account, "owner", body, async () => ({} as any)) : reviewListing(f.client, f.account, "admin", body, async () => ({} as any));
    await assert.rejects(result, (error: any) => error.status === 400 && error.details?.[0]?.path === "termOptionCode");
    assert.equal(f.calls.some(sql => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
  }
});
