import { decimalToBigInt, divideToScale, parseNonNegativeDecimal } from "./decimal";

type LegacyHaffPriceInput = {
  haffMillions: string;
  ownerRatio: string;
  spread: string;
  recordedOwnerYuan: string;
};

export function legacyPriceInteger(value: string, allowZero: boolean): bigint {
  if (!/^(0|[1-9]\d{0,17})$/.test(value) || (!allowZero && value === "0")) throw new Error("LEGACY_PRICE_INPUT_INVALID");
  return BigInt(value);
}

/** The old site rounded the complete Haff amount to whole yuan, before any resource charges. */
export function quoteLegacyHaff(input: LegacyHaffPriceInput): { ownerCents: string; renterCents: string; buyerRatio: string } {
  const haff = legacyPriceInteger(input.haffMillions, false), owner = legacyPriceInteger(input.ownerRatio, false), spread = legacyPriceInteger(input.spread, true);
  const amount = (ratio: bigint) => divideToScale({ value: haff * 100n, scale: 0 }, { value: ratio, scale: 0 }, 0).value * 100n;
  const ownerCents = amount(owner);
  if (decimalToBigInt(parseNonNegativeDecimal(input.recordedOwnerYuan, 2, "legacy owner amount"), 2) !== ownerCents)
    throw new Error("LEGACY_OWNER_PRICE_MISMATCH");
  const buyerRatio = owner - spread;
  if (buyerRatio <= 0n) throw new Error("LEGACY_BUYER_RATIO_INVALID");
  return { ownerCents: ownerCents.toString(), renterCents: amount(buyerRatio).toString(), buyerRatio: buyerRatio.toString() };
}
