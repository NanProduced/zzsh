import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import type { AppConfig } from "../config/config";
import { readRentalMembership } from "../auth/rental-membership";
import { canonicalize, computeContentHash, normalizeQuote } from "../supply/content-hash";
import { computeDeltaQuote, projectDeltaQuote } from "../supply/pricing";
import { normalizeRentalPricing } from "../supply/delta-rental";
import { parseNonNegativeDecimal, yuanAmountObject } from "../supply/decimal";
import { evaluatePublication, type PublishingAccount, type ListingVersion, type SupplyGateReader } from "../supply/publishing";
import { ensureOnlyFields, invalid, notFound } from "../supply/supply-util";
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
  schema:"personal-quote-v2";fullPayoutPolicyRef:string;fullPayoutPolicyVersion:string;disclosureVersion:string;
};
export type ConfirmationFunding = LegacyConfirmationFunding | V2ConfirmationFunding;
export type ConfirmationFundingReader = (client:PoolClient,account:PublishingAccount,version:ListingVersion)=>Promise<ConfirmationFunding|null>;
export type PersonalConfirmationOptions = {gate:SupplyGateReader;fundingReader?:ConfirmationFundingReader;key?:ConfirmationKey};

export type ControlledFundingListing = Readonly<{runId:string;ownerUserId:string;listingVersionId:string;listingHash:string}>;
const controlledFundingReaders=new WeakSet<ConfirmationFundingReader>();
const CONTROLLED_RUN_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Explicit process-local synthetic authority for the registered settlement test resource only. */
export function createControlledConfirmationFundingReader(input:{config:AppConfig;resourceSet:string;runId:string;allowedListings:ReadonlyMap<string,ControlledFundingListing>}):ConfirmationFundingReader {
  const {config,resourceSet,runId,allowedListings}=input;
  if(config.profile!=="test" || config.provider!=="fake" || !config.testOperationsEnabled || config.database.target!=="local-compose"
    || config.database.targetProfile!=="test" || config.database.host!=="127.0.0.1" || config.database.port!==55432
    || resourceSet!=="trade_settlement" || config.database.name!=="zzsh_test_order_trade_settlement"
    || config.database.user!=="zzsh_order_trade_settlement_r" || !CONTROLLED_RUN_ID.test(runId)) {
    throw new Error("Controlled funding requires the exact test/fake trade_settlement runtime");
  }
  const reader:ConfirmationFundingReader=async(client,account,version)=>{
    const identity=(await client.query<{database:string;role:string}>(`SELECT current_database() AS database,current_user AS role`)).rows[0];
    const allowed=allowedListings.get(account.id);
    if(identity?.database!==config.database.name || identity.role!==config.database.user || !ID.test(account.id) || !ID.test(version.id)
      || !allowed || allowed.runId!==runId || !ID.test(allowed.ownerUserId) || !/^[0-9a-f]{64}$/.test(allowed.listingHash)
      || allowed.ownerUserId!==account.owner_user_id || allowed.listingVersionId!==version.id || allowed.listingHash!==version.content_hash
      || account.current_version_id!==version.id || version.review_state!=="APPROVED" || !version.content_hash || !version.payload) return null;
    const approved=(await client.query<{ok:boolean}>(
      `SELECT EXISTS (
         SELECT 1 FROM zzsh_supply.review_decision d
          WHERE d.version_id=$1 AND d.release_id=$2 AND d.content_hash=$3 AND d.decision='APPROVE'
       ) AS ok`,[version.id,version.rule_release_id,version.content_hash])).rows[0]?.ok;
    const current=(await client.query<{ok:boolean}>(
      `SELECT EXISTS (
         SELECT 1 FROM zzsh_supply.rental_account a JOIN zzsh_supply.listing_version v ON v.account_id=a.id
          WHERE a.id=$1 AND a.owner_user_id=$2 AND a.current_version_id=v.id AND v.id=$3
            AND v.review_state='APPROVED' AND v.content_hash=$4
       ) AS ok`,[account.id,account.owner_user_id,version.id,version.content_hash])).rows[0]?.ok;
    if(!approved || !current) return null;
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
  ensureOnlyFields(body,["accountId","versionId","releaseId"]);
  for(const name of ["accountId","versionId","releaseId"])if(typeof body[name]!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body[name] as string))throw invalid("Invalid confirmation reference",name);
  return {accountId:body.accountId as string,versionId:body.versionId as string,releaseId:body.releaseId as string};
}
const unavailable=(message:string):never=>{throw new SecurityApiError(503,"CONFIRMATION_DEPENDENCY_UNAVAILABLE",message);};

function fullPayoutDeclaration(value:unknown):{schema:"full-payout-declaration-v1";selected:boolean}|null {
  if(value===undefined)return null;
  if(!value || typeof value!=="object" || Array.isArray(value))return unavailable("Owner compensation declaration is unavailable");
  const declaration=value as Record<string,unknown>;
  if(Object.keys(declaration).sort().join(",")!=="schema,selected" || declaration.schema!=="full-payout-declaration-v1" || typeof declaration.selected!=="boolean")return unavailable("Owner compensation declaration is invalid");
  return {schema:"full-payout-declaration-v1",selected:declaration.selected};
}

export async function rebuildPersonalConfirmation(client:PoolClient,context:OrderUserContext,input:ReturnType<typeof confirmationInput>,options:PersonalConfirmationOptions) {
  // This authorization function locks both users in ID order and rechecks session/identity.
  const parties=await assertFreshCreateAuthorization(client,context,input.accountId);
  const game=(await client.query(`SELECT current_release_id,enabled FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`,[parties.gameId])).rows[0];
  const account=(await client.query<PublishingAccount>(`SELECT * FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`,[input.accountId])).rows[0];
  if(!account || account.owner_user_id!==parties.ownerUserId || account.game_id!==parties.gameId || !game?.enabled)throw notFound();
  const version=(await client.query<ListingVersion>(`SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2`,[input.versionId,account.id])).rows[0];
  if(!version || account.current_version_id!==version.id || version.review_state!=="APPROVED" || !version.payload || !version.content_hash)throw notFound();
  if(version.rule_release_id!==input.releaseId || game.current_release_id!==input.releaseId)throw new SecurityApiError(409,"CONFIRMATION_CHANGED","Listing rules changed");
  if(version.payload.accountId!==account.id || version.payload.gameId!==account.game_id || computeContentHash(version.payload)!==version.content_hash)unavailable("Listing snapshot cannot be verified");
  const approved=(await client.query(`SELECT 1 FROM zzsh_supply.review_decision WHERE version_id=$1 AND release_id=$2 AND content_hash=$3 AND decision='APPROVE' LIMIT 1`,[version.id,version.rule_release_id,version.content_hash])).rowCount;
  if(!approved)unavailable("Approved listing evidence cannot be verified");
  const blockers=await evaluatePublication(client,account,version,options.gate);
  if(blockers.includes("OCCUPIED"))throw new SecurityApiError(409,"OCCUPIED","Account is occupied");
  if(blockers.length)unavailable("Listing eligibility is unavailable");
  const membership=await readRentalMembership(client,context.userId);
  if(membership.tier==="UNKNOWN")throw new SecurityApiError(503,"MEMBERSHIP_UNKNOWN","Rental membership is unknown");
  const ownerDeclaration=fullPayoutDeclaration(version.payload.declaration.attributes.full_payout_declaration);
  if(ownerDeclaration && (!options.fundingReader || !isControlledConfirmationFundingReader(options.fundingReader)))unavailable("Controlled full-payout funding source is unavailable");
  const funding=await options.fundingReader?.(client,account,version) ?? null;
  if(!funding || (funding.schema!==undefined && funding.schema!=="personal-quote-v1" && funding.schema!=="personal-quote-v2")
    || typeof funding.version!=="string" || !funding.version.trim() || typeof funding.sourceRef!=="string" || !funding.sourceRef.trim()
    || typeof funding.fullPayoutPolicyRef!=="string" || !funding.fullPayoutPolicyRef.trim()
    || typeof funding.vipWaiver!=="boolean" || typeof funding.svipWaiver!=="boolean")unavailable("Authoritative deposit and compensation rules are unavailable");
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
  const guarantee=await options.gate(client,account);
  if(typeof guarantee.reference!=="string" || !guarantee.reference.trim() || guarantee.occupancy!=="FREE" || !["SATISFIED","NOT_REQUIRED"].includes(guarantee.publisherBail) || (guarantee.publisherBail==="NOT_REQUIRED" && BigInt(f.publisherBailRequirementCents)>0n))unavailable("Account guarantee evidence is unavailable");
  const release=(await client.query(`SELECT p.id,p.status,p.mode,p.haff_rule,p.commission_rate::text,p.rounding_policy,r.term_version_id FROM zzsh_supply.rule_release r JOIN zzsh_supply.price_version p ON p.id=r.price_version_id WHERE r.id=$1 AND r.game_id=$2`,[input.releaseId,account.game_id])).rows[0];
  if(!release || release.status!=="SEALED" || release.id!==version.payload.ruleRefs.priceVersionId)unavailable("Frozen price version unavailable");
  const rows=(await client.query(`SELECT item_id,pricing_kind,unit_quantity::text,buyer_unit_amount::text,owner_unit_amount::text FROM zzsh_supply.price_line WHERE price_version_id=$1 AND customer_tier=$2 ORDER BY item_id`,[release.id,membership.tier])).rows;
  const prices=new Map(rows.map(r=>[r.item_id,r]));
  const original=normalizeQuote(version.payload.quoteValues);
  if(original.lines.some(l=>!prices.has(l.itemId)))unavailable("Required membership price is missing");
  const term=(await client.query(`SELECT code,daily_consumption::text AS "dailyConsumption",duration_rounding AS "durationRounding" FROM zzsh_supply.term_option WHERE version_id=$1 AND code=$2`,[release.term_version_id,version.payload.declaration.termOptionCode])).rows[0];
  if(!term)unavailable("Frozen term unavailable");
  const attrs=version.payload.declaration.attributes;
  const waive=membership.tier==="VIP"?f.vipWaiver:membership.tier==="SVIP"?f.svipWaiver:false;
  const result=computeDeltaQuote({priceVersionId:release.id,mode:release.mode,customerTier:membership.tier,roundingPolicy:release.rounding_policy,haffRule:release.haff_rule,...(release.commission_rate===null?{}:{commissionRate:release.commission_rate}),
    lines:original.lines.map(line=>{const price=prices.get(line.itemId)!;return {itemId:line.itemId,unit:line.unit,quantity:line.quantity,customerTier:membership.tier as Exclude<typeof membership.tier,"UNKNOWN">,pricingKind:price.pricing_kind,...(price.unit_quantity===null?{}:{unitQuantity:price.unit_quantity}),...(price.buyer_unit_amount===null?{}:{buyerUnitAmount:price.buyer_unit_amount}),...(price.owner_unit_amount===null?{}:{ownerUnitAmount:price.owner_unit_amount})};}),
    conditions:{safeBoxCode:attrs.safe_box_code as string,vitLevel:(attrs.vit_level??attrs.vitLevel) as number,bearLevel:(attrs.bear_level??attrs.bearLevel) as number,termOptionCode:term.code,pricingOptionCode:version.payload.declaration.pricingOptionCode,...(attrs.rentalPricing===undefined?{}:{rentalPricing:normalizeRentalPricing(attrs.rentalPricing)})},termOption:term,
    entitlements:original.expiryDisclosures.map(e=>({entitlementId:e.entitlementId,expiryKind:e.expiresAt===null?"PERMANENT":"TIMED",...(e.expiresAt===null?{}:{expiresAt:e.expiresAt})})),
    deposits:{tenantDepositCents:waive?"0":f.baseDepositCents,publisherBailRequirementCents:f.publisherBailRequirementCents},
  });
  if(!result.quotable)unavailable("Membership price cannot be calculated");
  if(!result.quotable)throw new Error("unreachable");
  result.quote.ruleReleaseId=input.releaseId;
  // Explicit ordered fields, normalized quote and frozen refs. Internal evidence goes
  // only into the digest, never into a decodable signed payload or renter projection.
  const quote=normalizeQuote(result.quote);
  const snapshot=ownerDeclaration
    ? {schema:"personal-quote-v2",userId:context.userId,ownerUserId:account.owner_user_id,accountId:account.id,listingVersionId:version.id,listingHash:version.content_hash,
      fullPayoutDeclaration:ownerDeclaration,ruleRefs:version.payload.ruleRefs,membership:{tier:membership.tier,version:membership.version,sourceRef:membership.sourceRef},
      guarantee:{status:guarantee.publisherBail,reference:guarantee.reference},funding:{version:f.version,sourceRef:f.sourceRef,baseDepositCents:f.baseDepositCents,
        publisherBailRequirementCents:f.publisherBailRequirementCents,fullPayoutPolicyRef:v2Funding!.fullPayoutPolicyRef,fullPayoutPolicyVersion:v2Funding!.fullPayoutPolicyVersion,
        disclosureVersion:v2Funding!.disclosureVersion,vipWaiver:f.vipWaiver,svipWaiver:f.svipWaiver},quote}
    : {schema:"personal-quote-v1",listingHash:version.content_hash,userId:context.userId,ruleRefs:version.payload.ruleRefs,membership:{tier:membership.tier,version:membership.version,sourceRef:membership.sourceRef},guarantee:{status:guarantee.publisherBail,reference:guarantee.reference},funding:{version:f.version,sourceRef:f.sourceRef,baseDepositCents:f.baseDepositCents,publisherBailRequirementCents:f.publisherBailRequirementCents,fullPayoutSelected:(f as LegacyConfirmationFunding).fullPayoutSelected,fullPayoutPolicyRef:f.fullPayoutPolicyRef,fullPayoutFeeCents:(f as LegacyConfirmationFunding).fullPayoutFeeCents,vipWaiver:f.vipWaiver,svipWaiver:f.svipWaiver},quote};
  const quoteDigest=createHash("sha256").update(canonicalize(snapshot)).digest("hex");
  const now=Number((await client.query(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now`)).rows[0].now);
  return {snapshot,now,binding:{...input,userId:context.userId,sessionId:context.sessionId,listingHash:version.content_hash,quoteDigest},projection:{quote:projectDeltaQuote(result.quote,"public"),baseTenantDeposit:yuanAmountObject(parseNonNegativeDecimal(f.baseDepositCents,0,"deposit").value),customerTier:membership.tier,depositWaived:waive,
    ...(ownerDeclaration?{compensationDisclosure:{selected:ownerDeclaration.selected,disclosureVersion:v2Funding!.disclosureVersion}}:{})}};
}

export async function issuePersonalConfirmation(client:PoolClient,context:OrderUserContext,input:ReturnType<typeof confirmationInput>,options:PersonalConfirmationOptions) {
  requireConfirmationKey(options.key);
  const rebuilt=await rebuildPersonalConfirmation(client,context,input,options);
  const signed=signConfirmation(rebuilt.binding,rebuilt.now,options.key);
  return {...rebuilt.projection,confirmationId:signed.claims.confirmationId,listingHash:rebuilt.binding.listingHash,expiresAt:new Date(signed.claims.expiresAt*1000).toISOString(),confirmationToken:signed.token};
}
export async function verifyPersonalConfirmation(client:PoolClient,context:OrderUserContext,input:ReturnType<typeof confirmationInput>,token:unknown,options:PersonalConfirmationOptions) {
  const rebuilt=await rebuildPersonalConfirmation(client,context,input,options);
  return {claims:verifyConfirmation(token,rebuilt.binding,rebuilt.now,options.key),snapshot:rebuilt.snapshot};
}
