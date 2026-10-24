import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertLegacyDisplayFields } from "../src/supply/legacy-display-snapshot";
import { prepareLegacyTradeIntake, prepareLegacyTradeTakeover, takeoverLegacyTrade, finalizeLegacyTradeTakeover, buildLegacyTradeDeclaration, applyLegacyOrdinaryDraft, type LegacyTradeTakeoverInput, type LegacyTradeIntake, type TradeCatalogItem } from "../src/supply/legacy-trade-takeover";
import { DELTA_LEGACY_RESOURCES } from "../src/supply/legacy-observation";
import { canonicalize, computeContentHash, normalizeContentPayload, type ContentDeclaration } from "../src/supply/content-hash";
import { fingerprintRequest, sha256Hex } from "../src/supply/supply-util";
import { handleSupplyAdminRoute, type SupplyResponse } from "../src/supply/supply-routes";
import { API_V1_ERROR_CODES } from "../src/contracts/api-v1";
import { SecurityApiError } from "../src/auth/security-core";
import {planLegacyTradeIntakeBatch,assembleLegacyTradeIntakeBatch,assembleLegacyTradeMediaGate,stableFingerprint,type LegacyTradeExtractionOriginal,type LegacyTradeMediaAssemblyRow,type LegacyTradeMediaByteEvidence} from "../src/supply/legacy-trade-intake-plan";
import {legacyDisplayDigest} from "../src/supply/legacy-display-snapshot";
import {computeDeltaQuote} from "../src/supply/pricing";
import {compatRule} from "./pricing-compat-fixture";

function bindSource(input: LegacyTradeIntake) {
  const { source } = input;
  const canonical = canonicalize({ sourceSystem: source.sourceSystem, sourceEntity: source.sourceEntity, legacyId: source.legacyId, baseSourceDigest: source.sourceDigest, deposit_amount: input.depositYuan, is_full_payout: input.isFullPayout, ownerRatioB: input.ownerRatioB });
  input.sourceFieldEvidence = { canonical, digest: sha256Hex(canonical), extractSha256: "f".repeat(64), evidenceRef: "FIXTURE_SOURCE_EXTRACT" };
  return input;
}

function fixture(): LegacyTradeIntake {
  const display = convertLegacyDisplayFields({ insure_lv: "4", grading_lv: "4", login_way: "1", vit_lv: "7", bear_lv: "7", dive_lv: "3", character_lv: "60", processing_time_start: "8", processing_time_end: "22", secret_kd: "1.20", ratio_type: "default", high_risk_owner: "0", ban_record: "0", face_is_self: "1", haff: "3", awm_bullet_num: "1", level6_bullet_num: "2", level6_helmet_num: "0", level6_armor_num: "1", barrett_bullet_num: "1", coffee_num: "0", top_insure_card_num: "7" });
  return bindSource({ accountId: "fixture_account", source: { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: "33", sourceDigest: "a".repeat(64), expectedObservationVersionId: "fixture_observation", expectedOwnerUserId: "fixture_owner", expectedGameId: "fixture_game" }, display,
    title: "FIXTURE 账号", description: null, depositYuan: "300.00", isFullPayout: "0", ownerRatioB: null, termOptionCode: "daily", pricingOptionCode: "", skins: [], entitlements: [],
    sourceFieldEvidence: { canonical: "", digest: "", extractSha256: "", evidenceRef: "" },
    media: [{ assetId: "fixture_asset", byteHash: "b".repeat(64), position: 0, technicalState: "READY", accessClass: "PUBLIC_DISPLAY" }] });
}
function catalog(): TradeCatalogItem[] {
  return DELTA_LEGACY_RESOURCES.map(([field, codes], i) => ({ id: "fixture_item_" + i, code: codes[0], unit: field === "haff" ? "HAFF_BASE" : field.includes("bullet") ? "ROUND" : field === "top_insure_card_num" ? "DAY" : "PIECE", quantityScale: 0 }));
}

function reviewedMaintenanceFixture(t: TestContext, options: { native?: boolean; selected?: boolean; originalTitle?: string; bumpDraft?: boolean } = {}) {
  const publishing: typeof import("../src/supply/publishing") = require("../src/supply/publishing");
  const legacy: typeof import("../src/supply/legacy-observation") = require("../src/supply/legacy-observation");
  const auth: typeof import("../src/auth/auth-security") = require("../src/auth/auth-security");
  const access: typeof import("../src/auth/admin-authorization") = require("../src/auth/admin-authorization");
  const funding: typeof import("../src/supply/funding-authority") = require("../src/supply/funding-authority");
  const intake = fixture(); intake.title = options.originalTitle ?? "历史资料待核实"; intake.termOptionCode = "daily-10m";
  if (options.selected) { intake.isFullPayout = "1"; bindSource(intake); }
  const original = structuredClone(intake), calls: string[] = [], queries: Array<{ sql: string; values: unknown[] }> = [], audits: any[] = [];
  const actor = { id: "fixture_admin", sessionId: "fixture_session", requestId: "req_fixture" };
  const gate: import("../src/supply/publishing").SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "FIXTURE_ONLY" });
  const account: any = { id: intake.accountId, owner_user_id: intake.source.expectedOwnerUserId, game_id: intake.source.expectedGameId, current_version_id: options.native ? "fixture_draft" : intake.source.expectedObservationVersionId, revision: "1", legacy_hold: options.native ? "NONE" : "UNRESOLVED", lifecycle: "ACTIVE" };
  let stored = { ...buildLegacyTradeDeclaration(intake, catalog()).declaration!, mediaBindings: [] } as unknown as ContentDeclaration;
  if (options.native && !intake.title.trim()) stored.title = `历史资料待核实-${intake.accountId.slice(0, 8)}`;
  const version: any = { id: account.current_version_id, origin: options.native ? "NATIVE" : "LEGACY_OBSERVATION", review_state: options.native ? "DRAFT" : "IMPORTED_UNVERIFIED", attributes: stored.attributes, payload: null, content_hash: null, rule_release_id: null };
  const controls = { priorOrdinary: true, sourceMismatch: false, displayMismatch: false, observationMismatch: false, authorized: true, accepted: false, formalDone: false, reviewPermission: true };
  const receipts = new Map<string, unknown>();
  const sourceUpdatedAt = new Date("2026-10-15T00:00:00Z"), extractSha256 = "e".repeat(64), evidenceRef = "FIXTURE_DISPLAY";
  const displayDigest = legacyDisplayDigest(account.id, { observationVersionId: original.source.expectedObservationVersionId, baseSourceDigest: original.source.sourceDigest, extractSha256, sourceUpdatedAt: sourceUpdatedAt.toISOString(), evidenceRef, snapshot: original.display });
  const client = { query: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes('FROM "zzsh_supply"."idempotency_record"')) { const row = receipts.get(String(values[0])+":"+String(values[1])); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }; }
    if (sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')) { receipts.set(String(values[0])+":"+String(values[1]), { requestFingerprint: values[2], responseStatus: values[3], responseBody: JSON.parse(String(values[4])), publishRequired: values[5] }); return { rows: [], rowCount: 1 }; }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { const details = JSON.parse(String(values[10])); audits.push({ action: values[4], details }); if (values[4] === "supply.legacy.trade_takeover") controls.formalDone = true; return { rows: [], rowCount: 1 }; }
    if (sql.includes("legacy_listing_display_snapshot")) return { rows: [{ observation_version_id: original.source.expectedObservationVersionId, base_source_digest: original.source.sourceDigest, extract_sha256: extractSha256, source_updated_at: sourceUpdatedAt, evidence_ref: evidenceRef, snapshot: original.display, display_digest: controls.displayMismatch ? "0".repeat(64) : displayDigest }], rowCount: 1 };
    if (sql.includes("SELECT title,description")) return { rows: [{ title: controls.observationMismatch ? "different original" : original.title, description: original.description }], rowCount: 1 };
    if (sql.includes("SELECT id,code,unit")) return { rows: catalog(), rowCount: catalog().length };
    if (sql.includes("e.action='supply.legacy.trade_draft_write'")) return { rows: controls.priorOrdinary && !controls.formalDone ? [{}] : [], rowCount: controls.priorOrdinary && !controls.formalDone ? 1 : 0 };
    if (sql.includes("FROM zzsh_supply.listing_media m JOIN")) return { rows: original.media.map(m => ({ id: m.assetId, account_id: account.id, owner_user_id: account.owner_user_id, purpose: "ACCOUNT_DISPLAY" })), rowCount: original.media.length };
    if (sql.includes("unnest($2::text[])")) return { rows: [], rowCount: 0 };
    if (sql.includes("acceptance_kind='OWNER_ACCEPTED'")) return { rows: controls.accepted ? [{}] : [], rowCount: controls.accepted ? 1 : 0 };
    if (sql.includes("details->>'batchId'")) return { rows: controls.formalDone ? [{}] : [], rowCount: controls.formalDone ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  } } as unknown as import("pg").PoolClient;
  t.mock.method(publishing, "lockPublishingAccount", async () => account);
  t.mock.method(publishing, "currentVersion", async () => version);
  t.mock.method(publishing, "assertCurrentRelease", async () => {});
  t.mock.method(publishing, "readDeclaration", async () => stored);
  t.mock.method(legacy, "lockLegacySource", async () => {});
  t.mock.method(legacy, "readLegacyMap", async () => ({ account_id: account.id, source_digest: controls.sourceMismatch ? "c".repeat(64) : original.source.sourceDigest, version_id: original.source.expectedObservationVersionId }));
  t.mock.method(legacy, "resolveLegacyObservationToDraft", async () => { calls.push("resolve"); account.current_version_id = "fixture_draft"; account.legacy_hold = "NONE"; version.id = "fixture_draft"; version.origin = "NATIVE"; version.review_state = "DRAFT"; return {} as any; });
  t.mock.method(auth, "assertAdminContextInTransaction", async () => { if (!controls.authorized) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Denied"); });
  t.mock.method(access, "loadEffectiveAdminAccess", async () => ({ status: "ACTIVE", isBoss: true, permissions: new Set(controls.reviewPermission ? ["supply.catalog.manage", "supply.review.decide"] : ["supply.catalog.manage"]) }));
  t.mock.method(funding, "readFundingPolicyForRelease", async () => ({ ownerDepositRules: { normal: { minCents: "1" }, fullPayoutSelected: { minCents: "30000" }, capCents: "999999" } } as any));
  t.mock.method(publishing, "saveListingDraft", async (_c: unknown, _a: unknown, body: Record<string, unknown>) => { calls.push("save"); const { expectedRevision: _revision, ...declaration } = body; stored = { ...declaration, mediaBindings: original.media.map(m => ({ assetId: m.assetId, byteHash: m.byteHash, position: m.position, purpose: "ACCOUNT_DISPLAY" })) } as unknown as ContentDeclaration; if (options.bumpDraft) { Object.assign(version, { payload: null, content_hash: null, rule_release_id: null }); account.revision = (BigInt(account.revision) + 1n).toString(); } });
  t.mock.method(publishing, "quoteListing", async (_c: unknown, _a: unknown, _r: unknown, grading: import("../src/supply/publishing").LegacyTakeoverGradingContext | undefined) => {
    assert.deepEqual(grading, { kind: "VERIFIED_LEGACY_TAKEOVER", accountId: account.id, sourceDigest: original.source.sourceDigest, observationVersionId: original.source.expectedObservationVersionId, gradingCode: original.display.attributes.grading_code, gradingDivision: null });
    calls.push("quote"); const priced = computeDeltaQuote({ priceVersionId: "fixture_price", mode: "SPREAD", roundingPolicy: "HALF_UP_CENT_V1", customerTier: "STANDARD", haffRule: compatRule(), lines: [{ itemId: "fixture_item_0", quantity: "3000000", pricingKind: "HAFF_RATIO", unit: "HAFF_BASE", customerTier: "STANDARD" }], conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", rentalPricing: { rentalMode: "ordinary" } }, termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" } }); assert(priced.quotable);
    const payload = normalizeContentPayload({ schemaVersion: 2, accountId: account.id, gameId: account.game_id, declaration: stored, ruleRefs: { releaseId: "fixture_release", catalogRevision: "1", priceVersionId: "fixture_price", termVersionId: "fixture_term", agreementVersionId: "fixture_agreement", agreementDigest: "d".repeat(64) }, quoteValues: priced.quote });
    Object.assign(version, { attributes: payload.declaration.attributes, payload, content_hash: computeContentHash(payload), rule_release_id: "fixture_release" });
    if (options.bumpDraft) account.revision = (BigInt(account.revision) + 1n).toString();
  });
  t.mock.method(publishing, "reviewListing", async (_c: unknown, _a: unknown, _id: unknown, _body: unknown, _gate: unknown, grading: import("../src/supply/publishing").LegacyTakeoverGradingContext | undefined) => { assert.equal(grading?.gradingDivision, null); assert.equal(grading?.sourceDigest, original.source.sourceDigest); calls.push("review"); });
  return { intake, original, client, actor, gate, account, version, controls, calls, queries, audits, displayDigest, getStored: () => stored };
}

function mediaCloseoutFixture(t: TestContext, selected = false) {
  const f = reviewedMaintenanceFixture(t, { native: true, selected, originalTitle: "已核来源标题", bumpDraft: true });
  const p: typeof import("../src/supply/publishing") = require("../src/supply/publishing");
  const auth: typeof import("../src/auth/auth-security") = require("../src/auth/auth-security");
  t.mock.method(auth, "readAdminContext", async () => ({ userId: f.actor.id, sessionId: f.actor.sessionId }));
  const asset: any = { id: f.intake.media[0]!.assetId, accountId: f.account.id, ownerUserId: f.account.owner_user_id, gameId: f.account.game_id, purpose: "ACCOUNT_DISPLAY", ownershipKind: "USER_SUPPLY", contentHash: f.intake.media[0]!.byteHash, revision: "1", technicalState: "READY", publicStorageKey: "fixture_public_derivative", reviewState: "UNREVIEWED", accessClass: "PRIVATE_REVIEW", reviewReason: null };
  const controls = { reviewFailure: false }, originalQuery = f.client.query.bind(f.client) as any;
  f.client.query = (async (sql: string, values: unknown[] = []) => {
    if (sql.includes("/* legacy-prepared-media */")) {
      const bindings = f.getStored().mediaBindings.filter(m => m.assetId === asset.id);
      return { rows: bindings.map(m => ({ assetId: asset.id, accountId: asset.accountId, ownerUserId: asset.ownerUserId, gameId: asset.gameId, purpose: asset.purpose, ownershipKind: asset.ownershipKind, byteHash: asset.contentHash, assetRevision: asset.revision, technicalState: asset.technicalState, reviewState: asset.reviewState, accessClass: asset.accessClass, publicDerivative: Boolean(asset.publicStorageKey), validReviewReason: typeof asset.reviewReason === "string" && asset.reviewReason.trim().length >= 2, position: m.position })), rowCount: bindings.length };
    }
    if (sql.includes("/* legacy-prepared-draft */")) {
      const token = JSON.parse(String(values[4]));
      const rows = f.audits.filter(a => a.action === "supply.legacy.trade_takeover.prepare" && a.details.batchId === values[1] && a.details.inputDigest === values[3] && canonicalize(a.details.source) === canonicalize(JSON.parse(String(values[2]))) && ["accountRevision", "versionId", "releaseId", "contentHash"].every(key => a.details.preparedDraft[key] === token[key])).map(a => ({ details: a.details }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("/* legacy-prepared-media-review */")) {
      const rows = f.audits.filter(a => a.action === "supply.media.reviewed").map(a => ({ object_id: a.objectId, details: a.details })); return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM "zzsh_supply"."media_asset"')) return { rows: values[0] === asset.id ? [{ ...asset }] : [], rowCount: values[0] === asset.id ? 1 : 0 };
    if (sql.includes('FROM zzsh_supply."media_asset"')) return { rows: [{ id: asset.id, game_id: asset.gameId, purpose: asset.purpose, ownership_kind: asset.ownershipKind, owner_user_id: asset.ownerUserId, content_hash: asset.contentHash, review_state: asset.reviewState, access_class: asset.accessClass, revision: asset.revision, review_reason: asset.reviewReason }], rowCount: 1 };
    if (sql.startsWith("SELECT revision::text,current_version_id,owner_user_id")) return { rows: [{ revision: f.account.revision, current_version_id: f.account.current_version_id, owner_user_id: f.account.owner_user_id }], rowCount: 1 };
    if (sql.startsWith("SELECT 1 FROM zzsh_supply.listing_media WHERE")) { const bound = values[0] === f.version.id && f.getStored().mediaBindings.some(m => m.assetId === values[1]); return { rows: bound ? [{}] : [], rowCount: bound ? 1 : 0 }; }
    if (sql.includes('UPDATE "zzsh_supply"."media_asset"')) {
      if (controls.reviewFailure) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Fixture review failed");
      Object.assign(asset, { reviewState: values[0], reviewReason: values[2], accessClass: values[3], revision: (BigInt(asset.revision) + 1n).toString() }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT details FROM zzsh_iam.audit_event") && sql.includes("action='supply.legacy.trade_takeover'")) { const rows = f.audits.filter(a => a.action === "supply.legacy.trade_takeover" && a.details.state === "OWNER_ACCEPTANCE_REQUIRED").map(a => ({ details: a.details })); return { rows, rowCount: rows.length }; }
    const result = await originalQuery(sql, values);
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) f.audits.at(-1)!.objectId = values[6];
    return result;
  }) as any;
  const token = () => ({ accountRevision: f.account.revision, versionId: f.version.id, releaseId: f.version.rule_release_id!, contentHash: f.version.content_hash! });
  async function formalReview() {
    const accountContext = { accountId: f.account.id, accountRevision: f.account.revision, versionId: f.version.id, assetRevision: asset.revision, byteHash: asset.contentHash };
    const http = { headersSent: false, statusCode: 0, payload: undefined as any, status(n: number) { this.statusCode = n; return this; }, setHeader() { return this; }, json(body: unknown) { this.payload = body; this.headersSent = true; return this; } };
    const pool = { connect: async () => Object.assign(f.client, { release() {} }) };
    await handleSupplyAdminRoute({ method: "POST", originalUrl: `/api/v1/admin/supply/media/${asset.id}/review`, headers: { origin: "http://admin.invalid", "idempotency-key": sha256Hex(JSON.stringify(accountContext)), "x-request-id": f.actor.requestId }, body: { decision: "APPROVE", reason: "核对新稿与本地联调图片", visibility: "PUBLIC_DISPLAY", accountContext } } as never, http as unknown as SupplyResponse, { pool, apiOrigin: "http://api.invalid", userOrigin: "http://user.invalid", adminOrigin: "http://admin.invalid", mediaStorage: { available: false } } as never);
    if (http.statusCode !== 200) throw new SecurityApiError(http.statusCode, http.payload?.error?.code ?? "EVIDENCE_UNAVAILABLE", http.payload?.error?.message ?? "Fixture review failed");
    return accountContext;
  }
  async function primeQuotedDraft() {
    const plan = prepareLegacyTradeIntake(f.intake, catalog()); assert.equal(plan.admission, "TRADE_CANDIDATE");
    await p.saveListingDraft(f.client, f.account, { ...plan.draft, expectedRevision: f.account.revision }, f.gate);
    await p.quoteListing(f.client, f.account, f.account.revision, { kind: "VERIFIED_LEGACY_TAKEOVER", accountId: f.account.id, sourceDigest: f.intake.source.sourceDigest, observationVersionId: f.intake.source.expectedObservationVersionId, gradingCode: "4", gradingDivision: null });
  }
  return { ...f, asset, mediaControls: controls, token, formalReview, primeQuotedDraft };
}

test("takeover submits an empty submitted_at through the real review, while wrong bindings still reject", async t => {
  for (const mode of ["valid", "wrong-media", "wrong-release"] as const) await t.test(mode, async t => {
    const publishing: typeof import("../src/supply/publishing") = require("../src/supply/publishing");
    const realReview = publishing.reviewListing, realRelease = publishing.assertCurrentRelease;
    const f = mediaCloseoutFixture(t);
    f.intake.media[0]!.accessClass = "PRIVATE_REVIEW";
    const input = { batchId: "fixture_submitted_time", intake: f.intake };
    const prepared = await prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate);
    await f.formalReview();
    const final = { ...input, intake: structuredClone(input.intake), preparedDraft: (prepared.body as any).preparedDraft };
    final.intake.media[0]!.accessClass = "PUBLIC_DISPLAY";
    Object.assign(f.version, { title: f.getStored().title, submitted_at: null });
    publishing.reviewListing = realReview;
    publishing.assertCurrentRelease = realRelease;
    let acceptance: unknown[] | undefined, decision: unknown[] | undefined, publications = 0;
    const query = f.client.query.bind(f.client);
    f.client.query = (async (sql: string, values: unknown[] = []) => {
      const result = (rows: unknown[] = [], rowCount = rows.length) => { f.queries.push({ sql, values }); return { rows, rowCount }; };
      if (sql.includes("SELECT * FROM zzsh_supply.listing_version WHERE id=$1")) return result(values[0] === f.version.id && values[1] === f.account.id ? [f.version] : []);
      if (sql.includes("SELECT current_release_id,catalog_revision")) return result([{ current_release_id: mode === "wrong-release" ? "another_release" : f.version.rule_release_id, catalog_revision: "1" }]);
      if (sql.includes("INSERT INTO zzsh_supply.rule_acceptance")) { acceptance = [values[2], values[3], values[4], values[5], values[1]]; return result([], 1); }
      if (sql.includes("SELECT 1 FROM zzsh_supply.rule_acceptance")) return result(canonicalize(values) === canonicalize(acceptance) ? [{}] : []);
      if (sql.startsWith("UPDATE zzsh_supply.listing_version SET review_state='SUBMITTED'")) {
        const submittedAt = /submitted_at\s*=\s*clock_timestamp\(\)/.test(sql) ? new Date("2026-10-24T00:00:00Z") : f.version.submitted_at;
        assert(f.version.payload && f.version.rule_release_id && submittedAt instanceof Date && !Number.isNaN(submittedAt.getTime()), "listing_version SUBMITTED check requires submitted_at");
        Object.assign(f.version, { review_state: "SUBMITTED", submitted_at: submittedAt }); return result([], 1);
      }
      if (sql.includes("SELECT u.suspended")) return result([{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }]);
      if (sql.includes("SELECT id,code,name,enabled,current_release_id")) return result([{ enabled: true, current_release_id: f.version.rule_release_id, catalog_revision: "1" }]);
      if (sql.includes("game_service_operation")) return result([{ id: "fixture_service", gameCode: "delta", gameEnabled: true, enabled: true }]);
      if (sql.includes("current-trade-resources")) return result(catalog().filter(item => (values[1] as string[]).includes(item.id)).map(item => ({ ...item, enabled: true })));
      if (sql.includes("SELECT a.* FROM zzsh_supply.listing_media")) return result([{ id: f.asset.id, purpose: f.asset.purpose, ownership_kind: "USER_SUPPLY", review_state: f.asset.reviewState, technical_state: "READY", public_storage_key: f.asset.publicStorageKey, access_class: f.asset.accessClass }]);
      if (sql.startsWith("SELECT id,display_no FROM zzsh_supply.rental_account")) return result([{ id: f.account.id, display_no: "AC0000000001" }]);
      if (sql.includes("INSERT INTO zzsh_supply.review_decision")) { decision = values; return result([], 1); }
      if (sql.startsWith("UPDATE zzsh_supply.listing_version SET review_state='APPROVED'")) { assert(f.version.submitted_at instanceof Date); f.version.review_state = "APPROVED"; return result([], 1); }
      if (sql.includes("INSERT INTO zzsh_supply.listing_publication")) {
        assert.deepEqual(decision?.slice(1, 5), [f.version.id, f.version.rule_release_id, f.version.content_hash, "APPROVE"]);
        publications++; return result([{ id: "fixture_publication" }]);
      }
      if (sql.startsWith("UPDATE zzsh_supply.rental_account SET revision")) return result([{ revision: String(Number(f.account.revision) + 1) }]);
      return query(sql, values);
    }) as any;
    if (mode === "wrong-media") f.asset.contentHash = "c".repeat(64);
    if (mode === "valid") {
      const result = await takeoverLegacyTrade(f.client, f.actor, final, f.gate);
      assert.equal((result.body as any).state, "PUBLISHED"); assert.equal(f.version.review_state, "APPROVED");
      assert(f.version.submitted_at instanceof Date); assert.equal(publications, 1);
    } else {
      await assert.rejects(() => takeoverLegacyTrade(f.client, f.actor, final, f.gate));
      assert.equal(f.version.review_state, "DRAFT"); assert.equal(f.version.submitted_at, null); assert.equal(publications, 0);
    }
  });
});

test("old reviewed tuple cannot authorize a takeover that clears and rebuilds the quote; forged prepared token is rejected", async t => {
  const f = mediaCloseoutFixture(t); await f.primeQuotedDraft(); await f.formalReview();
  const old = f.token(), writes = f.calls.length;
  await assert.rejects(() => takeoverLegacyTrade(f.client, f.actor, { batchId: "fixture_old_review", intake: f.intake, preparedDraft: old } as any, f.gate), /PREPARED/);
  assert.equal(f.calls.length, writes, "a prior image approval cannot be carried across another save/quote");
});

test("prepare accepts actual private media; final requires the ordinary audited exact-tuple review and never saves or quotes again", async t => {
  const f = mediaCloseoutFixture(t); f.intake.media[0]!.accessClass = "PRIVATE_REVIEW";
  const input = { batchId: "fixture_prepared", intake: f.intake };
  const prepared = await prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate);
  assert.equal((prepared.body as any).state, "MEDIA_REVIEW_REQUIRED"); assert.deepEqual(f.calls, ["save", "quote"]);
  assert.equal(f.asset.reviewState, "UNREVIEWED"); assert.equal(f.audits.some(a => a.action === "supply.media.reviewed"), false);
  const token = (prepared.body as any).preparedDraft;
  const final = { ...input, intake: structuredClone(input.intake), preparedDraft: token }; final.intake.media[0]!.accessClass = "PUBLIC_DISPLAY";
  await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /PREPARED_MEDIA_REVIEW_REQUIRED/);
  f.mediaControls.reviewFailure = true; await assert.rejects(f.formalReview(), { status: 503 }); f.mediaControls.reviewFailure = false;
  assert.deepEqual(f.calls, ["save", "quote"]);
  await f.formalReview();
  const actualReview = f.audits.find(a => a.action === "supply.media.reviewed"); assert.deepEqual(actualReview.details.mediaContext, { accountId: f.account.id, accountRevision: token.accountRevision, versionId: token.versionId, assetRevision: "1", byteHash: f.asset.contentHash });
  const result = await takeoverLegacyTrade(f.client, f.actor, final, f.gate);
  assert.equal((result.body as any).state, "PUBLISHED"); assert.deepEqual(f.calls, ["save", "quote", "review"]);
  assert.deepEqual(f.audits.find(a => a.action === "supply.legacy.trade_takeover").details.preparedDraft, token);
  f.asset.accessClass = "PRIVATE_REVIEW";
  assert.equal((await takeoverLegacyTrade(f.client, f.actor, final, f.gate)).replayed, true);
  assert.deepEqual(f.calls, ["save", "quote", "review"]);
  await assert.rejects(takeoverLegacyTrade(f.client, f.actor, { ...final, preparedDraft: { ...token, accountRevision: "999" } }, f.gate), (e: any) => e.code === API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  f.controls.reviewPermission = false;
  await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), { status: 403 });
});

test("prepared source, declaration, exact media identity, audit tuple and current revision cannot be forged", async t => {
  const f = mediaCloseoutFixture(t), input = { batchId: "fixture_prepared", intake: f.intake };
  const prepared = await prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate), token = (prepared.body as any).preparedDraft;
  await f.formalReview(); const final = { ...input, preparedDraft: token }, writes = f.calls.length;
  const audit = f.audits.find(a => a.action === "supply.media.reviewed"), proof = f.audits.find(a => a.action === "supply.legacy.trade_takeover.prepare");
  const oldContext = structuredClone(audit.details.mediaContext);
  audit.details.mediaContext.accountRevision = "999"; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /PREPARED_MEDIA_REVIEW_REQUIRED/); audit.details.mediaContext = oldContext;
  f.asset.revision = "3"; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /PREPARED_MEDIA_REVIEW_REQUIRED/); f.asset.revision = "2";
  f.asset.accountId = "another_account"; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /PREPARED_MEDIA_BINDING_MISMATCH/); f.asset.accountId = f.account.id;
  f.asset.contentHash = "c".repeat(64); await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /PREPARED_MEDIA_BINDING_MISMATCH/); f.asset.contentHash = f.intake.media[0]!.byteHash;
  f.account.revision = "99"; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /PREPARED_DRAFT_CHANGED/); f.account.revision = token.accountRevision;
  proof.details.declarationDigest = "c".repeat(64); await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /PREPARED_DRAFT_AUDIT_REQUIRED/); proof.details.declarationDigest = sha256Hex(canonicalize(f.version.payload.declaration));
  f.getStored().description = "another draft"; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /MATERIALIZATION_MISMATCH/); f.getStored().description = null;
  await assert.rejects(takeoverLegacyTrade(f.client, f.actor, { ...final, reviewedDeclaration: { title: "另一个标题", reason: "另一次核对" } }, f.gate), /MATERIALIZATION_MISMATCH/);
  f.controls.sourceMismatch = true; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), /SOURCE_BINDING_MISMATCH/); f.controls.sourceMismatch = false;
  f.controls.reviewPermission = false; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, final, f.gate), { status: 403 }); f.controls.reviewPermission = true;
  for (const preparedDraft of [null, {}, { ...token, accountRevision: 3 }]) await assert.rejects(takeoverLegacyTrade(f.client, f.actor, { ...final, preparedDraft } as any, f.gate), { status: 400 });
  assert.equal(f.calls.length, writes); assert.equal((await takeoverLegacyTrade(f.client, f.actor, final, f.gate)).status, 200);
});

test("preparation is separately idempotent and reauthorizes replay; missing title/reason and actual readiness fail closed", async t => {
  const f = mediaCloseoutFixture(t), input = { batchId: "fixture_prepared", intake: f.intake };
  f.asset.technicalState = "PENDING"; await assert.rejects(prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate), /PREPARED_MEDIA_BINDING_MISMATCH/); f.asset.technicalState = "READY";
  f.controls.priorOrdinary = false; await assert.rejects(prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate), /TAKEOVER_DRAFT_SOURCE_MISMATCH/); f.controls.priorOrdinary = true;
  const prepared = await prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate); const writes = f.calls.length;
  assert.equal((await prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate)).replayed, true); assert.equal(f.calls.length, writes);
  await assert.rejects(prepareLegacyTradeTakeover(f.client, f.actor, { ...input, reviewedDeclaration: { title: "已核标题", reason: "" } }, f.gate), (e: any) => e.code === API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  await assert.rejects(prepareLegacyTradeTakeover(f.client, f.actor, { ...input, preparedDraft: (prepared.body as any).preparedDraft } as any, f.gate), { status: 400 });
  f.controls.reviewPermission = false; await assert.rejects(prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate), { status: 403 }); assert.equal(f.calls.length, writes);
});

test("prepared full payout still requires owner acceptance and a fresh formal media review after its account revision changes", async t => {
  const f = mediaCloseoutFixture(t, true), input = { batchId: "fixture_full_prepared", intake: f.intake };
  const prepared = await prepareLegacyTradeTakeover(f.client, f.actor, input, f.gate); await f.formalReview();
  assert.equal(((await takeoverLegacyTrade(f.client, f.actor, { ...input, preparedDraft: (prepared.body as any).preparedDraft }, f.gate)).body as any).state, "OWNER_ACCEPTANCE_REQUIRED");
  const finalize = { accountId: f.account.id, source: f.intake.source, batchId: input.batchId, expectedRevision: f.account.revision, versionId: f.version.id, contentHash: f.version.content_hash, releaseId: f.version.rule_release_id };
  await assert.rejects(finalizeLegacyTradeTakeover(f.client, f.actor, finalize, f.gate), /TERMS_ACCEPTANCE_REQUIRED/);
  f.controls.accepted = true; f.account.revision = (BigInt(f.account.revision) + 1n).toString(); finalize.expectedRevision = f.account.revision;
  await assert.rejects(finalizeLegacyTradeTakeover(f.client, f.actor, finalize, f.gate), /PREPARED_MEDIA_REVIEW_REQUIRED/);
  await f.formalReview(); assert.equal((await finalizeLegacyTradeTakeover(f.client, f.actor, finalize, f.gate)).status, 200);
  assert.deepEqual(f.calls, ["save", "quote", "review"]);
});

test("reviewed title is explicit and audited while original source/title/hash stay untouched; original key replays only identical review", async t => {
  const f = reviewedMaintenanceFixture(t), before = canonicalize(f.intake), sourceFields = canonicalize(f.intake.sourceFieldEvidence);
  const input: LegacyTradeTakeoverInput = { batchId: "fixture_reviewed", intake: f.intake, reviewedDeclaration: { title: "黄金 · 3M哈夫币 · QQ账密", reason: "依据同源账号属性核对标题" } };
  assert.equal(prepareLegacyTradeIntake(f.intake, catalog()).admission, "BLOCKED");
  const result = await takeoverLegacyTrade(f.client, f.actor, input, f.gate);
  assert.equal((result.body as any).state, "PUBLISHED"); assert.deepEqual(f.calls, ["resolve", "save", "quote", "review"]);
  assert.equal(f.getStored().title, input.reviewedDeclaration!.title);
  assert.equal(Object.hasOwn(f.getStored().attributes, "grading_division"), false);
  assert.equal(canonicalize(f.intake), before); assert.equal(canonicalize(f.intake.sourceFieldEvidence), sourceFields);
  assert.equal(f.intake.source.sourceDigest, "a".repeat(64)); assert.equal(f.intake.title, "历史资料待核实");
  assert.deepEqual(f.audits.find(a => a.action === "supply.legacy.trade_takeover").details.reviewedDeclaration, { originalTitle: "历史资料待核实", title: input.reviewedDeclaration!.title, reason: input.reviewedDeclaration!.reason });
  const inserted = f.queries.find(q => q.sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"'))!;
  assert.equal(inserted.values[1], sha256Hex(JSON.stringify([f.intake.accountId, f.intake.source.expectedObservationVersionId, sha256Hex(canonicalize(f.intake))])));
  const writes = f.calls.length; assert.equal((await takeoverLegacyTrade(f.client, f.actor, input, f.gate)).replayed, true); assert.equal(f.calls.length, writes);
  await assert.rejects(takeoverLegacyTrade(f.client, f.actor, { ...input, reviewedDeclaration: { ...input.reviewedDeclaration!, reason: "另一个理由" } }, f.gate), (error: any) => error.status === 409 && error.code === API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
  assert.equal(f.calls.length, writes);
  assert.equal(f.queries.some(q => /UPDATE\s+zzsh_supply\.legacy_listing_display_snapshot|UPDATE\s+zzsh_supply\.listing_version\s+SET\s+title/i.test(q.sql)), false);
});

test("missing or malformed reviewed title never turns the original placeholder into a publishable title", async t => {
  const f = reviewedMaintenanceFixture(t);
  await assert.rejects(takeoverLegacyTrade(f.client, f.actor, { batchId: "no_review", intake: f.intake }, f.gate), /TITLE_REVIEW_REQUIRED/);
  for (const reviewedDeclaration of [{ title: "历史资料待核实", reason: "核对" }, { title: "已核标题", reason: "" }, { title: "", reason: "核对" }, { title: "已核标题", reason: "核对", bypass: true }, null])
    await assert.rejects(takeoverLegacyTrade(f.client, f.actor, { batchId: "invalid_review", intake: f.intake, reviewedDeclaration } as any, f.gate), { status: 400 });
  assert.deepEqual(f.calls, []);
});

test("a reviewed title cannot bypass source map, display digest, original observation or admin authorization", async t => {
  const f = reviewedMaintenanceFixture(t), input = { batchId: "fixture_reviewed", intake: f.intake, reviewedDeclaration: { title: "已核属性标题", reason: "核对原件" } };
  for (const [flag, expected] of [["sourceMismatch", /SOURCE_BINDING_MISMATCH/], ["displayMismatch", /DISPLAY_SOURCE_BINDING_MISMATCH/], ["observationMismatch", /OBSERVATION_DECLARATION_MISMATCH/]] as const) {
    f.controls[flag] = true; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, input, f.gate), expected); f.controls[flag] = false;
  }
  f.controls.authorized = false; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, input, f.gate), { status: 403 });
  assert.deepEqual(f.calls, []);
});

test("existing Native drafts require matching ordinary source audit and unchanged declaration before takeover", async t => {
  const f = reviewedMaintenanceFixture(t, { native: true }), input = { batchId: "fixture_reviewed", intake: f.intake, reviewedDeclaration: { title: "同源已核属性标题", reason: "核对原件" } };
  f.controls.priorOrdinary = false; await assert.rejects(takeoverLegacyTrade(f.client, f.actor, input, f.gate), /TAKEOVER_DRAFT_SOURCE_MISMATCH/);
  f.controls.priorOrdinary = true; f.getStored().description = "another task changed this";
  await assert.rejects(takeoverLegacyTrade(f.client, f.actor, input, f.gate), /已有草稿与本次来源声明不一致/);
  f.getStored().description = f.original.description;
  f.getStored().mediaBindings = [{ assetId: "foreign_asset", byteHash: "b".repeat(64), purpose: "ACCOUNT_DISPLAY", position: 0 }];
  await assert.rejects(takeoverLegacyTrade(f.client, f.actor, input, f.gate), /已有草稿与本次来源声明不一致/);
  assert.deepEqual(f.calls, []);
  f.getStored().mediaBindings = [];
  assert.equal((await takeoverLegacyTrade(f.client, f.actor, input, f.gate)).status, 200);
  assert.deepEqual(f.calls, ["save", "quote", "review"]);
  const audit = f.queries.find(q => q.sql.includes("e.action='supply.legacy.trade_draft_write'"))!;
  assert.deepEqual(audit.values, [f.account.id, "fixture_draft", "legacy_mysql_restore", "la_rental_accounts", "33", "a".repeat(64), "fixture_observation"]);
});

test("selected payout finalization rechecks the bound display once and retains unknown division until genuine owner acceptance", async t => {
  const f = reviewedMaintenanceFixture(t, { selected: true }), input = { batchId: "fixture_reviewed", intake: f.intake, reviewedDeclaration: { title: "包赔已核属性标题", reason: "核对原件" } };
  const result = await takeoverLegacyTrade(f.client, f.actor, input, f.gate); assert.equal((result.body as any).state, "OWNER_ACCEPTANCE_REQUIRED");
  const finalize = { accountId: f.account.id, source: f.intake.source, batchId: input.batchId, expectedRevision: "1", versionId: f.version.id, contentHash: f.version.content_hash, releaseId: f.version.rule_release_id };
  f.controls.displayMismatch = true; await assert.rejects(finalizeLegacyTradeTakeover(f.client, f.actor, finalize, f.gate), /DISPLAY_SOURCE_BINDING_MISMATCH/);
  f.controls.displayMismatch = false; await assert.rejects(finalizeLegacyTradeTakeover(f.client, f.actor, finalize, f.gate), /TERMS_ACCEPTANCE_REQUIRED/);
  assert.deepEqual(f.calls, ["resolve", "save", "quote"]);
  f.controls.accepted = true; const before = f.queries.length;
  assert.equal((await finalizeLegacyTradeTakeover(f.client, f.actor, finalize, f.gate)).status, 200);
  assert.deepEqual(f.calls, ["resolve", "save", "quote", "review"]);
  assert.equal(f.queries.slice(before).filter(q => q.sql.includes("legacy_listing_display_snapshot")).length, 1);
  assert.equal(Object.hasOwn(f.getStored().attributes, "grading_division"), false);
});

test("a same-source ordinary draft keeps the established blank-title fallback until its explicit reviewed title", async t => {
  const f = reviewedMaintenanceFixture(t, { native: true, originalTitle: "" });
  assert.equal(f.getStored().title, `历史资料待核实-${f.account.id.slice(0, 8)}`);
  const result = await takeoverLegacyTrade(f.client, f.actor, { batchId: "blank_original", intake: f.intake, reviewedDeclaration: { title: "已核属性标题", reason: "核对真实属性补齐原空标题" } }, f.gate);
  assert.equal(result.status, 200); assert.equal(f.intake.title, ""); assert.equal(f.getStored().title, "已核属性标题");
  assert.equal(f.audits.find(a => a.action === "supply.legacy.trade_takeover").details.reviewedDeclaration.originalTitle, "");
});
test("formal intake uses native item IDs, exact base quantities and materialized funding declarations", () => {
  const input = fixture(), plan = prepareLegacyTradeIntake(input, catalog());
  assert.equal(plan.admission, "TRADE_CANDIDATE", plan.reasons.join(",")); assert(plan.draft);
  const attributes = plan.draft.attributes as Record<string, unknown>;
  assert.deepEqual(attributes.owner_deposit_declaration, { schema: "owner-deposit-declaration-v1", amountCents: "30000", declarationVersion: "legacy-trade-intake-v1" });
  assert.deepEqual(attributes.full_payout_declaration, { schema: "full-payout-declaration-v1", selected: false });
  const inventory = plan.draft.inventory as Array<{ itemId: string; quantity: string }>;
  assert.equal(inventory.find(i => i.itemId === "fixture_item_0")?.quantity, "3000000");
  assert.equal(inventory.find(i => i.itemId === "fixture_item_1")?.quantity, "120");
  assert.equal(inventory.find(i => i.itemId === "fixture_item_7")?.quantity, "7");
  assert.equal(input.display.resources.find(r => r.field === "top_insure_card_num")?.unit, "DAY");
  assert.equal(input.display.resources.find(r => r.field === "top_insure_card_num")?.quantity, "7");
  assert(!JSON.stringify(plan.draft).includes("legacy-carry"));
});
test("legacy insurance binds the original DAY identity with no separate card-count evidence", () => {
  const input = fixture(), rows=catalog(), plan=prepareLegacyTradeIntake(input,rows);
  assert.equal(plan.admission,"TRADE_CANDIDATE");assert(plan.draft);assert.equal((plan.draft.inventory as Array<{itemId:string;quantity:string}>).find(i=>i.itemId==='fixture_item_7')?.quantity,'7');
  assert(prepareLegacyTradeIntake(input,rows.map(i=>i.code==='df_billable_top_insure_card'?{...i,unit:'PIECE'}:i)).reasons.includes('CATALOG_UNIT_MISMATCH'));
  assert(prepareLegacyTradeIntake(input,rows.filter(i=>i.code!=='df_billable_top_insure_card')).reasons.includes('CATALOG_ITEM_MISSING'));
});
test("all modes retain known ratios and missing ratios do not default to ordinary", () => {
  for (const mode of ["ordinary", "custom", "fast"] as const) {
    const input = fixture(); input.display.rentalMode = mode; input.ownerRatioB = mode === "ordinary" ? null : "9.20"; bindSource(input);
    const plan = prepareLegacyTradeIntake(input, catalog());
    assert.equal(plan.admission, "TRADE_CANDIDATE", plan.reasons.join(","));
    assert.equal((plan.draft?.attributes as Record<string, unknown>).rentalPricing !== undefined, true);
    if (mode !== "ordinary") { input.ownerRatioB = null; assert(prepareLegacyTradeIntake(input, catalog()).reasons.includes("MODE_RATIO_UNPROVEN")); }
  }
});
test("missing catalog, units, source, levels, media and declaration facts are explicit blockers", () => {
  const baseline = fixture();
  const duplicate = [...catalog(), { ...catalog()[0]!, id: "another" }];
  assert(prepareLegacyTradeIntake(baseline, duplicate).reasons.includes("AMBIGUOUS_ITEM_ID"));
  const wrong = catalog(); wrong[1] = { ...wrong[1]!, unit: "PIECE" };
  assert(prepareLegacyTradeIntake(baseline, wrong).reasons.includes("CATALOG_UNIT_MISMATCH"));
  for (const mutation of [
    (v: LegacyTradeIntake) => { v.display.resources[0]!.quantity = null; },
    (v: LegacyTradeIntake) => { v.display.attributes.vit_level = 3; },
    (v: LegacyTradeIntake) => { v.media[0]!.technicalState = "UNKNOWN"; },
    (v: LegacyTradeIntake) => { v.depositYuan = null; },
    (v: LegacyTradeIntake) => { v.isFullPayout = null; },
  ]) {
    const input = fixture(); mutation(input); const plan = prepareLegacyTradeIntake(input, catalog());
    assert.equal(plan.admission, "BLOCKED"); assert.equal(plan.draft, null); assert(plan.reasons.length);
  }
});
test("selected full-payout survives as a true declaration for genuine owner acceptance", () => {
  const input = fixture(); input.isFullPayout = "1"; bindSource(input);
  const plan = prepareLegacyTradeIntake(input, catalog()); assert.equal(plan.admission, "TRADE_CANDIDATE");
  assert.deepEqual((plan.draft?.attributes as Record<string, unknown>).full_payout_declaration, { schema: "full-payout-declaration-v1", selected: true });
  assert.equal(Object.hasOwn(plan.draft!, "fullPayoutTermsAcceptance"), false);
});

test("matching source proof cannot turn a non-string-0/1 payout flag into a formal false declaration",()=>{
 for(const flag of [null,undefined,"2","",false,true,0,1]){
  const input=fixture();input.isFullPayout=flag as LegacyTradeIntake["isFullPayout"];bindSource(input);
  const plan=prepareLegacyTradeIntake(input,catalog());assert.equal(plan.admission,"BLOCKED",String(flag));assert(plan.reasons.includes("FUNDING_POLICY_UNKNOWN"),String(flag));assert.equal(plan.draft,null);
 }
});
test("frozen batch pure plan closes every row into candidate/blocked/isolated and never publishes",()=>{
 const first=fixture(),second=fixture();second.source.legacyId="34";second.accountId="another_account";second.source.sourceDigest="b".repeat(64);bindSource(second);second.media=[];
 const plan=planLegacyTradeIntakeBatch([{legacyId:"33",accountId:first.accountId,intake:first,isolationReasons:[]},{legacyId:"34",accountId:second.accountId,intake:second,isolationReasons:[]},{legacyId:"35",accountId:null,intake:null,isolationReasons:["PARTY_UNMAPPED"]}],catalog());
 assert.deepEqual(plan.counts,{total:3,tradeCandidate:1,blocked:1,isolated:1});assert.equal(plan.writeAllowed,false);assert.equal(plan.realRuntime,"NOT_RUN");assert.equal(plan.items.length,3);
 const duplicate=planLegacyTradeIntakeBatch([{legacyId:"33",accountId:first.accountId,intake:first,isolationReasons:[]},{legacyId:"33",accountId:first.accountId,intake:first,isolationReasons:[]}],catalog());assert.equal(duplicate.counts.tradeCandidate,0);assert.equal(duplicate.counts.isolated,2);
 const broken=fixture();broken.sourceFieldEvidence.digest="0".repeat(64);assert(prepareLegacyTradeIntake(broken,catalog()).reasons.includes("SOURCE_FIELD_EVIDENCE_MISMATCH"));broken.media.push({...broken.media[0]!,position:1});assert(prepareLegacyTradeIntake(broken,catalog()).reasons.includes("MEDIA_ASSET_CONFLICT"));
});

test("each media dimension blocks with its own reason instead of one merged code",()=>{
 const empty=fixture();empty.media=[];assert(prepareLegacyTradeIntake(empty,catalog()).reasons.includes("MEDIA_UNAVAILABLE"));
 const cases:Array<[Partial<(typeof empty)["media"][number]>,string]>=[
  [{technicalState:"PENDING"},"MEDIA_NOT_READY"],
  [{accessClass:"PRIVATE_REVIEW"},"MEDIA_VISIBILITY_NOT_PUBLIC"],
  [{byteHash:"not-a-hash"},"MEDIA_BYTE_HASH_INVALID"],
 ];
 for(const[patch,reason]of cases){const input=fixture();Object.assign(input.media[0]!,patch);const plan=prepareLegacyTradeIntake(input,catalog());assert.equal(plan.admission,"BLOCKED",reason);assert(plan.reasons.includes(reason),plan.reasons.join(","));}
 const position=fixture();position.media.push({...position.media[0]!,assetId:"fixture_asset_2"});assert(prepareLegacyTradeIntake(position,catalog()).reasons.includes("MEDIA_POSITION_INVALID"));
 const count=fixture();for(let i=1;i<=20;i++)count.media.push({...count.media[0]!,position:i,assetId:"fixture_asset_"+i});assert(prepareLegacyTradeIntake(count,catalog()).reasons.includes("MEDIA_ASSET_COUNT_INVALID"));
});

test("media association gate proves original→asset→byte lineage and isolates bad rows instead of crashing",()=>{
 const key="a".repeat(64),otherKey="b".repeat(64),corruptKey="c".repeat(64);
 const evidence:LegacyTradeMediaByteEvidence[]=[{storageKey:key,sha256:key,issues:[]},{storageKey:corruptKey,sha256:corruptKey,issues:[{kind:"CORRUPT_BYTES"}]}];
 const asset=(over:Partial<NonNullable<LegacyTradeMediaAssemblyRow["targetAssets"]>[number]>={})=>({assetId:"asset_1",accountId:"acct_1",ownerUserId:"owner_1",purpose:"ACCOUNT_DISPLAY",accessClass:"PUBLIC_DISPLAY",technicalState:"READY",storageKey:key,contentHash:key,...over});
 const association=(over:Partial<NonNullable<LegacyTradeMediaAssemblyRow["associations"]>[number]>={})=>({sourceRef:"legacy/img/1.png",assetId:"asset_1",storageKey:key,contentHash:key,...over});
 const row=(over:Partial<LegacyTradeMediaAssemblyRow>={})=>({legacyId:"33",accountId:"acct_1",expectedOwnerUserId:"owner_1",sourceImageRefs:["legacy/img/1.png"],targetAssets:[asset()],associations:[association()],...over});
 const ready=assembleLegacyTradeMediaGate([row()],evidence)[0]!;assert.equal(ready.ready,true,ready.reasons.join(","));assert.deepEqual(ready.reasons,[]);assert.equal(ready.evidence.byteBoundAssets,1);assert.deepEqual(ready.provenAssets.map(p=>p.assetId),["asset_1"]);
 const reasons=(over:Partial<LegacyTradeMediaAssemblyRow>)=>assembleLegacyTradeMediaGate([{...row(),...over}],evidence)[0]!.reasons;
 // SM-01: two nulls are not a binding; an empty string is not an original; unproven lineage never passes.
 const nullNull=assembleLegacyTradeMediaGate([{...row(),accountId:null,targetAssets:[asset({accountId:null})]}],evidence)[0]!;
 assert.equal(nullNull.ready,false);assert(nullNull.reasons.includes("MEDIA_SUBJECT_UNPROVEN"));
 assert(reasons({sourceImageRefs:[""]}).includes("MEDIA_SOURCE_REFERENCE_MISSING"));
 assert(reasons({sourceImageRefs:["legacy/img/replaced.png"]}).includes("MEDIA_ASSOCIATION_UNPROVEN"));
 assert(reasons({associations:null}).includes("MEDIA_ASSOCIATION_UNPROVEN"));
 assert(reasons({targetAssets:null}).includes("MEDIA_ASSET_REFERENCE_MISSING"));
 assert.deepEqual(assembleLegacyTradeMediaGate([{...row(),targetAssets:[asset({ownerUserId:"someone_else"})]}],evidence)[0]!.reasons,["MEDIA_SUBJECT_MISMATCH"]);
 assert.deepEqual(assembleLegacyTradeMediaGate([{...row(),targetAssets:[asset({ownerUserId:null})]}],evidence)[0]!.reasons,["MEDIA_SUBJECT_UNPROVEN"]);
 assert(reasons({targetAssets:[asset({purpose:"ACCOUNT_EVIDENCE"})]}).includes("MEDIA_PURPOSE_INVALID"));
 assert(reasons({targetAssets:[asset({accessClass:"PRIVATE_REVIEW"})]}).includes("MEDIA_VISIBILITY_NOT_PUBLIC"));
 assert(reasons({targetAssets:[asset({technicalState:"PENDING"})]}).includes("MEDIA_NOT_READY"));
 assert(reasons({targetAssets:[asset({storageKey:corruptKey})],associations:[association({storageKey:corruptKey,contentHash:corruptKey})]}).includes("MEDIA_BYTES_UNAVAILABLE"));
 // SM-01: conflicting byte facts for one storage key never last-win, whatever the order.
 assert(assembleLegacyTradeMediaGate([row()],evidence.concat({storageKey:key,sha256:otherKey,issues:[]}))[0]!.reasons.includes("MEDIA_BYTES_CONFLICT"));
 assert(assembleLegacyTradeMediaGate([row()],[{storageKey:key,sha256:otherKey,issues:[]},...evidence])[0]!.reasons.includes("MEDIA_BYTES_CONFLICT"));
 // SM-01: a conflicting association set is a conflict, not a winner.
 assert(reasons({associations:[association(),association({sourceRef:"legacy/img/other.png"})]}).includes("MEDIA_ASSOCIATION_CONFLICT"));
 // SM-01: one malformed asset row isolates that row's result only; the batch keeps going.
 const mixed=assembleLegacyTradeMediaGate([row(),{...row(),legacyId:"34",targetAssets:[null as never]}],evidence);
 assert.equal(mixed.length,2);assert.equal(mixed[0]!.ready,true);assert(mixed[1]!.reasons.includes("MEDIA_ASSET_INVALID"));assert.equal(mixed[1]!.ready,false);
 assert(assembleLegacyTradeMediaGate([null as never],evidence)[0]!.reasons.includes("MEDIA_ROW_INVALID"));
 const noEvidence=assembleLegacyTradeMediaGate([row()],[])[0]!;assert(noEvidence.reasons.includes("MEDIA_BYTES_UNAVAILABLE"));
 // A byte-clean platform/default file without an account binding is never usable as account media.
 const unbound=assembleLegacyTradeMediaGate([{...row(),targetAssets:[asset({accountId:null,ownerUserId:null})]}],evidence)[0]!;assert(unbound.reasons.includes("MEDIA_SUBJECT_UNPROVEN"));assert(!unbound.ready);
 for(const issues of [null,undefined,{},false,"",0]){
  const invalid=assembleLegacyTradeMediaGate([row()],[{storageKey:key,sha256:key,issues:issues as never}])[0]!;
  assert.equal(invalid.ready,false,JSON.stringify(issues));assert(invalid.reasons.includes("MEDIA_BYTES_UNAVAILABLE"));
 }
 const invalidHash=assembleLegacyTradeMediaGate([row({targetAssets:[asset({contentHash:"bad-hash"})],associations:[association({contentHash:"bad-hash"})]})],[{storageKey:key,sha256:"bad-hash",issues:[]}])[0]!;
 assert.equal(invalidHash.ready,false);assert(invalidHash.reasons.includes("MEDIA_BYTES_UNAVAILABLE"));
});

test("formal batch facts gate release, term, STANDARD base prices, occupancy and media per row and keep absent fact families visibly unobserved",()=>{
 const input=fixture(),row={legacyId:"33",accountId:input.accountId,intake:input,isolationReasons:[]};
 const byteKey="b".repeat(64);
 const mediaGate=assembleLegacyTradeMediaGate([{legacyId:"33",accountId:input.accountId,expectedOwnerUserId:input.source.expectedOwnerUserId,sourceImageRefs:null,targetAssets:null,associations:null}]);
 const readyGate=assembleLegacyTradeMediaGate([{legacyId:"33",accountId:input.accountId,expectedOwnerUserId:input.source.expectedOwnerUserId,sourceImageRefs:["legacy/img/1.png"],
   targetAssets:[{assetId:"fixture_asset",accountId:input.accountId,ownerUserId:input.source.expectedOwnerUserId,purpose:"ACCOUNT_DISPLAY",accessClass:"PUBLIC_DISPLAY",technicalState:"READY",storageKey:byteKey,contentHash:byteKey}],
   associations:[{sourceRef:"legacy/img/1.png",assetId:"fixture_asset",storageKey:byteKey,contentHash:byteKey}]}],[{storageKey:byteKey,sha256:byteKey,issues:[]}]);
 const standardPrices={priceVersionId:"price_1",lines:catalog().map(item=>({itemId:item.id,customerTier:"STANDARD"}))};
 const facts={mediaGate:readyGate,releaseByGame:{fixture_game:{releaseId:"rel_1",priceVersionId:"price_1"}},termOptionCodesByGame:{fixture_game:{releaseId:"rel_1",codes:["daily"]}},priceLinesByGame:{fixture_game:standardPrices},occupancyByAccount:{[input.accountId]:"FREE" as const}};
 const base=planLegacyTradeIntakeBatch([row],catalog(),facts);assert.equal(base.counts.tradeCandidate,1,base.items[0]!.reasons.join(","));assert.deepEqual(base.unobservedFacts,[]);assert.equal(base.stage,"FULL_ADMISSION");
 for(const key of Object.keys(facts) as Array<keyof typeof facts>)for(const value of [null,false,"",0,[]]){
  if(key==="mediaGate"&&Array.isArray(value))continue;
  const malformed={...facts,[key]:value} as unknown as NonNullable<Parameters<typeof planLegacyTradeIntakeBatch>[2]>;
  const invalid=planLegacyTradeIntakeBatch([row],catalog(),malformed);
  assert.equal(invalid.counts.tradeCandidate,0,key);assert.equal(invalid.counts.isolated,1,key);assert(invalid.items[0]!.reasons.includes("SOURCE_SCHEMA_INVALID"),key);
  if(value===null){assert(invalid.unobservedFacts.includes(key));assert.equal(invalid.stage,"INTAKE_PRECHECK");}
 }
 const reasons=(override:NonNullable<Parameters<typeof planLegacyTradeIntakeBatch>[2]>)=>planLegacyTradeIntakeBatch([row],catalog(),{...facts,...override}).items[0]!.reasons;
 assert(reasons({releaseByGame:{fixture_game:null}}).includes("RELEASE_NOT_BOUND"));
 assert(reasons({termOptionCodesByGame:{fixture_game:{releaseId:"rel_old",codes:["daily"]}}}).includes("TERM_FACT_VERSION_MISMATCH"));
 assert(reasons({termOptionCodesByGame:{fixture_game:{releaseId:"rel_1",codes:["other"]}}}).includes("TERM_OPTION_UNPROVEN"));
 assert(reasons({priceLinesByGame:{fixture_game:{priceVersionId:"price_old",lines:standardPrices.lines}}}).includes("PRICE_FACT_VERSION_MISMATCH"));
 const missingStandard={priceVersionId:"price_1",lines:standardPrices.lines.filter(p=>!(p.customerTier==="STANDARD"&&p.itemId===catalog()[0]!.id))};
 assert(reasons({priceLinesByGame:{fixture_game:missingStandard}}).includes("PRICE_LINE_MISSING"));
 // SM-03: the retired legacy member tiers are never a takeover precondition on top of the STANDARD base.
 assert(reasons({occupancyByAccount:{[input.accountId]:"UNKNOWN"}}).includes("OCCUPANCY_UNKNOWN"));
 assert(reasons({occupancyByAccount:{[input.accountId]:"OCCUPIED"}}).includes("OCCUPIED"));
 assert.deepEqual(reasons({occupancyByAccount:{}}),["OCCUPANCY_UNKNOWN"]);
 assert(reasons({mediaGate}).includes("MEDIA_SOURCE_REFERENCE_MISSING"));
 const none=planLegacyTradeIntakeBatch([row],catalog());assert.equal(none.counts.tradeCandidate,1);assert.equal(none.unobservedFacts.length,5);assert.equal(none.stage,"INTAKE_PRECHECK");
 // SM-02: a provided-but-empty media family is a missing row, not a satisfied one.
 const emptyFamily=planLegacyTradeIntakeBatch([row],catalog(),{...facts,mediaGate:[]});assert.equal(emptyFamily.counts.tradeCandidate,0);assert(emptyFamily.items[0]!.reasons.includes("MEDIA_GATE_MISSING"));
 // SM-02: ready=false with no reasons cannot pass either.
 assert(planLegacyTradeIntakeBatch([row],catalog(),{...facts,mediaGate:[{legacyId:"33",accountId:input.accountId,ready:false,reasons:[],provenAssets:[],evidence:{sourceRefCount:0,observedAssetCount:0,byteBoundAssets:0}}]}).items[0]!.reasons.includes("MEDIA_GATE_INVALID"));
 // SM-02: conflicting duplicate subject gates isolate; identical duplicates are the same fact.
 const failingGate={...readyGate[0]!,ready:false,reasons:["MEDIA_BYTES_UNAVAILABLE"]};
 assert.equal(planLegacyTradeIntakeBatch([row],catalog(),{...facts,mediaGate:[failingGate,readyGate[0]!]}).counts.isolated,1);
 assert.equal(planLegacyTradeIntakeBatch([row],catalog(),{...facts,mediaGate:[readyGate[0]!,{...readyGate[0]!}]}).counts.tradeCandidate,1);
 // SM-02: a gate proving another asset than the one the intake declares is not this row's proof.
 const otherAssetGate=assembleLegacyTradeMediaGate([{legacyId:"33",accountId:input.accountId,expectedOwnerUserId:input.source.expectedOwnerUserId,sourceImageRefs:["legacy/img/1.png"],
   targetAssets:[{assetId:"somebody_else_asset",accountId:input.accountId,ownerUserId:input.source.expectedOwnerUserId,purpose:"ACCOUNT_DISPLAY",accessClass:"PUBLIC_DISPLAY",technicalState:"READY",storageKey:byteKey,contentHash:byteKey}],
   associations:[{sourceRef:"legacy/img/1.png",assetId:"somebody_else_asset",storageKey:byteKey,contentHash:byteKey}]}],[{storageKey:byteKey,sha256:byteKey,issues:[]}]);
 assert(planLegacyTradeIntakeBatch([row],catalog(),{...facts,mediaGate:otherAssetGate}).items[0]!.reasons.includes("MEDIA_GATE_INTAKE_MISMATCH"));
 // Two rows claiming the same reviewed original digest are all isolated, never the first one kept.
 const twin={legacyId:"34",accountId:"acct_2",intake:{...input,accountId:"acct_2"},isolationReasons:[]};
 const dup=planLegacyTradeIntakeBatch([row,twin],catalog(),facts);assert.equal(dup.counts.isolated,2);assert(dup.items.every(i=>i.reasons.includes("DUPLICATE_SOURCE_OR_TARGET")));
 // One malformed row isolates alone; other rows keep their result.
 const malformed={legacyId:"35",accountId:"broken",intake:{contentHash:"legal-json-unrepresentable"} as never,isolationReasons:[]};
 const mixed=planLegacyTradeIntakeBatch([row,malformed],catalog(),facts);assert.equal(mixed.counts.tradeCandidate,1);assert.equal(mixed.counts.isolated,1);assert(mixed.items[1]!.reasons.includes("SOURCE_SCHEMA_INVALID"));
});

const accountRow=(over:Record<string,string|null>={})=>({id:"33",user_id:"11",game_id:"1",status:"0",is_delete:"0",no:"NO-33",price_tenant:"10.00",extra_goods_total_price_tenant:"0.00",deposit_amount:"300.00",rental_days:"1",default_consume_type:"1",update_time:"1760000000",is_full_payout:"0",...over});
const row12=(full:Record<string,string|null>)=>{const{is_full_payout:_flag,...rest}=full;return rest;};
test("batch assembly recomputes both digests from the reviewed 13-column original and rejects an unproven payout flag",()=>{
 const original={sourceAsOf:"2026-09-13T13:31:22.000Z",extractSha256:"e".repeat(64),row:accountRow()};
 const base=fixture();base.source.sourceDigest=sha256Hex(canonicalize(row12(original.row)));bindSource(base);
 const extraction=(originalOverride:unknown)=>[{legacyId:"33",accountId:base.accountId,intake:base,isolationReasons:[],original:originalOverride as LegacyTradeExtractionOriginal|null}];
 const [bound]=assembleLegacyTradeIntakeBatch(extraction(original),"2026-09-13T13:31:22.000Z");
 assert(bound);assert.deepEqual(bound.isolationReasons,[]);
 assert.equal(bound.projection!.old12Digest,base.source.sourceDigest);
 assert.equal(bound.projection!.new13Digest,sha256Hex(canonicalize(original.row)));
 assert.notEqual(bound.projection!.old12Digest,bound.projection!.new13Digest);
 for(const[originalOverride,reason]of [
  [null,"FLAG_EXTRACTION_SOURCE_MISSING"],
  [{...original,sourceAsOf:"2026-09-13T00:00:00.000Z"},"FLAG_EXTRACTION_CUTOFF_MISMATCH"],
  [{...original,extractSha256:"zz"},"FLAG_EXTRACTION_SOURCE_INVALID"],
  [{...original,row:{...original.row,extra:"1"}},"FLAG_EXTRACTION_ROW_INVALID"],
  [{...original,row:accountRow({id:"99"})},"FLAG_EXTRACTION_ROW_MISMATCH"],
  [{...original,row:accountRow({is_full_payout:"1"})},"FLAG_EXTRACTION_FLAG_MISMATCH"],
  [{...original,row:accountRow({no:"NO-CHANGED"})},"FLAG_EXTRACTION_DIGEST_MISMATCH"],
 ] as const){
  const [isolated]=assembleLegacyTradeIntakeBatch(extraction(originalOverride),"2026-09-13T13:31:22.000Z");
  assert(isolated);assert.deepEqual(isolated.isolationReasons,[reason],JSON.stringify(originalOverride));
  assert.equal(isolated.projection,null);assert.equal(planLegacyTradeIntakeBatch([isolated],catalog()).counts.isolated,1,reason);
 }
 const declared=assembleLegacyTradeIntakeBatch(extraction({old12Digest:base.source.sourceDigest,new13Digest:"0".repeat(64)}));
 assert.deepEqual(declared[0]!.isolationReasons,["FLAG_EXTRACTION_SOURCE_INVALID"]);assert.equal(declared[0]!.projection,null);
 const illegal=fixture();illegal.source.sourceDigest=base.source.sourceDigest;illegal.isFullPayout="2" as LegacyTradeIntake["isFullPayout"];bindSource(illegal);
 const illegalPlan=planLegacyTradeIntakeBatch(assembleLegacyTradeIntakeBatch([{legacyId:"33",accountId:illegal.accountId,intake:illegal,isolationReasons:[],original:{...original,row:accountRow({is_full_payout:"2"})}}],"2026-09-13T13:31:22.000Z"),catalog());
 assert.equal(illegalPlan.items[0]!.admission,"BLOCKED");assert(illegalPlan.items[0]!.reasons.includes("FUNDING_POLICY_UNKNOWN"));
 const missing=fixture();missing.isFullPayout=null;bindSource(missing);
 const [noFlag]=assembleLegacyTradeIntakeBatch([{legacyId:"33",accountId:missing.accountId,intake:missing,isolationReasons:[],original:null}]);assert(noFlag);
 assert.equal(noFlag.intake!.isFullPayout,null);assert.deepEqual(noFlag.isolationReasons,[]);
 const missingPlan=planLegacyTradeIntakeBatch([noFlag],catalog());
 assert.equal(missingPlan.counts.blocked,1);assert(missingPlan.items[0]!.reasons.includes("FUNDING_POLICY_UNKNOWN"));
 const [missingBinding]=assembleLegacyTradeIntakeBatch([{legacyId:"34",accountId:null,intake:null,isolationReasons:[],original:null}]);assert(missingBinding);
 assert.deepEqual(missingBinding.isolationReasons,["SOURCE_BINDING_MISSING"]);
});
test("one malformed extraction row isolates without failing the frozen batch and modifying any other row or the catalog changes the batch fingerprint",()=>{
 const good=fixture(),bad={legacyId:"34",accountId:"broken",intake:{contentHash:"legal-json-unrepresentable"} as unknown as LegacyTradeIntake,isolationReasons:[]};
 const run=(catalogOverride?:TradeCatalogItem[])=>planLegacyTradeIntakeBatch([{legacyId:"33",accountId:good.accountId,intake:good,isolationReasons:[]},bad],catalogOverride??catalog());
 const plan=run();
 assert.equal(plan.counts.total,2);assert.equal(plan.counts.isolated,1);assert.equal(plan.counts.tradeCandidate,1);
 const broken=plan.items.find(i=>i.legacyId==="34")!;assert(broken.reasons.includes("SOURCE_SCHEMA_INVALID"));assert.equal(broken.sourceDigest,null);
 assert.equal(plan.inputDigest.length,64);assert.notEqual(plan.inputDigest,sha256Hex("UNREPRESENTABLE_ROW"));
 assert.equal(run().inputDigest,plan.inputDigest);
 good.title="DIFFERENT_TITLE";
 const changed=run();
 assert.notEqual(plan.inputDigest,changed.inputDigest);
 assert.notEqual(plan.items[0]!.inputDigest,changed.items[0]!.inputDigest);
 const otherCatalog=run([...catalog(),{id:"extra",code:"haff_base",unit:"HAFF_BASE",quantityScale:0}]);
 assert.notEqual(plan.inputDigest,otherCatalog.inputDigest);
 assert.equal(stableFingerprint({a:1}),stableFingerprint({a:1}));assert.notEqual(stableFingerprint({a:1}),stableFingerprint({a:2}));
});
test("actual maintenance chain saves and quotes formal native fields before publication; selected payout stops for genuine owner acceptance",async t=>{
 const p:typeof import("../src/supply/publishing")=require("../src/supply/publishing"),legacy:typeof import("../src/supply/legacy-observation")=require("../src/supply/legacy-observation"),auth:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security"),access:typeof import("../src/auth/admin-authorization")=require("../src/auth/admin-authorization"),funding:typeof import("../src/supply/funding-authority")=require("../src/supply/funding-authority");
 const actor={id:"fixture_admin",sessionId:"fixture_session",requestId:"req_fixture"},gate:import("../src/supply/publishing").SupplyGateReader=async()=>({publisherBail:"NOT_REQUIRED",occupancy:"FREE",reference:"FIXTURE_ONLY"});
 for(const selected of [false,true]){
  const input=fixture();input.isFullPayout=selected?"1":"0";input.termOptionCode="daily-10m";bindSource(input);const plan=prepareLegacyTradeIntake(input,catalog());assert(plan.draft);
  const declaration={...plan.draft,mediaBindings:plan.expectedMedia} as ContentDeclaration,priced=computeDeltaQuote({priceVersionId:"fixture_price",mode:"SPREAD",roundingPolicy:"HALF_UP_CENT_V1",customerTier:"STANDARD",haffRule:compatRule(),lines:[{itemId:"fixture_item_0",quantity:"3000000",pricingKind:"HAFF_RATIO",unit:"HAFF_BASE",customerTier:"STANDARD"}],conditions:{safeBoxCode:"box-a",vitLevel:6,bearLevel:6,termOptionCode:"daily-10m",rentalPricing:{rentalMode:"ordinary"}},termOption:{code:"daily-10m",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"}});assert(priced.quotable);
  const payload=normalizeContentPayload({schemaVersion:2,accountId:input.accountId,gameId:input.source.expectedGameId,declaration,ruleRefs:{releaseId:"fixture_release",catalogRevision:"1",priceVersionId:"fixture_price",termVersionId:"fixture_term",agreementVersionId:"fixture_agreement",agreementDigest:"d".repeat(64)},quoteValues:priced.quote});
  const a={id:input.accountId,owner_user_id:input.source.expectedOwnerUserId,game_id:input.source.expectedGameId,current_version_id:"fixture_draft",revision:"1",owner_paused:false,staff_restricted:false,restriction_reason:null,legacy_hold:"NONE",lifecycle:"ACTIVE",display_no:null},version={id:"fixture_draft",origin:"NATIVE",review_state:"DRAFT",content_hash:computeContentHash(payload),rule_release_id:"fixture_release",attributes:payload.declaration.attributes,payload} as import("../src/supply/publishing").ListingVersion,calls:string[]=[],queries:string[]=[];let accepted=false,badDisplay=false,foreignMedia=false,missingTier=false;
  t.mock.method(p,"lockPublishingAccount",async()=>a);t.mock.method(p,"currentVersion",async()=>version);t.mock.method(p,"assertCurrentRelease",async()=>{});t.mock.method(p,"readDeclaration",async()=>payload.declaration);
  t.mock.method(p,"saveListingDraft",async(_c:import("pg").PoolClient,_a:import("../src/supply/publishing").PublishingAccount,body:Record<string,unknown>)=>{calls.push("save");assert.deepEqual(body,{...plan.draft,expectedRevision:"1"});});t.mock.method(p,"quoteListing",async(_c:unknown,_a:unknown,_r:unknown,ctx:import("../src/supply/publishing").LegacyTakeoverGradingContext|undefined)=>{assert.deepEqual(ctx,{kind:"VERIFIED_LEGACY_TAKEOVER",accountId:a.id,sourceDigest:input.source.sourceDigest,observationVersionId:input.source.expectedObservationVersionId,gradingCode:"4",gradingDivision:null});calls.push("quote");});t.mock.method(p,"reviewListing",async(_c:unknown,_a:unknown,_id:unknown,_b:unknown,_g:unknown,ctx:import("../src/supply/publishing").LegacyTakeoverGradingContext|undefined)=>{assert.equal(ctx?.gradingCode,"4");assert.equal(ctx?.gradingDivision,null);assert.equal(ctx?.sourceDigest,input.source.sourceDigest);calls.push("review");});
  t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:true,permissions:new Set(["supply.catalog.manage","supply.review.decide"])} as Awaited<ReturnType<typeof access.loadEffectiveAdminAccess>>));
  t.mock.method(legacy,"lockLegacySource",async()=>{});t.mock.method(legacy,"readLegacyMap",async()=>({account_id:a.id,source_digest:input.source.sourceDigest,version_id:input.source.expectedObservationVersionId}) as Awaited<ReturnType<typeof legacy.readLegacyMap>>);
  t.mock.method(funding,"readFundingPolicyForRelease",async()=>({ownerDepositRules:{normal:{minCents:"1"},fullPayoutSelected:{minCents:"30000"},capCents:"999999"}} as import("../src/supply/funding-policy").FundingPolicy));
  const sourceUpdatedAt=new Date("2026-10-15T00:00:00Z"),extractSha256="e".repeat(64),evidenceRef="FIXTURE_DISPLAY",displayDigest=legacyDisplayDigest(a.id,{observationVersionId:input.source.expectedObservationVersionId,baseSourceDigest:input.source.sourceDigest,extractSha256,sourceUpdatedAt:sourceUpdatedAt.toISOString(),evidenceRef,snapshot:input.display});
  const client={query:async(sql:string)=>{queries.push(sql);if(sql.includes("e.action='supply.legacy.trade_draft_write'"))return {rows:[{}],rowCount:1};if(sql.includes("legacy_listing_display_snapshot"))return {rows:[{observation_version_id:input.source.expectedObservationVersionId,base_source_digest:input.source.sourceDigest,extract_sha256:extractSha256,source_updated_at:sourceUpdatedAt,evidence_ref:evidenceRef,snapshot:input.display,display_digest:badDisplay?"0".repeat(64):displayDigest}],rowCount:1};if(sql.includes("SELECT title,description"))return {rows:[{title:input.title,description:input.description}],rowCount:1};if(sql.includes("SELECT id,code,unit"))return {rows:catalog(),rowCount:catalog().length};if(sql.includes("FROM zzsh_supply.listing_media m JOIN zzsh_supply.media_asset a")){const rows=plan.expectedMedia.map(m=>({id:m.assetId,account_id:foreignMedia?"foreign_account":a.id,owner_user_id:foreignMedia?"foreign_owner":a.owner_user_id,purpose:"ACCOUNT_DISPLAY"}));return {rows,rowCount:rows.length};}if(sql.includes("unnest($2::text[])"))return {rows:missingTier?[{}]:[],rowCount:missingTier?1:0};if(sql.includes("acceptance_kind='OWNER_ACCEPTED'"))return {rows:accepted?[{}]:[],rowCount:accepted?1:0};if(sql.includes("details->>'batchId'"))return {rows:[{}],rowCount:1};return {rows:[],rowCount:0};}} as unknown as import("pg").PoolClient;
  const result=await takeoverLegacyTrade(client,actor,{batchId:"fixture_batch",intake:input},gate);assert.deepEqual(calls,selected?["save","quote"]:["save","quote","review"]);assert.equal((result.body as {state:string}).state,selected?"OWNER_ACCEPTANCE_REQUIRED":"PUBLISHED");
  assert.equal(queries.some(q=>q.includes("'LEGACY_TAKEOVER_AUTHORIZED'")),!selected);assert(!queries.some(q=>/INSERT INTO zzsh_order\.rental_order|ledger_entry/.test(q)));
  if(selected){const finalize={accountId:a.id,source:input.source,batchId:"fixture_batch",expectedRevision:"1",versionId:version.id,contentHash:version.content_hash!,releaseId:version.rule_release_id!};await assert.rejects(()=>finalizeLegacyTradeTakeover(client,actor,finalize,gate),/TERMS_ACCEPTANCE_REQUIRED/);assert.deepEqual(calls,["save","quote"]);accepted=true;assert.equal((await finalizeLegacyTradeTakeover(client,actor,finalize,gate)).status,200);assert.deepEqual(calls,["save","quote","review"]);}
  calls.length=0;
  for(const flag of [null,undefined,"2","",false,true,0,1]){const invalid=structuredClone(input);invalid.isFullPayout=flag as LegacyTradeIntake["isFullPayout"];bindSource(invalid);await assert.rejects(()=>takeoverLegacyTrade(client,actor,{batchId:"fixture_batch",intake:invalid},gate),/FUNDING_POLICY_UNKNOWN/);assert.deepEqual(calls,[]);}
  badDisplay=true;await assert.rejects(()=>takeoverLegacyTrade(client,actor,{batchId:"fixture_batch",intake:input},gate),/DISPLAY_SOURCE_BINDING_MISMATCH/);assert.deepEqual(calls,[]);
  // A foreign asset bound to the draft is a subject mismatch, not a publishable listing.
  badDisplay=false;foreignMedia=true;await assert.rejects(()=>takeoverLegacyTrade(client,actor,{batchId:"fixture_batch",intake:input},gate),/MEDIA_BINDING_SUBJECT_MISMATCH/);assert.deepEqual(calls,["save","quote"]);calls.length=0;foreignMedia=false;
  // A missing STANDARD base line still blocks publish readiness (the retired legacy tiers do not).
  missingTier=true;await assert.rejects(()=>takeoverLegacyTrade(client,actor,{batchId:"fixture_batch",intake:input},gate),/MEMBER_PRICE_LINE_MISSING/);assert.deepEqual(calls,["save","quote"]);calls.length=0;missingTier=false;
  t.mock.restoreAll();
 }
});
/** The restored catalogue carries the same DAY insurance identity used by new declarations. */
function legacyDayCatalog(): TradeCatalogItem[] {
  return DELTA_LEGACY_RESOURCES.map(([field, codes], i) => ({ id: "fixture_item_" + i, code: field === "top_insure_card_num" ? "df_billable_top_insure_card" : codes[0], unit: field === "haff" ? "HAFF_BASE" : field.includes("bullet") ? "ROUND" : field === "top_insure_card_num" ? "DAY" : "PIECE", quantityScale: 0 }));
}
/** Restored-shaped intake: every resource carries a real value, the placeholder title and no media. */
function restoredFixture(): LegacyTradeIntake {
  const display = convertLegacyDisplayFields({ insure_lv: "4", grading_lv: "4", login_way: "1", vit_lv: "7", bear_lv: "7", dive_lv: "3", character_lv: "60", processing_time_start: "8", processing_time_end: "22", secret_kd: "1.20", ratio_type: "default", high_risk_owner: "0", ban_record: "0", face_is_self: "1", haff: "3", awm_bullet_num: "1", level6_bullet_num: "2", level6_helmet_num: "0", level6_armor_num: "1", barrett_bullet_num: "1", coffee_num: "0", top_insure_card_num: "7" });
  return bindSource({ accountId: "restored_account", source: { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: "37017", sourceDigest: "a".repeat(64), expectedObservationVersionId: "restored_observation", expectedOwnerUserId: "restored_owner", expectedGameId: "restored_game" }, display,
    title: "历史资料待核实", description: null, depositYuan: "400.00", isFullPayout: "0", ownerRatioB: null, termOptionCode: "daily-10m", pricingOptionCode: "standard", skins: [], entitlements: [], media: [],
    sourceFieldEvidence: { canonical: "", digest: "", extractSha256: "", evidenceRef: "" } });
}
test("the shared declaration includes original insurance days while title and media remain publish-gated", () => {
  const input = restoredFixture(), catalog = legacyDayCatalog(), built = buildLegacyTradeDeclaration(input, catalog);
  assert.deepEqual(built.deferred, ["TITLE_REVIEW_REQUIRED"]);
  assert.deepEqual(built.blockers, []);
  assert(built.declaration);
  const inventory = built.declaration!.inventory as Array<{ itemId: string;quantity:string }>;
  assert.equal(inventory.length, 8);
  assert.equal(inventory.find(i => i.itemId === "fixture_item_7")?.quantity,'7');
  const plan = prepareLegacyTradeIntake(input, catalog);
  assert.equal(plan.admission, "BLOCKED");
  assert(!plan.reasons.includes("INSURANCE_UNIT_PENDING"));
  assert(!plan.reasons.includes("CATALOG_ITEM_MISSING"));
  assert.equal(plan.draft, null);
});
test("formal takeover is never reported as a draft result when publish-grade facts or the price basis are missing", async t => {
  const p: typeof import("../src/supply/publishing") = require("../src/supply/publishing"), legacy: typeof import("../src/supply/legacy-observation") = require("../src/supply/legacy-observation"), auth: typeof import("../src/auth/auth-security") = require("../src/auth/auth-security"), access: typeof import("../src/auth/admin-authorization") = require("../src/auth/admin-authorization");
  const actor = { id: "fixture_admin", sessionId: "fixture_session", requestId: "req_fixture" }, gate: import("../src/supply/publishing").SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "FIXTURE_ONLY" });
  const input = restoredFixture(), catalog = legacyDayCatalog(), calls: string[] = [];
  // Real admission: no media and placeholder title keep the row BLOCKED,
  // so the formal takeover must refuse before it writes or quotes anything.
  assert.equal(prepareLegacyTradeIntake(input, catalog).admission, "BLOCKED");
  const account = { id: input.accountId, owner_user_id: input.source.expectedOwnerUserId, game_id: input.source.expectedGameId, current_version_id: input.source.expectedObservationVersionId, revision: "1", owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "UNRESOLVED", lifecycle: "ACTIVE", display_no: null };
  t.mock.method(p, "lockPublishingAccount", async () => account as unknown as import("../src/supply/publishing").PublishingAccount);
  t.mock.method(p, "saveListingDraft", async () => { calls.push("save"); });
  t.mock.method(p, "quoteListing", async () => { calls.push("quote"); });
  t.mock.method(auth, "assertAdminContextInTransaction", async () => {});
  t.mock.method(access, "loadEffectiveAdminAccess", async () => ({ status: "ACTIVE", isBoss: true, permissions: new Set(["supply.catalog.manage", "supply.review.decide"]) } as Awaited<ReturnType<typeof access.loadEffectiveAdminAccess>>));
  t.mock.method(legacy, "lockLegacySource", async () => {});
  t.mock.method(legacy, "readLegacyMap", async () => ({ account_id: account.id, source_digest: input.source.sourceDigest, version_id: input.source.expectedObservationVersionId }) as Awaited<ReturnType<typeof legacy.readLegacyMap>>);
  const sourceUpdatedAt = new Date("2026-10-16T00:00:00Z"), extractSha256 = "e".repeat(64), evidenceRef = "FIXTURE_DISPLAY", displayDigest = legacyDisplayDigest(account.id, { observationVersionId: input.source.expectedObservationVersionId, baseSourceDigest: input.source.sourceDigest, extractSha256, sourceUpdatedAt: sourceUpdatedAt.toISOString(), evidenceRef, snapshot: input.display });
  const client = {
    query: async (sql: string) => {
      if (sql.includes("legacy_listing_display_snapshot")) return { rows: [{ observation_version_id: input.source.expectedObservationVersionId, base_source_digest: input.source.sourceDigest, extract_sha256: extractSha256, source_updated_at: sourceUpdatedAt, evidence_ref: evidenceRef, snapshot: input.display, display_digest: displayDigest }], rowCount: 1 };
      if (sql.includes("SELECT title,description")) return { rows: [{ title: input.title, description: input.description }], rowCount: 1 };
      if (sql.includes("SELECT id,code,unit")) return { rows: catalog, rowCount: catalog.length };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as import("pg").PoolClient;
  await assert.rejects(() => takeoverLegacyTrade(client, actor, { batchId: "fixture_batch", intake: input }, gate), /MEDIA_UNAVAILABLE|TITLE_REVIEW_REQUIRED/);
  assert.deepEqual(calls, [], "no draft, quote or publish work may happen for a blocked admission");
  t.mock.restoreAll();
});
test("ordinary draft chain saves the converted declaration without a quote and a separate real quote rejects the missing price line", async () => {
  const publishing: typeof import("../src/supply/publishing") = require("../src/supply/publishing");
  const gate: import("../src/supply/publishing").SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "FIXTURE_ONLY" });
  const input = restoredFixture(), catalog = legacyDayCatalog(), built = buildLegacyTradeDeclaration(input, catalog);
  assert(built.declaration);
  const declaration = { ...built.declaration, mediaBindings: [] } as unknown as ContentDeclaration;
  const account = { id: input.accountId, owner_user_id: input.source.expectedOwnerUserId, game_id: input.source.expectedGameId, current_version_id: "fixture_draft", revision: "1", owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "NONE", lifecycle: "ACTIVE", display_no: null } as unknown as import("../src/supply/publishing").PublishingAccount;
  const version = { id: "fixture_draft", account_id: account.id, sequence: "2", origin: "NATIVE", review_state: "DRAFT", revision: "1", title: "历史资料待核实", description: null, attributes: {}, term_option_code: "", pricing_option_code: "", schema_version: 1, payload: null, content_hash: null, rule_release_id: null, presentation: null } as unknown as import("../src/supply/publishing").ListingVersion;
  const statements: string[] = [];
  const saveClient = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: false }], rowCount: 1 };
      if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [], rowCount: 0 };
      if (sql.includes("game_service_operation")) return { rows: [{ id: "s", gameId: account.game_id, gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1" }], rowCount: 1 };
      if (sql.startsWith("SELECT * FROM zzsh_supply.listing_version")) return { rows: [version], rowCount: 1 };
      if (sql.includes('quantity_scale AS "quantityScale" FROM zzsh_supply.billable_item')) return { rows: catalog, rowCount: catalog.length };
      if (sql.includes("RETURNING revision::text")) return { rows: [{ revision: "2" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as import("pg").PoolClient;
  // The ordinary chain persists the declaration; no quote runs inside this step.
  await publishing.saveListingDraft(saveClient, account, { ...declaration, expectedRevision: "1" }, gate);
  assert.equal(statements.some((sql) => /INSERT INTO zzsh_supply\.inventory_line/.test(sql)), true);
  // Draft persistence never runs pricing work: the version is left without payload/price binding.
  assert.equal(statements.some((sql) => sql.includes("UPDATE zzsh_supply.listing_version SET title=")), true);
  assert.equal(statements.some((sql) => /FROM zzsh_supply\.price_line|FROM zzsh_supply\.rule_release/.test(sql)), false);
  assert.equal(account.revision, "2");
  // A later, independent real quote rejects because the current SEALED price version has no
  // STANDARD line for the declared items; the missing price is never mocked into success.
  const quoteClient = {
    query: async (sql: string) => {
      if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: false }], rowCount: 1 };
      if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [], rowCount: 0 };
      if (sql.includes("game_service_operation")) return { rows: [{ id: "s", gameId: account.game_id, gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1" }], rowCount: 1 };
      if (sql.startsWith("SELECT * FROM zzsh_supply.listing_version")) return { rows: [{ ...version, rule_release_id: "fixture_release", attributes: declaration.attributes, term_option_code: declaration.termOptionCode, pricing_option_code: declaration.pricingOptionCode }], rowCount: 1 };
      if (sql.includes("FROM zzsh_supply.term_option")) return { rows: [{ code: declaration.termOptionCode, dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }], rowCount: 1 };
      if (sql.includes("FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item i")) return { rows: [{ itemId: catalog[0]!.id, code: catalog[0]!.code, quantity: "1", unit: catalog[0]!.unit, name: "x", enabled: true, pricingKind: null, unitQuantity: null, buyerUnitAmount: null, ownerUnitAmount: null }], rowCount: 1 };
      if (sql.includes("zzsh_supply.inventory_line WHERE version_id")) return { rows: [{ itemId: catalog[0]!.id, quantity: "1" }], rowCount: 1 };
      if (sql.includes("JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id")) return { rows: [{ id: "fixture_release", price_version_id: "fixture_price", term_version_id: "fixture_term", agreement_version_id: "fixture_agreement", mode: "SPREAD", commission_rate: null, haff_rule: {}, rounding_policy: "HALF_UP_CENT_V1", catalogRevision: "1", digest: "d".repeat(64) }], rowCount: 1 };
      if (sql.includes("zzsh_supply.listing_skin")) return { rows: [], rowCount: 0 };
      if (sql.includes("zzsh_supply.listing_entitlement")) return { rows: [], rowCount: 0 };
      if (sql.includes("zzsh_supply.listing_media")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM zzsh_supply.billable_item i WHERE")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as import("pg").PoolClient;
  await assert.rejects(() => publishing.quoteListing(quoteClient, account, account.revision), /请补齐小段位/);
  await assert.rejects(() => publishing.quoteListing(quoteClient, account, account.revision, {kind:"VERIFIED_LEGACY_TAKEOVER",accountId:account.id,sourceDigest:input.source.sourceDigest,observationVersionId:input.source.expectedObservationVersionId,gradingCode:"4",gradingDivision:null}), /申报物品不在当前可用价目中/);
});

test("ordinary draft command saves one legacy observation without quote, review, takeover or an observation update", async (t) => {
  const sourceRoot = join(process.cwd(), "src");
  const source = readFileSync(join(sourceRoot, "supply/legacy-trade-takeover.ts"), "utf8");
  const fn = source.slice(source.indexOf("export async function applyLegacyOrdinaryDraft"), source.indexOf("export async function takeoverLegacyTrade"));
  for (const name of ["quoteListing(", "reviewListing(", "takeoverLegacyTrade(", "finalizeLegacyTradeTakeover(", "publishTakenOverDraft(", "withIdempotency("]) assert.equal(fn.includes(name), false, name);
  const publishingSource = readFileSync(join(sourceRoot, "supply/publishing.ts"), "utf8");
  const blockers = publishingSource.slice(publishingSource.indexOf("export async function publicationBlockers"), publishingSource.indexOf("export async function assertEditable"));
  assert.match(blockers, /purpose === "WRITE"/);
  assert.match(blockers, /TITLE_REVIEW_REQUIRED/);
  assert.match(blockers, /if \(policy\)/);
  const submit = publishingSource.slice(publishingSource.indexOf("export async function submitListing"), publishingSource.indexOf("export async function withdrawListing"));
  const review = publishingSource.slice(publishingSource.indexOf("export async function reviewListing"), publishingSource.indexOf("export async function withdrawListing") > publishingSource.indexOf("export async function reviewListing") ? publishingSource.indexOf("async function bumpAccount", publishingSource.indexOf("export async function reviewListing")) : publishingSource.length);
  assert.ok(submit.indexOf("publicationBlockers") < submit.indexOf("INSERT INTO zzsh_supply.listing_publication"));
  assert.ok(review.includes("publicationBlockers"));
  assert.ok(review.indexOf("publicationBlockers") < review.indexOf("INSERT INTO zzsh_supply.review_decision"));
  for (const relative of ["../src/order/legacy-continuation-routes.ts", "../src/order/legacy-continuation-command.ts", "../src/order/settlement-record.ts", "../src/supply/funding-authority.ts"]) {
    const text = readFileSync(join(sourceRoot, relative.replace("../src/", "")), "utf8");
    assert.equal(text.includes("legacy-draft"), false, relative);
    assert.equal(text.includes("trade_draft_write"), false, relative);
    assert.equal(text.includes("applyLegacyOrdinaryDraft"), false, relative);
  }
  const p: typeof import("../src/supply/publishing") = require("../src/supply/publishing");
  const legacy: typeof import("../src/supply/legacy-observation") = require("../src/supply/legacy-observation");
  const auth: typeof import("../src/auth/auth-security") = require("../src/auth/auth-security");
  const access: typeof import("../src/auth/admin-authorization") = require("../src/auth/admin-authorization");
  const actor = { id: "fixture_admin", sessionId: "fixture_session", requestId: "req_fixture" };
  const gate: import("../src/supply/publishing").SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "FIXTURE_ONLY" });
  const input = restoredFixture();
  input.media = [];
  const rows = legacyDayCatalog();
  const account = { id: input.accountId, owner_user_id: input.source.expectedOwnerUserId, game_id: input.source.expectedGameId, current_version_id: input.source.expectedObservationVersionId, revision: "1", owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "UNRESOLVED", lifecycle: "ACTIVE", display_no: null };
  const calls: string[] = [];
  const queries: string[] = [];
  const audits: unknown[] = [];
  let saved: Record<string, unknown> | null = null;
  t.mock.method(p, "lockPublishingAccount", async () => account);
  t.mock.method(p, "currentVersion", async () => account.current_version_id === "draft_1"
    ? { id: "draft_1", origin: "NATIVE", review_state: "DRAFT", title: "历史资料待核实", description: null }
    : { id: input.source.expectedObservationVersionId, origin: "LEGACY_OBSERVATION", review_state: "IMPORTED_UNVERIFIED", title: input.title, description: input.description });
  t.mock.method(p, "saveListingDraft", async (_client: unknown, _account: unknown, body: Record<string, unknown>) => { calls.push("save"); saved = body; });
  t.mock.method(p, "quoteListing", async () => { calls.push("quote"); });
  t.mock.method(p, "reviewListing", async () => { calls.push("review"); });
  t.mock.method(p, "readDeclaration", async () => { const { expectedRevision: _revision, ...rest } = saved!; return rest; });
  t.mock.method(legacy, "lockLegacySource", async () => {});
  t.mock.method(legacy, "readLegacyMap", async () => ({ account_id: account.id, source_digest: input.source.sourceDigest, version_id: input.source.expectedObservationVersionId }));
  t.mock.method(legacy, "resolveLegacyObservationToDraft", async () => { calls.push("resolve"); account.current_version_id = "draft_1"; account.legacy_hold = "NONE"; account.revision = "2"; return { accountId: account.id, observationVersionId: input.source.expectedObservationVersionId, versionId: "draft_1", status: "DRAFT" as const }; });
  t.mock.method(auth, "assertAdminContextInTransaction", async () => {});
  t.mock.method(access, "loadEffectiveAdminAccess", async () => ({ status: "ACTIVE", isBoss: true, permissions: new Set(["supply.catalog.manage"]) }));
  const sourceUpdatedAt = new Date("2026-10-16T00:00:00Z"), extractSha256 = "e".repeat(64), evidenceRef = "FIXTURE_DISPLAY";
  const displayDigest = legacyDisplayDigest(account.id, { observationVersionId: input.source.expectedObservationVersionId, baseSourceDigest: input.source.sourceDigest, extractSha256, sourceUpdatedAt: sourceUpdatedAt.toISOString(), evidenceRef, snapshot: input.display });
  let badDisplay = false;
  const client = { query: async (sql: string, params?: unknown[]) => {
    queries.push(sql);
    if (sql.includes("audit_event")) audits.push(params?.[10]);
    if (sql.includes("legacy_listing_display_snapshot")) return { rows: [{ observation_version_id: input.source.expectedObservationVersionId, base_source_digest: input.source.sourceDigest, extract_sha256: extractSha256, source_updated_at: sourceUpdatedAt, evidence_ref: evidenceRef, snapshot: input.display, display_digest: badDisplay ? "0".repeat(64) : displayDigest }], rowCount: 1 };
    if (sql.includes("SELECT title,description")) return { rows: [{ title: input.title, description: input.description }], rowCount: 1 };
    if (sql.includes("SELECT id,code,unit")) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  } } as unknown as import("pg").PoolClient;
  const result = await applyLegacyOrdinaryDraft(client, actor, { accountId: input.accountId, batchId: "fixture_batch", expectedRevision: "1", intake: input }, gate);
  assert.deepEqual(calls, ["resolve", "save"]);
  assert.equal(result.body.state, "DRAFT");
  assert.deepEqual(result.body.deferred, ["TITLE_REVIEW_REQUIRED"]);
  assert.deepEqual((saved!.mediaBindings as unknown[]), []);
  assert.equal((saved!.inventory as Array<{ itemId: string; quantity: string }>).find((item) => item.itemId === "fixture_item_7")?.quantity, "7");
  assert.equal(JSON.stringify(saved).includes("top_insure_card_piece"), false);
  assert.equal(JSON.stringify(saved).includes("INSURANCE_UNIT_PENDING"), false);
  const details = JSON.parse(String(audits[0]));
  assert.equal(details.state, undefined);
  assert.equal(JSON.stringify(details).includes("PUBLISHED"), false);
  assert.equal(details.batchId, "fixture_batch");
  assert.deepEqual(details.deferred, ["TITLE_REVIEW_REQUIRED"]);
  assert.equal(details.versionId, "draft_1");
  assert.equal(queries.some((sql) => /UPDATE\s+zzsh_supply\.listing_version/i.test(sql)), false);
  calls.length = 0;
  const replay = await applyLegacyOrdinaryDraft(client, actor, { accountId: input.accountId, batchId: "fixture_batch", expectedRevision: account.revision, intake: input }, gate);
  assert.equal(replay.status, 200);
  assert.deepEqual(calls, []);
  input.title = "号主已写标题";
  await assert.rejects(() => applyLegacyOrdinaryDraft(client, actor, { accountId: input.accountId, batchId: "fixture_batch", expectedRevision: account.revision, intake: input }, gate), (error: { status?: number }) => error.status === 409);
  assert.deepEqual(calls, []);
  input.title = "历史资料待核实";
  badDisplay = true;
  account.current_version_id = input.source.expectedObservationVersionId;
  account.revision = "1";
  account.legacy_hold = "UNRESOLVED";
  const before = queries.length;
  await assert.rejects(() => applyLegacyOrdinaryDraft(client, actor, { accountId: input.accountId, batchId: "fixture_batch", expectedRevision: "1", intake: input }, gate), /DISPLAY_SOURCE_BINDING_MISMATCH/);
  assert.equal(queries.slice(before).some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql.trim())), false);
  assert.deepEqual(calls, []);
  badDisplay = false;
  input.title = "";
  const blank = await applyLegacyOrdinaryDraft(client, actor, { accountId: input.accountId, batchId: "fixture_batch", expectedRevision: "1", intake: input }, gate);
  assert.equal(blank.body.titleNormalized, true);
  assert.equal(blank.body.deferred.includes("TITLE_REVIEW_REQUIRED"), true);
  assert.equal(saved!.title, `历史资料待核实-${input.accountId.slice(0, 8)}`);
  assert.deepEqual(calls, ["resolve", "save"]);
  input.title = "历史资料待核实";
  calls.length = 0;
  t.mock.method(access, "loadEffectiveAdminAccess", async () => ({ status: "ACTIVE", isBoss: true, permissions: new Set(["supply.review.decide"]) }));
  await assert.rejects(() => applyLegacyOrdinaryDraft(client, actor, { accountId: input.accountId, batchId: "fixture_batch", expectedRevision: "1", intake: input }, gate), (error: { status?: number }) => error.status === 403);
  t.mock.method(auth, "assertAdminContextInTransaction", async () => { throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required"); });
  await assert.rejects(() => applyLegacyOrdinaryDraft(client, actor, { accountId: input.accountId, batchId: "fixture_batch", expectedRevision: "1", intake: input }, gate), (error: { status?: number }) => error.status === 403);
  await assert.rejects(() => applyLegacyOrdinaryDraft(client, actor, { accountId: "other_account", batchId: "fixture_batch", expectedRevision: "1", intake: input }, gate), (error: { status?: number }) => error.status === 400);
  t.mock.restoreAll();
});

test("admin legacy-draft route reuses the draft idempotency scope and does not rewrite on replay", async (t) => {
  const auth: typeof import("../src/auth/auth-security") = require("../src/auth/auth-security");
  const takeover: typeof import("../src/supply/legacy-trade-takeover") = require("../src/supply/legacy-trade-takeover");
  t.mock.method(auth, "readAdminContext", async () => ({ userId: "fixture_admin", sessionId: "fixture_session" }));
  let authCalls = 0, applyCalls = 0, allowed = true;
  t.mock.method(takeover, "authorizeLegacyOrdinaryDraft", async () => { authCalls++; if (!allowed) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required"); return { id: "restored_account", game_id: "restored_game", owner_user_id: "restored_owner", revision: "1" }; });
  t.mock.method(takeover, "applyLegacyOrdinaryDraft", async () => { applyCalls++; return { status: 200, body: { state: "DRAFT", versionId: "draft_1", revision: "2" } }; });
  const records = new Map<string, { requestFingerprint: string; responseStatus: number; responseBody: unknown; publishRequired: boolean }>();
  const scopes: unknown[] = [];
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, values: unknown[] = []) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')) { scopes.push(values[0]); records.set(String(values[1]), { requestFingerprint: String(values[2]), responseStatus: Number(values[3]), responseBody: JSON.parse(String(values[4])), publishRequired: values[5] === true }); return { rows: [], rowCount: 1 }; }
    if (sql.includes("request_fingerprint")) { const row = records.get(String(values[1])); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }; }
    return { rows: [], rowCount: 0 };
  } }) } as unknown as import("pg").Pool;
  const response = () => ({ headersSent: false, statusCode: 0, payload: undefined as unknown, status(n: number) { this.statusCode = n; return this; }, setHeader() { return this; }, json(body: unknown) { this.payload = body; this.headersSent = true; return this; } });
  const intake = restoredFixture();
  const body = { expectedRevision: "1", batchId: "fixture_batch", intake };
  const call = async (key: string, payload: Record<string, unknown> = body) => {
    const http = response();
    await handleSupplyAdminRoute({ method: "POST", originalUrl: `/api/v1/admin/supply/accounts/${intake.accountId}/legacy-draft`, headers: { origin: "http://admin.invalid", "idempotency-key": key, "x-request-id": "req_route" }, body: payload } as never, http as unknown as SupplyResponse, { pool, apiOrigin: "http://api.invalid", userOrigin: "http://user.invalid", adminOrigin: "http://admin.invalid", mediaStorage: { available: false } } as never);
    return http;
  };
  const first = await call("draft_key_1");
  const second = await call("draft_key_1");
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(applyCalls, 1);
  assert.equal(authCalls, 2);
  assert.deepEqual(first.payload, second.payload);
  assert.equal(scopes[0], JSON.stringify(["admin", "fixture_admin", "supply.legacy.trade_draft_write", intake.accountId]));
  assert.equal(records.get("draft_key_1")?.requestFingerprint, fingerprintRequest("supply.legacy.trade_draft_write", intake.accountId, body));
  const changed = await call("draft_key_1", { ...body, batchId: "other_batch" });
  assert.equal(changed.statusCode, 409);
  assert.equal(applyCalls, 1);
  const scriptBody = { source: intake.source, declaration: { title: intake.title }, deferred: ["TITLE_REVIEW_REQUIRED"], expectation: { accountId: intake.accountId } };
  const scriptKey = sha256Hex(JSON.stringify(["root-r2", intake.accountId, intake.source.sourceDigest, "c".repeat(64)]));
  records.set(scriptKey, { requestFingerprint: fingerprintRequest("supply.legacy.trade_draft_write", intake.accountId, scriptBody), responseStatus: 200, responseBody: { state: "DRAFT", kept: true }, publishRequired: false });
  const historical = await call(scriptKey);
  assert.equal(historical.statusCode, 409);
  assert.equal(applyCalls, 1);
  assert.equal(records.size, 2);
  allowed = false;
  const denied = await call("draft_key_2");
  assert.equal(denied.statusCode, 403);
  assert.equal(applyCalls, 1);
  const mismatch = response();
  await handleSupplyAdminRoute({ method: "POST", originalUrl: "/api/v1/admin/supply/accounts/other_account/legacy-draft", headers: { origin: "http://admin.invalid", "idempotency-key": "draft_key_4", "x-request-id": "req_route" }, body } as never, mismatch as unknown as SupplyResponse, { pool, apiOrigin: "http://api.invalid", userOrigin: "http://user.invalid", adminOrigin: "http://admin.invalid", mediaStorage: { available: false } } as never);
  assert.equal(mismatch.statusCode, 400);
  assert.equal(applyCalls, 1);
  t.mock.method(auth, "readAdminContext", async () => { throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required"); });
  const anonymous = await call("draft_key_3");
  assert.equal(anonymous.statusCode, 403);
  assert.equal(applyCalls, 1);
  t.mock.restoreAll();
});

test("submit and review stop on a placeholder title before any publication write", async () => {
  const publishing: typeof import("../src/supply/publishing") = require("../src/supply/publishing");
  const input = fixture();
  input.termOptionCode = "daily-10m";
  bindSource(input);
  const plan = prepareLegacyTradeIntake(input, catalog());
  assert(plan.draft);
  const baseDeclaration = plan.draft as unknown as ContentDeclaration;
  const declaration: ContentDeclaration = { ...baseDeclaration, title: "历史资料待核实", attributes: { ...baseDeclaration.attributes, grading_division: 3 }, mediaBindings: plan.expectedMedia };
  const priced = computeDeltaQuote({ priceVersionId: "fixture_price", mode: "SPREAD", roundingPolicy: "HALF_UP_CENT_V1", customerTier: "STANDARD", haffRule: compatRule(), lines: [{ itemId: "fixture_item_0", quantity: "3000000", pricingKind: "HAFF_RATIO", unit: "HAFF_BASE", customerTier: "STANDARD" }], conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", rentalPricing: { rentalMode: "ordinary" } }, termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" } });
  assert(priced.quotable);
  const payload = normalizeContentPayload({ schemaVersion: 2, accountId: input.accountId, gameId: input.source.expectedGameId, declaration, ruleRefs: { releaseId: "fixture_release", catalogRevision: "1", priceVersionId: "fixture_price", termVersionId: "fixture_term", agreementVersionId: "fixture_agreement", agreementDigest: "d".repeat(64) }, quoteValues: priced.quote });
  const account = { id: input.accountId, owner_user_id: input.source.expectedOwnerUserId, game_id: input.source.expectedGameId, current_version_id: "fixture_draft", revision: "1", owner_paused: false, staff_restricted: false, restriction_reason: null, legacy_hold: "NONE", lifecycle: "ACTIVE", display_no: null } as import("../src/supply/publishing").PublishingAccount;
  const version = { id: "fixture_draft", origin: "NATIVE", review_state: "DRAFT", title: "历史资料待核实", content_hash: computeContentHash(payload), rule_release_id: "fixture_release", attributes: payload.declaration.attributes, payload } as import("../src/supply/publishing").ListingVersion;
  const writes: string[] = [];
  const client = { query: async (sql: string) => {
    if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) writes.push(sql);
    if (sql.includes("zzsh_auth_user")) return { rows: [{ suspended: false, account_status: "ACTIVE", identity_status: "VERIFIED", age_status: "ADULT" }], rowCount: 1 };
    if (sql.includes("SELECT enabled,current_release_id")) return { rows: [{ enabled: true, current_release_id: "fixture_release", catalog_revision: "1" }], rowCount: 1 };
    if (sql.includes("current_release_id,catalog_revision")) return { rows: [{ current_release_id: "fixture_release", catalog_revision: "1" }], rowCount: 1 };
    if (sql.includes("game_service_operation")) return { rows: [{ id: "s", gameId: account.game_id, gameCode: "delta", gameEnabled: true, serviceCode: "ACCOUNT_RENTAL", enabled: true, revision: "1" }], rowCount: 1 };
    if (sql.includes("SELECT * FROM zzsh_supply.listing_version")) return { rows: [version], rowCount: 1 };
    if (sql.includes("current-trade-resources")) return { rows: [{ id: "fixture_item_0", code: "df_billable_haff", unit: "HAFF_BASE", enabled: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } } as unknown as import("pg").PoolClient;
  const gate: import("../src/supply/publishing").SupplyGateReader = async () => ({ publisherBail: "NOT_REQUIRED", occupancy: "FREE", reference: "FIXTURE_ONLY" });
  const token = { expectedRevision: "1", versionId: version.id, contentHash: version.content_hash, releaseId: version.rule_release_id };
  await assert.rejects(() => publishing.submitListing(client, account, account.owner_user_id, token, gate), /TITLE_REVIEW_REQUIRED/);
  version.review_state = "SUBMITTED";
  await assert.rejects(() => publishing.reviewListing(client, account, "fixture_admin", { ...token, decision: "APPROVE", reason: "占位标题" }, gate), /TITLE_REVIEW_REQUIRED/);
  assert.deepEqual(writes, []);
});
