import { test } from "node:test";
import assert from "node:assert/strict";
import { convertLegacyDisplayFields } from "../src/supply/legacy-display-snapshot";
import { prepareLegacyTradeIntake, takeoverLegacyTrade, finalizeLegacyTradeTakeover, type LegacyTradeIntake, type TradeCatalogItem } from "../src/supply/legacy-trade-takeover";
import { DELTA_LEGACY_RESOURCES } from "../src/supply/legacy-observation";
import { canonicalize, computeContentHash, normalizeContentPayload, type ContentDeclaration } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import {planLegacyTradeIntakeBatch} from "../src/supply/legacy-trade-intake-plan";
import {legacyDisplayDigest} from "../src/supply/legacy-display-snapshot";
import {computeDeltaQuote} from "../src/supply/pricing";
import {compatRule} from "./pricing-compat-fixture";

function bindSource(input: LegacyTradeIntake) {
  const { source } = input;
  const canonical = canonicalize({ sourceSystem: source.sourceSystem, sourceEntity: source.sourceEntity, legacyId: source.legacyId, baseSourceDigest: source.sourceDigest, deposit_amount: input.depositYuan, is_full_payout: input.isFullPayout, ownerRatioB: input.ownerRatioB });
  input.sourceFieldEvidence = { canonical, digest: sha256Hex(canonical), extractSha256: "f".repeat(64), evidenceRef: "FIXTURE_SOURCE_EXTRACT" };
  if (input.insuranceCountEvidence) { const p = input.insuranceCountEvidence; p.canonical = canonicalize({ sourceSystem: source.sourceSystem, sourceEntity: source.sourceEntity, legacyId: source.legacyId, baseSourceDigest: source.sourceDigest, quantity: p.quantity, unit: "PIECE" }); p.digest = sha256Hex(p.canonical); }
  return input;
}

function fixture(): LegacyTradeIntake {
  const display = convertLegacyDisplayFields({ insure_lv: "4", grading_lv: "4", login_way: "1", vit_lv: "7", bear_lv: "7", dive_lv: "3", character_lv: "60", processing_time_start: "8", processing_time_end: "22", secret_kd: "1.20", ratio_type: "default", high_risk_owner: "0", ban_record: "0", face_is_self: "1", haff: "3", awm_bullet_num: "1", level6_bullet_num: "2", level6_helmet_num: "0", level6_armor_num: "1", barrett_bullet_num: "1", coffee_num: "0", top_insure_card_num: "7" });
  return bindSource({ accountId: "fixture_account", source: { sourceSystem: "legacy_mysql_restore", sourceEntity: "la_rental_accounts", legacyId: "33", sourceDigest: "a".repeat(64), expectedObservationVersionId: "fixture_observation", expectedOwnerUserId: "fixture_owner", expectedGameId: "fixture_game" }, display,
    title: "FIXTURE 账号", description: null, depositYuan: "300.00", isFullPayout: "0", ownerRatioB: null, termOptionCode: "daily", pricingOptionCode: "", skins: [], entitlements: [],
    sourceFieldEvidence: { canonical: "", digest: "", extractSha256: "", evidenceRef: "" },
    media: [{ assetId: "fixture_asset", byteHash: "b".repeat(64), position: 0, technicalState: "READY", accessClass: "PUBLIC_DISPLAY" }], insuranceCountEvidence: { quantity: "3", canonical: "", digest: "c".repeat(64), evidenceRef: "FIXTURE_CARD_COUNT_EVIDENCE" } });
}
function catalog(): TradeCatalogItem[] {
  return DELTA_LEGACY_RESOURCES.map(([field, codes], i) => ({ id: "fixture_item_" + i, code: field === "top_insure_card_num" ? "top_insure_card_piece" : codes[0], unit: field === "haff" ? "HAFF_BASE" : field.includes("bullet") ? "ROUND" : "PIECE", quantityScale: 0 }));
}
test("formal intake uses native item IDs, exact base quantities and materialized funding declarations", () => {
  const input = fixture(), plan = prepareLegacyTradeIntake(input, catalog());
  assert.equal(plan.admission, "TRADE_CANDIDATE", plan.reasons.join(",")); assert(plan.draft);
  const attributes = plan.draft.attributes as Record<string, unknown>;
  assert.deepEqual(attributes.owner_deposit_declaration, { schema: "owner-deposit-declaration-v1", amountCents: "30000", declarationVersion: "legacy-trade-intake-v1" });
  assert.deepEqual(attributes.full_payout_declaration, { schema: "full-payout-declaration-v1", selected: false });
  const inventory = plan.draft.inventory as Array<{ itemId: string; quantity: string }>;
  assert.equal(inventory.find(i => i.itemId === "fixture_item_0")?.quantity, "3000000");
  assert.equal(inventory.find(i => i.itemId === "fixture_item_1")?.quantity, "120");
  assert.equal(inventory.find(i => i.itemId === "fixture_item_7")?.quantity, "3");
  assert.equal(input.display.resources.find(r => r.field === "top_insure_card_num")?.unit, "DAY");
  assert.equal(input.display.resources.find(r => r.field === "top_insure_card_num")?.quantity, "7");
  assert(!JSON.stringify(plan.draft).includes("legacy-carry"));
});
test("legacy insurance DAY never silently becomes new card count", () => {
  const input = fixture(); delete input.insuranceCountEvidence;
  const plan = prepareLegacyTradeIntake(input, catalog());
  assert.equal(plan.admission, "BLOCKED"); assert(plan.reasons.includes("INSURANCE_UNIT_PENDING")); assert.equal(plan.draft, null);
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
 const first=fixture(),second=fixture();second.source.legacyId="34";second.accountId="another_account";bindSource(second);delete second.insuranceCountEvidence;
 const plan=planLegacyTradeIntakeBatch([{legacyId:"33",accountId:first.accountId,intake:first,isolationReasons:[]},{legacyId:"34",accountId:second.accountId,intake:second,isolationReasons:[]},{legacyId:"35",accountId:null,intake:null,isolationReasons:["PARTY_UNMAPPED"]}],catalog());
 assert.deepEqual(plan.counts,{total:3,tradeCandidate:1,blocked:1,isolated:1});assert.equal(plan.writeAllowed,false);assert.equal(plan.realRuntime,"NOT_RUN");assert.equal(plan.items.length,3);
 const duplicate=planLegacyTradeIntakeBatch([{legacyId:"33",accountId:first.accountId,intake:first,isolationReasons:[]},{legacyId:"33",accountId:first.accountId,intake:first,isolationReasons:[]}],catalog());assert.equal(duplicate.counts.tradeCandidate,0);assert.equal(duplicate.counts.isolated,2);
 const broken=fixture();broken.sourceFieldEvidence.digest="0".repeat(64);assert(prepareLegacyTradeIntake(broken,catalog()).reasons.includes("SOURCE_FIELD_EVIDENCE_MISMATCH"));broken.media.push({...broken.media[0]!,position:1});assert(prepareLegacyTradeIntake(broken,catalog()).reasons.includes("MEDIA_UNAVAILABLE"));
});

test("actual maintenance chain saves and quotes formal native fields before publication; selected payout stops for genuine owner acceptance",async t=>{
 const p:typeof import("../src/supply/publishing")=require("../src/supply/publishing"),legacy:typeof import("../src/supply/legacy-observation")=require("../src/supply/legacy-observation"),auth:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security"),access:typeof import("../src/auth/admin-authorization")=require("../src/auth/admin-authorization"),funding:typeof import("../src/supply/funding-authority")=require("../src/supply/funding-authority");
 const actor={id:"fixture_admin",sessionId:"fixture_session",requestId:"req_fixture"},gate:import("../src/supply/publishing").SupplyGateReader=async()=>({publisherBail:"NOT_REQUIRED",occupancy:"FREE",reference:"FIXTURE_ONLY"});
 for(const selected of [false,true]){
  const input=fixture();input.isFullPayout=selected?"1":"0";input.termOptionCode="daily-10m";bindSource(input);const plan=prepareLegacyTradeIntake(input,catalog());assert(plan.draft);
  const declaration={...plan.draft,mediaBindings:plan.expectedMedia} as ContentDeclaration,priced=computeDeltaQuote({priceVersionId:"fixture_price",mode:"SPREAD",roundingPolicy:"HALF_UP_CENT_V1",customerTier:"STANDARD",haffRule:compatRule(),lines:[{itemId:"fixture_item_0",quantity:"3000000",pricingKind:"HAFF_RATIO",unit:"HAFF_BASE",customerTier:"STANDARD"}],conditions:{safeBoxCode:"box-a",vitLevel:6,bearLevel:6,termOptionCode:"daily-10m",rentalPricing:{rentalMode:"ordinary"}},termOption:{code:"daily-10m",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"}});assert(priced.quotable);
  const payload=normalizeContentPayload({schemaVersion:2,accountId:input.accountId,gameId:input.source.expectedGameId,declaration,ruleRefs:{releaseId:"fixture_release",catalogRevision:"1",priceVersionId:"fixture_price",termVersionId:"fixture_term",agreementVersionId:"fixture_agreement",agreementDigest:"d".repeat(64)},quoteValues:priced.quote});
  const a={id:input.accountId,owner_user_id:input.source.expectedOwnerUserId,game_id:input.source.expectedGameId,current_version_id:"fixture_draft",revision:"1",owner_paused:false,staff_restricted:false,restriction_reason:null,legacy_hold:"NONE",lifecycle:"ACTIVE",display_no:null},version={id:"fixture_draft",origin:"NATIVE",review_state:"DRAFT",content_hash:computeContentHash(payload),rule_release_id:"fixture_release",attributes:payload.declaration.attributes,payload} as import("../src/supply/publishing").ListingVersion,calls:string[]=[],queries:string[]=[];let accepted=false,badDisplay=false;
  t.mock.method(p,"lockPublishingAccount",async()=>a);t.mock.method(p,"currentVersion",async()=>version);t.mock.method(p,"assertCurrentRelease",async()=>{});t.mock.method(p,"readDeclaration",async()=>payload.declaration);
  t.mock.method(p,"saveListingDraft",async(_c:import("pg").PoolClient,_a:import("../src/supply/publishing").PublishingAccount,body:Record<string,unknown>)=>{calls.push("save");assert.deepEqual(body,{...plan.draft,expectedRevision:"1"});});t.mock.method(p,"quoteListing",async()=>{calls.push("quote");});t.mock.method(p,"reviewListing",async()=>{calls.push("review");});
  t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:true,permissions:new Set(["supply.catalog.manage","supply.review.decide"])} as Awaited<ReturnType<typeof access.loadEffectiveAdminAccess>>));
  t.mock.method(legacy,"lockLegacySource",async()=>{});t.mock.method(legacy,"readLegacyMap",async()=>({account_id:a.id,source_digest:input.source.sourceDigest,version_id:input.source.expectedObservationVersionId}) as Awaited<ReturnType<typeof legacy.readLegacyMap>>);
  t.mock.method(funding,"readFundingPolicyForRelease",async()=>({ownerDepositRules:{normal:{minCents:"1"},fullPayoutSelected:{minCents:"30000"},capCents:"999999"}} as import("../src/supply/funding-policy").FundingPolicy));
  const sourceUpdatedAt=new Date("2026-10-15T00:00:00Z"),extractSha256="e".repeat(64),evidenceRef="FIXTURE_DISPLAY",displayDigest=legacyDisplayDigest(a.id,{observationVersionId:input.source.expectedObservationVersionId,baseSourceDigest:input.source.sourceDigest,extractSha256,sourceUpdatedAt:sourceUpdatedAt.toISOString(),evidenceRef,snapshot:input.display});
  const client={query:async(sql:string)=>{queries.push(sql);if(sql.includes("legacy_listing_display_snapshot"))return {rows:[{observation_version_id:input.source.expectedObservationVersionId,base_source_digest:input.source.sourceDigest,extract_sha256:extractSha256,source_updated_at:sourceUpdatedAt,evidence_ref:evidenceRef,snapshot:input.display,display_digest:badDisplay?"0".repeat(64):displayDigest}],rowCount:1};if(sql.includes("SELECT title,description"))return {rows:[{title:input.title,description:input.description}],rowCount:1};if(sql.includes("SELECT id,code,unit"))return {rows:catalog(),rowCount:catalog().length};if(sql.includes("acceptance_kind='OWNER_ACCEPTED'"))return {rows:accepted?[{}]:[],rowCount:accepted?1:0};if(sql.includes("details->>'batchId'"))return {rows:[{}],rowCount:1};return {rows:[],rowCount:0};}} as unknown as import("pg").PoolClient;
  const result=await takeoverLegacyTrade(client,actor,{batchId:"fixture_batch",intake:input},gate);assert.deepEqual(calls,selected?["save","quote"]:["save","quote","review"]);assert.equal((result.body as {state:string}).state,selected?"OWNER_ACCEPTANCE_REQUIRED":"PUBLISHED");
  assert.equal(queries.some(q=>q.includes("'LEGACY_TAKEOVER_AUTHORIZED'")),!selected);assert(!queries.some(q=>/INSERT INTO zzsh_order\.rental_order|ledger_entry/.test(q)));
  if(selected){const finalize={accountId:a.id,source:input.source,batchId:"fixture_batch",expectedRevision:"1",versionId:version.id,contentHash:version.content_hash!,releaseId:version.rule_release_id!};await assert.rejects(()=>finalizeLegacyTradeTakeover(client,actor,finalize,gate),/TERMS_ACCEPTANCE_REQUIRED/);assert.deepEqual(calls,["save","quote"]);accepted=true;assert.equal((await finalizeLegacyTradeTakeover(client,actor,finalize,gate)).status,200);assert.deepEqual(calls,["save","quote","review"]);}
  calls.length=0;
  for(const flag of [null,undefined,"2","",false,true,0,1]){const invalid=structuredClone(input);invalid.isFullPayout=flag as LegacyTradeIntake["isFullPayout"];bindSource(invalid);await assert.rejects(()=>takeoverLegacyTrade(client,actor,{batchId:"fixture_batch",intake:invalid},gate),/FUNDING_POLICY_UNKNOWN/);assert.deepEqual(calls,[]);}
  badDisplay=true;await assert.rejects(()=>takeoverLegacyTrade(client,actor,{batchId:"fixture_batch",intake:input},gate),/DISPLAY_SOURCE_BINDING_MISMATCH/);assert.deepEqual(calls,[]);
  t.mock.restoreAll();
 }
});
