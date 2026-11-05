import { canonicalize } from "./content-hash";
import { decimalToBigInt, parseNonNegativeDecimal } from "./decimal";
import { legacyPriceInteger } from "./legacy-listed-pricing";
import { sha256Hex } from "./supply-util";

export function readLegacyListedSource(canonical: string, source: { sourceSystem: string; sourceEntity: string; legacyId: string; sourceDigest: string }) {
  if (source.sourceSystem !== "legacy_mysql_restore" || source.sourceEntity !== "la_rental_accounts"
    || !/^[1-9]\d{0,23}$/.test(source.legacyId) || !/^[a-f0-9]{64}$/.test(source.sourceDigest)
    || typeof canonical !== "string" || Buffer.byteLength(canonical, "utf8") > 32768 || sha256Hex(canonical) !== source.sourceDigest)
    throw new Error("LEGACY_LISTED_SOURCE_INVALID");
  let row: Record<string, unknown>;
  try { row = JSON.parse(canonical); } catch { throw new Error("LEGACY_LISTED_SOURCE_INVALID"); }
  if (!row || typeof row !== "object" || Array.isArray(row) || canonicalize(row) !== canonical || row.id !== source.legacyId
    || row.status !== "3" || row.is_delete !== "0" || typeof row.ratio_type !== "string" || !["default", "custom", "fast"].includes(row.ratio_type)
    || typeof row.is_full_payout !== "string" || !["0", "1"].includes(row.is_full_payout)
    || [row.haff, row.base_bot, row.price_per, row.deposit_amount, row.rental_days].some(value => typeof value !== "string")
    || [row.price_tenant, row.price_vip].some(value => value !== null && typeof value !== "string"))
    throw new Error("LEGACY_LISTED_SOURCE_INVALID");
  try {
    legacyPriceInteger(row.haff as string, false); legacyPriceInteger(row.base_bot as string, false); legacyPriceInteger(row.rental_days as string, false);
    for (const value of [row.price_per, row.deposit_amount, row.price_tenant, row.price_vip])
      if (value !== null) decimalToBigInt(parseNonNegativeDecimal(value as string, 2, "legacy amount"), 2);
  } catch { throw new Error("LEGACY_LISTED_SOURCE_INVALID"); }
  return { haffMillions: row.haff as string, ownerRatio: row.base_bot as string, recordedOwnerYuan: row.price_per as string,
    recordedTenantYuan: row.price_tenant, recordedVipYuan: row.price_vip, depositYuan: row.deposit_amount as string,
    rentalDays: row.rental_days as string, rentalMode: (row.ratio_type === "default" ? "ordinary" : row.ratio_type) as "ordinary" | "custom" | "fast",
    fullPayoutSelected: row.is_full_payout === "1" };
}
