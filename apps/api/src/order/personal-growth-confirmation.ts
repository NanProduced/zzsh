import {createHash} from "node:crypto";
import {SecurityApiError} from "../auth/security-core";
import {chooseCompleteOffer,quoteToGrowthOfferPlan,type GrowthOfferPlan,type GrowthTier,type NormalGrowthTier,type OfferBinding} from "../auth/membership-growth";
import {canonicalize,normalizeQuote} from "../supply/content-hash";
import {yuanAmountObject} from "../supply/decimal";
import type {InternalQuote} from "../supply/pricing";

export type PersonalGrowthBenefits={schema:"membership-benefits-v1";effectiveTier:Exclude<GrowthTier,"UNKNOWN">;policyTier:NormalGrowthTier;priceSource:GrowthOfferPlan["source"];depositSource:GrowthOfferPlan["source"];policyVersion:string};
export type GrowthConfirmationKnown={knowledge:"KNOWN";policyVersion:string;candidates:Array<{plan:GrowthOfferPlan;quote:InternalQuote}>;entitlementIds:string[];
  /** Filled by the existing E reader. Missing metadata is UNKNOWN, never synthetic STANDARD. */
  effectiveTier?:Exclude<GrowthTier,"UNKNOWN">;policyTier?:NormalGrowthTier;asOfUtc?:string};
const fail=(message:string):never=>{throw new SecurityApiError(503,"MEMBERSHIP_UNKNOWN",message);};
const tiers=["STANDARD","SILVER","GOLD","PLATINUM","DIAMOND","BLACK_GOLD"] as const;
export function selectPersonalGrowthOffer(known:GrowthConfirmationKnown,binding:OfferBinding,asOfUtc:string,baseQuote:InternalQuote){
  if(!known.effectiveTier || !tiers.includes(known.effectiveTier) || !known.policyTier || !["STANDARD","SILVER","GOLD","PLATINUM","DIAMOND"].includes(known.policyTier) || known.asOfUtc!==asOfUtc || !/^[1-9]\d{0,18}$/.test(known.policyVersion))return fail("Growth benefit metadata is unavailable");
  if((known.effectiveTier==="BLACK_GOLD"?"DIAMOND":known.effectiveTier)!==known.policyTier)return fail("Growth benefit tier binding is invalid");
  for(const candidate of known.candidates){
    const plan=candidate.plan;
    const quantities=(q:InternalQuote)=>q.lines.map(l=>({itemId:l.itemId,unit:l.unit,quantity:l.quantity,pricingKind:l.pricingKind})).sort((a,b)=>a.itemId.localeCompare(b.itemId));
    if(canonicalize(plan.binding)!==canonicalize(binding) || candidate.quote.priceVersionId!==plan.priceVersion || candidate.quote.priceVersionId!==baseQuote.priceVersionId || candidate.quote.termSeconds!==baseQuote.termSeconds || canonicalize(quantities(candidate.quote))!==canonicalize(quantities(baseQuote)) || canonicalize(candidate.quote.expiryDisclosures)!==canonicalize(baseQuote.expiryDisclosures)
      || candidate.quote.ruleReleaseId!==null && candidate.quote.ruleReleaseId!==binding.ruleReleaseId)return fail("Growth offer binding changed");
    if(!["GROWTH","FRIEND","PRESTIGE"].includes(plan.source) || plan.source==="GROWTH" && (plan.entitlementId!=null || plan.validUntil!=null)
      || plan.source!=="GROWTH" && (!plan.entitlementId || !known.entitlementIds.includes(plan.entitlementId) || !plan.validUntil))return fail("Benefit evidence is unavailable");
    const actual=quoteToGrowthOfferPlan(normalizeQuote(candidate.quote),{source:plan.source,benefitVersion:plan.benefitVersion,binding:plan.binding});
    if(actual.rentalTotalCents!==plan.rentalTotalCents || actual.depositCents!==plan.depositCents || actual.depositWaived!==plan.depositWaived)return fail("Growth offer amount is not authoritative");
  }
  let choice:ReturnType<typeof chooseCompleteOffer>;try{choice=chooseCompleteOffer(known.candidates.map(c=>c.plan),asOfUtc);}catch{return fail("Benefit evidence is invalid");}
  if(choice.knowledge!=="KNOWN" || choice.depositCents===null || choice.depositBasis==="UNKNOWN")return fail("Growth or entitlement offer is unavailable");
  const selected=known.candidates.find(c=>c.plan===choice.selected);if(!selected)return fail("Selected offer cannot be recovered");
  const depositPlan=known.candidates.find(c=>c.plan.depositWaived && (c.plan.validUntil==null || Date.parse(c.plan.validUntil)>Date.parse(asOfUtc)))?.plan??choice.selected;
  if(!depositPlan)return fail("Deposit benefit evidence is unavailable");
  // Whole price plan wins; the independent valid waiver only changes deposit and derived payable total.
  const quote=normalizeQuote({...selected.quote,tenantDeposit:yuanAmountObject(BigInt(choice.depositCents))});
  const benefits:PersonalGrowthBenefits={schema:"membership-benefits-v1",effectiveTier:known.effectiveTier,policyTier:known.policyTier,priceSource:choice.priceBasis,depositSource:choice.depositBasis,policyVersion:known.policyVersion};
  const growth={schema:"membership-growth-v2" as const,policyVersion:known.policyVersion,effectiveTier:known.effectiveTier,policyTier:known.policyTier,selectedSource:choice.priceBasis,depositSource:choice.depositBasis,
    entitlementIds:[...known.entitlementIds].sort(),binding,selectedBenefitVersion:choice.selected.benefitVersion,selectedEntitlementId:choice.selected.entitlementId??null,selectedValidUntil:choice.selected.validUntil??null,
    depositBenefitVersion:depositPlan.benefitVersion,depositEntitlementId:depositPlan.entitlementId??null,depositValidUntil:depositPlan.validUntil??null,
    pricePlanDigest:createHash("sha256").update(canonicalize(normalizeQuote(selected.quote))).digest("hex"),depositCents:choice.depositCents};
  return {quote,benefits,growth};
}

/** Shared frozen-v4 consumer for settlement. It never reselects current benefits or recalculates an old order. */
export function frozenPersonalGrowthV4Valid(personal:Record<string,unknown>,expected:{userId:string;ownerUserId:string;accountId:string;listingVersionId:string;ruleReleaseId:string;listingHash:string},depositCents:string):boolean{
  if(personal.schema!=="personal-quote-v4" || Object.hasOwn(personal,"membership") || personal.userId!==expected.userId || personal.ownerUserId!==expected.ownerUserId || personal.accountId!==expected.accountId || personal.listingVersionId!==expected.listingVersionId || personal.listingHash!==expected.listingHash)return false;
  const g=personal.membershipGrowth as Record<string,unknown>|undefined,b=g?.binding as Record<string,unknown>|undefined;
  return !!g && g.schema==="membership-growth-v2" && typeof g.policyVersion==="string" && /^[1-9]\d{0,18}$/.test(g.policyVersion) && tiers.includes(g.effectiveTier as Exclude<GrowthTier,"UNKNOWN">)
    && g.policyTier===(g.effectiveTier==="BLACK_GOLD"?"DIAMOND":g.effectiveTier) && ["GROWTH","FRIEND","PRESTIGE"].includes(String(g.selectedSource)) && ["GROWTH","FRIEND","PRESTIGE"].includes(String(g.depositSource))
    && Array.isArray(g.entitlementIds) && g.entitlementIds.every(id=>typeof id==="string") && typeof g.pricePlanDigest==="string" && /^[a-f0-9]{64}$/.test(g.pricePlanDigest) && g.depositCents===depositCents
    && !!b && b.userId===expected.userId && b.ownerUserId===expected.ownerUserId && b.accountId===expected.accountId && b.listingVersionId===expected.listingVersionId && b.ruleReleaseId===expected.ruleReleaseId && typeof b.quantityDigest==="string" && /^[a-f0-9]{64}$/.test(b.quantityDigest)
    && [g.selectedBenefitVersion,g.depositBenefitVersion].every(v=>typeof v==="string" && v.length>0)
    && [g.selectedEntitlementId,g.depositEntitlementId].every(v=>v===null || typeof v==="string") && [g.selectedValidUntil,g.depositValidUntil].every(v=>v===null || typeof v==="string" && Number.isFinite(Date.parse(v)));
}
