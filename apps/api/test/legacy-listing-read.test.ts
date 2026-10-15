import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { parseLegacyReadSnapshot,buildLegacyListingCandidates,buildMixedListingCandidates,legacyListingSortLabel,legacyReadSourceAllowed,legacySnapshotConflicts,legacySnapshotReplaySql,legacyHistoricalReadSql,projectLegacyHistoricalRead,LEGACY_NATIVE_TAKEOVER_GUARD } from "../src/supply/legacy-listing-read";
import { publicFilterMetadata,validateConfigCatalog,validateListingQuery } from "../src/supply/listing-filter-config";
import { parseFilterConfig,type ListingQueryV2 } from "../src/supply/listing-filter-contract";

const valid = { schema: "legacy-listing-read-v1", resourceNo: "SOURCE-1", haffRentYuan: "2038.00", goodsYuan: "20.00", depositYuan: "50.00", termDays: "102", dailyHaffBase: "10000000" };
test("historical read amounts remain exact source strings, including a legitimate zero", () => {
  assert.deepEqual(parseLegacyReadSnapshot(valid), valid);
  assert.equal(parseLegacyReadSnapshot({ ...valid, depositYuan: "0.00" }).depositYuan, "0.00");
});
test("historical public snapshot refuses private fields, missing values and numeric coercion", () => {
  for (const extra of ["ownerUserId", "mobile", "ownerRatioB", "quote", "canCreateOrder"])
    assert.throws(() => parseLegacyReadSnapshot({ ...valid, [extra]: "untrusted" }));
  for (const bad of [1, null, ["20.00"], " 20.00", "20.00 ", "1e2", "-1.00", "20", "20.001"])
    assert.throws(() => parseLegacyReadSnapshot({ ...valid, goodsYuan: bad }));
  for (const bad of [0, null, "0", "01", "1.5", "-1"])
    assert.throws(() => parseLegacyReadSnapshot({ ...valid, termDays: bad }));
  const { depositYuan: omitted, ...missing } = valid;
  assert.throws(() => parseLegacyReadSnapshot(missing));
});

const config = parseFilterConfig({
  schemaVersion: 1,
  fields: [
    { key: "resources", operator: "AND_MIN", label: "资源", enabled: true, order: 0, items: [{ itemId: "item_haff", min: "0", max: "999999999999999999999999" }] },
    { key: "safeBoxCodes", operator: "ANY", label: "安全箱", enabled: true, order: 1, options: [{ value: "safe_box_3x3", label: "顶级安全箱(3*3)" }] },
    { key: "vitality", operator: "MIN", label: "体力", enabled: true, order: 2, levels: [6, 7] },
    { key: "serviceWindow", operator: "COVERS", label: "服务时段", enabled: true, order: 3 },
  ],
  sorts: [
    { key: "latest", label: "最新发布", enabled: true, order: 0 },
    { key: "resourceTotal", label: "资源总价", enabled: true, order: 1 },
    { key: "coreQuantity", label: "核心数量", enabled: true, order: 2, itemIds: ["item_haff"] },
  ],
});
const catalog = {
  game: { id: "game_x", code: "delta", catalogRevision: "7", ruleReleaseId: null, rule: null },
  items: [{ id: "item_haff", code: "haff_base", name: "哈夫币", unit: "HAFF_BASE" }],
  categories: [],
};
const legacyState = { catalog, config, legacyReadOnly: true, mixed: false, mode: "LEGACY_READ_ONLY", hasLegacySnapshots: true, allowLegacyOptions: true, filterRevision: "3", catalogRevision: "7", ruleReleaseId: null } as unknown as Parameters<typeof publicFilterMetadata>[0];
const baseQuery: ListingQueryV2 = { queryVersion: 2, gameId: "game_x", q: null, filters: {}, sort: "latest", direction: "DESC", coreItemId: null, limit: 20, cursor: null, filterRevision: null, catalogRevision: null, ruleReleaseId: null };
const fakeClient = { query: async () => ({ rows: [] }) } as unknown as PoolClient;

test("legacy read metadata exposes the configured fields, real revision and plain sort labels", () => {
  const metadata = publicFilterMetadata(legacyState, true) as ReturnType<typeof publicFilterMetadata> & { readMode?: string };
  assert.equal(metadata.readMode, "LEGACY_READ_ONLY");
  assert.equal(metadata.available, true);
  assert.equal(metadata.filterRevision, "3");
  assert.equal(metadata.ruleReleaseId, null);
  assert.equal(metadata.resourceQuantityRange, true);
  assert.deepEqual(metadata.fields.map((field) => field.key), ["resources", "safeBoxCodes", "vitality", "serviceWindow"]);
  assert.deepEqual(metadata.sorts.map((sort) => [sort.key, sort.label]), [["latest", "更新时间"], ["resourceTotal", "资源费用"], ["coreQuantity", "核心数量"]]);
  assert.equal(metadata.defaultSort.label, "更新时间");
  const unavailable = publicFilterMetadata({ ...legacyState, config: null } as typeof legacyState, true);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reasonCode, "FILTERS_UNCONFIGURED");
  assert.deepEqual(unavailable.fields, []);
});

test("legacy read configuration accepts known source codes and configured levels without a pricing rule", () => {
  validateConfigCatalog(config, catalog as never, true);
  assert.throws(() => validateConfigCatalog(config, catalog as never, false));
});

test("legacy read query validation rejects conditions outside the configured contract", async () => {
  await validateListingQuery(fakeClient, { ...baseQuery, filters: { resources: [{ itemId: "item_haff", minQuantity: "1000000000" }], safeBoxCodes: ["safe_box_3x3"], vitality: { min: 7 } } }, legacyState);
  await assert.rejects(() => validateListingQuery(fakeClient, { ...baseQuery, filters: { safeBoxCodes: ["safe_box_1x2"] } }, legacyState));
  await assert.rejects(() => validateListingQuery(fakeClient, { ...baseQuery, filters: { vitality: { min: 4 } } }, legacyState));
  await assert.rejects(() => validateListingQuery(fakeClient, { ...baseQuery, sort: "coreQuantity", coreItemId: "item_other" }, legacyState));
  const withoutRule = { ...legacyState, legacyReadOnly: false, mixed: false, mode: "NATIVE", allowLegacyOptions: false, ruleReleaseId: null } as typeof legacyState;
  await assert.rejects(() => validateListingQuery(fakeClient, baseQuery, withoutRule));
});

test("legacy candidate SQL applies shared predicates to the observation attributes and explicit sort keys", () => {
  const query: ListingQueryV2 = { ...baseQuery, q: "846M", filters: { resources: [{ itemId: "item_haff", minQuantity: "1000000000" }], regions: [{ province: "北京市", city: "丰台区" }] } };
  const { text, values } = buildLegacyListingCandidates(query, null);
  assert.match(text, /legacy_listing_read_snapshot/);
  assert.match(text, /\(COALESCE\(d\.snapshot->'attributes',v\.attributes\)\)->>'region_province'/);
  assert.match(text, /l\.item_id=\$3 AND l\.quantity>=\$4/);
  assert.match(text, /v\.title ILIKE/);
  assert.deepEqual(values, ["game_x", "%846M%", "item_haff", "1000000000", "北京市", "丰台区"]);
  const seek = buildLegacyListingCandidates(query, { id: "account_1", key: "2026-09-13T09:39:21.000000Z", isNull: false });
  assert.match(seek.text, /sort_key < \$\d+::timestamptz/);
  const price = buildLegacyListingCandidates({ ...baseQuery, sort: "resourceTotal" }, null);
  assert.match(price.text, /haffRentYuan/);
  assert.match(price.text, /goodsYuan/);
  const core = buildLegacyListingCandidates({ ...baseQuery, sort: "coreQuantity", coreItemId: "item_haff" }, null);
  assert.match(core.text, /l\.item_id=\$2/);
  assert.equal(legacyListingSortLabel("latest", "最新发布"), "更新时间");
  assert.equal(legacyListingSortLabel("resourceTotal", "资源总价"), "资源费用");
  assert.equal(legacyListingSortLabel("coreQuantity", "核心数量"), "核心数量");
  assert.match(text, /h\.source_status=3/);
  assert.match(text, /a\.legacy_hold IN \('NONE','UNRESOLVED'\)/);
  assert.match(text, /COALESCE\(us\.age_status,'UNKNOWN'\)='ADULT'/);
  assert.match(text, /NOT EXISTS \(SELECT 1 FROM zzsh_supply\.listing_publication/);
  const mixed = buildMixedListingCandidates(query, null);
  assert.match(mixed.text, /h\.source_status=3/);
  assert.match(mixed.text, new RegExp(LEGACY_NATIVE_TAKEOVER_GUARD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("non-public source statuses stay out of public reads and conflict on replay", () => {
  for (const status of [0, 3, 4, 5]) assert.equal(legacyReadSourceAllowed(status, false), true);
  for (const status of [-1, 1, 2, 6, 3.5]) assert.equal(legacyReadSourceAllowed(status, false), false);
  assert.equal(legacyReadSourceAllowed(3, true), false);
  assert.match(legacySnapshotReplaySql(), /source_status/);
  const old = {
    observation_version_id: "observation", source_system: "legacy_mysql_restore", source_entity: "la_rental_accounts",
    legacy_id: "1", source_digest: "a".repeat(64), source_status: 3, source_updated_at: new Date("2026-01-01T00:00:00.000Z"),
    evidence_ref: "frozen", snapshot: valid,
  };
  const next = {
    observationVersionId: "observation", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts",
    legacyId: "1", sourceDigest: "a".repeat(64), sourceStatus: 3, sourceUpdatedAt: "2026-01-01T00:00:00.000Z", evidenceRef: "frozen",
  };
  assert.equal(legacySnapshotConflicts(old, next, valid), false);
  assert.equal(legacySnapshotConflicts({ ...old, source_status: 4 }, next, valid), true);
  assert.equal(legacySnapshotConflicts(old, { ...next, sourceStatus: 0 }, valid), true);
  const historicalSql = legacyHistoricalReadSql();
  assert.match(historicalSql, /source_status/);
  assert.doesNotMatch(historicalSql, /h\.source_status=3/);
  const saved = projectLegacyHistoricalRead({ source_status: 4, legacy_id: "1", owner_user_id: "owner-1", snapshot: valid });
  assert.equal(saved.sourceStatusPublicCandidate, false);
  assert.equal("publicRead" in saved, false);
  assert.equal(saved.canCreateOrder, false);
  assert.equal(saved.trade, "UNKNOWN");
  assert.equal(saved.sourceStatus, 4);
  assert.equal(saved.resourceNo, "SOURCE-1");
  assert.equal(projectLegacyHistoricalRead({ source_status: 3, legacy_id: "1", owner_user_id: "owner-1", snapshot: valid }).sourceStatusPublicCandidate, true);
});

// F1: a configured game keeps its filter capability when the visible result set
// is empty; only the SQL visibility filter decides what is projected.
test("configured legacy mode survives zero visible rows and still returns an authorized empty result", async () => {
  const { readListingState } = await import("../src/supply/listing-filter-config");
  const stub = (snapshotRows: boolean) => ({
    query: async (sql: string) => {
      if (sql.includes("legacy_listing_read_snapshot")) return { rows: snapshotRows ? [{ one: 1 }] : [], rowCount: snapshotRows ? 1 : 0 };
      if (sql.includes("AS \"gameId\"") && sql.includes("service_code")) return { rows: [{ id: "service", gameId: "game_x", gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1" }] };
      if (sql.includes("AS \"catalogRevision\"")) return { rows: [{ id: "game_x", code: "delta", catalogRevision: "7", ruleReleaseId: null, rule: null }] };
      if (sql.includes("billable_item")) return { rows: catalog.items };
      if (sql.includes("skin_category")) return { rows: [] };
      if (sql.includes("listing_filter_config")) return { rows: [{ revision: "3", config }] };
      throw new Error("unexpected query: " + sql);
    },
  }) as unknown as PoolClient;
  for (const visibleRows of [true, false]) {
    const state = await readListingState(stub(visibleRows), "game_x");
    const metadata = publicFilterMetadata(state, true) as ReturnType<typeof publicFilterMetadata> & { readMode?: string };
    assert.equal(state.legacyReadOnly, true, `legacy mode must not depend on visibility (${visibleRows})`);
    assert.equal(metadata.available, true);
    assert.equal(metadata.reasonCode, null);
    await validateListingQuery(stub(visibleRows), baseQuery, state);
  }
});
