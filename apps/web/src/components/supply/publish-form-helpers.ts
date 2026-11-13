import { formatReferenceYuan } from "@zzsh/ui/display-money";
import {
  groupForField,
  supplyBlockerMessages,
} from "../../lib/supply-client";
import { formatServiceWindowMinute, canonicalResourceCode } from "../../lib/listing-filters";
import {
  buildRentalPricing,
  ratioDisplayText,
  ratioRangeText,
  rentalModeLabel,
} from "../../lib/publish-derive";
import type { DraftInput, RentalMode } from "../../lib/supply-types";
import type {
  PublishGroupId,
  RecommendationInputs,
} from "./publish-form-types";

export function ammoQuantityText(quantity: string): string {
  const rounds = BigInt(quantity), remainder = rounds % 60n;
  return `${rounds / 60n}组${remainder ? `另有${remainder}发历史余量` : ""}，共${rounds}发`;
}

export function formatUnitPrice(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "待确认";
  return formatReferenceYuan(String(amount)) ?? "待确认";
}

/** One ratio rule for both the inline hint and the submit preflight. */
export function ratioEntryProblem(
  mode: RentalMode,
  config: { min?: { base: "C" | "ABSOLUTE"; value: string }; max?: { base: "C" | "ABSOLUTE"; value: string } } | null | undefined,
  raw: string,
  resolvedRange?: { min?: string | null; max?: string | null } | null,
): { message: string; target?: string } | null {
  const label = rentalModeLabel(mode);
  const range = ratioRangeText(config);
  const resolvedLabel = ratioDisplayText(resolvedRange);
  if (!range && !resolvedLabel) return { message: `${label}规则暂未加载，请稍后重试。` };
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!buildRentalPricing(mode, trimmed)) return { message: `请填写合法的${label}数值，或切换为普通比例。`, target: "input[aria-label='兑换比例']" };
  const value = Number(trimmed);
  const belowStatic = config?.min?.base === "ABSOLUTE" && value < Number(config.min.value);
  const aboveStatic = config?.max?.base === "ABSOLUTE" && value > Number(config.max.value);
  if (belowStatic || aboveStatic) {
    return { message: `${label}（${trimmed}）已不在当前允许范围（${range}，万哈夫币/元），请重新填写。`, target: "input[aria-label='兑换比例']" };
  }
  const dynMin = resolvedRange?.min != null && resolvedRange.min !== "" ? Number(resolvedRange.min) : null;
  const dynMax = resolvedRange?.max != null && resolvedRange.max !== "" ? Number(resolvedRange.max) : null;
  const belowDynamic = dynMin !== null && Number.isFinite(dynMin) && value < dynMin;
  const aboveDynamic = dynMax !== null && Number.isFinite(dynMax) && value > dynMax;
  if (belowDynamic || aboveDynamic) {
    const activeRange = resolvedLabel ?? range;
    return { message: `${label}（${trimmed}）已不在当前允许范围（${activeRange}，万哈夫币/元），请重新填写。`, target: "input[aria-label='兑换比例']" };
  }
  return null;
}

export function inputsEqual(left: RecommendationInputs, right: RecommendationInputs): boolean {
  return left.safeBoxCode === right.safeBoxCode &&
    left.vitality === right.vitality &&
    left.bear === right.bear &&
    left.dive === right.dive &&
    [...left.skinIds].sort().join(",") === [...right.skinIds].sort().join(",");
}

export const groupMeta: Record<PublishGroupId, { title: string; hint: string }> = {
  account: { title: "账号资料", hint: "基础属性与安全箱" },
  assets: { title: "库存与皮肤", hint: "物资、装备与外观" },
  media: { title: "展示图片", hint: "游戏截图与封禁记录" },
  terms: { title: "出租条件", hint: "租金、押金与交付方式" },
};

export const INSURANCE_EXPERIENCE_CARD = "九格保险体验卡";

export const INVENTORY_ITEM_ART: Record<string, string> = {
  df_billable_level6_bullet: "/art/delta/items/level6-ammo.png",
  level6_round: "/art/delta/items/level6-ammo.png",
  df_billable_level6_helmet: "/art/delta/items/level6-helmet-dich9.png",
  level6_helmet: "/art/delta/items/level6-helmet-dich9.png",
  df_billable_level6_armor: "/art/delta/items/level6-armor-mas2.png",
  level6_armor: "/art/delta/items/level6-armor-mas2.png",
  df_billable_awm_bullet: "/art/delta/items/awm-ammo.png",
  awm_round: "/art/delta/items/awm-ammo.png",
  df_billable_barrett_bullet: "/art/delta/items/barrett-ammo.png",
  barrett_round: "/art/delta/items/barrett-ammo.png",
  legacy_barrett_round: "/art/delta/items/barrett-ammo.png",
  df_billable_coffee: "/art/delta/items/coffee-beans.png",
  coffee: "/art/delta/items/coffee-beans.png",
  df_billable_turtle_backpack_45: "/art/delta/items/turtle-backpack-45.png",
  turtle_backpack_45: "/art/delta/items/turtle-backpack-45.png",
  df_billable_top_insure_card: "/art/delta/items/insurance-experience-card-thumb.png",
  top_insure_card_piece: "/art/delta/items/insurance-experience-card-thumb.png",
  df_billable_top_insure_card_piece: "/art/delta/items/insurance-experience-card-thumb.png",
  legacy_insurance_day: "/art/delta/items/insurance-experience-card-thumb.png",
};

export const emptyAttributes: DraftInput["attributes"] = {
  safe_box_code: null,
  vit_level: null,
  bear_level: null,
  dive_level: null,
  character_level: null,
  awm_weapon_count: null,
  grading_code: null,
  login_method_code: null,
  region_province: null,
  region_city: null,
  ban_record: null,
  face_is_self: null,
  secret_kd: null,
  service_window_start_minute: null,
  service_window_end_minute: null,
  service_window_timezone: null,
  service_window_cross_midnight: null,
};

export function emptyDraft(): DraftInput {
  return {
    title: "",
    description: null,
    attributes: { ...emptyAttributes },
    termOptionCode: "",
    pricingOptionCode: "",
    inventory: [],
    skins: [],
    entitlements: [],
    mediaBindings: [],
  };
}

export function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m3d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function moneyText(money: { amount: string } | null | undefined): string {
  return money ? `${money.amount} 元` : "未配置";
}

export function durationText(seconds: string | number | null | undefined): string {
  const value = typeof seconds === "string" ? Number(seconds) : seconds;
  if (!value || !Number.isFinite(value)) return "核价后显示";
  if (value % 86400 === 0) return `${value / 86400} 天`;
  if (value % 3600 === 0) return `${value / 3600} 小时`;
  if (value % 60 === 0) return `${value / 60} 分钟`;
  if (value > 60) return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
  return `${value} 秒`;
}

export function stateLabel(state: string | null | undefined): string {
  return ({ DRAFT: "草稿", SUBMITTED: "审核中", WITHDRAWN: "已撤回", REJECTED: "已退回", APPROVED: "已通过", PUBLISHED: "已上架", IMPORTED_UNVERIFIED: "待复核" } as Record<string, string>)[state ?? ""] ?? "未确认";
}

export function mediaReviewLabel(state: string | undefined): string {
  return ({ NOT_REQUIRED: "无需人工审核", PENDING: "技术校验中", APPROVED: "已通过技术校验", REJECTED: "未通过校验", QUARANTINED: "已隔离" } as Record<string, string>)[state ?? ""] ?? "状态待核";
}

export function is3x3SafeBoxCode(code: string, displayName?: string | null): boolean {
  return code === "safe_box_3x3" || code === "3*3" || (displayName?.includes("3*3") ?? false) || (displayName?.includes("3x3") ?? false);
}

export const SYSTEM_ERROR_BLOCKER_CODES = new Set<string>([
  "FUNDING_UNKNOWN",
  "RULE_UNCONFIGURED",
  "REQUIRED_ITEM_UNPRICED",
  "OCCUPANCY_UNKNOWN",
  "STATE_UNKNOWN",
  "ACCOUNT_NOT_PUBLISHABLE",
  "GAME_UNAVAILABLE",
  "GAME_SERVICE_UNAVAILABLE",
  "OWNER_UNAVAILABLE",
]);

export const FORM_ENTRY_BLOCKER_CODES = new Set<string>([
  "PUBLICATION_REQUIRED",
  "CONFIRMATION_OR_MEDIA_REQUIRED",
  "QUOTE_REQUIRED",
  "ACCEPTANCE_REQUIRED",
  "RULE_CHANGED",
  "MEDIA_REQUIRED",
  "RULE_INPUT_MISSING",
  "TERM_UNDETERMINED",
  "DECLARATION_INCOMPLETE",
  "ACCOUNT_INFO_INCOMPLETE",
]);

export const extraBlockerMessages: Record<string, string> = {
  RENTAL_COMPLETED: "该账号已有已完成租约，当前规则不允许重新发布；请选择其他账号或联系客服。",
  RULE_INPUT_MISSING: "请先完善账号属性、哈夫币余额和出租比例后再试。",
  TERM_UNDETERMINED: "请检查哈夫币余额和每日消耗设置。",
  QUOTE_REQUIRED: "请确认必填信息后再提交上架。",
  ACCEPTANCE_REQUIRED: "请勾选同意出租协议后再提交上架。",
  RULE_CHANGED: "平台规则已更新，请重新点击确认上架。",
  MEDIA_REQUIRED: "请按要求上传展示图片与封禁记录截图。",
  DECLARATION_INCOMPLETE: "请先补全账号资料与必填项。",
  ACCOUNT_INFO_INCOMPLETE: "请先补全账号资料。",
};

export function blockerText(code: string): string {
  if (SYSTEM_ERROR_BLOCKER_CODES.has(code)) return "系统问题，请联系客服";
  return supplyBlockerMessages[code] ?? extraBlockerMessages[code] ?? "当前暂不能继续，请检查填写内容或联系客服。";
}

export function localizedErrorMessage(message: string): string {
  const messages: Record<string, string> = { ...supplyBlockerMessages, ...extraBlockerMessages };
  const translateToken = (code: string) =>
    SYSTEM_ERROR_BLOCKER_CODES.has(code) ? "系统问题，请联系客服" : messages[code] ?? "操作未能完成，请检查填写内容或联系客服";
  const cleaned = message.trim();
  const tail = cleaned.includes(":") || cleaned.includes("：")
    ? cleaned.slice(Math.max(cleaned.lastIndexOf(":"), cleaned.lastIndexOf("：")) + 1).trim()
    : cleaned;
  const candidateCodes = tail.split(/[,，\s]+/).map((code) => code.trim()).filter(Boolean);
  if (candidateCodes.length > 0 && candidateCodes.every((code) => /^[A-Z][A-Z0-9_]{2,}$/.test(code))) {
    const parts = Array.from(new Set(candidateCodes.map((code) => translateToken(code).replace(/[。；;]+$/g, ""))));
    return `${parts.join("；")}。`;
  }
  if (/[A-Z][A-Z0-9_]{2,}/.test(cleaned)) {
    const replaced = cleaned.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, (code) => translateToken(code));
    return replaced.replace(/[:：]\s*$/, "").trim() || "系统问题，请联系客服";
  }
  return message;
}

export function fieldErrorText(path: string, code: string): string {
  if (code === "REQUIRED" || code === "MISSING") return "请填写此项后再保存。";
  if (code === "INVALID" || code === "INVALID_VALUE" || code === "FORMAT") return "填写内容格式不正确，请按提示修改。";
  if (code === "OUT_OF_RANGE" || code === "NEGATIVE") return "数量必须是允许范围内的非负整数。";
  if (path.startsWith("inventory")) return "请填写目录要求的整数数量。";
  if (path.startsWith("entitlements")) return "请补充权益数值或有效期，未知值不能直接提交。";
  if (path.startsWith("mediaBindings")) return "请检查图片是否已上传并保存到当前资料。";
  return "请检查此项后重试。";
}

export function publishGroupForPath(path: string, haffItemId?: string): PublishGroupId {
  if (path === "attributes.info_source") return "terms";
  if (path === "attributes.next_season_pass" || path === "attributes.demulan_unlocked") return "account";
  if (haffItemId && path.startsWith("inventory") && path.includes(haffItemId)) return "terms";
  const group = groupForField(path);
  if (group === "basics") return "account";
  if (group === "inventory" || group === "skins" || group === "entitlements") return "assets";
  if (group === "media") return "media";
  return "terms";
}

export function isAbort(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError");
}

export function meaningfulDraft(draft: DraftInput): boolean {
  return Boolean(
    draft.title.trim() ||
    draft.description?.trim() ||
    draft.inventory.some((item) => item.quantity !== null && item.quantity !== "0") ||
    draft.skins.length ||
    draft.entitlements.length ||
    draft.mediaBindings.length ||
    Object.values(draft.attributes).some((value) => value !== null && value !== undefined),
  );
}

export function nextMediaPosition(bindings: DraftInput["mediaBindings"]): number {
  const used = new Set(bindings.map((binding) => binding.position));
  let position = 0;
  while (used.has(position)) position += 1;
  return position;
}

export function inferNoticeKind(text: string): "success" | "warning" | "info" {
  if (/请先|请补|请填写|请检查|请选择|请核对|请重新|已失效|已过期|未完成|读取失败|不可采用|暂不可用|暂不能|未提供|尚未|变动|变化|需要重新|待核对|恢复原请求/.test(text)) {
    return "warning";
  }
  if (/正在读取|正在准备|已切换游戏|点击“开始修改”|原图片文件|移除|剪贴板|设为 0/.test(text)) {
    return "info";
  }
  return "success";
}

export function formatHaffChineseUnit(rawM: string): string | null {
  const trimmed = rawM.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const m = BigInt(trimmed);
  if (m <= 0n) return null;
  if (m >= 100n) {
    const whole = m / 100n;
    const rem = Number(m % 100n);
    if (rem === 0) return `${whole} 亿哈夫币`;
    const decimal = rem % 10 === 0 ? String(rem / 10) : String(rem).padStart(2, "0");
    return `${whole}.${decimal} 亿哈夫币`;
  }
  return `${m * 100n} 万哈夫币`;
}

export function retiredInsuranceCode(code: string | null | undefined): boolean {
  return code === "top_insure_card_piece" || code === "df_billable_top_insure_card_piece";
}

export function numericChoiceOptions(current: string, values: number[], suffix = "级") {
  const known = new Set(values.map(String));
  return [
    ...(current && !known.has(current) ? [{ value: current, label: `${current}${suffix}（历史原值）`, disabled: true }] : []),
    ...values.map((value) => ({ value: String(value), label: `${value}${suffix}` })),
  ];
}

export function retainedNumericChoiceNote(current: string, values: readonly number[], name: string): string | null {
  if (!current || values.includes(Number(current))) return null;
  return `${name}保留了${current}级历史原值；新申报请选择 ${values[0]}–${values[values.length - 1]} 级。`;
}

export function serviceTimeOptions(values: readonly number[], current: number | null) {
  const options = values.map((value) => ({ value: String(value), label: formatServiceWindowMinute(value) }));
  if (current !== null && !values.includes(current)) {
    options.unshift({ value: String(current), label: `${formatServiceWindowMinute(current)}（历史原值）` });
  }
  return options;
}
