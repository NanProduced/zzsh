import { canonicalResourceCode } from "./listing-filters";
import type { ConditionLine, ResourceLine } from "./listing-view";

export type AccountTitleData = {
  title?: string | null;
  publicTitle?: string | null;
  resourceLines?: ResourceLine[];
  conditionLines?: ConditionLine[];
};

export function isHaff(line: { code?: string | null; unitLabel?: string | null }): boolean {
  return line.unitLabel === "哈夫币" || line.code === "df_billable_haff" || line.code === "haff_coin";
}

const RESOURCE_DISPLAY_ORDER = [
  "df_billable_level6_armor",
  "df_billable_level6_helmet",
  "df_billable_level6_bullet",
  "df_billable_awm_bullet",
  "df_billable_barrett_bullet",
  "df_billable_turtle_backpack_45",
  "turtle_backpack_45",
  "df_billable_coffee",
  "df_billable_top_insure_card",
  "top_insure_card_piece",
  "df_billable_top_insure_card_piece",
  "legacy_insurance_day",
];

export function orderedQuoteResources(data: { resourceLines?: ResourceLine[] }): ResourceLine[] {
  const lines = (data.resourceLines ?? []).filter((line) => !isHaff(line));
  return [...lines].sort((a, b) => {
    const ia = RESOURCE_DISPLAY_ORDER.indexOf(canonicalResourceCode(a.code) ?? "");
    const ib = RESOURCE_DISPLAY_ORDER.indexOf(canonicalResourceCode(b.code) ?? "");
    const pa = ia < 0 ? 999 : ia;
    const pb = ib < 0 ? 999 : ib;
    return pa - pb;
  });
}

export function resourceQuantityLabel(line: { quantity?: string | null; quantityLabel?: string | null; unitLabel?: string | null }): string {
  const quantity = (line.quantityLabel || line.quantity || "未确认").replace(/\s+/g, "");
  return line.unitLabel === "哈夫币" || (line.unitLabel && quantity.includes(line.unitLabel))
    ? quantity
    : `${quantity}${line.unitLabel ?? ""}`;
}

function haffMillions(quantity: string): string {
  const digits = quantity.replace(/[^\d]/g, "");
  if (!digits) return quantity;
  const n = BigInt(digits);
  const millions = n / 1_000_000n;
  const remainder = n % 1_000_000n;
  if (remainder === 0n) return `${millions}M`;
  const decimals = (remainder / 100_000n).toString();
  return `${millions}.${decimals}M`;
}

export function parseRank(value: string | null | undefined): { text: string; iconSrc?: string } {
  if (!value || !value.trim()) return { text: "未提供" };
  const raw = value.trim();
  if (raw === "巅峰" || raw.toLowerCase() === "peak") {
    return { text: "巅峰", iconSrc: "/art/delta/ranks/peak.webp" };
  }
  const tiers: Array<{ key: string; name: string; maxDiv: number }> = [
    { key: "bronze", name: "青铜", maxDiv: 3 },
    { key: "silver", name: "白银", maxDiv: 3 },
    { key: "gold", name: "黄金", maxDiv: 4 },
    { key: "platinum", name: "铂金", maxDiv: 4 },
    { key: "diamond", name: "钻石", maxDiv: 5 },
    { key: "blackhawk", name: "黑鹰", maxDiv: 5 },
  ];
  for (const tier of tiers) {
    if (raw.includes(tier.name) || raw.toLowerCase().includes(tier.key)) {
      let div: number | null = null;
      const romanMatch = raw.match(/\b(VIII|VII|VI|IV|V|III|II|I)\b/i) || raw.match(/([ⅠⅡⅢⅣⅤ])/);
      if (romanMatch) {
        const r = romanMatch[1]!.toUpperCase();
        if (r === "I" || r === "Ⅰ") div = 1;
        else if (r === "II" || r === "Ⅱ") div = 2;
        else if (r === "III" || r === "Ⅲ") div = 3;
        else if (r === "IV" || r === "Ⅳ") div = 4;
        else if (r === "V" || r === "Ⅴ") div = 5;
      }
      if (!div) {
        const arabicMatch = raw.match(/(\d+)/);
        if (arabicMatch) div = parseInt(arabicMatch[1]!, 10);
      }
      if (div && div >= 1 && div <= tier.maxDiv) {
        const roman = ["I", "II", "III", "IV", "V"][div - 1];
        return {
          text: `${tier.name}${roman}`,
          iconSrc: `/art/delta/ranks/${tier.key}-${div}.webp`,
        };
      }
      return { text: raw.includes("未") ? raw : `${tier.name} · 小段位未提供` };
    }
  }
  return { text: raw };
}

export function parseSafeBox(raw: string | null | undefined): { size: string | null; name: string | null; full: string } {
  if (!raw || raw === "未提供") return { size: null, name: null, full: "未提供" };
  const formatted = raw.replaceAll("*", "×").trim();
  const match = formatted.match(/(\d\s*×\s*\d)/);
  if (match) {
    const size = match[1]!.replace(/\s+/g, "");
    let remainder = formatted.replace(match[0], "").replace(/[()（）]/g, "").trim();
    if (remainder === "安全箱") {
      remainder = "";
    }
    return { size, name: remainder || null, full: formatted };
  }
  return { size: null, name: null, full: formatted };
}

export function extractSafeBoxForTitle(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim() || /^(未提供|未确认)/.test(raw)) return null;
  const formatted = raw.replaceAll("*", "×");
  const match = formatted.match(/(\d\s*×\s*\d)/);
  if (match) return `${match[1]!.replace(/\s+/g, "")}安全箱`;
  return formatted;
}

export function extractRankForTitle(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim() || /^(无|未提供|未确认)/.test(raw)) return null;
  const parsed = parseRank(raw);
  if (parsed.text === "未提供" || parsed.text === "无") return null;
  if (parsed.text.includes("· 小段位未提供")) {
    return parsed.text.split("·")[0]!.trim();
  }
  return parsed.text;
}

export function extractLevelForTitle(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim() || /^(未提供|未确认)/.test(raw)) return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/(\d+)/);
  if (match) return `${match[1]}级`;
  return trimmed.endsWith("级") ? trimmed : `${trimmed}级`;
}

export function extractVitForTitle(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim() || /^(未提供|未确认)/.test(raw)) return null;
  const trimmed = raw.trim().replace(/\s+/g, "");
  return trimmed.includes("体力") ? trimmed : `体力${trimmed}`;
}

export function extractBearForTitle(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim() || /^(未提供|未确认)/.test(raw)) return null;
  const trimmed = raw.trim().replace(/\s+/g, "");
  return trimmed.includes("负重") ? trimmed : `负重${trimmed}`;
}

const ITEM_ART_MAP: Record<string, string> = {
  df_billable_level6_helmet: "/art/delta/items/level6-helmet-dich9.png",
  df_billable_level6_armor: "/art/delta/items/level6-armor-mas2.png",
  df_billable_awm_bullet: "/art/delta/items/awm-ammo.png",
  awm_round: "/art/delta/items/awm-ammo.png",
  df_billable_barrett_bullet: "/art/delta/items/barrett-ammo.png",
  barrett_round: "/art/delta/items/barrett-ammo.png",
  legacy_barrett_round: "/art/delta/items/barrett-ammo.png",
  df_billable_coffee: "/art/delta/items/coffee-beans.png",
  turtle_backpack_45: "/art/delta/items/turtle-backpack-45.png",
  df_billable_turtle_backpack_45: "/art/delta/items/turtle-backpack-45.png",
  df_billable_level6_bullet: "/art/delta/items/level6-ammo.png",
  level6_round: "/art/delta/items/level6-ammo.png",
  df_billable_top_insure_card: "/art/delta/items/insurance-experience-card-thumb.png",
  top_insure_card_piece: "/art/delta/items/insurance-experience-card-thumb.png",
  df_billable_top_insure_card_piece: "/art/delta/items/insurance-experience-card-thumb.png",
  legacy_insurance_day: "/art/delta/items/insurance-experience-card-thumb.png",
};

export function formatSupplyItem(line: ResourceLine): {
  imageSrc: string | null;
  quantityText: string;
  isZero: boolean;
  isUnknown: boolean;
} {
  const code = canonicalResourceCode(line.code);
  const rawCode = line.code ?? "";
  let isUnknown = line.quantity == null || line.quantity === "" || line.quantity === "未提供" || line.quantity === "待确认";
  const isZero = line.quantity === "0" || line.quantity === "0.00";

  const imageSrc = (code ? ITEM_ART_MAP[code] : undefined) ?? ITEM_ART_MAP[rawCode] ?? null;

  let quantityText = "未提供";
  if (!isUnknown) {
    if (code === "df_billable_level6_bullet") {
      const rounds = /^\d+$/.test(line.quantity!) ? BigInt(line.quantity!) : null;
      if (rounds === null) {
        quantityText = "数量待确认";
        isUnknown = true;
      } else if (rounds === 0n) {
        quantityText = "0组（0发）";
      } else {
        const stacks = rounds / 60n;
        const rem = rounds % 60n;
        if (rem === 0n) quantityText = `${stacks}组（${rounds}发）`;
        else if (stacks === 0n) quantityText = `${rounds}发`;
        else quantityText = `${stacks}组零${rem}发（共${rounds}发）`;
      }
    } else if (code === "df_billable_turtle_backpack_45" || code === "turtle_backpack_45") {
      quantityText = `${line.quantity}个`;
    } else if (isZero) {
      quantityText = `0${line.unitLabel || "件"}`;
    } else if (line.unitLabel) {
      quantityText = `${line.quantity}${line.unitLabel}`;
    } else {
      quantityText = resourceQuantityLabel(line);
    }
  }

  return { imageSrc, quantityText, isZero, isUnknown };
}

function conditionValue(data: { conditionLines?: Array<{ key: string; value: string }> }, key: string): string | null {
  return data.conditionLines?.find((line) => line.key === key)?.value ?? null;
}

function cleanFallbackTitle(title: string | null | undefined, haffStr: string | null): string {
  if (!title || !title.trim()) return "游戏账号";
  let t = title.trim();
  if (haffStr) {
    const rawHaff = haffStr.replace(/\s*哈夫币$/, "").trim();
    const escaped = rawHaff.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^\\s*${escaped}\\s*(?:哈夫币)?\\s*[·\\-\\s]*`, "i"), "").trim();
  }
  return t || "游戏账号";
}

export function deriveAccountTitle(data: AccountTitleData, explicitHaff?: string | null): {
  primary: string;
  secondary: string;
  haff: string | null;
  rest: string;
} {
  const knownValue = (key: string) => {
    const raw = conditionValue(data, key)?.trim();
    return raw && !/^(未提供|未确认)/.test(raw) ? raw : null;
  };

  const haff = data.resourceLines?.find(isHaff);
  let haffStr: string | null = null;
  if (explicitHaff !== undefined) {
    if (explicitHaff) {
      haffStr = explicitHaff.includes("哈夫币") ? explicitHaff : `${explicitHaff} 哈夫币`;
    }
  } else if (haff && haff.quantity != null && haff.quantity !== "") {
    const qtyText = (haff.quantityLabel || haff.quantity).replace(/\s+/g, "");
    const formattedQty = /^\d+$/.test(qtyText) && BigInt(qtyText) >= 1_000_000n ? haffMillions(qtyText) : qtyText;
    haffStr = formattedQty.includes("哈夫币") ? formattedQty : `${formattedQty} 哈夫币`;
  }

  const safeBoxStr = extractSafeBoxForTitle(knownValue("safe_box_code"));
  const rankStr = extractRankForTitle(knownValue("grading_code"));
  const levelStr = extractLevelForTitle(knownValue("character_level"));
  const vitStr = extractVitForTitle(knownValue("vit_level"));
  const bearStr = extractBearForTitle(knownValue("bear_level"));

  const restSegments = [safeBoxStr, rankStr, levelStr, vitStr, bearStr].filter(Boolean) as string[];
  const fallback = cleanFallbackTitle(data.publicTitle ?? data.title, haffStr);
  const hasFallbackName = fallback && fallback !== "游戏账号";

  let primary: string;
  let rest: string;

  if (restSegments.length > 0) {
    rest = restSegments.join(" · ");
    primary = [haffStr, rest].filter(Boolean).join(" · ");
  } else if (hasFallbackName) {
    rest = fallback;
    primary = [haffStr, fallback].filter(Boolean).join(" · ");
  } else {
    rest = haffStr ? "" : fallback;
    primary = haffStr || fallback;
  }

  // Secondary: war resources
  const secondaryParts: string[] = [];
  const quoteResources = orderedQuoteResources(data);
  for (const line of quoteResources) {
    if (!line.quantity || line.quantity === "0" || line.quantity === "") continue;
    const code = canonicalResourceCode(line.code);
    if (code === "df_billable_level6_helmet") {
      secondaryParts.push(`${line.quantity}六头`);
    } else if (code === "df_billable_level6_armor") {
      secondaryParts.push(`${line.quantity}六甲`);
    } else if (code === "df_billable_awm_bullet") {
      secondaryParts.push(`${line.quantity}发AWM`);
    } else if (code === "df_billable_barrett_bullet") {
      secondaryParts.push(`${line.quantity}发巴雷特`);
    } else if (code === "df_billable_level6_bullet") {
      const formatted = formatSupplyItem(line);
      if (!formatted.isUnknown) secondaryParts.push(`${formatted.quantityText.replace(/（[^）]*）$/, "")}六级弹`);
    } else if (code === "df_billable_turtle_backpack_45" || code === "turtle_backpack_45") {
      secondaryParts.push(`${line.quantity}个45格包`);
    } else if (
      code === "df_billable_top_insure_card" ||
      code === "top_insure_card_piece" ||
      code === "df_billable_top_insure_card_piece" ||
      line.code === "legacy_insurance_day"
    ) {
      const u = line.unitLabel === "张" || (line.code && line.code.includes("piece")) ? "张" : "天";
      secondaryParts.push(`${line.quantity}${u}九格卡`);
    }
  }
  const secondary = secondaryParts.join(" · ");

  return { primary, secondary, haff: haffStr, rest };
}

export function deriveDetailTitle(data: AccountTitleData): { primary: string; secondary: string } {
  const { primary, secondary } = deriveAccountTitle(data);
  return { primary, secondary };
}
