import { sha256Hex } from "../src/supply/supply-util";
import { legacyOwnerUserId } from "../src/supply/legacy-user-migration";
import type { LegacyContinuationSource, LegacyPrices, LegacyQuantities } from "../src/order/legacy-continuation-calc";
import { sealLegacyFacts, type LegacyEffectiveFacts, type LegacyEvidenceRow, type LegacyOrderBinding } from "../src/order/legacy-continuation-model";

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
