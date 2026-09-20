import type { DeltaHaffRule } from "../src/supply/delta-rental";

// Isolated compatibility parameters, never production defaults.
export function compatRule(base = "47"): DeltaHaffRule {
  return {
    schema: "haff-ratio-v2", baseBySafeBox: { "box-a": base },
    vitalityDeltaByLevel: { "6": "0" }, bearDeltaByLevel: { "6": "0" }, dailyDeltaByTermOption: { "daily-10m": "0" },
    compatibility: {
      ordinary: { spreadDelta: "8", discounts: { STANDARD: "0", VIP: "2", SVIP: "3", DISCOUNT_USER: "2" } },
      fast: { spreadDelta: "12", discounts: { STANDARD: "0", VIP: "2", SVIP: "4", DISCOUNT_USER: "2" } },
      modes: {
        ordinary: { enabled: true },
        custom: { enabled: true, min: { base: "C", value: "-3" }, max: { base: "C", value: "-1" } },
        fast: { enabled: true, min: { base: "C", value: "6" }, max: { base: "ABSOLUTE", value: "99" } },
      },
    },
  };
}
