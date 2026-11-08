import { createHash } from 'node:crypto';
import { canonicalize, normalizeQuote } from '../supply/content-hash';

export const ORDER_COMPENSATION_OPERATION = 'order.compensation.grant';
export const ORDER_COMPENSATION_TRIGGER = 'order.compensation.requested';

export type CompensationPayload = {
  schema: 'order-compensation.v1'; orderId: string; origin: 'NATIVE' | 'LEGACY'; gameId: string; ownerUserId: string;
  sourceDigest: string; amountCents: string; caseRef: string; reason: string; evidenceRef: string;
};
const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const positiveCents = /^[1-9]\d{0,15}$/;
const expectedKeys = ['amountCents','caseRef','evidenceRef','gameId','orderId','origin','ownerUserId','reason','schema','sourceDigest'].sort().join(',');
const text = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value === value.trim() && value === value.normalize('NFC') && [...value].length >= min && [...value].length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** Only frozen, exact-cent input is eligible for an approval; no caller can choose a different recipient. */
export function parseCompensationPayload(value: unknown): CompensationPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== expectedKeys) return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 'order-compensation.v1' || !['NATIVE','LEGACY'].includes(String(v.origin)) ||
    ![v.orderId,v.gameId,v.ownerUserId].every(item => typeof item === 'string' && token.test(item)) ||
    typeof v.sourceDigest !== 'string' || !digest.test(v.sourceDigest) || typeof v.amountCents !== 'string' || !positiveCents.test(v.amountCents) ||
    !text(v.caseRef, 3, 120) || !text(v.reason, 3, 500) || !text(v.evidenceRef, 3, 200)) return null;
  return v as CompensationPayload;
}

type NativeBasis = { id: string; ownerUserId: string; renterUserId: string; accountId: string; listingVersionId: string; contentHash: string; ruleReleaseId: string; gameId: string; paymentId: string; paidCents: string; quote: Record<string, unknown> };
const sha = (value: unknown) => createHash('sha256').update(canonicalize(value)).digest('hex');
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A current account selection cannot prove what an older order bought. */
export function nativeCompensationBasis(order: NativeBasis): { selected: boolean; sourceDigest: string } | null {
  try {
    const snapshot = order.quote, personal = snapshot.personal;
    if (!token.test(order.paymentId) || !positiveCents.test(order.paidCents) || !obj(personal) || !['personal-quote-v2','personal-quote-v3','personal-quote-v4'].includes(String(personal.schema)) ||
      personal.ownerUserId !== order.ownerUserId || personal.userId !== order.renterUserId || personal.accountId !== order.accountId ||
      personal.listingVersionId !== order.listingVersionId || personal.listingHash !== order.contentHash || snapshot.listingHash !== order.contentHash ||
      !obj(personal.ruleRefs) || personal.ruleRefs.releaseId !== order.ruleReleaseId || !obj(personal.fullPayoutDeclaration) ||
      personal.fullPayoutDeclaration.schema !== 'full-payout-declaration-v1' || typeof personal.fullPayoutDeclaration.selected !== 'boolean') return null;
    const names = ['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit','tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs',...(snapshot.schemaVersion === 3 ? ['quoteSource','legacyQuote'] : [])];
    const quote = normalizeQuote(Object.fromEntries(names.map(name => [name, snapshot[name]])));
    const signed = { ...personal, quote, ...(snapshot.settlementPricing === undefined ? {} : { settlementPricing: snapshot.settlementPricing }) };
    if (typeof snapshot.confirmationDigest !== 'string' || sha(signed) !== snapshot.confirmationDigest) return null;
    return { selected: personal.fullPayoutDeclaration.selected, sourceDigest: sha({ origin:'NATIVE',orderId:order.id,gameId:order.gameId,ownerUserId:order.ownerUserId,paymentId:order.paymentId,paidCents:order.paidCents,confirmationDigest:snapshot.confirmationDigest }) };
  } catch { return null; }
}

/** Legacy account capture is reference material only; staff must provide separate reviewed evidence. */
export function legacyCompensationBasis(order: { id: string; gameId: string; ownerUserId: string; sourceDigest: string }): string | null {
  if (![order.id,order.gameId,order.ownerUserId].every(value => token.test(value)) || !digest.test(order.sourceDigest)) return null;
  return sha({ origin:'LEGACY',orderId:order.id,gameId:order.gameId,ownerUserId:order.ownerUserId,sourceDigest:order.sourceDigest });
}
