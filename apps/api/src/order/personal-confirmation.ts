import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { readRentalMembership } from "../auth/rental-membership";
import { canonicalize, computeContentHash, normalizeQuote } from "../supply/content-hash";
import { computeDeltaQuote, projectDeltaQuote } from "../supply/pricing";
import { normalizeRentalPricing } from "../supply/delta-rental";
import { parseNonNegativeDecimal, yuanAmountObject } from "../supply/decimal";
import { evaluatePublication, type PublishingAccount, type ListingVersion, type SupplyGateReader } from "../supply/publishing";
import { ensureOnlyFields, invalid, notFound } from "../supply/supply-util";
import { assertFreshCreateAuthorization, type OrderUserContext } from "./order";
import { requireConfirmationKey, signConfirmation, verifyConfirmation, type ConfirmationKey } from "./confirmation-token";

// Production has no authoritative deposit/declaration integration yet. Only an
// explicitly test/fake constructor may provide this complete synthetic source.
export type ConfirmationFunding = {
  version:string;sourceRef:string;baseDepositCents:string;publisherBailRequirementCents:string;
  fullPayoutSelected:boolean;fullPayoutPolicyRef:string;fullPayoutFeeCents:string;
  vipWaiver:boolean;svipWaiver:boolean;
};
export type ConfirmationFundingReader = (client:PoolClient,account:PublishingAccount,version:ListingVersion)=>Promise<ConfirmationFunding|null>;
export type PersonalConfirmationOptions = {gate:SupplyGateReader;fundingReader?:ConfirmationFundingReader;key?:ConfirmationKey};
export function confirmationInput(body:Record<string,unknown>) {
  ensureOnlyFields(body,["accountId","versionId","releaseId"]);
  for(const name of ["accountId","versionId","releaseId"])if(typeof body[name]!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body[name] as string))throw invalid("Invalid confirmation reference",name);
  return {accountId:body.accountId as string,versionId:body.versionId as string,releaseId:body.releaseId as string};
}
const unavailable=(message:string):never=>{throw new SecurityApiError(503,"CONFIRMATION_DEPENDENCY_UNAVAILABLE",message);};

export async function rebuildPersonalConfirmation(client:PoolClient,context:OrderUserContext,input:ReturnType<typeof confirmationInput>,options:PersonalConfirmationOptions) {
  // This authorization function locks both users in ID order and rechecks session/identity.
  const parties=await assertFreshCreateAuthorization(client,context,input.accountId);
  const game=(await client.query(`SELECT current_release_id,enabled FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`,[parties.gameId])).rows[0];
  const account=(await client.query<PublishingAccount>(`SELECT * FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`,[input.accountId])).rows[0];
  if(!account || account.owner_user_id!==parties.ownerUserId || account.game_id!==parties.gameId || !game?.enabled)throw notFound();
  const version=(await client.query<ListingVersion>(`SELECT * FROM zzsh_supply.listing_version WHERE id=$1 AND account_id=$2`,[input.versionId,account.id])).rows[0];
  if(!version || account.current_version_id!==version.id || version.review_state!=="APPROVED" || !version.payload || !version.content_hash)throw notFound();
  if(version.rule_release_id!==input.releaseId || game.current_release_id!==input.releaseId)throw new SecurityApiError(409,"CONFIRMATION_CHANGED","Listing rules changed");
  if(computeContentHash(version.payload)!==version.content_hash)unavailable("Listing snapshot cannot be verified");
  const blockers=await evaluatePublication(client,account,version,options.gate);
  if(blockers.includes("OCCUPIED"))throw new SecurityApiError(409,"OCCUPIED","Account is occupied");
  if(blockers.length)unavailable("Listing eligibility is unavailable");
  const membership=await readRentalMembership(client,context.userId);
  if(membership.tier==="UNKNOWN")throw new SecurityApiError(503,"MEMBERSHIP_UNKNOWN","Rental membership is unknown");
  const funding=await options.fundingReader?.(client,account,version) ?? null;
  if(!funding || typeof funding.version!=="string" || !funding.version.trim() || typeof funding.sourceRef!=="string" || !funding.sourceRef.trim() || typeof funding.fullPayoutPolicyRef!=="string" || !funding.fullPayoutPolicyRef.trim() || typeof funding.fullPayoutSelected!=="boolean" || typeof funding.vipWaiver!=="boolean" || typeof funding.svipWaiver!=="boolean")unavailable("Authoritative deposit and compensation rules are unavailable");
  const f=funding!;
  for(const value of [f.baseDepositCents,f.publisherBailRequirementCents,f.fullPayoutFeeCents])if(typeof value!=="string" || !/^(0|[1-9]\d{0,17})$/.test(value))unavailable("Authoritative funding amount is unavailable");
  const guarantee=await options.gate(client,account);
  if(typeof guarantee.reference!=="string" || !guarantee.reference.trim() || guarantee.occupancy!=="FREE" || !["SATISFIED","NOT_REQUIRED"].includes(guarantee.publisherBail) || (guarantee.publisherBail==="NOT_REQUIRED" && BigInt(f.publisherBailRequirementCents)>0n))unavailable("Account guarantee evidence is unavailable");
  if(f.fullPayoutSelected || f.fullPayoutFeeCents!=="0")unavailable("Full compensation pricing is not supported yet");
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
  const snapshot={schema:"personal-quote-v1",listingHash:version.content_hash,userId:context.userId,ruleRefs:version.payload.ruleRefs,membership:{tier:membership.tier,version:membership.version,sourceRef:membership.sourceRef},guarantee:{status:guarantee.publisherBail,reference:guarantee.reference},funding:{version:f.version,sourceRef:f.sourceRef,baseDepositCents:f.baseDepositCents,publisherBailRequirementCents:f.publisherBailRequirementCents,fullPayoutSelected:f.fullPayoutSelected,fullPayoutPolicyRef:f.fullPayoutPolicyRef,fullPayoutFeeCents:f.fullPayoutFeeCents,vipWaiver:f.vipWaiver,svipWaiver:f.svipWaiver},quote:normalizeQuote(result.quote)};
  const quoteDigest=createHash("sha256").update(canonicalize(snapshot)).digest("hex");
  const now=Number((await client.query(`SELECT floor(extract(epoch FROM clock_timestamp()))::text AS now`)).rows[0].now);
  return {snapshot,now,binding:{...input,userId:context.userId,sessionId:context.sessionId,listingHash:version.content_hash,quoteDigest},projection:{quote:projectDeltaQuote(result.quote,"public"),baseTenantDeposit:yuanAmountObject(parseNonNegativeDecimal(f.baseDepositCents,0,"deposit").value),customerTier:membership.tier,depositWaived:waive}};
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
