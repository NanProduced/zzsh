import { sha256Hex } from "../src/supply/supply-util";
import { legacyOwnerUserId } from "../src/supply/legacy-user-migration";
import { admitLegacyEvidence, planVerifiedLegacySettlement, type LegacyContinuationSource, type LegacyPrices, type LegacyQuantities, type LegacySettlementBasis } from "../src/order/legacy-continuation-calc";
import { deriveLegacyFacts, initialLegacyFacts, sealLegacyFacts, type LegacyEffectiveFacts, type LegacyEvidenceRow, type LegacyOrderBinding } from "../src/order/legacy-continuation-model";

export const legacyPrices = (value: string | null) => Object.fromEntries(["barrett", "bullet", "awm", "armor", "helmet", "coffee", "card"].map(n => [n, value])) as LegacyPrices;
export const legacyQuantities = (haff: string | null): LegacyQuantities => ({ expendHaff: haff, ...legacyPrices("0.00") });
export function legacySource(patch: Partial<LegacyContinuationSource> = {}): LegacyContinuationSource {
  return { legacyOrderId: "7", orderStatus: "3", isSettle: "0", renterId: "11", ownerId: "22", accountId: "33", profitDot: "2", baseBot: "10", payMoney: "100.00", goodsMoney: "10.00", storedCommissionMoney: "0.00", depositAmount: "57.00", detainMoney: "5.00", returnOrderMoney: null, saleEarnings: null, fullPayoutMoney: "0.00", isFullPayout: "0", isAdvanceSet: "0", orderPrices: legacyPrices("8.00"), accountPrices: legacyPrices("8.00"), quantities: legacyQuantities(null), paidPay: [{ id: "9", payOrderSn: "FIXTURE_P7", payMoney: "100.00" }], commissions: [], policy: { advanceOrderSetRatio: "90", expend: Object.fromEntries(["barrettBullet", "bullet", "awm", "armor", "helmet", "coffee", "experienceCard", "barrettBulletSale", "bulletSale", "awmSale", "armorSale", "helmetSale", "coffeeSale", "experienceCardSale"].map(n => [n, "0.20"])) }, ...patch };
}
export const legacyBinding: LegacyOrderBinding = { id: "legacy_order_" + sha256Hex(JSON.stringify(["legacy_mysql_restore", "la_order", "7"])).slice(0, 40), legacyId: "7", accountId: "fixture_account", legacyAccountId: "33", gameId: "fixture_game", ownerUserId: legacyOwnerUserId("legacy_mysql_restore", "la_user", "22"), renterUserId: legacyOwnerUserId("legacy_mysql_restore", "la_user", "11"), legacyOwnerId: "22", legacyRenterId: "11", ownerSourceDigest: "a".repeat(64), renterSourceDigest: "b".repeat(64), sourceDigest: "c".repeat(64), sourceOrderStatus: 3, sourcePayStatus: 1, paidCents: "10000" };
export function legacyEvidence(facts: LegacyEffectiveFacts): LegacyEvidenceRow {
  const s = sealLegacyFacts(facts);
  return { id: "fixture_evidence", orderId: legacyBinding.id, evidenceVersion: "1", sourceKind: "SOURCE_IMPORT", sourceDigest: legacyBinding.sourceDigest, factsDigest: s.digest, factsCanonical: s.canonical, facts };
}

/** A real new-rule proposal, with a sealed original and independently verified opening basis. */
export function legacyVerifiedProposal(stage: "8" | "9" = "8", itemAmount = "0", patch: Partial<LegacyContinuationSource> = {}) {
  const source = legacySource({ baseBot:"10", profitDot:"0", goodsMoney:"10.00", storedCommissionMoney:"0.00", ...patch,
    orderStatus:"3", orderPrices:{...legacyPrices("8.00"),barrett:itemAmount} });
  const basis:LegacySettlementBasis = {id:"fixture_basis",openingHaffM:"1",baseBot:"10",ownerPrices:{...legacyPrices("8.00"),barrett:"0"},openingItems:legacyQuantities("1"),fullPayout:false};
  const quantities={...legacyQuantities("1.30"),barrett:itemAmount==="0"?"0":"1"};
  const caller=stage==="8"?{role:"renter" as const,legacyUserId:source.renterId}:{role:"owner" as const,legacyUserId:source.ownerId};
  const command={kind:"propose" as const,caller,quantities,endReason:"NORMAL" as const,settlementBasis:basis};
  const plan=planVerifiedLegacySettlement(admitLegacyEvidence(source),command,basis);
  if(!plan.ok)throw new Error(`Invalid verified fixture: ${plan.code}`);
  const original=legacyEvidence(initialLegacyFacts(source)); original.id="fixture_original";
  const facts=deriveLegacyFacts(original.facts,plan,command,original.id,"fixture_proposal");
  return {source:facts.evidence.source,facts,original,basis,quantities,plan};
}

export function legacyVerifiedEarlyProposal(stage:"8"|"9"="8",fullPayout=false) {
  const source=legacySource({baseBot:"110",profitDot:"10",goodsMoney:"100.00",storedCommissionMoney:"9.00",detainMoney:"0.00",isFullPayout:fullPayout?"1":"0"});
  const basis:LegacySettlementBasis={id:"fixture_basis",openingHaffM:"100",baseBot:"110",ownerPrices:legacyPrices("1"),openingItems:legacyQuantities("100"),fullPayout};
  const quantities=legacyQuantities("60"),caller=stage==="8"?{role:"renter" as const,legacyUserId:source.renterId}:{role:"owner" as const,legacyUserId:source.ownerId};
  const command={kind:"propose" as const,caller,quantities,endReason:"TENANT_VOLUNTARY_EARLY" as const,settlementBasis:basis};
  const plan=planVerifiedLegacySettlement(admitLegacyEvidence(source),command,basis);
  if(!plan.ok)throw new Error(`Invalid verified fixture: ${plan.code}`);
  const original=legacyEvidence(initialLegacyFacts(source));original.id="fixture_original";
  const facts=deriveLegacyFacts(original.facts,plan,command,original.id,"fixture_proposal");
  return {source:facts.evidence.source,facts,original,basis,quantities,plan};
}
