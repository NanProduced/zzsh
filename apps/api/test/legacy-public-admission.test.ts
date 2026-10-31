import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolClient } from "pg";
import {
  LEGACY_DISPLAY_HOLD_STATES,
  classifyPublicDisplay,
  coreIdentityDisplayable,
  evaluatePublicDisplayGuard,
  legacyEvidenceReferenceValid,
  legacyAdmissionSql,
  parseLegacyPublicAdmission,
  assertLegacyPublicAdmissionTarget,
  loadLegacyPublicAdmission,
  loadLegacyPublicAdmissionManifest,
  admissionForAccount,
  legacyHoldDisplayable,
  publicTextPrivacyIssues,
  type PublicDisplayCaseInput,
} from "../src/legacy-load/legacy-public-admission";
import {
  LEGACY_NATIVE_TAKEOVER_GUARD,
  buildLegacyListingCandidates,
  buildMixedListingCandidates,
  mixedListingBinding,
  parseLegacyReadSnapshot,
  projectLegacyHistoricalRead,
  readLegacyListing,
  withoutLegacyResourceNo,
} from "../src/supply/legacy-listing-read";
import { assertEditable, evaluatePublication, publicationBlockers } from "../src/supply/publishing";
import { createReservation } from "../src/order/order";
import type { ListingQueryV2 } from "../src/supply/listing-filter-contract";

const EVIDENCE = "legacy-migration-preflight-20261006:la_rental_accounts:34418";

const approvedFixture = () => ({
  schema: "legacy-public-admission-v1", sourceBatchSha256: "a".repeat(64),
  resource: { database: "review_db", oid: 123, marker: "review", runtimeRole: "review_r" },
  records: [{ accountId: "account_1", ownerUserId: "owner_1", gameId: "game-1", observationVersionId: "version-1", sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: "34418", sourceDigest: "b".repeat(64), evidenceRef: EVIDENCE, sourceUpdatedAt: "2026-01-01T00:00:00.000Z", snapshot: { resourceNo: "A-1" }, title: "历史资料", description: null, attributes: {} }],
});

test("reviewed capability rejects malformed/empty records and binds the actual database", async () => {
  const input=approvedFixture(), parsed=parseLegacyPublicAdmission(input);
  input.records[0]!.sourceDigest="c".repeat(64);
  assert.equal(parsed.records[0]!.sourceDigest,"b".repeat(64));
  for(const broken of [{...approvedFixture(),records:[]},{...approvedFixture(),records:[...approvedFixture().records,...approvedFixture().records]},{...approvedFixture(),sourceBatchSha256:"not-a-digest"}])assert.throws(()=>parseLegacyPublicAdmission(broken));
  const same={query:async()=>({rows:[parsed.resource]})};
  await assertLegacyPublicAdmissionTarget(same as never,parsed);
  await assert.rejects(()=>assertLegacyPublicAdmissionTarget({query:async()=>({rows:[{...parsed.resource,oid:456}]})} as never,parsed),/TARGET_MISMATCH/);
});

test("local capability loading requires pinned bytes, a private path and a test assembly", () => {
  const dir=mkdtempSync(join(tmpdir(),"zzsh-admission-"));mkdirSync(join(dir,".secrets"));
  const bytes=JSON.stringify(approvedFixture()), file=join(dir,".secrets","admission.json"),outside=join(dir,"outside.json");
  writeFileSync(file,bytes);writeFileSync(outside,bytes);
  const env={APP_PROFILE:"test",NODE_ENV:"test",LEGACY_PUBLIC_ADMISSION_FILE:".secrets/admission.json",LEGACY_PUBLIC_ADMISSION_SHA256:createHash("sha256").update(bytes).digest("hex")};
  try{
    assert.equal(loadLegacyPublicAdmission({},dir),undefined);
    assert.equal(loadLegacyPublicAdmission(env,dir)!.records.length,1);
    assert.throws(()=>loadLegacyPublicAdmission({...env,NODE_ENV:"production"},dir),/LOCAL_ONLY/);
    assert.throws(()=>loadLegacyPublicAdmission({...env,LEGACY_PUBLIC_ADMISSION_FILE:outside},dir),/PATH/);
    assert.throws(()=>loadLegacyPublicAdmission({...env,LEGACY_PUBLIC_ADMISSION_SHA256:"0".repeat(64)},dir),/DIGEST/);
  }finally{unlinkSync(file);unlinkSync(outside);rmdirSync(join(dir,".secrets"));rmdirSync(dir);}
});

test("exact admission constrains both candidate paths and invalidates old cursors", () => {
  const approved=parseLegacyPublicAdmission(approvedFixture());
  for(const builder of [buildLegacyListingCandidates,buildMixedListingCandidates]){
    const sql=builder(legacyQuery(),null,approved);
    assert.ok(sql.values.includes(JSON.stringify(approved.records)));
    assert.match(sql.text,/approved\."ownerUserId"=a\.owner_user_id/);
    assert.match(sql.text,/approved\."sourceDigest"=h\.source_digest/);
    assert.match(sql.text,/approved\.snapshot=h\.snapshot/);
  }
  const revisions={filterRevision:"1",catalogRevision:"9",ruleReleaseId:"release-1"};
  const changed=parseLegacyPublicAdmission({...approvedFixture(),sourceBatchSha256:"c".repeat(64)});
  assert.notEqual(mixedListingBinding(legacyQuery(),revisions,approved).queryHash,mixedListingBinding(legacyQuery(),revisions,changed).queryHash);
});

const baseInput = (): PublicDisplayCaseInput => ({
  source: { reason: null, sourceStatus: "3", evidenceRef: EVIDENCE },
  account: {
    legacyHold: "UNRESOLVED", lifecycle: "ACTIVE", ownerPaused: false, staffRestricted: false,
    hasPublication: false, gameEnabled: true, serviceEnabled: true,
  },
  owner: { suspended: false, accountStatus: "ACTIVE", ageStatus: "ADULT" },
  flags: { highRiskOwner: false, privacyCodes: [] },
});

test("public display admission keeps reasons mutually exclusive and ordered", () => {
  const cases: Array<[string, (input: PublicDisplayCaseInput) => void, string, string]> = [
    ["soft deleted source is never public", (i) => { i.source.reason = "SOURCE_DELETED"; }, "NOT_PUBLIC", "SOURCE_SOFT_DELETED"],
    ["out of scope source status is never public", (i) => { i.source.reason = "STATUS_NOT_READ_SCOPE"; }, "NOT_PUBLIC", "SOURCE_STATUS_OUT_OF_SCOPE"],
    ["non public source status wins over later pending facts", (i) => { i.source.sourceStatus = "4"; i.flags.privacyCodes = ["MAINLAND_MOBILE"]; }, "NOT_PUBLIC", "SOURCE_STATUS_4_NOT_PUBLIC"],
    ["status 0 stays historical, not public", (i) => { i.source.sourceStatus = 0; }, "NOT_PUBLIC", "SOURCE_STATUS_0_NOT_PUBLIC"],
    ["owner not active at import is not public", (i) => { i.source.reason = "OWNER_NOT_ACTIVE"; }, "NOT_PUBLIC", "OWNER_NOT_ACTIVE_AT_IMPORT"],
    ["import layer reasons still win over missing facts", (i) => { i.source.reason = "OWNER_NOT_ACTIVE"; i.source.sourceStatus = null; }, "NOT_PUBLIC", "OWNER_NOT_ACTIVE_AT_IMPORT"],
    ["mobile duplicate owner stays pending", (i) => { i.source.reason = "OWNER_MOBILE_DUPLICATE"; }, "PENDING_REVIEW", "OWNER_MOBILE_DUPLICATE_PENDING"],
    ["incomplete source fields stay pending", (i) => { i.source.reason = "SNAPSHOT_INCOMPLETE"; }, "PENDING_REVIEW", "SOURCE_FIELD_INCOMPLETE"],
    ["archived account is not public", (i) => { i.account.lifecycle = "ARCHIVED"; }, "NOT_PUBLIC", "ACCOUNT_LIFECYCLE_NOT_ACTIVE"],
    ["owner paused account is not public", (i) => { i.account.ownerPaused = true; }, "NOT_PUBLIC", "OWNER_PAUSED"],
    ["staff restricted account is not public", (i) => { i.account.staffRestricted = true; }, "NOT_PUBLIC", "STAFF_RESTRICTED"],
    ["suspended owner is not public", (i) => { i.owner.suspended = true; }, "NOT_PUBLIC", "OWNER_SUSPENDED"],
    ["frozen owner account status is not public", (i) => { i.owner.accountStatus = "FROZEN"; }, "NOT_PUBLIC", "OWNER_ACCOUNT_STATUS_NOT_ACTIVE"],
    ["native publication takes the account over", (i) => { i.account.hasPublication = true; }, "NOT_PUBLIC", "NATIVE_TAKEOVER"],
    ["disabled game or service is not public", (i) => { i.account.serviceEnabled = false; }, "NOT_PUBLIC", "GAME_OR_SERVICE_DISABLED"],
    ["active legacy hold stays pending", (i) => { i.account.legacyHold = "ACTIVE_LEGACY"; }, "PENDING_REVIEW", "LEGACY_HOLD_ACTIVE_LEGACY"],
    ["privacy hits stay pending before display", (i) => { i.flags.privacyCodes = ["CONTACT_KEYWORD"]; }, "PENDING_REVIEW", "CORE_IDENTITY_PRIVACY_PENDING"],
    ["non adult core identity stays pending", (i) => { i.owner.ageStatus = "MINOR"; }, "PENDING_REVIEW", "OWNER_AGE_IDENTITY_PENDING"],
    ["unknown age identity stays pending", (i) => { i.owner.ageStatus = "UNKNOWN"; }, "PENDING_REVIEW", "OWNER_AGE_IDENTITY_PENDING"],
    ["high risk owner stays pending", (i) => { i.flags.highRiskOwner = true; }, "PENDING_REVIEW", "OWNER_HIGH_RISK_PENDING_DECISION"],
    ["unmapped hold state stays pending", (i) => { i.account.legacyHold = "SOMETHING_ELSE"; }, "PENDING_REVIEW", "LEGACY_HOLD_UNMAPPED"],
    ["missing source status fails closed", (i) => { i.source.sourceStatus = null; }, "PENDING_REVIEW", "SOURCE_STATUS_UNKNOWN_PENDING"],
    ["undefined source status fails closed", (i) => { i.source.sourceStatus = undefined as never; }, "PENDING_REVIEW", "SOURCE_STATUS_UNKNOWN_PENDING"],
    ["empty source status fails closed", (i) => { i.source.sourceStatus = ""; }, "PENDING_REVIEW", "SOURCE_STATUS_UNKNOWN_PENDING"],
    ["unbound evidence fails closed", (i) => { i.source.evidenceRef = "legacy-migration-preflight-202606:la_order:1"; }, "PENDING_REVIEW", "EVIDENCE_BATCH_UNBOUND_PENDING"],
    ["missing evidence fails closed", (i) => { i.source.evidenceRef = undefined; }, "PENDING_REVIEW", "EVIDENCE_BATCH_UNBOUND_PENDING"],
    ["missing age evidence fails closed", (i) => { i.owner.ageStatus = undefined; }, "PENDING_REVIEW", "OWNER_AGE_IDENTITY_PENDING"],
    ["unresolved hold may still be displayed read only", () => {}, "DISPLAY_CANDIDATE", "SOURCE_STATUS_3_SAFE_TEXT"],
    ["resolved hold may be displayed read only", (i) => { i.account.legacyHold = "NONE"; }, "DISPLAY_CANDIDATE", "SOURCE_STATUS_3_SAFE_TEXT"],
  ];
  for (const [name, mutate, bucket, reason] of cases) {
    const input = baseInput();
    mutate(input);
    const verdict = classifyPublicDisplay(input);
    assert.deepEqual(verdict, { bucket, reason }, name);
  }
});

test("hold and identity helpers never fold unknown values into a default class", () => {
  assert.deepEqual([...LEGACY_DISPLAY_HOLD_STATES], ["NONE", "UNRESOLVED"]);
  assert.equal(legacyHoldDisplayable("NONE"), true);
  assert.equal(legacyHoldDisplayable("UNRESOLVED"), true);
  assert.equal(legacyHoldDisplayable("ACTIVE_LEGACY"), false);
  for (const value of [null, undefined, "", 0, "none", { toString: () => "NONE" }])
    assert.equal(legacyHoldDisplayable(value as never), false, String(value));
  assert.equal(coreIdentityDisplayable("ADULT"), true);
  for (const value of ["MINOR", "UNKNOWN", null, undefined, "adult"])
    assert.equal(coreIdentityDisplayable(value), false, String(value));
});

test("public text privacy scan flags contacts and credentials without false positives", () => {
  assert.deepEqual(publicTextPrivacyIssues("联系我 13812345678 详谈"), ["MAINLAND_MOBILE"]);
  assert.deepEqual(publicTextPrivacyIssues("微信号 abc123"), ["CONTACT_KEYWORD"]);
  assert.deepEqual(publicTextPrivacyIssues("账号密码见私聊"), ["CREDENTIAL_KEYWORD"]);
  assert.deepEqual(publicTextPrivacyIssues("身份证 11010519900101123X"), ["CN_ID_CARD"]);
  assert.deepEqual(publicTextPrivacyIssues(""), []);
  assert.deepEqual(publicTextPrivacyIssues(null), []);
  assert.deepEqual(publicTextPrivacyIssues("编号 A-12345 租期 3 天 押金 99.00"), []);
  assert.deepEqual(publicTextPrivacyIssues("1 天 2 小时"), []);
});

test("runtime display guard binds evidence and fails closed on privacy text", () => {
  assert.equal(legacyEvidenceReferenceValid(EVIDENCE), true);
  for (const ref of [null, undefined, "", "legacy-migration-preflight-202606:la_rental_accounts:", "other-batch:la_rental_accounts:1", 123])
    assert.equal(legacyEvidenceReferenceValid(ref), false, String(ref));
  assert.equal(legacyAdmissionSql(undefined, () => { throw Error("unexpected param"); }), "(a.legacy_hold='NONE' AND d.account_id IS NULL)");
  assert.deepEqual(evaluatePublicDisplayGuard({ title: "历史资料待核实", description: null, evidenceRef: EVIDENCE }), { ok: true });
  assert.deepEqual(
    evaluatePublicDisplayGuard({ title: "历史资料待核实", description: "加微信 abc123", evidenceRef: EVIDENCE }),
    { ok: false, reason: "CORE_IDENTITY_PRIVACY_PENDING" },
  );
  assert.deepEqual(
    evaluatePublicDisplayGuard({ title: "密码：123456", description: null, evidenceRef: EVIDENCE }),
    { ok: false, reason: "CORE_IDENTITY_PRIVACY_PENDING" },
  );
  assert.deepEqual(
    evaluatePublicDisplayGuard({ title: "历史资料待核实", description: null, evidenceRef: "legacy-migration-preflight-202606:la_order:1" }),
    { ok: false, reason: "EVIDENCE_BATCH_UNBOUND" },
  );
  // Missing facts fail closed instead of displaying by default.
  assert.deepEqual(evaluatePublicDisplayGuard({ title: null, description: null, evidenceRef: null }), { ok: false, reason: "EVIDENCE_BATCH_UNBOUND" });
});

const legacyQuery = (overrides: Partial<ListingQueryV2> = {}): ListingQueryV2 => ({
  queryVersion: 2, gameId: "game-1", q: null, filters: {}, sort: "latest", direction: "DESC",
  coreItemId: null, limit: 20, cursor: null, filterRevision: "1", catalogRevision: "9", ruleReleaseId: null,
  ...overrides,
});

test("legacy public SQL widens hold display only and keeps every other guard", () => {
  const legacy = buildLegacyListingCandidates(legacyQuery(), null).text;
  const mixed = buildMixedListingCandidates(legacyQuery(), null).text;
  for (const [name, sql] of [["legacy", legacy], ["mixed", mixed]] as const) {
    assert.match(sql, /a\.legacy_hold IN \('NONE','UNRESOLVED'\)/, name);
    assert.match(sql, /h\.source_status=3/, name);
    assert.match(sql, /COALESCE\(us\.account_status,'ACTIVE'\)='ACTIVE'/, name);
    assert.match(sql, /COALESCE\(us\.age_status,'UNKNOWN'\)='ADULT'/, name);
    assert.match(sql, /a\.legacy_hold='NONE'/, name);
    assert.ok(sql.includes(LEGACY_NATIVE_TAKEOVER_GUARD), name);
    for (const state of LEGACY_DISPLAY_HOLD_STATES) assert.ok(sql.includes(`'${state}'`), `${name}:${state}`);
  }
  // Missing reviewed capability preserves the pre-existing NONE-only boundary.
  assert.match(legacy, /a\.legacy_hold='NONE'/);
  assert.match(mixed, /a\.legacy_hold='NONE'/);
  assert.match(mixed, /DISTINCT ON \(id\)/);
  assert.match(mixed, /priority/);
  // Public search no longer matches or exposes the old resource number.
  const legacySearched = buildLegacyListingCandidates(legacyQuery({ q: "A-1" }), null).text;
  const mixedSearched = buildMixedListingCandidates(legacyQuery({ q: "A-1" }), null).text;
  assert.doesNotMatch(legacySearched, /resourceNo/);
  assert.doesNotMatch(mixedSearched, /resourceNo/);
  assert.match(legacySearched, /h\.source_status=3/);
  assert.match(legacySearched, /v\.title ILIKE/);
});

test("frozen historical amounts are shown verbatim and never recomputed", () => {
  const snapshot = parseLegacyReadSnapshot({
    schema: "legacy-listing-read-v1", resourceNo: "A-1", haffRentYuan: "12.30", goodsYuan: "0.40",
    depositYuan: "99.00", termDays: "3", dailyHaffBase: "20000000",
  });
  const projected = projectLegacyHistoricalRead({ source_status: 3, legacy_id: "37017", owner_user_id: "owner-1", snapshot });
  assert.deepEqual(projected.historicalQuote, {
    haffRentYuan: "12.30", goodsYuan: "0.40", depositYuan: "99.00", termDays: "3", dailyHaffBase: "20000000",
  });
  assert.equal(projected.canCreateOrder, false);
  assert.equal(projected.trade, "UNKNOWN");
  // Missing or malformed values are rejected instead of being zero-filled or re-derived.
  for (const patch of [
    { haffRentYuan: "12.3" }, { haffRentYuan: "0" }, { goodsYuan: "1" }, { depositYuan: "" },
    { termDays: "0" }, { dailyHaffBase: "1.5" }, { resourceNo: "" },
  ]) {
    assert.throws(() => parseLegacyReadSnapshot({ ...snapshot, ...patch }), JSON.stringify(patch));
  }
});

function legacyProjectionClient(row: Record<string, unknown>) {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM zzsh_supply.legacy_listing_read_snapshot h")) return { rows: [row], rowCount: 1 };
      if (sql.includes("FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM zzsh_supply.listing_skin ls")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM zzsh_supply.listing_media m")) return { rows: [], rowCount: 0 };
      throw Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
}

function legacyProjectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "account_1", owner_user_id: "owner-1", game_id: "game-1", game_code: "delta", game_name: "三角洲行动", version_id: "version-1",
    source_status: 3, owner_paused: false,
    title: "历史资料待核实", description: null,
    attributes: {},
    snapshot: {
      schema: "legacy-listing-read-v1", resourceNo: "A-1", haffRentYuan: "12.30", goodsYuan: "0.40",
      depositYuan: "99.00", termDays: "3", dailyHaffBase: "20000000",
    },
    source_updated_at: new Date("2026-01-02T03:04:05.678Z"),
    evidence_ref: EVIDENCE,
    ...overrides,
  };
}

test("legacy public listing projection stays read only and leaks no private evidence", async () => {
  const listing = await readLegacyListing(legacyProjectionClient(legacyProjectionRow()), "account_1");
  assert.equal(listing.source, "LEGACY_READ_ONLY");
  assert.equal(listing.canCreateOrder, false);
  assert.equal(listing.quote, null);
  assert.equal(listing.displayNo, null);
  assert.deepEqual(listing.historicalQuote, {
    haffRent: { currency: "CNY", unit: "yuan", amount: "12.30", scale: 2 },
    goods: { currency: "CNY", unit: "yuan", amount: "0.40", scale: 2 },
    deposit: { currency: "CNY", unit: "yuan", amount: "99.00", scale: 2 },
    termDays: "3",
  });
  assert.equal(listing.termOption.displayName, "3 天");
  const wire = JSON.stringify(listing);
  for (const forbidden of ["ownerUserId", "owner_user_id", "evidenceRef", "evidence_ref", "sourceDigest", "source_digest", "legacyId", "legacy_id", "legacy_hold", "legacyHold"])
    assert.equal(wire.includes(forbidden), false, forbidden);
  // Mode is unknown for legacy rows: it is dropped, never defaulted to ordinary/fast.
  assert.equal(Object.hasOwn(listing as Record<string, unknown>, "rentalMode"), false);
  assert.equal(wire.includes("rentalMode"), false);
});

test("historical media uses the same account identity guard and keeps missing pictures readable", async () => {
  const own = { assetId: "own", position: 0, purpose: "ACCOUNT_DISPLAY", ownership_kind: "USER_SUPPLY", account_id: "account_1", owner_user_id: "owner-1", game_id: "game-1" };
  for (const patch of [null, { owner_user_id: "foreign" }, { account_id: "foreign" }, { game_id: "foreign" }, { ownership_kind: "PLATFORM_CATALOG" }]) {
    const base = legacyProjectionClient(legacyProjectionRow());
    const rows = patch === null ? [own] : [{ ...own, ...patch }];
    const client = { query: async (sql: string, args: unknown[]) => sql.includes('SELECT m.asset_id AS "assetId"') ? { rows, rowCount: rows.length } : base.query(sql, args) } as unknown as PoolClient;
    const listing = await readLegacyListing(client, "account_1");
    assert.deepEqual(listing.media, patch === null ? [{ assetId: "own", position: 0, url: "/api/v1/supply/listings/account_1/media/own" }] : []);
    assert.equal(listing.source, "LEGACY_READ_ONLY"); assert.equal(listing.canCreateOrder, false);
    assert(!JSON.stringify(listing).includes("foreign"));
  }
});

test("legacy public read never chooses a private current native draft over its frozen observation", async () => {
  const observation = legacyProjectionRow(), draft = { ...observation, version_id: "private-current-draft", title: "UNREVIEWED_PRIVATE_DRAFT" };
  const observationClient = legacyProjectionClient(observation);
  const client = { query: async (sql: string) => {
    if (sql.includes("FROM zzsh_supply.legacy_listing_read_snapshot h")) {
      // Model the two persisted versions; actual PostgreSQL join execution is a separate acceptance item.
      const selected = sql.includes("COALESCE(dv.id,ov.id)") ? draft : observation;
      return { rows: [selected], rowCount: 1 };
    }
    return observationClient.query(sql);
  } };
  const listing = await readLegacyListing(client as never, "account_1");
  assert.equal(listing.versionId, "version-1"); assert.equal(listing.title, observation.title);
  assert.equal(listing.displayNo, null); assert.equal(listing.quote, null); assert.equal(listing.canCreateOrder, false);
  assert(!JSON.stringify(listing).includes("UNREVIEWED_PRIVATE_DRAFT"));
});

test("legacy public projection uses only its independently assigned canonical number",async()=>{
 const canonical=await readLegacyListing(legacyProjectionClient(legacyProjectionRow({display_no:'AC0000000001'})),'account_1');
 assert.equal(canonical.displayNo,'AC0000000001');assert.equal(canonical.quote,null);assert.equal(canonical.canCreateOrder,false);
 for(const display_no of ['A-1',null,undefined]){const listing=await readLegacyListing(legacyProjectionClient(legacyProjectionRow({display_no})),'account_1');assert.equal(listing.displayNo,null);}
});

test("v3 binds each added source status; old capability versions never imply extra public states", async () => {
  const row = legacyProjectionRow({ source_status: 4 });
  const original = approvedFixture();
  const v3 = { ...original, schema: "legacy-public-admission-v3", records: original.records.map(record => ({ ...record,
    snapshot: row.snapshot, title: row.title, sourceUpdatedAt: row.source_updated_at.toISOString(), displayDigest: null, sourceStatus: 4 })) };
  const admitted = parseLegacyPublicAdmission(v3);
  const result = await readLegacyListing(legacyProjectionClient(row), "account_1", admitted);
  assert.equal(result.canCreateOrder, false); assert.equal(result.quote, null); assert.equal(result.sourceAvailability.state, "OFFLINE");
  assert.equal(result.availability.state, "LEGACY_READ_ONLY");
  await assert.rejects(readLegacyListing(legacyProjectionClient(row), "account_1", parseLegacyPublicAdmission(original)), (e: any) => e.status === 404);
  await assert.rejects(readLegacyListing(legacyProjectionClient(row), "account_1"), (e: any) => e.status === 404);
  for (const status of [0, 1, 2, 7, undefined, "4"]) assert.throws(() => parseLegacyPublicAdmission({ ...v3, records: v3.records.map(record => ({ ...record, sourceStatus: status })) }));
  assert.throws(() => parseLegacyPublicAdmission({ ...v3, schema: "legacy-public-admission-v2" }));
  for (const sourceStatus of [4,5,6]) {
    const capability = parseLegacyPublicAdmission({ ...v3, records: v3.records.map(record => ({ ...record, sourceStatus })) });
    const listing = await readLegacyListing(legacyProjectionClient(legacyProjectionRow({ source_status: sourceStatus })), "account_1", capability);
    assert.equal(listing.canCreateOrder, false); assert.equal(listing.quote, null); assert.equal(listing.availability.state, "LEGACY_READ_ONLY");
  }
});

test("the shared legacy projection fails closed on privacy text and unbound evidence", async () => {
  await assert.rejects(
    () => readLegacyListing(legacyProjectionClient(legacyProjectionRow({ description: "加微信 abc123 联系" })), "account_1"),
    (error: { status?: number }) => error.status === 404,
    "privacy description must not be displayed",
  );
  await assert.rejects(
    () => readLegacyListing(legacyProjectionClient(legacyProjectionRow({ title: "账号密码 123456" })), "account_1"),
    (error: { status?: number }) => error.status === 404,
    "credential title must not be displayed",
  );
  await assert.rejects(
    () => readLegacyListing(legacyProjectionClient(legacyProjectionRow({ evidence_ref: "legacy-migration-preflight-202606:la_order:1" })), "account_1"),
    (error: { status?: number }) => error.status === 404,
    "evidence outside the adjudicated batch must not be displayed",
  );
  await assert.rejects(
    () => readLegacyListing(legacyProjectionClient(legacyProjectionRow({ evidence_ref: null })), "account_1"),
    (error: { status?: number }) => error.status === 404,
    "missing evidence must fail closed",
  );
});

const legacyAccount = {
  id: "account_1", owner_user_id: "owner-1", game_id: "game-1", current_version_id: "version-1",
  lifecycle: "ACTIVE", legacy_hold: "UNRESOLVED", revision: "1", owner_paused: false, staff_restricted: false,
};
const legacyVersion = {
  id: "version-1", account_id: "account_1", origin: "LEGACY_OBSERVATION", review_state: "IMPORTED_UNVERIFIED",
  rule_release_id: null, content_hash: "a".repeat(64), payload: null, attributes: {},
};

function legacyTradeClient() {
  return {
    query: async (sql: string) => {
      if (sql.includes("zzsh_auth_user")) return {
        rows: [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }], rowCount: 1,
      };
      if (sql.includes("SELECT enabled,current_release_id,catalog_revision::text FROM zzsh_supply.game"))
        return { rows: [{ enabled: true, current_release_id: "release-1", catalog_revision: "9" }], rowCount: 1 };
      if (sql.includes("SELECT id, enabled, current_release_id"))
        return { rows: [{ id: "game-1", enabled: true, currentReleaseId: "release-1" }], rowCount: 1 };
      if (sql.includes("game_service_operation"))
        return { rows: [{ id: "service-1", gameId: "game-1", gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1" }], rowCount: 1 };
      if (sql.includes("SELECT * FROM zzsh_supply.rental_account")) return { rows: [legacyAccount], rowCount: 1 };
      if (sql.includes("SELECT * FROM zzsh_supply.listing_version")) return { rows: [legacyVersion], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as never;
}
const tradeGate = async () => ({ publisherBail: "NOT_REQUIRED" as const, occupancy: "FREE" as const, reference: "fixture" });

test("a placeholder title blocks write publication and stays readable", async () => {
  const version = { ...legacyVersion, title: "历史资料待核实" };
  const read = await publicationBlockers(legacyTradeClient(), legacyAccount as never, version as never, tradeGate, "READ");
  const write = await publicationBlockers(legacyTradeClient(), legacyAccount as never, version as never, tradeGate, "WRITE");
  assert.equal(read.includes("TITLE_REVIEW_REQUIRED"), false, JSON.stringify(read));
  assert.equal(write.includes("TITLE_REVIEW_REQUIRED"), true, JSON.stringify(write));
  const visible = await evaluatePublication(legacyTradeClient(), legacyAccount as never, version as never, tradeGate, "READ");
  assert.equal(visible.includes("TITLE_REVIEW_REQUIRED"), false, JSON.stringify(visible));
});

test("publish and edit entries keep rejecting a legacy held account", async () => {
  const blockers = await evaluatePublication(legacyTradeClient(), legacyAccount as never, legacyVersion as never, tradeGate);
  assert.ok(blockers.includes("ACCOUNT_NOT_PUBLISHABLE"), JSON.stringify(blockers));
  await assert.rejects(
    () => assertEditable(legacyTradeClient(), legacyAccount as never, tradeGate),
    (error: { status?: number; message?: string }) => error.status === 409 && String(error.message).includes("历史异常"),
    "edit entry must reject the legacy held account",
  );
});

test("the real order creation entry rejects a legacy account server side", async () => {
  // Legacy observation versions carry no rule release: the create entry refuses
  // before any quote or hold is considered.
  await assert.rejects(
    () => createReservation(legacyTradeClient(), {
      context: { userId: "renter-1", sessionId: "session-1" }, accountId: "account_1", versionId: "version-1",
      releaseId: "release-1", ownerUserId: "owner-1", gameId: "game-1", holdSeconds: 600,
      gate: tradeGate, requestId: "request-1",
    } as never),
    (error: { code?: string; status?: number; message?: string }) => error.status === 409 && String(error.message).includes("规则已更新"),
    "legacy account must fail the rule gate at the order entry",
  );
  // Even with a matching rule release the publication gate fails closed.
  const versionWithRelease = { ...legacyVersion, rule_release_id: "release-1" };
  const client = {
    query: async (sql: string) => {
      if (sql.includes("SELECT id, enabled, current_release_id")) return { rows: [{ id: "game-1", enabled: true, currentReleaseId: "release-1" }], rowCount: 1 };
      if (sql.includes("SELECT * FROM zzsh_supply.rental_account")) return { rows: [legacyAccount], rowCount: 1 };
      if (sql.includes("SELECT * FROM zzsh_supply.listing_version")) return { rows: [versionWithRelease], rowCount: 1 };
      if (sql.includes("zzsh_auth_user")) return {
        rows: [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }], rowCount: 1,
      };
      if (sql.includes("SELECT enabled,current_release_id,catalog_revision::text FROM zzsh_supply.game"))
        return { rows: [{ enabled: true, current_release_id: "release-1", catalog_revision: "9" }], rowCount: 1 };
      if (sql.includes("game_service_operation"))
        return { rows: [{ id: "service-1", gameId: "game-1", gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as never;
  await assert.rejects(
    () => createReservation(client, {
      context: { userId: "renter-1", sessionId: "session-1" }, accountId: "account_1", versionId: "version-1",
      releaseId: "release-1", ownerUserId: "owner-1", gameId: "game-1", holdSeconds: 600,
      gate: tradeGate, requestId: "request-1",
    } as never),
    (error: { status?: number }) => error.status === 404,
    "legacy held account must not become orderable through the create entry",
  );
});

// ---------- v3 detail manifest ----------
const sampleV3Dir = join(process.cwd(), "test/fixtures/legacy-v3-admission-sample");
function v3Record(accountId: string, sourceStatus: 3 | 4 | 5 | 6, overrides: Record<string, unknown> = {}) {
  return { accountId, ownerUserId: "owner_1", gameId: "game-1", observationVersionId: "version-1",
    sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: "34418",
    sourceDigest: "b".repeat(64), evidenceRef: EVIDENCE, sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    snapshot: { resourceNo: "A-1" }, title: "历史资料", description: null, attributes: {},
    displayDigest: null, sourceStatus, ...overrides };
}
function v3Admission(records: Array<Record<string, unknown>>) {
  return { schema: "legacy-public-admission-v3", sourceBatchSha256: "a".repeat(64),
    resource: { database: "review_db", oid: 123, marker: "review", runtimeRole: "review_r" }, records };
}
function writeAdmission(dir: string, name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(join(dir, name), bytes);
  return { path: name, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function writeManifest(dir: string, name: string, shards: Array<{ path: string; sha256: string }>) {
  writeFileSync(join(dir, name), JSON.stringify({ schema: "legacy-public-admission-manifest-v1", shards }));
}
function manifestEnv(file: string) { return { APP_PROFILE: "test", NODE_ENV: "test", LEGACY_PUBLIC_ADMISSION_MANIFEST: ".secrets/" + file }; }

test("v3 detail manifest is local-only, integrity/size/cap/status/duplicate bound, and accepts the generator sample", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-admission-")), secrets = join(dir, ".secrets");
  mkdirSync(secrets);
  for (const name of readdirSync(sampleV3Dir)) copyFileSync(join(sampleV3Dir, name), join(secrets, name));
  const loaded = loadLegacyPublicAdmissionManifest(manifestEnv("manifest.json"), dir);
  assert.equal(loaded?.shards.length, 4); assert.equal(loaded?.index.size, 90);
  const one = admissionForAccount(loaded!.index, "account_sample_001");
  assert.equal(one?.records.length, 1); assert.equal(one?.records[0]!.sourceStatus, 4);
  assert.equal(loadLegacyPublicAdmissionManifest({ APP_PROFILE: "test", NODE_ENV: "test" }, dir), undefined);
  assert.throws(() => loadLegacyPublicAdmissionManifest({ ...manifestEnv("manifest.json"), APP_PROFILE: "dev" }, dir), /LOCAL_ONLY/);
  assert.throws(() => loadLegacyPublicAdmissionManifest({ ...manifestEnv("manifest.json"), NODE_ENV: "production" }, dir), /LOCAL_ONLY/);
  const sample = JSON.parse(readFileSync(join(secrets, "manifest.json"), "utf8"));
  sample.shards[0].sha256 = "0".repeat(64);
  writeFileSync(join(secrets, "manifest.bad-sha.json"), JSON.stringify(sample));
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("manifest.bad-sha.json"), dir), /DIGEST/);
  const s3 = writeAdmission(secrets, "s3.json", v3Admission([v3Record("account_s3", 3)]));
  writeManifest(secrets, "manifest.s3.json", [s3]);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("manifest.s3.json"), dir), /INVALID/);
  const dup = writeAdmission(secrets, "dup.json", v3Admission([v3Record("account_dup", 4)]));
  writeManifest(secrets, "manifest.dup.json", [dup, { ...dup, path: "dup.json" }]);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("manifest.dup.json"), dir), /INVALID/);
  const v2 = v3Admission([v3Record("account_v2", 4)]);
  delete (v2.records[0] as Record<string, unknown>).sourceStatus; (v2 as { schema: string }).schema = "legacy-public-admission-v2";
  const f2 = writeAdmission(secrets, "v2.json", v2); writeManifest(secrets, "manifest.v2.json", [f2]);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("manifest.v2.json"), dir), /INVALID/);
  const huge = writeAdmission(secrets, "huge.json", v3Admission([v3Record("account_huge", 4, { snapshot: { resourceNo: "A-1", pad: "x".repeat(8 * 1024 * 1024) } })]));
  writeManifest(secrets, "manifest.huge.json", [huge]);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("manifest.huge.json"), dir), /SIZE/);
  const many = v3Admission(Array.from({ length: 5001 }, (_, i) => v3Record("account_" + i, 4)));
  const fm = writeAdmission(secrets, "many.json", many); writeManifest(secrets, "manifest.many.json", [fm]);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("manifest.many.json"), dir), /INVALID/);
  const outside = writeAdmission(dir, "outside.json", v3Admission([v3Record("account_out", 4)]));
  writeManifest(secrets, "manifest.outside.json", [{ path: "../outside.json", sha256: outside.sha256 }]);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("manifest.outside.json"), dir), /PATH/);
});

test("v3 detail only sees the matched shard record and labels 4/5/6 without an old number", async () => {
  const record = (status: 4 | 5 | 6) => v3Record("account_1", status, { snapshot: legacyProjectionRow({ source_status: status }).snapshot, title: legacyProjectionRow({ source_status: status }).title });
  const labels: Record<number, string> = { 4: "已下架", 5: "已出租", 6: "待支付占位" };
  for (const status of [4, 5, 6] as const) {
    const admission = parseLegacyPublicAdmission(v3Admission([record(status)]));
    const index = new Map([["account_1", admission]]);
    const listing = await readLegacyListing(legacyProjectionClient(legacyProjectionRow({ source_status: status })), "account_1", undefined, index);
    assert.equal(listing.displayNo, null); assert.equal(listing.canCreateOrder, false);
    assert.equal(listing.sourceAvailabilityLabel, labels[status]);
  }
  const admitted = parseLegacyPublicAdmission(v3Admission([record(4)]));
  const index = new Map([["account_1", admitted]]);
  await assert.rejects(readLegacyListing(legacyProjectionClient(legacyProjectionRow({ source_status: 4 })), "account_other", undefined, index), (e: any) => e.status === 404);
  await assert.rejects(readLegacyListing(legacyProjectionClient(legacyProjectionRow({ source_status: 5 })), "account_1", undefined, index), (e: any) => e.status === 404);
});

test("owner historical projection drops the old resource number", () => {
  assert.deepEqual(withoutLegacyResourceNo({ resourceNo: "A-1", sourceStatus: 4 }), { sourceStatus: 4 });
  assert.equal(withoutLegacyResourceNo(null), null);
});

// ---------- v3 detail manifest: claim review r2 ----------
function capturingLegacyClient(row: Record<string, unknown>) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const inner = legacyProjectionClient(row) as unknown as { query: (sql: string) => Promise<unknown> };
  return { calls, client: { query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return inner.query(sql); } } as unknown as PoolClient };
}
const jsonRecordParams = (values: unknown[]) => values.filter((value): value is string => typeof value === "string" && value.startsWith("["))
  .map(value => JSON.parse(value) as Array<{ accountId: string }>);

test("v3 detail SQL carries only the matched shard record and never replaces the status-3 admission", async () => {
  const row = legacyProjectionRow({ source_status: 4 });
  const shard = parseLegacyPublicAdmission(v3Admission([
    v3Record("account_1", 4, { snapshot: row.snapshot, title: row.title }),
    v3Record("account_2", 5), v3Record("account_3", 6),
  ]));
  const index = new Map(shard.records.map(record => [record.accountId, shard]));
  const hit = capturingLegacyClient(row);
  const listing = await readLegacyListing(hit.client, "account_1", undefined, index);
  assert.equal(listing.sourceAvailabilityLabel, "已下架");
  const detailCall = hit.calls.find(call => call.sql.includes("FROM zzsh_supply.legacy_listing_read_snapshot h"))!;
  const params = jsonRecordParams(detailCall.values);
  assert.equal(params.length, 1, "only the 4/5/6 branch receives admission JSON");
  assert.deepEqual(params[0]!.map(record => record.accountId), ["account_1"], "one matched record, never the whole shard");
  assert.match(detailCall.sql, /h\.source_status=3 AND \(a\.legacy_hold='NONE' AND d\.account_id IS NULL\)\)/, "status 3 stays on its own (absent) admission");
  assert.match(detailCall.sql, /h\.source_status IN\(4,5,6\)/);
  // A miss sends no 4/5/6 branch at all.
  const miss = capturingLegacyClient(legacyProjectionRow({ id: "account_9", source_status: 4 }));
  await assert.rejects(readLegacyListing(miss.client, "account_9", undefined, index), (e: any) => e.status === 404);
  const missCall = miss.calls.find(call => call.sql.includes("FROM zzsh_supply.legacy_listing_read_snapshot h"))!;
  assert.doesNotMatch(missCall.sql, /IN\(4,5,6\)/); assert.equal(jsonRecordParams(missCall.values).length, 0);
});

test("v3 public detail carries no old resource number anywhere in the response", async () => {
  for (const status of [4, 5, 6] as const) {
    const row = legacyProjectionRow({ source_status: status });
    const shard = parseLegacyPublicAdmission(v3Admission([v3Record("account_1", status, { snapshot: row.snapshot, title: row.title })]));
    const listing = await readLegacyListing(legacyProjectionClient(row), "account_1", undefined, new Map([["account_1", shard]]));
    const body = JSON.stringify(listing);
    assert.equal(listing.displayNo, null);
    assert.doesNotMatch(body, /resourceNo/); assert.doesNotMatch(body, /"A-1"/);
  }
});

test("list and mixed list SQL stay status-3 only even with a v3 admission carrying 4/5/6", () => {
  const v3 = parseLegacyPublicAdmission(v3Admission([v3Record("account_4", 4), v3Record("account_5", 5), v3Record("account_6", 6)]));
  for (const built of [buildLegacyListingCandidates(legacyQuery(), null, v3), buildMixedListingCandidates(legacyQuery(), null, v3)]) {
    assert.match(built.text, /h\.source_status=3/);
    assert.doesNotMatch(built.text, /source_status IN ?\(4,5,6\)/);
    assert.doesNotMatch(built.text, /resourceNo/);
  }
});

test("v3 manifest rejects malformed manifests, mixed resources and accepts exactly 5000 records", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-admission-r2-")), secrets = join(dir, ".secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "m.badschema.json"), JSON.stringify({ schema: "legacy-public-admission-manifest-v0", shards: [] }));
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("m.badschema.json"), dir), /INVALID/);
  writeManifest(secrets, "m.empty.json", []);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("m.empty.json"), dir), /INVALID/);
  writeFileSync(join(secrets, "m.notjson.json"), "{");
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("m.notjson.json"), dir), /INVALID/);
  const a = writeAdmission(secrets, "a.json", v3Admission([v3Record("account_a", 4)]));
  const other = v3Admission([v3Record("account_b", 5)]); other.resource = { ...other.resource, oid: 999 };
  const b = writeAdmission(secrets, "b.json", other);
  writeManifest(secrets, "m.mixed.json", [a, b]);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("m.mixed.json"), dir), /INVALID/);
  writeManifest(secrets, "m.badhex.json", [{ ...a, sha256: "Z".repeat(64) }]);
  assert.throws(() => loadLegacyPublicAdmissionManifest(manifestEnv("m.badhex.json"), dir), /INVALID/);
  const exact = writeAdmission(secrets, "exact.json", v3Admission(Array.from({ length: 5000 }, (_, i) => v3Record("account_x" + i, 5))));
  writeManifest(secrets, "m.exact.json", [exact]);
  const loaded = loadLegacyPublicAdmissionManifest(manifestEnv("m.exact.json"), dir)!;
  assert.equal(loaded.index.size, 5000);
  assert.equal(admissionForAccount(loaded.index, "account_x4999")?.records.length, 1);
  assert.equal(admissionForAccount(loaded.index, "account_missing"), undefined);
  // The manifest itself must live in .secrets.
  writeFileSync(join(dir, "m.outside.json"), JSON.stringify({ schema: "legacy-public-admission-manifest-v1", shards: [a] }));
  assert.throws(() => loadLegacyPublicAdmissionManifest({ ...manifestEnv("x"), LEGACY_PUBLIC_ADMISSION_MANIFEST: "m.outside.json" }, dir), /PATH/);
});

// SKIN-CATALOG-INTEGRATION-6: migrated accounts read the same public skin summary as
// catalog pages and publish snapshots; non-public declared references are counted, not named.
test("legacy account skins carry the shared public summary and count withheld references", async () => {
  const seen: string[] = [];
  const skinRows = [
    { id: "skin_luna", name: "露娜-黑·天际线", baseName: "黑·天际线", ownerName: "露娜", mediaId: "asset_public", categoryCode: "df_skin_category_agent", categoryName: "干员外观", visible: true, isPublic: true },
    { id: "skin_pending", name: "PENDING_PRIVATE_TOKEN", baseName: null, ownerName: null, mediaId: null, categoryCode: "df_skin_category_knife", categoryName: "近战外观", visible: false, isPublic: false },
  ];
  const base = legacyProjectionClient(legacyProjectionRow());
  const client = { query: async (sql: string) => {
    if (sql.includes("FROM zzsh_supply.listing_skin ls")) { seen.push(sql); return { rows: skinRows, rowCount: skinRows.length }; }
    return base.query(sql);
  } } as unknown as PoolClient;
  const listing = await readLegacyListing(client, "account_1");
  assert.deepEqual(listing.presentation.skins, [{ id: "skin_luna", name: "露娜-黑·天际线", baseName: "黑·天际线", ownerName: "露娜", ownerKind: null, rarityCode: null, rarityName: null, rarityBasis: null, isCollectible: null, defaultState: "UNKNOWN", mediaKind: null, mediaId: "asset_public", categoryCode: "df_skin_category_agent", categoryName: "干员外观" }]);
  assert.equal((listing.presentation as { skinsWithheld?: number }).skinsWithheld, 1);
  assert.equal(JSON.stringify(listing).includes("PENDING_PRIVATE_TOKEN"), false);
  assert.match(seen[0]!, /purpose='SKIN_MEDIA' AND a\.review_state='APPROVED' AND a\.access_class='PUBLIC_DISPLAY' AND a\.public_storage_key IS NOT NULL/);
  assert.doesNotMatch(seen[0]!, /WHERE ls\.version_id=\$1 AND s\.enabled/, "withheld references are counted, not silently filtered");

  skinRows.pop();
  const complete = await readLegacyListing(client, "account_1");
  assert.equal(Object.hasOwn(complete.presentation, "skinsWithheld"), false);
  assert.equal(complete.canCreateOrder, false);
  assert.equal(complete.quote, null);
});

// SK6-R1-04: the current-catalog skin summary on a legacy account follows the public
// catalog's effective visibility (same game, category and every ancestor public).
// The fake client evaluates the visibility the SQL asks for; it is not PostgreSQL.
test("SK6-R1-04 legacy account skins withhold hidden categories, disabled and cross-game skins by count only", async () => {
  type Cat = { parent: string | null; enabled: boolean; formVisible: boolean };
  const run = async (change: (cats: Map<string, Cat>, skin: { gameId: string; enabled: boolean; formVisible: boolean }) => void) => {
    const cats = new Map<string, Cat>([["root", { parent: null, enabled: true, formVisible: true }], ["leaf", { parent: "root", enabled: true, formVisible: true }]]);
    const skin = { gameId: "game-1", enabled: true, formVisible: true };
    change(cats, skin);
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const base = legacyProjectionClient(legacyProjectionRow());
    const client = { query: async (sql: string, args: unknown[] = []) => {
      if (!sql.includes("FROM zzsh_supply.listing_skin ls")) return base.query(sql);
      seen.push({ sql, args });
      const asksCategory = sql.includes("WITH RECURSIVE visible AS (") && sql.includes(`c."parent_id" IS NULL`) && sql.includes(`JOIN visible p ON c."parent_id" = p."id"`)
        && sql.includes(`s.category_id IN (SELECT "id" FROM visible)`) && sql.includes("s.game_id=$2") && args[1] === "game-1";
      const publicCats = new Set<string>();
      for (let i = 0; i < cats.size; i++) for (const [id, c] of cats) if (c.enabled && c.formVisible && (c.parent === null || publicCats.has(c.parent))) publicCats.add(id);
      const ok = skin.enabled && skin.formVisible && (!asksCategory ? true : skin.gameId === args[1] && publicCats.has("leaf"));
      const row = { id: "skin_probe_id", name: "PROBE_PUBLIC_NAME", baseName: "PROBE_BASE", ownerName: "PROBE_OWNER", mediaId: "asset_probe_media", categoryCode: "leaf", categoryName: "Leaf", visible: ok, isPublic: ok };
      return { rows: [row], rowCount: 1 };
    } } as unknown as PoolClient;
    return { listing: await readLegacyListing(client, "account_1"), seen };
  };
  const open = await run(() => {});
  assert.deepEqual(open.listing.presentation.skins.map((s) => s.id), ["skin_probe_id"], "positive control");
  assert.equal(Object.hasOwn(open.listing.presentation, "skinsWithheld"), false);
  assert.match(open.seen[0]!.sql, /purpose='SKIN_MEDIA' AND a\.review_state='APPROVED' AND a\.access_class='PUBLIC_DISPLAY' AND a\.public_storage_key IS NOT NULL/, "unqualified media stays null via the shared media guard");
  const hidden: Array<[string, (cats: Map<string, Cat>, skin: { gameId: string; enabled: boolean; formVisible: boolean }) => void]> = [
    ["root enabled=false", (c) => { c.get("root")!.enabled = false; }],
    ["root formVisible=false", (c) => { c.get("root")!.formVisible = false; }],
    ["leaf formVisible=false", (c) => { c.get("leaf")!.formVisible = false; }],
    ["verified skin disabled", (_c, s) => { s.enabled = false; }],
    ["cross-game skin", (_c, s) => { s.gameId = "game-other"; }],
  ];
  for (const [label, change] of hidden) {
    const { listing } = await run(change);
    assert.deepEqual(listing.presentation.skins, [], label);
    assert.equal((listing.presentation as { skinsWithheld?: number }).skinsWithheld, 1, label);
    const body = JSON.stringify(listing);
    for (const secret of ["skin_probe_id", "PROBE_PUBLIC_NAME", "PROBE_BASE", "PROBE_OWNER", "asset_probe_media"]) assert.equal(body.includes(secret), false, `${label} leaks ${secret}`);
    assert.equal(listing.quote, null);
    assert.equal(listing.canCreateOrder, false);
  }
});

// SKIN-MODEL-7 A: the legacy account's current-catalog summary carries the same owner type and
// quality facts as the public catalog; a missing column or unknown quality stays null.
test("SK7 legacy account skin summary carries owner type and quality from the shared projection", async () => {
  const seen: string[] = [];
  const skinRows = [
    { id: "skin_a", name: "露娜-黑·天际线", baseName: "黑·天际线", ownerName: "露娜", ownerKind: "AGENT", rarityCode: "q_fixture", rarityName: "测试品质", rarityBasis: "PLATFORM_REFERENCE", isCollectible: true, defaultState: "NON_DEFAULT", mediaKind: "PROMO_POSTER", mediaSource: { url: "https://private.example/source" }, mediaId: null, categoryCode: "df_skin_category_agent", categoryName: "干员外观", visible: true, isPublic: true },
    { id: "skin_b", name: "露娜-另一外观", baseName: "另一外观", ownerName: "露娜", ownerKind: "AGENT", rarityCode: null, rarityName: null, rarityBasis: null, isCollectible: false, defaultState: "DEFAULT", mediaId: null, categoryCode: "df_skin_category_agent", categoryName: "干员外观", visible: true, isPublic: true },
    { id: "skin_c", name: "旧数据皮肤", mediaId: null, categoryCode: "df_skin_category_agent_gold", categoryName: "干员金皮（旧分组）", visible: true, isPublic: true },
  ];
  const base = legacyProjectionClient(legacyProjectionRow());
  const client = { query: async (sql: string) => {
    if (sql.includes("FROM zzsh_supply.listing_skin ls")) { seen.push(sql); return { rows: skinRows, rowCount: skinRows.length }; }
    return base.query(sql);
  } } as unknown as PoolClient;
  const listing = await readLegacyListing(client, "account_1");
  const byId = new Map(listing.presentation.skins.map((s) => [s.id, s as Record<string, unknown>]));
  assert.deepEqual([byId.get("skin_a")!.ownerKind, byId.get("skin_a")!.rarityCode, byId.get("skin_a")!.rarityName], ["AGENT", "q_fixture", "测试品质"]);
  assert.deepEqual([byId.get("skin_b")!.ownerKind, byId.get("skin_b")!.rarityName], ["AGENT", null], "same owner type, different (unknown) quality");
  assert.deepEqual([byId.get("skin_c")!.ownerKind, byId.get("skin_c")!.rarityCode, byId.get("skin_c")!.rarityName], [null, null, null], "a legacy gold group never becomes a type or quality");
  assert.deepEqual([byId.get("skin_a")!.rarityBasis, byId.get("skin_a")!.isCollectible, byId.get("skin_a")!.defaultState], ["PLATFORM_REFERENCE", true, "NON_DEFAULT"]);
  assert.deepEqual([byId.get("skin_b")!.rarityBasis, byId.get("skin_b")!.isCollectible, byId.get("skin_b")!.defaultState], [null, false, "DEFAULT"], "an explicit non-collectible state never becomes unknown");
  assert.deepEqual([byId.get("skin_c")!.rarityBasis, byId.get("skin_c")!.isCollectible, byId.get("skin_c")!.defaultState], [null, null, "UNKNOWN"], "missing current facts are not inferred from a legacy group");
  assert.equal(byId.get("skin_a")!.mediaKind, "PROMO_POSTER");
  assert.equal(byId.get("skin_c")!.mediaKind, null);
  assert.equal(JSON.stringify(listing).includes("private.example"), false);
  assert.match(seen[0]!, /s\.owner_kind AS "ownerKind",s\.rarity_code AS "rarityCode",\(SELECT r\.name FROM zzsh_supply\.skin_rarity r WHERE r\.game_id=s\.game_id AND r\.code=s\.rarity_code\) AS "rarityName"/);
  assert.match(seen[0]!, /s\.rarity_evidence->>'basis' AS "rarityBasis", s\.is_collectible AS "isCollectible", s\.default_state AS "defaultState"/);
  assert.match(seen[0]!, /s\.media_source->>'kind' AS "mediaKind"/);
});
