import {createHash} from 'node:crypto';
import {hashApprovalPayload} from '../auth/approval-audit';
import {canonicalize,normalizePricingPolicy,normalizeQuote} from '../supply/content-hash';
import {fixedFeeAllowsPayableRatio} from '../supply/fixed-fee';
import {sourceYuanToCents} from './finance-money';
import type {CompletedDistributionFacts,FixedFeeAccrualEvidence} from './distribution-accrual';
import type {FixedFeeDistributionPricing,PaymentDistributionBasis} from './distribution-payment-basis';

type ObjectValue=Record<string,any>;
type FixedOrderIdentity={renterUserId:string;ownerUserId:string;accountId:string;listingVersionId:string;contentHash:string;ruleReleaseId:string};
const object=(value:unknown):value is ObjectValue=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const quoteFields=['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit','tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'];
// Callers use the existing posting/order aliases; this value is never part of the legacy posting digest.
export const FIXED_FEE_EVIDENCE_SELECT=`CASE WHEN o.quote_snapshot->>'schemaVersion'='4' THEN jsonb_build_object(
 'orderId',o.id,'orderStatus',o.status,'renterUserId',o.renter_user_id,'ownerUserId',o.owner_user_id,'accountId',o.account_id,
 'listingVersionId',o.listing_version_id,'contentHash',o.content_hash,'ruleReleaseId',o.rule_release_id,'quote',o.quote_snapshot,
 'paymentId',dpc.id,'paymentOrderId',dpc.order_id,'paymentDisposition',dpc.disposition,'paymentCurrency',dpc.currency,'paymentCents',dpc.amount_cents::text,
 'postingVersionId',p.settlement_version_id,'versionId',dsv.id,'versionOrderId',dsv.order_id,'versionHash',dsv.version_hash,
 'versionKind',dsv.kind,'versionSuperseded',dsv.superseded_at IS NOT NULL,'snapshot',dsv.input_snapshot) ELSE NULL END AS fixed_evidence`;
export const FIXED_FEE_EVIDENCE_JOINS=`LEFT JOIN zzsh_order.settlement_version dsv ON dsv.id=p.settlement_version_id AND dsv.order_id=p.order_id
 LEFT JOIN zzsh_order.payment_confirmation dpc ON dpc.id=p.payment_confirmation_id AND dpc.order_id=p.order_id`;

/** This verifies a stored confirmation, not authority to accept a new payment. */
export function fixedFeePaymentPricing(value:unknown,identity:FixedOrderIdentity):FixedFeeDistributionPricing|null{
 try{
  if(!object(value)||value.schemaVersion!==4||!object(value.personal)||!object(value.settlementPricing))return null;
  const personal=value.personal,pricing=value.settlementPricing;
  const quote=normalizeQuote(Object.fromEntries(quoteFields.map(field=>[field,value[field]])));
  if(personal.schema!=='personal-quote-v5'||personal.userId!==identity.renterUserId||personal.ownerUserId!==identity.ownerUserId
   ||personal.accountId!==identity.accountId||personal.listingVersionId!==identity.listingVersionId
   ||personal.listingHash!==identity.contentHash||value.listingHash!==identity.contentHash||quote.ruleReleaseId!==identity.ruleReleaseId
   ||!object(personal.ruleRefs)||personal.ruleRefs.releaseId!==identity.ruleReleaseId||pricing.schema!=='settlement-pricing-v3'
   ||pricing.priceVersionId!==quote.priceVersionId||pricing.fixedFeeRate!==quote.pricingInputs.commissionRate
   ||typeof pricing.fixedFeeRate!=='string'||typeof pricing.payableRatio!=='string'
   ||!fixedFeeAllowsPayableRatio(pricing.fixedFeeRate,pricing.payableRatio))return null;
  const policy=normalizePricingPolicy(personal.pricingPolicy);
  if(policy.pricingModel!=='FIXED_FEE'||policy.priceVersionId!==quote.priceVersionId
   ||typeof value.confirmationDigest!=='string'||sha(canonicalize({...personal,quote,settlementPricing:pricing}))!==value.confirmationDigest)return null;
  return{fixedFeeRate:pricing.fixedFeeRate,payableRatio:pricing.payableRatio};
 }catch{return null;}
}

/** Fields are read from the original committed posting and accepted settlement version. */
export function fixedFeeAccrualFacts(basis:PaymentDistributionBasis|null,facts:CompletedDistributionFacts,evidence:unknown):CompletedDistributionFacts{
 if(basis?.schema!=='payment-distribution-basis.v2')return facts;
 const unavailable={...facts,fixedFeeEvidence:null};
 try{
  if(!object(evidence)||!object(evidence.quote)||!object(evidence.snapshot)||!object(evidence.snapshot.amounts))return unavailable;
  const identity:FixedOrderIdentity={renterUserId:evidence.renterUserId,ownerUserId:evidence.ownerUserId,accountId:evidence.accountId,
   listingVersionId:evidence.listingVersionId,contentHash:evidence.contentHash,ruleReleaseId:evidence.ruleReleaseId};
  const pricing=fixedFeePaymentPricing(evidence.quote,identity),snapshot=evidence.snapshot,amounts=snapshot.amounts;
  if(!pricing||!basis.fixedFeePricing||canonicalize(pricing)!==canonicalize(basis.fixedFeePricing)
   ||evidence.orderId!==facts.orderId||evidence.orderStatus!=='COMPLETED'||evidence.paymentId!==facts.confirmationId
   ||evidence.paymentOrderId!==facts.orderId||evidence.paymentDisposition!=='APPLIED'||evidence.paymentCurrency!=='CNY'
   ||evidence.paymentCents!==facts.capturedCents||evidence.versionOrderId!==facts.orderId||evidence.versionId!==evidence.postingVersionId
   ||evidence.versionHash!==facts.settlementVersionHash||evidence.versionSuperseded!==false
   ||!['SYSTEM','MANUAL_ADJUSTMENT'].includes(evidence.versionKind)||facts.calculationMode!==(evidence.versionKind==='SYSTEM'?'SYSTEM':'MANUAL')
   ||snapshot.schema!=='settlement-version-v4'||snapshot.orderId!==facts.orderId||snapshot.paymentConfirmationId!==facts.confirmationId
   ||typeof snapshot.early!=='boolean'||snapshot.early!==(facts.classification==='EARLY')
   ||snapshot.renterUserId!==identity.renterUserId||snapshot.ownerUserId!==identity.ownerUserId||snapshot.listingVersionId!==identity.listingVersionId
   ||snapshot.listingHash!==identity.contentHash||snapshot.kind!==evidence.versionKind||hashApprovalPayload(snapshot).hash!==evidence.versionHash
   ||sourceYuanToCents(snapshot.capturedAmount)!==facts.capturedCents)return unavailable;
  const manual=evidence.versionKind==='MANUAL_ADJUSTMENT';
  const result:FixedFeeAccrualEvidence={orderId:facts.orderId,confirmationId:facts.confirmationId,postingId:facts.postingId,postingDigest:facts.postingDigest,
   settlementVersionId:evidence.versionId,settlementVersionHash:evidence.versionHash,orderStatus:'COMPLETED',
   ownerGrossCents:sourceYuanToCents(manual?snapshot.proposedOwnerGross:amounts.ownerGross),
   serviceFeeCents:sourceYuanToCents(manual?snapshot.proposedPlatformServiceFee:amounts.platformServiceFee),
   distributionDiscountCents:sourceYuanToCents(manual?snapshot.proposedMembershipDiscount:amounts.membershipDiscount)};
  return{...facts,settlementVersionId:evidence.versionId,fixedFeeEvidence:result};
 }catch{return unavailable;}
}
