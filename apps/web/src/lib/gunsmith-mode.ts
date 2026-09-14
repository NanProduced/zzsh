import type { PublicGunsmithCode } from "./supply-types";

export function modeLabelText(mode: PublicGunsmithCode["modeCode"]): string {
  if (mode === "HAZARD") return "烽火地带";
  if (mode === "BATTLEFIELD") return "全面战场";
  if (mode === "GENERAL") return "通用";
  return "未标注";
}
