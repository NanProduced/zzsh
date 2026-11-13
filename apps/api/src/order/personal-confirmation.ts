import { projectTenantPriceQuote } from "../supply/tenant-price-projection";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import type { AppConfig } from "../config/config";
import { readRentalMembership } from "../auth/rental-membership";
import { type GrowthOfferPlan } from "../auth/membership-growth";
import {selectPersonalGrowthOffer,type GrowthConfirmationKnown} from "./personal-growth-confirmation";
import { canonicalize, computeContentHash, normalizeQuote, type ContentPayloadInput } from "../supply/content-hash";
import { computeDeltaQuote, computePublishedFixedFeeQuote, computePublishedSpreadQuote, computeFixedUnitAmounts, projectDeltaQuote, type HaffRatioRule, type InternalQuote, type PublishedQuoteProof, type QuoteInput } from "../supply/pricing";
import { normalizeRentalPricing } from "../supply/delta-rental";
import { decimalToBigInt, divideToScale, formatDecimalExact, parseNonNegativeDecimal, yuanAmountObject } from "../supply/decimal";
import { FIXED_FEE_ALGORITHM, fixedFeeAllowsPayableRatio } from "../supply/fixed-fee";
import { assertFixedFeeTestListingAdmission, readFixedFeeDemoAccounts, type FixedFeeTestListingAdmission } from "../finance/controlled-fixed-fee-resource";
import type { DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import { boundListingPricingPolicy, readBoundListingPrice, SCHEDULED_SPREAD_ORDER_ENABLED } from "../supply/pricing-policy-schedule";
import { payableCentsFor } from "../auth/membership-total-discount";
import { evaluatePricePreviewPublication, readListingPublication, evaluatePublication, type PublishingAccount, type ListingVersion, type SupplyGateReader } from "../supply/publishing";
import { assertFullPayoutTermsAccepted, parseFullPayoutTermsAcceptance, readReleaseAgreement, type FullPayoutTerms } from "../supply/full-payout-terms";
import { assertFinalConfirmationFunding, isProductionConfirmationFundingReader, readProductionConfirmationFundingForPreview } from "../supply/funding-authority";
import { EFFECTIVE_PUBLICATION_STATE_SQL, isEffectivePublicationState } from "../supply/listing-query";
import { ensureOnlyFields, invalid, notFound } from "../supply/supply-util";
import { readLegacyPublishedReference } from "../supply/legacy-published-reference";
import { assertFreshCreateAuthorization, type OrderUserContext } from "./order";
import { requireConfirmationKey, signConfirmation, verifyConfirmation, type ConfirmationKey } from "./confirmation-token";

type ConfirmationFundingBase = {
  version:string;sourceRef:string;baseDepositCents:string;publisherBailRequirementCents:string;
  vipWaiver:boolean;svipWaiver:boolean;
};
export type LegacyConfirmationFunding = ConfirmationFundingBase & {
  schema?:"personal-quote-v1";fullPayoutSelected:boolean;fullPayoutPolicyRef:string;fullPayoutFeeCents:string;
};
export type V2ConfirmationFunding = ConfirmationFundingBase & {
  schema:"personal-quote-v2";fullPayoutPolicyRef:string;fullPayoutPolicyVersion:string;disclosureVersion:string;fullPayoutTerms?:FullPayoutTerms;
};
export type ConfirmationFunding = LegacyConfirmationFunding | V2ConfirmationFunding;
export type ConfirmationFundingReader = (client:PoolClient,account:PublishingAccount,version:ListingVersion)=>Promise<ConfirmationFunding|null>;
export type PersonalConfirmationOptions = {gate:SupplyGateReader;fundingReader?:ConfirmationFundingReader;key?:ConfirmationKey;membershipGrowthReader?:MembershipGrowthConfirmationReader;fixedFeeTestAdmission?:FixedFeeTestListingAdmission;fixedFeeDemo?:DemoFinanceResource};
export type MembershipGrowthQuoteCandidate = { plan: GrowthOfferPlan; quote: InternalQuote; payableRatio?: string };
export type MembershipGrowthConfirmationReader = (client: PoolClient, input: {
  userId: string; ownerUserId: string; accountId: string; gameId: string; listingVersionId: string; listingHash: string;
  ruleReleaseId: string; priceVersionId: string; quantityDigest: string; baseQuote: InternalQuote; quoteInput: QuoteInput;asOfUtc?:string;
  publishedSpreadListing?: PublishedQuoteProof & {listingVersionId:string;ownerUserId:string};
}) => Promise<
  | GrowthConfirmationKnown
  | { knowledge: "UNKNOWN"; reason: string }
>;

export type ControlledFundingListing = Readonly<{runId:string;ownerUserId:string;listingVersionId:string;listingHash:string}>;
const controlledFundingReaders=new WeakSet<ConfirmationFundingReader>();
const CONTROLLED_RUN_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Explicit process-local synthetic authority for the registered isolated test resources only. */
export function createControlledConfirmationFundingReader(input:{config:AppConfig;resourceSet:string;runId:string;allowedListings:ReadonlyMap<string,ControlledFundingListing>}):ConfirmationFundingReader {
  const {config,resourceSet,runId,allowedListings}=input;
  const resource = resourceSet === "trade_settlement"
    ? { database: "zzsh_test_order_trade_settlement", role: "zzsh_order_trade_settlement_r" }
    : resourceSet === "pub_direct"
      ? { database: "zzsh_test_order_pub_direct", role: "zzsh_order_pub_direct_r" }
      : null;
  if(config.profile!=="test" || config.provider!=="fake" || !config.testOperationsEnabled || config.database.target!=="local-compose"
    || config.database.targetProfile!=="test" || config.database.host!=="127.0.0.1" || ![55432,55433].includes(config.database.port)
    || !resource || config.database.name!==resource.database || config.database.user!==resource.role || !CONTROLLED_RUN_ID.test(runId)) {
    throw new Error("Controlled funding requires an exact registered test/fake order runtime");
  }
  const reader:ConfirmationFundingReader=async(client,account,version)=>{
    const identity=(await client.query<{database:string;role:string}>(`SELECT current_database() AS database,current_user AS role`)).rows[0];
    const allowed=allowedListings.get(account.id);
    if(identity?.database!==config.database.name || identity.role!==config.database.user || !ID.test(account.id) || !ID.test(version.id)
      || !allowed || allowed.runId!==runId || !ID.test(allowed.ownerUserId) || !/^[0-9a-f]{64}$/.test(allowed.listingHash)
      || allowed.ownerUserId!==account.owner_user_id || allowed.listingVersionId!==version.id || allowed.listingHash!==version.content_hash
      || account.current_version_id!==version.id || !version.content_hash || !version.payload) return null;
    const publication=(await client.query<{source:string}>(
      `SELECT p.source FROM zzsh_supply.listing_publication p
        WHERE p.version_id=$1 AND p.account_id=$2 AND p.owner_user_id=$3
          AND p.rule_release_id=$4 AND p.content_hash=$5`,[version.id,account.id,account.owner_user_id,version.rule_release_id,version.content_hash])).rows[0];
    if (!isEffectivePublicationState(version.review_state, publication?.source)) return null;
    const current=(await client.query<{ok:boolean}>(
      `SELECT EXISTS (
         SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.account_id=a.id
          JOIN zzsh_supply.listing_publication p ON p.version_id=v.id AND p.account_id=a.id
          WHERE a.id=$1 AND a.owner_user_id=$2 AND a.current_version_id=v.id AND v.id=$3
            AND ${EFFECTIVE_PUBLICATION_STATE_SQL} AND v.content_hash=$4
       ) AS ok`,[account.id,account.owner_user_id,version.id,version.content_hash])).rows[0]?.ok;
    if(!current) return null;
    const declaration=version.payload.declaration.attributes.full_payout_declaration as {schema?:unknown;selected?:unknown}|undefined;
    if(!declaration || declaration.schema!=="full-payout-declaration-v1" || typeof declaration.selected!=="boolean") return null;
    return {
      schema:"personal-quote-v2",version:`fixture:trb3b1:${runId}:funding-v1`,
      sourceRef:`fixture:trb3b1:${runId}:${account.id}:${version.id}`,
      baseDepositCents:"30000",publisherBailRequirementCents:"0",vipWaiver:false,svipWaiver:false,
      fullPayoutPolicyRef:"fixture:trade-baseline-20260921",fullPayoutPolicyVersion:"fixture:trade-baseline-20260921:v1",
      disclosureVersion:"full-payout-disclosure-v1",
    };
  };
  controlledFundingReaders.add(reader);
  return reader;
}

export function isControlledConfirmationFundingReader(reader:ConfirmationFundingReader):boolean {
  return controlledFundingReaders.has(reader);
}
export function confirmationInput(body:Record<string,unknown>) {
  ensureOnlyFields(body,["accountId","versionId","releaseId","fullPayoutTermsAcceptance"]);
  for(const name of ["accountId","versionId","releaseId"])if(typeof body[name]!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body[name] as string))throw invalid("Invalid confirmation reference",name);
  const terms=parseFullPayoutTermsAcceptance(body.fullPayoutTermsAcceptance);
  return {accountId:body.accountId as string,versionId:body.versionId as string,releaseId:body.releaseId as string,...(terms?{fullPayoutTermsAcceptance:terms}:{})};
}
const unavailable=(message:string):never=>{throw new SecurityApiError(503,"CONFIRMATION_DEPENDENCY_UNAVAILABLE",message);};

type FrozenPriceLine = { item_id:string; pricing_kind:"HAFF_RATIO"|"FIXED_UNIT"; unit_quantity:string|null; buyer_unit_amount:string|null; owner_unit_amount:string|null; item_unit?:string|null; item_name?:string|null; item_enabled?:boolean };
/** Captured as part of the signed order confirmation; never reconstructed from the current policy. */
export function freezeSettlementPricing(quote:InternalQuote,payableRatio:string,rows:readonly FrozenPriceLine[],commissionRate?:string|null) {
  if(payableCentsFor(1n,payableRatio)===null)throw new Error("Invalid settlement discount");
  const percent=quote.mode==="PERCENT";
  const fixed=quote.schemaVersion===4;
  const rate=percent&&typeof commissionRate==="string"?parseNonNegativeDecimal(commissionRate,8,"commission rate"):null;
  if(percent&&(!rate||rate.value>=10n**BigInt(rate.scale)))throw new Error("Missing frozen commission rate");
  if(fixed){
    normalizeQuote(quote);
    if(!rate||quote.pricingInputs.commissionRate!==formatDecimalExact(rate)||!fixedFeeAllowsPayableRatio(commissionRate!,payableRatio))throw new Error("Fixed fee policy does not match the quote");
  }
  const haff=quote.lines.filter(line=>line.pricingKind==="HAFF_RATIO");
  const exact=haff.length===1?quote.pricingInputs.exactRatios.find(line=>line.itemId===haff[0]!.itemId):undefined;
  if(!exact || haff[0]!.quantity==="0")throw new Error("Missing frozen haff price");
  const material=new Map<string,{itemId:string;name:string|null;unit:"ROUND"|"PIECE"|"DAY";unitQuantity:string;buyerUnitAmount:string;ownerUnitAmount:string}>();
  const add=(itemId:string,name:unknown,unit:unknown,unitQuantity:unknown,buyer:unknown,owner:unknown)=>{
    if(!ID.test(itemId)||!["ROUND","PIECE","DAY"].includes(String(unit))||typeof unitQuantity!=="string"||typeof buyer!=="string"||typeof owner!=="string")throw new Error("Missing frozen item price");
    if(typeof name==="string"&&name.trim().length>120)throw new Error("Invalid frozen item name");
    const quantity=parseNonNegativeDecimal(unitQuantity,0,"unit quantity"),b=parseNonNegativeDecimal(buyer,8,"buyer unit"),o=parseNonNegativeDecimal(owner,percent?16:8,"owner unit");
    if(quantity.value<=0n||decimalToBigInt(o,16)>decimalToBigInt(b,16))throw new Error("Invalid frozen item price");
    material.set(itemId,{itemId,name:typeof name==="string"&&name.trim()?name.trim():null,unit:unit as "ROUND"|"PIECE"|"DAY",unitQuantity:quantity.value.toString(),buyerUnitAmount:formatDecimalExact(b),ownerUnitAmount:formatDecimalExact(o)});
  };
  for(const row of rows){
    if(row.pricing_kind!=="FIXED_UNIT")continue;
    const line=quote.lines.find(item=>item.itemId===row.item_id);
    if(row.item_enabled===false&&!line)continue;
    if(material.has(row.item_id))throw new Error("Duplicate frozen item price");
    let owner:unknown=line?.ownerUnitAmount.amount??row.owner_unit_amount;
    if(fixed){
      if(row.unit_quantity===null||row.buyer_unit_amount===null||row.owner_unit_amount!==null)throw new Error("Missing frozen fixed-fee item price");
      owner=row.buyer_unit_amount;
      if(line&&(decimalToBigInt(parseNonNegativeDecimal(line.buyerUnitAmount.amount,8,"quoted buyer unit"),8)!==decimalToBigInt(parseNonNegativeDecimal(row.buyer_unit_amount,8,"frozen buyer unit"),8)
        ||decimalToBigInt(parseNonNegativeDecimal(line.ownerUnitAmount.amount,8,"quoted owner unit"),8)!==decimalToBigInt(parseNonNegativeDecimal(row.buyer_unit_amount,8,"frozen buyer unit"),8)))throw new Error("Frozen fixed-fee item price mismatch");
    } else if(percent){
      if(!rate||row.unit_quantity===null||row.buyer_unit_amount===null||row.owner_unit_amount!==null)throw new Error("Missing frozen percent item price");
      const calculated=computeFixedUnitAmounts({itemId:row.item_id,pricingKind:"FIXED_UNIT",quantity:"0",unitQuantity:row.unit_quantity,buyerUnitAmount:row.buyer_unit_amount},"PERCENT",rate);
      owner=formatDecimalExact(calculated.ownerUnit);
      if(line&&decimalToBigInt(parseNonNegativeDecimal(line.ownerUnitAmount.amount,8,"quoted owner unit"),8)!==divideToScale(calculated.ownerUnit,{value:1n,scale:0},8).value)throw new Error("Frozen owner price mismatch");
    }
    add(row.item_id,row.item_name,line?.unit??row.item_unit,line?.unitQuantity??row.unit_quantity,line?.buyerUnitAmount.amount??row.buyer_unit_amount,owner);
  }
  for(const line of quote.lines)if(line.pricingKind==="FIXED_UNIT"&&!material.has(line.itemId)){
    if(percent)throw new Error("Missing frozen percent item price");
    add(line.itemId,null,line.unit,line.unitQuantity,line.buyerUnitAmount.amount,line.ownerUnitAmount.amount);
  }
  if(material.size>63)throw new Error("Too many settlement resources");
  return {schema:fixed?"settlement-pricing-v3" as const:percent?"settlement-pricing-v2" as const:"settlement-pricing-v1" as const,
    ...(fixed?{fixedFeeRate:formatDecimalExact(rate!)}:{}),priceVersionId:quote.priceVersionId,payableRatio:formatDecimalExact(parseNonNegativeDecimal(payableRatio,8,"payable ratio")),
    haff:{itemId:haff[0]!.itemId,openingQuantity:haff[0]!.quantity,buyerNumerator:exact.buyerNumerator,buyerDenominator:exact.buyerDenominator},
    items:[...material.values()].sort((a,b)=>a.itemId<b.itemId?-1:a.itemId>b.itemId?1:0)};
}

function fullPayoutDeclaration(value:unknown):{schema:"full-payout-declaration-v1";selected:boolean}|null {
  if(value===undefined)return null;
  if(!value || typeof value!=="object" || Array.isArray(value))return unavailable("Owner compensation declaration is unavailable");
  const declaration=value as Record<string,unknown>;
  if(Object.keys(declaration).sort().join(",")!=="schema,selected" || declaration.schema!=="full-payout-declaration-v1" || typeof declaration.selected!=="boolean")return unavailable("Owner compensation declaration is invalid");
  return {schema:"full-payout-declaration-v1",selected:declaration.selected};
}

async function calculateBoundPersonalPrice(client:PoolClient,context:OrderUserContext,input:ReturnType<typeof confirmationInput>,options:PersonalConfirmationOptions,account:PublishingAccount,game:{current_release_id:string|null;enabled:boolean},purpose:"READ"|"WRITE",readAsOfUtc?:string) {
  if (!game.enabled) throw notFound();
  const version=(await client.query<ListingVersion>(`SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2`,[input.versionId,account.id])).rows[0];
  if(!version || !version.payload || !version.content_hash)throw notFound();
  if(account.current_version_id!==version.id) { if(purpose === "READ") throw new SecurityApiError(409,"CONFIRMATION_CHANGED","Listing version changed"); throw notFound(); }
  if(version.rule_release_id!==input.releaseId)throw new SecurityApiError(409,"CONFIRMATION_CHANGED","Listing rules changed");
  if(version.payload.accountId!==account.id || version.payload.gameId!==account.game_id || computeContentHash(version.payload)!==version.content_hash)unavailable("Listing snapshot cannot be verified");
  const legacy = version.payload.schemaVersion === 3;
  const fixedFee = version.payload.schemaVersion === 4;
  if (fixedFee && purpose === "WRITE") {
    if (options.fixedFeeDemo) {
      if (!(await readFixedFeeDemoAccounts(client, options.fixedFeeDemo, [account.id], "WRITE")).has(account.id))
        unavailable("Fixed fee demo order creation is not enabled for this account");
    } else {
      if (!options.fixedFeeTestAdmission) unavailable("Fixed fee order creation is not enabled");
      await assertFixedFeeTestListingAdmission(client, options.fixedFeeTestAdmission!, { role: "RENTER", actorId: context.userId,
        ownerUserId: account.owner_user_id, accountId: account.id, listingVersionId: version.id, listingHash: version.content_hash });
    }
  }
  if (fixedFee && !options.membershipGrowthReader) unavailable("Fixed fee confirmation requires the current membership policy");
  if (legacy) {
    const source = version.payload.legacyQuote, marker = version.payload.declaration.attributes.legacy_published_reference;
    const reference = typeof marker === "string" ? await readLegacyPublishedReference(client, account.id, marker) : null;
    if (version.payload.quoteSource !== "LEGACY_QUOTED" || source?.sourceSystem !== "legacy_mysql_restore" || source.sourceEntity !== "la_rental_accounts"
      || !reference || reference.legacyId !== source.legacyId || reference.observationVersionId !== source.observationVersionId || reference.sourceDigest !== source.sourceDigest)
      unavailable("Legacy listing source cannot be verified");
    if (!options.membershipGrowthReader) throw new SecurityApiError(503,"MEMBERSHIP_UNKNOWN","Membership growth is unavailable");
  }
  const publication = await readListingPublication(client, account, version);
  if (!isEffectivePublicationState(version.review_state, publication?.source)) {
    if (purpose === "READ") throw notFound();
    unavailable("Listing publication evidence cannot be verified");
  }
  const blockers=purpose === "READ" ? await evaluatePricePreviewPublication(client,account,version,options.gate) : await evaluatePublication(client,account,version,options.gate);
  if(blockers.includes("LEGACY_LISTING_RELIST_REQUIRED"))throw new SecurityApiError(409,"CONFIRMATION_CHANGED","旧账号已下架，请号主重新填写资料上架");
  if(blockers.includes("OCCUPIED"))throw new SecurityApiError(409,"OCCUPIED","Account is occupied");
  if(purpose === "READ" && blockers.includes("RULE_CHANGED")) throw new SecurityApiError(409,"CONFIRMATION_CHANGED","Listing rules changed");
  if(blockers.length)unavailable("Listing eligibility is unavailable");
  const membership=options.membershipGrowthReader?null:await readRentalMembership(client,context.userId);
  if(membership?.tier==="UNKNOWN")throw new SecurityApiError(503,"MEMBERSHIP_UNKNOWN","Rental membership is unknown");
  // STANDARD is only the sealed release's calculation baseline, never a synthetic user membership.
  const calculationTier=membership?.tier??"STANDARD";
  const ownerDeclaration=fullPayoutDeclaration(version.payload.declaration.attributes.full_payout_declaration);
  if(options.membershipGrowthReader && !ownerDeclaration)unavailable("Growth confirmation requires a versioned listing declaration");
  if(ownerDeclaration && (!options.fundingReader || (!isControlledConfirmationFundingReader(options.fundingReader) && !isProductionConfirmationFundingReader(options.fundingReader))))unavailable("Authoritative full-payout funding source is unavailable");
  const funding=purpose === "READ"
    ? options.fundingReader && isControlledConfirmationFundingReader(options.fundingReader) ? await options.fundingReader(client,account,version) : await readProductionConfirmationFundingForPreview(client,account,version,options.fundingReader,readAsOfUtc!)
    : await options.fundingReader?.(client,account,version) ?? null;
  if(!funding || (funding.schema!==undefined && funding.schema!=="personal-quote-v1" && funding.schema!=="personal-quote-v2")
    || typeof funding.version!=="string" || !funding.version.trim() || typeof funding.sourceRef!=="string" || !funding.sourceRef.trim()
    || typeof funding.fullPayoutPolicyRef!=="string" || !funding.fullPayoutPolicyRef.trim()
    || membership!==null && (typeof funding.vipWaiver!=="boolean" || typeof funding.svipWaiver!=="boolean"))unavailable("Authoritative deposit and compensation rules are unavailable");
  const f=funding!;
  for(const value of [f.baseDepositCents,f.publisherBailRequirementCents])if(typeof value!=="string" || !/^(0|[1-9]\d{0,17})$/.test(value))unavailable("Authoritative funding amount is unavailable");
  const v2Funding=ownerDeclaration && f.schema==="personal-quote-v2" ? f : null;
  if(ownerDeclaration) {
    if(!v2Funding || typeof v2Funding.fullPayoutPolicyVersion!=="string" || !v2Funding.fullPayoutPolicyVersion.trim()
      || typeof v2Funding.disclosureVersion!=="string" || !v2Funding.disclosureVersion.trim()
      || Object.hasOwn(v2Funding,"fullPayoutSelected") || Object.hasOwn(v2Funding,"fullPayoutFeeCents"))unavailable("Versioned compensation policy is unavailable");
  } else {
    if(f.schema==="personal-quote-v2" || typeof f.fullPayoutSelected!=="boolean" || typeof f.fullPayoutFeeCents!=="string"
      || f.fullPayoutSelected || f.fullPayoutFeeCents!=="0")unavailable("Legacy funding basis is unknown or contradictory");
  }
  if(ownerDeclaration?.selected){
    if(!v2Funding?.fullPayoutTerms)unavailable("Full-payout terms body is unavailable");
    if(purpose === "WRITE") assertFullPayoutTermsAccepted(v2Funding!.fullPayoutTerms!,input.fullPayoutTermsAcceptance);
  }else if(purpose === "WRITE" && input.fullPayoutTermsAcceptance!==undefined)throw invalid("Full-payout terms do not apply to this quote","fullPayoutTermsAcceptance");
  const guarantee=await options.gate(client,account,purpose);
  if(typeof guarantee.reference!=="string" || !guarantee.reference.trim() || guarantee.occupancy!=="FREE" || !["SATISFIED","NOT_REQUIRED"].includes(guarantee.publisherBail) || (guarantee.publisherBail==="NOT_REQUIRED" && BigInt(f.publisherBailRequirementCents)>0n))unavailable("Account guarantee evidence is unavailable");
  const creditGuarantee=guarantee.creditGuarantee;
  if (creditGuarantee) {
    const expectedStatus = creditGuarantee.status === "NOT_REQUIRED" ? "NOT_REQUIRED" : creditGuarantee.status === "SATISFIED" ? "SATISFIED" : "UNKNOWN";
    if (expectedStatus !== guarantee.publisherBail || creditGuarantee.accountId !== account.id || creditGuarantee.ownerUserId !== account.owner_user_id
      || creditGuarantee.gameId !== account.game_id || creditGuarantee.listingVersionId !== version.id
      || creditGuarantee.priceVersionId !== version.payload.ruleRefs.priceVersionId || creditGuarantee.releaseId !== version.rule_release_id
      || creditGuarantee.reference !== guarantee.reference || creditGuarantee.requiredCents !== f.publisherBailRequirementCents) {
      unavailable("Credit and guarantee authority changed; confirm again");
    }
  }
  const originalRelease=(await client.query(`SELECT p.id,p.status,p.mode,p.haff_rule,p.commission_rate::text,p.rounding_policy,r.term_version_id FROM zzsh_supply.rule_release r JOIN zzsh_supply.price_version p ON p.id=r.price_version_id WHERE r.id=$1 AND r.game_id=$2`,[input.releaseId,account.game_id])).rows[0];
  if(!originalRelease || originalRelease.status!=="SEALED" || originalRelease.id!==version.payload.ruleRefs.priceVersionId)unavailable("Frozen price version unavailable");
  const attrs=version.payload.declaration.attributes;
  const original=normalizeQuote(version.payload.quoteValues);
  let asOfUtc=readAsOfUtc;
  let pricingPolicy: ContentPayloadInput["pricingPolicy"];
  let publishedSpreadListing: (PublishedQuoteProof & {listingVersionId:string;ownerUserId:string}) | undefined;
  let release=originalRelease;
  if (fixedFee || version.payload.pricingPolicy) {
    if (publication?.source !== "OWNER_DIRECT") return unavailable("Published pricing policy is unavailable");
    pricingPolicy = boundListingPricingPolicy(version.payload, publication.publishedAtExact ?? publication.published_at) ??
      unavailable("Published pricing policy is unavailable");
    if (!fixedFee && !SCHEDULED_SPREAD_ORDER_ENABLED && purpose === "WRITE") unavailable("Scheduled spread settlement contract is not enabled");
    if (!options.membershipGrowthReader || !ownerDeclaration) unavailable("Published pricing requires the current membership policy");
    const rentalMode = normalizeRentalPricing(attrs.rentalPricing).rentalMode;
    const frozen = await readBoundListingPrice(client, account.game_id, pricingPolicy, rentalMode);
    if (!frozen) return unavailable("Published price version is unavailable");
    release = { ...originalRelease, id: frozen.id, mode: frozen.mode, haff_rule: frozen.haffRule as HaffRatioRule,
      commission_rate: frozen.commissionRate, rounding_policy: frozen.roundingPolicy };
    if (!fixedFee) publishedSpreadListing = { accountId:account.id,gameId:account.game_id,contentHash:version.content_hash,
      payload:version.payload,listingVersionId:version.id,ownerUserId:account.owner_user_id };
  } else if (!legacy && original.priceVersionId !== originalRelease.id) {
    unavailable("Published price version is unavailable");
  }
  const rows=(await client.query<FrozenPriceLine>(`SELECT p.item_id,p.pricing_kind,p.unit_quantity::text,p.buyer_unit_amount::text,p.owner_unit_amount::text,
    i.unit AS item_unit,i.name AS item_name,i.enabled AS item_enabled FROM zzsh_supply.price_line p JOIN zzsh_supply.billable_item i ON i.id=p.item_id
    WHERE p.price_version_id=$1 AND p.customer_tier=$2 AND i.game_id=$3 ORDER BY p.item_id`,[release.id,calculationTier,account.game_id])).rows;
  const prices=new Map(rows.map(r=>[r.item_id,r]));
  if(!legacy && original.lines.some(l=>!prices.has(l.itemId)))unavailable("Required membership price is missing");
  const term=(await client.query(`SELECT code,daily_consumption::text AS "dailyConsumption",duration_rounding AS "durationRounding" FROM zzsh_supply.term_option WHERE version_id=$1 AND code=$2`,[release.term_version_id,version.payload.declaration.termOptionCode])).rows[0];
  if(!term)unavailable("Frozen term unavailable");
  const waive=membership?.tier==="VIP"?f.vipWaiver:membership?.tier==="SVIP"?f.svipWaiver:false;
  const quoteInput: QuoteInput = { priceVersionId: release.id, mode: release.mode, customerTier: calculationTier, roundingPolicy: release.rounding_policy, haffRule: release.haff_rule, ...(release.commission_rate===null?{}:{commissionRate:release.commission_rate}), ...(fixedFee?{fixedFeeAlgorithm:FIXED_FEE_ALGORITHM}:{}),
    lines:original.lines.map(line=>{if(legacy)return {itemId:line.itemId,unit:line.unit,quantity:line.quantity,customerTier:calculationTier,pricingKind:line.pricingKind,unitQuantity:line.unitQuantity,buyerUnitAmount:line.buyerUnitAmount.amount,ownerUnitAmount:line.ownerUnitAmount.amount};const price=prices.get(line.itemId)!;return {itemId:line.itemId,unit:line.unit,quantity:line.quantity,customerTier:calculationTier,pricingKind:price.pricing_kind,...(price.unit_quantity===null?{}:{unitQuantity:price.unit_quantity}),...(price.buyer_unit_amount===null?{}:{buyerUnitAmount:price.buyer_unit_amount}),...(price.owner_unit_amount===null?{}:{ownerUnitAmount:price.owner_unit_amount})};}),
    conditions:{safeBoxCode:attrs.safe_box_code as string,vitLevel:(attrs.vit_level??attrs.vitLevel) as number,bearLevel:(attrs.bear_level??attrs.bearLevel) as number,termOptionCode:term.code,pricingOptionCode:version.payload.declaration.pricingOptionCode,...(attrs.rentalPricing===undefined?{}:{rentalPricing:normalizeRentalPricing(attrs.rentalPricing)})},termOption:term,
    entitlements:original.expiryDisclosures.map(e=>({entitlementId:e.entitlementId,expiryKind:e.expiresAt===null?"PERMANENT":"TIMED",...(e.expiresAt===null?{}:{expiresAt:e.expiresAt})})),
    deposits:{tenantDepositCents:waive?"0":f.baseDepositCents,publisherBailRequirementCents:f.publisherBailRequirementCents},
  };
  const result=legacy?{quotable:true as const,quote:original}:fixedFee
    ?computePublishedFixedFeeQuote(quoteInput,{accountId:account.id,gameId:account.game_id,contentHash:version.content_hash,payload:version.payload})
    :publishedSpreadListing?computePublishedSpreadQuote(quoteInput,publishedSpreadListing):computeDeltaQuote(quoteInput);
  if(!result.quotable)unavailable("Membership price cannot be calculated");
  if(!result.quotable)throw new Error("unreachable");
  const binding = {
    userId: context.userId,
    accountId: account.id,
    ownerUserId: account.owner_user_id,
    listingVersionId: version.id,
    ruleReleaseId: input.releaseId,
    quantityDigest: createHash("sha256").update(canonicalize(original.lines)).digest("hex"),
  };
  let selectedQuote = result.quote;
  let growthSelection:ReturnType<typeof selectPersonalGrowthOffer>|null=null;
  if (options.membershipGrowthReader) {
    asOfUtc ??= (await client.query<{at:string}>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]?.at??unavailable("Growth confirmation clock is unavailable");
    const growth = await options.membershipGrowthReader(client, {
      userId: context.userId, ownerUserId: account.owner_user_id, accountId: account.id, gameId: account.game_id,
      listingVersionId: version.id, listingHash: version.content_hash, ruleReleaseId: input.releaseId, priceVersionId: release.id,
      quantityDigest: binding.quantityDigest, baseQuote: result.quote, quoteInput,asOfUtc,...(publishedSpreadListing?{publishedSpreadListing}:{}),
    });
    if (growth.knowledge === "UNKNOWN") throw new SecurityApiError(503, "MEMBERSHIP_UNKNOWN", "Membership growth is unknown; confirm later");
    growthSelection=selectPersonalGrowthOffer(growth,binding,asOfUtc,result.quote,publishedSpreadListing?"STABLE":undefined);
    selectedQuote=growthSelection.quote;
  }
  selectedQuote.ruleReleaseId=input.releaseId;
  // Explicit ordered fields, normalized quote and frozen refs. Internal evidence goes
  // only into the digest, never into a decodable signed payload or renter projection.
  const quote=normalizeQuote(selectedQuote);
  // The personal-order contract has five refs; catalogRevision stays bound by listingHash.
  const {releaseId,priceVersionId,termVersionId,agreementVersionId,agreementDigest}=version.payload.ruleRefs;
  const ruleRefs={releaseId,priceVersionId,termVersionId,agreementVersionId,agreementDigest};
  if(Object.values(ruleRefs).some(value=>typeof value!=="string" || !value.trim())
    || !/^[0-9a-f]{64}$/.test(agreementDigest) || releaseId!==input.releaseId
    || priceVersionId!==originalRelease.id || termVersionId!==originalRelease.term_version_id)unavailable("Personal rule references cannot be verified");

  const projection={quote:projectTenantPriceQuote(quote,original),baseTenantDeposit:yuanAmountObject(parseNonNegativeDecimal(f.baseDepositCents,0,"deposit").value),...(growthSelection?{membershipBenefits:growthSelection.benefits}:{customerTier:membership!.tier}),depositWaived:quote.tenantDeposit?.amount === "0.00",
    ...(ownerDeclaration?{compensationDisclosure:{selected:ownerDeclaration.selected,disclosureVersion:v2Funding!.disclosureVersion,...(v2Funding!.fullPayoutTerms?{terms:v2Funding!.fullPayoutTerms}:{})}}:{})};
  let settlementPricing:ReturnType<typeof freezeSettlementPricing>|undefined;
  const settlementRatio=growthSelection===null?"1":growthSelection.payableRatio;
  if(settlementRatio!==undefined){
    try{settlementPricing=freezeSettlementPricing(result.quote,settlementRatio,rows,release.commission_rate);}catch{unavailable("Frozen settlement pricing is unavailable");}
  }
  if(publishedSpreadListing&&!settlementPricing)unavailable("Scheduled spread settlement pricing is unavailable");
  return {account,version:{...version,payload:version.payload!,content_hash:version.content_hash!},membership,ownerDeclaration,v2Funding,f,guarantee,growthSelection,settlementPricing,quote,ruleRefs,binding,projection,pricingPolicy};
}

/** A price view, not a confirmation: no lock wrapper, agreement acceptance, digest credential or signing. */
export async function readPersonalPriceProjection(client:PoolClient,context:OrderUserContext,input:Pick<ReturnType<typeof confirmationInput>,"accountId"|"versionId"|"releaseId">,options:PersonalConfirmationOptions,prepared:{account:PublishingAccount;game:{current_release_id:string|null;enabled:boolean};asOfUtc:string}) {
  const priced=await calculateBoundPersonalPrice(client,context,input,options,prepared.account,prepared.game,"READ",prepared.asOfUtc);
  return {listingHash:priced.version.content_hash,projection:priced.projection};
}

export async function rebuildPersonalConfirmation(client:PoolClient,context:OrderUserContext,input:ReturnType<typeof confirmationInput>,options:PersonalConfirmationOptions) {
  // This authorization function locks both users in ID order and rechecks session/identity.
  const parties=await assertFreshCreateAuthorization(client,context,input.accountId);
  const game=(await client.query(`SELECT current_release_id,enabled FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`,[parties.gameId])).rows[0];
  const account=(await client.query<PublishingAccount>(`SELECT * FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`,[input.accountId])).rows[0];
  if(!account || account.owner_user_id!==parties.ownerUserId || account.game_id!==parties.gameId || !game?.enabled)throw notFound();

  const {version,membership,ownerDeclaration,v2Funding,f,guarantee,growthSelection,settlementPricing,quote,ruleRefs,binding,projection,pricingPolicy}=await calculateBoundPersonalPrice(client,context,input,options,account,game,"WRITE");
  const guaranteeSnapshot = { status: guarantee.publisherBail, reference: guarantee.reference };
  const baseSnapshot=ownerDeclaration
    ? {schema:"personal-quote-v2" as const,userId:context.userId,ownerUserId:account.owner_user_id,accountId:account.id,listingVersionId:version.id,listingHash:version.content_hash,
      fullPayoutDeclaration:ownerDeclaration,ruleRefs,...(membership?{membership:{tier:membership.tier,version:membership.version,sourceRef:membership.sourceRef}}:{}),
      guarantee:guaranteeSnapshot,funding:{version:f.version,sourceRef:f.sourceRef,baseDepositCents:f.baseDepositCents,
        publisherBailRequirementCents:f.publisherBailRequirementCents,fullPayoutPolicyRef:v2Funding!.fullPayoutPolicyRef,fullPayoutPolicyVersion:v2Funding!.fullPayoutPolicyVersion,
        disclosureVersion:v2Funding!.disclosureVersion,vipWaiver:f.vipWaiver,svipWaiver:f.svipWaiver},quote}
    : {schema:"personal-quote-v1" as const,listingHash:version.content_hash,userId:context.userId,ruleRefs:version.payload.ruleRefs,membership:{tier:membership!.tier,version:membership!.version,sourceRef:membership!.sourceRef},guarantee:guaranteeSnapshot,funding:{version:f.version,sourceRef:f.sourceRef,baseDepositCents:f.baseDepositCents,publisherBailRequirementCents:f.publisherBailRequirementCents,fullPayoutSelected:(f as LegacyConfirmationFunding).fullPayoutSelected,fullPayoutPolicyRef:f.fullPayoutPolicyRef,fullPayoutFeeCents:(f as LegacyConfirmationFunding).fullPayoutFeeCents,vipWaiver:f.vipWaiver,svipWaiver:f.svipWaiver},quote};
  const snapshot=growthSelection ? {schema:pricingPolicy?.pricingModel==="FIXED_FEE"?"personal-quote-v5" as const:pricingPolicy?.pricingModel==="SPREAD"?"personal-quote-v6" as const:"personal-quote-v4" as const,userId:context.userId,ownerUserId:account.owner_user_id,accountId:account.id,listingVersionId:version.id,listingHash:version.content_hash,fullPayoutDeclaration:ownerDeclaration!,ruleRefs,membershipGrowth:growthSelection.growth,guarantee:guaranteeSnapshot,
    ...(pricingPolicy?{pricingPolicy}:{}),
    funding:{version:f.version,sourceRef:f.sourceRef,baseDepositCents:f.baseDepositCents,publisherBailRequirementCents:f.publisherBailRequirementCents,fullPayoutPolicyRef:v2Funding!.fullPayoutPolicyRef,fullPayoutPolicyVersion:v2Funding!.fullPayoutPolicyVersion,disclosureVersion:v2Funding!.disclosureVersion},quote,...(settlementPricing?{settlementPricing}:{})} : {...baseSnapshot,...(settlementPricing?{settlementPricing}:{})};
  const quoteDigest=createHash("sha256").update(canonicalize(snapshot)).digest("hex");
  const now=Number((await client.query(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now`)).rows[0].now);
  return {snapshot,gameId:account.game_id,now,binding:{...input,userId:context.userId,sessionId:context.sessionId,listingHash:version.content_hash,quoteDigest},projection};

}

export async function issuePersonalConfirmation(client:PoolClient,context:OrderUserContext,input:ReturnType<typeof confirmationInput>,options:PersonalConfirmationOptions) {
  requireConfirmationKey(options.key);
  const rebuilt=await rebuildPersonalConfirmation(client,context,input,options);
  const signed=signConfirmation(rebuilt.binding,rebuilt.now,options.key);
  const snapshot=rebuilt.snapshot;
  if (snapshot.schema !== "personal-quote-v1" && snapshot.accountId && snapshot.ownerUserId) {
    await assertFinalConfirmationFunding(client,{accountId:snapshot.accountId,ownerUserId:snapshot.ownerUserId,
      priceVersionId:snapshot.ruleRefs.priceVersionId,releaseId:snapshot.ruleRefs.releaseId,policyVersion:snapshot.funding.version,
      reference:snapshot.guarantee.reference,status:snapshot.guarantee.status},options.fundingReader);
  }
  const agreement = await readReleaseAgreement(client, rebuilt.gameId, snapshot.ruleRefs.releaseId);
  if (!agreement || agreement.id !== snapshot.ruleRefs.agreementVersionId || agreement.digest !== snapshot.ruleRefs.agreementDigest) unavailable("Frozen rental agreement cannot be verified");
  return {...rebuilt.projection,agreement,agreementAcceptance:{versionId:snapshot.ruleRefs.agreementVersionId,digest:snapshot.ruleRefs.agreementDigest},confirmationId:signed.claims.confirmationId,listingHash:rebuilt.binding.listingHash,expiresAt:new Date(signed.claims.expiresAt*1000).toISOString(),confirmationToken:signed.token};
}
export async function verifyPersonalConfirmation(client:PoolClient,context:OrderUserContext,input:ReturnType<typeof confirmationInput>,token:unknown,options:PersonalConfirmationOptions) {
  const rebuilt=await rebuildPersonalConfirmation(client,context,input,options);
  return {claims:verifyConfirmation(token,rebuilt.binding,rebuilt.now,options.key),snapshot:rebuilt.snapshot};
}
