import assert from "node:assert/strict";
import test from "node:test";
import { assertCurrentRelease, quoteListing, reviewListing, submitListing } from "../src/supply/publishing";
import { projectDeltaQuote } from "../src/supply/delta-rental";
import { computeContentHash } from "../src/supply/content-hash";
import { compatRule } from "./pricing-compat-fixture";
import { readListingPricingModel } from "../src/supply/pricing-policy-schedule";
import { fundingPolicyFixture } from "./funding-authority-fixtures";

// Synthetic SQL responses; the real quote, policy validator and snapshot writer execute.
function fixture(amount: string | null = "10000", mode: "NOT_REQUIRED" | "FIXED_CENTS" = "FIXED_CENTS") {
  const account: any = { id: "account", game_id: "game", owner_user_id: "owner", revision: "1", current_version_id: "draft", lifecycle: "ACTIVE" };
  const attributes: Record<string, unknown> = { safe_box_code: "box-a", vit_level: 6, bear_level: 6, dive_level: 0, grading_code: "4", grading_division: 3, character_level: 30, secret_kd: "1.50", ban_record: false, face_is_self: true, region_province: "上海市", region_city: "上海市", login_method_code: "login_qq_qr", next_season_pass: false, demulan_unlocked: false, service_window_start_minute: 540, service_window_end_minute: 1380, service_window_cross_midnight: false, service_window_timezone: "Asia/Shanghai", rentalPricing: { rentalMode: "ordinary" } };
  if (amount !== null) attributes.owner_deposit_declaration = { schema: "owner-deposit-declaration-v1", amountCents: amount, declarationVersion: "fixture-v1" };
  const version: any = { id: "draft", account_id: account.id, origin: "NATIVE", review_state: "DRAFT", title: "合成测试", description: null, attributes, term_option_code: "daily-10m", pricing_option_code: "" };
  const policy = fundingPolicyFixture(mode);
  const controls = { policy: policy as unknown, policyFailure: false, schedules:false, incompleteSchedules:false, missingDefault:false, defaultModel:"FIXED_FEE" as "SPREAD"|"FIXED_FEE", fixedGeneration:"1", spreadPrice:"price", previous:null as any };
  const snapshots: any[] = [], writes: string[] = [];
  let policyReads = 0;
  const client: any = { query: async (sql: string, args: any[] = []) => {
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.includes("AS retired")) return result([{retired:false}]);
    if (sql.startsWith("SELECT 1 FROM zzsh_supply.listing_publication")) return result(controls.previous?[{}]:[]);
    if (sql.startsWith("SELECT 1 FROM zzsh_order.rental_order")) return result([]);
    if (sql.includes('"game_service_operation"')) return result([{ id: "service", gameCode: "delta", gameEnabled: true, enabled: true }]);
    if (sql.startsWith("SELECT * FROM zzsh_supply.listing_version")) return result([version]);
    if (sql.startsWith('SELECT item_id AS "itemId"')) return result([{ itemId: "haff", quantity: "100000000" }]);
    if (sql.startsWith("SELECT skin_id FROM") || sql.startsWith("SELECT s.id,s.name") || sql.startsWith("SELECT entitlement_id AS") || sql.startsWith("SELECT m.asset_id AS") || sql.startsWith("SELECT 1 FROM zzsh_supply.billable_item")) return result([]);
    if (sql.startsWith("SELECT r.*,to_char(transaction_timestamp()")) return result([{ id: "release", catalogRevision: "1", price_version_id: "price", term_version_id: "term", agreement_version_id: "agreement", digest: "a".repeat(64), mode: "SPREAD", commission_rate: null, haff_rule: compatRule(), rounding_policy: "HALF_UP_CENT_V1" }]);
    if (sql.includes("AS current_release_id,catalog_revision")) return result([{current_release_id:"release",catalog_revision:"1"}]);
    if (sql.includes("to_regclass('zzsh_supply.pricing_mode_schedule')")) return result([{modes:controls.schedules,prices:controls.schedules&&!controls.incompleteSchedules,asOf:"2026-11-02T00:00:00.000000Z"}]);
    if (sql.includes("FROM zzsh_supply.listing_publication p JOIN zzsh_supply.listing_version v")) return result(controls.previous?[controls.previous]:[]);
    const {compatibility,...fixedRule}=compatRule();
    const rule={...fixedRule,schema:"haff-ratio-v3",fixedModes:compatibility!.modes};
    if (sql.includes("FROM zzsh_supply.pricing_mode_schedule m")) return result(controls.missingDefault?[]:[controls.defaultModel==="FIXED_FEE"?{id:"mode",generation:"1",effectiveAt:"2026-11-01T00:00:00.000000Z",pricingModel:"FIXED_FEE",priceScheduleId:"fixed-schedule",priceVersionId:"fixed-price",priceMode:"PERCENT",priceStatus:"SEALED",roundingPolicy:"HALF_UP_CENT_V1",rates:{ordinary:"0.10",custom:"0.08",fast:"0.12"},haffRule:rule}:{id:"mode",generation:"2",effectiveAt:"2026-11-01T00:00:00.000000Z",pricingModel:"SPREAD",priceScheduleId:"spread-schedule",priceVersionId:controls.spreadPrice,priceMode:"SPREAD",priceStatus:"SEALED",roundingPolicy:"HALF_UP_CENT_V1",rates:null,haffRule:compatRule()}]);
    if (sql.includes("FROM zzsh_supply.pricing_policy_schedule s LEFT JOIN zzsh_supply.price_version p") && sql.includes("s.pricing_model='FIXED_FEE'")) return result([{id:"fixed-schedule",generation:controls.fixedGeneration,effectiveAt:"2026-11-01T00:00:00.000000Z",priceVersionId:"fixed-price",mode:"PERCENT",status:"SEALED",roundingPolicy:"HALF_UP_CENT_V1",haffRule:rule,rates:{ordinary:"0.10",custom:"0.08",fast:"0.12"}}]);
    if (sql.includes("FROM zzsh_supply.pricing_policy_schedule s") && sql.includes("s.pricing_model='SPREAD'")) return result([{id:"spread-schedule",generation:"1",effectiveAt:"2026-11-01T00:00:00.000000Z",priceVersionId:controls.spreadPrice,mode:"SPREAD",status:"SEALED",roundingPolicy:"HALF_UP_CENT_V1",rates:null,haffRule:compatRule()}]);
    if (sql.startsWith("SELECT code,daily_consumption")) return result([{ code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" }]);
    if (sql.startsWith("SELECT l.item_id AS")) return result([{ itemId: "haff", code: "HAFF", name: "哈夫币", quantity: "100000000", unit: "HAFF_BASE", enabled: true, pricingKind: "HAFF_RATIO", unitQuantity: null, buyerUnitAmount: null, ownerUnitAmount: null }]);
    if (sql.startsWith("SELECT e.id AS") || sql.startsWith("WITH RECURSIVE visible")) return result([]);
    if (sql.includes("p.funding_policy AS policy")) { policyReads++; assert.equal(args[0], "release"); if (controls.policyFailure) throw Error("POLICY_READ_FAILED"); return result([{ policy: controls.policy }]); }
    if (sql.startsWith("UPDATE zzsh_supply.listing_version SET payload=")) { assert.equal(args[0], "draft"); snapshots.push(structuredClone({ payload: args[1], hash: args[2] })); writes.push(sql); return result([]); }
    if (sql.startsWith("UPDATE zzsh_supply.rental_account SET revision=")) { writes.push(sql); return result([{ revision: String(Number(account.revision) + 1) }]); }
    throw Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
  } };
  return { account, version, attributes, controls, client, snapshots, writes, policyReads: () => policyReads };
}

test("listing quote freezes tenant deposit separately from publisher guarantee and requotes only the draft", async () => {
  const f = fixture();
  await quoteListing(f.client, f.account, "1");
  const first = f.snapshots[0], before = JSON.stringify(first);
  assert.equal(first.payload.quoteValues.tenantDeposit.amount, "100.00");
  assert.equal(first.payload.quoteValues.publisherBailRequirement.amount, "30.00");
  const renter = projectDeltaQuote(first.payload.quoteValues, "public")!;
  assert.equal(renter.tenantPayableTotal?.amount, "356.41");
  assert.equal(first.hash, computeContentHash(first.payload));
  (f.attributes.owner_deposit_declaration as any).amountCents = "20000";
  await quoteListing(f.client, f.account, "2");
  assert.equal(f.snapshots[1].payload.quoteValues.tenantDeposit.amount, "200.00");
  assert.notEqual(f.snapshots[1].hash, first.hash);
  assert.equal(JSON.stringify(first), before, "previous frozen bytes remain unchanged");
});

test("new fixed-fee draft uses the current policy while an existing spread listing keeps its mode",async()=>{
  const existing=fixture();await quoteListing(existing.client,existing.account,"1");
  const old=existing.snapshots[0];existing.controls.previous={schemaVersion:2,contentHash:old.hash,payload:old.payload};existing.controls.schedules=true;
  const binding={accountId:"account",gameId:"game",ownerUserId:"owner"};
  assert.equal((await readListingPricingModel(existing.client,binding))?.model,"LEGACY_SPREAD");
  await assert.rejects(quoteListing(existing.client,existing.account,"2"),/已上架账号不能修改/);
  assert.equal(existing.snapshots.length,1);
  const fresh=fixture();fresh.controls.schedules=true;await quoteListing(fresh.client,fresh.account,"1");
  const snapshot=fresh.snapshots[0];assert.equal(snapshot.payload.schemaVersion,4);
  assert.equal(snapshot.payload.quoteValues.priceVersionId,"fixed-price");assert.equal(snapshot.payload.ruleRefs.priceVersionId,"price");
  assert.equal(snapshot.payload.pricingPolicy.pricingModel,"FIXED_FEE");assert.equal(snapshot.payload.quoteValues.pricingInputs.commissionRate,"0.1");
  fresh.controls.previous={schemaVersion:4,contentHash:snapshot.hash,payload:snapshot.payload};fresh.controls.defaultModel="SPREAD";
  assert.equal((await readListingPricingModel(fresh.client,binding))?.model,"FIXED_FEE");
  await assert.rejects(quoteListing(fresh.client,fresh.account,"2"),/已上架账号不能修改/);
  fresh.controls.previous=null;fresh.controls.defaultModel="FIXED_FEE";
  Object.assign(fresh.version,{payload:snapshot.payload,content_hash:snapshot.hash,rule_release_id:"release"});
  await assertCurrentRelease(fresh.client,fresh.account,fresh.version);

  await assert.rejects(submitListing(fresh.client,fresh.account,"owner",{expectedRevision:"2",versionId:"draft",contentHash:snapshot.hash,releaseId:"release"},async()=>({publisherBail:"NOT_REQUIRED",reference:"proof",occupancy:"FREE"})),/暂未就绪/);
  fresh.version.review_state="SUBMITTED";
  await assert.rejects(reviewListing(fresh.client,fresh.account,"admin",{expectedRevision:"2",versionId:"draft",contentHash:snapshot.hash,releaseId:"release",decision:"APPROVE",reason:"test"},async()=>({publisherBail:"NOT_REQUIRED",reference:"proof",occupancy:"FREE"})),/暂未就绪/);
  fresh.version.review_state="DRAFT";
  fresh.controls.fixedGeneration="2";
  await assert.rejects(assertCurrentRelease(fresh.client,fresh.account,fresh.version),/价格政策已更新/);
});

test("a new scheduled spread listing binds the current price independently of its terms release",async()=>{
  const f=fixture();f.controls.schedules=true;f.controls.defaultModel="SPREAD";f.controls.spreadPrice="spread-price";
  await quoteListing(f.client,f.account,"1");const snapshot=f.snapshots[0];
  assert.equal(snapshot.payload.schemaVersion,2);assert.equal(snapshot.payload.ruleRefs.priceVersionId,"price");
  assert.equal(snapshot.payload.quoteValues.priceVersionId,"spread-price");assert.equal(snapshot.payload.pricingPolicy.pricingModel,"SPREAD");
  assert.equal(snapshot.hash,computeContentHash(snapshot.payload));
  Object.assign(f.version,{payload:snapshot.payload,content_hash:snapshot.hash,rule_release_id:"release"});
  await assert.rejects(submitListing(f.client,f.account,"owner",{expectedRevision:"2",versionId:"draft",contentHash:snapshot.hash,releaseId:"release"},async()=>({publisherBail:"NOT_REQUIRED",reference:"proof",occupancy:"FREE"})),/价差订单结算暂未就绪/);
});

test("draft pricing stops when model configuration or prior publication evidence cannot be verified",async()=>{
  for(const mode of ["incomplete","missing","priorHash"] as const){
    const f=fixture();f.controls.schedules=true;
    if(mode==="incomplete")f.controls.incompleteSchedules=true;
    if(mode==="missing")f.controls.missingDefault=true;
    if(mode==="priorHash")f.controls.previous={schemaVersion:4,contentHash:"0".repeat(64),payload:{accountId:"account",gameId:"game"}};
    await assert.rejects(quoteListing(f.client,f.account,"1"));assert.deepEqual(f.writes,[]);
  }
});

test("listing quote preserves explicit zero and distinguishes missing declaration or policy", async () => {
  const zero = fixture("10000", "NOT_REQUIRED"); await quoteListing(zero.client, zero.account, "1");
  assert.equal(zero.snapshots[0].payload.quoteValues.tenantDeposit.amount, "100.00");
  assert.equal(zero.snapshots[0].payload.quoteValues.publisherBailRequirement.amount, "0.00");
  for (const kind of ["declaration", "policy"] as const) {
    const f = fixture(kind === "declaration" ? null : "10000"); if (kind === "policy") f.controls.policy = null;
    await quoteListing(f.client, f.account, "1");
    assert.equal(f.snapshots[0].payload.quoteValues.tenantDeposit, null);
    assert.equal(f.snapshots[0].payload.quoteValues.publisherBailRequirement, null);
    assert.equal(f.policyReads(), kind === "declaration" ? 0 : 1);
  }
});

test("invalid declaration, unavailable policy and published versions cannot write a quote", async () => {
  for (const kind of ["invalid", "unavailable", "published"] as const) {
    const f = fixture(kind === "invalid" ? "-1" : "10000");
    if (kind === "unavailable") f.controls.policyFailure = true;
    if (kind === "published") f.version.review_state = "PUBLISHED";
    await assert.rejects(quoteListing(f.client, f.account, "1"));
    assert.deepEqual(f.writes, []);
  }
});
