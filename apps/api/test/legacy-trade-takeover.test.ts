import { test } from "node:test";
import assert from "node:assert/strict";
import { convertLegacyDisplayFields } from "../src/supply/legacy-display-snapshot";
import { prepareLegacyTradeIntake, takeoverLegacyTrade, finalizeLegacyTradeTakeover, type LegacyTradeIntake, type TradeCatalogItem } from "../src/supply/legacy-trade-takeover";
import { DELTA_LEGACY_RESOURCES } from "../src/supply/legacy-observation";
import { canonicalize, computeContentHash, normalizeContentPayload, type ContentDeclaration } from "../src/supply/content-hash";
import { sha256Hex } from "../src/supply/supply-util";
import {planLegacyTradeIntakeBatch,assembleLegacyTradeIntakeBatch,assembleLegacyTradeMediaGate,stableFingerprint,type LegacyTradeExtractionOriginal,type LegacyTradeMediaAssemblyRow,type LegacyTradeMediaByteEvidence} from "../src/supply/legacy-trade-intake-plan";
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
 const first=fixture(),second=fixture();second.source.legacyId="34";second.accountId="another_account";second.source.sourceDigest="b".repeat(64);bindSource(second);delete second.insuranceCountEvidence;
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
  t.mock.method(p,"saveListingDraft",async(_c:import("pg").PoolClient,_a:import("../src/supply/publishing").PublishingAccount,body:Record<string,unknown>)=>{calls.push("save");assert.deepEqual(body,{...plan.draft,expectedRevision:"1"});});t.mock.method(p,"quoteListing",async()=>{calls.push("quote");});t.mock.method(p,"reviewListing",async()=>{calls.push("review");});
  t.mock.method(auth,"assertAdminContextInTransaction",async()=>{});t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:true,permissions:new Set(["supply.catalog.manage","supply.review.decide"])} as Awaited<ReturnType<typeof access.loadEffectiveAdminAccess>>));
  t.mock.method(legacy,"lockLegacySource",async()=>{});t.mock.method(legacy,"readLegacyMap",async()=>({account_id:a.id,source_digest:input.source.sourceDigest,version_id:input.source.expectedObservationVersionId}) as Awaited<ReturnType<typeof legacy.readLegacyMap>>);
  t.mock.method(funding,"readFundingPolicyForRelease",async()=>({ownerDepositRules:{normal:{minCents:"1"},fullPayoutSelected:{minCents:"30000"},capCents:"999999"}} as import("../src/supply/funding-policy").FundingPolicy));
  const sourceUpdatedAt=new Date("2026-10-15T00:00:00Z"),extractSha256="e".repeat(64),evidenceRef="FIXTURE_DISPLAY",displayDigest=legacyDisplayDigest(a.id,{observationVersionId:input.source.expectedObservationVersionId,baseSourceDigest:input.source.sourceDigest,extractSha256,sourceUpdatedAt:sourceUpdatedAt.toISOString(),evidenceRef,snapshot:input.display});
  const client={query:async(sql:string)=>{queries.push(sql);if(sql.includes("legacy_listing_display_snapshot"))return {rows:[{observation_version_id:input.source.expectedObservationVersionId,base_source_digest:input.source.sourceDigest,extract_sha256:extractSha256,source_updated_at:sourceUpdatedAt,evidence_ref:evidenceRef,snapshot:input.display,display_digest:badDisplay?"0".repeat(64):displayDigest}],rowCount:1};if(sql.includes("SELECT title,description"))return {rows:[{title:input.title,description:input.description}],rowCount:1};if(sql.includes("SELECT id,code,unit"))return {rows:catalog(),rowCount:catalog().length};if(sql.includes("FROM zzsh_supply.listing_media m JOIN zzsh_supply.media_asset a")){const rows=plan.expectedMedia.map(m=>({id:m.assetId,account_id:foreignMedia?"foreign_account":a.id,owner_user_id:foreignMedia?"foreign_owner":a.owner_user_id,purpose:"ACCOUNT_DISPLAY"}));return {rows,rowCount:rows.length};}if(sql.includes("unnest($2::text[])"))return {rows:missingTier?[{}]:[],rowCount:missingTier?1:0};if(sql.includes("acceptance_kind='OWNER_ACCEPTED'"))return {rows:accepted?[{}]:[],rowCount:accepted?1:0};if(sql.includes("details->>'batchId'"))return {rows:[{}],rowCount:1};return {rows:[],rowCount:0};}} as unknown as import("pg").PoolClient;
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
