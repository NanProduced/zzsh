import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {computeDeltaQuote,projectDeltaQuote,type InternalQuote,type QuoteInput} from "../src/supply/pricing";
import {quoteToGrowthOfferPlan,type OfferBinding} from "../src/auth/membership-growth";
import {selectPersonalGrowthOffer,frozenPersonalGrowthV4Valid,type GrowthConfirmationKnown} from "../src/order/personal-growth-confirmation";
import {freezeSettlementPricing,issuePersonalConfirmation,readPersonalPriceProjection,rebuildPersonalConfirmation,verifyPersonalConfirmation,type PersonalConfirmationOptions} from "../src/order/personal-confirmation";
import {computeContentHash,normalizeContentPayload} from "../src/supply/content-hash";
import {compatRule} from "./pricing-compat-fixture";
import {legacyPayload} from "./legacy-listed-fixture";
import {applyTotalDiscountToQuote} from "../src/auth/membership-total-discount";
import {FIXED_FEE_ALGORITHM} from "../src/supply/fixed-fee";
const asOf="2026-10-16T04:00:00.123456Z",binding:OfferBinding={userId:"user-1",ownerUserId:"owner-1",accountId:"account-1",listingVersionId:"version-1",ruleReleaseId:"release-1",quantityDigest:"a".repeat(64)};
function input(base="47",deposit="30000"):QuoteInput{return {priceVersionId:"price-v1",mode:"SPREAD",roundingPolicy:"HALF_UP_CENT_V1",customerTier:"STANDARD",haffRule:compatRule(base),lines:[{itemId:"haff",quantity:"60000000",pricingKind:"HAFF_RATIO",unit:"HAFF_BASE",customerTier:"STANDARD"}],conditions:{safeBoxCode:"box-a",vitLevel:6,bearLevel:6,termOptionCode:"daily-10m",rentalPricing:{rentalMode:"ordinary"}},termOption:{code:"daily-10m",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"},deposits:{tenantDepositCents:deposit,publisherBailRequirementCents:"0"}};}
function quote(base="47",deposit="30000"):InternalQuote{const result=computeDeltaQuote(input(base,deposit));assert(result.quotable,result.quotable?"":result.reasonCodes.join(","));return result.quote;}

test("partial deposit source freezes its own identity and expiry without adding allowances or altering rental lines",()=>{
 const growth=quote("55","20000"),friend=quote("47","10000");
 const data:GrowthConfirmationKnown={knowledge:"KNOWN",effectiveTier:"GOLD",policyTier:"GOLD",asOfUtc:asOf,policyVersion:"1",entitlementIds:["friend-1"],candidates:[{quote:growth,plan:quoteToGrowthOfferPlan(growth,{source:"GROWTH",benefitVersion:"1",binding})},{quote:friend,plan:quoteToGrowthOfferPlan(friend,{source:"FRIEND",benefitVersion:"2",binding,entitlementId:"friend-1",validUntil:"2026-10-20T00:00:00.000000Z"})}]};
 const before=JSON.stringify(data),selected=selectPersonalGrowthOffer(data,binding,asOf,quote("47","40000"));
 assert.equal(selected.benefits.priceSource,"GROWTH");assert.equal(selected.benefits.depositSource,"FRIEND");
 assert.equal(selected.quote.tenantDeposit?.amount,"100.00");assert.equal(selected.growth.depositCents,"10000");
 assert.equal(selected.growth.depositEntitlementId,"friend-1");assert.equal(selected.growth.depositValidUntil,"2026-10-20T00:00:00.000000Z");
 assert.deepEqual(selected.quote.lines,growth.lines);assert.equal(JSON.stringify(data),before);
});
function known():GrowthConfirmationKnown{
 const growth=quote("47","0"),friend=quote("55","30000");
 return {knowledge:"KNOWN",effectiveTier:"GOLD",policyTier:"GOLD",asOfUtc:asOf,policyVersion:"1",entitlementIds:["friend-1"],candidates:[{quote:growth,plan:quoteToGrowthOfferPlan(growth,{source:"GROWTH",benefitVersion:"1",binding})},{quote:friend,plan:quoteToGrowthOfferPlan(friend,{source:"FRIEND",benefitVersion:"1",binding,entitlementId:"friend-1",validUntil:"2026-10-17T00:00:00.000000Z"})}]};
}
test("whole cheaper friend price combines only independent growth deposit waiver, exact payable is recomputed",()=>{
 const data=known(),result=selectPersonalGrowthOffer(data,binding,asOf,quote());assert.equal(result.benefits.priceSource,"FRIEND");assert.equal(result.benefits.depositSource,"GROWTH");
 assert.deepEqual(result.quote.lines,data.candidates[1]!.quote.lines);assert.equal(result.quote.tenantDeposit?.amount,"0.00");assert.equal(data.candidates[1]!.quote.tenantDeposit?.amount,"300.00");
 assert.equal(projectDeltaQuote(result.quote,"public").tenantPayableTotal?.amount,result.quote.resourceTotal.amount);assert.equal(result.growth.depositCents,"0");assert.equal(result.growth.selectedEntitlementId,"friend-1");
 const tie=known();tie.candidates[1]={...tie.candidates[1]!,quote:tie.candidates[0]!.quote,plan:{...tie.candidates[1]!.plan,rentalTotalCents:tie.candidates[0]!.plan.rentalTotalCents,depositCents:"0",depositWaived:true}};assert.equal(selectPersonalGrowthOffer(tie,binding,asOf,quote()).benefits.priceSource,"GROWTH");
});
test("unknown metadata, stale asOf, wrong subject and synthetic candidate amounts never fall back to old tiers",()=>{
 for(const mutate of [(x:GrowthConfirmationKnown)=>{delete x.effectiveTier;},(x:GrowthConfirmationKnown)=>{x.asOfUtc="2026-10-15T00:00:00Z";},(x:GrowthConfirmationKnown)=>{x.candidates.forEach(c=>c.plan.binding={...binding,userId:"other"});},(x:GrowthConfirmationKnown)=>{x.candidates[0]!.plan.rentalTotalCents="0";},(x:GrowthConfirmationKnown)=>{x.effectiveTier="BLACK_GOLD";x.policyTier="GOLD";}]){const x=known();mutate(x);assert.throws(()=>selectPersonalGrowthOffer(x,binding,asOf,quote()),(e:unknown)=>(e as {status:number}).status===503);}
 const expired=known();expired.candidates[1]!.plan.validUntil=asOf;assert.equal(selectPersonalGrowthOffer(expired,binding,asOf,quote()).benefits.priceSource,"GROWTH");
});
test("frozen v4 validation binds separate sources and cannot reclassify old v3 or a mismatched deposit",()=>{
 const s=selectPersonalGrowthOffer(known(),binding,asOf,quote()),expected={...binding,listingHash:"b".repeat(64)},personal={schema:"personal-quote-v4",...expected,membershipGrowth:s.growth};
 assert(frozenPersonalGrowthV4Valid(personal,expected,"0"));assert(!frozenPersonalGrowthV4Valid(personal,expected,"30000"));assert(!frozenPersonalGrowthV4Valid({...personal,schema:"personal-quote-v3"},expected,"0"));assert(!frozenPersonalGrowthV4Valid({...personal,membership:{tier:"STANDARD"}},expected,"0"));
 const v5={...personal,schema:"personal-quote-v5",pricingPolicy:{schema:"pricing-policy-v1",pricingModel:"FIXED_FEE",scheduleId:"schedule-1",generation:"1",effectiveAt:"2026-10-01T00:00:00Z",priceVersionId:"price-1"}};
 assert(frozenPersonalGrowthV4Valid(v5,expected,"0"));assert(!frozenPersonalGrowthV4Valid({...v5,pricingPolicy:{...v5.pricingPolicy,pricingModel:"SPREAD"}},expected,"0"));
 assert(!frozenPersonalGrowthV4Valid({...v5,pricingPolicy:null},expected,"0"));
 const v6={...v5,schema:"personal-quote-v6",pricingPolicy:{...v5.pricingPolicy,pricingModel:"SPREAD"}};
 assert(frozenPersonalGrowthV4Valid(v6,expected,"0"));assert(!frozenPersonalGrowthV4Valid({...v6,pricingPolicy:v5.pricingPolicy},expected,"0"));
});
test("selected total discount is verified against the original quote before it is frozen",()=>{
 const base=quote("47","0"),discounted=applyTotalDiscountToQuote(base,"0.99");assert(discounted);
 const data:GrowthConfirmationKnown={knowledge:"KNOWN",effectiveTier:"GOLD",policyTier:"GOLD",asOfUtc:asOf,policyVersion:"1",entitlementIds:[],candidates:[{quote:discounted.quote,payableRatio:"0.99",plan:quoteToGrowthOfferPlan(discounted.quote,{source:"GROWTH",benefitVersion:"1",binding})}]};
 assert.equal(selectPersonalGrowthOffer(data,binding,asOf,base).payableRatio,"0.99");
 data.candidates[0]!.payableRatio="0.5";assert.throws(()=>selectPersonalGrowthOffer(data,binding,asOf,base));
});
test("settlement pricing freezes the selected discount and all enabled sealed item prices",()=>{
 const base=quote(),basis=freezeSettlementPricing(base,"0.99000000",[
  {item_id:"bullet",pricing_kind:"FIXED_UNIT",unit_quantity:"60",buyer_unit_amount:"4.00000000",owner_unit_amount:"2.00000000",item_unit:"ROUND",item_name:"6级子弹",item_enabled:true},
  {item_id:"disabled",pricing_kind:"FIXED_UNIT",unit_quantity:null,buyer_unit_amount:null,owner_unit_amount:null,item_unit:"PIECE",item_enabled:false},
 ]);
 assert.equal(basis.payableRatio,"0.99");assert.equal(basis.haff.itemId,"haff");
 assert.deepEqual(basis.items,[{itemId:"bullet",name:"6级子弹",unit:"ROUND",unitQuantity:"60",buyerUnitAmount:"4",ownerUnitAmount:"2"}]);
 assert.throws(()=>freezeSettlementPricing(base,"0.99",[{item_id:"bad",pricing_kind:"FIXED_UNIT",unit_quantity:"1",buyer_unit_amount:"1",owner_unit_amount:"2",item_unit:"PIECE"}]));
});
test("T deposit provenance keeps a still-active same-millisecond waiver using normalized microseconds; E choice is an explicit fixture",t=>{
 const shared:typeof import("../src/auth/membership-growth")=require("../src/auth/membership-growth");
 const growth=quote("47","30000"),friend=quote("46","0");let active=true;
 t.mock.method(shared,"chooseCompleteOffer",(plans:readonly import("../src/auth/membership-growth").GrowthOfferPlan[]):import("../src/auth/membership-growth").OfferChoice=>({knowledge:"KNOWN",selected:plans[0]!,priceBasis:"GROWTH",depositBasis:active?"FRIEND":"GROWTH",depositCents:active?"0":"30000"}));
 for(const [until,valid] of [["2026-10-16T04:00:00.123900Z",true],["2026-10-16T12:00:00.123900+08:00",true],[asOf,false],["2026-10-16T04:00:00.123455Z",false]] as const){
  active=valid;const data:GrowthConfirmationKnown={knowledge:"KNOWN",effectiveTier:"GOLD",policyTier:"GOLD",asOfUtc:asOf,policyVersion:"1",entitlementIds:["friend-1"],candidates:[{quote:growth,plan:quoteToGrowthOfferPlan(growth,{source:"GROWTH",benefitVersion:"1",binding})},{quote:friend,plan:quoteToGrowthOfferPlan(friend,{source:"FRIEND",benefitVersion:"2",binding,entitlementId:"friend-1",validUntil:until})}]};
  const result=selectPersonalGrowthOffer(data,binding,asOf,growth);assert.equal(result.growth.depositCents,valid?"0":"30000");assert.equal(result.growth.depositEntitlementId,valid?"friend-1":null);assert.equal(result.growth.depositBenefitVersion,valid?"2":"1");assert.equal(result.benefits.priceSource,"GROWTH");
 }
});
test("actual confirmation rebuild skips readRentalMembership when growth is configured and never exposes old customerTier",async t=>{
 const order:typeof import("../src/order/order")=require("../src/order/order"),publishing:typeof import("../src/supply/publishing")=require("../src/supply/publishing"),funding:typeof import("../src/supply/funding-authority")=require("../src/supply/funding-authority"),membership:typeof import("../src/auth/rental-membership")=require("../src/auth/rental-membership");
 t.mock.method(order,"assertFreshCreateAuthorization",async()=>({ownerUserId:"owner-1",gameId:"game-1"}));t.mock.method(publishing,"evaluatePublication",async()=>[]);t.mock.method(funding,"isProductionConfirmationFundingReader",()=>true);
 let legacyReads=0;t.mock.method(membership,"readRentalMembership",async()=>{legacyReads++;throw new Error("old membership must not gate growth");});
 const payload=normalizeContentPayload({schemaVersion:2,accountId:"account-1",gameId:"game-1",declaration:{title:"FIXTURE",description:null,attributes:{safe_box_code:"box-a",vit_level:6,bear_level:6,rentalPricing:{rentalMode:"ordinary"},full_payout_declaration:{schema:"full-payout-declaration-v1",selected:false}},inventory:[{itemId:"haff",quantity:"60000000"}],skins:[],entitlements:[],mediaBindings:[],termOptionCode:"daily-10m",pricingOptionCode:""},ruleRefs:{releaseId:"release-1",catalogRevision:"1",priceVersionId:"price-v1",termVersionId:"term-v1",agreementVersionId:"agreement-1",agreementDigest:"d".repeat(64)},quoteValues:quote()});
 const version={id:"version-1",account_id:"account-1",rule_release_id:"release-1",review_state:"PUBLISHED",payload,content_hash:computeContentHash(payload)},account={id:"account-1",owner_user_id:"owner-1",game_id:"game-1",current_version_id:"version-1"};
 const client={query:async(sql:string,v:unknown[]=[])=>{
  if(sql.includes("FROM zzsh_supply.game"))return {rows:[{current_release_id:"release-1",enabled:true}]};if(sql.includes("SELECT * FROM zzsh_supply.rental_account"))return {rows:[account]};if(sql.includes("SELECT * FROM zzsh_supply.listing_version"))return {rows:[version]};if(sql.includes("FROM zzsh_supply.listing_publication"))return {rows:[{source:"OWNER_DIRECT"}]};if(sql.includes("SELECT p.id,p.status"))return {rows:[{id:"price-v1",status:"SEALED",mode:"SPREAD",haff_rule:compatRule(),commission_rate:null,rounding_policy:"HALF_UP_CENT_V1",term_version_id:"term-v1"}]};if(sql.includes("FROM zzsh_supply.price_line")){assert.equal(v[1],"STANDARD");return {rows:[{item_id:"haff",pricing_kind:"HAFF_RATIO",unit_quantity:null,buyer_unit_amount:null,owner_unit_amount:null}]};}if(sql.includes("FROM zzsh_supply.term_option"))return {rows:[input().termOption]};if(sql.includes("AS at"))return {rows:[{at:asOf}]};if(sql.includes(" AS now"))return {rows:[{now:"1792123200"}]};throw new Error("unexpected SQL: "+sql);
 }} as unknown as PoolClient;
 let unknown=false;const options:PersonalConfirmationOptions={gate:async()=>({occupancy:"FREE",publisherBail:"NOT_REQUIRED",reference:"FIXTURE_FORMAL_REFERENCE"}),fundingReader:async()=>({schema:"personal-quote-v2",version:"1",sourceRef:"FIXTURE_FUNDING",baseDepositCents:"30000",publisherBailRequirementCents:"0",vipWaiver:false,svipWaiver:false,fullPayoutPolicyRef:"fixture-policy",fullPayoutPolicyVersion:"1",disclosureVersion:"v1"}),membershipGrowthReader:async(_c,i)=>unknown?{knowledge:"UNKNOWN",reason:"GROWTH_UNKNOWN"}:{...known(),asOfUtc:i.asOfUtc,candidates:known().candidates.map(c=>({...c,plan:{...c.plan,binding:{userId:i.userId,ownerUserId:i.ownerUserId,accountId:i.accountId,listingVersionId:i.listingVersionId,ruleReleaseId:i.ruleReleaseId,quantityDigest:i.quantityDigest}}}))}};
 const result=await rebuildPersonalConfirmation(client,{userId:"user-1",sessionId:"session-1"},{accountId:"account-1",versionId:"version-1",releaseId:"release-1"},options);
 assert.equal(result.snapshot.schema,"personal-quote-v4");assert(!Object.hasOwn(result.snapshot,"membership"));assert(!Object.hasOwn(result.projection,"customerTier"));assert("membershipBenefits" in result.projection);assert.equal(result.projection.membershipBenefits.effectiveTier,"GOLD");assert.equal(result.projection.quote.tenantPayableTotal?.amount,result.projection.quote.resourceTotal.amount);assert.equal(legacyReads,0);
 unknown=true;await assert.rejects(()=>rebuildPersonalConfirmation(client,{userId:"user-1",sessionId:"session-1"},{accountId:"account-1",versionId:"version-1",releaseId:"release-1"},options),(e:unknown)=>(e as {code:string}).code==="MEMBERSHIP_UNKNOWN");assert.equal(legacyReads,0);
});

test("legacy confirmation uses its frozen base with new growth and rejects missing source or policy",async t=>{
 const order:typeof import("../src/order/order")=require("../src/order/order"),publishing:typeof import("../src/supply/publishing")=require("../src/supply/publishing"),funding:typeof import("../src/supply/funding-authority")=require("../src/supply/funding-authority"),reference:typeof import("../src/supply/legacy-published-reference")=require("../src/supply/legacy-published-reference");
 t.mock.method(order,"assertFreshCreateAuthorization",async()=>({ownerUserId:"owner-1",gameId:"game"}));
  const evaluate=t.mock.method(publishing,"evaluatePublication",async()=>[]);t.mock.method(funding,"isProductionConfirmationFundingReader",()=>true);
 let sourceValid=true;
 t.mock.method(reference,"readLegacyPublishedReference",async()=>sourceValid?{digest:"c".repeat(64),observationVersionId:"observation",sourceDigest:"a".repeat(64),legacyId:"42",gradingCode:null,slots:[{position:0,path:"accountsImage/20261101/fixture.png"}]}:null);
 const payload=normalizeContentPayload(legacyPayload());
 const version={id:"version-1",account_id:"legacy-account",rule_release_id:"release",review_state:"APPROVED",payload,content_hash:computeContentHash(payload)},account={id:"legacy-account",owner_user_id:"owner-1",game_id:"game",current_version_id:"version-1"};
 const statements:string[]=[];
 const client={query:async(sql:string)=>{statements.push(sql);
  if(sql.includes("FROM zzsh_supply.game"))return {rows:[{current_release_id:"release",enabled:true}]};
  if(sql.includes("SELECT * FROM zzsh_supply.rental_account"))return {rows:[account]};
  if(sql.includes("SELECT * FROM zzsh_supply.listing_version"))return {rows:[version]};
  if(sql.includes("FROM zzsh_supply.listing_publication"))return {rows:[{source:"LEGACY_APPROVED"}]};
  if(sql.includes("SELECT p.id,p.status"))return {rows:[{id:"price",status:"SEALED",mode:"SPREAD",haff_rule:compatRule("52"),commission_rate:null,rounding_policy:"HALF_UP_CENT_V1",term_version_id:"term"}]};
  if(sql.includes("FROM zzsh_supply.price_line"))return {rows:[]}; // no new price may replace the frozen legacy base
  if(sql.includes("FROM zzsh_supply.term_option"))return {rows:[{code:"daily-10m",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"}]};
  if(sql.includes("AS at"))return {rows:[{at:asOf}]};if(sql.includes(" AS now"))return {rows:[{now:"1792123200"}]};throw new Error("unexpected SQL: "+sql);
 }} as unknown as PoolClient;
 let unknown=false;
 const growthReader:NonNullable<PersonalConfirmationOptions["membershipGrowthReader"]>=async(_c,i)=>{
  if(unknown)return {knowledge:"UNKNOWN",reason:"GROWTH_UNKNOWN"};
  const discounted=applyTotalDiscountToQuote(i.baseQuote,"0.95");assert(discounted);
  const planBinding={userId:i.userId,ownerUserId:i.ownerUserId,accountId:i.accountId,listingVersionId:i.listingVersionId,ruleReleaseId:i.ruleReleaseId,quantityDigest:i.quantityDigest};
  return {knowledge:"KNOWN",effectiveTier:"GOLD",policyTier:"GOLD",asOfUtc:i.asOfUtc,policyVersion:"1",entitlementIds:[],candidates:[{quote:discounted.quote,payableRatio:"0.95",plan:quoteToGrowthOfferPlan(discounted.quote,{source:"GROWTH",benefitVersion:"1",binding:planBinding})}]};
 };
 const terms={termsVersionId:"terms-1",termsDigest:"e".repeat(64),disclosureVersion:"v1",policyRef:"fixture-policy",policyVersion:"1",title:"Fixture terms",body:"Synthetic terms"};
 let withTerms=false;
 const options:PersonalConfirmationOptions={gate:async()=>({occupancy:"FREE",publisherBail:"NOT_REQUIRED",reference:"FIXTURE"}),fundingReader:async()=>({schema:"personal-quote-v2",version:"1",sourceRef:"FIXTURE",baseDepositCents:"20000",publisherBailRequirementCents:"0",vipWaiver:false,svipWaiver:false,fullPayoutPolicyRef:"fixture-policy",fullPayoutPolicyVersion:"1",disclosureVersion:"v1",...(withTerms?{fullPayoutTerms:terms}:{})}),membershipGrowthReader:growthReader};
 const user={userId:"user-1",sessionId:"session-1"},request={accountId:"legacy-account",versionId:"version-1",releaseId:"release"};
 const result=await rebuildPersonalConfirmation(client,user,request,options);
 assert.equal(result.snapshot.schema,"personal-quote-v4");assert.equal(result.snapshot.quote.schemaVersion,3);
 assert("settlementPricing" in result.snapshot);assert.equal(result.snapshot.settlementPricing?.payableRatio,"0.95");
 assert(!Object.hasOwn(result.projection,"settlementPricing"));
 assert.equal(result.snapshot.quote.resourceTotal.amount,"384.75");assert.equal(result.snapshot.quote.ownerTotal.amount,"349.00");
 assert.equal(result.projection.quote.baseRenterHaffRatioWanPerYuan,"37");assert.equal(result.snapshot.quote.legacyQuote?.ownerRatio,"43");
 unknown=true;await assert.rejects(()=>rebuildPersonalConfirmation(client,user,request,options),(e:unknown)=>(e as {code:string}).code==="MEMBERSHIP_UNKNOWN");
 unknown=false;sourceValid=false;await assert.rejects(()=>rebuildPersonalConfirmation(client,user,request,options),(e:unknown)=>(e as {code:string}).code==="CONFIRMATION_DEPENDENCY_UNAVAILABLE");
 sourceValid=true;await assert.rejects(()=>rebuildPersonalConfirmation(client,user,request,{...options,membershipGrowthReader:undefined}),(e:unknown)=>(e as {code:string}).code==="MEMBERSHIP_UNKNOWN");
 // Owner's old election is carried as a fact, but the renter must still see and accept the sealed terms.
 payload.legacyQuote!.fullPayoutSelected=true;(payload.quoteValues as any).legacyQuote.fullPayoutSelected=true;
 (payload.declaration.attributes.full_payout_declaration as {selected:boolean}).selected=true;version.content_hash=computeContentHash(payload);
 t.mock.method(publishing,"evaluatePricePreviewPublication",async()=>[]);
 t.mock.method(publishing,"readListingPublication",async()=>({source:"LEGACY_APPROVED"} as never));
 t.mock.method(funding,"readProductionConfirmationFundingForPreview",async()=>options.fundingReader!(client,account as never,version as never) as never);
 const prepared={account:account as never,game:{current_release_id:"release",enabled:true},asOfUtc:asOf};
 await assert.rejects(()=>readPersonalPriceProjection(client,user,request,options,prepared),(e:unknown)=>(e as {code:string}).code==="CONFIRMATION_DEPENDENCY_UNAVAILABLE");
 withTerms=true;const preview=await readPersonalPriceProjection(client,user,request,options,prepared);
 assert.equal(preview.projection.compensationDisclosure?.terms?.termsDigest,terms.termsDigest);
 await assert.rejects(()=>rebuildPersonalConfirmation(client,user,request,options),(e:unknown)=>(e as {status:number}).status===409);
 await assert.rejects(()=>rebuildPersonalConfirmation(client,user,{...request,fullPayoutTermsAcceptance:{termsVersionId:"other",termsDigest:terms.termsDigest,disclosureVersion:terms.disclosureVersion}},options),(e:unknown)=>(e as {status:number}).status===409);
 const accepted=await rebuildPersonalConfirmation(client,user,{...request,fullPayoutTermsAcceptance:{termsVersionId:terms.termsVersionId,termsDigest:terms.termsDigest,disclosureVersion:terms.disclosureVersion}},options);
 assert.equal(accepted.snapshot.schema,"personal-quote-v4");assert.equal(accepted.projection.compensationDisclosure?.selected,true);
  evaluate.mock.mockImplementation(async()=>["LEGACY_LISTING_RELIST_REQUIRED"]);
  await assert.rejects(()=>rebuildPersonalConfirmation(client,user,request,options),(e:unknown)=>(e as {code:string,status:number}).code==="CONFIRMATION_CHANGED"&&(e as {status:number}).status===409);
 assert.equal(statements.some(sql=>/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),false);
});

test("fixed-fee confirmation binds effective pricing separately from accepted funding and rejects a changed policy",async t=>{
 const order:typeof import("../src/order/order")=require("../src/order/order"),publishing:typeof import("../src/supply/publishing")=require("../src/supply/publishing"),funding:typeof import("../src/supply/funding-authority")=require("../src/supply/funding-authority");
 t.mock.method(order,"assertFreshCreateAuthorization",async()=>({ownerUserId:"owner-1",gameId:"game-1"}));t.mock.method(publishing,"evaluatePublication",async()=>[]);t.mock.method(funding,"isProductionConfirmationFundingReader",()=>true);
 let fundingPrice="";t.mock.method(funding,"assertFinalConfirmationFunding",async(_client:PoolClient,facts:Parameters<typeof funding.assertFinalConfirmationFunding>[1])=>{fundingPrice=facts.priceVersionId;});
 const fixedRule=(base:string)=>{const {compatibility,...rest}=compatRule(base);return {...rest,schema:"haff-ratio-v3",fixedModes:compatibility!.modes};};
 const originalInput:QuoteInput={priceVersionId:"price-v1",mode:"PERCENT",fixedFeeAlgorithm:FIXED_FEE_ALGORITHM,commissionRate:"0.10",roundingPolicy:"HALF_UP_CENT_V1",customerTier:"STANDARD",haffRule:fixedRule("47"),
  lines:[{itemId:"haff",quantity:"60000000",pricingKind:"HAFF_RATIO",unit:"HAFF_BASE",customerTier:"STANDARD"}],conditions:{safeBoxCode:"box-a",vitLevel:6,bearLevel:6,termOptionCode:"daily-10m",rentalPricing:{rentalMode:"custom",ownerRatioB:"45"}},
  termOption:{code:"daily-10m",dailyConsumption:"10000000",durationRounding:"CEIL_DAY"},deposits:{tenantDepositCents:"30000",publisherBailRequirementCents:"0"}};
 const original=computeDeltaQuote(originalInput);assert(original.quotable);original.quote.ruleReleaseId="release-1";
 const payload=normalizeContentPayload({schemaVersion:4,accountId:"account-1",gameId:"game-1",declaration:{title:"FIXTURE",description:null,attributes:{safe_box_code:"box-a",vit_level:6,bear_level:6,rentalPricing:{rentalMode:"custom",ownerRatioB:"45"},full_payout_declaration:{schema:"full-payout-declaration-v1",selected:false}},inventory:[{itemId:"haff",quantity:"60000000"}],skins:[],entitlements:[],mediaBindings:[],termOptionCode:"daily-10m",pricingOptionCode:""},
  ruleRefs:{releaseId:"release-1",priceVersionId:"funding-v1",termVersionId:"term-v1",agreementVersionId:"agreement-1",agreementDigest:"d".repeat(64)},
  pricingPolicy:{schema:"pricing-policy-v1",pricingModel:"FIXED_FEE",scheduleId:"schedule-1",generation:"1",effectiveAt:"2026-10-15T00:00:00Z",priceVersionId:"price-v1"},quoteValues:original.quote as unknown as Record<string,unknown>});
 const version={id:"version-1",account_id:"account-1",rule_release_id:"release-1",review_state:"PUBLISHED",payload,content_hash:computeContentHash(payload)},account={id:"account-1",owner_user_id:"owner-1",game_id:"game-1",current_version_id:"version-1"};
 let policyNo=2;
 const client={query:async(sql:string,values:unknown[]=[])=>{
  if(sql.includes("FROM zzsh_supply.game"))return {rows:[{current_release_id:"release-1",enabled:true}]};if(sql.includes("SELECT * FROM zzsh_supply.rental_account"))return {rows:[account]};if(sql.includes("SELECT * FROM zzsh_supply.listing_version"))return {rows:[version]};
  if(sql.includes("FROM zzsh_supply.listing_publication"))return {rows:[{source:"OWNER_DIRECT"}]};if(sql.includes("SELECT p.id,p.status"))return {rows:[{id:"funding-v1",status:"SEALED",mode:"SPREAD",haff_rule:compatRule(),commission_rate:null,rounding_policy:"HALF_UP_CENT_V1",term_version_id:"term-v1"}]};
  if(sql.includes("FROM zzsh_supply.pricing_policy_schedule s"))return {rows:[{id:`schedule-${policyNo}`,generation:String(policyNo),effectiveAt:"2026-10-16T00:00:00.000000Z",priceVersionId:`price-v${policyNo}`,mode:"PERCENT",status:"SEALED",roundingPolicy:"HALF_UP_CENT_V1",haffRule:fixedRule(policyNo===2?"50":"51"),rates:{ordinary:"0.1",custom:policyNo===2?"0.12":"0.13",fast:"0.12"}}]};
  if(sql.includes("FROM zzsh_supply.price_line")){assert.equal(values[0],`price-v${policyNo}`);return {rows:[{item_id:"haff",pricing_kind:"HAFF_RATIO",unit_quantity:null,buyer_unit_amount:null,owner_unit_amount:null,item_unit:"HAFF_BASE",item_enabled:true}]};}
  if(sql.includes("FROM zzsh_supply.term_option"))return {rows:[originalInput.termOption]};if(sql.includes("AS at"))return {rows:[{at:asOf}]};if(sql.includes(" AS now"))return {rows:[{now:"1792123200"}]};throw new Error("unexpected SQL: "+sql);
 }} as unknown as PoolClient;
 const growthReader:NonNullable<PersonalConfirmationOptions["membershipGrowthReader"]>=async(_c,i)=>{
  assert.equal(i.priceVersionId,`price-v${policyNo}`);assert.equal(i.baseQuote.pricingInputs.compatibility?.ownerRatioB,"45");
  const discounted=applyTotalDiscountToQuote(i.baseQuote,"0.95");assert(discounted);
  const planBinding={userId:i.userId,ownerUserId:i.ownerUserId,accountId:i.accountId,listingVersionId:i.listingVersionId,ruleReleaseId:i.ruleReleaseId,quantityDigest:i.quantityDigest};
  return {knowledge:"KNOWN",effectiveTier:"GOLD",policyTier:"GOLD",asOfUtc:i.asOfUtc,policyVersion:"1",entitlementIds:[],candidates:[{quote:discounted.quote,payableRatio:"0.95",plan:quoteToGrowthOfferPlan(discounted.quote,{source:"GROWTH",benefitVersion:"1",binding:planBinding})}]};
 };
 const options:PersonalConfirmationOptions={key:{keyId:"fixture",secret:"isolated-fixture-only-not-production-key"},gate:async()=>({occupancy:"FREE",publisherBail:"NOT_REQUIRED",reference:"FIXTURE"}),
  fundingReader:async()=>({schema:"personal-quote-v2",version:"1",sourceRef:"FIXTURE",baseDepositCents:"30000",publisherBailRequirementCents:"0",vipWaiver:false,svipWaiver:false,fullPayoutPolicyRef:"fixture-policy",fullPayoutPolicyVersion:"1",disclosureVersion:"v1"}),membershipGrowthReader:growthReader};
 const user={userId:"user-1",sessionId:"session-1"},request={accountId:"account-1",versionId:"version-1",releaseId:"release-1"};
 const rebuilt=await rebuildPersonalConfirmation(client,user,request,options);
 assert.equal(rebuilt.snapshot.schema,"personal-quote-v5");assert.equal(rebuilt.snapshot.ruleRefs.priceVersionId,"funding-v1");assert.equal(rebuilt.snapshot.quote.priceVersionId,"price-v2");
 assert.equal("pricingPolicy" in rebuilt.snapshot&&rebuilt.snapshot.pricingPolicy?.scheduleId,"schedule-2");assert.equal(rebuilt.projection.quote.baseRenterHaffRatioWanPerYuan,"45");
 assert("settlementPricing" in rebuilt.snapshot);assert.equal(rebuilt.snapshot.settlementPricing?.schema,"settlement-pricing-v3");assert.equal(rebuilt.snapshot.settlementPricing?.fixedFeeRate,"0.12");
 const issued=await issuePersonalConfirmation(client,user,request,options);assert.equal(fundingPrice,"funding-v1");
 await verifyPersonalConfirmation(client,user,request,issued.confirmationToken,options);
 policyNo=3;await assert.rejects(()=>verifyPersonalConfirmation(client,user,request,issued.confirmationToken,options),(error:unknown)=>(error as {code:string}).code==="CONFIRMATION_CHANGED");
});
