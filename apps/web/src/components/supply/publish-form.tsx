"use client";
import { BusinessUpdateNotices } from "@/components/content/platform-update-notices";
import { formatReferenceYuan } from "@zzsh/ui/display-money";
import { ManagedNoticeSections, ManagedNoticeText } from "@/components/content/managed-notice";
import { usePublicContent } from "@/components/content/public-content-provider";
import { FormSelect, FormRadioGroup, Input, IntegerStepper, Textarea, DateTimePicker } from "../ui/form-controls";
import { ConfirmAlertDialog } from "../ui/alert-dialog";
import { RecoveryAlert } from "../ui/information";
import { SessionLoading } from "../auth/session-loading";
import { SkinMediaThumb, SkinMediaPreview, SkinMetadata } from "./skin-media-thumb";
import { CatalogItemArt } from "./catalog-item-art";
import "./publish-refinement.css";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Dialog } from "@base-ui/react/dialog";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Box,
  Bean,
  Crosshair,
  HardHat,
  Shield,
  Ticket,
  TriangleAlert,
  CalendarClock,
  Clock3,
  CircleHelp,
  Check,
  Coins,
  CreditCard,
  Calculator,
  ChevronDown,
  FileImage,
  FileText,
  Info,
  LogIn,
  LockKeyhole,
  MapPin,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
  X,
  ZoomIn,
} from "lucide-react";
import { ServiceShell } from "../layout/service-shell";
import { useUserSessionStore } from "../session/user-session-provider";
import {
  editableDeclaration,
  groupForField,
  inventoryEditorRows,
  inventoryPriceHint,
  mediaAccessUrl,
  mergeInventory,
  supplyApi,
  supplyBlockerGroup,
  supplyBlockerMessages,
  SupplyRequestError,
  uploadSupplyMedia,
  uncertainSupplyWriteFailure,
  type CatalogAvailability,
} from "../../lib/supply-client";
import { freezeRequest, IdentityPauseGate, isCurrentQuery } from "../../lib/supply-workspace-guards";
import { loadSupplyIntent, prepareSupplyIntent, acceptSupplyIntent, retainUncertainSupplyIntent, clearSupplyIntent, sameSupplyIntent, SupplyIntentStorageError, type SupplyWriteIntent, type SupplyWriteAction, type SupplyWriteReceipt } from "../../lib/supply-write-intent";
import { MEDIA_ACCEPT_ATTRIBUTE, mediaUploadFailureHint } from "../../lib/media-upload";
import { selectDeltaGame } from "../../lib/supply-games";
import { requiredAccountFactsProblem } from "../../lib/supply-publication-required";
import { DELTA_REGION_OPTIONS } from "../../lib/delta-region-options";
import {
  SERVICE_WINDOW_END_OPTIONS,
  SERVICE_WINDOW_START_OPTIONS,
  canonicalResourceCode,
  resourceUnitLabel,
  formatServiceWindowMinute,
  isSkinOwnerKind,
  skinTypeOptions,
} from "../../lib/listing-filters";
import {
  baseFromHaffM,
  baseQuantityText,
  beijingInputFromIso,
  buildRentalPricing,
  centsOfMoney,
  centsText,
  customTermOptions,
  depositDeclarationCents,
  fullPayoutSelected,
  haffMInputFromBase,
  haffMText,
  isoFromBeijingInput,
  minutesToTimeValue,
  matchedOwnerNetEstimate,
  usesRentalModes,
  ownerQuoteBreakdown,
  ratioDisplayText,
  ratioRangeText,
  rentalModeLabel,
  rentalPricingOf,
  timeValueToMinutes,
  yuanFromCents,
  yuanToCents,
} from "../../lib/publish-derive";
import type {
  DepositRecommendation,
  DepositSkinFacts,
  DraftInput,
  FullPayoutTerms,
  FullPayoutTermsAcceptance,
  MySupply,
  PublishingCatalog,
  PublishingOptions,
  ResourceIncomePreview,
  OwnerIncomePreview,
  OwnerIncomePreviewInput,
  OwnerDepositDeclaration,
  RentalMode,
  SkinOwnerKind,
  SupplyGame,
} from "../../lib/supply-types";
import type { PublishMode } from "../../lib/service-navigation";

type PublishFormProps = { mode: PublishMode; gameCode?: string; accountId?: string; editRequested?: boolean };
type RegionOption = { province: string; city: string };
type SessionId = string | null | undefined;
type MediaPurpose = "ACCOUNT_DISPLAY" | "ACCOUNT_EVIDENCE";
type IdentityState = "checking" | "confirmed" | "failed" | "guest";
type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
type AmmoReview = { itemId: string; quantity: string; context: RequestContext; resume?: () => void };
type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };
type WriteIntent = { action: string; context: RequestContext; persisted?: SupplyWriteIntent; run: () => Promise<void | boolean> };
type DraftRequest = { context: RequestContext; accountId: string; body: DraftInput & { expectedRevision: string }; key: string };
type MediaCategory = "SHOWCASE" | "PENALTY";

function ammoQuantityText(quantity: string): string {
  const rounds = BigInt(quantity), remainder = rounds % 60n;
  return `${rounds / 60n}组${remainder ? `另有${remainder}发历史余量` : ""}，共${rounds}发`;
}
function formatUnitPrice(amount: string | number | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "待确认";
  return formatReferenceYuan(String(amount)) ?? "待确认";
}
type MediaEntry = {
  id: string;
  purpose: MediaPurpose;
  category?: MediaCategory;
  file?: File;
  transport?: "OSS_POST";
  assetId?: string;
  reviewState?: string;
  publicDisplayEligible?: boolean;
  publiclyReadable?: boolean;
  previewUrl?: string;
  bindingSaved: boolean;
  status: "uploading" | "bound" | "failed";
  intentKey: string;
  uploadKey: string;
  error?: string;
  context: RequestContext;
};
type SkinQuery = { q?: string; categoryId?: string; ownerKind?: SkinOwnerKind; rarityCode?: string; ownerId?: string; cursor?: string };
type PublishGroupId = "account" | "assets" | "terms" | "media";
type OptionsAvailability = "pending" | "ready" | "unavailable" | "failed";
type NavigationIntent = { message: string; label: string; run: () => void; cancel?: () => void };
type UiProblem = { group: PublishGroupId; message: string; target?: string };

/** One ratio rule for both the inline hint and the submit preflight. */
function ratioEntryProblem(
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
    return { message: `${label}（${trimmed}）已不在当前允许范围（${resolvedLabel ?? range}），请重新填写。`, target: "input[aria-label='兑换比例']" };
  }
  return null;
}
type RecommendationInputs = Extract<DepositRecommendation, { available: true }>["inputs"];
type RecommendationBinding = {
  accountId: string;
  accountRevision: string;
  versionId: string;
  versionRevision: string;
  ruleReleaseId: string;
  inputs: RecommendationInputs;
  mismatch: boolean;
};

function inputsEqual(left: RecommendationInputs, right: RecommendationInputs): boolean {
  return left.safeBoxCode === right.safeBoxCode &&
    left.vitality === right.vitality &&
    left.bear === right.bear &&
    left.dive === right.dive &&
    [...left.skinIds].sort().join(",") === [...right.skinIds].sort().join(",");
}

const groupMeta: Record<PublishGroupId, { title: string; hint: string }> = {
  account: { title: "账号资料", hint: "基础属性与安全箱" },
  assets: { title: "库存与皮肤", hint: "物资、装备与外观" },
  media: { title: "展示图片", hint: "游戏截图与封禁记录" },
  terms: { title: "出租条件", hint: "租金、押金与交付方式" },
};
const INSURANCE_EXPERIENCE_CARD = "九格保险体验卡";
const INVENTORY_ITEM_ART: Record<string, string> = {
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

const emptyAttributes: DraftInput["attributes"] = {
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

function emptyDraft(): DraftInput {
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

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m3d-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function moneyText(money: { amount: string } | null | undefined): string {
  return money ? `${money.amount} 元` : "未配置";
}

function durationText(seconds: string | number | null | undefined): string {
  const value = typeof seconds === "string" ? Number(seconds) : seconds;
  if (!value || !Number.isFinite(value)) return "核价后显示";
  if (value % 86400 === 0) return `${value / 86400} 天`;
  if (value % 3600 === 0) return `${value / 3600} 小时`;
  if (value % 60 === 0) return `${value / 60} 分钟`;
  if (value > 60) return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
  return `${value} 秒`;
}

function stateLabel(state: string | null | undefined): string {
  return ({ DRAFT: "草稿", SUBMITTED: "审核中", WITHDRAWN: "已撤回", REJECTED: "已退回", APPROVED: "已通过", PUBLISHED: "已上架", IMPORTED_UNVERIFIED: "待复核" } as Record<string, string>)[state ?? ""] ?? "未确认";
}

function mediaReviewLabel(state: string | undefined): string {
  return ({ NOT_REQUIRED: "无需人工审核", PENDING: "技术校验中", APPROVED: "已通过技术校验", REJECTED: "未通过校验", QUARANTINED: "已隔离" } as Record<string, string>)[state ?? ""] ?? "状态待核";
}

function is3x3SafeBoxCode(code: string, displayName?: string | null): boolean {
  return code === "safe_box_3x3" || code === "3*3" || (displayName?.includes("3*3") ?? false) || (displayName?.includes("3x3") ?? false);
}

const SYSTEM_ERROR_BLOCKER_CODES = new Set<string>([
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

const FORM_ENTRY_BLOCKER_CODES = new Set<string>([
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

const extraBlockerMessages: Record<string, string> = {
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

function blockerText(code: string): string {
  if (SYSTEM_ERROR_BLOCKER_CODES.has(code)) return "系统问题，请联系客服";
  return supplyBlockerMessages[code] ?? extraBlockerMessages[code] ?? "当前暂不能继续，请检查填写内容或联系客服。";
}

function localizedErrorMessage(message: string): string {
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

function fieldErrorText(path: string, code: string): string {
  if (code === "REQUIRED" || code === "MISSING") return "请填写此项后再保存。";
  if (code === "INVALID" || code === "INVALID_VALUE" || code === "FORMAT") return "填写内容格式不正确，请按提示修改。";
  if (code === "OUT_OF_RANGE" || code === "NEGATIVE") return "数量必须是允许范围内的非负整数。";
  if (path.startsWith("inventory")) return "请填写目录要求的整数数量。";
  if (path.startsWith("entitlements")) return "请补充权益数值或有效期，未知值不能直接提交。";
  if (path.startsWith("mediaBindings")) return "请检查图片是否已上传并保存到当前资料。";
  return "请检查此项后重试。";
}

function publishGroupForPath(path: string, haffItemId?: string): PublishGroupId {
  if (path === "attributes.info_source") return "terms";
  if (path === "attributes.next_season_pass" || path === "attributes.demulan_unlocked") return "account";
  if (haffItemId && path.startsWith("inventory") && path.includes(haffItemId)) return "terms";
  const group = groupForField(path);
  if (group === "basics") return "account";
  if (group === "inventory" || group === "skins" || group === "entitlements") return "assets";
  if (group === "media") return "media";
  return "terms";
}

function isAbort(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError");
}

function meaningfulDraft(draft: DraftInput): boolean {
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

function nextMediaPosition(bindings: DraftInput["mediaBindings"]): number {
  const used = new Set(bindings.map((binding) => binding.position));
  let position = 0;
  while (used.has(position)) position += 1;
  return position;
}

function FieldError({ text, id }: { text?: string; id?: string }) {
  return text ? <span id={id} className="supply-field-error" role="alert">{text}</span> : null;
}

function inferNoticeKind(text: string): "success" | "warning" | "info" {
  if (/请先|请补|请填写|请检查|请选择|请核对|请重新|已失效|已过期|未完成|读取失败|不可采用|暂不可用|暂不能|未提供|尚未|变动|变化|需要重新|待核对|恢复原请求/.test(text)) {
    return "warning";
  }
  if (/正在读取|正在准备|已切换游戏|点击“开始修改”|原图片文件|移除|剪贴板|设为 0/.test(text)) {
    return "info";
  }
  return "success";
}

function formatHaffChineseUnit(rawM: string): string | null {
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

function Notice({ error, text, onDismiss }: { error?: SupplyRequestError | null; text?: string; onDismiss?: () => void }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
    // Keep error alerts visible until dismissed or cleared; auto-dismiss status notices only.
    if (error || !text) return;
    const timer = setTimeout(() => {
      setDismissed(true);
      onDismiss?.();
    }, 5000);
    return () => clearTimeout(timer);
  }, [text, error, onDismiss]);

  if (dismissed || (!error && !text)) return null;

  const kind = error ? "error" : inferNoticeKind(text ?? "");
  const Icon = kind === "error" ? AlertCircle : kind === "warning" ? TriangleAlert : kind === "info" ? Info : Check;

  return (
    <div
      className={`supply-notice supply-floating-notice ${error ? "is-error" : ""}`}
      data-kind={kind}
      role={error ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="supply-notice-content">
        <Icon size={18} aria-hidden="true" />
        <span>{error ? (error.status === 0 || error.status >= 500 ? "系统问题，请联系客服。" : localizedErrorMessage(error.message)) : text}</span>
      </div>
      <button
        type="button"
        className="supply-notice-close"
        onClick={() => {
          setDismissed(true);
          onDismiss?.();
        }}
        aria-label="关闭提示"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

function AgreementBody({ body }: { body: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!/<\/?[a-z][^>]*>/i.test(body)) { setText(body); return; }
    // Legacy agreements contain HTML. Parse inertly and render text only;
    // the original body remains unchanged in the signed server version.
    const doc = new DOMParser().parseFromString(body, "text/html");
    doc.querySelectorAll("script,style,iframe,object,template").forEach((node) => node.remove());
    doc.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    doc.querySelectorAll("p,h1,h2,h3,h4,li,tr").forEach((node) => node.append("\n"));
    doc.querySelectorAll("td,th").forEach((node) => node.append("\t"));
    setText(doc.body.textContent ?? "");
  }, [body]);
  return <div className="publish-terms-body">{text ?? "正在读取条款正文…"}</div>;
}

function SectionCard({ id, title, hasError, headerMeta, children, actions }: { id: PublishGroupId; title: string; hasError: boolean; headerMeta?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section id={`publish-group-${id}`} data-publish-group={id} aria-labelledby={`publish-heading-${id}`} className={`publish-section-card${hasError ? " is-error" : ""}`}>
    <header className="publish-section-header">
      <h2 id={`publish-heading-${id}`} className="publish-section-title publish-group-title">{title}</h2>
      {headerMeta}
    </header>
    <div id={`publish-panel-${id}`} className="publish-section-body">{children}</div>
    {actions}
  </section>;
}

function PublishVisualBanner() {
  return <section className="publish-visual-banner" aria-labelledby="publish-banner-title">
    <h1 id="publish-banner-title" className="sr-only">上架出租</h1>
    <picture>
      <source media="(max-width:600px)" srcSet="/art/zhouzhou/publish-banner-approved-mobile-v1.png" width={1050} height={378} />
      <img className="publish-visual-banner-image" src="/art/zhouzhou/publish-banner-approved-v1.png" width={2141} height={251} alt="填写资料，核对报价后确认上架。流程：填写资料、核对报价、确认上架。" fetchPriority="high" decoding="async" />
    </picture>
  </section>;
}

function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <TooltipPrimitive.Provider delayDuration={180}>
    <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger asChild><button type="button" className="publish-field-help" aria-label={`${label}说明`} onClick={event => { event.preventDefault(); setOpen(previous => !previous); }}><CircleHelp size={17} aria-hidden="true" /></button></TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal><TooltipPrimitive.Content className="app-tooltip-content publish-field-help-popup" sideOffset={7}>{children}</TooltipPrimitive.Content></TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  </TooltipPrimitive.Provider>;
}

function PendingValue({ label = "待填" }: { label?: string }) {
  return <span className="publish-pending-value"><span aria-hidden="true">—</span><span className="sr-only">{label}</span></span>;
}

const NOTICE_READ_KEY = "zzsh_supply_notice_read:v1";

// Same shadcn/Base UI composition and theme tokens as the existing form controls.
function PublishingNotice({
  open,
  onClose,
  agreement,
  returnFocus,
  manual = false,
}: {
  open: boolean;
  onClose: () => void;
  agreement: PublishingOptions["agreement"] | null;
  returnFocus?: () => HTMLElement | null;
  manual?: boolean;
}) {
  const notice = usePublicContent("placement:PUBLISH_NOTICE");
  const noticeTitle = notice.resource?.payload?.kind === "notice" ? notice.resource.payload.title : "出租上架须知";
  const isReadStored = useCallback(() => {
    if (manual) return true;
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem(NOTICE_READ_KEY) === "1";
    } catch {
      return false;
    }
  }, [manual]);

  const [seconds, setSeconds] = useState(() => (isReadStored() ? 0 : 5));
  const [agreementOpen, setAgreementOpen] = useState(false);
  const read = useRef(isReadStored());
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    if (isReadStored() || read.current) {
      setSeconds(0);
      return;
    }
    const deadline = window.performance.now() + 5000;
    setSeconds(5);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - window.performance.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) {
        read.current = true;
        window.clearInterval(timer);
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [open, isReadStored]);

  const handleConfirmClose = () => {
    try {
      window.sessionStorage.setItem(NOTICE_READ_KEY, "1");
    } catch {}
    read.current = true;
    onClose();
  };

  return <Dialog.Root open={open} disablePointerDismissal onOpenChange={(next, event) => {
    if (!next && seconds > 0) event.cancel();
    else if (!next) handleConfirmClose();
  }}>
    <Dialog.Portal><Dialog.Backdrop className="modal-overlay publish-dialog-backdrop" />
      <Dialog.Popup className="publish-dialog publish-reading-dialog" data-slot="dialog-content" initialFocus={titleRef} finalFocus={returnFocus ?? (() => document.querySelector<HTMLElement>(".publish-outline a"))}>
        <header className="publish-reading-header">
          <ShieldCheck size={26} aria-hidden="true" />
          <div>
            <Dialog.Title ref={titleRef} tabIndex={-1}>{noticeTitle}</Dialog.Title>
            <Dialog.Description>保障账号权益，先了解以下规则。</Dialog.Description>
          </div>
          <Dialog.Close className="publish-reading-close" aria-label="关闭上架须知" disabled={seconds > 0} onClick={handleConfirmClose}><X size={20} aria-hidden="true" /></Dialog.Close>
        </header>
        <div className="publish-reading-body">
          <ManagedNoticeSections contentKey="placement:PUBLISH_NOTICE" />
          <div className="publish-notice-specs-card">
            <div className="publish-specs-card-title">
              <Box size={16} aria-hidden="true" />
              <h4>物资申报与计量口径</h4>
            </div>
            <div className="publish-specs-grid">
              <div className="publish-spec-item">
                <span className="publish-spec-label">安全箱与保险</span>
                <span className="publish-spec-desc">安全箱填写赛季永久容量 · {INSURANCE_EXPERIENCE_CARD}另填可用天数</span>
              </div>
              <div className="publish-spec-item">
                <span className="publish-spec-label">计量单位换算</span>
                <span className="publish-spec-desc">六级子弹 <strong>1 组 = 60 发</strong> · AWM/巴雷特<strong>按发</strong> · {INSURANCE_EXPERIENCE_CARD}<strong>按天</strong></span>
              </div>
              <div className="publish-spec-item">
                <span className="publish-spec-label">物资数量默认按 0 申报</span>
                <span className="publish-spec-desc">
                  所有可填物资默认初始化为 <span className="publish-spec-pill publish-spec-pill--zero">0</span>，请将账号实际拥有的物资修改为真实整数数量
                </span>
              </div>
            </div>
          </div>
          <div className="publish-reading-tip">
            <Info size={15} aria-hidden="true" />
            <span>备注向租客公开展示，请勿填写密码、验证码等敏感信息。</span>
          </div>
        </div>
        <footer className="publish-reading-footer">
          <Dialog.Root open={agreementOpen} onOpenChange={setAgreementOpen}>
            <div className="publish-reading-agreement-row"><span>交易规则与协议</span><Dialog.Trigger className="publish-reading-agreement-link" disabled={!agreement}>查看《出租交易须知》<ArrowRight size={16} aria-hidden="true" /></Dialog.Trigger></div>
            {!agreement ? <p>交易协议暂未读取，核价前请确认当前规则已加载。</p> : null}
            <Dialog.Portal><Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-agreement-backdrop" /><Dialog.Popup className="publish-dialog publish-agreement-dialog" data-slot="dialog-content">
              <header><Dialog.Title>{agreement?.title ?? "出租交易须知"}</Dialog.Title><Dialog.Close className="publish-reading-close" aria-label="关闭交易须知"><X size={20} aria-hidden="true" /></Dialog.Close></header>
              <Dialog.Description>当前读取的协议正文；阅读不会自动同意条款，上架前仍需确认本次报价对应的协议。</Dialog.Description>
              {agreement ? <AgreementBody body={agreement.body} /> : <p>暂未取得协议正文。</p>}
              <Dialog.Close className="button secondary">返回上架须知</Dialog.Close>
            </Dialog.Popup></Dialog.Portal>
          </Dialog.Root>
          <p>阅读须知不代表接受本次报价，上架前仍需单独确认。</p><Dialog.Close className="button primary" disabled={seconds > 0} onClick={handleConfirmClose}>{seconds > 0 ? `请阅读须知（${seconds} 秒）` : notice.status === "error" ? "返回填写" : "我已了解，开始填写"}</Dialog.Close>
        </footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function LoginPlatformIcon({ code }: { code: string }) {
  const platform = ({
    legacy_login_qq: "tencentqq",
    login_qq_qr: "tencentqq",
    legacy_login_wechat: "wechat",
    legacy_login_steam_cn: "steam",
    legacy_login_steam_global: "steam",
  } as Record<string, string>)[code] ?? (code.includes("qq") ? "tencentqq" : undefined);
  return platform ? <img className="publish-login-platform-icon" src={`/images/login-platforms/${platform}.svg`} width={20} height={20} alt="" /> : <LogIn size={20} />;
}

function InventoryIcon({ code }: { code: string | null }) {
  const canonical = canonicalResourceCode(code);
  const art = INVENTORY_ITEM_ART[canonical ?? ""] ?? (code ? INVENTORY_ITEM_ART[code] : undefined);
  if(art)return <img src={art} width={48} height={48} alt="" decoding="async" />;
  const Icon = canonical === "df_billable_coffee" ? Bean
    : canonical === "df_billable_level6_armor" ? Shield
    : canonical === "df_billable_level6_helmet" ? HardHat
    : canonical === "df_billable_level6_bullet" || canonical === "df_billable_awm_bullet" || code === "barrett_round" || code === "df_billable_barrett_bullet" ? Crosshair
    : code === "df_billable_top_insure_card" || code === "top_insure_card_piece" || code === "df_billable_top_insure_card_piece" ? Ticket : Box;
  return <Icon size={22} aria-hidden="true" />;
}

function retiredInsuranceCode(code: string | null | undefined): boolean {
  return code === "top_insure_card_piece" || code === "df_billable_top_insure_card_piece";
}

function numericChoiceOptions(current: string, values: number[], suffix = "级") {
  const known = new Set(values.map(String));
  return [
    ...(current && !known.has(current) ? [{ value: current, label: `${current}${suffix}（历史原值）`, disabled: true }] : []),
    ...values.map((value) => ({ value: String(value), label: `${value}${suffix}` })),
  ];
}

function retainedNumericChoiceNote(current: string, values: readonly number[], name: string): string | null {
  if (!current || values.includes(Number(current))) return null;
  return `${name}保留了${current}级历史原值；新申报请选择 ${values[0]}–${values[values.length - 1]} 级。`;
}

function serviceTimeOptions(values: readonly number[], current: number | null) {
  const options = values.map((value) => ({ value: String(value), label: formatServiceWindowMinute(value) }));
  if (current !== null && !values.includes(current)) {
    options.unshift({ value: String(current), label: `${formatServiceWindowMinute(current)}（历史原值）` });
  }
  return options;
}

function RegionPicker({
  province,
  city,
  options,
  disabled,
  required = false,
  error,
  onChange,
}: {
  province: string;
  city: string;
  options: ReadonlyArray<RegionOption>;
  disabled: boolean;
  required?: boolean;
  error?: string;
  onChange: (province: string | null, city: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeProvince, setActiveProvince] = useState(province);
  const searchRef = useRef<HTMLInputElement>(null);
  const provincesRef = useRef<HTMLDivElement>(null);
  const pairs = [...options, ...(province && city && !options.some((item) => item.province === province && item.city === city) ? [{ province, city }] : [])];
  const provinces = [...new Set(pairs.map((item) => item.province))];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProvinces = provinces.filter((item) => !normalizedQuery || item.toLocaleLowerCase().includes(normalizedQuery) || pairs.some((pair) => pair.province === item && pair.city.toLocaleLowerCase().includes(normalizedQuery)));
  const current = visibleProvinces.includes(activeProvince) ? activeProvince : visibleProvinces[0] ?? "";
  const cities = pairs.filter((item) => item.province === current && (!normalizedQuery || current.toLocaleLowerCase().includes(normalizedQuery) || item.city.toLocaleLowerCase().includes(normalizedQuery))).map((item) => item.city);
  const hasSelected = Boolean(province && city);
  const selected = hasSelected ? `${province} · ${city}` : "请选择省份和城市";

  useEffect(() => {
    if (province) setActiveProvince(province);
  }, [province]);

  return <div id="publish-region" tabIndex={-1} className="publish-region-field">
    <span className="publish-region-label">地区选择{required ? <span className="publish-required-mark">必填</span> : null}</span>
    <div className={`publish-region-control${hasSelected ? " has-selection" : ""}`}>
      <Popover.Root
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery("");
          else if (province) setActiveProvince(province);
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className="publish-region-trigger"
            data-selected={hasSelected ? "true" : "false"}
            disabled={disabled}
            aria-invalid={Boolean(error) || undefined}
            aria-label="地区选择"
          >
            <MapPin size={16} aria-hidden="true" />
            <span>{selected}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="publish-region-popover"
            aria-label="选择地区"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
              const activeBtn = provincesRef.current?.querySelector<HTMLElement>('[data-active="true"]');
              if (typeof activeBtn?.scrollIntoView === "function") {
                activeBtn.scrollIntoView({ block: "nearest" });
              }
            }}
          >
            <div className="publish-region-search">
              <Search size={15} aria-hidden="true" />
              <label className="sr-only" htmlFor="publish-region-search-input">搜索省份或城市</label>
              <input
                id="publish-region-search-input"
                ref={searchRef}
                type="search"
                value={query}
                placeholder="搜索省份或城市"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  className="publish-region-search-clear"
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {visibleProvinces.length ? (
              <div className="publish-region-columns">
                <div ref={provincesRef} className="publish-region-provinces" role="group" aria-label="选择省份">
                  {visibleProvinces.map((item) => (
                    <button
                      type="button"
                      key={item}
                      aria-pressed={item === current}
                      data-active={item === current}
                      data-has-selected={hasSelected && province === item ? "true" : undefined}
                      onClick={() => setActiveProvince(item)}
                    >
                      <span>{item}</span>
                      {hasSelected && province === item ? <i className="publish-region-province-dot" aria-hidden="true" /> : null}
                    </button>
                  ))}
                </div>
                <div className="publish-region-cities" role="group" aria-label={`${current}城市`}>
                  <div className="publish-region-cities-head">
                    <strong>{current || "城市"}</strong>
                    <small>{cities.length} 个地区</small>
                  </div>
                  <div className="publish-region-cities-grid">
                    {cities.map((item) => {
                      const isSelected = province === current && city === item;
                      return (
                        <button
                          type="button"
                          key={`${current}-${item}`}
                          data-selected={isSelected}
                          onClick={() => {
                            onChange(current, item);
                            setOpen(false);
                            setQuery("");
                          }}
                        >
                          <span>{item}</span>
                          {isSelected ? <Check size={13} aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <p className="publish-region-empty" role="status">未找到匹配的省份或城市</p>
            )}
            {hasSelected ? (
              <div className="publish-region-footer">
                <span className="publish-region-footer-current">已选：<strong>{province} · {city}</strong></span>
                <button
                  type="button"
                  className="publish-region-clear"
                  onClick={() => {
                    onChange(null, null);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  清除当前地区
                </button>
              </div>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {hasSelected ? (
        <button
          type="button"
          className="publish-region-inline-clear"
          aria-label={`移除地区 ${province} ${city}`}
          title="清除已选地区"
          disabled={disabled}
          onClick={() => onChange(null, null)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
    <FieldError text={error} />
  </div>;
}

export function PublishForm({ mode, gameCode: gameCodeProp, accountId: accountIdProp, editRequested = false }: PublishFormProps) {
  const router = useRouter();
  const sharedSession = useUserSessionStore();
  const fastLocked = mode === "fast";
  const mounted = useRef(true);
  const identityRef = useRef<SessionId>(undefined);
  const identityStatusRef = useRef<IdentityState>("checking");
  const identityPauseGate = useRef(new IdentityPauseGate());
  const epochRef = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const pendingKeys = useRef(new Map<string, { fingerprint: string; key: string }>());
  const lastRetry = useRef<RetryTask | null>(null);
  const accountRef = useRef<string | undefined>(accountIdProp);
  const loadedAccountRef = useRef<string | undefined>(undefined);
  const routeAccountRef = useRef<string | undefined>(accountIdProp);
  const gameRef = useRef("");
  const gamesRef = useRef<SupplyGame[]>([]);
  const skinRequestRef = useRef(0);
  const skinQueryRef = useRef<{ gameId: string; key: string; query: SkinQuery }>({ gameId: "", key: "", query: {} });
  const skinSearchTimerRef = useRef<number | null>(null);
  const skinFiltersRef = useRef<SkinQuery>({});
  const liveRatioRangesRef = useRef<Partial<Record<RentalMode, Parameters<typeof ratioEntryProblem>[3]>> | null>(null);
  const zeroInitKeyRef = useRef("");
  const clearSkinSearchTimer = useCallback(() => {
    if (skinSearchTimerRef.current !== null) {
      window.clearTimeout(skinSearchTimerRef.current);
      skinSearchTimerRef.current = null;
    }
  }, []);
  const supplyRef = useRef<MySupply | null>(null);
  const quoteCatalogBinding = useRef<{ token: string; catalogRevision: string } | null>(null);
  const draftRef = useRef<DraftInput>(emptyDraft());
  const serviceWindowCache = useRef<Pick<DraftInput["attributes"], "service_window_start_minute" | "service_window_end_minute" | "service_window_cross_midnight" | "service_window_timezone"> | null>(null);
  const uploadQueue = useRef(Promise.resolve());
  const cancelledMedia = useRef(new Set<string>());
  const formRef = useRef<HTMLFormElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const [railExpanded, setRailExpanded] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<{ url: string; title: string } | null>(null);
  useEffect(() => {
    const open = () => { if (window.location.hash === "#publish-quote") setRailExpanded(true); };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  const scrollPositionRef = useRef(0);
  useEffect(() => {
    const onVisibility = () => {
      if (typeof document === "undefined" || typeof window === "undefined") return;
      if (document.hidden) {
        scrollPositionRef.current = window.scrollY;
      } else if (scrollPositionRef.current > 0) {
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: scrollPositionRef.current, behavior: "instant" as ScrollBehavior });
        });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const pasteGuardRef = useRef<{ blocked: boolean; hasBanRecord: boolean; acceptFiles: ((category: MediaCategory, files: File[]) => void) | null }>({
    blocked: true,
    hasBanRecord: false,
    acceptFiles: null,
  });
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const state = pasteGuardRef.current;
      if (state.blocked || !state.acceptFiles) return;
      const active = document.activeElement as HTMLElement | null;
      const isTextField = Boolean(
        active && (
          active.tagName === "TEXTAREA" ||
          active.isContentEditable ||
          (active.tagName === "INPUT" && !["file", "checkbox", "radio", "button", "submit", "reset"].includes((active as HTMLInputElement).type))
        ),
      );
      if (isTextField && Boolean(event.clipboardData?.getData("text/plain"))) return;
      const items = Array.from(event.clipboardData?.items ?? []);
      const files = items
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      if (!files.length) return;
      event.preventDefault();
      const targetCategory: MediaCategory = state.hasBanRecord && document.activeElement?.closest("#publish-media-penalty")
        ? "PENALTY"
        : "SHOWCASE";
      state.acceptFiles(targetCategory, files);
      setNotice(`已从剪贴板添加 ${files.length} 张截图，正在上传…`);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
  const noticeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const noticeManualRef = useRef(false);
  const correctedAccountGameRef = useRef("");
  const ammoReviewRef = useRef<AmmoReview | null>(null);
  const confirmedAmmoRef = useRef<AmmoReview | null>(null);
  const ammoFocusRef = useRef<HTMLElement | null>(null);
  const [ammoReview, setAmmoReview] = useState<AmmoReview | null>(null);

  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const [gameId, setGameId] = useState("");
  const [identityState, setIdentityState] = useState<IdentityState>("checking");
  const [accountId, setAccountId] = useState<string | undefined>(accountIdProp);
  const [supply, setSupply] = useState<MySupply | null>(null);
  const [draft, setDraftState] = useState<DraftInput>(emptyDraft);
  const [pendingResourceInputs,setPendingResourceInputs]=useState<Record<string,string>>({});
  const [ownerIncomePreviewSnapshot,setOwnerIncomePreview]=useState<{ value: OwnerIncomePreview; scopeKey: string; inputKey: string } | null>(null);
  const [ownerIncomePreviewPending,setOwnerIncomePreviewPending]=useState(false);
  const [serviceWindowCustomSelected, setServiceWindowCustomSelected] = useState(false);
  const [options, setOptions] = useState<PublishingOptions | null>(null);
  const [optionsAvailability, setOptionsAvailability] = useState<OptionsAvailability>("pending");
  const [catalog, setCatalog] = useState<PublishingCatalog | null>(null);
  const [catalogAvailability, setCatalogAvailability] = useState<CatalogAvailability>("pending");
  const [knownSkins, setKnownSkins] = useState<Record<string, PublishingCatalog["skins"][number] & { catalogRevision: string }>>({});
  const [skinCatalogRevision, setSkinCatalogRevision] = useState<{ gameId: string; revision: string } | null>(null);
  const [skinQuery, setSkinQuery] = useState("");
  const [skinCategory, setSkinCategory] = useState("");
  const [skinRarity, setSkinRarity] = useState("");
  const [skinOwner, setSkinOwner] = useState("");
  const [skinPagePending, setSkinPagePending] = useState(false);
  const [skinPageFailed, setSkinPageFailed] = useState<"replace" | "append" | null>(null);
  const [media, setMedia] = useState<MediaEntry[]>([]);
  const [mediaDropActive, setMediaDropActive] = useState<MediaCategory | null>(null);
  const [dragMediaId, setDragMediaId] = useState<string | null>(null);
  const [dragOverMediaId, setDragOverMediaId] = useState<string | null>(null);
  const [editing, setEditing] = useState(!accountIdProp);
  const [authRequired, setAuthRequired] = useState(false);
  const [loadingAccount, setLoadingAccount] = useState(Boolean(accountIdProp));
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<SupplyRequestError | null>(null);
  const [activeGroup, setActiveGroup] = useState<PublishGroupId>("account");

  useEffect(() => {
    const groups: PublishGroupId[] = ["account", "assets", "media", "terms"];
    const handleScroll = () => {
      const headerOffset = 140;
      for (let i = groups.length - 1; i >= 0; i--) {
        const grp = groups[i];
        if (!grp) continue;
        const el = document.getElementById(`publish-group-${grp}`);
        if (el) {
          const top = el.getBoundingClientRect().top;
          if (top <= headerOffset + 80) {
            setActiveGroup(grp);
            return;
          }
        }
      }
      setActiveGroup("account");
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined" || window.innerWidth >= 1200) return;
    const node = document.querySelector<HTMLElement>(`#publish-outline a[href="#publish-group-${activeGroup}"]`);
    const track = node?.closest<HTMLElement>(".publish-timeline-track");
    if (!node || !track) return;
    const left = Math.max(0, node.offsetLeft - Math.max(0, (track.clientWidth - node.clientWidth) / 2));
    track.scrollTo({ left, behavior: "smooth" });
  }, [activeGroup]);
  const [serverSnapshot, setServerSnapshot] = useState<MySupply | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [readingNotice, setReadingNotice] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.sessionStorage.getItem(NOTICE_READ_KEY) !== "1";
    } catch {
      return true;
    }
  });
  const handleNoticeClose = () => {
    try {
      window.sessionStorage.setItem(NOTICE_READ_KEY, "1");
    } catch {}
    setReadingNotice(false);
  };
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent | null>(null);
  const routeGameApproval = useRef<string | null>(null);
  const [routeSwitch, setRouteSwitch] = useState(0);
  const leavingRef = useRef(false);
  const navigationFocusRef = useRef<HTMLElement | null>(null);
  const [agreementChecked, setAgreementChecked] = useState(false);
  const [termsModalOpen, setTermsModalOpen] = useState(false);
  const [payoutTermsModalOpen, setPayoutTermsModalOpen] = useState(false);
  const [payoutTerms, setPayoutTerms] = useState<{ target: string; terms: FullPayoutTerms | null; status: "loading" | "ready" | "unavailable" } | null>(null);
  const [payoutAccepted, setPayoutAccepted] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [publishSuccessOpen, setPublishSuccessOpen] = useState(false);
  const [successCountdown, setSuccessCountdown] = useState(5);
  useEffect(() => {
    if (!publishSuccessOpen) return;
    setSuccessCountdown(5);
    const interval = window.setInterval(() => {
      setSuccessCountdown((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval);
          router.push("/account?view=accounts");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [publishSuccessOpen, router]);
  const [quoteStale, setQuoteStale] = useState(false);
  const [depositInput, setDepositInput] = useState("");
  const [haffInput, setHaffInput] = useState("");
  const [recommendation, setRecommendation] = useState<DepositRecommendation | null>(null);
  const [recommendationBinding, setRecommendationBinding] = useState<RecommendationBinding | null>(null);
  const [recommendationAdopted, setRecommendationAdopted] = useState(false);
  const [recommendationBusy, setRecommendationBusy] = useState(false);
  const [writeIntent, setWriteIntentState] = useState<WriteIntent | null>(null);
  const writeIntentRef = useRef<WriteIntent | null>(null);
  const storedIntentRef = useRef<SupplyWriteIntent | null>(null);
  const restoredSubjectRef = useRef<string | null>(null);
  const [intentStorageIssue, setIntentStorageIssue] = useState("");
  const [intentRestoreVersion, setIntentRestoreVersion] = useState(0);

  useEffect(() => { accountRef.current = accountId; }, [accountId]);
  useEffect(() => { gameRef.current = gameId; }, [gameId]);
  useEffect(() => { supplyRef.current = supply; }, [supply]);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const beginRequest = () => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  };
  const finishRequest = (controller: AbortController) => controllers.current.delete(controller);
  const current = (epoch: number, signal?: AbortSignal) => mounted.current && epoch === epochRef.current && !signal?.aborted;
  const currentContext = useCallback((context: RequestContext, signal?: AbortSignal) =>
    current(context.epoch, signal) && identityRef.current === context.identity && gameRef.current === context.gameId &&
    (context.accountId === undefined || accountRef.current === context.accountId), []);
  const waitForIdentity = useCallback((context: RequestContext) =>
    identityPauseGate.current.wait(() => currentContext(context)), [currentContext]);
  const captureContext = (selectedAccount = accountRef.current, selectedGame = gameId): RequestContext => ({
    epoch: epochRef.current,
    identity: identityRef.current,
    accountId: selectedAccount,
    gameId: selectedGame,
  });
  const setIdentityPhase = (next: IdentityState) => {
    identityStatusRef.current = next;
    setIdentityState(next);
  };
  const ownsWriteIntent = (context: RequestContext, record: SupplyWriteIntent) => currentContext(context) &&
    writeIntentRef.current?.context.epoch === context.epoch && sameSupplyIntent(writeIntentRef.current?.persisted, record);
  const ownsStoredWrite = (context: RequestContext, record: SupplyWriteIntent) => ownsWriteIntent(context, record) && sameSupplyIntent(storedIntentRef.current, record);
  const setWritePending = (intent: WriteIntent | null): boolean => {
    const currentIntent = writeIntentRef.current;
    if (!mounted.current || (intent ? !currentContext(intent.context) : currentIntent && !currentContext(currentIntent.context))) return false;
    if (intent && !intent.persisted) {
      const record = storedIntentRef.current;
      if (record && record.userId === intent.context.identity && record.gameId === intent.context.gameId) intent = { ...intent, persisted: record };
    }
    if (intent?.persisted && !sameSupplyIntent(storedIntentRef.current, intent.persisted)) return false;
    if (!intent && storedIntentRef.current && !sameSupplyIntent(currentIntent?.persisted, storedIntentRef.current)) return false;
    if (!intent && storedIntentRef.current?.phase === "accepted") {
      if (!clearSupplyIntent(storedIntentRef.current)) throw new SupplyIntentStorageError();
      storedIntentRef.current = null;
    }
    writeIntentRef.current = intent;
    setWriteIntentState(intent);
    return true;
  };
  const writePersisted = async <T,>(action: SupplyWriteAction, context: RequestContext, body: Record<string, unknown>, key: string, send: () => Promise<T>): Promise<T> => {
    context = Object.freeze({ ...context });
    if (!currentContext(context) || !context.identity) throw new SupplyIntentStorageError();
    let record: SupplyWriteIntent;
    try {
      record = prepareSupplyIntent({ userId: context.identity, gameId: context.gameId, accountId: context.accountId ?? null, action, key, body });
      setIntentStorageIssue("");
    } catch (failure) {
      setIntentStorageIssue(failure instanceof Error ? failure.message : "无法保留操作记录，暂不能提交。");
      throw failure;
    }
    storedIntentRef.current = record;
    setWritePending({ action, context, persisted: record, run: () => recoverStoredIntent(record) });
    let outcome = record;
    try {
      const result = await send();
      const value = result as { accountId?: string; account?: { id: string; revision: string }; version?: { id: string } | null; assetId?: string; purpose?: string; reviewState?: string } | null;
      if (!value) return result;
      const accountId = value.account?.id ?? value.accountId ?? context.accountId;
      if (!accountId) throw new SupplyRequestError(502, null, key);
      const receipt: SupplyWriteReceipt = { accountId,
        ...(value.account ? { revision: value.account.revision } : {}), ...(value.version ? { versionId: value.version.id } : {}),
        ...(value.assetId ? { assetId: value.assetId, purpose: value.purpose, reviewState: value.reviewState } : {}),
      };
      outcome = { ...record, phase: "accepted", receipt };
      // A late response still belongs to its original stored responsibility.
      try { outcome = acceptSupplyIntent(record, receipt); }
      catch (failure) {
        if (ownsStoredWrite(context, record)) { storedIntentRef.current = outcome; setIntentStorageIssue("操作已返回，但恢复记录未能更新；请保留本页并重试读取结果。"); }
        throw failure;
      }
      if (!ownsStoredWrite(context, record)) throw new DOMException("Superseded supply response", "AbortError");
      storedIntentRef.current = outcome;
      return result;
    } catch (failure) {
      let cleared = false;
      if (outcome.phase !== "accepted" && !isAbort(failure)) {
        try {
          const persisted = loadSupplyIntent(record.userId);
          if (!persisted || !sameSupplyIntent(persisted, record)) throw new SupplyIntentStorageError();
          outcome = persisted;
          if (persisted.phase !== "accepted") {
            if (uncertainSupplyWriteFailure(failure)) outcome = retainUncertainSupplyIntent(record);
            else if (!persisted.uncertain) { if (!clearSupplyIntent(record)) throw new SupplyIntentStorageError(); cleared = true; }
          }
        } catch (storageFailure) {
          if (ownsStoredWrite(context, record)) setIntentStorageIssue("原操作记录暂不可更新；请保留本页并重试恢复。");
          throw storageFailure;
        }
      }
      if (ownsStoredWrite(context, record)) {
        storedIntentRef.current = cleared ? null : outcome;
        if (cleared) setWritePending(null);
      }
      throw failure;
    }
  };
  const rememberWrite = (intent: WriteIntent) => {
    if (currentContext(intent.context)) setWritePending(intent);
  };
  const recoverStoredIntent = async (initial: SupplyWriteIntent): Promise<boolean> => {
    if (["pause", "resume", "withdraw", "delist"].includes(initial.action)) {
      setNotice("有一笔账号操作待核对，请返回上架账号查询原操作结果；本页不会重发或清除它。");
      return false;
    }
    if (identityRef.current !== initial.userId || identityStatusRef.current !== "confirmed" || gameRef.current !== initial.gameId) return false;
    const persisted = loadSupplyIntent(initial.userId), memory = storedIntentRef.current;
    if (!persisted || !sameSupplyIntent(persisted, initial) || !sameSupplyIntent(memory, initial)) return false;
    let record = persisted.phase === "accepted" ? persisted : memory?.phase === "accepted" ? memory : persisted;
    const target = record.receipt?.accountId ?? record.accountId ?? undefined;
    if (target && accountRef.current && target !== accountRef.current) return false;
    if (target) { accountRef.current = target; loadedAccountRef.current = target; setAccountId(target); }
    const context = captureContext(target, record.gameId), controller = beginRequest();
    try {
      if (!ownsStoredWrite(context, record) || !(await waitForIdentity(context)) || !ownsStoredWrite(context, record)) return false;
      let next: MySupply | null = null;
      if (record.phase === "accepted" && record.receipt) storedIntentRef.current = acceptSupplyIntent(record, record.receipt);
      if (record.phase === "pending") {
        const body = record.body;
        switch (record.action) {
          case "create-account": {
            const created = await writePersisted(record.action, context, body, record.key, () => supplyApi.createAccount(record.gameId, record.key, controller.signal));
            if (!ownsStoredWrite(context, record)) return false;
            accountRef.current = created.accountId; loadedAccountRef.current = created.accountId; setAccountId(created.accountId);
            break;
          }
          case "create-draft": next = await writePersisted(record.action, context, body, record.key, () => supplyApi.createDraft(target!, String(body.expectedRevision), record.key, controller.signal)); break;
          case "save-draft": next = await writePersisted(record.action, context, body, record.key, () => supplyApi.saveDraft(target!, body as unknown as DraftInput & { expectedRevision: string }, record.key, controller.signal)); break;
          case "quote": next = await writePersisted(record.action, context, body, record.key, () => supplyApi.quote(target!, String(body.expectedRevision), record.key, controller.signal)); break;
          case "accept-rules": case "submit": next = await writePersisted(record.action, context, body, record.key, () => supplyApi.confirm(target!, record.action as "accept-rules" | "submit", body as { expectedRevision: string; versionId: string; releaseId: string; contentHash: string }, record.key, controller.signal)); break;
          case "media": setNotice("原图片文件没有保留，不能在此页重新上传。请在原标签页恢复，或联系平台核对原上传结果；已保留原操作记录。"); return false;
        }
        if (!ownsStoredWrite(context, record)) return false;
        record = storedIntentRef.current!;
      }
      // A recorded successful write is never POSTed again to repair a failed readback.
      if (!next) next = await supplyApi.mine(record.receipt?.accountId ?? target!, controller.signal);
      if (!ownsStoredWrite(context, record) || controller.signal.aborted || !(await waitForIdentity(context)) || !ownsStoredWrite(context, record) || !sameSupplyIntent(loadSupplyIntent(record.userId), record)) return false;
      if (next.account.id !== (record.receipt?.accountId ?? target) || next.account.game_id !== record.gameId) throw new SupplyRequestError(502, null, record.key);
      applySupply(next, record.action !== "submit", true);
      setServerSnapshot(next); setDraftDirty(false);
      if (record.action === "accept-rules") setRulesAccepted(true);
      if (record.action === "submit") setEditing(false);
      if (record.action === "media" && record.receipt?.assetId) {
        const assetId = record.receipt.assetId, category = record.body.category as MediaCategory;
        const purpose: MediaPurpose = record.body.purpose === "ACCOUNT_EVIDENCE" ? "ACCOUNT_EVIDENCE" : "ACCOUNT_DISPLAY";
        setDraft((previous) => previous.mediaBindings.some(row => row.assetId === assetId) ? previous : { ...previous, mediaBindings: [...previous.mediaBindings, { assetId, position: nextMediaPosition(previous.mediaBindings), category }] });
        setMedia(previous => previous.some(row => row.assetId === assetId) ? previous : [...previous, { id: `recovered-${assetId}`, assetId, purpose, category, reviewState: record.receipt?.reviewState, status: "bound", bindingSaved: false, intentKey: record.key, uploadKey: String(record.body.uploadKey), context, previewUrl: mediaAccessUrl(assetId) }]);
      }
      if (!setWritePending(null)) return false;
      setIntentStorageIssue("");
      setNotice(record.action === "save-draft" ? "草稿已保存，已恢复原操作结果。请核对资料后继续。" : "已恢复原操作结果，请核对当前资料后继续。");
      return true;
    } finally { finishRequest(controller); }
  };
  const haffQuantityOf = (value: MySupply): string | null => {
    const haff = (value.version?.catalogItems ?? []).find((item) => item.unit === "HAFF_BASE");
    if (!haff) return null;
    return value.version?.declaration.inventory.find((row) => row.itemId === haff.id)?.quantity ?? null;
  };
  const syncHaffInput = (value: MySupply) => {
    setHaffInput(haffMInputFromBase(haffQuantityOf(value) ?? ""));
  };
  const invalidateContext = useCallback((message: string, requireAuth: boolean, resetGame = true) => {
    ammoReviewRef.current = null;
    confirmedAmmoRef.current = null;
    setAmmoReview(null);
    storedIntentRef.current = null;
    restoredSubjectRef.current = null;
    setIntentStorageIssue("");
    setNavigationIntent(null);
    routeGameApproval.current = null;
    epochRef.current += 1;
    identityPauseGate.current.cancelWaiters();
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    pendingKeys.current.clear();
    lastRetry.current = null;
    writeIntentRef.current = null;
    setWriteIntentState(null);
    uploadQueue.current = Promise.resolve();
    accountRef.current = undefined;
    loadedAccountRef.current = undefined;
    supplyRef.current = null;
    draftRef.current = emptyDraft();
    serviceWindowCache.current = null;
    setServiceWindowCustomSelected(false);
    setAccountId(undefined);
    setSupply(null);
    setDraftState(emptyDraft());
    setPendingResourceInputs({});
    setOwnerIncomePreview(null);
    setDepositInput("");
    setHaffInput("");
    setRecommendation(null);
    setRecommendationBinding(null);
    setRecommendationAdopted(false);
    setMedia((previous) => {
      for (const item of previous) if (item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
    cancelledMedia.current.clear();
    setEditing(false);
    setServerSnapshot(null);
    setDraftDirty(false);
    setAgreementChecked(false);
    setRulesAccepted(false);
    setQuoteStale(false);
    setBusy("");
    setAuthRequired(requireAuth);
    setError(null);
    setNotice(message);
    setLoadingAccount(false);
    setLoadingCatalog(false);
    if (resetGame) {
      gameRef.current = "";
      gamesRef.current = [];
      setGameId("");
      setGames([]);
      setOptions(null);
      setOptionsAvailability("pending");
      setCatalog(null);
      setCatalogAvailability("pending");
      setKnownSkins({}); setSkinCatalogRevision(null);
      skinQueryRef.current = { gameId: "", key: "", query: {} };
    }
  }, []);
  const applySupply = useCallback((next: MySupply, loadDraft: boolean, replaceMedia = false) => {
    supplyRef.current = next;
    setSupply(next);
    if (next.version?.quote) setQuoteStale(false);
    if (loadDraft && next.version) {
      const nextDraft = editableDeclaration(next.version.declaration);
      draftRef.current = nextDraft;
      setDraftState(nextDraft);
      setDepositInput(yuanFromCents(depositDeclarationCents(nextDraft.attributes) ?? "") ?? "");
      syncHaffInput(next);
      setEditing(next.version.reviewState === "DRAFT" && !["ARCHIVED", "DELISTED"].includes(next.account.lifecycle ?? "") && !next.version.publication && !next.blockers?.includes("LEGACY_LISTING_RELIST_REQUIRED"));
    }
    if (replaceMedia) {
      const bindings = next.version?.declaration.mediaBindings ?? [];
      setMedia((previous) => {
        for (const item of previous) if (item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
        return bindings.map((binding, index) => ({
          id: `bound-${binding.assetId}-${index}`,
          purpose: binding.purpose,
          category: binding.category ?? (binding.purpose === "ACCOUNT_EVIDENCE" ? "PENALTY" : "SHOWCASE"),
          reviewState: binding.reviewState,
          publicDisplayEligible: binding.publicDisplayEligible,
          publiclyReadable: binding.publiclyReadable,
          assetId: binding.assetId,
          previewUrl: mediaAccessUrl(binding.assetId),
          bindingSaved: true,
          context: { epoch: epochRef.current, identity: identityRef.current, accountId: next.account.id, gameId: next.account.game_id },
          status: "bound",
          intentKey: "",
          uploadKey: "",
        }));
      });
    } else if (next.version?.declaration.mediaBindings) {
      const savedIds = new Set(next.version.declaration.mediaBindings.map((binding) => binding.assetId));
      setMedia((previous) => previous.map((item) => item.assetId ? { ...item, bindingSaved: savedIds.has(item.assetId) } : item));
    }
  }, []);

  const keyFor = (operation: string, body: unknown): string => {
    const fingerprint = JSON.stringify(body);
    const previous = pendingKeys.current.get(operation);
    if (previous?.fingerprint === fingerprint) return previous.key;
    const key = newKey();
    pendingKeys.current.set(operation, { fingerprint, key });
    return key;
  };
  const completeKey = (operation: string, body: unknown) => {
    const previous = pendingKeys.current.get(operation);
    if (previous?.fingerprint === JSON.stringify(body)) pendingKeys.current.delete(operation);
  };

  const refreshLatest = useCallback(async (replace = false) => {
    const id = accountRef.current;
    if (!id) return;
    const epoch = epochRef.current;
    const controller = beginRequest();
    try {
      const latest = await supplyApi.mine(id, controller.signal);
      if (!current(epoch, controller.signal)) return;
      setServerSnapshot(latest);
      if (replace) {
        // A generic object read never proves whether the original write failed or
        // committed, so it must not unlock or overwrite a pending intent.
        if (writeIntentRef.current) {
          setNotice("已读取服务器当前状态；未知写入的原始请求仍保留，重试原步骤收到确定结果前不会解除。");
          return;
        }
        applySupply(latest, true, true);
        setAgreementChecked(false);
        setRulesAccepted(false);
        setDraftDirty(false);
        setError(null);
        setNotice("已采用最新资料，当前页面已更新。");
      }
    } catch (failure) {
      if (!isAbort(failure) && current(epoch, controller.signal)) setNotice("最新状态读取失败，请稍后重试。");
    } finally {
      finishRequest(controller);
    }
  }, [applySupply]);

  // Read failures (catalog/options/skins) keep their own retry slot; they must
  // never overwrite an unknown business write intent.
  const reportFailure = useCallback((failure: unknown, retry?: () => Promise<void>, context?: RequestContext, retryBusy = "") => {
    if (isAbort(failure)) return;
    if (context && !currentContext(context)) return;
    const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
    setError(nextError);
    setNotice("");
    const keepExistingRetry = nextError.status === 0 && !retry && Boolean(context && lastRetry.current && currentContext(lastRetry.current.context));
    if (nextError.status === 0 && retry && context) lastRetry.current = { context, busy: retryBusy, run: retry };
    else if (!keepExistingRetry) lastRetry.current = null;
    if (nextError.status === 401) setAuthRequired(true);
  }, [currentContext]);

  const invalidateConfirmations = useCallback(() => {
    setAgreementChecked(false);
    setRulesAccepted(false);
    setQuoteStale(true);
    setSupply((previous) => {
      const value = previous?.version?.quote
        ? { ...previous, version: { ...previous.version, quote: null, contentHash: null, releaseId: null } }
        : previous;
      supplyRef.current = value;
      return value;
    });
  }, []);

  // Business-write failures: unknown results keep the frozen intent and freeze
  // further writes; 401 pauses and preserves the receipt; 409 invalidates the
  // old confirmation and requires a fresh read/quote.
  const reportWriteFailure = useCallback((failure: unknown, context: RequestContext, intent?: WriteIntent) => {
    if (isAbort(failure)) return;
    if (!currentContext(context)) return;
    if (intent?.persisted && !ownsWriteIntent(context, intent.persisted)) return;
    const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
    setError(nextError);
    setNotice("");
    if (nextError.status === 401) {
      if (intent) rememberWrite(intent);
      setAuthRequired(true);
      return;
    }
    if (storedIntentRef.current?.phase === "accepted" || storedIntentRef.current?.uncertain) {
      const record = storedIntentRef.current;
      rememberWrite({ action: record.action, context, run: () => recoverStoredIntent(record) });
      return;
    }
    if (nextError.status === 409) {
      setWritePending(null);
      invalidateConfirmations();
      void refreshLatest(false);
      return;
    }
    if (uncertainSupplyWriteFailure(nextError)) {
      if (intent && !writeIntentRef.current) rememberWrite(intent);
      return;
    }
    setWritePending(null);
  }, [currentContext, invalidateConfirmations, refreshLatest]);

  const retryWrite = useCallback(async () => {
    const intent = writeIntentRef.current;
    if (!intent || !currentContext(intent.context)) {
      return;
    }
    setBusy(intent.action);
    setError(null);
    try {
      const record = storedIntentRef.current;
      if (intent.persisted && (!record || !ownsStoredWrite(intent.context, intent.persisted))) return;
      if (record?.phase === "accepted" && intent.persisted) await recoverStoredIntent(intent.persisted);
      else await intent.run();
    } catch (failure) {
      if (!intent.persisted || ownsStoredWrite(intent.context, intent.persisted)) reportWriteFailure(failure, intent.context, intent);
    } finally {
      if (currentContext(intent.context) && (!writeIntentRef.current || !intent.persisted || ownsWriteIntent(intent.context, intent.persisted))) setBusy("");
    }
  }, [currentContext, reportWriteFailure]);

  const syncIdentity = useCallback(async (): Promise<boolean> => {
    const snapshot = sharedSession.getSnapshot();
    if (snapshot.status === "loading" || snapshot.status === "error") {
      if (snapshot.status === "error") {
        identityPauseGate.current.markFailed();
        setIdentityPhase("failed");
      } else {
        identityPauseGate.current.startCheck();
        setIdentityPhase("checking");
      }
      return false;
    }
    if (!snapshot.userId) {
      if (identityRef.current) {
        // A guest read can follow a definite 401. Keep this mounted context for
        // same-user recovery; a later different user still invalidates it below.
        identityPauseGate.current.markFailed();
        setAuthRequired(true);
        setIdentityPhase("confirmed");
        return false;
      }
      setIdentityPhase("guest");
      return false;
    }
    const next = snapshot.userId;
    const previous = identityRef.current;
    identityRef.current = next;
    if (previous !== undefined && previous !== next) {
      invalidateContext("登录身份已变化，旧账号资料已清除。", !next);
      router.replace(mode === "fast" ? "/publish?mode=fast" : "/publish", { scroll: false });
    }
    identityPauseGate.current.markConfirmed();
    setAuthRequired(!next);
    setIdentityPhase("confirmed");
    return true;
  }, [sharedSession, invalidateContext, router, mode]);

  useEffect(() => {
    mounted.current = true;
    void syncIdentity();
    const onFocus = () => { void syncIdentity(); };
    const unsubscribeIdentity = sharedSession.subscribe(onFocus);
    return () => {
      mounted.current = false;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      pendingKeys.current.clear();
      lastRetry.current = null;
      uploadQueue.current = Promise.resolve();
      for (const item of media) if (item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
      cancelledMedia.current.clear();
      clearSkinSearchTimer();
      identityPauseGate.current.cancel();
      unsubscribeIdentity();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncIdentity, sharedSession]);

  const hasUnsaved = draftDirty || Object.values(pendingResourceInputs).some(value => value !== "") || media.some(item => !item.bindingSaved);
  const writePending = writeIntent !== null;
  const navigationProtected = Boolean(busy) || writePending || Boolean(intentStorageIssue) || (hasUnsaved && editing);
  const requestNavigation = (intent: NavigationIntent) => {
    navigationFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (navigationProtected) setNavigationIntent(intent);
    else intent.run();
  };
  const leaveConfirmed = () => {
    if (!navigationIntent || writeIntentRef.current || busy) return;
    leavingRef.current = true;
    const run = navigationIntent.run;
    setNavigationIntent(null);
    run();
    window.setTimeout(() => { leavingRef.current = false; }, 500);
  };
  const cancelNavigation = () => {
    navigationIntent?.cancel?.();
    setNavigationIntent(null);
  };
  const saveAndLeave = async () => {
    if (!navigationIntent || writeIntentRef.current || busy) return;
    const intent = navigationIntent;
    const context = captureContext();
    setBusy("save");
    setError(null);
    try {
      const request = await prepareDraftRequest(context, "save", () => saveAndLeave());
      if (request) {
        const saved = await sendDraftRequest(request, "save");
        if (saved && currentContext(context)) {
          leavingRef.current = true;
          setNavigationIntent(null);
          intent.run();
          window.setTimeout(() => { leavingRef.current = false; }, 500);
        }
      }
    } catch (failure) {
      reportWriteFailure(failure, context);
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };
  useEffect(() => {
    if (!navigationProtected) return;
    const guardNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      const href = anchor?.getAttribute("href");
      if (!href || href.startsWith("#") || anchor?.target === "_blank" || anchor?.hasAttribute("download")) return;
      const next = new URL(href, window.location.href);
      if (next.pathname === window.location.pathname && next.search === window.location.search && next.origin === window.location.origin) return;
      if (!/^https?:$/.test(next.protocol)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigationFocusRef.current = anchor;
      setNavigationIntent({ message: "本页还有未保存的资料。离开后，这些修改不会保留。", label: "放弃修改并离开", run: () => {
        if (next.origin === window.location.origin) router.push(`${next.pathname}${next.search}${next.hash}`);
        else window.location.assign(next.href);
      } });
    };
    const handlePopState = () => {
      if (leavingRef.current) return;
      window.history.pushState(null, "", window.location.href);
      setNavigationIntent({
        message: "本页还有未保存的资料。离开后，这些修改不会保留。",
        label: "放弃修改并离开",
        run: () => {
          leavingRef.current = true;
          window.history.back();
        },
      });
    };
    document.addEventListener("click", guardNavigation, true);
    window.addEventListener("popstate", handlePopState);
    return () => {
      document.removeEventListener("click", guardNavigation, true);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [navigationProtected, router, busy, writePending, intentStorageIssue]);

  useEffect(() => {
    if (accountIdProp && loadedAccountRef.current === accountIdProp) return;
    if (!accountIdProp && gameCodeProp && gameRef.current) {
      const currentCode = gamesRef.current.find((game) => game.id === gameRef.current)?.code ?? null;
      if (currentCode && currentCode !== gameCodeProp) {
        if ((meaningfulDraft(draftRef.current) || media.length > 0 || hasUnsaved) && routeGameApproval.current !== gameCodeProp) {
          setNavigationIntent({ message: "切换游戏会清空当前未保存资料。", label: "放弃修改并切换", run: () => { routeGameApproval.current = gameCodeProp; setRouteSwitch(value => value + 1); }, cancel: () => {
            const params = new URLSearchParams();
            if (mode === "fast") params.set("mode", "fast");
            params.set("game", currentCode);
            router.replace(`/publish?${params.toString()}`, { scroll: false });
          } });
          return;
        }
        invalidateContext("已切换游戏，请重新填写发布资料。", false, false);
        gameRef.current = "";
        setGameId("");
        setOptions(null);
        setOptionsAvailability("pending");
        setCatalog(null);
        setCatalogAvailability("pending");
        setKnownSkins({}); setSkinCatalogRevision(null);
        skinQueryRef.current = { gameId: "", key: "", query: {} };
      }
    }
    if (routeAccountRef.current !== accountIdProp) {
      const isInternalAccountPromotion = Boolean(accountIdProp && accountRef.current === accountIdProp);
      routeAccountRef.current = accountIdProp;
      if (!isInternalAccountPromotion) {
        invalidateContext(accountIdProp ? "正在读取新的发布资料。" : "正在准备新的发布资料。", false);
        accountRef.current = accountIdProp;
        setAccountId(accountIdProp);
        setEditing(!accountIdProp);
      } else {
        loadedAccountRef.current = accountIdProp;
        setEditing(true);
      }
    }
    if (identityStatusRef.current !== "confirmed") return;
    const epoch = epochRef.current;
    const loadContext = captureContext(accountIdProp, gameRef.current);
    const controller = beginRequest();
    setLoadingAccount(Boolean(accountIdProp));
    setGamesLoaded(false);
    void (async () => {
      try {
        if (!(await waitForIdentity(loadContext))) return;
        const result = await supplyApi.games(controller.signal);
        if (!current(epoch, controller.signal)) return;
        gamesRef.current = result.games;
        setGames(result.games);
        setGamesLoaded(true);
        let selected = "";
        if (accountIdProp) {
          if (!identityRef.current) {
            if (current(epoch, controller.signal)) setAuthRequired(true);
            return;
          }
          if (!(await waitForIdentity(loadContext))) return;
          const loaded = await supplyApi.mine(accountIdProp, controller.signal);
          if (!current(epoch, controller.signal)) return;
          accountRef.current = accountIdProp;
          loadedAccountRef.current = accountIdProp;
          supplyRef.current = loaded;
          setAccountId(accountIdProp);
          setSupply(loaded);
          setServerSnapshot(loaded);
          selected = loaded.account.game_id;
          setEditing(loaded.version?.reviewState === "DRAFT" && !["ARCHIVED", "DELISTED"].includes(loaded.account.lifecycle ?? "") && !loaded.version.publication && !loaded.blockers?.includes("LEGACY_LISTING_RELIST_REQUIRED"));
          if (loaded.version) {
            const loadedDraft = editableDeclaration(loaded.version.declaration);
            draftRef.current = loadedDraft;
            setDraftState(loadedDraft);
            setDepositInput(yuanFromCents(depositDeclarationCents(loadedDraft.attributes) ?? "") ?? "");
            syncHaffInput(loaded);
          }
          setDraftDirty(false);
          const savedGame = result.games.find((game) => game.id === loaded.account.game_id) ?? null;
          const urlGame = gameCodeProp ? result.games.find((game) => game.code === gameCodeProp) ?? null : null;
          if (gameCodeProp && urlGame && savedGame && urlGame.id !== savedGame.id) {
            setNotice(`已按该账号所在的“${savedGame.name}”读取资料。`);
          }
          const canonical = savedGame?.code ?? urlGame?.code;
          if (canonical && correctedAccountGameRef.current !== accountIdProp) {
            correctedAccountGameRef.current = accountIdProp;
            const params = new URLSearchParams();
            if (mode === "fast") params.set("mode", "fast");
            params.set("accountId", accountIdProp);
            params.set("game", canonical);
            if (editRequested) params.set("edit", "1");
            router.replace(`/publish?${params.toString()}`, { scroll: false });
          }
          setMedia((loaded.version?.declaration.mediaBindings ?? []).map((binding, index) => ({
            id: `bound-${binding.assetId}-${index}`,
            purpose: binding.purpose,
            category: binding.category ?? (binding.purpose === "ACCOUNT_EVIDENCE" ? "PENALTY" : "SHOWCASE"),
            reviewState: binding.reviewState,
            publicDisplayEligible: binding.publicDisplayEligible,
            publiclyReadable: binding.publiclyReadable,
            assetId: binding.assetId,
            previewUrl: mediaAccessUrl(binding.assetId),
            bindingSaved: true,
            context: { epoch: epochRef.current, identity: identityRef.current, accountId: loaded.account.id, gameId: loaded.account.game_id },
            status: "bound",
            intentKey: "",
            uploadKey: "",
          })));
          if (editRequested && (["ARCHIVED", "DELISTED"].includes(loaded.account.lifecycle ?? "") || loaded.version?.origin === "LEGACY_OBSERVATION" || loaded.version?.publication || ["PUBLISHED", "APPROVED"].includes(loaded.version?.reviewState ?? "") || loaded.blockers?.includes("LEGACY_LISTING_RELIST_REQUIRED"))) setNotice("已上架或历史账号不能修改；如需出租，请重新填写上架资料。");
        } else if (gameCodeProp) {
          const requested = result.games.find((game) => game.code === gameCodeProp) ?? null;
          selected = requested?.id ?? "";
          if (!requested) setNotice(`当前未提供 ${gameCodeProp} 的上架入口，可选择其他已开放游戏。`);
        } else {
          selected = selectDeltaGame(result.games)?.id ?? "";
          if (!selected && result.games.length > 0) setNotice("请选择要上架的游戏。");
        }
        setGameId(selected);
      } catch (failure) {
        if (current(epoch, controller.signal)) reportFailure(failure, undefined, captureContext(accountIdProp, ""));
      } finally {
        if (current(epoch, controller.signal)) setLoadingAccount(false);
        finishRequest(controller);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIdProp, editRequested, identityState, gameCodeProp, mode, routeSwitch, router, invalidateContext, reportFailure, waitForIdentity]);

  const rememberSkinCatalog = useCallback((page: PublishingCatalog) => {
    setSkinCatalogRevision({ gameId: page.game.id, revision: page.game.catalogRevision });
    setKnownSkins((previous) => Object.fromEntries([
      ...Object.entries(previous), ...page.skins.map((skin) => [skin.id, { ...skin, catalogRevision: page.game.catalogRevision }] as const),
    ]));
  }, []);

  const zeroInitStateRef = useRef({ editing, options, writePending });
  zeroInitStateRef.current = { editing, options, writePending };
  const fillDefaultZeroInventory = useCallback((page: PublishingCatalog, forceEditable = false) => {
    const { editing: currentEditing, options: currentOptions, writePending: currentWritePending } = zeroInitStateRef.current;
    const isEditable = !accountRef.current || forceEditable || currentEditing || supplyRef.current?.version?.reviewState === "DRAFT";
    if (!isEditable || storedIntentRef.current || currentWritePending || page.blockers?.some(({code}) => code === "PRICING_POLICY_UNAVAILABLE" || code === "RULE_UNCONFIGURED")) return;
    const scopeKey = `${epochRef.current}:${accountRef.current ?? "new"}:${supplyRef.current?.version?.id ?? "none"}:${page.game.id}:${page.game.catalogRevision}`;
    if (zeroInitKeyRef.current === scopeKey) return;
    zeroInitKeyRef.current = scopeKey;
    const safeBoxCode = typeof draftRef.current.attributes.safe_box_code === "string" ? draftRef.current.attributes.safe_box_code : "";
    const safeBoxDisplayName = currentOptions?.safeBoxOptions?.find((o) => o.code === safeBoxCode)?.displayName
      ?? (supplyRef.current?.version?.attributeDisplay?.safeBox?.code === safeBoxCode ? supplyRef.current.version.attributeDisplay.safeBox.displayName : null);
    const selected3x3 = is3x3SafeBoxCode(safeBoxCode, safeBoxDisplayName);
    const hasRetiredPieceInsurance = Boolean(
      supplyRef.current?.version?.catalogItems?.some(
        (ci) => retiredInsuranceCode(ci.code) && draftRef.current.inventory.some((r) => r.itemId === ci.id && r.quantity !== null && r.quantity !== "0"),
      ),
    );
    const fillableIds = page.items
      .filter((item) => {
        if (!item.id || item.unit === "HAFF_BASE" || retiredInsuranceCode(item.code) || item.priced === false || item.priced === null) return false;
        const insuranceCard = canonicalResourceCode(item.code) === "df_billable_top_insure_card" || item.code === "legacy_insurance_day";
        if (insuranceCard && (selected3x3 || hasRetiredPieceInsurance)) return false;
        return true;
      })
      .map((item) => item.id);
    if (!fillableIds.length) return;
    setDraftState((previous) => {
      const existingMap = new Map(previous.inventory.map((row) => [row.itemId, row.quantity]));
      let changed = false;
      const nextInventory = previous.inventory.map((row) => {
        if (fillableIds.includes(row.itemId) && (row.quantity === null || row.quantity === "")) {
          changed = true;
          return { ...row, quantity: "0" };
        }
        return row;
      });
      for (const id of fillableIds) {
        if (!existingMap.has(id)) {
          changed = true;
          nextInventory.push({ itemId: id, quantity: "0" });
        }
      }
      if (!changed) return previous;
      const nextDraft = { ...previous, inventory: nextInventory };
      draftRef.current = nextDraft;
      return nextDraft;
    });
  }, []);

  const loadSkinPage = useCallback(async (query: SkinQuery, append: boolean) => {
    clearSkinSearchTimer();
    if (!gameId) return;
    const queryKey = JSON.stringify({ q: query.q ?? "", categoryId: query.categoryId ?? "", ownerKind: query.ownerKind ?? "", rarityCode: query.rarityCode ?? "", ownerId: query.ownerId ?? "" });
    if (append && (skinQueryRef.current.gameId !== gameId || skinQueryRef.current.key !== queryKey)) return;
    const requestId = ++skinRequestRef.current;
    const request = { id: requestId, key: `${gameId}:${queryKey}` };
    const isCurrent = () => isCurrentQuery(request, skinRequestRef.current, `${skinQueryRef.current.gameId}:${skinQueryRef.current.key}`);
    if (!append) skinQueryRef.current = { gameId, key: queryKey, query: { ...query, cursor: undefined } };
    const context = captureContext(accountRef.current, gameId);
    const controller = beginRequest();
    setLoadingCatalog(true);
    setSkinPageFailed(null);
    if (!append) setSkinPagePending(true);
    try {
      if (!(await waitForIdentity(context))) return;
      const params = new URLSearchParams({ limit: "30" });
      if (query.q) params.set("q", query.q);
      if (query.categoryId) params.set("categoryId", query.categoryId);
      if (query.ownerKind) params.set("ownerKind", query.ownerKind);
      if (query.rarityCode) params.set("rarityCode", query.rarityCode);
      if (query.ownerId) params.set("ownerId", query.ownerId);
      if (query.cursor) params.set("cursor", query.cursor);
      const page = await supplyApi.catalog(gameId, params, controller.signal);
      if (!currentContext(context, controller.signal) || !isCurrent()) return;
      // The first visible type and every later cursor must share one query.
      const firstKind = page.skinFilters?.ownerKinds.find(isSkinOwnerKind);
      const firstCategory = page.categories[0]?.id;
      if (!append && !query.categoryId && !query.ownerKind && (firstKind || firstCategory)) {
        setSkinCategory(firstKind ?? firstCategory!);
        await loadSkinPage({ ...query, ...(firstKind ? { ownerKind: firstKind } : { categoryId: firstCategory }) }, false);
        return;
      }
      setCatalog((previous) => {
        if (!append || !previous) return page;
        const existing = new Set(previous.skins.map((skin) => skin.id));
        return { ...page, skins: [...previous.skins, ...page.skins.filter((skin) => !existing.has(skin.id))] };
      });
      if (!append) fillDefaultZeroInventory(page);
      rememberSkinCatalog(page);
      setCatalogAvailability("ready");
    } catch (failure) {
      if (currentContext(context, controller.signal) && isCurrent()) {
        setCatalogAvailability("failed");
        setSkinPageFailed(append ? "append" : "replace");
        reportFailure(failure, () => loadSkinPage(query, append), context, "catalog");
      }
    } finally {
      if (currentContext(context, controller.signal) && isCurrent()) { setLoadingCatalog(false); setSkinPagePending(false); }
      finishRequest(controller);
    }
  }, [clearSkinSearchTimer, currentContext, fillDefaultZeroInventory, gameId, rememberSkinCatalog, reportFailure, waitForIdentity]);

  const loadOptions = useCallback(async (requestedGameId = gameId) => {
    if (!requestedGameId) return;
    const context = captureContext(accountRef.current, requestedGameId);
    const controller = beginRequest();
    setOptions(null);
    setOptionsAvailability("pending");
    try {
      if (!(await waitForIdentity(context))) return;
      const nextOptions = await supplyApi.publishingOptions(requestedGameId, controller.signal);
      if (!currentContext(context, controller.signal)) return;
      setOptions(nextOptions);
      setOptionsAvailability("ready");
      setDraftState((previous) => {
        const next = { ...previous, attributes: { ...previous.attributes } };
        if (!next.termOptionCode && nextOptions.termOptions[0]) next.termOptionCode = nextOptions.termOptions[0].code;
        if (usesRentalModes(nextOptions)) {
          if (!rentalPricingOf(next.attributes)) {
            next.attributes.rentalPricing = { rentalMode: fastLocked ? "fast" : "ordinary" };
          }
        } else if (!next.pricingOptionCode && nextOptions.pricingOptionCodes[0]) {
          next.pricingOptionCode = nextOptions.pricingOptionCodes[0];
        }
        draftRef.current = next;
        return next;
      });
    } catch (failure) {
      if (!currentContext(context, controller.signal) || isAbort(failure)) return;
      const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
      setOptionsAvailability(nextError.status === 404 ? "unavailable" : "failed");
      if (nextError.status === 0) rememberRetry(context, "rules", () => loadOptions(requestedGameId));
    } finally {
      finishRequest(controller);
    }
  }, [currentContext, fastLocked, gameId, waitForIdentity]);

  useEffect(() => {
    if (!gameId || identityStatusRef.current !== "confirmed") return;
    setSkinQuery("");
    setSkinCategory("");
    setSkinRarity("");
    setSkinOwner("");
    void loadOptions(gameId);
    void loadSkinPage({}, false);
  }, [gameId, identityState, loadOptions, loadSkinPage]);

  // The fast entry explicitly converts the working declaration to fast. It never
  // silently rewrites a saved or published version while the form is read-only.
  useEffect(() => {
    if (!fastLocked || !editing || writeIntent) return;
    if (optionsAvailability !== "ready" || !usesRentalModes(options)) return;
    if (options.rentalModes?.fast?.enabled !== true) return;
    const saved = rentalPricingOf(draftRef.current.attributes);
    if (saved?.rentalMode === "fast") return;
    setDraft((previous) => {
      const current = rentalPricingOf(previous.attributes);
      const keep = current?.ownerRatioB;
      return {
        ...previous,
        attributes: { ...previous.attributes, rentalPricing: { rentalMode: "fast", ...(keep ? { ownerRatioB: keep } : {}) } },
      };
    });
    setNotice("已按极速入口切换为极速比例；请填写合法数值，原报价与条款确认已失效。");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fastLocked, editing, optionsAvailability, options, writeIntent]);

  const setDraft = (next: DraftInput | ((previous: DraftInput) => DraftInput)) => {
    if (writeIntentRef.current) return;
    if (supplyRef.current?.version?.quote) setQuoteStale(true);
    setDraftState((previous) => {
      const value = typeof next === "function" ? next(previous) : next;
      const confirmed = confirmedAmmoRef.current;
      if (confirmed) {
        const nextQty = value.inventory.find(row => row.itemId === confirmed.itemId)?.quantity;
        if (!nextQty || !/^\d+$/.test(nextQty) || BigInt(nextQty) <= 1200n) confirmedAmmoRef.current = null;
      }
      draftRef.current = value;
      return value;
    });
    setDraftDirty(true);
    setAgreementChecked(false);
    setRulesAccepted(false);
    setRecommendationAdopted(false);
    setSupply((previous) => {
      const value = previous?.version?.quote ? { ...previous, version: { ...previous.version, quote: null, contentHash: null, releaseId: null } } : previous;
      supplyRef.current = value;
      return value;
    });
    setError(null);
  };

  const rememberRetry = (context: RequestContext, busyName: string, run: () => Promise<void>) => {
    if (currentContext(context)) lastRetry.current = { context, busy: busyName, run };
  };

  const retryLast = async () => {
    const task = lastRetry.current;
    if (!task || !currentContext(task.context)) {
      lastRetry.current = null;
      return;
    }
    lastRetry.current = null;
    setBusy(task.busy);
    setError(null);
    try {
      await task.run();
    } catch (failure) {
      reportFailure(failure, undefined, task.context, task.busy);
    } finally {
      if (currentContext(task.context)) setBusy("");
    }
  };

  const ensureReady = async (context: RequestContext, signal: AbortSignal, retryBusy: string, retryAfterReady?: () => Promise<void>): Promise<MySupply | null> => {
    if (!currentContext(context, signal) || !(await waitForIdentity(context))) return null;
    if (identityStatusRef.current !== "confirmed" || !identityRef.current) {
      if (currentContext(context, signal)) {
        setAuthRequired(true);
        setNotice(identityStatusRef.current === "failed" ? "无法确认登录身份，请先重试身份确认。" : "此操作需要登录并确认当前身份。");
      }
      return null;
    }
    if (!context.gameId) {
      setNotice("请先选择可发布的游戏。");
      return null;
    }
    let id = accountRef.current;
    let currentSupply = supplyRef.current;
    if (!id) {
      const accountBody = { gameId: context.gameId };
      const accountKey = keyFor("create-account", accountBody);
      let created: { accountId: string; gameId: string };
      try {
        created = await writePersisted("create-account", context, accountBody, accountKey, () => supplyApi.createAccount(context.gameId, accountKey, signal));
      } catch (failure) {
        if (!isAbort(failure) && uncertainSupplyWriteFailure(failure) && currentContext(context, signal)) rememberWrite({ action: retryBusy, context, run: retryAfterReady ?? (() => prepareAndRetry(context, retryBusy)) });
        throw failure;
      }
      if (!currentContext(context, signal) || !(await waitForIdentity(context))) return null;
      completeKey("create-account", accountBody);
      id = created.accountId;
      accountRef.current = id;
      loadedAccountRef.current = id;
      routeAccountRef.current = id;
      setAccountId(id);
      setEditing(true);
      const params = new URLSearchParams();
      if (mode === "fast") params.set("mode", "fast");
      const canonicalGame = games.find((game) => game.id === context.gameId)?.code ?? gameCodeProp;
      if (canonicalGame) params.set("game", canonicalGame);
      params.set("accountId", id);
      router.replace(`/publish?${params.toString()}`, { scroll: false });
      try {
        if (!(await waitForIdentity(context))) return null;
        currentSupply = await supplyApi.mine(id, signal);
      } catch (failure) {
        if (failure instanceof SupplyRequestError && failure.status === 0 && currentContext(context, signal)) rememberRetry(context, retryBusy, retryAfterReady ?? (() => prepareAndRetry(context, retryBusy)));
        throw failure;
      }
      if (!currentContext(context, signal) || !(await waitForIdentity(context))) return null;
      setWritePending(null);
    }
    if (!currentSupply || currentSupply.account.id !== id) {
      try {
        if (!(await waitForIdentity(context))) return null;
        currentSupply = await supplyApi.mine(id, signal);
      } catch (failure) {
        if (failure instanceof SupplyRequestError && failure.status === 0 && currentContext(context, signal)) rememberRetry(context, retryBusy, retryAfterReady ?? (() => prepareAndRetry(context, retryBusy)));
        throw failure;
      }
      if (!currentContext(context, signal) || !(await waitForIdentity(context))) return null;
    }
    if (["ARCHIVED", "DELISTED"].includes(currentSupply.account.lifecycle ?? "") || currentSupply.version?.origin === "LEGACY_OBSERVATION" || currentSupply.version?.publication || ["PUBLISHED", "APPROVED"].includes(currentSupply.version?.reviewState ?? "") || currentSupply.blockers?.includes("LEGACY_LISTING_RELIST_REQUIRED")) {
      throw new Error("已上架或历史账号不能修改，请重新填写上架资料。");
    }
    if (currentSupply.version?.reviewState !== "DRAFT") {
      const body = { expectedRevision: currentSupply.account.revision };
      const draftKey = keyFor("create-draft", { accountId: id, ...body });
      let next: MySupply;
      try {
        if (!(await waitForIdentity(context))) return null;
        next = await writePersisted("create-draft", { ...context, accountId: id }, body, draftKey, () => supplyApi.createDraft(id!, body.expectedRevision, draftKey, signal));
      } catch (failure) {
        if (!isAbort(failure) && uncertainSupplyWriteFailure(failure) && currentContext(context, signal)) rememberWrite({ action: retryBusy, context, run: retryAfterReady ?? (() => prepareAndRetry(context, retryBusy)) });
        throw failure;
      }
      if (!currentContext(context, signal) || !(await waitForIdentity(context))) return null;
      completeKey("create-draft", { accountId: id, ...body });
      setWritePending(null);
      currentSupply = next;
      if (!meaningfulDraft(draftRef.current)) {
        const nextDraft = editableDeclaration(next.version!.declaration);
        draftRef.current = nextDraft;
        setDraftState(nextDraft);
        setDepositInput(yuanFromCents(depositDeclarationCents(nextDraft.attributes) ?? "") ?? "");
        syncHaffInput(next);
        setDraftDirty(false);
      }
    }
    if (currentSupply) {
      supplyRef.current = currentSupply;
      setSupply(currentSupply);
      setEditing(true);
    }
    return currentSupply;
  };

  const prepareAndRetry = async (context: RequestContext, retryBusy: string): Promise<void> => {
    const controller = beginRequest();
    try {
      await ensureReady(context, controller.signal, retryBusy);
    } finally {
      finishRequest(controller);
    }
  };

  const pricingSelection = (sourceAttributes?: DraftInput["attributes"]): { rentalMode: RentalMode; ownerRatioB?: string } | null => {
    const saved = rentalPricingOf(sourceAttributes ?? draftRef.current.attributes);
    const selectedMode = fastLocked ? "fast" : (saved?.rentalMode ?? "ordinary");
    return buildRentalPricing(selectedMode, String(saved?.ownerRatioB ?? ""));
  };

  const pricingProblem = (): UiProblem | null => {
    if (optionsAvailability !== "ready") return null;
    if (!usesRentalModes(options)) {
      if (fastLocked) return { group: "terms", message: "当前规则暂不支持极速出租，请改用普通出租。" };
      return null;
    }
    const modes = options.rentalModes;
    if (fastLocked && modes?.fast?.enabled !== true) {
      return { group: "terms", message: modes?.fast ? "当前规则未启用极速比例，不能以极速入口上架；请改用普通出租。" : "当前规则未提供极速比例范围，不能以极速入口上架；请改用普通出租。" };
    }
    const saved = rentalPricingOf(draftRef.current.attributes);
    const selectedMode = fastLocked ? "fast" : (saved?.rentalMode ?? "ordinary");
    if (selectedMode !== "ordinary" && modes?.[selectedMode] && !modes[selectedMode]!.enabled) {
      return { group: "terms", message: `${rentalModeLabel(selectedMode)}当前未启用，请切换比例类型。` };
    }
    if (selectedMode !== "ordinary") {
      const problem = ratioEntryProblem(selectedMode, modes?.[selectedMode], String(saved?.ownerRatioB ?? ""), liveRatioRangesRef.current?.[selectedMode]);
      if (problem) return { group: "terms", ...problem };
    }
    if (selectedMode === "custom") {
      const option10m = customTermOptions(options)[0];
      if (!option10m) {
        return { group: "terms", message: "当前规则未提供10M/天选项，自定义出租不可用。" };
      }
      if (!customTermOptions(options).some(term => term.code === draftRef.current.termOptionCode)) {
        return { group: "terms", message: "自定义比例仅支持 10M/天 方案，请选择 10M/天。" };
      }
    }
    if (selectedMode !== "ordinary" && !buildRentalPricing(selectedMode, String(saved?.ownerRatioB ?? "")))
      return { group: "terms", message: `请填写合法的${rentalModeLabel(selectedMode)}数值，或切换为普通比例。` };
    return null;
  };

  const depositProblem = (): UiProblem | null => {
    if (depositInput.trim() === "") return null;
    if (yuanToCents(depositInput) === null) return { group: "terms", message: "租客押金请填写不超过两位小数的金额。", target: "publish-deposit" };
    return null;
  };

  const haffProblem = (): UiProblem | null => {
    if (!haffInput || haffInput.trim() === "") return null;
    const value = haffInput.trim();
    if (!/^\d+$/.test(value)) return { group: "terms", message: "哈夫币请按 M 填写整数，不支持小数。", target: "publish-haff-balance" };
    if (baseFromHaffM(value) === null) return { group: "terms", message: "哈夫币填写过大，请检查数值。", target: "publish-haff-balance" };
    return null;
  };

  const quantityProblem = (): UiProblem | null => {
    const invalidRow = draftRef.current.inventory.find((row) => row.quantity !== null && !/^(0|[1-9]\d{0,23})$/.test(row.quantity));
    if (invalidRow) return { group: "assets", message: "库存数量请填写非负整数（没有请填 0）。", target: `quantity-${invalidRow.itemId}` };
    const level = draftRef.current.attributes.character_level;
    if (level !== null && level !== undefined && (!Number.isSafeInteger(level) || Number(level) < 0 || Number(level) > 60)) return { group: "account", message: "账号等级请填写 0–60 的整数；历史原值请核对后更新。" };
    if(Object.values(pendingResourceInputs).some(value=>value!==""))return {group:"assets",message:"新增资源数量已保留在本页，目录配置完成后才能保存或上架。"};
    return null;
  };
  const kdProblem = (): UiProblem | null => {
    const raw = draftRef.current.attributes.secret_kd;
    if (raw === null || raw === undefined || raw === "") return null;
    const text = String(raw);
    return /^\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text)) && Number(text) <= 100
      ? null : { group: "account", message: "绝密KD请填写0–100的数字，可用小数；请核对原输入。", target: "publish-secret-kd" };
  };

  const prepareDraftRequest = async (context: RequestContext, retryBusy: string, retryAfterReady?: () => Promise<void>): Promise<DraftRequest | null> => {
    const problem = kdProblem() ?? quantityProblem() ?? haffProblem() ?? depositProblem() ?? pricingProblem();
    if (problem) { locate(problem.group, problem.message, problem.target); return null; }
    const controller = beginRequest();
    try {
      const ready = await ensureReady(context, controller.signal, retryBusy, retryAfterReady);
      const id = accountRef.current;
      if (!ready || !id || !currentContext(context, controller.signal)) return null;
      const source = draftRef.current;
      const attributes: DraftInput["attributes"] = { ...source.attributes };
      let pricingOptionCode = source.pricingOptionCode;
      if (usesRentalModes(options)) {
        const selection = pricingSelection(source.attributes);
        if (selection) attributes.rentalPricing = selection;
        pricingOptionCode = "";
      }
      const body: DraftInput & { expectedRevision: string } = {
        title: source.title,
        description: source.description?.trim() || null,
        attributes,
        termOptionCode: source.termOptionCode,
        pricingOptionCode,
        inventory: mergeInventory(source, catalog).map((item) => ({ ...item })),
        skins: [...source.skins],
        entitlements: source.entitlements.map((item) => ({ ...item })),
        mediaBindings: source.mediaBindings.map((item) => ({ ...item })),
        expectedRevision: ready.account.revision,
      };
      const keyBody = { accountId: id, ...body };
      const frozen = freezeRequest(body, keyFor("save-draft", keyBody));
      return { context: { ...context, accountId: id }, accountId: id, body: frozen.body, key: frozen.key };
    } finally {
      finishRequest(controller);
    }
  };

  const sendDraftRequest = async (request: DraftRequest, retryBusy: string, retryAfterUnknown?: () => Promise<void>): Promise<MySupply | null> => {
    if (!(await waitForIdentity(request.context))) return null;
    const controller = beginRequest();
    const keyBody = { accountId: request.accountId, ...request.body };
    try {
      const saved = await writePersisted("save-draft", request.context, request.body as unknown as Record<string, unknown>, request.key, () => supplyApi.saveDraft(request.accountId, request.body, request.key, controller.signal));
      if (!currentContext(request.context, controller.signal)) return null;
      completeKey("save-draft", keyBody);
      applySupply(saved, true);
      setServerSnapshot(saved);
      setDraftDirty(false);
      setWritePending(null);
      return saved;
    } catch (failure) {
      if (!isAbort(failure) && uncertainSupplyWriteFailure(failure) && currentContext(request.context, controller.signal)) rememberWrite({ action: retryBusy, context: request.context, run: retryAfterUnknown ?? (() => sendDraftRequest(request, retryBusy).then(() => undefined)) });
      throw failure;
    } finally {
      finishRequest(controller);
    }
  };

  const runSaveRequest = async (request: DraftRequest, retryBusy: string): Promise<void> => {
    const saved = await sendDraftRequest(request, retryBusy, () => runSaveRequest(request, retryBusy));
    if (saved && currentContext(request.context)) setNotice("草稿已保存，刷新后可继续编辑。");
  };

  const sendQuoteRequest = async (context: RequestContext, saved: MySupply, retryBusy: string): Promise<MySupply | null> => {
    const id = saved.account.id;
    const body = { expectedRevision: saved.account.revision };
    const keyBody = { accountId: id, ...body };
    const frozen = freezeRequest(body, keyFor("quote", keyBody));
    if (!(await waitForIdentity({ ...context, accountId: id }))) return null;
    const controller = beginRequest();
    try {
      const quoted = await writePersisted("quote", { ...context, accountId: id }, frozen.body, frozen.key, () =>
        supplyApi.quote(id, frozen.body.expectedRevision, frozen.key, controller.signal),
      );
      if (!currentContext({ ...context, accountId: id }, controller.signal)) return null;
      completeKey("quote", keyBody);
      applySupply(quoted, true);
      setRulesAccepted(false);
      setDraftDirty(false);
      setWritePending(null);
      return quoted;
    } catch (failure) {
      if (!isAbort(failure) && uncertainSupplyWriteFailure(failure) && currentContext({ ...context, accountId: id }, controller.signal)) {
        rememberWrite({ action: retryBusy, context: { ...context, accountId: id }, run: () => sendQuoteRequest(context, saved, retryBusy).then(() => undefined) });
      }
      throw failure;
    } finally {
      finishRequest(controller);
    }
  };

  const firstFocusable = (group: PublishGroupId): HTMLElement | null => {
    const section = formRef.current?.querySelector<HTMLElement>(`[data-publish-group="${group}"]`);
    if (!section) return null;
    return section.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')
      ?? section.querySelector<HTMLElement>('[data-first-field]:not([disabled])')
      ?? section.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
  };

  const scrollToTarget = (group: PublishGroupId, target?: string) => {
    requestAnimationFrame(() => {
      const matched = target
        ? (target.includes("[") ? formRef.current?.querySelector<HTMLElement>(target) : document.getElementById(target))
        : null;
      const node = matched ?? firstFocusable(group) ?? document.getElementById(`publish-group-${group}`);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        const focusTarget = node.matches('input, textarea, button, [role="radio"], [role="combobox"]')
          ? node
          : node.querySelector<HTMLElement>('[role="radio"]:not([aria-disabled="true"]), [role="combobox"]:not([aria-disabled="true"]), input:not([type="hidden"]):not([disabled]), textarea:not([disabled])')
            ?? node.querySelector<HTMLElement>('button:not([disabled])') ?? node;
        focusTarget.focus({ preventScroll: true });
      }
    });
  };

  const locate = (group: PublishGroupId, message: string, target?: string) => {
    setNotice(message);
    setError(null);
    scrollToTarget(group, target);
  };

  const declarationProblem = (): UiProblem | null => {
    if (writeIntent || writePending) return null;
    for (const key of ["next_season_pass", "demulan_unlocked"] as const) {
      const field = options?.declarationOptions?.[key];
      if (field?.enabled && field.required && typeof draftRef.current.attributes[key] !== "boolean") return { group: "account", message: `请明确选择${field.label}的是或否。`, target: `publish-declaration-${key}` };
    }
    return null;
  };
  const penaltyMediaProblem = (): UiProblem | null => {
    if (draftRef.current.attributes.ban_record === true) {
      const penaltyCount = media.filter(
        (item) => item.category === "PENALTY" || item.purpose === "ACCOUNT_EVIDENCE"
      ).length;
      if (penaltyCount === 0) {
        return {
          group: "media",
          message: "请上传该账号三角洲行动所有封禁记录截图",
          target: "publish-media-penalty",
        };
      }
    }
    return null;
  };
  const quoteProblem = (): UiProblem | null => {
    const kd = kdProblem();
    if (kd) return kd;
    const quantities = quantityProblem();
    if (quantities) return quantities;
    if (!gameId) return { group: "account", message: "请先选择游戏。" };
    if (optionsAvailability === "pending") return { group: "terms", message: "正在读取当前出租规则，请稍候再试。" };
    if (optionsAvailability === "unavailable") return { group: "terms", message: "当前暂不可上架，请先保存草稿或联系客服。" };
    if (optionsAvailability === "failed") return { group: "terms", message: "出租规则读取失败，请重试读取后再试。" };
    const declaration = declarationProblem();
    if (declaration) return declaration;
    const required = requiredAccountFactsProblem(draftRef.current.attributes, options);
    if (required) return { group: "account", message: required.message, target: required.target };
    if (catalogAvailability === "pending") return { group: "assets", message: "物品目录正在加载，请稍候再试。" };
    if (catalogAvailability === "failed") return { group: "assets", message: "物品目录加载失败，请重试后再试。" };
    if (catalog?.blockers?.some(({code}) => code === "PRICING_POLICY_UNAVAILABLE" || code === "RULE_UNCONFIGURED"))
      return { group: "assets", message: "当前上架价目暂无法核实，可先保存草稿。恢复后请重新核价。" };
    const missing = (catalog?.items ?? []).filter((item) => item.required && !draftRef.current.inventory.some((row) => row.itemId === item.id && row.quantity !== null));
    if (missing.length) return { group: "assets", message: `请先填写必填资源数量：${missing.map((item) => item.name).join("、")}。` };
    if (!draftRef.current.termOptionCode) return { group: "terms", message: "请选择每日消耗档位。" };
    const pricing = pricingProblem();
    if (pricing) return pricing;
    if (!usesRentalModes(options) && !draftRef.current.pricingOptionCode) return { group: "terms", message: "请选择计价方案。" };
    return haffProblem() ?? depositProblem() ?? penaltyMediaProblem();
  };

  const currentAmmoQuantity = () => draftRef.current.inventory.find(row => {
    const item = catalog?.items.find(item => item.id === row.itemId) ?? supplyRef.current?.version?.catalogItems?.find(item => item.id === row.itemId);
    return canonicalResourceCode(item?.code ?? null) === "df_billable_level6_bullet" && typeof row.quantity === "string" && /^(0|[1-9]\d{0,23})$/.test(row.quantity);
  });
  const closeAmmoReview = () => {
    ammoReviewRef.current = null;
    setAmmoReview(null);
  };
  const requireAmmoReview = (resume?: () => void): boolean => {
    const item = currentAmmoQuantity();
    if (!item?.quantity || BigInt(item.quantity) <= 1200n) return false;
    const confirmed = confirmedAmmoRef.current;
    if (confirmed && currentContext(confirmed.context) && confirmed.itemId === item.itemId) return false;
    const previous = ammoReviewRef.current;
    const review: AmmoReview = { itemId: item.itemId, quantity: item.quantity, context: captureContext(), resume: resume ?? previous?.resume };
    ammoFocusRef.current = document.getElementById(`quantity-${item.itemId}`);
    ammoReviewRef.current = review;
    setAmmoReview(review);
    return true;
  };
  const confirmAmmoReview = () => {
    const review = ammoReviewRef.current;
    if (!review) return;
    const item = currentAmmoQuantity();
    closeAmmoReview();
    if (!currentContext(review.context) || identityStatusRef.current !== "confirmed" || item?.itemId !== review.itemId || item.quantity !== review.quantity) return;
    confirmedAmmoRef.current = { itemId: review.itemId, quantity: review.quantity, context: review.context };
    review.resume?.();
  };

  const saveWithContext = async (context: RequestContext): Promise<void> => {
    const request = await prepareDraftRequest(context, "save", () => saveWithContext(context));
    if (request) await runSaveRequest(request, "save");
  };

  const save = async () => {
    const problem = kdProblem() ?? quantityProblem() ?? haffProblem() ?? pricingProblem() ?? depositProblem();
    if (problem) { locate(problem.group, problem.message, problem.target); return; }
    if (requireAmmoReview(() => { void save(); })) return;
    const context = captureContext();
    setBusy("save");
    setError(null);
    try {
      await saveWithContext(context);
    } catch (failure) {
      reportWriteFailure(failure, context);
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };


  const token = () => {
    const id = accountRef.current;
    const version = supplyRef.current?.version;
    const expectedRevision = supplyRef.current?.account.revision;
    if (!id || !version || !expectedRevision || !version.releaseId || !version.contentHash) return null;
    return { id, expectedRevision, versionId: version.id, releaseId: version.releaseId, contentHash: version.contentHash };
  };

  const sendConfirmRequest = async (
    action: "accept-rules" | "submit",
    context: RequestContext,
    body: { expectedRevision: string; versionId: string; releaseId: string; contentHash: string; fullPayoutTermsAcceptance?: FullPayoutTermsAcceptance },
    key: string,
    retryBusy: string,
    onSuccess: (next: MySupply) => void,
  ): Promise<void> => {
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    try {
      const next = await writePersisted(action, context, body, key, () => supplyApi.confirm(context.accountId!, action, body, key, controller.signal));
      if (!currentContext(context, controller.signal)) return;
      completeKey(action, { accountId: context.accountId, ...body });
      setWritePending(null);
      onSuccess(next);
    } catch (failure) {
      if (!isAbort(failure) && uncertainSupplyWriteFailure(failure) && currentContext(context, controller.signal)) rememberWrite({ action: retryBusy, context, run: () => sendConfirmRequest(action, context, body, key, retryBusy, onSuccess) });
      throw failure;
    } finally {
      finishRequest(controller);
    }
  };

  const confirmPublish = async () => {
    const declaration = declarationProblem();
    if (declaration) { locate(declaration.group, declaration.message, declaration.target); return; }
    const penalty = penaltyMediaProblem();
    if (penalty) { locate(penalty.group, penalty.message, penalty.target); return; }
    if (requireAmmoReview(() => { void confirmPublish(); })) return;
    if (!agreementChecked) {
      if (typeof window !== "undefined" && window.innerWidth <= 1023) setRailExpanded(true);
      locate("terms", "请先阅读并勾选同意出租协议。");
      return;
    }
    if (payoutSelected === true && !payoutAcceptance) {
      if (typeof window !== "undefined" && window.innerWidth <= 1023) setRailExpanded(true);
      locate("terms", "请先阅读并同意本次全额包赔条款。");
      return;
    }
    const currentToken = token();
    if (!currentToken) {
      locate("terms", "当前信息已变更，请重新点击确认上架。");
      return;
    }
    setBusy("accept");
    setError(null);
    const context = captureContext(currentToken.id);
    const body = { expectedRevision: currentToken.expectedRevision, versionId: currentToken.versionId, releaseId: currentToken.releaseId, contentHash: currentToken.contentHash, ...(payoutAcceptance ? { fullPayoutTermsAcceptance: payoutAcceptance } : {}) };
    const keyBody = { accountId: currentToken.id, ...body };
    try {
      const frozen = freezeRequest(body, keyFor("accept-rules", keyBody));
      await sendConfirmRequest("accept-rules", context, frozen.body, frozen.key, "accept", (accepted) => {
        applySupply(accepted, true);
        setDraftDirty(false);
        setRulesAccepted(true);
      });
      if (!currentContext(context)) return;
      setBusy("submit");
      const submitToken = token();
      if (!submitToken) {
        setNotice("条款已确认，但资料已更新；请重新点击确认上架。");
        return;
      }
      const submitBody = { expectedRevision: submitToken.expectedRevision, versionId: submitToken.versionId, releaseId: submitToken.releaseId, contentHash: submitToken.contentHash };
      const submitFrozen = freezeRequest(submitBody, keyFor("submit", { accountId: submitToken.id, ...submitBody }));
      await sendConfirmRequest("submit", { ...context, accountId: submitToken.id }, submitFrozen.body, submitFrozen.key, "submit", (submitted) => {
        applySupply(submitted, false);
        setDraftDirty(false);
        setEditing(false);
        setNotice("账号已成功上架！");
        setPublishSuccessOpen(true);
      });
    } catch (failure) {
      reportWriteFailure(failure, context);
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };

  const changeAttribute = (key: string, value: string | number | boolean | null) => {
    setDraft((previous) => {
      const nextAttributes = { ...previous.attributes, [key]: value };
      if (key !== "safe_box_code") return { ...previous, attributes: nextAttributes };
      const nextCode = typeof value === "string" ? value : "";
      const safeBoxDisplayName = options?.safeBoxOptions?.find((o) => o.code === nextCode)?.displayName
        ?? (supply?.version?.attributeDisplay?.safeBox?.code === nextCode ? supply.version.attributeDisplay.safeBox.displayName : null);
      const nextIs3x3 = is3x3SafeBoxCode(nextCode, safeBoxDisplayName);
      const insureItemIds = new Set(
        (catalog?.items ?? [])
          .filter((item) => canonicalResourceCode(item.code) === "df_billable_top_insure_card" || item.code === "legacy_insurance_day")
          .map((item) => item.id),
      );
      if (nextIs3x3 && insureItemIds.size > 0) {
        const cleanedInventory = previous.inventory.filter(
          (row) => !insureItemIds.has(row.itemId) || (row.quantity !== null && row.quantity !== "" && row.quantity !== "0"),
        );
        return { ...previous, attributes: nextAttributes, inventory: cleanedInventory };
      }
      if (!nextIs3x3) {
        const activeInsure = (catalog?.items ?? []).find(
          (item) => canonicalResourceCode(item.code) === "df_billable_top_insure_card" && item.unit !== "HAFF_BASE" && !retiredInsuranceCode(item.code) && item.priced !== false,
        );
        if (activeInsure) {
          const existing = previous.inventory.find((row) => row.itemId === activeInsure.id);
          if (!existing) {
            return { ...previous, attributes: nextAttributes, inventory: [...previous.inventory, { itemId: activeInsure.id, quantity: "0" }] };
          }
          if (existing.quantity === null || existing.quantity === "") {
            return {
              ...previous,
              attributes: nextAttributes,
              inventory: previous.inventory.map((row) => row.itemId === activeInsure.id ? { ...row, quantity: "0" } : row),
            };
          }
        }
      }
      return { ...previous, attributes: nextAttributes };
    });
  };
  const changeServiceWindow = (key: "service_window_start_minute" | "service_window_end_minute", raw: string) => {
    const minutes = raw === "" ? null : timeValueToMinutes(raw);
    if (raw !== "" && minutes === null) return;
    if (key === "service_window_start_minute" && minutes === 1440) return;
    setDraft((previous) => {
      const attributes = { ...previous.attributes, [key]: minutes };
      const start = key === "service_window_start_minute" ? minutes : (typeof previous.attributes.service_window_start_minute === "number" ? previous.attributes.service_window_start_minute : null);
      const end = key === "service_window_end_minute" ? minutes : (typeof previous.attributes.service_window_end_minute === "number" ? previous.attributes.service_window_end_minute : null);
      if (start === null || end === null) {
        attributes.service_window_cross_midnight = null;
        attributes.service_window_timezone = null;
      } else if (start === end) {
        attributes.service_window_cross_midnight = null;
        attributes.service_window_timezone = "Asia/Shanghai";
      } else {
        attributes.service_window_cross_midnight = end < start;
        attributes.service_window_timezone = "Asia/Shanghai";
      }
      return { ...previous, attributes };
    });
  };
  const changeAllDay = (checked: boolean) => {
    const current = draftRef.current.attributes;
    if (checked && !(current.service_window_start_minute === 0 && current.service_window_end_minute === 1440 && current.service_window_cross_midnight === false)) serviceWindowCache.current = {
      service_window_start_minute: current.service_window_start_minute ?? null,
      service_window_end_minute: current.service_window_end_minute ?? null,
      service_window_cross_midnight: current.service_window_cross_midnight ?? null,
      service_window_timezone: current.service_window_timezone ?? null,
    };
    setServiceWindowCustomSelected(!checked);
    const cached = serviceWindowCache.current;
    setDraft((previous) => ({
      ...previous,
      attributes: {
        ...previous.attributes,
        service_window_start_minute: checked ? 0 : cached?.service_window_start_minute ?? null,
        service_window_end_minute: checked ? 1440 : cached?.service_window_end_minute ?? null,
        service_window_cross_midnight: checked ? false : cached?.service_window_cross_midnight ?? null,
        service_window_timezone: checked ? "Asia/Shanghai" : cached?.service_window_timezone ?? null,
      },
    }));
  };
  const changeInventory = (itemId: string, raw: string) => {
    const value = raw === "" ? null : raw;
    setDraft((previous) => {
      const next = new Map(previous.inventory.map((item) => [item.itemId, item.quantity]));
      next.set(itemId, value);
      return { ...previous, inventory: Array.from(next, ([id, quantity]) => ({ itemId: id, quantity })) };
    });
  };
  const changeHaffM = (itemId: string, raw: string) => {
    const next = raw ?? "";
    setHaffInput(next);
    const isInteger = /^\d+$/.test(next.trim());
    const base = isInteger ? baseFromHaffM(next) : null;
    if (next.trim() === "") changeInventory(itemId, "");
    else if (base !== null) changeInventory(itemId, base);
    else changeInventory(itemId, "");
  };
  const changeEntitlement = (entitlementId: string, enabled: boolean, value?: string, expiresAt?: string, expiryKind?: "PERMANENT" | "TIMED") => {
    setDraft((previous) => {
      const next = previous.entitlements.filter((item) => item.entitlementId !== entitlementId);
      if (!enabled) return { ...previous, entitlements: next };
      const numeric = value === undefined || value.trim() === "" ? null : Number.parseInt(value, 10);
      const expiry = expiryKind === "TIMED" && expiresAt ? isoFromBeijingInput(expiresAt) : null;
      next.push({ entitlementId, value: value === undefined ? true : Number.isNaN(numeric) ? null : numeric, expiresAt: expiry, expiryKnowledge: expiryKind === "TIMED" && !expiry ? "UNKNOWN" : "KNOWN" });
      return { ...previous, entitlements: next };
    });
  };
  const selectedEntitlement = (id: string) => draft.entitlements.find((item) => item.entitlementId === id);

  const rentalSelection = rentalPricingOf(draft.attributes);
  const rentalMode: RentalMode = fastLocked ? "fast" : (rentalSelection?.rentalMode ?? "ordinary");
  const ratioInput = rentalSelection?.ownerRatioB ?? "";
  const changeRentalMode = (next: RentalMode) => {
    if (fastLocked || next === rentalMode) return;
    const option10m = customTermOptions(options)[0];
    if (next === "custom" && !option10m) return;
    setDraft((previous) => {
      const saved = rentalPricingOf(previous.attributes);
      const keep = saved?.ownerRatioB;
      const nextTermOptionCode = next === "custom" && option10m ? option10m.code : previous.termOptionCode;
      return {
        ...previous,
        termOptionCode: nextTermOptionCode,
        attributes: {
          ...previous.attributes,
          rentalPricing: next === "ordinary" ? { rentalMode: next } : { rentalMode: next, ...(keep ? { ownerRatioB: keep } : {}) },
        },
      };
    });
    invalidateConfirmations();
  };
  const changeRatio = (raw: string) => {
    setDraft((previous) => ({
      ...previous,
      attributes: { ...previous.attributes, rentalPricing: { rentalMode: rentalMode === "ordinary" ? (fastLocked ? "fast" : "custom") : rentalMode, ownerRatioB: raw } },
    }));
  };
  const changeDeposit = (raw: string) => {
    setDepositInput(raw);
    setDraft((previous) => {
      const attributes = { ...previous.attributes };
      const cents = raw.trim() === "" ? null : yuanToCents(raw);
      if (cents === null) delete attributes.owner_deposit_declaration;
      else attributes.owner_deposit_declaration = { schema: "owner-deposit-declaration-v1", amountCents: cents, declarationVersion: "1" };
      return { ...previous, attributes };
    });
  };
  const changeFullPayout = (selected: boolean | null) => {
    setDraft((previous) => {
      const attributes = { ...previous.attributes };
      if (selected === null) delete attributes.full_payout_declaration;
      else attributes.full_payout_declaration = { schema: "full-payout-declaration-v1", selected };
      return { ...previous, attributes };
    });
  };

  const currentRecommendationInputs = (): RecommendationInputs => {
    const attributes = draftRef.current.attributes;
    const level = (value: unknown) => (typeof value === "number" ? value : null);
    return {
      safeBoxCode: typeof attributes.safe_box_code === "string" ? attributes.safe_box_code : null,
      vitality: level(attributes.vit_level),
      bear: level(attributes.bear_level),
      dive: level(attributes.dive_level),
      skinIds: [...draftRef.current.skins],
    };
  };

  const verifyRecommendationSkinFacts = async (facts: DepositSkinFacts | undefined, binding: RecommendationBinding, context: RequestContext, signal: AbortSignal): Promise<boolean> => {
    if (!facts || facts.schema !== "deposit-skin-facts-v1" || facts.gameId !== context.gameId || facts.listingVersionId !== binding.versionId ||
      typeof facts.catalogRevision !== "string" || !/^[1-9]\d*$/.test(facts.catalogRevision) || !Array.isArray(facts.skins) || facts.skins.length !== binding.inputs.skinIds.length) return false;
    const pending = new Set(binding.inputs.skinIds), expected = new Map<string, DepositSkinFacts["skins"][number]>();
    if (pending.size !== binding.inputs.skinIds.length) return false;
    for (const skin of facts.skins) {
      if (!skin || !pending.has(skin.skinId) || expected.has(skin.skinId) || !["AGENT", "FIREARM", "MELEE_TYPE"].includes(skin.ownerKind) ||
        !(skin.rarityCode === null || typeof skin.rarityCode === "string")) return false;
      expected.set(skin.skinId, skin);
    }
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page = await supplyApi.catalog(context.gameId, query, signal);
      if (!currentContext(context, signal)) return false;
      if (page.game.id !== facts.gameId || page.game.catalogRevision !== facts.catalogRevision || page.game.currentReleaseId !== binding.ruleReleaseId) return false;
      rememberSkinCatalog(page);
      for (const skin of page.skins) {
        const fact = expected.get(skin.id);
        if (!fact) continue;
        if (skin.ownerKind !== fact.ownerKind || skin.rarityCode !== fact.rarityCode) return false;
        pending.delete(skin.id);
      }
      if (pending.size === 0) return true;
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) return false;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return false;
  };

  const recommendDeposit = async () => {
    const problem = pricingProblem();
    if (problem) { locate(problem.group, problem.message, problem.target); return; }
    const needsSave = draftDirty || !supplyRef.current?.version || supplyRef.current.version.reviewState !== "DRAFT";
    if (needsSave && requireAmmoReview(() => { void recommendDeposit(); })) return;
    const context = captureContext();
    setRecommendationBusy(true);
    setError(null);
    try {
      let currentSupply = supplyRef.current;
      if (needsSave) {
        // The recommendation is computed from the persisted declaration, so the
        // current edits go through the same frozen write chain first.
        const request = await prepareDraftRequest(context, "recommend", () => recommendDeposit());
        if (!request) return;
        const saved = await sendDraftRequest(request, "recommend", () => recommendDeposit());
        if (!saved) return;
        currentSupply = saved;
      }
      if (!currentSupply?.version) return;
      const id = currentSupply.account.id;
      const requestBinding: RecommendationBinding = {
        accountId: id,
        accountRevision: currentSupply.account.revision,
        versionId: currentSupply.version.id,
        versionRevision: currentSupply.version.revision ?? "",
        ruleReleaseId: options?.releaseId ?? currentSupply.version.releaseId ?? "",
        inputs: currentRecommendationInputs(),
        mismatch: false,
      };
      const controller = beginRequest();
      try {
        const result = await supplyApi.depositRecommendation(id, controller.signal);
        if (!currentContext({ ...context, accountId: id }, controller.signal)) return;
        if (supplyRef.current?.account.revision !== requestBinding.accountRevision || supplyRef.current?.version?.id !== requestBinding.versionId) {
          setNotice("资料在查看推荐期间发生变化，请重新查看推荐押金。");
          return;
        }
        if (!result.available) {
          setRecommendation(result);
          setRecommendationBinding(null);
          setRecommendationAdopted(false);
          setNotice(result.reason === "FUNDING_POLICY_UNCONFIGURED" ? "当前规则尚未配置推荐押金依据，可自行填写押金。" : "请先补全安全箱、体力、负重、潜水与皮肤资料后再查看推荐押金。");
          return;
        }
        // The response must prove it was computed for this account/version
        // revision, this rule release and this declaration snapshot.
        const v2 = result.recommendationSchema === "deposit-recommendation-v2" || result.inputs.skinFacts !== undefined;
        const factsMatch = !v2 || await verifyRecommendationSkinFacts(result.inputs.skinFacts, requestBinding, { ...context, accountId: id }, controller.signal);
        if (!currentContext({ ...context, accountId: id }, controller.signal)) return;
        const resultAmount = yuanFromCents(result.amountCents);
        const mismatch = resultAmount === null || !factsMatch || (result.recommendationSchema !== undefined && !["deposit-recommendation-v1", "deposit-recommendation-v2"].includes(result.recommendationSchema)) || result.accountId !== requestBinding.accountId ||
          result.accountRevision !== requestBinding.accountRevision ||
          result.versionId !== requestBinding.versionId ||
          result.versionRevision !== requestBinding.versionRevision ||
          result.ruleReleaseId !== requestBinding.ruleReleaseId ||
          !inputsEqual(result.inputs, requestBinding.inputs);
        setRecommendation(result);
        setRecommendationBinding({ ...requestBinding, inputs: { ...requestBinding.inputs, ...(v2 ? { skinFacts: result.inputs.skinFacts } : {}) }, mismatch });
        setRecommendationAdopted(false);
        setNotice(resultAmount === null ? "推荐金额暂不可用，请重新读取；不会按零元采用。" : mismatch
          ? "推荐结果与当前账号资料或规则不匹配，已标记过期；请重新查看推荐押金。"
          : `推荐押金 ${resultAmount} 元，依据当前账号资料计算；点击“采用推荐”才会填入申报。`);
      } finally {
        finishRequest(controller);
      }
    } catch (failure) {
      if (writeIntentRef.current) reportWriteFailure(failure, context);
      else reportFailure(failure, undefined, context, "recommend");
    } finally {
      if (currentContext(context)) setRecommendationBusy(false);
    }
  };

  const recommendationFacts = recommendationBinding?.inputs.skinFacts;
  const recommendationCatalogFresh = !recommendationFacts || (skinCatalogRevision?.gameId === gameId && skinCatalogRevision.revision === recommendationFacts.catalogRevision &&
    recommendationFacts.skins.every((fact) => knownSkins[fact.skinId]?.catalogRevision === recommendationFacts.catalogRevision && knownSkins[fact.skinId]?.ownerKind === fact.ownerKind && knownSkins[fact.skinId]?.rarityCode === fact.rarityCode));
  const recommendationAmountYuan = recommendation?.available ? yuanFromCents(recommendation.amountCents) : null;
  const recommendationFresh = Boolean(
    recommendation?.available &&
    recommendationAmountYuan !== null &&
    recommendationBinding &&
    !recommendationBinding.mismatch &&
    recommendationCatalogFresh &&
    !draftDirty &&
    supply?.account.id === recommendationBinding.accountId &&
    supply?.account.revision === recommendationBinding.accountRevision &&
    supply?.version?.id === recommendationBinding.versionId &&
    (supply?.version?.revision ?? "") === recommendationBinding.versionRevision &&
    (options?.releaseId ?? supply?.version?.releaseId ?? "") === recommendationBinding.ruleReleaseId &&
    inputsEqual(currentRecommendationInputs(), recommendationBinding.inputs),
  );

  const adoptRecommendation = async () => {
    const current = recommendation;
    if (!current || !current.available || !recommendationFresh) {
      setNotice("推荐已过期或不可用，请重新查看推荐押金。");
      return;
    }
    const binding = recommendationBinding!, context = captureContext(), controller = beginRequest();
    setRecommendationBusy(true);
    try {
      if (current.recommendationSchema === "deposit-recommendation-v2" || current.inputs.skinFacts !== undefined) {
        const matches = await verifyRecommendationSkinFacts(current.inputs.skinFacts, binding, context, controller.signal);
        if (!currentContext(context, controller.signal)) return;
        if (!matches || !inputsEqual(currentRecommendationInputs(), binding.inputs) || supplyRef.current?.account.revision !== binding.accountRevision || supplyRef.current?.version?.id !== binding.versionId || supplyRef.current?.version?.revision !== binding.versionRevision) {
          setRecommendationBinding({ ...binding, mismatch: true }); setRecommendationAdopted(false);
          setNotice("目录或资料已变化，推荐已过期；请重新查看推荐押金。"); return;
        }
      }
      changeDeposit(yuanFromCents(current.amountCents) ?? "");
      setRecommendation(current);
      setRecommendationAdopted(true);
      setNotice("已按推荐填入押金。");
    } catch {
      if (currentContext(context, controller.signal)) { setRecommendationBinding({ ...binding, mismatch: true }); setRecommendationAdopted(false); setNotice("目录核对未完成，推荐不可采用；请重新查看推荐押金。"); }
    } finally {
      finishRequest(controller);
      if (currentContext(context)) setRecommendationBusy(false);
    }
  };

  const upload = async (entry: MediaEntry, queuedContext = entry.context) => {
    if (cancelledMedia.current.has(entry.id) || !entry.file || !queuedContext.gameId || !currentContext(queuedContext)) return;
    const context = queuedContext;
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    if (currentContext(context, controller.signal)) setMedia((previous) => previous.map((item) => item.id === entry.id ? { ...item, status: "uploading", error: undefined } : item));
    setBusy(`upload-${entry.id}`);
    try {
      const ready = await ensureReady(context, controller.signal, "upload", () => upload(entry, context));
      const id = accountRef.current;
      if (cancelledMedia.current.has(entry.id) || !ready || !id || !currentContext(context, controller.signal)) return;
      const file = entry.file;
      const result = await writePersisted("media", { ...context, accountId: id }, { purpose: entry.purpose, category: entry.category ?? "SHOWCASE", mime: file.type, size: file.size, uploadKey: entry.uploadKey }, entry.intentKey, () => uploadSupplyMedia({ gameId: context.gameId, accountId: id, purpose: entry.purpose, file, transport: entry.transport, intentKey: entry.intentKey, uploadKey: entry.uploadKey, signal: controller.signal, beforeBytesUpload: () => waitForIdentity(context) }));
      if (!currentContext(context, controller.signal)) return;
      if (!result) return;
      setWritePending(null);
      if (cancelledMedia.current.has(entry.id)) return;
      setMedia((previous) => previous.map((item) => item.id === entry.id ? { ...item, assetId: result.assetId, reviewState: result.reviewState, bindingSaved: false, status: "bound", error: undefined } : item));
      setDraft((previous) => previous.mediaBindings.some((binding) => binding.assetId === result.assetId)
        ? previous
        : { ...previous, mediaBindings: [...previous.mediaBindings, { assetId: result.assetId, position: nextMediaPosition(previous.mediaBindings), ...(entry.category ? { category: entry.category } : {}) }] });
      lastRetry.current = null;
    } catch (failure) {
      if (cancelledMedia.current.has(entry.id)) return;
      if (currentContext(context, controller.signal)) {
        setMedia((previous) => previous.map((item) => item.id === entry.id ? { ...item, status: "failed", error: failure instanceof SupplyRequestError ? failure.message : "上传未完成" } : item));
        if (!isAbort(failure) && uncertainSupplyWriteFailure(failure)) rememberWrite({ action: "upload", context, run: () => upload(entry, context) });
        reportWriteFailure(failure, context);
      }
    } finally {
      if (currentContext(context, controller.signal)) setBusy("");
      finishRequest(controller);
    }
  };
  const acceptFiles = (category: MediaCategory, files: File[]) => {
    if (formDisabled || !gameId || (category === "PENALTY" && draftRef.current.attributes.ban_record !== true)) return;
    const context = captureContext(accountRef.current, gameId);
    if (!currentContext(context)) return;
    const transport = globalThis.crypto?.subtle ? options?.accountMediaTransport : undefined;
    for (const file of files) {
      const entryId = newKey();
      cancelledMedia.current.delete(entryId);
      const hint = mediaUploadFailureHint(file);
      const entry: MediaEntry = { id: entryId, purpose: "ACCOUNT_DISPLAY", category, file, transport, status: "failed", error: hint ?? undefined, intentKey: newKey(), uploadKey: newKey(), bindingSaved: false, context, previewUrl: hint ? undefined : URL.createObjectURL(file) };
      setMedia((previous) => [...previous, entry]);
      if (hint) {
        setNotice("");
        continue;
      }
      uploadQueue.current = uploadQueue.current.catch(() => undefined).then(() => {
        if (!currentContext(context)) return;
        return waitForIdentity(context).then((ready) => ready ? upload(entry, context) : undefined);
      });
    }
  };
  const selectFiles = (category: MediaCategory, event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    acceptFiles(category, files);
  };

  const removeMedia = (entryId: string) => {
    if (busy || readOnly) return;
    const entry = media.find((item) => item.id === entryId);
    if (!entry || !currentContext(entry.context)) return;
    cancelledMedia.current.add(entryId);
    if (entry.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(entry.previewUrl);
    setMedia((previous) => previous.filter((item) => item.id !== entryId));
    setDraft((previous) => {
      if (!entry.assetId) return previous;
      const remaining = previous.mediaBindings.filter((binding) => binding.assetId !== entry.assetId);
      return { ...previous, mediaBindings: remaining.map((binding, position) => ({ ...binding, position })) };
    });
  };

  const isPenaltyMediaEntry = (item: MediaEntry) =>
    item.category === "PENALTY" || item.purpose === "ACCOUNT_EVIDENCE";

  const applyMediaOrder = (next: MediaEntry[]) => {
    setMedia(next);
    setDraft((previous) => ({
      ...previous,
      mediaBindings: next.filter((item) => item.assetId).map((item, position) => ({
        assetId: item.assetId!,
        position,
        ...(item.category ? { category: item.category } : {}),
      })),
    }));
  };

  const reorderMediaCard = (sourceId: string, targetId: string) => {
    if (busy || readOnly || sourceId === targetId) return;
    const sourceIndex = media.findIndex((item) => item.id === sourceId);
    const targetIndex = media.findIndex((item) => item.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    if (isPenaltyMediaEntry(media[sourceIndex]!) !== isPenaltyMediaEntry(media[targetIndex]!)) return;
    const next = [...media];
    const [moved] = next.splice(sourceIndex, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    applyMediaOrder(next);
  };

  const moveMedia = (entryId: string, delta: -1 | 1) => {
    if (busy || readOnly) return;
    const index = media.findIndex((item) => item.id === entryId);
    if (index < 0) return;
    const isPenalty = isPenaltyMediaEntry(media[index]!);
    let target = index + delta;
    while (target >= 0 && target < media.length && isPenaltyMediaEntry(media[target]!) !== isPenalty) {
      target += delta;
    }
    if (target < 0 || target >= media.length) return;
    const next = [...media];
    [next[index], next[target]] = [next[target]!, next[index]!];
    applyMediaOrder(next);
  };

  const setCoverMedia = (entryId: string) => {
    if (busy || readOnly) return;
    const index = media.findIndex((item) => item.id === entryId);
    if (index < 0) return;
    const entry = media[index]!;
    if (isPenaltyMediaEntry(entry)) return;
    const firstDisplayIndex = media.findIndex((item) => !isPenaltyMediaEntry(item));
    if (firstDisplayIndex < 0 || index === firstDisplayIndex) return;
    const next = [...media];
    next.splice(index, 1);
    next.splice(firstDisplayIndex, 0, entry);
    applyMediaOrder(next);
  };

  const selectGame = (nextGameId: string) => {
    if (nextGameId === gameId) return;
    requestNavigation({ message: "切换游戏会清空当前未保存资料。", label: "放弃修改并切换", run: () => {
    invalidateContext("已切换游戏，请重新填写发布资料。", false, false);
    gameRef.current = nextGameId;
    setGameId(nextGameId);
    setOptions(null);
    setOptionsAvailability("pending");
    setCatalog(null);
    setCatalogAvailability("pending");
    setKnownSkins({}); setSkinCatalogRevision(null);
    skinQueryRef.current = { gameId: "", key: "", query: {} };
    clearSkinSearchTimer();
    const code = games.find((game) => game.id === nextGameId)?.code;
    const params = new URLSearchParams();
    if (mode === "fast") params.set("mode", "fast");
    if (code) params.set("game", code);
    router.replace(params.size ? `/publish?${params.toString()}` : "/publish", { scroll: false });
    } });
  };

  const beginEditingWithContext = async (context: RequestContext): Promise<void> => {
    const controller = beginRequest();
    try {
      await ensureReady(context, controller.signal, "edit", () => beginEditingWithContext(context));
      if (currentContext(context)) {
        setEditing(true);
        if (catalog) fillDefaultZeroInventory(catalog, true);
        setNotice("草稿已准备好；提交前可继续完善资料。");
      }
    } finally {
      finishRequest(controller);
    }
  };

  const beginEditing = async () => {
    if (!accountId || identityState !== "confirmed" || !identityRef.current || busy) return;
    const context = captureContext(accountId, gameId);
    setBusy("edit");
    setError(null);
    try {
      await beginEditingWithContext(context);
    } catch (failure) {
      if (writeIntentRef.current) reportWriteFailure(failure, context);
      else reportFailure(failure, undefined, context, "edit");
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };

  const fieldErrors = error?.details ?? [];
  const fieldError = (path: string) => {
    const item = fieldErrors.find((candidate) => candidate.path === path || candidate.path.startsWith(`${path}.`) || candidate.path.startsWith(`${path}[`));
    return item ? fieldErrorText(path, item.code) : undefined;
  };
  const errorKey = error ? `${error.status}:${fieldErrors.map((item) => item.path).join(",")}` : "";
  useEffect(() => {
    if (!fieldErrors.length) return;
    requestAnimationFrame(() => {
      const node = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? null;
      node?.scrollIntoView({ block: "center" });
      node?.focus({ preventScroll: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorKey]);

  useEffect(() => {
    const version = supply?.version;
    if (!version?.quote) { quoteCatalogBinding.current = null; return; }
    // An unresolved write owns its original frozen token; metadata reads must
    // neither replace that intent nor release its lock.
    if (version.reviewState !== "DRAFT" || writeIntent || quoteStale || !catalog || !options) return;
    const token = `${version.id}:${version.contentHash}`;
    const previous = quoteCatalogBinding.current;
    const revision = version.quote.catalogRevision ?? (previous?.token === token ? previous.catalogRevision : catalog.game.catalogRevision);
    quoteCatalogBinding.current = { token, catalogRevision: revision };
    if (revision !== catalog.game.catalogRevision || version.quote.ruleReleaseId !== options.releaseId || supply?.blockers?.includes("RULE_CHANGED")) invalidateConfirmations();
  }, [catalog, options, supply, writeIntent, quoteStale, invalidateConfirmations]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const header = document.querySelector<HTMLElement>(".site-header");
    const measure = () => {
      const viewportHeight = window.innerHeight;
      const offset = Math.ceil(header?.getBoundingClientRect().height ?? 96) + 12;
      const railHeight = rail.getBoundingClientRect().height;
      const shell = rail.closest<HTMLElement>(".functional-shell--editor");
      shell?.style.setProperty("--publish-header-offset", `${offset}px`);
      const tooShortForSticky = viewportHeight < 460;
      const stickyTop = !tooShortForSticky && railHeight > viewportHeight - offset - 12
        ? Math.max(12, Math.floor(viewportHeight - railHeight - 16))
        : offset;
      shell?.style.setProperty("--publish-rail-sticky-top", `${stickyTop}px`);
      rail.dataset.tall = String(tooShortForSticky);
    };
    const observer = new ResizeObserver(measure);
    if (header) observer.observe(header);
    observer.observe(rail);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [identityState, gameId]);

  const previewReleaseId = catalog?.game.currentReleaseId ?? options?.releaseId ?? "";
  const previewCatalogRevision = catalog?.game.catalogRevision ?? "";
  const previewAttributes: OwnerIncomePreviewInput["attributes"] = {
    safe_box_code: typeof draft.attributes.safe_box_code === "string" ? draft.attributes.safe_box_code : null,
    vit_level: typeof draft.attributes.vit_level === "number" ? draft.attributes.vit_level : null,
    bear_level: typeof draft.attributes.bear_level === "number" ? draft.attributes.bear_level : null,
    rentalPricing: usesRentalModes(options) ? pricingSelection() : null,
    owner_deposit_declaration: (draft.attributes.owner_deposit_declaration as OwnerDepositDeclaration | undefined) ?? null,
    full_payout_declaration: (draft.attributes.full_payout_declaration as { schema: "full-payout-declaration-v1"; selected: boolean } | undefined) ?? null,
  };
  const catalogItemIds = new Set((catalog?.items ?? []).map((item) => item.id));
  const previewInventory = [
    ...(catalog?.items ?? []).map((item) => {
      const existing = draft.inventory.find((row) => row.itemId === item.id);
      const raw = existing?.quantity;
      return {
        itemId: item.id,
        quantity: raw === "" || raw === undefined ? null : raw,
      };
    }),
    ...draft.inventory
      .filter((row) => !catalogItemIds.has(row.itemId))
      .map((row) => ({
        itemId: row.itemId,
        quantity: row.quantity === "" || row.quantity === undefined ? null : row.quantity,
      })),
  ];
  const previewEntitlements = draft.entitlements.map((row) => ({
    entitlementId: row.entitlementId,
    value: row.value,
    expiresAt: row.expiresAt,
    expiryKnowledge: row.expiryKnowledge,
  }));
  const previewInput: OwnerIncomePreviewInput = {
    releaseId: previewReleaseId,
    catalogRevision: previewCatalogRevision,
    ...(accountId ? { accountId } : {}),
    attributes: previewAttributes,
    termOptionCode: draft.termOptionCode ?? null,
    ...(!usesRentalModes(options) && draft.pricingOptionCode ? { pricingOptionCode: draft.pricingOptionCode } : {}),
    inventory: previewInventory,
    entitlements: previewEntitlements,
  };
  const previewInputKey = JSON.stringify(previewInput);
  const previewScopeKey = JSON.stringify([epochRef.current, identityRef.current, accountId, gameId, previewCatalogRevision, previewReleaseId]);
  const previewEnabled = identityState === "confirmed" && Boolean(identityRef.current) && !authRequired && Boolean(gameId && previewReleaseId) && !writeIntent;
  const ownerPreview = previewEnabled && ownerIncomePreviewSnapshot?.scopeKey === previewScopeKey ? ownerIncomePreviewSnapshot.value : null;
  const ownerPreviewStale = Boolean(ownerPreview && ownerIncomePreviewSnapshot?.inputKey !== previewInputKey);
  useEffect(() => {
    if (!previewEnabled || !previewReleaseId) {
      setOwnerIncomePreview(null);
      setOwnerIncomePreviewPending(false);
      return;
    }
    setOwnerIncomePreview((previous) => (previous?.scopeKey === previewScopeKey ? previous : null));
    const context = captureContext(), controller = beginRequest();
    setOwnerIncomePreviewPending(true);
    const timer = setTimeout(() => {
      void supplyApi.ownerIncomePreview(gameId, JSON.parse(previewInputKey), controller.signal)
        .then((result) => {
          if (!currentContext(context, controller.signal)) return;
          if (
            result.binding &&
            (result.binding.gameId !== gameId ||
              result.binding.catalogRevision !== previewCatalogRevision ||
              result.binding.releaseId !== previewReleaseId)
          ) {
            setOwnerIncomePreview(null);
            return;
          }
          setOwnerIncomePreview({ value: result, scopeKey: previewScopeKey, inputKey: previewInputKey });
        })
        .catch((failure) => {
          if (!currentContext(context, controller.signal) || isAbort(failure)) return;
          setOwnerIncomePreview({
            value: {
              schema: "owner-income-preview.v1",
              state: "UNAVAILABLE",
              missingFields: [],
              reasonCodes: [failure instanceof SupplyRequestError ? failure.code ?? "PREVIEW_FAILED" : "PREVIEW_FAILED"],
              lines: [],
              ownerHaffIncome: null,
              ownerResourceIncome: null,
              knownResourceSubtotal: null,
              totalExpectedIncome: null,
              baseTenantDeposit: null,
              depositState: "UNAVAILABLE",
              ownerHaffRatioWanPerYuan: null,
              termSeconds: null,
              unitAmountsInformational: true,
              estimateOnly: true,
              incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES",
              binding: null,
              evaluatedAt: new Date().toISOString(),
              refreshAfter: new Date().toISOString(),
              rentalMode: null,
            },
            scopeKey: previewScopeKey,
            inputKey: previewInputKey,
          });
          if (failure instanceof SupplyRequestError && failure.status === 401) {
            reportFailure(failure, undefined, context);
          }
        })
        .finally(() => {
          if (currentContext(context, controller.signal)) setOwnerIncomePreviewPending(false);
          finishRequest(controller);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
      finishRequest(controller);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, previewEnabled, previewScopeKey, previewInputKey, writeIntent]);

  useEffect(()=>{
    if(!catalog||writeIntent||identityState!=="confirmed")return;
    const mapped=Object.entries(pendingResourceInputs).flatMap(([code,quantity])=>{
      const item=catalog.items.find(row=>canonicalResourceCode(row.code)===canonicalResourceCode(code));
      return item&&quantity!==""?[{code,itemId:item.id,quantity}]:[];
    });
    if(!mapped.length)return;
    setDraft(previous=>({...previous,inventory:[...previous.inventory.filter(row=>!mapped.some(item=>item.itemId===row.itemId)),...mapped.map(({itemId,quantity})=>({itemId,quantity}))]}));
    setPendingResourceInputs(previous=>Object.fromEntries(Object.entries(previous).filter(([code])=>!mapped.some(row=>row.code===code))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[catalog,pendingResourceInputs,identityState,writeIntent]);

  useEffect(() => {
    if (identityState !== "confirmed" || !identityRef.current || authRequired || !gameId || !gamesLoaded || loadingAccount) return;
    const subject = `${epochRef.current}:${identityRef.current}`;
    if (restoredSubjectRef.current === subject) return;
    restoredSubjectRef.current = subject;
    try {
      const record = loadSupplyIntent(identityRef.current);
      if (!record) { setIntentStorageIssue(""); return; }
      const target = record.receipt?.accountId ?? record.accountId;
      if (record.gameId !== gameId || (target && accountRef.current && target !== accountRef.current)) {
        setIntentStorageIssue("此身份还有另一份发布资料的操作待确认，请先回原资料核对。"); return;
      }
      storedIntentRef.current = record;
      if (record.phase === "pending") storedIntentRef.current = retainUncertainSupplyIntent(record);
      setIntentStorageIssue("");
      if (target) { accountRef.current = target; loadedAccountRef.current = target; setAccountId(target); }
      const context = captureContext(target ?? undefined, record.gameId);
      setWritePending({ action: record.action, context, persisted: record, run: () => recoverStoredIntent(record) });
      if (record.action === "save-draft") {
        const { expectedRevision: _revision, ...body } = record.body;
        const saved = body as unknown as DraftInput;
        draftRef.current = saved; setDraftState(saved); setDraftDirty(true);
        setDepositInput(yuanFromCents(depositDeclarationCents(saved.attributes) ?? "") ?? "");
      }
      setNotice(record.phase === "accepted" ? "原操作已返回成功，先重新读取结果后继续。" : "检测到上次未确认的操作，请先恢复原请求结果。");
    } catch { setIntentStorageIssue("无法读取原操作记录，暂不能提交。请保留本页并重试恢复。"); }
    // Initial subject read only: never auto-sends a business operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityState, authRequired, gameId, gamesLoaded, loadingAccount, intentRestoreVersion]);

  const game = games.find((item) => item.id === gameId) ?? null;
  const gameCrumb = game ? { label: game.name, href: game.code === "delta" ? "/#delta-section" : undefined } : null;
  const breadcrumbs = [{ label: "首页", href: "/" }, ...(gameCrumb ? [gameCrumb] : []), { label: "上架出租" }];
  const navigationDialog = !busy && !writePending && hasUnsaved ? (
    <AlertDialog.Root open={navigationIntent !== null} onOpenChange={(next) => { if (!next) cancelNavigation(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-overlay ui-alert-dialog-backdrop" />
        <AlertDialog.Popup className="ui-alert-dialog publish-leave-dialog" data-slot="alert-dialog-content">
          <AlertDialog.Title className="ui-alert-dialog-title">保存当前上架资料？</AlertDialog.Title>
          <AlertDialog.Description className="ui-alert-dialog-description">
            你正在编辑的账号资料尚未保存为草稿。离开前是否需要保存？
          </AlertDialog.Description>
          <div className="ui-alert-dialog-actions publish-leave-actions">
            <button
              type="button"
              className="button primary"
              disabled={Boolean(busy)}
              onClick={() => void saveAndLeave()}
            >
              {busy === "save" ? "保存中…" : "保存草稿并离开"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={Boolean(busy)}
              onClick={leaveConfirmed}
            >
              放弃修改并离开
            </button>
            <button
              type="button"
              className="button quiet"
              disabled={Boolean(busy)}
              onClick={cancelNavigation}
            >
              继续填写
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  ) : (
    <ConfirmAlertDialog
      open={navigationIntent !== null}
      onOpenChange={(next) => { if (!next) cancelNavigation(); }}
      title={busy ? "当前操作尚未完成" : writePending ? "先确认上次操作结果" : "保留当前修改？"}
      description={busy ? "请等待当前操作完成，再离开本页。" : writePending ? "上次操作结果仍待确认，请先通过原操作核对结果，再离开本页。" : (navigationIntent?.message ?? "本页还有未保存的资料。离开后，这些修改不会保留。")}
      cancelLabel={writePending || busy ? "留在此页" : "继续填写"}
      confirmLabel={navigationIntent?.label ?? "离开页面"}
      confirmDisabled={writePending || Boolean(busy)}
      busy={Boolean(busy)}
      onConfirm={leaveConfirmed}
      returnFocusRef={navigationFocusRef}
      className="publish-leave-dialog"
    />
  );
  const ammoDialog = <AlertDialog.Root open={ammoReview !== null && identityState === "confirmed" && currentContext(ammoReview.context)} onOpenChange={open => { if (!open) closeAmmoReview(); }}>
    <AlertDialog.Portal><AlertDialog.Backdrop className="modal-overlay publish-dialog-backdrop" />
      <AlertDialog.Popup className="publish-dialog publish-ammo-dialog" data-slot="alert-dialog-content" finalFocus={() => ammoFocusRef.current?.isConnected ? ammoFocusRef.current : false}>
        <div className="publish-ammo-dialog-body">
          <div className="publish-ammo-dialog-header">
            <span className="publish-ammo-icon" aria-hidden="true"><TriangleAlert size={20} /></span>
            <AlertDialog.Title>请核对六级子弹数量</AlertDialog.Title>
          </div>
          <div className="publish-ammo-summary-box">
            <p className="publish-ammo-review-count">你填写了<strong>{ammoReview ? ammoQuantityText(ammoReview.quantity) : ""}</strong></p>
            <span className="publish-ammo-unit-badge">按 60发/组 折算</span>
          </div>
          <AlertDialog.Description>六级子弹按<strong>60发/组</strong>填写，请确认填写的是“组数”而非单发子弹数量，避免物资估价过高。确认后本次编辑内再次调整数量将不再重复弹窗。</AlertDialog.Description>
        </div>
        <div className="publish-ammo-dialog-actions">
          <AlertDialog.Close className="button secondary">返回修改</AlertDialog.Close>
          <button type="button" className="button primary" onClick={confirmAmmoReview}>确认数量无误</button>
        </div>
      </AlertDialog.Popup>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
  const publishShell = {
    surface: "editor" as const,
    showPageHeading: false,
    headingInContent: true,
    showBack: false,
    contextLabel: null,
    breadcrumbs,
    topContent: <>{navigationDialog}{ammoDialog}</>,
    backHref: accountIdProp ? `/account?view=accounts&accountId=${encodeURIComponent(accountIdProp)}` : "/accounts",
    backLabel: accountIdProp ? "返回账号管理" : "返回账号列表",
    searchLabel: "在公开账号目录中搜索",
    searchPlaceholder: "搜索账号编号或名称",
    onSearch: (value: string) => requestNavigation({ message: "本页还有未保存的资料。离开后，这些修改不会保留。", label: "放弃修改并离开", run: () => router.push(`/accounts?q=${encodeURIComponent(value)}`) }),
  };

  const published = supply?.version?.reviewState === "PUBLISHED" && !["ARCHIVED", "DELISTED"].includes(supply.account.lifecycle ?? "");
  const quoteData = supply?.version?.quote ?? null;
  const effectiveQuote = quoteData && !quoteStale ? quoteData : null;
  const payoutSelected = fullPayoutSelected(draft.attributes);
  const payoutReleaseId = effectiveQuote?.ruleReleaseId ?? options?.releaseId;
  const payoutTarget = JSON.stringify([identityRef.current, gameId, accountId, supply?.version?.id, supply?.version?.revision, payoutReleaseId, supply?.version?.contentHash]);
  useEffect(() => {
    setPayoutAccepted(false);
    if (payoutSelected !== true || !payoutReleaseId || identityState !== "confirmed" || published) { setPayoutTerms(null); return; }
    const controller = new AbortController();
    setPayoutTerms({ target: payoutTarget, status: "loading", terms: null });
    supplyApi.fullPayoutTerms(gameId, payoutReleaseId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setPayoutTerms(result.releaseId === payoutReleaseId && result.fullPayoutTerms
        ? { target: payoutTarget, status: "ready", terms: result.fullPayoutTerms }
        : { target: payoutTarget, status: "unavailable", terms: null });
    }).catch(() => {
      if (!controller.signal.aborted) setPayoutTerms({ target: payoutTarget, status: "unavailable", terms: null });
    });
    return () => controller.abort();
  }, [payoutSelected, payoutReleaseId, payoutTarget, identityState, published, gameId]);
  const currentPayoutTerms = payoutTerms?.target === payoutTarget && payoutTerms.status === "ready" ? payoutTerms.terms : null;
  const payoutAcceptance: FullPayoutTermsAcceptance | undefined = payoutSelected === true && payoutAccepted && currentPayoutTerms
    ? { termsVersionId: currentPayoutTerms.termsVersionId, termsDigest: currentPayoutTerms.termsDigest, disclosureVersion: currentPayoutTerms.disclosureVersion } : undefined;

  if (identityState === "checking") return <ServiceShell {...publishShell} title="上架出租"><PublishVisualBanner /><SessionLoading layout="form" label="正在加载上架资料…" /></ServiceShell>;
  if (identityState === "guest") return <ServiceShell {...publishShell} title="上架出租"><PublishVisualBanner /><RecoveryAlert className="session-recovery" tone="info" title="登录后即可出租账号" problem="登录后填写账号资料，核对费用并提交上架。" action={<Link className="button primary" href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/publish" : window.location.pathname + window.location.search)}`}>登录并继续</Link>} /></ServiceShell>;
  if (identityState === "failed") return <ServiceShell {...publishShell} title="上架出租"><PublishVisualBanner /><RecoveryAlert className="session-recovery" tone="unknown" live title="暂时无法加载上架资料" problem="登录状态读取失败，请重试。" impact={meaningfulDraft(draft) || media.length > 0 || writeIntent ? "刚才填写的内容仍保留在本页，请先不要关闭。" : undefined} action={<button type="button" className="button primary" onClick={() => void sharedSession.confirm()}>重试</button>} /></ServiceShell>;
  if (identityState === "confirmed" && authRequired && identityRef.current) return <ServiceShell {...publishShell} title="上架出租"><PublishVisualBanner /><RecoveryAlert className="session-recovery" tone="unknown" live title="登录状态已失效" problem="请重新确认登录状态后继续。" impact="刚才填写的内容仍保留在本页，请先不要关闭。" action={<button type="button" className="button primary" onClick={() => void sharedSession.confirm()}>重新确认身份</button>} /></ServiceShell>;
  if (!accountIdProp && gamesLoaded && games.length === 0) return <ServiceShell {...publishShell} title="上架出租" description="填写账号资料并提交上架。"><PublishVisualBanner /><section className="account-guest"><h2>暂未开放上架</h2><p>目前没有开放出租的游戏，请稍后再来。</p><Link className="button secondary" href="/">返回首页</Link></section></ServiceShell>;

  const blockers = [...(catalog?.blockers ?? []).map((item) => item.code), ...(supply?.blockers ?? [])];
  const breakdown = ownerQuoteBreakdown(quoteData);
  const agreement = supply?.agreement ?? options?.agreement ?? null;
  const readOnly = Boolean(accountId && !editing);
  const mustCreateAccount = ["ARCHIVED", "DELISTED"].includes(supply?.account.lifecycle ?? "") || supply?.version?.origin === "LEGACY_OBSERVATION" || Boolean(supply?.version?.publication) || ["PUBLISHED", "APPROVED"].includes(supply?.version?.reviewState ?? "") || Boolean(supply?.blockers?.includes("LEGACY_LISTING_RELIST_REQUIRED"));
  const formDisabled = identityState !== "confirmed" || !identityRef.current || readOnly || Boolean(busy) || writePending || Boolean(intentStorageIssue);
  const requireNewAccountFacts = !(typeof draft.attributes.legacy_published_reference === "string" && draft.attributes.legacy_published_reference.trim());
  const declarationOptions = options?.declarationOptions;
  const infoSourceOptions = declarationOptions?.info_source;
  const infoSourceValue = typeof draft.attributes.info_source === "string" ? draft.attributes.info_source : "";
  const infoSourceLegacy = Boolean(infoSourceValue && !infoSourceOptions?.options?.some(option => option.value === infoSourceValue));
  const netEstimate = !ownerPreviewStale && !ownerIncomePreviewPending ? matchedOwnerNetEstimate(ownerPreview, payoutSelected, effectiveQuote) : null;
  const reviewState = supply?.version?.reviewState;
  const safeBoxOptions = options?.safeBoxOptions ?? [];
  const gradingOptions = options?.gradingOptions ?? [];
  const loginMethodOptions = options?.loginMethodOptions ?? [];
  const currentGrading = String(draft.attributes.grading_code ?? "");
  const currentGradingDivision = draft.attributes.grading_division !== null && draft.attributes.grading_division !== undefined && draft.attributes.grading_division !== ""
    ? Number(draft.attributes.grading_division)
    : null;
  const selectedGradingOption = gradingOptions.find((option) => option.code === currentGrading) as { divisions?: number[] } | undefined;
  const currentDivisions = selectedGradingOption?.divisions?.length
    ? selectedGradingOption.divisions
    : ["2", "3", "4", "5", "6", "7"].includes(currentGrading)
      ? [3, 2, 1]
      : [];
  const currentLoginMethod = String(draft.attributes.login_method_code ?? "");
  const currentSafeBox = String(draft.attributes.safe_box_code ?? "");
  const currentVitality = draft.attributes.vit_level === null || draft.attributes.vit_level === undefined ? "" : String(draft.attributes.vit_level);
  const currentBear = draft.attributes.bear_level === null || draft.attributes.bear_level === undefined ? "" : String(draft.attributes.bear_level);
  const safeBoxKnown = currentSafeBox !== "" && (options?.safeBoxCodes ?? []).includes(currentSafeBox);
  const safeBoxDisplay = supply?.version?.attributeDisplay?.safeBox;
  const retainedSafeBoxLabel = safeBoxDisplay?.code === currentSafeBox && safeBoxDisplay.displayName
    ? safeBoxDisplay.displayName
    : "未确认";
  const is3x3SafeBox = is3x3SafeBoxCode;

  const hasInsuranceCardFilled = draft.inventory.some((row) => {
    const item = catalog?.items.find((item) => item.id === row.itemId) ?? supply?.version?.catalogItems?.find((item) => item.id === row.itemId);
    const code = item?.code ?? null;
    return (canonicalResourceCode(code) === "df_billable_top_insure_card" || code === "legacy_insurance_day") && typeof row.quantity === "string" && /^[1-9]\d*$/.test(row.quantity);
  }) || Boolean(
    (pendingResourceInputs["df_billable_top_insure_card"] && /^[1-9]\d*$/.test(pendingResourceInputs["df_billable_top_insure_card"]))
    || (pendingResourceInputs["legacy_insurance_day"] && /^[1-9]\d*$/.test(pendingResourceInputs["legacy_insurance_day"]))
  );

  const is3x3SafeBoxSelected = is3x3SafeBox(currentSafeBox, safeBoxDisplay?.code === currentSafeBox ? safeBoxDisplay.displayName : safeBoxOptions.find((o) => o.code === currentSafeBox)?.displayName);

  const safeBoxChoiceOptions = [
    ...(currentSafeBox && !safeBoxKnown ? [{
      value: currentSafeBox,
      label: retainedSafeBoxLabel,
      hintTooltip: is3x3SafeBox(currentSafeBox, retainedSafeBoxLabel) ? "此选项仅限赛季3x3可选" : undefined,
      disabled: is3x3SafeBox(currentSafeBox, retainedSafeBoxLabel) && hasInsuranceCardFilled,
      tooltip: is3x3SafeBox(currentSafeBox, retainedSafeBoxLabel) && hasInsuranceCardFilled ? "已填写九格保险体验卡，不可与顶级安全箱(3*3)同时选择（只能二选一）" : undefined,
    }] : []),
    ...(options?.safeBoxCodes.map((code) => {
      const option = safeBoxOptions.find((item) => item.code === code);
      const displayName = option?.displayName ?? "未确认";
      const is3x3 = is3x3SafeBox(code, displayName);
      const disabled3x3 = is3x3 && hasInsuranceCardFilled;
      return {
        value: code,
        label: displayName,
        hintTooltip: is3x3 ? "此选项仅限赛季3x3可选" : undefined,
        disabled: disabled3x3,
        tooltip: disabled3x3 ? "已填写九格保险体验卡，不可与顶级安全箱(3*3)同时选择（只能二选一）" : undefined,
      };
    }) ?? []),
  ];
  // Owner 要求：前端隐藏“Steam国际服”上号方式选项，避免大改后端代码与枚举（勿当成 bug 移除）
  const visibleLoginMethodOptions = loginMethodOptions.filter(
    (option) => option.code !== "legacy_login_steam_global" && option.displayName !== "Steam国际服"
  );
  const loginChoiceOptions = [
    ...(currentLoginMethod && !visibleLoginMethodOptions.some((option) => option.code === currentLoginMethod)
      ? [{ value: currentLoginMethod, label: "未确认" }]
      : []),
    ...(visibleLoginMethodOptions.map((option) => ({ value: option.code, label: option.displayName ?? "未确认", icon: <LoginPlatformIcon code={option.code} /> }))),
  ];
  const vitalityChoiceOptions = numericChoiceOptions(currentVitality, (options?.vitalityLevels ?? []).filter(level => level >= 4 && level <= 7));
  const bearChoiceOptions = numericChoiceOptions(currentBear, (options?.bearLevels ?? []).filter(level => level >= 4 && level <= 7));
  const currentDive = draft.attributes.dive_level === null || draft.attributes.dive_level === undefined ? "" : String(draft.attributes.dive_level);
  const diveChoiceOptions = numericChoiceOptions(currentDive, [0, 1, 2, 3]);
  const vitalityChoiceNote = retainedNumericChoiceNote(currentVitality, [4, 5, 6, 7], "体力");
  const bearChoiceNote = retainedNumericChoiceNote(currentBear, [4, 5, 6, 7], "负重");
  const diveChoiceNote = retainedNumericChoiceNote(currentDive, [0, 1, 2, 3], "潜水");
  const inventoryHaffId = (catalog?.items ?? []).find((item) => item.unit === "HAFF_BASE")?.id;
  const allInventoryRows = inventoryEditorRows(catalog, draft.inventory, supply?.version?.catalogItems, catalog ? "ready" : catalogAvailability);
  const haffInventoryRow = allInventoryRows.find((item) => item.unit === "HAFF_BASE" && (!inventoryHaffId || item.itemId === inventoryHaffId));
  const haffFieldError = inventoryHaffId ? fieldErrors.find((item) => item.path.startsWith("inventory") && item.path.includes(inventoryHaffId)) : undefined;
  const haffErrorMessage = haffProblem()?.message ?? (haffFieldError ? fieldErrorText("inventory", haffFieldError.code) : undefined);
  const inventoryFieldError = fieldErrors.find((item) => item.path.startsWith("inventory") && !(inventoryHaffId && item.path.includes(inventoryHaffId)));
  const inventoryRows = allInventoryRows.filter((item) => item !== haffInventoryRow).map(item=>({...item,code:catalog?.items.find(row=>row.id===item.itemId)?.code??supply?.version?.catalogItems?.find(row=>row.id===item.itemId)?.code??null}))
    .filter(item=>!retiredInsuranceCode(item.code)||draft.inventory.some(row=>row.itemId===item.itemId))
    .map(item=>retiredInsuranceCode(item.code)?{...item,required:false}:item);
  const missingResourceRows=catalog?[{code:"df_billable_barrett_bullet",name:"巴雷特子弹",unit:"ROUND"},{code:"df_billable_top_insure_card",name:INSURANCE_EXPERIENCE_CARD,unit:"DAY"}].filter(item=>!catalog.items.some(row=>canonicalResourceCode(row.code)===canonicalResourceCode(item.code))).map(item=>({...item,itemId:null,quantity:pendingResourceInputs[item.code]??null,priced:null,required:false,catalogState:"pending" as const})):[];
  const resourceOrder = ["df_billable_level6_bullet", "df_billable_level6_armor", "df_billable_level6_helmet", "df_billable_awm_bullet", "df_billable_barrett_bullet", "df_billable_top_insure_card", "df_billable_coffee"];
  const resourcePosition = (code: string | null) => { const index = resourceOrder.indexOf(canonicalResourceCode(code) ?? ""); return index < 0 ? resourceOrder.length : index; };
  const resourceRows=[...inventoryRows,...missingResourceRows].sort((a,b)=>resourcePosition(a.code)-resourcePosition(b.code));
  const savedSkinNames = new Map((supply?.version?.presentation?.skins ?? []).map((skin) => [skin.id, skin.name]));
  const skinName = (id: string) => knownSkins[id]?.name ?? savedSkinNames.get(id) ?? "目录名称待加载";
  const skinTypes = catalog?.skinFilters?.ownerKinds ? skinTypeOptions(catalog.skinFilters.ownerKinds) : catalog?.categories ?? [];
  const activeSkinCategory = skinCategory || skinTypes[0]?.id || "";
  const activeSkinKind = skinTypes.find((category) => category.id === activeSkinCategory)?.ownerKind;
  const skinOwners = (catalog?.owners ?? []).filter((owner) => !activeSkinKind || owner.kind === activeSkinKind);
  const visibleSkinRows = (catalog?.skins ?? []).filter((skin) => !activeSkinCategory || (catalog?.skinFilters ? skin.ownerKind === activeSkinCategory : skin.categoryId === activeSkinCategory));
  const skinFilters: SkinQuery = { q: skinQuery.trim(), ...(catalog?.skinFilters && isSkinOwnerKind(activeSkinCategory) ? { ownerKind: activeSkinCategory } : { categoryId: activeSkinCategory }), rarityCode: skinRarity, ownerId: skinOwner };
  const showPricingSelect = !usesRentalModes(options);
  const disabledPricing = formDisabled || !options;
  const haffBaseMissing = [
    ...(!draft.attributes.safe_box_code ? [{ label: "安全箱档位", target: "publish-attribute-safe-box" }] : []),
    ...(draft.attributes.vit_level == null ? [{ label: "体力等级", target: "publish-attribute-vit" }] : []),
    ...(draft.attributes.bear_level == null ? [{ label: "负重等级", target: "publish-attribute-bear" }] : []),
  ];
  const haffBaseIncomplete = haffBaseMissing.length > 0;
  const haffControlsDisabled = formDisabled || haffBaseIncomplete;
  const rentalModes = options?.rentalModes;
  const rentalModeEntries: RentalMode[] = (["ordinary", "custom", "fast"] as const).filter((entry) => rentalModes ? rentalModes[entry]?.enabled : true);
  const ratioRanges = !ownerPreviewStale && !ownerIncomePreviewPending ? ownerPreview?.ratioRanges : null;
  liveRatioRangesRef.current = ratioRanges ?? null;
  const selectedRatioRange = ratioDisplayText(ratioRanges?.[rentalMode]);
  const modeRange = ratioRangeText(rentalModes?.[rentalMode]);
  const ratioInlineProblem = ratioInput.trim() === "" ? null : ratioEntryProblem(rentalMode, rentalModes?.[rentalMode], ratioInput, ratioRanges?.[rentalMode]);
  const fastReady = optionsAvailability === "ready" && usesRentalModes(options) && rentalModes?.fast?.enabled === true;
  // The guarantee cannot be determined until the draft has a current quote.
  const visibleBlockers = [...new Set(blockers)].filter((code) => !FORM_ENTRY_BLOCKER_CODES.has(code) && (code !== "PUBLISHER_BAIL_UNCONFIRMED" || Boolean(effectiveQuote)));
  const userBlockers = visibleBlockers.filter((code) => supplyBlockerGroup(code) === "USER");
  const systemBlockers = visibleBlockers.filter((code) => supplyBlockerGroup(code) === "SYSTEM");
  const blockerHint = visibleBlockers.length ? "当前暂无法上架" : undefined;
  const serviceWindowStart = typeof draft.attributes.service_window_start_minute === "number" ? draft.attributes.service_window_start_minute : null;
  const serviceWindowEnd = typeof draft.attributes.service_window_end_minute === "number" ? draft.attributes.service_window_end_minute : null;
  const serviceWindowAllDay = serviceWindowStart === 0 && serviceWindowEnd === 1440 && draft.attributes.service_window_cross_midnight === false;
  const serviceWindowMode = serviceWindowAllDay ? "allDay" : serviceWindowCustomSelected || serviceWindowStart !== null || serviceWindowEnd !== null ? "window" : null;
  const serviceWindowEqual = serviceWindowStart !== null && serviceWindowEnd !== null && serviceWindowStart === serviceWindowEnd && !serviceWindowAllDay;
  const serviceWindowHasLegacyValue = (serviceWindowStart !== null && !SERVICE_WINDOW_START_OPTIONS.includes(serviceWindowStart)) || (serviceWindowEnd !== null && !SERVICE_WINDOW_END_OPTIONS.includes(serviceWindowEnd));
  const hasBanRecord = draft.attributes.ban_record === true;
  const retainedPenaltyCount = media.filter(item => item.category === "PENALTY" || item.purpose === "ACCOUNT_EVIDENCE").length;

  const errorGroups = new Set(fieldErrors.map((item) => publishGroupForPath(item.path, inventoryHaffId)));
  const quotedHaffRatio = effectiveQuote?.ownerHaffRatio;
  const declaredDepositCents = yuanToCents(depositInput);
  const actualPublisherRequirement = centsOfMoney(effectiveQuote?.publisherBailRequirement);
  const quoteConsistent = !effectiveQuote || Boolean(breakdown);
  const mediaStatusText = (item: MediaEntry) => item.status === "uploading"
    ? "上传中…"
    : item.status === "failed"
      ? item.error ?? "上传未完成"
      : item.reviewState === "REJECTED" || item.reviewState === "QUARANTINED"
        ? `${item.bindingSaved ? "已保存" : "已上传"} · ${mediaReviewLabel(item.reviewState)}`
        : item.bindingSaved ? "已保存" : "已上传，待保存";

  const primaryLabel = busy === "submit" ? "上架中…" : busy === "accept" ? "确认条款中…" : busy === "quote" ? "正在提交…" : "确认上架";
  const primaryDisabled = readOnly || Boolean(busy) || writePending || Boolean(intentStorageIssue) || identityState !== "confirmed" || !identityRef.current || visibleBlockers.length > 0 || (effectiveQuote ? !quoteConsistent || (payoutSelected === true && !payoutAcceptance) : false);
  const primaryAction = async () => {
    if (primaryDisabled) return;
    const hasUnsavedMedia = media.some((item) => !item.bindingSaved);
    const needsSaveAndQuote = draftDirty || hasUnsavedMedia || !effectiveQuote || !quoteConsistent;

    if (!needsSaveAndQuote && effectiveQuote) {
      await confirmPublish();
      return;
    }

    const problem = quoteProblem();
    if (problem) {
      locate(problem.group, problem.message, problem.target);
      return;
    }
    if (requireAmmoReview(() => { void primaryAction(); })) return;
    if (!agreementChecked) {
      if (typeof window !== "undefined" && window.innerWidth <= 1023) setRailExpanded(true);
      locate("terms", "请先阅读并勾选同意出租协议。");
      return;
    }
    if (payoutSelected === true && currentPayoutTerms && !payoutAcceptance) {
      if (typeof window !== "undefined" && window.innerWidth <= 1023) setRailExpanded(true);
      locate("terms", "请先阅读并同意本次全额包赔条款。");
      return;
    }

    const context = captureContext();
    setBusy("quote");
    setError(null);
    try {
      const draftRequest = await prepareDraftRequest(context, "quote", () => primaryAction());
      if (!draftRequest) return;
      const saved = await sendDraftRequest(draftRequest, "quote", () => primaryAction());
      if (!saved || !currentContext({ ...draftRequest.context, accountId: draftRequest.accountId })) return;

      const quoted = await sendQuoteRequest(context, saved, "quote");
      if (!quoted) return;

      if (!Array.isArray(quoted.blockers) || quoted.blockers.some((code) => !FORM_ENTRY_BLOCKER_CODES.has(code))) {
        setNotice("报价已生成，请先核对上架条件，再确认上架。");
        return;
      }

      const authoritativeCents = centsOfMoney(quoted.version?.quote?.ownerTotal);
      const snapshotVal = ownerIncomePreviewSnapshot?.value;
      const previewCents = snapshotVal?.totalExpectedIncome
        ? centsOfMoney(snapshotVal.totalExpectedIncome)
        : (snapshotVal?.ownerHaffIncome && snapshotVal?.knownResourceSubtotal)
          ? (centsOfMoney(snapshotVal.ownerHaffIncome) ?? 0n) + (centsOfMoney(snapshotVal.knownResourceSubtotal) ?? 0n)
          : null;

      if (previewCents !== null && authoritativeCents !== null && previewCents !== authoritativeCents) {
        setNotice(`预估收入已更新为 ${moneyText(quoted.version?.quote?.ownerTotal)}，请核对后再次点击确认上架。`);
        setAgreementChecked(false);
        return;
      }

      if (payoutSelected === true) {
        setNotice("请阅读并确认本次全额包赔条款后再次点击确认上架。");
        return;
      }

      await confirmPublish();
    } catch (failure) {
      reportWriteFailure(failure, context);
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };
  const hasPendingResources = Object.values(pendingResourceInputs).some((value) => value !== "");
  const hasUnpricedCatalogItem = Boolean(
    catalog?.items.some((item) => item.unit !== "HAFF_BASE" && !retiredInsuranceCode(item.code) && item.priced === false),
  );
  const resourcePreviewState: string | null = ownerPreview
    ? ownerPreview.state === "UNAVAILABLE"
      ? "暂未取得有效价目，已填数量会保留。"
      : (hasUnpricedCatalogItem || hasPendingResources) && ownerPreview.state === "PARTIAL"
        ? (ownerPreview.knownResourceSubtotal
          ? `部分新增资源价目配置中，预估已含已定价物品（¥ ${ownerPreview.knownResourceSubtotal.amount}）。`
          : "部分新增资源价目配置中，预估仅含已定价物品。")
        : null
    : ownerIncomePreviewPending
      ? "正在读取物品单价与预估…"
      : hasPendingResources
        ? "新增资源价目配置中，数量暂存于本页。"
        : null;
  const resourceTotalText = effectiveQuote && breakdown ? `${centsText(breakdown.itemCents)} 元`
    : ownerPreview?.ownerResourceIncome ? `${ownerPreview.ownerResourceIncome.amount} 元`
    : ownerPreview?.knownResourceSubtotal ? `${ownerPreview.knownResourceSubtotal.amount} 元`
    : hasPendingResources ? "待资源配置"
    : ownerIncomePreviewPending ? "读取中…"
    : ownerPreview?.state === "PARTIAL" ? "价目待配置"
    : ownerPreview?.state === "UNAVAILABLE" ? "预估暂不可用" : null;
  const currentTermOption = options?.termOptions.find((o) => o.code === draft.termOptionCode);
  const rawTermAdjustment = currentTermOption?.ownerRatioAdjustmentWanPerYuan;
  const termAdjustmentText = typeof rawTermAdjustment === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(rawTermAdjustment)
    ? /^[+-]?0(?:\.0+)?$/.test(rawTermAdjustment) ? "不调整" : `${/^[+-]/.test(rawTermAdjustment) ? rawTermAdjustment : `+${rawTermAdjustment}`} 万/元`
    : null;
  const liveDailyConsumption = currentTermOption?.dailyConsumption;
  const haffBaseValue = baseFromHaffM(haffInput);
  const calculatedDays = haffBaseValue && liveDailyConsumption && BigInt(liveDailyConsumption) > 0n && BigInt(haffBaseValue) > 0n
    ? `${(BigInt(haffBaseValue) + BigInt(liveDailyConsumption) - 1n) / BigInt(liveDailyConsumption)} 天`
    : null;
  const displayEstimateDuration = effectiveQuote
    ? durationText(effectiveQuote.termSeconds)
    : ownerPreview?.termSeconds
    ? durationText(ownerPreview.termSeconds)
    : calculatedDays
    ? calculatedDays
    : null;
  const pendingTotalHint = haffBaseIncomplete
    ? `请先补全${haffBaseMissing.map((item) => item.label).join("、")}`
    : !haffInput.trim()
    ? "请先填写哈夫币余额"
    : !draft.termOptionCode
    ? "请选择每日消耗"
    : ratioInlineProblem
    ? "请按允许范围填写兑换比例"
    : (rentalMode === "custom" || rentalMode === "fast") && !ratioInput.trim()
    ? "请填写出租比例"
    : ownerIncomePreviewPending
    ? "正在核算…"
    : "填写哈夫币与出租条件后自动估算";
  const durationResult = displayEstimateDuration
    ?? (ownerIncomePreviewPending
      ? "计算中…"
      : ownerPreview?.state === "UNAVAILABLE"
        ? "暂不可用"
        : !haffInput.trim() && !draft.termOptionCode
          ? "待补余额与日耗"
          : !haffInput.trim()
            ? "待补余额"
            : !draft.termOptionCode
              ? "待选日耗"
              : "待核算");
  const validLiveRatioInput = (rentalMode === "custom" || rentalMode === "fast") && Boolean(ratioInput.trim()) && !ratioInlineProblem;
  const ratioKnown = Boolean(quotedHaffRatio || (!ratioInlineProblem && ownerPreview?.ownerHaffRatioWanPerYuan) || validLiveRatioInput);
  const ratioResult = quotedHaffRatio
    ? `${quotedHaffRatio} 万哈夫币/元`
    : haffBaseIncomplete
      ? "待补账号属性"
      : ratioInlineProblem
        ? "待输入有效比例"
        : ownerPreview?.ownerHaffRatioWanPerYuan
          ? `${ownerPreview.ownerHaffRatioWanPerYuan} 万哈夫币/元`
          : validLiveRatioInput
            ? `${ratioInput} 万哈夫币/元`
            : rentalMode === "custom" || rentalMode === "fast"
              ? "待填比例"
              : ownerIncomePreviewPending
                ? "计算中…"
                : ownerPreview?.state === "UNAVAILABLE"
                  ? "暂不可用"
                  : !draft.termOptionCode
                    ? "待选日耗"
                    : "待核算";
  const previewGrossAmount = (ownerPreview?.state === "READY" && ownerPreview.totalExpectedIncome?.amount)
    ? ownerPreview.totalExpectedIncome.amount
    : (ownerPreview?.ownerHaffIncome && ownerPreview?.knownResourceSubtotal)
      ? centsText((centsOfMoney(ownerPreview.ownerHaffIncome) ?? 0n) + (centsOfMoney(ownerPreview.knownResourceSubtotal) ?? 0n))
      : ownerPreview?.totalExpectedIncome?.amount ?? null;
  const railSummary = netEstimate
    ? { label: "预计所得", value: `${netEstimate.ownerNet.amount} 元`, pending: false }
    : effectiveQuote
      ? { label: "预计总收入", value: breakdown ? `${centsText(breakdown.totalCents)} 元` : "金额待核对", pending: !breakdown }
      : previewGrossAmount
        ? { label: payoutSelected === true ? "预计收入（扣费前）" : ownerPreview?.state === "PARTIAL" ? "预计总收入（部分）" : "预计总收入", value: `${previewGrossAmount} 元`, pending: false }
        : { label: "预计总收入", value: "待核算", pending: true };
  const groupDone: Record<PublishGroupId, boolean> = {
    account: Boolean(
      currentSafeBox &&
      currentGrading &&
      currentVitality !== "" &&
      currentBear !== "" &&
      currentDive !== "" &&
      currentLoginMethod &&
      serviceWindowMode &&
      typeof draft.attributes.ban_record === "boolean" &&
      typeof draft.attributes.face_is_self === "boolean",
    ),
    assets:
      draft.inventory.some((row) => row.itemId !== inventoryHaffId && row.quantity !== null && row.quantity !== "" && row.quantity !== "0") ||
      draft.skins.length > 0,
    media:
      media.some((item) => item.category !== "PENALTY" && item.purpose === "ACCOUNT_DISPLAY" && item.status === "bound") &&
      (!hasBanRecord || media.some((item) => (item.category === "PENALTY" || item.purpose === "ACCOUNT_EVIDENCE") && item.status === "bound")),
    terms: Boolean(haffInput.trim() && draft.termOptionCode && typeof payoutSelected === "boolean" && declaredDepositCents !== null),
  };
  skinFiltersRef.current = skinFilters;
  pasteGuardRef.current = {
    blocked: Boolean(formDisabled || !gameId || readingNotice || termsModalOpen || payoutTermsModalOpen || previewMedia || ammoReview || navigationIntent),
    hasBanRecord,
    acceptFiles,
  };
  const accountRequiredChecks = [
    Boolean(currentSafeBox),
    typeof draft.attributes.character_level === "number",
    Boolean(currentGrading),
    !requireNewAccountFacts || Boolean(String(draft.attributes.secret_kd ?? "").trim()),
    currentVitality !== "",
    currentBear !== "",
    currentDive !== "",
    Boolean(currentLoginMethod),
    !requireNewAccountFacts || Boolean(draft.attributes.region_province && draft.attributes.region_city),
    !requireNewAccountFacts || Boolean(serviceWindowMode),
    !requireNewAccountFacts || typeof draft.attributes.ban_record === "boolean",
    !requireNewAccountFacts || typeof draft.attributes.face_is_self === "boolean",
    ...(["next_season_pass", "demulan_unlocked"] as const)
      .filter((key) => declarationOptions?.[key]?.enabled && declarationOptions?.[key]?.required)
      .map((key) => typeof draft.attributes[key] === "boolean"),
  ];
  const accountRequiredDone = accountRequiredChecks.filter(Boolean).length;
  const accountRequiredTotal = accountRequiredChecks.length;
  const applyServiceWindowPreset = (start: number, end: number) => {
    setServiceWindowCustomSelected(true);
    setDraft((previous) => ({
      ...previous,
      attributes: {
        ...previous.attributes,
        service_window_start_minute: start,
        service_window_end_minute: end,
        service_window_cross_midnight: end < start,
        service_window_timezone: "Asia/Shanghai",
      },
    }));
  };
  const selectedSkinCountForCategory = (categoryId: string) => draft.skins.filter((id) => {
    const known = knownSkins[id];
    const saved = supply?.version?.presentation?.skins?.find((skin) => skin.id === id);
    return catalog?.skinFilters
      ? (known?.ownerKind ?? saved?.ownerKind) === categoryId
      : known?.categoryId === categoryId;
  }).length;
  const noticeReturnFocus = () => {
    if (noticeManualRef.current && noticeTriggerRef.current?.isConnected) {
      noticeManualRef.current = false;
      return noticeTriggerRef.current;
    }
    return document.querySelector<HTMLElement>(".publish-outline a");
  };
  const agreementConsent = <div className="publish-consent-row publish-agreement-acceptance">
    <label className="supply-check"><input type="checkbox" checked={agreementChecked} disabled={formDisabled || !agreement} aria-label="我已阅读并同意出租协议" onChange={(event) => setAgreementChecked(event.target.checked)} /><span>我已阅读并同意</span></label>
    {agreement ? <button type="button" className="publish-terms-inline-link" onClick={() => setTermsModalOpen(true)}>出租协议</button> : null}
  </div>;
  const payoutConsent = payoutSelected === true ? <div className="publish-consent-row publish-payout-acceptance">
    <label className="supply-check"><input type="checkbox" checked={Boolean(payoutAcceptance)} disabled={formDisabled || !currentPayoutTerms} aria-label="我已阅读并同意包赔条款" onChange={(event) => setPayoutAccepted(event.target.checked)} /><span>我已阅读并同意</span></label>
    {currentPayoutTerms ? <button type="button" className="publish-terms-inline-link" onClick={() => setPayoutTermsModalOpen(true)}>包赔条款</button> : null}
  </div> : null;

  const modeHref = (fast: boolean) => {
    const params = new URLSearchParams();
    if (game?.code) params.set("game", game.code);
    if (fast) params.set("mode", "fast");
    if (accountId) params.set("accountId", accountId);
    if (accountIdProp && editRequested) params.set("edit", "1");
    return params.size ? `/publish?${params.toString()}` : "/publish";
  };
  const renderMediaPanel = (category: MediaCategory) => {
    const isPenalty = category === "PENALTY";
    const rows = isPenalty
      ? media.filter((item) => item.category === "PENALTY" || item.purpose === "ACCOUNT_EVIDENCE")
      : media.filter((item) => item.category !== "PENALTY" && item.purpose === "ACCOUNT_DISPLAY");
    const canUpload = !isPenalty || hasBanRecord;
    const isPenaltyEmpty = isPenalty && hasBanRecord && rows.length === 0;
    const title = isPenalty ? (canUpload ? "封禁记录截图" : "已保留的封禁截图") : "账号展示图";
    const desc = isPenalty ? (canUpload ? "请上传该账号三角洲行动所有封禁记录截图" : "已有图片仍在本次资料中，可在这里查看或移除。") : "至少上传一张，第一张作为封面；可调整图片顺序。";
    return <div className="supply-media-panel" key={category} id={isPenalty ? "publish-media-penalty" : undefined}>
      <div className="supply-media-heading"><FileImage size={20} aria-hidden="true" /><div><h3>{title}{isPenalty && hasBanRecord ? <span className="publish-required-mark">必填</span> : null}</h3><p>{desc}</p></div>{rows.length ? <span className="publish-media-count">{rows.length} 张</span> : null}</div>
      {canUpload ? <label
        className="supply-upload-dropzone"
        data-disabled={formDisabled || !gameId ? "true" : "false"}
        data-drag-active={mediaDropActive === category ? "true" : "false"}
        onDragEnter={() => { if (!formDisabled && gameId) setMediaDropActive(category); }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!formDisabled && gameId && mediaDropActive !== category) setMediaDropActive(category);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setMediaDropActive((previous) => (previous === category ? null : previous));
          }
        }}
        onDrop={(event: DragEvent<HTMLLabelElement>) => {
          event.preventDefault();
          setMediaDropActive(null);
          acceptFiles(category, Array.from(event.dataTransfer.files));
        }}
      >
        <Upload size={22} aria-hidden="true" /><span className="publish-upload-copy"><strong>选择图片、拖入此处，或直接 Ctrl+V 粘贴截图</strong><span>PNG / JPEG / WebP · 单张 ≤ 10 MiB</span></span><span className="publish-upload-action" aria-hidden="true">选择图片</span>
        <input aria-label={isPenalty ? "上传封禁记录截图" : "上传账号展示图"} data-first-field={!isPenalty ? true : undefined} type="file" accept={MEDIA_ACCEPT_ATTRIBUTE} multiple disabled={formDisabled || !gameId} onChange={(event) => selectFiles(category, event)} />
      </label> : null}
      {!isPenalty && canUpload ? <p className="publish-media-guide">建议依次上传：① 仓库/哈夫币总览（首张作封面） ② 干员或枪械外观 ③ 特勤处与段位页，更易吸引租客下单。</p> : null}
      {isPenaltyEmpty ? <p className="supply-field-error" role="alert" style={{ margin: "8px 0 0" }}>请上传该账号三角洲行动所有封禁记录截图</p> : null}
      <div className="supply-media-list">{rows.map((item, index) => {
        const isCover = !isPenalty && index === 0;
        const previewLabel = item.file?.name ?? (isPenalty ? `处罚公示图 ${index + 1}` : `展示图 ${index + 1}`);
        const canDrag = !formDisabled && item.status !== "uploading" && rows.length > 1;
        return <div
          key={item.id}
          className={`supply-media-row supply-media-card${isCover ? " is-cover" : ""}${item.status === "failed" ? " is-failed" : ""}`}
          draggable={canDrag}
          data-dragging={dragMediaId === item.id ? "true" : undefined}
          data-drag-over={dragOverMediaId === item.id && dragMediaId !== item.id ? "true" : undefined}
          onDragStart={(event) => {
            if (!canDrag) return;
            setDragMediaId(item.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.id);
          }}
          onDragOver={(event) => {
            if (!canDrag || !dragMediaId || dragMediaId === item.id) return;
            event.preventDefault();
            if (dragOverMediaId !== item.id) setDragOverMediaId(item.id);
          }}
          onDrop={(event) => {
            if (!canDrag || !dragMediaId) return;
            event.preventDefault();
            reorderMediaCard(dragMediaId, item.id);
            setDragMediaId(null);
            setDragOverMediaId(null);
          }}
          onDragEnd={() => {
            setDragMediaId(null);
            setDragOverMediaId(null);
          }}
        >
          <div className="supply-media-preview">
            {isCover ? <span className="supply-media-badge-cover">封面</span> : null}
            {item.status === "uploading" || item.status === "failed" || !item.bindingSaved ? (
              <span className="supply-media-badge-state" data-saved={item.bindingSaved ? "true" : "false"} data-status={item.status}>
                {item.status === "uploading" ? "上传中" : item.status === "failed" ? "未完成" : "待保存草稿"}
              </span>
            ) : null}
            {item.previewUrl ? (
              <button
                type="button"
                className="supply-media-zoom-btn"
                aria-label={`预览 ${previewLabel}`}
                onClick={() => setPreviewMedia({ url: item.previewUrl!, title: previewLabel })}
              >
                <img src={item.previewUrl} alt="" />
              </button>
            ) : (
              <span className="supply-media-placeholder" aria-hidden="true"><FileImage size={20} /></span>
            )}
          </div>
          <div className="supply-media-copy">
            <span title={previewLabel}>{item.file?.name ?? (isPenalty ? "处罚公示图" : "展示图")}</span>
            <small>{mediaStatusText(item)}</small>
            {item.error && item.status === "failed" ? <small className="supply-field-error" role="alert">{item.error}</small> : null}
          </div>
          <div className="supply-media-actions">
            {item.status === "failed" && item.file && !mediaUploadFailureHint(item.file) ? <button type="button" className="button quiet" disabled={formDisabled} onClick={() => void upload(item)}>重试</button> : null}
            {!isPenalty && index > 0 && item.status === "bound" ? <button type="button" className="button quiet supply-media-set-cover" disabled={formDisabled} onClick={() => setCoverMedia(item.id)}>设为封面</button> : null}
            <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading" || index === 0} aria-label="上移" onClick={() => moveMedia(item.id, -1)}><ArrowUp size={14} /></button>
            <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading" || index === rows.length - 1} aria-label="下移" onClick={() => moveMedia(item.id, 1)}><ArrowDown size={14} /></button>
            <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} onClick={() => removeMedia(item.id)}><Trash2 size={14} />移除</button>
          </div>
        </div>;
      })}</div>
    </div>;
  };

  return <ServiceShell {...publishShell} title="上架出租">
    <BusinessUpdateNotices surface="publish" gameId={gameId || undefined} />
    <PublishingNotice open={readingNotice} onClose={handleNoticeClose} agreement={agreement} returnFocus={noticeReturnFocus} manual={noticeManualRef.current} />
    {intentStorageIssue ? <div className="supply-conflict" role="alert"><strong>暂不能提交新的操作</strong><p>{intentStorageIssue}</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => { restoredSubjectRef.current = null; setIntentRestoreVersion(value => value + 1); }}>重试恢复记录</button></div> : null}
    {authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>此操作需要登录并确认当前身份。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent(accountId ? `/publish?accountId=${accountId}` : "/publish")}`}>登录 / 注册</Link></div> : null}
    <Notice error={error} text={notice} onDismiss={() => { setNotice(""); setError(null); }} />
    {error?.status === 409 && serverSnapshot ? <div className="supply-conflict" role="alert"><strong>资料状态已变化</strong><p>已保留本页输入，没有自动覆盖。当前资料状态为 {serverSnapshot.version ? stateLabel(serverSnapshot.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" onClick={() => void refreshLatest(false)}>重新读取最新状态</button><button type="button" className="button secondary" onClick={() => void refreshLatest(true)}>采用最新资料</button></div></div> : null}
    {writePending ? <div className="supply-conflict" role="alert"><strong>结果未知</strong><p>上次写入已发出但没有收到确认。重新读取只更新服务器展示，不会解除锁定；请重试当前步骤，收到与原请求对应的确定结果后才可继续修改或发起新写入。</p><div className="supply-inline-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void retryWrite()}>重试当前步骤</button><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void refreshLatest(true)}>重新读取最新状态</button></div></div> : null}
    {!writePending && error?.status === 0 && lastRetry.current ? <div className="supply-conflict"><strong>读取未完成</strong><p>本页没有自动重复操作，请重试本次读取。</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void retryLast()}>重试读取</button></div> : null}
    {!writePending && optionsAvailability === "failed" ? <div className="supply-blockers" role="alert"><strong>出租规则读取失败</strong><p>暂不能核对报价；可先保存草稿。</p><button type="button" className="button secondary" disabled={Boolean(busy) || !gameId} onClick={() => void loadOptions(gameId)}>重试读取规则</button></div> : null}
    {readOnly && !published ? <div className="supply-readonly" role="status"><strong>当前资料不可直接编辑</strong><span>{mustCreateAccount ? "此账号仅保留记录；如需出租，请重新填写上架资料。" : reviewState === "SUBMITTED" ? "资料正在审核，可返回账号详情撤回审核。" : "可以在原账号继续完善未发布的草稿。"}</span>{mustCreateAccount ? <Link href="/publish" className="button secondary">重新填写上架资料</Link> : reviewState === "SUBMITTED" ? <Link href="/account?view=accounts" className="button secondary">返回账号管理</Link> : <button type="button" className="button secondary" disabled={identityState !== "confirmed" || !identityRef.current || Boolean(busy)} onClick={() => void beginEditing()}>{busy === "edit" ? "准备草稿中…" : "继续填写草稿"}</button>}</div> : null}
    {loadingAccount ? <p className="supply-muted" role="status">正在读取账号资料…</p> : null}
    <PublishVisualBanner />
    <div className="publish-header-bar">
      <p className="publish-form-guidance"><Info size={15} aria-hidden="true" />可先保存草稿；确认上架前系统会自动核验必填项与出租要求。</p>
      <button ref={noticeTriggerRef} type="button" className="button quiet publish-header-notice-btn" onClick={() => { noticeManualRef.current = true; setReadingNotice(true); }}><FileText size={16} aria-hidden="true" />上架须知</button>
    </div>

    <div className="publish-page-layout">
      <aside id="publish-outline" className="publish-outline publish-timeline-rail" aria-label="步骤导航">
        <nav className="publish-outline-groups publish-timeline-track">
          {(Object.keys(groupMeta) as PublishGroupId[]).map((id) => {
            const isActive = activeGroup === id;
            const isError = errorGroups.has(id);
            const isDone = !isError && groupDone[id];
            return (
              <a
                key={id}
                href={`#publish-group-${id}`}
                className={`publish-timeline-node${isActive ? " is-active" : ""}${isError ? " is-error" : ""}${isDone ? " is-done" : ""}`}
                aria-current={isActive ? "step" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  const target = document.getElementById(`publish-group-${id}`);
                  if (target) {
                    const headerOffset = 90;
                    const targetTop = target.getBoundingClientRect().top + window.scrollY - headerOffset;
                    window.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
                  }
                }}
              >
                <span className="publish-timeline-marker">
                  <span className="publish-timeline-dot">{isDone && !isActive ? <Check size={9} strokeWidth={3} aria-hidden="true" /> : null}</span>
                  <span className="publish-timeline-line" />
                </span>
                <span className="publish-timeline-copy">
                  <span className="publish-timeline-title">{groupMeta[id].title}</span>
                </span>
                {isError ? <span className="publish-timeline-badge-err" title="有待完善项" /> : null}
              </a>
            );
          })}
        </nav>
      </aside>

      <form
        ref={formRef}
        className="publish-column"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          primaryAction();
        }}
        onKeyDown={(event: React.KeyboardEvent<HTMLFormElement>) => {
          if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
            event.preventDefault();
          }
        }}
        noValidate
      >
        <div className="publish-groups">
          <SectionCard
            id="account"
            title={groupMeta.account.title}
            hasError={errorGroups.has("account")}
            headerMeta={
              <span className="publish-section-progress" data-complete={accountRequiredDone === accountRequiredTotal ? "true" : "false"}>
                {accountRequiredDone === accountRequiredTotal ? "必填已齐" : `必填 ${accountRequiredDone}/${accountRequiredTotal}`}
              </span>
            }
          >
            <div className="publish-account-flow">
              {!accountId && games.length > 1 ? (
                <label className="publish-game-field">游戏
                  <FormSelect label="游戏"
                    value={gameId}
                    disabled={Boolean(accountId) || formDisabled}
                    placeholder="选择游戏"
                    popupClassName="publish-select-popup"
                    options={games.map((option) => ({ value: option.id, label: option.name }))}
                    onChange={(val) => selectGame(val)}
                  />
                  <small>仅显示已开放出租的游戏。</small>
                </label>
              ) : null}
              <div className="publish-account-subhead supply-wide"><span>基础规格与赛季</span></div>
              <fieldset id="publish-attribute-safe-box" tabIndex={-1} className="supply-radio-field publish-choice-field publish-safe-box-field supply-wide"><legend><span className="publish-account-label">安全箱档位{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}<FieldHelp label="安全箱档位"><ManagedNoticeText contentKey="placement:PUBLISH_SAFE_BOX" fallback="根据账号当前赛季实际安全箱规格如实选择；顶级安全箱(3*3)仅限赛季3x3可选，与九格保险体验卡二选一。" /></FieldHelp></span></legend>
                {safeBoxChoiceOptions.length ? <FormRadioGroup variant="segmented" name="safe_box_code" label="安全箱档位" required={requireNewAccountFacts} error={fieldError("attributes.safe_box_code")} value={currentSafeBox} options={safeBoxChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("safe_box_code", value)} /> : <small className="publish-choice-empty">{options ? "当前规则未配置安全箱档位。" : "正在读取安全箱档位…"}</small>}
                <small className="publish-choice-hint">顶级安全箱(3*3)仅限赛季3x3可选，与九格保险体验卡互斥</small>
              </fieldset>
              {(["next_season_pass", "demulan_unlocked"] as const).some(key => declarationOptions?.[key]?.enabled || typeof draft.attributes[key] === "boolean") ? <div className="publish-safety-row supply-wide">
                {(["next_season_pass", "demulan_unlocked"] as const).map(key => {
                  const field = declarationOptions?.[key];
                  if (!field?.enabled && typeof draft.attributes[key] !== "boolean") return null;
                  const label = key === "next_season_pass" ? "下赛季通行证" : "解锁德穆兰";
                  const selected = typeof draft.attributes[key] === "boolean" ? draft.attributes[key] as boolean : null;
                  return <fieldset key={key} id={`publish-declaration-${key}`} tabIndex={-1} aria-required={field?.required || undefined} className="supply-radio-field publish-choice-field">
                    <legend><span className="publish-account-label">{label}</span></legend>
                    <FormRadioGroup variant="segmented" name={key} label={label} value={selected} options={[{ value: true, label: "是" }, { value: false, label: "否" }]} disabled={formDisabled || !field?.enabled} onChange={value => changeAttribute(key, value)} error={fieldError(`attributes.${key}`)} />
                    <small>{key === "next_season_pass" ? "下赛季是否计划购买通行证、续费六格保险箱。" : "当前账号是否已经解锁德穆兰。"}</small>
                  </fieldset>;
                })}
              </div> : null}
              <div className="publish-performance-row supply-wide">
                <div id="publish-character-level" tabIndex={-1} className="publish-account-integer-field"><span className="publish-account-label">账号等级{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}</span><IntegerStepper label="账号等级" required={requireNewAccountFacts} value={String(draft.attributes.character_level??"")} max="60" disabled={formDisabled} onChange={raw=>changeAttribute("character_level",raw===""?null:Number(raw))} /><div className="publish-quick-chips" role="group" aria-label="常用账号等级">{([{ value: 30, label: "30级" }, { value: 50, label: "50级" }, { value: 60, label: "60级满级" }] as const).map((preset) => <button key={preset.value} type="button" className="publish-quick-chip" data-active={draft.attributes.character_level === preset.value ? "true" : "false"} disabled={formDisabled} onClick={() => changeAttribute("character_level", preset.value)}>{preset.label}</button>)}</div>{typeof draft.attributes.character_level==="number"&&draft.attributes.character_level>60?<small className="publish-legacy-choice-note">已保留历史{draft.attributes.character_level}级原值；请核对后填写0–60级。</small>:null}</div>
                <label id="publish-attribute-grading" tabIndex={-1} className="publish-grading-field"><span className="publish-account-label">段位<span className="publish-required-mark">必填</span></span>
                  <div className="publish-grading-group">
                    <FormSelect label="账号段位" required
                      value={currentGrading}
                      disabled={formDisabled || !options}
                      placeholder="请选择段位"
                      popupClassName="publish-select-popup"
                      options={[
                        { value: "", label: "未申报" },
                        ...(currentGrading && !gradingOptions.some((option) => option.code === currentGrading) ? [{ value: currentGrading, label: "未确认" }] : []),
                        ...(gradingOptions.map((option) => ({ value: option.code, label: option.displayName ?? "未确认" }))),
                      ]}
                      onChange={(val) => {
                        changeAttribute("grading_code", val || null);
                        const nextOpt = gradingOptions.find((opt) => opt.code === val) as { divisions?: number[] } | undefined;
                        const nextDivs = nextOpt?.divisions?.length
                          ? nextOpt.divisions
                          : ["2", "3", "4", "5", "6", "7"].includes(val)
                            ? [3, 2, 1]
                            : [];
                        if (!nextDivs.length || (currentGradingDivision !== null && !nextDivs.includes(currentGradingDivision))) {
                          changeAttribute("grading_division", null);
                        }
                      }}
                    />
                    {currentDivisions.length > 0 ? (
                      <FormSelect label="小段位"
                        value={currentGradingDivision !== null ? String(currentGradingDivision) : ""}
                        disabled={formDisabled || !options}
                        placeholder="小段位（选填）"
                        popupClassName="publish-select-popup"
                        options={[
                          { value: "", label: "未选小段位" },
                          ...currentDivisions.map((div: number) => ({ value: String(div), label: `${div} 级` })),
                        ]}
                        onChange={(val) => changeAttribute("grading_division", val ? Number(val) : null)}
                      />
                    ) : null}
                  </div>
                </label>
                <label className="publish-kd-field" htmlFor="publish-secret-kd"><span className="publish-account-label">绝密KD{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}<FieldHelp label="绝密KD">填写当前赛季绝密模式显示的KD，可填写小数，例如1.85。</FieldHelp></span><Input id="publish-secret-kd" data-publish-entry aria-label="绝密KD" aria-required={requireNewAccountFacts || undefined} type="text" inputMode="decimal" maxLength={32} autoComplete="off" value={String(draft.attributes.secret_kd ?? "")} disabled={formDisabled} aria-invalid={Boolean(kdProblem())} aria-describedby={kdProblem() ? "publish-secret-kd-error" : undefined} onChange={(event) => changeAttribute("secret_kd", event.target.value === "" ? null : event.target.value)} placeholder="例如 1.85" /><FieldError id="publish-secret-kd-error" text={kdProblem()?.message} /></label>
              </div>
              <div className="publish-account-subhead supply-wide"><span>角色身体素质</span></div>
              <div className="publish-vitality-matrix supply-wide">
                <fieldset id="publish-attribute-vit" tabIndex={-1} className="supply-radio-field publish-choice-field publish-compact-level-field publish-vitality-field"><legend>体力等级<span className="publish-required-mark">必填</span></legend><FormRadioGroup variant="segmented" name="vit_level" label="体力等级" required error={fieldError("attributes.vit_level")} value={currentVitality} options={vitalityChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("vit_level", Number(value))} />{vitalityChoiceNote ? <small className="publish-legacy-choice-note">{vitalityChoiceNote}</small> : null}</fieldset>
                <fieldset id="publish-attribute-bear" tabIndex={-1} className="supply-radio-field publish-choice-field publish-compact-level-field publish-bear-field"><legend>负重等级<span className="publish-required-mark">必填</span></legend><FormRadioGroup variant="segmented" name="bear_level" label="负重等级" required error={fieldError("attributes.bear_level")} value={currentBear} options={bearChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("bear_level", Number(value))} />{bearChoiceNote ? <small className="publish-legacy-choice-note">{bearChoiceNote}</small> : null}</fieldset>
                <fieldset id="publish-attribute-dive" tabIndex={-1} className="supply-radio-field publish-choice-field publish-compact-level-field publish-dive-field"><legend>潜水等级<span className="publish-required-mark">必填</span></legend><FormRadioGroup variant="segmented" name="dive_level" label="潜水等级" required error={fieldError("attributes.dive_level")} value={currentDive} options={diveChoiceOptions} disabled={formDisabled} onChange={(value) => changeAttribute("dive_level", Number(value))} />{diveChoiceNote ? <small className="publish-legacy-choice-note">{diveChoiceNote}</small> : null}</fieldset>
              </div>
              <div className="publish-account-subhead supply-wide"><span>上号配合与合规声明</span></div>
              <fieldset id="publish-attribute-login" tabIndex={-1} className="supply-radio-field publish-choice-field publish-login-field supply-wide"><legend><span className="publish-account-label">上号方式<span className="publish-required-mark">必填</span><FieldHelp label="上号方式">选择租客上号时，你可以配合的登录方式。</FieldHelp></span></legend>
                {loginChoiceOptions.length ? <FormRadioGroup variant="segmented" className="publish-login-segmented" name="login_method_code" label="上号方式" required error={fieldError("attributes.login_method_code")} value={currentLoginMethod} options={loginChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("login_method_code", value)} /> : <small className="publish-choice-empty">{options ? "当前规则未配置上号方式。" : "正在读取上号方式…"}</small>}
              </fieldset>
              <div className="publish-service-row supply-wide">
                <RegionPicker province={String(draft.attributes.region_province ?? "")} city={String(draft.attributes.region_city ?? "")} options={DELTA_REGION_OPTIONS} disabled={formDisabled} required={requireNewAccountFacts} error={fieldError("attributes.region_province") || fieldError("attributes.region_city")} onChange={(province, city) => setDraft((previous) => ({ ...previous, attributes: { ...previous.attributes, region_province: province, region_city: city } }))} />
                <div id="publish-service-window" tabIndex={-1} className="publish-service-window">
                  <span className="publish-account-label"><Clock3 size={16} aria-hidden="true" />可配合上号时间{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}<span className="publish-timezone">北京时间</span><FieldHelp label="可配合上号时间">填写你能协助上号的时间。支持跨日时段，例如22:00至次日02:00。</FieldHelp></span>
                  <FormRadioGroup variant="segmented" className="publish-window-mode" name="service_window_mode" label="可配合上号时间" required={requireNewAccountFacts} value={serviceWindowMode} options={[{value:"allDay",label:"全天可配合"},{value:"window",label:"按时段配合"}]} disabled={formDisabled} onChange={value => changeAllDay(value === "allDay")} />
                  {serviceWindowMode === "window" ? <>
                    <div className="publish-quick-chips publish-window-presets" role="group" aria-label="常用配合时段">
                      {([{ start: 480, end: 1440, label: "白天 08:00–24:00" }, { start: 1080, end: 120, label: "晚间 18:00–02:00" }, { start: 1320, end: 480, label: "通宵 22:00–08:00" }] as const).map((preset) => (
                        <button key={preset.label} type="button" className="publish-quick-chip" data-active={serviceWindowStart === preset.start && serviceWindowEnd === preset.end ? "true" : "false"} disabled={formDisabled} onClick={() => applyServiceWindowPreset(preset.start, preset.end)}>{preset.label}</button>
                      ))}
                    </div>
                    <span className="supply-time-range">
                      <FormSelect label="开始时间" value={serviceWindowStart === null ? "" : String(serviceWindowStart)} disabled={formDisabled} placeholder="开始时间" popupClassName="publish-select-popup" options={serviceTimeOptions(SERVICE_WINDOW_START_OPTIONS, serviceWindowStart)} onChange={(value) => changeServiceWindow("service_window_start_minute", value === "" ? "" : minutesToTimeValue(Number(value)))} />
                      <span aria-hidden="true" className="supply-time-separator">至</span>
                      <FormSelect label="结束时间" value={serviceWindowEnd === null ? "" : String(serviceWindowEnd)} disabled={formDisabled} placeholder="结束时间" popupClassName="publish-select-popup" options={serviceTimeOptions(SERVICE_WINDOW_END_OPTIONS, serviceWindowEnd)} onChange={(value) => changeServiceWindow("service_window_end_minute", value === "" ? "" : minutesToTimeValue(Number(value)))} />
                    </span>
                  </> : serviceWindowAllDay ? <output className="publish-window-summary sr-only">全天可配合 · 00:00 至 24:00</output> : null}
                  {serviceWindowEqual ? <small className="supply-field-error" role="alert">开始和结束时间不能相同。</small> : null}
                  {serviceWindowMode === "window" && serviceWindowStart !== null && serviceWindowEnd !== null && !serviceWindowEqual ? <output className="publish-window-summary">可配合时间：{minutesToTimeValue(serviceWindowStart)} 至 {serviceWindowEnd < serviceWindowStart ? "次日 " : ""}{minutesToTimeValue(serviceWindowEnd)}</output> : null}
                  {serviceWindowHasLegacyValue ? <small className="publish-legacy-choice-note">已保留历史非 30 分钟原值；新选择仅支持每 30 分钟一个时间点。</small> : null}
                </div>
              </div>
              <div className="publish-safety-row supply-wide">
                <fieldset id="publish-attribute-ban" tabIndex={-1} className="supply-radio-field"><legend>封禁记录{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}</legend>
                  <div className="supply-radio-group">
                    <FormRadioGroup variant="segmented" name="ban_record" label="封禁记录" required={requireNewAccountFacts} value={draft.attributes.ban_record as boolean | null} options={[{value:false,label:"无封禁记录"},{value:true,label:"有封禁记录"}]} disabled={formDisabled} onChange={value => changeAttribute("ban_record",value)} />
                  </div>
                  {draft.attributes.ban_record === true ? <small className="publish-choice-hint publish-choice-hint--alert">注意：已声明有封禁记录，必须在下方“展示图片”区域上传该账号三角洲行动所有封禁记录截图。</small> : null}
                </fieldset>
                <fieldset id="publish-attribute-face" tabIndex={-1} className="supply-radio-field"><legend><span className="publish-account-label">人脸归属{requireNewAccountFacts ? <span className="publish-required-mark">必填</span> : null}<FieldHelp label="人脸归属">请选择账号人脸认证是否属于号主本人；该信息由号主申报。</FieldHelp></span></legend>
                  <div className="supply-radio-group">
                    <FormRadioGroup variant="segmented" name="face_is_self" label="人脸归属" required={requireNewAccountFacts} value={draft.attributes.face_is_self as boolean | null} options={[{value:true,label:"号主本人"},{value:false,label:"非号主本人"}]} disabled={formDisabled} onChange={value => changeAttribute("face_is_self",value)} />
                  </div>
                </fieldset>
              </div>
            </div>
          </SectionCard>

          <SectionCard id="assets" title={groupMeta.assets.title} hasError={errorGroups.has("assets")}>
            <div className="supply-subsection">
              <div className="publish-assets-heading">
                <h3><Box size={20} aria-hidden="true" />物品资源</h3>
                <FieldHelp label="物品资源"><ManagedNoticeText contentKey="placement:PUBLISH_RESOURCES" fallback="物资默认按 0 申报，请将实际拥有的可消耗物资改为真实整数数量；单价按平台当前规则展示。" /></FieldHelp>
                <span className="publish-preview-updating" data-updating={ownerIncomePreviewPending} aria-hidden="true">更新中</span>
              </div>
              {resourcePreviewState ? <p className="publish-resource-read-state publish-resource-preview-status" role="status" aria-live="polite" aria-busy={ownerIncomePreviewPending}><Info size={16} aria-hidden="true" />{resourcePreviewState}</p> : null}
              {resourceRows.length ? <div className="supply-resource-grid" role="list" aria-label="资源库存" aria-busy={ownerIncomePreviewPending}>{resourceRows.map((item) => {
                const itemCode=item.code, key=item.itemId??itemCode!;
                const insuranceExperience=canonicalResourceCode(itemCode)==="df_billable_top_insure_card"||itemCode==="legacy_insurance_day";
                const itemName=canonicalResourceCode(itemCode)==="df_billable_coffee"?"咖啡豆":insuranceExperience?INSURANCE_EXPERIENCE_CARD:item.name;
                const retiredInsurance=retiredInsuranceCode(itemCode);
                const quantity=draft.inventory.find(row=>row.itemId===item.itemId)?.quantity??item.quantity??"";
                const grouped=canonicalResourceCode(itemCode)==="df_billable_level6_bullet";
                const valid=/^(0|[1-9]\d{0,23})$/.test(quantity), remainder=grouped&&valid?BigInt(quantity)%60n:0n;
                const inputValue=grouped&&valid?(BigInt(quantity)/60n).toString():quantity;
                const inputUnit=grouped?"组":resourceUnitLabel(item.unit??"",itemCode);
                const line=item.itemId&&ownerPreview?.lines?ownerPreview.lines.find(row=>row.itemId===item.itemId):null;
                const unpriced = item.priced === false || (retiredInsurance && item.priced !== null);
                const unknownPrice = item.priced === null;
                const priceHint = item.itemId ? inventoryPriceHint(unpriced ? { ...item, priced: false } : item) : null;
                const help=grouped?"六级子弹按组填写，每组60发；保存时只换算一次。":insuranceExperience?`按天填写${INSURANCE_EXPERIENCE_CARD}的可用天数。`:null;
                const durabilityRequired = ["df_billable_level6_armor", "df_billable_level6_helmet"].includes(canonicalResourceCode(itemCode) ?? "");
                const fillState = quantity === "" ? "empty" : valid && BigInt(quantity) > 0n ? "filled" : quantity === "0" ? "zero" : "empty";
                return <article className="supply-resource-card" key={key} role="listitem" data-resource-code={itemCode??undefined} data-fill-state={fillState}>
                  <div className="supply-resource-card-head">
                    <span className="supply-resource-art"><CatalogItemArt mediaId={"mediaId" in item ? item.mediaId : null}><InventoryIcon code={itemCode} /></CatalogItemArt></span>
                    <div className="supply-resource-info">
                      <div className="supply-resource-name"><label htmlFor={`quantity-${key}`}>{itemName}</label>{help?<FieldHelp label={itemName}>{help}</FieldHelp>:null}</div>
                      <div className="publish-owner-rate"><span>单价</span><strong>{unknownPrice && item.itemId ? "待核实" : line?.ownerUnitAmount ? `${formatUnitPrice(line.ownerUnitAmount.amount)} / ${inputUnit}` : !item.itemId || unpriced ? "待配置" : ownerIncomePreviewPending ? "读取中…" : "暂未取得"}</strong>{line ? <FieldHelp label={`${itemName}单价`}>单价按分显示，实际收入以核价和结算为准。</FieldHelp> : null}</div>
                    </div>
                    {item.required?<span className="supply-resource-required">必填</span>:null}
                  </div>
                  {!item.itemId ? <small className="publish-resource-state">此项暂存本页。填写后需等待目录配置，整份资料才能保存或核价。</small> : null}
                  <div className="publish-resource-input" role={grouped ? "group" : undefined} aria-label={grouped ? `${itemName}数量，单位为组` : undefined} aria-describedby={grouped ? `measure-${key}` : undefined} onBlur={grouped ? event => {
                    if (formDisabled || event.currentTarget.contains(event.relatedTarget)) return;
                    const editor = event.currentTarget, context = captureContext();
                    requestAnimationFrame(() => {
                      if (currentContext(context) && identityStatusRef.current === "confirmed" && !editor.contains(document.activeElement)
                        && !document.querySelector(':is([role="dialog"], [role="alertdialog"]):is([data-open], [data-state="open"])')) requireAmmoReview();
                    });
                  } : undefined}>
                    <div className="publish-resource-spec-bar">
                      {grouped ? <p id={`measure-${key}`} className="publish-ammo-unit">按组填写 · 1组 = 60发</p> : null}
                      {durabilityRequired ? <p className="publish-resource-durability"><Info size={14} aria-hidden="true" />磨损不超过5耐久</p> : null}
                    </div>
                    {insuranceExperience && is3x3SafeBoxSelected ? (
                      <TooltipPrimitive.Provider delayDuration={180}>
                        <TooltipPrimitive.Root>
                          <TooltipPrimitive.Trigger asChild>
                            <span className="publish-resource-disabled-wrapper" tabIndex={0}>
                              <IntegerStepper id={`quantity-${key}`} label={`${itemName}数量`} value={inputValue} unit={inputUnit} max="999999999999999999999999" disabled={true} invalid={quantity!==""&&!valid} onChange={()=>{}} />
                            </span>
                          </TooltipPrimitive.Trigger>
                          <TooltipPrimitive.Portal>
                            <TooltipPrimitive.Content sideOffset={6} className="app-tooltip-content" side="top">
                              已选择顶级安全箱(3*3)，不可与九格保险体验卡同时填写（只能二选一）
                            </TooltipPrimitive.Content>
                          </TooltipPrimitive.Portal>
                        </TooltipPrimitive.Root>
                      </TooltipPrimitive.Provider>
                    ) : (
                      <IntegerStepper id={`quantity-${key}`} label={`${itemName}数量`} value={inputValue} unit={inputUnit} max={grouped?((999999999999999999999999n-remainder)/60n).toString():"999999999999999999999999"} disabled={formDisabled||retiredInsurance} invalid={quantity!==""&&!valid} describedBy={grouped ? `measure-${key}` : undefined} onChange={raw=>{
                        const base=raw===""?"":grouped?(BigInt(raw)*60n+remainder).toString():raw;
                        if(item.itemId)changeInventory(item.itemId,base);else setPendingResourceInputs(previous=>({...previous,[itemCode!]:base}));
                      }} />
                    )}
                    {!(insuranceExperience && is3x3SafeBoxSelected) && !retiredInsurance ? (
                      <div className="publish-quick-chips publish-resource-quick-chips">
                        <button type="button" className="publish-quick-chip" data-active={quantity === "0" ? "true" : "false"} disabled={formDisabled} onClick={() => {
                          if (item.itemId) changeInventory(item.itemId, "0");
                          else setPendingResourceInputs((previous) => ({ ...previous, [itemCode!]: "0" }));
                        }}>置0</button>
                        {([1n, 5n] as const).map((delta) => (
                          <button key={delta.toString()} type="button" className="publish-quick-chip" disabled={formDisabled} onClick={() => {
                            const currentGroups = valid && quantity !== "" ? (grouped ? BigInt(quantity) / 60n : BigInt(quantity)) : 0n;
                            const maxGroups = grouped ? (999999999999999999999999n - remainder) / 60n : 999999999999999999999999n;
                            const nextGroups = currentGroups + delta > maxGroups ? maxGroups : currentGroups + delta;
                            const base = grouped ? (nextGroups * 60n + remainder).toString() : nextGroups.toString();
                            if (item.itemId) changeInventory(item.itemId, base);
                            else setPendingResourceInputs((previous) => ({ ...previous, [itemCode!]: base }));
                          }}>{`+${delta.toString()}`}</button>
                        ))}
                      </div>
                    ) : null}
                    {grouped && valid ? <p className="publish-ammo-conversion" aria-live="polite">{ammoQuantityText(quantity)}</p> : null}
                  </div>
                  {insuranceExperience && is3x3SafeBoxSelected ? <small className="publish-resource-conflict-hint">已选择顶级安全箱(3*3)，不可与九格保险体验卡同时填写</small> : null}
                  {retiredInsurance?<small className="publish-resource-state">单位需核对：历史按张申报保留原数量和停用状态，新申报请在上方按天项目填写。</small>:null}
                  <div className="publish-resource-subtotal"><span>{ownerPreviewStale&&line?.ownerAmount?"上次预估":"本项预估"}</span><output aria-live="off">{insuranceExperience&&is3x3SafeBoxSelected?"互斥停用":quantity===""?"未填写":!item.itemId?"待资源配置":unknownPrice?"价目待核实":line?.ownerAmount?`¥ ${line.ownerAmount.amount}`:unpriced?"价目待配置":ownerIncomePreviewPending?"计算中…":"预估暂不可用"}</output></div>
                  {!item.itemId ? <small className="publish-resource-state">目录待配置 · 数量暂存本页</small> : null}
                  {quantity!==""&&!valid?<FieldError text="请填写非负整数，或留空。"/>:null}
                  {priceHint ? <small className="publish-resource-state">{priceHint}</small> : null}
                  {unpriced ? <button type="button" className="button quiet" disabled={formDisabled} onClick={()=>setDraft(previous=>({...previous,inventory:previous.inventory.filter(row=>row.itemId!==item.itemId)}))}>不纳入本次申报</button> : null}
                </article>;
              })}</div>:null}
              {missingResourceRows.length?<p className="publish-resource-state">{missingResourceRows.map(item=>item.name).join("、")}的数量暂存本页，配置完成后可保存。</p>:null}
              <FieldError text={inventoryFieldError ? fieldErrorText("inventory", inventoryFieldError.code) : undefined} />
            </div>
            <div className="supply-subsection">
              <div className="publish-assets-heading"><h3><UserRound size={20} aria-hidden="true" />皮肤</h3><FieldHelp label="皮肤">按名称或分类查找，并勾选账号拥有的皮肤。</FieldHelp></div>
              <div className="skin-picker">
                <div className="skin-category-nav" role="group" aria-label="皮肤分类">
                  {skinTypes.map((category) => {
                    const selectedInCat = selectedSkinCountForCategory(category.id);
                    return (
                      <button key={category.id} type="button" className={`skin-category-btn${activeSkinCategory === category.id ? " is-active" : ""}`} aria-pressed={activeSkinCategory === category.id} disabled={formDisabled} onClick={() => { clearSkinSearchTimer(); setSkinCategory(category.id); setSkinOwner(""); void loadSkinPage({ ...skinFilters, categoryId: catalog?.skinFilters ? undefined : category.id, ownerKind: catalog?.skinFilters && isSkinOwnerKind(category.id) ? category.id : undefined, ownerId: "" }, false); }}>
                        {category.name}
                        {selectedInCat > 0 ? <span className="skin-category-badge">{selectedInCat}</span> : null}
                      </button>
                    );
                  })}
                </div>
                <div className="skin-search-row">
                  <div className="skin-search-control">
                    <div className="skin-search-input-wrap">
                      <Input
                        className="skin-search-input"
                        type="search"
                        maxLength={80}
                        aria-label="搜索皮肤或所属名称"
                        enterKeyHint="search"
                        value={skinQuery}
                        disabled={formDisabled}
                        onChange={(event) => {
                          const nextQuery = event.target.value;
                          setSkinQuery(nextQuery);
                          clearSkinSearchTimer();
                          if (!formDisabled && !loadingCatalog && gameId) {
                            skinSearchTimerRef.current = window.setTimeout(() => {
                              skinSearchTimerRef.current = null;
                              void loadSkinPage({ ...skinFiltersRef.current, q: nextQuery.trim() }, false);
                            }, 300);
                          }
                        }}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadSkinPage(skinFilters, false); } }}
                        placeholder="搜索皮肤或所属名称"
                      />
                      {skinQuery ? (
                        <button
                          type="button"
                          className="skin-search-clear"
                          aria-label="清空搜索关键词"
                          disabled={formDisabled}
                          onClick={() => {
                            clearSkinSearchTimer();
                            setSkinQuery("");
                            void loadSkinPage({ ...skinFilters, q: "" }, false);
                          }}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                    <button type="button" className="button secondary" disabled={formDisabled || loadingCatalog} onClick={() => void loadSkinPage(skinFilters, false)}>查找</button>
                  </div>
                  {skinOwners.length ? <FormSelect label="皮肤所属" value={skinOwner || "__all__"} disabled={formDisabled} placeholder="全部所属" popupClassName="publish-select-popup" options={[{ value: "__all__", label: "全部所属" }, ...skinOwners.map((owner) => ({ value: owner.id, label: owner.name }))]} onChange={(value) => { const ownerId = value === "__all__" ? "" : value; setSkinOwner(ownerId); void loadSkinPage({ ...skinFilters, ownerId }, false); }} /> : null}
                  {catalog?.rarities.length ? <FormSelect label="皮肤品质"
                    value={skinRarity || "__all__"}
                    disabled={formDisabled}
                    placeholder="全部品质"
                    popupClassName="publish-select-popup"
                    options={[{ value: "__all__", label: "全部品质" }, ...catalog.rarities.map((rarity) => ({ value: rarity.code, label: rarity.name }))]}
                    onChange={(value) => { const rarityCode = value === "__all__" ? "" : value; setSkinRarity(rarityCode); void loadSkinPage({ ...skinFilters, rarityCode }, false); }}
                    className="skin-rarity-select"
                  /> : null}
                </div>
                {draft.skins.length > 0 ? (
                  <div className="skin-selected-box">
                    <div className="skin-selected-header">
                      <span>已选皮肤（{draft.skins.length}）</span>
                      <button type="button" className="button quiet" disabled={formDisabled} onClick={() => setDraft((previous) => ({ ...previous, skins: [] }))}>清空已选</button>
                    </div>
                    <div className="supply-selected-chips" aria-label="已选皮肤">
                      {draft.skins.map((id) => (
                        <span key={id} className="supply-chip" data-skin-id={id}>
                          {skinName(id)}
                          <button type="button" className="supply-chip-remove" aria-label={`移除 ${skinName(id)}`} disabled={formDisabled} onClick={() => setDraft((previous) => ({ ...previous, skins: previous.skins.filter((skinId) => skinId !== id) }))}>
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {skinPagePending || (!catalog && loadingCatalog) ? <p className="supply-muted" role="status">正在读取皮肤目录，已选皮肤会保留…</p> : null}
                {skinPageFailed ? <div className="skin-picker-error" role="alert"><p>{skinPageFailed === "append" ? "更多皮肤加载失败，已加载内容与已选皮肤会保留。" : "皮肤目录加载失败，已选皮肤会保留。"}</p><button type="button" className="button secondary" disabled={formDisabled || loadingCatalog} onClick={() => void loadSkinPage({ ...skinQueryRef.current.query, ...(skinPageFailed === "append" ? { cursor: catalog?.nextCursor ?? undefined } : {}) }, skinPageFailed === "append")}>重试皮肤目录</button></div> : null}
                {!skinPagePending && skinPageFailed !== "replace" ? (() => {
                  const isAgentCategory = activeSkinKind === "AGENT" || skinTypes.find((c) => c.id === activeSkinCategory)?.name?.includes("干员");
                  return (
                    <div className="skin-choices-grid" aria-label="可选皮肤" data-orientation={isAgentCategory ? "vertical" : "horizontal"}>
                      {visibleSkinRows.map((skin) => {
                        const isSelected = draft.skins.includes(skin.id);
                        const isAgentSkin = skin.ownerKind === "AGENT" || (!skin.ownerKind && isAgentCategory);
                        const orientation = isAgentSkin ? "vertical" : "horizontal";
                        return (
                          <article key={skin.id} className={`skin-card${isSelected ? " is-selected" : ""}`} data-skin-id={skin.id} data-owner-kind={skin.ownerKind ?? "UNKNOWN"} data-orientation={orientation}>
                            <label className="skin-card-choice">
                              <div className={`skin-card-thumb-wrap skin-card-thumb-wrap--${orientation}`}>
                                <SkinMediaThumb mediaId={skin.mediaId} ownerKind={skin.ownerKind} />
                                {skin.rarityName?.trim() ? (
                                  <span className="skin-card-tag">{skin.rarityName.trim()}</span>
                                ) : null}
                                <span className="skin-card-check" aria-hidden="true"><Check size={12} /></span>
                              </div>
                              <span className="skin-card-copy">
                                <span className="skin-card-name" title={skin.name}>{skin.name}</span>
                                <span className="sr-only"><SkinMetadata skin={skin} className="skin-card-rarity" /></span>
                              </span>
                              <input type="checkbox" checked={isSelected} aria-label={`选择 ${skin.name}`} disabled={formDisabled} onChange={(event) => setDraft((previous) => ({
                                ...previous,
                                skins: event.target.checked ? [...new Set([...previous.skins, skin.id])] : previous.skins.filter((id) => id !== skin.id),
                              }))} />
                            </label>
                            <span className="sr-only" aria-hidden="true">
                              <SkinMediaPreview skin={skin} triggerClassName="skin-card-preview"><span>放大</span></SkinMediaPreview>
                            </span>
                          </article>
                        );
                      })}
                      {catalog && visibleSkinRows.length === 0 ? <p className="skin-picker-empty">没有匹配的皮肤，可更换分类或减少查找条件；已选皮肤会保留。</p> : null}
                      {catalog?.nextCursor && !skinPagePending && !skinPageFailed ? (
                        <div className="skin-load-more-wrap">
                          <button
                            type="button"
                            className="button secondary skin-load-more"
                            disabled={formDisabled || loadingCatalog}
                            onClick={() => void loadSkinPage({ ...skinQueryRef.current.query, cursor: catalog.nextCursor ?? undefined }, true)}
                          >
                            {loadingCatalog ? "正在读取…" : "加载更多皮肤"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })() : null}
              </div>
            </div>
            {catalog?.entitlements.length ? <div className="supply-subsection">
              <h3>权益及有效期</h3>
              <p className="supply-muted">定时权益必须填写到期时间；未知时保持“未知”，不默认永久有效。</p>
              <div className="supply-entitlement-list">{catalog.entitlements.map((item) => { const selected = selectedEntitlement(item.id); const numeric = item.valueKind !== "FLAG"; const valueLabel = item.valueKind === "LEVEL" ? "等级" : item.valueKind === "CAPACITY" ? "容量" : "是否拥有"; return <div key={item.id} className="supply-entitlement"><label className="supply-choice"><input type="checkbox" checked={Boolean(selected)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, event.target.checked, numeric ? "" : undefined, undefined, item.expiryKind)} /><span>{item.name}</span><small>{valueLabel}{item.expiryKind === "TIMED" ? " · 定时权益" : " · 长期权益"}</small></label>{selected && numeric ? <label>{valueLabel}<Input inputMode="numeric" value={selected.value === null ? "" : String(selected.value)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, true, event.target.value, selected.expiresAt ?? undefined, item.expiryKind)} placeholder="填写数值" /></label> : null}{selected && item.expiryKind === "TIMED" ? <label>有效期至<DateTimePicker label={`${item.name}有效期至`} value={beijingInputFromIso(selected.expiresAt)} disabled={formDisabled} onChange={(value) => changeEntitlement(item.id, true, numeric ? String(selected.value ?? "") : undefined, value, item.expiryKind)} /> <small>{selected.expiryKnowledge === "UNKNOWN" ? "未知到期时间不能核价。" : "按北京时间填写。"}</small></label> : null}</div>; })}</div>
              <FieldError text={fieldError("entitlements")} />
            </div> : null}
          </SectionCard>

          <SectionCard id="media" title={groupMeta.media.title} hasError={errorGroups.has("media")}>
            <div className="supply-media-columns">{renderMediaPanel("SHOWCASE")}{hasBanRecord ? renderMediaPanel("PENALTY") : retainedPenaltyCount > 0 ? <details className="publish-retained-media"><summary>已保留 {retainedPenaltyCount} 张封禁截图 · 查看与管理</summary>{renderMediaPanel("PENALTY")}</details> : null}</div>
            <FieldError text={fieldError("mediaBindings")} />
          </SectionCard>

          <SectionCard id="terms" title={groupMeta.terms.title} hasError={errorGroups.has("terms")}>
            <div className="publish-terms-flow">
              <section className={`publish-term-section publish-term-haff-section${haffBaseIncomplete && !readOnly ? " is-prereq-locked" : ""}`}>
                <div className="publish-term-section-heading"><Coins size={20} aria-hidden="true" /><h3>出租设置</h3></div>
                {haffBaseIncomplete && !readOnly ? (
                  <div className="publish-haff-prereq-banner" role="status">
                    <div className="publish-haff-prereq-copy">
                      <strong>请先填写账号属性，再设置哈夫币与出租条件</strong>
                      <p>哈夫币基准比例与允许范围依赖安全箱、体力与负重等级，待补全：{haffBaseMissing.map((item) => item.label).join("、")}。</p>
                    </div>
                    <button
                      type="button"
                      className="button secondary publish-haff-prereq-jump"
                      onClick={() => scrollToTarget("account", haffBaseMissing[0]?.target)}
                    >
                      去补全
                    </button>
                  </div>
                ) : null}
                <div className="publish-term-row publish-term-haff-row">
                  <div className="publish-term-label"><label htmlFor="publish-haff-balance">哈夫币余额</label><span className="publish-required-mark">必填</span><FieldHelp label="哈夫币余额">填写仓库右上角的现金余额；1 M = 100万哈夫币，仅支持整数。</FieldHelp></div>
                  <div className="publish-term-control">
                    {haffInventoryRow ? (
                      <div className="publish-haff-balance-control">
                        <div className="publish-haff-input-wrap">
                          <Input
                            id="publish-haff-balance"
                            aria-label="哈夫币数量（M）"
                            aria-required="true"
                            data-first-field
                            inputMode="numeric"
                            autoComplete="off"
                            value={haffInput}
                            disabled={haffControlsDisabled}
                            onChange={(event) => changeHaffM(haffInventoryRow.itemId, event.target.value)}
                            placeholder="0"
                            aria-invalid={Boolean(haffErrorMessage)}
                            aria-describedby={haffErrorMessage ? "publish-haff-balance-hint publish-haff-balance-error" : "publish-haff-balance-hint"}
                          />
                          <span className="publish-haff-unit">M</span>
                        </div>
                        <div id="publish-haff-balance-hint" className="publish-haff-hint-row">
                          <span className="publish-haff-hint-base">1 M = 100万哈夫币 · 仅支持整数</span>
                          {/^\d+$/.test(haffInput.trim()) && baseFromHaffM(haffInput) ? (
                            <span className="publish-haff-conversion">
                              = {baseQuantityText(baseFromHaffM(haffInput) ?? "")} 哈夫币
                              {formatHaffChineseUnit(haffInput) ? <em className="publish-haff-chinese">（约 {formatHaffChineseUnit(haffInput)}）</em> : null}
                            </span>
                          ) : null}
                        </div>
                        <div className="publish-quick-chips" role="group" aria-label="常用哈夫币档位">
                          {(["50", "100", "200", "500"] as const).map((preset) => (
                            <button key={preset} type="button" className="publish-quick-chip" data-active={haffInput.trim() === preset ? "true" : "false"} disabled={haffControlsDisabled} onClick={() => changeHaffM(haffInventoryRow.itemId, preset)}>{preset}M</button>
                          ))}
                        </div>
                        <FieldError id="publish-haff-balance-error" text={haffErrorMessage} />
                      </div>
                    ) : (
                      <p className="publish-term-unavailable">当前发布目录尚未提供哈夫币计费项，暂不能填写。</p>
                    )}
                  </div>
                </div>
                <div className="publish-term-row publish-term-options-row">
                  <span className="publish-term-label">每日消耗<span className="publish-required-mark">必填</span><FieldHelp label="每日消耗">选择租客每日消耗哈夫币档位{termAdjustmentText ? `（当前档位比例调整：${termAdjustmentText}）` : ""}；自定义比例固定为 10M/天。</FieldHelp></span>
                  <div className="publish-term-control">
                    <FormRadioGroup
                      name="term_option"
                      label="每日消耗"
                      value={draft.termOptionCode}
                      options={options?.termOptions.map((option) => {
                        const is10m = option.dailyConsumption === "10000000";
                        const allowed = options?.rentalTermOptions?.[rentalMode]?.termOptionCodes;
                        return {
                          value: option.code,
                          label: `${haffMText(option.dailyConsumption)} / 天`,
                          disabled: (rentalMode === "custom" && !is10m) || Boolean(allowed && !allowed.includes(option.code)),
                        };
                      }) ?? []}
                      disabled={haffControlsDisabled || !options}
                      onChange={(value) => {
                        setDraft({ ...draft, termOptionCode: value });
                        invalidateConfirmations();
                      }}
                    />
                    {rentalMode === "custom" ? (
                      <small className="publish-term-subnote">自定义比例仅支持 10M/天 方案</small>
                    ) : null}
                  </div>
                </div>
                <div className="publish-term-row publish-term-options-row">
                  <span className="publish-term-label">出租方案<FieldHelp label="出租方案">普通比例按安全箱、体力、负重与日耗自动匹配；自定义比例（仅限10M/天）与极速比例可在允许区间内设置。</FieldHelp></span>
                  <div className="publish-term-control publish-ratio-control">
                  {showPricingSelect ? <div><FormSelect label="计价方案" value={draft.pricingOptionCode} disabled={disabledPricing || haffBaseIncomplete} placeholder="选择计价方案" popupClassName="publish-select-popup" options={[{ value: "", label: "选择计价方案" }, ...(options?.pricingOptionCodes.map((code, index) => ({ value: code, label: `计价方案 ${index + 1}` })) ?? [])]} onChange={(val) => setDraft({ ...draft, pricingOptionCode: val })} /><FieldError text={fieldError("pricingOptionCode")} /></div> : <>
                    {fastLocked ? <div className={`supply-ratio-locked${fastReady ? "" : " is-disabled"}`} aria-label="极速比例（已锁定）"><LockKeyhole size={14} aria-hidden="true" />{optionsAvailability !== "ready" ? "正在读取极速比例规则" : fastReady ? "当前使用极速出租" : "极速比例当前未启用"}</div> : <FormRadioGroup name="rental_mode" label="出租比例" value={rentalMode} options={rentalModeEntries.map((entry) => {
                      const range = ratioDisplayText(ratioRanges?.[entry]);
                      return { value: entry, label: rentalModeLabel(entry), description: range ? `${range}${entry === "custom" ? "（10M/天）" : ""}` : undefined, disabled: entry === "custom" && !customTermOptions(options).length };
                    })} disabled={haffControlsDisabled} onChange={changeRentalMode} />}
                    {rentalMode !== "ordinary" ? <label className="publish-ratio-input"><span>兑换比例</span><div className="publish-ratio-equation publish-ratio-equation--input"><span>1 元 =</span><Input data-first-field inputMode="decimal" value={ratioInput} disabled={haffControlsDisabled} aria-invalid={Boolean(ratioInlineProblem)} onChange={(event) => changeRatio(event.target.value)} placeholder="填写比例" aria-label="兑换比例" /><span>万哈夫币</span></div><small>{haffBaseIncomplete ? `请先补全${haffBaseMissing.map((item) => item.label).join("、")}后获取兑换比例范围` : selectedRatioRange ? `允许范围：${selectedRatioRange}` : modeRange ? `允许范围（万哈夫币/元）：${modeRange}` : "允许范围需读取当前规则后确认"}</small>{ratioInlineProblem ? <FieldError text={ratioInlineProblem.message} /> : null}</label> : null}
                  </>}
                </div></div>
                <div className="publish-term-row publish-term-result-row">
                  <span className="publish-term-label">测算结果<span className="publish-auto-tag">自动计算</span></span>
                  <div className="publish-term-control publish-calc-results">
                    <div className="publish-calc-item">
                      <span className="publish-calc-label"><CalendarClock size={14} aria-hidden="true" />预计租期<FieldHelp label="预计租期">按哈夫币余额 ÷ 每日消耗计算，不足一天按一天计；租期与收入按实时规则自动测算。</FieldHelp></span>
                      <output className="publish-calc-value" data-state={displayEstimateDuration ? "ready" : "pending"} aria-label="预计租期">{durationResult}</output>
                    </div>
                    <div className="publish-calc-item">
                      <span className="publish-calc-label">出租比例<FieldHelp label="出租比例">每收入 1 元可兑换多少万哈夫币（1 万＝10,000 哈夫币）；普通比例由平台按账号配置与日耗核定，自定义比例需在允许范围内。</FieldHelp></span>
                      <output className="publish-calc-value" data-state={ratioKnown ? "ready" : "pending"} aria-label="测算出租比例">{ratioResult}</output>
                    </div>
                  </div>
                </div>
                {fastLocked && options && !usesRentalModes(options) ? <div className="supply-blockers" role="alert"><strong>极速入口当前不可用</strong><p>当前规则暂不支持极速出租。</p><Link className="button secondary" href={modeHref(false)}>切换到普通出租</Link></div> : null}
                {fastLocked && optionsAvailability === "ready" && usesRentalModes(options) && rentalModes?.fast?.enabled !== true ? <div className="supply-blockers" role="alert"><strong>极速入口当前不可用</strong><p>{rentalModes?.fast ? "当前规则未启用极速比例，不能以极速入口上架。" : "当前规则未提供极速比例范围，不能以极速入口上架。"}</p><Link className="button secondary" href={modeHref(false)}>切换到普通出租</Link></div> : null}
                <details className="publish-rule-disclosure"><summary><span>日耗、租期与比例怎么选？</span></summary><div className="publish-disclosure-panel"><ManagedNoticeSections contentKey="placement:PUBLISH_TERM" compact /><p>预计租期按哈夫币余额除以每日消耗推算，不足一天按一天计。租期结束后按约定办理结算，不是手动承诺的成交时间。</p><p>普通比例由平台按账号配置和日耗核定；自定义比例仅支持10M/天。每收入1元对应的哈夫币越多，租金就越低，租客也更容易比较。</p><p>具体可选档位与比例以当前页面为准；修改资料后预估会更新，最终以上架时确认的报价为准。</p></div></details>
              </section>

              <section className="publish-term-section">
                <div className="publish-term-section-heading"><ShieldCheck size={20} aria-hidden="true" /><h3>赔付与押金</h3></div>
                <div className="publish-term-row publish-term-options-row"><span className="publish-term-label">赔付方案</span><div className="publish-term-control publish-payout-control"><FormRadioGroup name="full_payout" label="赔付方案" className="publish-payout-group" value={payoutSelected} disabled={formDisabled} onChange={changeFullPayout} options={[{ value: false, label: "普通赔付" }, { value: true, label: "全额包赔", badge: "推荐" }]} />
                  <div className="publish-payout-feature" data-selected={payoutSelected === true ? "true" : "false"}>
                    <div className="publish-payout-feature-heading">{payoutSelected === true ? <Image className="publish-payout-art" src="/art/quote/full-payout-shield.png" width={88} height={88} sizes="88px" alt="" /> : <ShieldCheck size={28} aria-hidden="true" />}<div><strong>{payoutSelected === true ? "全额包赔" : "可选全额包赔方案说明"}</strong><span>{payoutSelected === true ? "已选择此方案 · 平台推荐" : payoutSelected === false ? "当前选择普通赔付" : "可选保障 · 尚未选择赔付方案"}</span></div>{payoutSelected === true ? <Check size={18} aria-hidden="true" /> : null}</div>
                    <dl className="publish-payout-facts"><div><dt>包赔费率</dt><dd>8%</dd></div><div><dt>全额包赔基础押金门槛</dt><dd>{recommendation?.available && recommendationFresh ? `${yuanFromCents(recommendation.fullPayoutMinCents)} 元起` : "300 元起"}</dd></div></dl>
                    <p>正常结束时，按已消耗的哈夫币与物资收入收取8%服务费，并从收入中扣除。具体保障范围与提前结束的处理，请查看赔付规则。</p>
                  </div>
                <details id="publish-payout-rules" className="publish-policy-disclosure"><summary><span>查看赔付规则</span></summary>
                  <div className="publish-disclosure-panel">
                    <div className="publish-payout-scenes"><div className="publish-payout-scene-card"><strong>正常结束或提前结束</strong><p>按实际消耗对应的号主扣费前收入计算，由号主承担。上架时的全量收入仅为预估。</p></div></div>
                    <p className="publish-payout-subnote">未选择全额包赔或未正常交付开租，不自动收取。押金、保证金、价差、提前补足及赔款均不计入收费基数。</p>
                    <p className="publish-payout-subnote">服务费在结算生效时计算一次。保障针对本次租赁导致的约定损失，范围与实际赔付按有效条款处理；不承诺无条件赔付。</p>
                    <p className="publish-payout-subnote">以上是平台政策说明；提交上架前需在右侧确认适用协议。</p>
                  </div>
                </details>
                </div></div>

                <div className="publish-term-row"><label className="publish-term-label" htmlFor="publish-deposit">基础租客押金<FieldHelp label="基础租客押金">结合账号价值设置租客押金（不计入你的出租收入）；也可点击“查看推荐押金”后一键采用。</FieldHelp></label><div className="publish-term-control"><div className="supply-deposit-input-group"><div className="supply-deposit-input-wrap"><Input id="publish-deposit" data-first-field inputMode="decimal" value={depositInput} disabled={formDisabled} onChange={(event) => changeDeposit(event.target.value)} placeholder="填写押金金额" aria-invalid={Boolean(depositProblem())} /><span className="supply-deposit-unit">元</span></div><button type="button" className="button secondary supply-recommend-btn" disabled={formDisabled || recommendationBusy} onClick={() => void recommendDeposit()}>{recommendationBusy ? "计算中…" : "查看推荐押金"}</button></div><div className="publish-quick-chips" role="group" aria-label="常用押金档位">{(["200", "300", "500", "800"] as const).map((preset) => <button key={preset} type="button" className="publish-quick-chip" data-active={depositInput.trim() === preset ? "true" : "false"} disabled={formDisabled} onClick={() => changeDeposit(preset)}>{`${preset} 元`}</button>)}</div><FieldError text={depositProblem()?.message} />{recommendation?.available ? <div className="supply-recommend-result" data-fresh={recommendationFresh && !recommendationBinding?.mismatch ? "true" : "false"}><small>{recommendationAmountYuan === null ? "推荐金额待确认，请重新读取；不会按零元采用。" : recommendationAdopted && recommendationCatalogFresh ? `已采用推荐 ${moneyText({ amount: recommendationAmountYuan })}。` : recommendationBinding?.mismatch ? "推荐结果与当前账号资料或规则不匹配，已过期；请重新查看。" : recommendationFresh ? `推荐 ${moneyText({ amount: recommendationAmountYuan })}（依据当前账号资料）。` : `推荐 ${moneyText({ amount: recommendationAmountYuan })}已过期：资料已修改，请重新查看。`}</small><button type="button" className="button quiet" disabled={formDisabled || recommendationBusy || !recommendationFresh || recommendationAdopted} onClick={() => void adoptRecommendation()}>{recommendationBusy ? "核对中…" : recommendationAdopted && recommendationCatalogFresh ? "已采用" : "采用推荐"}</button></div> : recommendation && !recommendation.available ? <div className="supply-recommend-result supply-recommend-result--unavailable" role="status"><AlertCircle size={14} aria-hidden="true" /><span>{recommendation.reason === "FUNDING_POLICY_UNCONFIGURED" ? "当前规则尚未配置推荐押金依据，可自行填写押金。" : "请先补全安全箱、体力、负重、潜水与皮肤资料后再查看推荐押金。"}</span></div> : null}</div></div>
              </section>

              <section className="publish-term-section publish-term-note-section">
                <div className="publish-term-section-heading"><FileText size={20} aria-hidden="true" /><h3>补充信息</h3></div>
                <div className="publish-term-row">
                  <div className="publish-term-label"><label htmlFor="publish-description">备注（选填）</label><span className="publish-visibility-tag">向租客公开</span></div>
                  <div className="publish-term-control">
                    <Textarea id="publish-description" rows={3} maxLength={4000} value={draft.description ?? ""} disabled={formDisabled} aria-invalid={Boolean(fieldError("description"))} onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} placeholder="填写上号配合或账号使用说明（向租客公开展示）" />
                    <FieldError text={fieldError("description")} />
                  </div>
                </div>
                {infoSourceOptions?.enabled || infoSourceValue ? <div className="publish-term-row">
                  <div className="publish-term-label"><span>信息来源（选填）</span><span className="publish-visibility-tag publish-visibility-tag--private">仅平台可见</span></div>
                  <div className="publish-term-control">
                    <FormSelect label="信息来源（选填）" value={infoSourceValue} disabled={formDisabled || !infoSourceOptions?.enabled || infoSourceOptions.optionsState !== "CONFIGURED"} placeholder="请选择信息来源" popupClassName="publish-select-popup" options={[{ value: "", label: "请选择信息来源" }, ...(infoSourceLegacy ? [{ value: infoSourceValue, label: `${infoSourceValue}（历史来源原文）` }] : []), ...(infoSourceOptions?.options.map(option => ({ value: option.value, label: option.name })) ?? [])]} onChange={value => changeAttribute("info_source", value || null)} />
                    {infoSourceLegacy ? <small>已保留历史来源原文，重新选择后才会替换。</small> : null}
                    <FieldError text={fieldError("attributes.info_source")} />
                  </div>
                </div> : null}
              </section>
            </div>
          </SectionCard>
        </div>
      </form>

      {railExpanded ? <div className="publish-rail-backdrop" aria-hidden="true" onClick={() => setRailExpanded(false)} /> : null}
      <aside ref={railRef} id="publish-quote" tabIndex={-1} className="publish-rail" data-quoted={effectiveQuote ? "true" : "false"} data-expanded={railExpanded ? "true" : "false"} data-stale={ownerPreviewStale ? "true" : "false"} data-pending={ownerIncomePreviewPending ? "true" : undefined} aria-label="出租报价">
        <div className="publish-rail-head">
          <div className="publish-rail-heading-group">
            <h2>预计出租收入</h2>
          </div>
          <FieldHelp label="查看出租报价">预计收入为号主侧哈夫币和物品的扣费前金额，按全部库存消耗估算。押金不计入收入；实际收入按使用情况和结算场景计算，不保证最终到账；计价单位均为人民币（元）。</FieldHelp>
          <div className="publish-rail-mobile-summary">
            <span>{railSummary.label}</span>
            <strong data-pending={railSummary.pending ? "true" : undefined}>{railSummary.value}</strong>
          </div>
          <button type="button" className="publish-rail-mobile-toggle" aria-expanded={railExpanded} aria-controls="publish-quote-body" onClick={() => setRailExpanded((value) => !value)}>
            {railExpanded ? "收起" : "明细"}
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="publish-rail-scroll" id="publish-quote-body">
        {published ? <div className="publish-success" role="status"><Check size={20} aria-hidden="true" /><strong>已上架</strong><p>公众列表、详情与“我的上架账号”显示的是同一份发布资料。</p>{readOnly ? <p>上架后不可修改；如需变更，请先在账号管理中下架，再重新填写上架资料。</p> : null}<div className="supply-inline-actions"><Link className="button primary" href={`/accounts/${encodeURIComponent(accountId ?? "")}`}>查看公开详情</Link><Link className="button secondary" href="/account?view=accounts">我的上架账号</Link></div></div> : <>
          {netEstimate ? <div className="publish-income-total"><span>预计所得</span><output aria-label="预计净所得">{netEstimate.ownerNet.amount} 元</output></div> : effectiveQuote ? (
            <div className="publish-income-total">
              <span>预计收入（扣费前）</span>
              <output aria-label="预计收入合计">{breakdown ? `${centsText(breakdown.totalCents)} 元` : "金额待核对"}</output>
            </div>
          ) : previewGrossAmount ? (
            <div className="publish-income-total">
              <span>{payoutSelected === true ? "预计收入（扣费前）" : ownerPreview?.state === "PARTIAL" ? "预计总收入（部分）" : "预计总收入"}{ownerPreviewStale ? <small className="publish-stale-tag">（上次预估）</small> : null}</span>
              <output aria-label="实时预估总收入">{`${previewGrossAmount} 元`}</output>
            </div>
          ) : (
            <div className="publish-income-total publish-income-total--pending">
              <span>预计总收入</span>
              <output aria-label="待核算总收入"><PendingValue label="待核算" /></output>
              <small className="publish-pending-hint">{pendingTotalHint}</small>
            </div>
          )}
          <dl className="publish-rail-lines">
            <div>
              <dt>哈夫币计价比例</dt>
              <dd>
                {effectiveQuote?.ownerHaffRatio
                  ? `${effectiveQuote.ownerHaffRatio} 万哈夫币/元`
                  : ownerPreview?.ownerHaffRatioWanPerYuan
                    ? `${ownerPreview.ownerHaffRatioWanPerYuan} 万哈夫币/元`
                    : <PendingValue label="待核定" />}
              </dd>
            </div>
            <div>
              <dt>预计租期{!effectiveQuote && displayEstimateDuration ? <small>按当前条件估算</small> : null}</dt>
              <dd>
                {displayEstimateDuration ?? <PendingValue label="待核算" />}
              </dd>
            </div>
            <div>
              <dt>哈夫币预计收入</dt>
              <dd>
                {effectiveQuote && breakdown
                  ? `${centsText(breakdown.haffCents)} 元`
                  : ownerPreview?.ownerHaffIncome
                    ? `${ownerPreview.ownerHaffIncome.amount} 元`
                    : ownerIncomePreviewPending
                      ? "计算中…"
                      : <PendingValue label="待核定" />}
              </dd>
            </div>
            <div className="publish-live-resource-total" aria-busy={ownerIncomePreviewPending&&!effectiveQuote}>
              <dt>物品预计收入{ownerPreviewStale&&!effectiveQuote?<small>上次预估</small>:null}</dt>
              <dd><output aria-label="物品预估收入" aria-live="off">{resourceTotalText ?? <PendingValue label="待填" />}</output></dd>
            </div>
          </dl>
          <p className="publish-rail-note">按库存全部用完预估，押金不计入收入。</p>
          {netEstimate ? <div className="publish-fee-pending" role="status">
            <div><span>扣费前收入</span><strong>{netEstimate.ownerGross.amount} 元</strong></div>
            {netEstimate.platformFee ? <div><span>平台手续费</span><strong>−{netEstimate.platformFee.amount.amount} 元</strong></div> : null}
            <div><span>全额包赔服务费{netEstimate.selected ? "（8%）" : ""}</span><strong>{netEstimate.selected ? `−${netEstimate.serviceFee.amount.amount} 元` : "未选择，不收取"}</strong></div>
            <p>按全部申报库存用完、正常结束预估；实际按使用情况与结算条款核算。</p>
          </div> : payoutSelected === true ? <div className="publish-fee-pending" role="status"><div><span>全额包赔服务费</span><strong>{ownerIncomePreviewPending || ownerPreviewStale ? "正在重新核算…" : "金额待核定"}</strong></div><p>当前为扣费前收入，费后金额尚未核定。</p></div> : payoutSelected === null ? <p className="publish-rail-note">选择赔付方案后可查看费后预计所得。</p> : null}
          <dl className="publish-rail-lines publish-rail-deposits">
            <div><dt>基础租客押金<small>不计入收入</small></dt><dd>{!ownerPreviewStale && ownerPreview?.depositState === "KNOWN" && ownerPreview.baseTenantDeposit ? moneyText(ownerPreview.baseTenantDeposit) : declaredDepositCents !== null ? `${yuanFromCents(declaredDepositCents)} 元` : depositInput.trim() ? "请检查金额" : <PendingValue label="待填" />}</dd></div>
            {!ownerPreviewStale && ownerPreview?.depositState === "KNOWN" && ownerPreview.baseTenantDeposit ? <div className="publish-deposit-verified"><dt><Check size={12} aria-hidden="true" />符合押金要求</dt></div> : null}
            {actualPublisherRequirement !== null && actualPublisherRequirement > 0n ? <div><dt>发布保证金<small>本次规则要求</small></dt><dd>{moneyText(effectiveQuote?.publisherBailRequirement)}</dd></div> : null}
          </dl>
          {actualPublisherRequirement !== null && actualPublisherRequirement > 0n ? <p className="publish-rail-note">请先保存草稿，再前往 <Link href="/account?view=credit">信用与保证金</Link> 查看缴纳状态。</p> : null}
          {effectiveQuote ? <small className="publish-rail-deposit-note">会员实际实付押金以下单时的个人报价为准。</small> : null}
          {effectiveQuote?.expiryDisclosures.length ? <div className="publish-rail-expiry"><strong>权益有效期</strong>{effectiveQuote.expiryDisclosures.map((item) => <p key={item.entitlementId}>{catalog?.entitlements.find((entitlement) => entitlement.id === item.entitlementId)?.name ?? supply?.version?.presentation?.entitlements.find((entitlement) => entitlement.id === item.entitlementId)?.name ?? "该项权益"}：{item.expiresAt ? new Date(item.expiresAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "长期有效"} · 本租期不保证覆盖完整有效期</p>)}</div> : null}
          {effectiveQuote && !quoteConsistent ? <div className="supply-blockers" role="alert"><strong>报价金额待核对</strong><p>本次报价的行金额与合计不一致，暂不能确认上架。</p></div> : null}
          {visibleBlockers.length ? <div className="supply-blockers" data-blocker-count={visibleBlockers.length}>
            {userBlockers.length ? <section className="supply-blocker-group is-user" data-blocker-group="user"><strong><TriangleAlert size={14} aria-hidden="true" />上架限制（{userBlockers.length}）</strong><ul>{Array.from(new Set(userBlockers.map(blockerText))).map((text) => <li key={text}>{text}</li>)}</ul></section> : null}
            {systemBlockers.length ? <section className="supply-blocker-group is-system" data-blocker-group="system"><strong><Clock3 size={14} aria-hidden="true" />暂无法上架</strong><ul>{Array.from(new Set(systemBlockers.map(blockerText))).map((text) => <li key={text}>{text}</li>)}</ul></section> : null}
            <p className="supply-muted" role="status">当前暂不可提交上架，请处理上述事项或联系客服。</p>
            <button type="button" className="button secondary" disabled={Boolean(busy) || formDisabled} onClick={() => void refreshLatest(false)}>刷新状态</button>
          </div> : null}
          {!agreement ? <p className="supply-muted">本次条款正文尚未读取，暂不能确认上架。</p> : null}
          {payoutSelected === true && !published && !currentPayoutTerms ? (
            <p className="supply-muted" role={payoutTerms?.status === "unavailable" ? "alert" : "status"}>
              {payoutTerms?.target === payoutTarget && payoutTerms.status === "unavailable"
                ? "全额包赔条款暂时无法读取或版本已变化，请刷新后重试。"
                : "正在读取本次全额包赔条款…"}
            </p>
          ) : null}
        </>}
        </div>
        {!published ? <div className="publish-rail-footer">
          {readOnly ? <div className="publish-rail-readonly"><p>{mustCreateAccount ? "此账号不能修改或再次上架；如需出租，请重新填写上架资料。" : reviewState === "SUBMITTED" ? "当前资料正在审核中，不能直接编辑。" : "当前资料不是可编辑草稿。"}</p>{mustCreateAccount ? <Link className="button primary" href="/publish">重新填写上架资料</Link> : reviewState === "SUBMITTED" ? <Link href="/account?view=accounts" className="button secondary">返回账号管理</Link> : <button type="button" className="button primary" disabled={identityState !== "confirmed" || !identityRef.current || Boolean(busy)} onClick={() => void beginEditing()}>{busy === "edit" ? "准备草稿中…" : "继续填写草稿"}</button>}</div> : <>
            {effectiveQuote ? <div className="publish-confirm">
              <div className="publish-consent-card">
                {agreementConsent}
                {payoutConsent}
              </div>
              <button type="button" className="button primary" disabled={primaryDisabled} title={blockerHint} onClick={() => void confirmPublish()}>{primaryLabel}</button>
              <button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button>
              {rulesAccepted ? <p className="supply-muted">条款已按当前资料确认；资料变化后需重新确认。</p> : null}
            </div> : <div className="publish-rail-actions">
              <div className="publish-consent-card">
                {agreementConsent}
                {payoutConsent}
              </div>
              <button type="button" className="button primary" disabled={primaryDisabled} title={blockerHint} onClick={() => void primaryAction()}>{primaryLabel}</button>
              <button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button>
            </div>}
          </>}
        </div> : null}
      </aside>
    </div>

    <Dialog.Root open={termsModalOpen} onOpenChange={setTermsModalOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-agreement-backdrop" />
        <Dialog.Popup className="publish-dialog publish-agreement-dialog" data-slot="dialog-content">
          <header>
            <Dialog.Title>{agreement?.title ?? "出租条款"}</Dialog.Title>
            <Dialog.Close className="publish-reading-close" aria-label="关闭出租条款">
              <X size={20} aria-hidden="true" />
            </Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">
            当前读取的协议正文；阅读不会自动同意条款，上架前仍需单独勾选确认。
          </Dialog.Description>
          {agreement ? <AgreementBody body={agreement.body} /> : <p>暂未取得协议正文。</p>}
          <div className="publish-agreement-dialog-actions">
            <Dialog.Close className="button secondary">返回</Dialog.Close>
            {agreement ? <button type="button" className="button primary" disabled={formDisabled} onClick={() => { setAgreementChecked(true); setTermsModalOpen(false); }}>我已阅读并同意本条款</button> : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root open={payoutTermsModalOpen} onOpenChange={setPayoutTermsModalOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-agreement-backdrop" />
        <Dialog.Popup className="publish-dialog publish-agreement-dialog" data-slot="dialog-content">
          <header>
            <Dialog.Title>{currentPayoutTerms?.title ?? "全额包赔条款"}</Dialog.Title>
            <Dialog.Close className="publish-reading-close" aria-label="关闭包赔条款">
              <X size={20} aria-hidden="true" />
            </Dialog.Close>
          </header>
          <Dialog.Description className="sr-only">
            当前读取的全额包赔协议正文；阅读不会自动同意条款，上架前仍需单独勾选确认。
          </Dialog.Description>
          {currentPayoutTerms ? <AgreementBody body={currentPayoutTerms.body} /> : <p>暂未取得协议正文。</p>}
          <div className="publish-agreement-dialog-actions">
            <Dialog.Close className="button secondary">返回</Dialog.Close>
            {currentPayoutTerms ? <button type="button" className="button primary" disabled={formDisabled} onClick={() => { setPayoutAccepted(true); setPayoutTermsModalOpen(false); }}>我已阅读并同意包赔条款</button> : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root open={previewMedia !== null} onOpenChange={(open) => { if (!open) setPreviewMedia(null); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-media-lightbox-backdrop" />
        <Dialog.Popup className="publish-dialog publish-media-lightbox" data-slot="dialog-content" aria-label={previewMedia?.title ?? "图片预览"}>
          <header className="publish-media-lightbox-head">
            <Dialog.Title>{previewMedia?.title ?? "图片预览"}</Dialog.Title>
            <Dialog.Close className="publish-reading-close" aria-label="关闭图片预览">
              <X size={20} aria-hidden="true" />
            </Dialog.Close>
          </header>
          {previewMedia ? (
            <div className="publish-media-lightbox-body">
              <img src={previewMedia.url} alt={previewMedia.title} />
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root open={publishSuccessOpen} onOpenChange={setPublishSuccessOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay publish-dialog-backdrop publish-success-backdrop" />
        <Dialog.Popup className="publish-dialog publish-success-dialog" data-slot="dialog-content">
          <div className="publish-success-fireworks" aria-hidden="true">
            <span className="firework-particle particle-1">🎆</span>
            <span className="firework-particle particle-2">✨</span>
            <span className="firework-particle particle-3">🎉</span>
            <span className="firework-particle particle-4">✨</span>
            <span className="firework-particle particle-5">🥳</span>
            <span className="firework-particle particle-6">🎆</span>
          </div>
          <div className="publish-success-icon-badge">
            <Check size={32} aria-hidden="true" />
          </div>
          <header className="publish-success-header">
            <Dialog.Title>账号已成功上架！</Dialog.Title>
            <Dialog.Description>
              你的账号已发布至平台，租客可在游戏专区浏览并下单。
            </Dialog.Description>
          </header>
          <div className="publish-success-timer">
            <strong>{successCountdown}</strong> 秒后将自动前往我的账号…
          </div>
          <div className="publish-success-actions">
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setPublishSuccessOpen(false);
                router.push("/account?view=accounts");
              }}
            >
              立即前往我的账号
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setPublishSuccessOpen(false)}
            >
              留在本页
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </ServiceShell>;
}




