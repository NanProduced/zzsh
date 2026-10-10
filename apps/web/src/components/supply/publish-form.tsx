"use client";
import { FormSelect, FormRadioGroup, Input, IntegerStepper, Textarea, DateTimePicker } from "../ui/form-controls";
import "./publish-refinement.css";

import Link from "next/link";
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
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { ServiceShell } from "../layout/service-shell";
import { useUserSessionStore } from "../session/user-session-provider";
import {
  editableDeclaration,
  groupForField,
  inventoryEditorRows,
  mergeInventory,
  supplyApi,
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
import { DELTA_REGION_OPTIONS } from "../../lib/delta-region-options";
import {
  SERVICE_WINDOW_END_OPTIONS,
  SERVICE_WINDOW_START_OPTIONS,
  canonicalResourceCode,
  resourceUnitLabel,
  formatServiceWindowMinute,
} from "../../lib/listing-filters";
import {
  baseFromHaffM,
  baseQuantityText,
  beijingInputFromIso,
  buildRentalPricing,
  centsOfMoney,
  centsText,
  depositDeclarationCents,
  fullPayoutSelected,
  haffMInputFromBase,
  haffMText,
  isoFromBeijingInput,
  minutesToTimeValue,
  ownerQuoteBreakdown,
  ratioRangeText,
  rentalModeLabel,
  rentalPricingOf,
  timeValueToMinutes,
  yuanFromCents,
  yuanToCents,
} from "../../lib/publish-derive";
import type {
  DepositRecommendation,
  DraftInput,
  MySupply,
  PublishingCatalog,
  PublishingOptions,
  ResourceIncomePreview,
  RentalMode,
  SupplyGame,
} from "../../lib/supply-types";
import type { PublishMode } from "../../lib/service-navigation";

type PublishFormProps = { mode: PublishMode; gameCode?: string; accountId?: string; editRequested?: boolean };
type RegionOption = { province: string; city: string };
type SessionId = string | null | undefined;
type MediaPurpose = "ACCOUNT_DISPLAY" | "ACCOUNT_EVIDENCE";
type IdentityState = "checking" | "confirmed" | "failed";
type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };
type WriteIntent = { action: string; context: RequestContext; persisted?: SupplyWriteIntent; run: () => Promise<void | boolean> };
type DraftRequest = { context: RequestContext; accountId: string; body: DraftInput & { expectedRevision: string }; key: string };
type MediaCategory = "SHOWCASE" | "PENALTY";
type MediaEntry = {
  id: string;
  purpose: MediaPurpose;
  category?: MediaCategory;
  file?: File;
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
type SkinQuery = { q?: string; categoryId?: string; rarityCode?: string; cursor?: string };
type PublishGroupId = "account" | "assets" | "terms" | "media";
type OptionsAvailability = "pending" | "ready" | "unavailable" | "failed";
type NavigationIntent = { message: string; label: string; run: () => void; cancel?: () => void };
type RecommendationInputs = {
  safeBoxCode: string | null;
  vitality: number | null;
  bear: number | null;
  dive: number | null;
  skinIds: string[];
};
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

const groupMeta: Record<PublishGroupId, { title: string }> = {
  account: { title: "账号资料" },
  assets: { title: "库存与皮肤" },
  terms: { title: "出租条件" },
  media: { title: "展示图片" },
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

function blockerText(code: string): string {
  return supplyBlockerMessages[code] ?? "当前资料暂不能继续，请读取最新状态或稍后重试。";
}

function localizedErrorMessage(message: string): string {
  const messages: Record<string, string> = { ...supplyBlockerMessages, RULE_INPUT_MISSING: "当前资料不满足核价规则，请检查账号属性、库存和出租比例", TERM_UNDETERMINED: "暂不能确定租期，请检查每日消耗和哈夫币数量" };
  const codes = message.split(",").map((code) => code.trim()).filter(Boolean);
  if (codes.length > 0 && codes.every((code) => code in messages)) {
    return codes.map((code) => messages[code]).join("；");
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

function publishGroupForPath(path: string): PublishGroupId {
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
    draft.inventory.some((item) => item.quantity !== null) ||
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

function FieldError({ text }: { text?: string }) {
  return text ? <span className="supply-field-error" role="alert">{text}</span> : null;
}

function Notice({ error, text }: { error?: SupplyRequestError | null; text?: string }) {
  if (!error && !text) return null;
  return <div className={`supply-notice ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
    {error ? <AlertCircle size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
    <span>{error ? error.status === 0 || error.status >= 500 ? "暂时未取得结果，请先恢复当前步骤后继续。" : localizedErrorMessage(error.message) : text}</span>
  </div>;
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

function SectionCard({ id, title, hasError, children, actions }: { id: PublishGroupId; title: string; hasError: boolean; children: ReactNode; actions?: ReactNode }) {
  return <section id={`publish-group-${id}`} data-publish-group={id} aria-labelledby={`publish-heading-${id}`} className={`publish-section-card${hasError ? " is-error" : ""}`}>
    <header className="publish-section-header"><h2 id={`publish-heading-${id}`} className="publish-section-title publish-group-title">{title}</h2></header>
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

// Same shadcn/Base UI composition and theme tokens as the existing form controls.
function PublishingNotice({ open, onClose, agreement }: { open: boolean; onClose: () => void; agreement: PublishingOptions["agreement"] | null }) {
  const [seconds, setSeconds] = useState(5);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const read = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!open || read.current) return;
    const deadline = window.performance.now() + 5000;
    setSeconds(5);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - window.performance.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) { read.current = true; window.clearInterval(timer); }
    }, 200);
    return () => window.clearInterval(timer);
  }, [open]);
  return <Dialog.Root open={open} disablePointerDismissal onOpenChange={(next, event) => {
    if (!next && seconds > 0) event.cancel();
    else if (!next) onClose();
  }}>
    <Dialog.Portal><Dialog.Backdrop className="modal-overlay publish-dialog-backdrop" />
      <Dialog.Popup className="publish-dialog publish-reading-dialog" data-slot="dialog-content" initialFocus={titleRef} finalFocus={() => document.querySelector<HTMLElement>(".publish-outline a")}>
        <header className="publish-reading-header"><ShieldCheck size={26} aria-hidden="true" /><div><Dialog.Title ref={titleRef} tabIndex={-1}>出租上架须知</Dialog.Title><Dialog.Description>保障账号权益，先了解以下规则。</Dialog.Description></div><Dialog.Close className="publish-reading-close" aria-label="关闭上架须知" disabled={seconds > 0}><X size={20} aria-hidden="true" /></Dialog.Close></header>
        <div className="publish-reading-body">
          <div className="publish-reading-essentials">
            <div><ShieldCheck size={20} aria-hidden="true" /><div><h3>绑定人脸须为号主本人</h3><p>解除人脸验证需准备双设备：两部手机，或手机与电脑。</p></div></div>
            <div><CreditCard size={20} aria-hidden="true" /><div><h3>目前仅支持银行卡提现</h3><p>请提前准备本人银行卡。</p></div></div>
          </div>
          <section><h3>如实申报资料与库存</h3><ul><li>安全箱填写赛季永久容量，临时体验卡另填库存；有封禁记录时，需提供对应截图。</li><li>申报可出租的全量库存，留空与 0 含义不同。六级子弹 <strong>1 组 = 60 发</strong>，AWM、巴雷特按发，顶级保险卡按张；已激活的体验效果不计入卡片库存。</li></ul></section>
          <section><h3>核对报价、租期与收入</h3><ul><li>租期和金额由平台按本次规则计算；修改资料或规则变化后，需要重新核价。</li><li>预计收入为<strong>扣费前金额</strong>，最终按实际消耗与结束场景结算。押金不计入收入。</li></ul></section>
          <section><h3>确认上号配合与赔付方案</h3><p>请填写实际可协助上号的时间。全额包赔为可选方案，费率 <strong>8%</strong>、基础押金至少 <strong>300 元</strong>；收费基数、承担方及保障条件以本次有效条款为准。</p></section>
          <p className="publish-reading-tip"><Info size={16} aria-hidden="true" />备注向租客公开，请勿填写密码、验证码等敏感信息。</p>
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
          <p>阅读须知不代表接受本次报价，上架前仍需单独确认。</p><Dialog.Close className="button primary" disabled={seconds > 0}>{seconds > 0 ? `请阅读须知（${seconds} 秒）` : "我已了解，开始填写"}</Dialog.Close>
        </footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function SkinCardMedia({ mediaId }: { mediaId: string | null }) {
  const src = mediaId ? `/api/supply/media/${encodeURIComponent(mediaId)}/content` : null;
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="skin-card-media" aria-hidden="true"><span className="skin-card-media-fallback"><FileImage size={16} /><span>暂无公开图</span></span></span>;
  return <span className="skin-card-media" aria-hidden="true">
    <img src={src} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; setFailed(true); }} onLoad={(event) => { event.currentTarget.hidden = false; setFailed(false); }} />
    <span className="skin-card-media-fallback" hidden><FileImage size={16} /><span>暂无公开图</span></span>
  </span>;
}

function LoginPlatformIcon({ code }: { code: string }) {
  const platform = ({ legacy_login_qq: "tencentqq", legacy_login_wechat: "wechat", legacy_login_steam_cn: "steam", legacy_login_steam_global: "steam" } as Record<string, string>)[code];
  return platform ? <img className="publish-login-platform-icon" src={`/images/login-platforms/${platform}.svg`} width={20} height={20} alt="" /> : <LogIn size={20} />;
}

function InventoryIcon({ code }: { code: string | null }) {
  const canonical = canonicalResourceCode(code);
  const art = ({df_billable_awm_bullet:"awm-round",df_billable_level6_bullet:"level6-round",df_billable_barrett_bullet:"barrett-round",df_billable_level6_armor:"level6-armor",df_billable_level6_helmet:"level6-helmet",df_billable_coffee:"coffee-beans",top_insure_card_piece:"insurance-card",df_billable_top_insure_card_piece:"insurance-card"} as Record<string,string>)[canonical??""];
  if(art)return <img src={`/art/zhouzhou/inventory-polished/${art}.webp`} width={56} height={56} alt="" />;
  const Icon = canonical === "df_billable_coffee" ? Bean
    : canonical === "df_billable_level6_armor" ? Shield
    : canonical === "df_billable_level6_helmet" ? HardHat
    : canonical === "df_billable_level6_bullet" || canonical === "df_billable_awm_bullet" || code === "barrett_round" || code === "df_billable_barrett_bullet" ? Crosshair
    : code === "top_insure_card_piece" || code === "df_billable_top_insure_card_piece" ? Ticket : Box;
  return <Icon size={22} aria-hidden="true" />;
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
  onChange,
}: {
  province: string;
  city: string;
  options: ReadonlyArray<RegionOption>;
  disabled: boolean;
  onChange: (province: string | null, city: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeProvince, setActiveProvince] = useState(province);
  const searchRef = useRef<HTMLInputElement>(null);
  const pairs = [...options, ...(province && city && !options.some((item) => item.province === province && item.city === city) ? [{ province, city }] : [])];
  const provinces = [...new Set(pairs.map((item) => item.province))];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProvinces = provinces.filter((item) => !normalizedQuery || item.toLocaleLowerCase().includes(normalizedQuery) || pairs.some((pair) => pair.province === item && pair.city.toLocaleLowerCase().includes(normalizedQuery)));
  const current = visibleProvinces.includes(activeProvince) ? activeProvince : visibleProvinces[0] ?? "";
  const cities = pairs.filter((item) => item.province === current && (!normalizedQuery || current.toLocaleLowerCase().includes(normalizedQuery) || item.city.toLocaleLowerCase().includes(normalizedQuery))).map((item) => item.city);
  const selected = province && city ? `${province} · ${city}` : "请选择省份和城市";

  useEffect(() => {
    if (province) setActiveProvince(province);
  }, [province]);

  return <div className="publish-region-field">
    <span className="publish-region-label">地区选择</span>
    <div className="publish-region-control">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" className="publish-region-trigger" disabled={disabled} aria-label="地区选择">
            <MapPin size={16} aria-hidden="true" /><span>{selected}</span><ChevronDown size={16} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="publish-region-popover" align="start" sideOffset={8} collisionPadding={12} onOpenAutoFocus={(event) => { event.preventDefault(); searchRef.current?.focus(); }}>
            <label className="publish-region-search"><Search size={15} aria-hidden="true" /><span className="sr-only">搜索省份或城市</span><input ref={searchRef} type="search" value={query} placeholder="搜索省份或城市" onChange={(event) => setQuery(event.target.value)} /></label>
            {visibleProvinces.length ? <div className="publish-region-columns">
              <div className="publish-region-provinces" role="group" aria-label="选择省份">
                {visibleProvinces.map((item) => <button type="button" key={item} aria-pressed={item === current} data-active={item === current} onClick={() => setActiveProvince(item)}>{item}</button>)}
              </div>
              <div className="publish-region-cities" role="group" aria-label={`${current}城市`}>
                <strong>{current || "城市"}</strong>
                <div>{cities.map((item) => <button type="button" key={`${current}-${item}`} data-selected={province === current && city === item} onClick={() => { onChange(current, item); setOpen(false); setQuery(""); }}>{item}</button>)}</div>
              </div>
            </div> : <p className="publish-region-empty">当前没有可选地区</p>}
            {province && city ? <button type="button" className="publish-region-clear" onClick={() => { onChange(null, null); setOpen(false); setQuery(""); }}>清除当前地区</button> : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {province && city ? <button type="button" className="publish-region-chip" aria-label={`移除地区 ${province} ${city}`} disabled={disabled} onClick={() => onChange(null, null)}>{province} · {city}<X size={13} aria-hidden="true" /></button> : null}
    </div>
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
  const redirectedGuest = useRef(false);
  const accountRef = useRef<string | undefined>(accountIdProp);
  const loadedAccountRef = useRef<string | undefined>(undefined);
  const routeAccountRef = useRef<string | undefined>(accountIdProp);
  const gameRef = useRef("");
  const gamesRef = useRef<SupplyGame[]>([]);
  const skinRequestRef = useRef(0);
  const skinQueryRef = useRef({ gameId: "", key: "" });
  const supplyRef = useRef<MySupply | null>(null);
  const quoteCatalogBinding = useRef<{ token: string; catalogRevision: string } | null>(null);
  const draftRef = useRef<DraftInput>(emptyDraft());
  const serviceWindowCache = useRef<Pick<DraftInput["attributes"], "service_window_start_minute" | "service_window_end_minute" | "service_window_cross_midnight" | "service_window_timezone"> | null>(null);
  const uploadQueue = useRef(Promise.resolve());
  const cancelledMedia = useRef(new Set<string>());
  const formRef = useRef<HTMLFormElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const correctedAccountGameRef = useRef("");

  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const [gameId, setGameId] = useState("");
  const [identityState, setIdentityState] = useState<IdentityState>("checking");
  const [accountId, setAccountId] = useState<string | undefined>(accountIdProp);
  const [supply, setSupply] = useState<MySupply | null>(null);
  const [draft, setDraftState] = useState<DraftInput>(emptyDraft);
  const [pendingResourceInputs,setPendingResourceInputs]=useState<Record<string,string>>({});
  const [resourcePreview,setResourcePreview]=useState<ResourceIncomePreview|null>(null);
  const [resourcePreviewPending,setResourcePreviewPending]=useState(false);
  const [serviceWindowCustomSelected, setServiceWindowCustomSelected] = useState(false);
  const [options, setOptions] = useState<PublishingOptions | null>(null);
  const [optionsAvailability, setOptionsAvailability] = useState<OptionsAvailability>("pending");
  const [catalog, setCatalog] = useState<PublishingCatalog | null>(null);
  const [catalogAvailability, setCatalogAvailability] = useState<CatalogAvailability>("pending");
  const [skinNames, setSkinNames] = useState<Record<string, string>>({});
  const [skinQuery, setSkinQuery] = useState("");
  const [skinCategory, setSkinCategory] = useState("");
  const [skinRarity, setSkinRarity] = useState("");
  const [media, setMedia] = useState<MediaEntry[]>([]);
  const [editing, setEditing] = useState(!accountIdProp);
  const [authRequired, setAuthRequired] = useState(false);
  const [loadingAccount, setLoadingAccount] = useState(Boolean(accountIdProp));
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<SupplyRequestError | null>(null);
  const [serverSnapshot, setServerSnapshot] = useState<MySupply | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [readingNotice, setReadingNotice] = useState(true);
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent | null>(null);
  const routeGameApproval = useRef<string | null>(null);
  const [routeSwitch, setRouteSwitch] = useState(0);
  const leavingRef = useRef(false);
  const navigationFocusRef = useRef<HTMLElement | null>(null);
  const [agreementChecked, setAgreementChecked] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(false);
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
        setMedia(previous => previous.some(row => row.assetId === assetId) ? previous : [...previous, { id: `recovered-${assetId}`, assetId, purpose, category, reviewState: record.receipt?.reviewState, status: "bound", bindingSaved: false, intentKey: record.key, uploadKey: String(record.body.uploadKey), context, previewUrl: `/api/supply/media/${encodeURIComponent(assetId)}/access` }]);
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
    setResourcePreview(null);
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
      setSkinNames({});
      skinQueryRef.current = { gameId: "", key: "" };
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
      setEditing(next.version.reviewState === "DRAFT");
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
          previewUrl: `/api/supply/media/${encodeURIComponent(binding.assetId)}/access`,
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
      if (snapshot.status === "error") identityPauseGate.current.markFailed();
      else identityPauseGate.current.startCheck();
      setIdentityPhase(snapshot.status === "loading" ? "checking" : "failed");
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
      setIdentityPhase("checking");
      if (!redirectedGuest.current) {
        redirectedGuest.current = true;
        const target = window.location.pathname + window.location.search;
        router.replace(`/login?next=${encodeURIComponent(target)}`);
      }
      return false;
    }
    redirectedGuest.current = false;
    const next = snapshot.userId;
    const previous = identityRef.current;
    identityRef.current = next;
    if (previous !== undefined && previous !== next) {
      invalidateContext("登录身份已变化，旧账号资料已清除。", !next);
      router.replace(mode === "fast" ? "/publish?mode=fast" : "/publish");
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
  useEffect(() => {
    if (!navigationProtected) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
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
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardNavigation, true);
    };
  }, [navigationProtected, router]);

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
            router.replace(`/publish?${params.toString()}`);
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
        setSkinNames({});
        skinQueryRef.current = { gameId: "", key: "" };
      }
    }
    if (routeAccountRef.current !== accountIdProp) {
      routeAccountRef.current = accountIdProp;
      invalidateContext(accountIdProp ? "正在读取新的发布资料。" : "正在准备新的发布资料。", false);
      accountRef.current = accountIdProp;
      setAccountId(accountIdProp);
      setEditing(!accountIdProp);
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
          setEditing(loaded.version?.reviewState === "DRAFT");
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
            router.replace(`/publish?${params.toString()}`);
          }
          setMedia((loaded.version?.declaration.mediaBindings ?? []).map((binding, index) => ({
            id: `bound-${binding.assetId}-${index}`,
            purpose: binding.purpose,
            category: binding.category ?? (binding.purpose === "ACCOUNT_EVIDENCE" ? "PENALTY" : "SHOWCASE"),
            reviewState: binding.reviewState,
            publicDisplayEligible: binding.publicDisplayEligible,
            publiclyReadable: binding.publiclyReadable,
            assetId: binding.assetId,
            previewUrl: `/api/supply/media/${encodeURIComponent(binding.assetId)}/access`,
            bindingSaved: true,
            context: { epoch: epochRef.current, identity: identityRef.current, accountId: loaded.account.id, gameId: loaded.account.game_id },
            status: "bound",
            intentKey: "",
            uploadKey: "",
          })));
          if (editRequested && loaded.version?.reviewState !== "SUBMITTED") setNotice("点击“开始修改”后，会按当前版本创建可编辑草稿。");
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

  const loadSkinPage = useCallback(async (query: SkinQuery, append: boolean) => {
    if (!gameId) return;
    const queryKey = JSON.stringify({ q: query.q ?? "", categoryId: query.categoryId ?? "", rarityCode: query.rarityCode ?? "" });
    const requestId = ++skinRequestRef.current;
    const request = { id: requestId, key: `${gameId}:${queryKey}` };
    const isCurrent = () => isCurrentQuery(request, skinRequestRef.current, `${skinQueryRef.current.gameId}:${skinQueryRef.current.key}`);
    if (!append) skinQueryRef.current = { gameId, key: queryKey };
    if (append && (skinQueryRef.current.gameId !== gameId || skinQueryRef.current.key !== queryKey)) return;
    const context = captureContext(accountRef.current, gameId);
    const controller = beginRequest();
    setLoadingCatalog(true);
    try {
      if (!(await waitForIdentity(context))) return;
      const params = new URLSearchParams({ limit: "30" });
      if (query.q) params.set("q", query.q);
      if (query.categoryId) params.set("categoryId", query.categoryId);
      if (query.rarityCode) params.set("rarityCode", query.rarityCode);
      if (query.cursor) params.set("cursor", query.cursor);
      const page = await supplyApi.catalog(gameId, params, controller.signal);
      if (!currentContext(context, controller.signal) || !isCurrent()) return;
      setCatalog((previous) => {
        if (!append || !previous) return page;
        const existing = new Set(previous.skins.map((skin) => skin.id));
        return { ...page, skins: [...previous.skins, ...page.skins.filter((skin) => !existing.has(skin.id))] };
      });
      setSkinNames((previous) => Object.fromEntries([
        ...Object.entries(previous),
        ...page.skins.map((skin) => [skin.id, skin.name] as const),
      ]));
      setCatalogAvailability("ready");
    } catch (failure) {
      if (currentContext(context, controller.signal) && isCurrent()) {
        setCatalogAvailability("failed");
        reportFailure(failure, () => loadSkinPage(query, append), context, "catalog");
      }
    } finally {
      if (currentContext(context, controller.signal) && isCurrent()) setLoadingCatalog(false);
      finishRequest(controller);
    }
  }, [currentContext, gameId, reportFailure, waitForIdentity]);

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
        if (nextOptions.pricingSchema === "haff-ratio-v2") {
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
    void loadOptions(gameId);
    void loadSkinPage({}, false);
  }, [gameId, identityState, loadOptions, loadSkinPage]);

  // The fast entry explicitly converts the working declaration to fast. It never
  // silently rewrites a saved or published version while the form is read-only.
  useEffect(() => {
    if (!fastLocked || !editing || writeIntent) return;
    if (optionsAvailability !== "ready" || options?.pricingSchema !== "haff-ratio-v2") return;
    if (options.rentalModes?.fast && !options.rentalModes.fast.enabled) return;
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
      setAccountId(id);
      const params = new URLSearchParams();
      if (mode === "fast") params.set("mode", "fast");
      const canonicalGame = games.find((game) => game.id === context.gameId)?.code ?? gameCodeProp;
      if (canonicalGame) params.set("game", canonicalGame);
      params.set("accountId", id);
      router.replace(`/publish?${params.toString()}`);
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

  const pricingSelection = (): { rentalMode: RentalMode; ownerRatioB?: string } | null => {
    const saved = rentalPricingOf(draftRef.current.attributes);
    const selectedMode = fastLocked ? "fast" : (saved?.rentalMode ?? "ordinary");
    return buildRentalPricing(selectedMode, String(saved?.ownerRatioB ?? ""));
  };

  const pricingProblem = (): { group: PublishGroupId; message: string } | null => {
    if (optionsAvailability !== "ready") return null;
    if (options?.pricingSchema !== "haff-ratio-v2") {
      if (fastLocked) return { group: "terms", message: "当前规则未开放极速比例合同，不能以极速入口上架；请改用普通出租。" };
      return null;
    }
    const modes = options.rentalModes;
    if (fastLocked && modes?.fast && !modes.fast.enabled) {
      return { group: "terms", message: "当前规则未启用极速比例，不能以极速入口上架；请改用普通出租。" };
    }
    const saved = rentalPricingOf(draftRef.current.attributes);
    const selectedMode = fastLocked ? "fast" : (saved?.rentalMode ?? "ordinary");
    if (selectedMode !== "ordinary" && modes?.[selectedMode] && !modes[selectedMode]!.enabled) {
      return { group: "terms", message: `${rentalModeLabel(selectedMode)}当前未启用，请切换比例类型。` };
    }
    if (selectedMode !== "ordinary" && !buildRentalPricing(selectedMode, String(saved?.ownerRatioB ?? "")))
      return { group: "terms", message: `请填写合法的${rentalModeLabel(selectedMode)}数值，或切换为普通比例。` };
    return null;
  };

  const depositProblem = (): { group: PublishGroupId; message: string } | null => {
    if (depositInput.trim() === "") return null;
    if (yuanToCents(depositInput) === null) return { group: "terms", message: "租客押金请填写不超过两位小数的金额。" };
    return null;
  };

  const haffProblem = (): { group: PublishGroupId; message: string } | null => {
    if (haffInput.trim() === "") return null;
    if (baseFromHaffM(haffInput) === null) return { group: "terms", message: "哈夫币请按 M 填写，最多 6 位小数。" };
    return null;
  };

  const quantityProblem = (): { group: PublishGroupId; message: string } | null => {
    const invalidRow = draftRef.current.inventory.find((row) => row.quantity !== null && !/^(0|[1-9]\d{0,23})$/.test(row.quantity));
    if (invalidRow) return { group: "assets", message: "库存数量请填写非负整数；留空表示尚未申报。" };
    const level = draftRef.current.attributes.character_level;
    if (level !== null && level !== undefined && (!Number.isSafeInteger(level) || Number(level) < 0 || Number(level) > 60)) return { group: "account", message: "账号等级请填写 0–60 的整数；历史原值请核对后更新。" };
    if(Object.values(pendingResourceInputs).some(value=>value!==""))return {group:"assets",message:"新增资源数量已保留在本页，目录配置完成后才能保存或核价。"};
    return null;
  };
  const kdProblem = (): { group: PublishGroupId; message: string } | null => {
    const raw = draftRef.current.attributes.secret_kd;
    if (raw === null || raw === undefined || raw === "") return null;
    const text = String(raw);
    return /^\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text)) && Number(text) <= 100
      ? null : { group: "account", message: "绝密KD请填写0–100的数字，可用小数；请核对原输入。" };
  };

  const prepareDraftRequest = async (context: RequestContext, retryBusy: string, retryAfterReady?: () => Promise<void>): Promise<DraftRequest | null> => {
    const problem = kdProblem() ?? quantityProblem() ?? haffProblem() ?? depositProblem() ?? pricingProblem();
    if (problem) { locate(problem.group, problem.message); return null; }
    const controller = beginRequest();
    try {
      const ready = await ensureReady(context, controller.signal, retryBusy, retryAfterReady);
      const id = accountRef.current;
      if (!ready || !id || !currentContext(context, controller.signal)) return null;
      const source = draftRef.current;
      const attributes: DraftInput["attributes"] = { ...source.attributes };
      let pricingOptionCode = source.pricingOptionCode;
      if (options?.pricingSchema === "haff-ratio-v2") {
        const selection = pricingSelection();
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

  const sendQuoteRequest = async (context: RequestContext, saved: MySupply, retryBusy: string): Promise<void> => {
    const id = saved.account.id;
    const body = { expectedRevision: saved.account.revision };
    const keyBody = { accountId: id, ...body };
    const frozen = freezeRequest(body, keyFor("quote", keyBody));
    if (!(await waitForIdentity({ ...context, accountId: id }))) return;
    const controller = beginRequest();
    try {
      const quoted = await writePersisted("quote", { ...context, accountId: id }, frozen.body, frozen.key, () => supplyApi.quote(id, frozen.body.expectedRevision, frozen.key, controller.signal));
      if (!currentContext({ ...context, accountId: id }, controller.signal)) return;
      completeKey("quote", keyBody);
      applySupply(quoted, true);
      setAgreementChecked(false);
      setRulesAccepted(false);
      setDraftDirty(false);
      setWritePending(null);
      setNotice("报价已更新，请核对预计租期、金额与权益有效期说明。");
    } catch (failure) {
      if (!isAbort(failure) && uncertainSupplyWriteFailure(failure) && currentContext({ ...context, accountId: id }, controller.signal)) rememberWrite({ action: retryBusy, context: { ...context, accountId: id }, run: () => sendQuoteRequest(context, saved, retryBusy) });
      throw failure;
    } finally {
      finishRequest(controller);
    }
  };

  const runQuoteAfterSave = async (request: DraftRequest, retryBusy: string): Promise<void> => {
    const saved = await sendDraftRequest(request, retryBusy, () => runQuoteAfterSave(request, retryBusy));
    if (saved && currentContext({ ...request.context, accountId: request.accountId })) await sendQuoteRequest(request.context, saved, retryBusy);
  };

  const firstFocusable = (group: PublishGroupId): HTMLElement | null => {
    const section = formRef.current?.querySelector<HTMLElement>(`[data-publish-group="${group}"]`);
    if (!section) return null;
    return section.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')
      ?? section.querySelector<HTMLElement>('[data-first-field]:not([disabled])')
      ?? section.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
  };

  const locate = (group: PublishGroupId, message: string) => {
    setNotice(message);
    setError(null);
    requestAnimationFrame(() => {
      const node = firstFocusable(group);
      node?.scrollIntoView({ block: "center" });
      node?.focus({ preventScroll: true });
    });
  };

  const quoteProblem = (): { group: PublishGroupId; message: string } | null => {
    const quantities = quantityProblem();
    if (quantities) return quantities;
    if (!gameId) return { group: "account", message: "请先选择游戏。" };
    if (optionsAvailability === "pending") return { group: "terms", message: "正在读取当前出租规则，请稍候再核对报价。" };
    if (optionsAvailability === "unavailable") return { group: "terms", message: "该游戏当前没有生效的出租规则，暂不能核价；可先保存草稿。" };
    if (optionsAvailability === "failed") return { group: "terms", message: "出租规则读取失败，请重试读取后再核价。" };
    if (catalogAvailability === "pending") return { group: "assets", message: "发布目录正在读取，请稍候再核对报价。" };
    if (catalogAvailability === "failed") return { group: "assets", message: "发布目录读取失败，请重试后再核价。" };
    const missing = (catalog?.items ?? []).filter((item) => item.required && !draftRef.current.inventory.some((row) => row.itemId === item.id && row.quantity !== null));
    if (missing.length) return { group: "assets", message: `请先填写必填资源数量：${missing.map((item) => item.name).join("、")}。` };
    if (!draftRef.current.termOptionCode) return { group: "terms", message: "请选择每日消耗档位。" };
    const pricing = pricingProblem();
    if (pricing) return pricing;
    if (options?.pricingSchema !== "haff-ratio-v2" && !draftRef.current.pricingOptionCode) return { group: "terms", message: "请选择计价方案。" };
    return haffProblem() ?? depositProblem();
  };

  const saveWithContext = async (context: RequestContext): Promise<void> => {
    const request = await prepareDraftRequest(context, "save", () => saveWithContext(context));
    if (request) await runSaveRequest(request, "save");
  };

  const save = async () => {
    const problem = quantityProblem() ?? haffProblem() ?? pricingProblem() ?? depositProblem();
    if (problem) { locate(problem.group, problem.message); return; }
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

  const quoteWithContext = async (context: RequestContext): Promise<void> => {
    const request = await prepareDraftRequest(context, "quote", () => quoteWithContext(context));
    if (request) await runQuoteAfterSave(request, "quote");
  };

  const quote = async () => {
    const problem = quoteProblem();
    if (problem) { locate(problem.group, problem.message); return; }
    const context = captureContext();
    setBusy("quote");
    setError(null);
    try {
      await quoteWithContext(context);
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
    body: { expectedRevision: string; versionId: string; releaseId: string; contentHash: string },
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
    if (!agreementChecked) {
      locate("terms", "请先勾选确认已阅读本次条款。");
      return;
    }
    const currentToken = token();
    if (!currentToken) {
      locate("terms", "当前报价已失效，请重新核对报价。");
      return;
    }
    setBusy("accept");
    setError(null);
    const context = captureContext(currentToken.id);
    const body = { expectedRevision: currentToken.expectedRevision, versionId: currentToken.versionId, releaseId: currentToken.releaseId, contentHash: currentToken.contentHash };
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
        setNotice("条款已确认，但报价已变化；请重新核对报价后再上架。");
        return;
      }
      const submitBody = { expectedRevision: submitToken.expectedRevision, versionId: submitToken.versionId, releaseId: submitToken.releaseId, contentHash: submitToken.contentHash };
      const submitFrozen = freezeRequest(submitBody, keyFor("submit", { accountId: submitToken.id, ...submitBody }));
      await sendConfirmRequest("submit", { ...context, accountId: submitToken.id }, submitFrozen.body, submitFrozen.key, "submit", (submitted) => {
        applySupply(submitted, false);
        setDraftDirty(false);
        setEditing(false);
        setNotice("资料已直接上架；展示图已完成技术校验，私有凭证仅内部可见。");
      });
    } catch (failure) {
      reportWriteFailure(failure, context);
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };

  const changeAttribute = (key: string, value: string | number | boolean | null) => {
    setDraft((previous) => ({ ...previous, attributes: { ...previous.attributes, [key]: value } }));
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
    const next = raw;
    setHaffInput(next);
    const base = baseFromHaffM(next);
    if (next.trim() === "") changeInventory(itemId, "");
    else if (base !== null) changeInventory(itemId, base);
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
    setDraft((previous) => {
      const saved = rentalPricingOf(previous.attributes);
      const keep = saved?.ownerRatioB;
      return {
        ...previous,
        attributes: {
          ...previous.attributes,
          rentalPricing: next === "ordinary" ? { rentalMode: next } : { rentalMode: next, ...(keep ? { ownerRatioB: keep } : {}) },
        },
      };
    });
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

  const recommendDeposit = async () => {
    const problem = pricingProblem();
    if (problem) { locate(problem.group, problem.message); return; }
    const context = captureContext();
    setRecommendationBusy(true);
    setError(null);
    try {
      let currentSupply = supplyRef.current;
      const needsSave = draftDirty || !currentSupply?.version || currentSupply.version.reviewState !== "DRAFT";
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
        const mismatch = result.accountId !== requestBinding.accountId ||
          result.accountRevision !== requestBinding.accountRevision ||
          result.versionId !== requestBinding.versionId ||
          result.versionRevision !== requestBinding.versionRevision ||
          result.ruleReleaseId !== requestBinding.ruleReleaseId ||
          !inputsEqual(result.inputs, requestBinding.inputs);
        setRecommendation(result);
        setRecommendationBinding({ ...requestBinding, mismatch });
        setRecommendationAdopted(false);
        setNotice(mismatch
          ? "推荐结果与当前账号、版本或规则不匹配，已标记过期；请重新查看推荐押金。"
          : `推荐押金 ${yuanFromCents(result.amountCents) ?? "0.00"} 元，依据当前版本资料计算；点击“采用推荐”才会填入申报。`);
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

  const recommendationFresh = Boolean(
    recommendation?.available &&
    recommendationBinding &&
    !recommendationBinding.mismatch &&
    !draftDirty &&
    supply?.account.id === recommendationBinding.accountId &&
    supply?.account.revision === recommendationBinding.accountRevision &&
    supply?.version?.id === recommendationBinding.versionId &&
    (supply?.version?.revision ?? "") === recommendationBinding.versionRevision &&
    (options?.releaseId ?? supply?.version?.releaseId ?? "") === recommendationBinding.ruleReleaseId &&
    inputsEqual(currentRecommendationInputs(), recommendationBinding.inputs),
  );

  const adoptRecommendation = () => {
    const current = recommendation;
    if (!current || !current.available || !recommendationFresh) {
      setNotice("推荐已过期或不可用，请重新查看推荐押金。");
      return;
    }
    changeDeposit(yuanFromCents(current.amountCents) ?? "");
    setRecommendation(current);
    setRecommendationAdopted(true);
    setNotice("已按推荐填入押金申报；可继续修改，核价与条款需重新确认。");
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
      const result = await writePersisted("media", { ...context, accountId: id }, { purpose: entry.purpose, category: entry.category ?? "SHOWCASE", mime: entry.file.type, size: entry.file.size, uploadKey: entry.uploadKey }, entry.intentKey, () => uploadSupplyMedia({ gameId: context.gameId, accountId: id, purpose: entry.purpose, file: entry.file!, intentKey: entry.intentKey, uploadKey: entry.uploadKey, signal: controller.signal, beforeBytesUpload: () => waitForIdentity(context) }));
      if (!currentContext(context, controller.signal)) return;
      if (!result) return;
      setWritePending(null);
      if (cancelledMedia.current.has(entry.id)) return;
      setMedia((previous) => previous.map((item) => item.id === entry.id ? { ...item, assetId: result.assetId, reviewState: result.reviewState, bindingSaved: false, status: "bound", error: undefined } : item));
      setDraft((previous) => previous.mediaBindings.some((binding) => binding.assetId === result.assetId)
        ? previous
        : { ...previous, mediaBindings: [...previous.mediaBindings, { assetId: result.assetId, position: nextMediaPosition(previous.mediaBindings), ...(entry.category ? { category: entry.category } : {}) }] });
      setNotice(`${entry.category === "PENALTY" ? "封禁与处罚公示图" : "账号展示图"}已上传到当前资料，保存草稿后才会正式绑定；当前状态：${mediaReviewLabel(result.reviewState)}。`);
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
    for (const file of files) {
      const entryId = newKey();
      cancelledMedia.current.delete(entryId);
      const hint = mediaUploadFailureHint(file);
      const entry: MediaEntry = { id: entryId, purpose: "ACCOUNT_DISPLAY", category, file, status: "failed", error: hint ?? undefined, intentKey: newKey(), uploadKey: newKey(), bindingSaved: false, context, previewUrl: hint ? undefined : URL.createObjectURL(file) };
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
    setNotice("图片已从本次发布资料移除；已上传对象不会被删除，重新保存后按新声明校验。");
  };

  const moveMedia = (entryId: string, delta: -1 | 1) => {
    if (busy || readOnly) return;
    const index = media.findIndex((item) => item.id === entryId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= media.length) return;
    const next = [...media];
    [next[index], next[target]] = [next[target]!, next[index]!];
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
    setSkinNames({});
    skinQueryRef.current = { gameId: "", key: "" };
    const code = games.find((game) => game.id === nextGameId)?.code;
    const params = new URLSearchParams();
    if (mode === "fast") params.set("mode", "fast");
    if (code) params.set("game", code);
    router.replace(params.size ? `/publish?${params.toString()}` : "/publish");
    } });
  };

  const beginEditingWithContext = async (context: RequestContext): Promise<void> => {
    const controller = beginRequest();
    try {
      await ensureReady(context, controller.signal, "edit", () => beginEditingWithContext(context));
      if (currentContext(context)) {
        setEditing(true);
        setNotice("已创建可编辑草稿；提交前可继续修改资料。");
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
      const offset = Math.ceil(header?.getBoundingClientRect().height ?? 96) + 12;
      rail.closest<HTMLElement>(".functional-shell--editor")?.style.setProperty("--publish-header-offset", `${offset}px`);
      const twoColumns = getComputedStyle(rail.parentElement ?? rail).gridTemplateColumns.trim().split(/\s+/).length > 1;
      rail.dataset.sticky = twoColumns && rail.getBoundingClientRect().height <= window.innerHeight - offset - 16 ? "true" : "false";
    };
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    if (header) observer.observe(header);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [identityState, gameId]);

  const previewInventoryKey=JSON.stringify(draft.inventory.filter(row=>(catalog?.items.find(item=>item.id===row.itemId)?.unit??supply?.version?.catalogItems?.find(item=>item.id===row.itemId)?.unit)!=="HAFF_BASE"));
  useEffect(()=>{
    setResourcePreview(null);
    setResourcePreviewPending(false);
    if(identityState!=="confirmed"||!identityRef.current||authRequired||!gameId||!catalog?.game.currentReleaseId||writeIntent)return;
    const context=captureContext(),controller=beginRequest();
    setResourcePreviewPending(true);
    const timer=setTimeout(()=>{void supplyApi.resourceIncomePreview(gameId,JSON.parse(previewInventoryKey),{catalogRevision:catalog.game.catalogRevision,releaseId:catalog.game.currentReleaseId!},controller.signal).then(result=>{
      if(!currentContext(context,controller.signal))return;
      if(result.available&&(result.binding.gameId!==gameId||result.binding.catalogRevision!==catalog.game.catalogRevision||result.binding.releaseId!==catalog.game.currentReleaseId))return;
      setResourcePreview(result);
    }).catch(failure=>{
      if(!currentContext(context,controller.signal)||isAbort(failure))return;
      setResourcePreview({available:false,reason:"PREVIEW_UNAVAILABLE"});
      if(failure instanceof SupplyRequestError&&failure.status===401)reportFailure(failure,undefined,context);
    }).finally(()=>{if(currentContext(context,controller.signal))setResourcePreviewPending(false);finishRequest(controller);});},180);
    return()=>{clearTimeout(timer);controller.abort();finishRequest(controller);};
    // The read depends on inventory and the immutable price/catalog binding, not account copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[gameId,identityState,authRequired,catalog?.game.catalogRevision,catalog?.game.currentReleaseId,previewInventoryKey,writeIntent]);

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
  const navigationDialog = <AlertDialog.Root open={navigationIntent !== null} onOpenChange={next => { if (!next) cancelNavigation(); }}>
    <AlertDialog.Portal><AlertDialog.Backdrop className="modal-overlay publish-dialog-backdrop" />
      <AlertDialog.Popup className="publish-dialog publish-leave-dialog" data-slot="alert-dialog-content" finalFocus={() => navigationFocusRef.current?.isConnected ? navigationFocusRef.current : true}>
        <AlertDialog.Title>{busy ? "当前操作尚未完成" : writePending ? "先确认上次操作结果" : "保留当前修改？"}</AlertDialog.Title>
        <AlertDialog.Description>{busy ? "请等待当前操作完成，再离开本页。" : writePending ? "上次操作结果仍待确认，请先通过原操作核对结果，再离开本页。" : navigationIntent?.message}</AlertDialog.Description>
        <div className="publish-dialog-actions"><AlertDialog.Close className="button secondary">{writePending || busy ? "留在此页" : "继续填写"}</AlertDialog.Close><button type="button" className="button primary" disabled={writePending || Boolean(busy)} onClick={leaveConfirmed}>{navigationIntent?.label ?? "离开页面"}</button></div>
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
    topContent: navigationDialog,
    backHref: accountIdProp ? `/account?view=accounts&accountId=${encodeURIComponent(accountIdProp)}` : "/accounts",
    backLabel: accountIdProp ? "返回账号管理" : "返回账号列表",
    searchLabel: "在公开账号目录中搜索",
    searchPlaceholder: "搜索账号编号或名称",
    onSearch: (value: string) => requestNavigation({ message: "本页还有未保存的资料。离开后，这些修改不会保留。", label: "放弃修改并离开", run: () => router.push(`/accounts?q=${encodeURIComponent(value)}`) }),
  };

  if (identityState === "checking") return <ServiceShell {...publishShell} title="上架出租" description="填写公开账号资料与出租条件；价格、规则和资格以本次核价结果为准。"><PublishVisualBanner /><section className="account-guest" aria-busy="true"><LockKeyhole size={30} /><h2>正在确认登录身份</h2><p>确认期间暂不展示私人发布资料，也不会继续发送保存、核价或上传请求。</p></section></ServiceShell>;
  if (identityState === "failed") return <ServiceShell {...publishShell} title="上架出租" description="填写公开账号资料与出租条件；价格、规则和资格以本次核价结果为准。"><PublishVisualBanner /><section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>暂时无法确认登录身份</h2><p>私人发布资料仍保留在本页，确认恢复后可继续；当前不会发送新的保存、核价或上传请求。</p><button type="button" className="button secondary" onClick={() => void sharedSession.confirm()}>重试身份确认</button></section></ServiceShell>;
  if (identityState === "confirmed" && authRequired && identityRef.current) return <ServiceShell {...publishShell} title="上架出租" description="填写公开账号资料与出租条件；价格、规则和资格以本次核价结果为准。"><PublishVisualBanner /><section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>登录状态已失效</h2><p>私有发布资料已暂停展示；原写回执与待重试步骤仍然保留。重新确认同一登录身份后可继续。</p><button type="button" className="button secondary" onClick={() => void sharedSession.confirm()}>重新确认身份</button></section></ServiceShell>;
  if (!accountIdProp && gamesLoaded && games.length === 0) return <ServiceShell {...publishShell} title="上架出租" description="填写账号资料并提交上架。"><PublishVisualBanner /><section className="account-guest"><h2>暂未开放上架</h2><p>目前没有开放出租的游戏，请稍后再来。</p><Link className="button secondary" href="/">返回首页</Link></section></ServiceShell>;

  const blockers = [...(catalog?.blockers ?? []).map((item) => item.code), ...(supply?.blockers ?? [])];
  const quoteData = supply?.version?.quote ?? null;
  const breakdown = ownerQuoteBreakdown(quoteData);
  const agreement = supply?.agreement ?? options?.agreement ?? null;
  const readOnly = Boolean(accountId && !editing);
  const published = supply?.version?.reviewState === "PUBLISHED";
  const formDisabled = identityState !== "confirmed" || !identityRef.current || readOnly || Boolean(busy) || writePending || Boolean(intentStorageIssue);
  const reviewState = supply?.version?.reviewState;
  const safeBoxOptions = options?.safeBoxOptions ?? [];
  const gradingOptions = options?.gradingOptions ?? [];
  const loginMethodOptions = options?.loginMethodOptions ?? [];
  const currentGrading = String(draft.attributes.grading_code ?? "");
  const currentLoginMethod = String(draft.attributes.login_method_code ?? "");
  const currentSafeBox = String(draft.attributes.safe_box_code ?? "");
  const currentVitality = draft.attributes.vit_level === null || draft.attributes.vit_level === undefined ? "" : String(draft.attributes.vit_level);
  const currentBear = draft.attributes.bear_level === null || draft.attributes.bear_level === undefined ? "" : String(draft.attributes.bear_level);
  const safeBoxKnown = currentSafeBox !== "" && (options?.safeBoxCodes ?? []).includes(currentSafeBox);
  const safeBoxDisplay = supply?.version?.attributeDisplay?.safeBox;
  const retainedSafeBoxLabel = safeBoxDisplay?.code === currentSafeBox && safeBoxDisplay.displayName
    ? safeBoxDisplay.displayName
    : `未确认（代码 ${currentSafeBox}）`;
  const safeBoxChoiceOptions = [
    ...(currentSafeBox && !safeBoxKnown ? [{ value: currentSafeBox, label: retainedSafeBoxLabel }] : []),
    ...(options?.safeBoxCodes.map((code) => ({
      value: code,
      label: safeBoxOptions.find((option) => option.code === code)?.displayName ?? `未确认（代码 ${code}）`,
    })) ?? []),
  ];
  const loginChoiceOptions = [
    ...(currentLoginMethod && !loginMethodOptions.some((option) => option.code === currentLoginMethod)
      ? [{ value: currentLoginMethod, label: `未确认（代码 ${currentLoginMethod}）` }]
      : []),
    ...(loginMethodOptions.map((option) => ({ value: option.code, label: option.displayName ?? `未确认（代码 ${option.code}）`, icon: <LoginPlatformIcon code={option.code} /> }))),
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
  const inventoryRows = allInventoryRows.filter((item) => item !== haffInventoryRow).map(item=>({...item,code:catalog?.items.find(row=>row.id===item.itemId)?.code??supply?.version?.catalogItems?.find(row=>row.id===item.itemId)?.code??null}));
  const missingResourceRows=catalog?[{code:"df_billable_barrett_bullet",name:"巴雷特子弹",unit:"ROUND"},{code:"top_insure_card_piece",name:"顶级保险卡",unit:"PIECE"}].filter(item=>!catalog.items.some(row=>canonicalResourceCode(row.code)===canonicalResourceCode(item.code))).map(item=>({...item,itemId:null,quantity:pendingResourceInputs[item.code]??null,priced:null,required:false,catalogState:"pending" as const})):[];
  const resourceOrder = ["df_billable_level6_bullet", "df_billable_level6_armor", "df_billable_level6_helmet", "df_billable_awm_bullet", "df_billable_barrett_bullet", "top_insure_card_piece", "df_billable_coffee"];
  const resourcePosition = (code: string | null) => { const index = resourceOrder.indexOf(canonicalResourceCode(code) ?? ""); return index < 0 ? resourceOrder.length : index; };
  const resourceRows=[...inventoryRows,...missingResourceRows].sort((a,b)=>resourcePosition(a.code)-resourcePosition(b.code));
  const rarityNames = new Map((catalog?.rarities ?? []).map((item) => [item.code, item.name]));
  const savedSkinNames = new Map((supply?.version?.presentation?.skins ?? []).map((skin) => [skin.id, skin.name]));
  const skinName = (id: string) => skinNames[id] ?? savedSkinNames.get(id) ?? "目录名称待加载";
  const activeSkinCategory = skinCategory || catalog?.categories[0]?.id || "";
  const visibleSkinRows = (catalog?.skins ?? []).filter((skin) => !activeSkinCategory || skin.categoryId === activeSkinCategory);
  const showPricingSelect = options?.pricingSchema !== "haff-ratio-v2";
  const disabledPricing = formDisabled || !options;
  const rentalModes = options?.rentalModes;
  const rentalModeEntries: RentalMode[] = (["ordinary", "custom", "fast"] as const).filter((entry) => rentalModes ? rentalModes[entry]?.enabled : true);
  const modeRange = ratioRangeText(rentalModes?.[rentalMode]);
  const visibleBlockers = [...new Set(blockers)].filter((code) => code !== "PUBLICATION_REQUIRED" && code !== "CONFIRMATION_OR_MEDIA_REQUIRED");
  const serviceWindowStart = typeof draft.attributes.service_window_start_minute === "number" ? draft.attributes.service_window_start_minute : null;
  const serviceWindowEnd = typeof draft.attributes.service_window_end_minute === "number" ? draft.attributes.service_window_end_minute : null;
  const serviceWindowAllDay = serviceWindowStart === 0 && serviceWindowEnd === 1440 && draft.attributes.service_window_cross_midnight === false;
  const serviceWindowMode = serviceWindowAllDay ? "allDay" : serviceWindowCustomSelected || serviceWindowStart !== null || serviceWindowEnd !== null ? "window" : null;
  const serviceWindowEqual = serviceWindowStart !== null && serviceWindowEnd !== null && serviceWindowStart === serviceWindowEnd && !serviceWindowAllDay;
  const serviceWindowHasLegacyValue = (serviceWindowStart !== null && !SERVICE_WINDOW_START_OPTIONS.includes(serviceWindowStart)) || (serviceWindowEnd !== null && !SERVICE_WINDOW_END_OPTIONS.includes(serviceWindowEnd));
  const payoutSelected = fullPayoutSelected(draft.attributes);
  const hasBanRecord = draft.attributes.ban_record === true;
  const retainedPenaltyCount = media.filter(item => item.category === "PENALTY" || item.purpose === "ACCOUNT_EVIDENCE").length;

  const errorGroups = new Set(fieldErrors.map((item) => publishGroupForPath(item.path)));
  const effectiveQuote = quoteData && !quoteStale ? quoteData : null;
  const quotedHaffRatio = effectiveQuote?.ownerHaffRatio;
  const declaredDepositCents = yuanToCents(depositInput);
  const actualPublisherRequirement = centsOfMoney(effectiveQuote?.publisherBailRequirement);
  const quoteConsistent = !effectiveQuote || Boolean(breakdown);
  const quoteProblemState = quoteProblem();
  const quoteStatus = busy === "quote"
    ? "processing"
    : writePending
      ? "unknown"
      : error?.status === 409
        ? "expired"
      : error || optionsAvailability === "failed" || catalogAvailability === "failed"
        ? "failed"
        : effectiveQuote
      ? quoteConsistent ? "ready" : "failed"
      : quoteStale
        ? "expired"
        : optionsAvailability === "pending" || catalogAvailability === "pending"
          ? "loading"
          : optionsAvailability === "unavailable"
            ? "unavailable"
          : quoteProblemState
            ? "needs"
            : "idle";
  const quoteStatusTitle = ({ idle: "尚未核价", needs: "待补全资料", loading:"正在读取规则", unavailable:"暂不能核价", unknown:"操作结果待确认", processing: "正在核价", ready: "报价已取得", expired: "报价已过期", failed: "核价未完成" } as Record<string, string>)[quoteStatus];
  const quoteStatusCopy = ({ idle: "完成左侧条件后，点击按钮获取本次规则报价。", needs: quoteProblemState?.message ?? "请先处理左侧必填条件。", loading:"读取完成后可核对报价。", unavailable:"当前出租规则尚未开放，可先保存草稿。", unknown:"请通过原操作核对结果后再继续。", processing: "正在读取当前规则并生成本次报价。", ready: "请阅读本次条款，确认后再提交上架。", expired: "资料或规则已变化，请重新核对报价。", failed: quoteProblemState?.message ?? "当前报价不可确认，请处理问题后重试。" } as Record<string, string>)[quoteStatus];
  const mediaStatusText = (item: MediaEntry) => item.status === "uploading"
    ? "上传中…"
    : item.status === "failed"
      ? item.error ?? "上传未完成"
      : item.reviewState
        ? `${item.bindingSaved ? "已保存" : "已上传，待保存"} · ${mediaReviewLabel(item.reviewState)}${item.publiclyReadable ? " · 当前公开展示" : item.publicDisplayEligible ? " · 图片可展示，账号尚未公开" : ""}`
        : item.bindingSaved ? "已保存，状态待核" : "已上传，待保存；状态待核";

  const primaryLabel = effectiveQuote ? "确认上架" : busy === "quote" ? "核对中…" : "核对报价";
  const primaryDisabled = readOnly || Boolean(busy) || writePending || Boolean(intentStorageIssue) || identityState !== "confirmed" || !identityRef.current || (effectiveQuote ? !agreementChecked || !quoteConsistent : false);
  const primaryAction = () => {
    if (primaryDisabled) return;
    if (effectiveQuote) void confirmPublish();
    else void quote();
  };
  const resourcePreviewState = resourcePreviewPending ? "正在读取资源单价…"
    : resourcePreview?.available ? null
    : resourcePreview?.reason === "PREVIEW_UNAVAILABLE" ? "暂未取得资源单价，预估金额尚不可用。已填数量会保留，实际金额需核价确认。"
    : "当前资源价目尚不可用。可继续填写数量，配置齐备后再核对报价。";
  const resourceTotalText = effectiveQuote && breakdown ? `${centsText(breakdown.itemCents)} 元`
    : Object.values(pendingResourceInputs).some(value => value !== "") ? "待资源配置"
    : resourcePreviewPending ? "读取中…"
    : resourcePreview?.available && resourcePreview.ownerTotal ? `${resourcePreview.ownerTotal.amount} 元`
    : resourcePreview?.available ? "填写数量后显示" : "预估暂不可用";
  const sectionActions = () => <div className="publish-section-actions"><a href="#publish-outline">返回分组</a><div><button type="button" className="button quiet" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button><a className="button secondary" href="#publish-quote">去核对报价</a></div></div>;
  const showTerms = () => {
    const terms = document.querySelector<HTMLDetailsElement>("#publish-payout-rules");
    if (!terms) return;
    terms.open = true;
    terms.scrollIntoView({ block: "center" });
    terms.querySelector("summary")?.focus({ preventScroll: true });
  };

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
    const title = isPenalty ? (canUpload ? "封禁记录截图" : "已保留的封禁截图") : "账号展示图";
    const desc = isPenalty ? (canUpload ? "请提供三角洲行动的封禁记录截图。" : "已有图片仍在本次资料中，可在这里查看或移除。") : "至少上传一张，第一张作为封面；可调整图片顺序。";
    return <div className="supply-media-panel" key={category}>
      <div className="supply-media-heading"><FileImage size={20} aria-hidden="true" /><div><h3>{title}</h3><p>{desc}</p></div>{rows.length ? <span className="publish-media-count">{rows.length} 张</span> : null}</div>
      {canUpload ? <label className="supply-upload-dropzone" data-disabled={formDisabled || !gameId ? "true" : "false"} onDragOver={(event) => event.preventDefault()} onDrop={(event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); acceptFiles(category, Array.from(event.dataTransfer.files)); }}>
        <Upload size={22} aria-hidden="true" /><span className="publish-upload-copy"><strong>选择图片或拖入此处</strong><span>PNG / JPEG / WebP · 单张 ≤ 10 MiB</span></span><span className="publish-upload-action" aria-hidden="true">选择图片</span>
        <input aria-label={isPenalty ? "上传封禁记录截图" : "上传账号展示图"} data-first-field={!isPenalty ? true : undefined} type="file" accept={MEDIA_ACCEPT_ATTRIBUTE} multiple disabled={formDisabled || !gameId} onChange={(event) => selectFiles(category, event)} />
      </label> : null}
      <div className="supply-media-list">{rows.map((item, index) => <div key={item.id} className="supply-media-row">
        <div className="supply-media-preview">
          {!isPenalty && index === 0 ? <span className="supply-media-badge-cover">封面</span> : null}
          {item.previewUrl ? <a href={item.previewUrl} target="_blank" rel="noreferrer" aria-label="预览图片"><img src={item.previewUrl} alt="" /></a> : <span className="supply-media-placeholder" aria-hidden="true"><FileImage size={16} /></span>}
        </div>
        <div className="supply-media-copy"><span>{item.file?.name ?? (isPenalty ? "处罚公示图" : "展示图")}</span><small>{mediaStatusText(item)}</small>{item.error && item.status === "failed" ? <small className="supply-field-error" role="alert">{item.error}</small> : null}</div>
        <div className="supply-media-actions">
          {item.status === "failed" && item.file && !mediaUploadFailureHint(item.file) ? <button type="button" className="button quiet" disabled={formDisabled} onClick={() => void upload(item)}>重试</button> : null}
          <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} aria-label="上移" onClick={() => moveMedia(item.id, -1)}><ArrowUp size={14} /></button>
          <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} aria-label="下移" onClick={() => moveMedia(item.id, 1)}><ArrowDown size={14} /></button>
          <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} onClick={() => removeMedia(item.id)}><Trash2 size={14} />移除</button>
        </div>
      </div>)}</div>
    </div>;
  };

  return <ServiceShell {...publishShell} title="上架出租">
    <PublishingNotice open={readingNotice} onClose={() => setReadingNotice(false)} agreement={agreement} />
    {intentStorageIssue ? <div className="supply-conflict" role="alert"><strong>暂不能提交新的操作</strong><p>{intentStorageIssue}</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => { restoredSubjectRef.current = null; setIntentRestoreVersion(value => value + 1); }}>重试恢复记录</button></div> : null}
    {authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>此操作需要登录并确认当前身份。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent(accountId ? `/publish?accountId=${accountId}` : "/publish")}`}>登录 / 注册</Link></div> : null}
    <Notice error={error} text={notice} />
    {error?.status === 409 && serverSnapshot ? <div className="supply-conflict" role="alert"><strong>资料状态已变化</strong><p>已保留本页输入，没有自动覆盖。当前资料状态为 {serverSnapshot.version ? stateLabel(serverSnapshot.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" onClick={() => void refreshLatest(false)}>重新读取最新状态</button><button type="button" className="button secondary" onClick={() => void refreshLatest(true)}>采用最新资料</button></div></div> : null}
    {writePending ? <div className="supply-conflict" role="alert"><strong>结果未知</strong><p>上次写入已发出但没有收到确认。重新读取只更新服务器展示，不会解除锁定；请重试当前步骤，收到与原请求对应的确定结果后才可继续修改或发起新写入。</p><div className="supply-inline-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void retryWrite()}>重试当前步骤</button><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void refreshLatest(true)}>重新读取最新状态</button></div></div> : null}
    {!writePending && error?.status === 0 && lastRetry.current ? <div className="supply-conflict"><strong>读取未完成</strong><p>本页没有自动重复操作，请重试本次读取。</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void retryLast()}>重试读取</button></div> : null}
    {!writePending && optionsAvailability === "failed" ? <div className="supply-blockers" role="alert"><strong>出租规则读取失败</strong><p>暂不能核对报价；可先保存草稿。</p><button type="button" className="button secondary" disabled={Boolean(busy) || !gameId} onClick={() => void loadOptions(gameId)}>重试读取规则</button></div> : null}
    {readOnly && !published ? <div className="supply-readonly" role="status"><strong>当前版本不可直接编辑</strong><span>已上架、审核中的历史版本或已退回版本会在你明确开始修改后创建新草稿。</span><button type="button" className="button secondary" disabled={identityState !== "confirmed" || !identityRef.current || Boolean(busy)} onClick={() => void beginEditing()}>{busy === "edit" ? "准备草稿中…" : "开始修改"}</button></div> : null}
    {loadingAccount ? <p className="supply-muted" role="status">正在读取账号资料…</p> : null}
    <PublishVisualBanner />
    <nav id="publish-outline" className="publish-outline" aria-label="填写分组">
      <div className="publish-outline-groups">{(Object.keys(groupMeta) as PublishGroupId[]).map(id => <a key={id} href={`#publish-group-${id}`}>{groupMeta[id].title}</a>)}</div>
      <div className="publish-outline-actions"><button type="button" className="button quiet" onClick={() => setReadingNotice(true)}><FileText size={16} aria-hidden="true" />上架须知</button><button type="button" className="button quiet publish-near-action" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button><a className="button secondary publish-near-action" href="#publish-quote">核对报价</a></div>
    </nav>

    <div className="publish-page-layout">
      <form ref={formRef} className="publish-column" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); primaryAction(); }} noValidate>
        <div className="publish-groups">
          <SectionCard id="account" title={groupMeta.account.title} hasError={errorGroups.has("account")} actions={sectionActions()}>
            <div className="publish-subgroup">
              <h3 className="publish-subgroup-title"><span className="publish-subgroup-icon" aria-hidden="true"><FileText size={16} /></span>账号能力</h3>
              <div className="supply-grid">
                {!accountId && games.length > 1 ? (
                  <label>游戏
                    <FormSelect label="游戏"
                      value={gameId}
                      disabled={Boolean(accountId) || formDisabled}
                      placeholder="选择游戏"
                      options={games.map((option) => ({ value: option.id, label: option.name }))}
                      onChange={(val) => selectGame(val)}
                    />
                    <small>仅显示已开放出租的游戏。</small>
                  </label>
                ) : null}
                <fieldset className="supply-radio-field publish-choice-field publish-safe-box-field"><legend><span className="publish-account-label">安全箱档位<FieldHelp label="安全箱档位">填写当前赛季永久安全箱的容量，不包含临时体验卡；体验卡数量在库存区填写。</FieldHelp></span></legend>
                  {safeBoxChoiceOptions.length ? <FormRadioGroup variant="segmented" name="safe_box_code" label="安全箱档位" error={fieldError("attributes.safe_box_code")} value={currentSafeBox} options={safeBoxChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("safe_box_code", value)} /> : <small className="publish-choice-empty">{options ? "当前规则未配置安全箱档位。" : "正在读取安全箱档位…"}</small>}
                </fieldset>
                <fieldset className="supply-radio-field publish-choice-field publish-level-field publish-vitality-field"><legend>体力等级</legend><FormRadioGroup variant="segmented" name="vit_level" label="体力等级" error={fieldError("attributes.vit_level")} value={currentVitality} options={vitalityChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("vit_level", Number(value))} />{vitalityChoiceNote ? <small className="publish-legacy-choice-note">{vitalityChoiceNote}</small> : null}</fieldset>
                <fieldset className="supply-radio-field publish-choice-field publish-level-field publish-bear-field"><legend>负重等级</legend><FormRadioGroup variant="segmented" name="bear_level" label="负重等级" error={fieldError("attributes.bear_level")} value={currentBear} options={bearChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("bear_level", Number(value))} />{bearChoiceNote ? <small className="publish-legacy-choice-note">{bearChoiceNote}</small> : null}</fieldset>
                <fieldset className="supply-radio-field publish-choice-field publish-level-field publish-dive-field"><legend>潜水等级</legend><FormRadioGroup variant="segmented" name="dive_level" label="潜水等级" error={fieldError("attributes.dive_level")} value={currentDive} options={diveChoiceOptions} disabled={formDisabled} onChange={(value) => changeAttribute("dive_level", Number(value))} />{diveChoiceNote ? <small className="publish-legacy-choice-note">{diveChoiceNote}</small> : null}</fieldset>
                <div className="publish-account-integer-field"><span className="publish-account-label">账号等级</span><IntegerStepper label="账号等级" value={String(draft.attributes.character_level??"")} max="60" disabled={formDisabled} onChange={raw=>changeAttribute("character_level",raw===""?null:Number(raw))} />{typeof draft.attributes.character_level==="number"&&draft.attributes.character_level>60?<small className="publish-legacy-choice-note">已保留历史{draft.attributes.character_level}级原值；请核对后填写0–60级。</small>:null}</div>
                <label><span className="publish-account-label">段位</span>
                  <FormSelect label="账号段位"
                    value={currentGrading}
                    disabled={formDisabled || !options}
                    placeholder="请选择段位"
                    options={[
                      { value: "", label: "未申报" },
                      ...(currentGrading && !gradingOptions.some((option) => option.code === currentGrading) ? [{ value: currentGrading, label: `未确认（代码 ${currentGrading}）` }] : []),
                      ...(gradingOptions.map((option) => ({ value: option.code, label: option.displayName ?? `未确认（代码 ${option.code}）` }))),
                    ]}
                    onChange={(val) => changeAttribute("grading_code", val || null)}
                  />
                </label>
                <label htmlFor="publish-secret-kd"><span className="publish-account-label">绝密KD<FieldHelp label="绝密KD">填写当前赛季绝密模式显示的KD，可填写小数，例如1.85。</FieldHelp></span><Input id="publish-secret-kd" aria-label="绝密KD" type="text" inputMode="decimal" maxLength={32} value={String(draft.attributes.secret_kd ?? "")} disabled={formDisabled} aria-invalid={Boolean(kdProblem())} onChange={(event) => changeAttribute("secret_kd", event.target.value === "" ? null : event.target.value)} placeholder="例如 1.85" /></label>
              </div>
            </div>
            <div className="publish-subgroup">
              <h3 className="publish-subgroup-title"><span className="publish-subgroup-icon" aria-hidden="true"><LogIn size={16} /></span>上号配合</h3>
              <div className="supply-grid">
                <fieldset className="supply-radio-field publish-choice-field publish-login-field"><legend><span className="publish-account-label">上号方式<FieldHelp label="上号方式">选择租客上号时，你可以配合的登录方式。</FieldHelp></span></legend>
                  {loginChoiceOptions.length ? <FormRadioGroup variant="segmented" name="login_method_code" label="上号方式" error={fieldError("attributes.login_method_code")} value={currentLoginMethod} options={loginChoiceOptions} disabled={formDisabled || !options} onChange={(value) => changeAttribute("login_method_code", value)} /> : <small className="publish-choice-empty">{options ? "当前规则未配置上号方式。" : "正在读取上号方式…"}</small>}
                </fieldset>
                <RegionPicker province={String(draft.attributes.region_province ?? "")} city={String(draft.attributes.region_city ?? "")} options={DELTA_REGION_OPTIONS} disabled={formDisabled} onChange={(province, city) => setDraft((previous) => ({ ...previous, attributes: { ...previous.attributes, region_province: province, region_city: city } }))} />
                <div className="supply-wide publish-service-window">
                  <span className="publish-account-label"><Clock3 size={16} aria-hidden="true" />可配合上号时间<span className="publish-timezone">北京时间</span><FieldHelp label="可配合上号时间">填写你能协助上号的时间。支持跨日时段，例如22:00至次日02:00。</FieldHelp></span>
                  <FormRadioGroup variant="segmented" className="publish-window-mode" name="service_window_mode" label="可配合上号时间" value={serviceWindowMode} options={[{value:"allDay",label:"全天可配合"},{value:"window",label:"按时段配合"}]} disabled={formDisabled} onChange={value => changeAllDay(value === "allDay")} />
                  {serviceWindowMode === "window" ? <span className="supply-time-range">
                    <FormSelect label="开始时间" value={serviceWindowStart === null ? "" : String(serviceWindowStart)} disabled={formDisabled} placeholder="开始时间" options={serviceTimeOptions(SERVICE_WINDOW_START_OPTIONS, serviceWindowStart)} onChange={(value) => changeServiceWindow("service_window_start_minute", value === "" ? "" : minutesToTimeValue(Number(value)))} />
                    <span aria-hidden="true" className="supply-time-separator">至</span>
                    <FormSelect label="结束时间" value={serviceWindowEnd === null ? "" : String(serviceWindowEnd)} disabled={formDisabled} placeholder="结束时间" options={serviceTimeOptions(SERVICE_WINDOW_END_OPTIONS, serviceWindowEnd)} onChange={(value) => changeServiceWindow("service_window_end_minute", value === "" ? "" : minutesToTimeValue(Number(value)))} />
                  </span> : serviceWindowAllDay ? <output className="publish-window-summary">全天可配合 · 00:00 至 24:00</output> : null}
                  {serviceWindowEqual ? <small className="supply-field-error" role="alert">开始和结束时间不能相同。</small> : null}
                  {serviceWindowMode === "window" && serviceWindowStart !== null && serviceWindowEnd !== null && !serviceWindowEqual ? <output className="publish-window-summary">可配合时间：{minutesToTimeValue(serviceWindowStart)} 至 {serviceWindowEnd < serviceWindowStart ? "次日 " : ""}{minutesToTimeValue(serviceWindowEnd)}</output> : null}
                  {serviceWindowHasLegacyValue ? <small className="publish-legacy-choice-note">已保留历史非 30 分钟原值；新选择仅支持每 30 分钟一个时间点。</small> : null}
                </div>
              </div>
            </div>
            <div className="publish-subgroup">
              <h3 className="publish-subgroup-title"><span className="publish-subgroup-icon" aria-hidden="true"><ShieldCheck size={16} /></span>账号情况</h3>
              <div className="supply-grid">
                <fieldset className="supply-radio-field"><legend>封禁记录</legend>
                  <div className="supply-radio-group">
                    <FormRadioGroup variant="segmented" name="ban_record" label="封禁记录" value={draft.attributes.ban_record as boolean | null} options={[{value:false,label:"无封禁记录"},{value:true,label:"有封禁记录"}]} disabled={formDisabled} onChange={value => changeAttribute("ban_record",value)} />
                  </div>
                </fieldset>
                <fieldset className="supply-radio-field"><legend><span className="publish-account-label">人脸归属<FieldHelp label="人脸归属">请选择账号人脸认证是否属于号主本人；该信息由号主申报。</FieldHelp></span></legend>
                  <div className="supply-radio-group">
                    <FormRadioGroup variant="segmented" name="face_is_self" label="人脸归属" value={draft.attributes.face_is_self as boolean | null} options={[{value:true,label:"号主本人"},{value:false,label:"非号主本人"}]} disabled={formDisabled} onChange={value => changeAttribute("face_is_self",value)} />
                  </div>
                </fieldset>
              </div>
            </div>
          </SectionCard>

          <SectionCard id="assets" title={groupMeta.assets.title} hasError={errorGroups.has("assets")} actions={sectionActions()}>
            <div className="supply-subsection">
              <div className="publish-assets-heading"><h3><Box size={20} aria-hidden="true" />库存数量</h3><FieldHelp label="库存数量">只统计可用于本次出租的资源。留空表示尚未申报，0表示明确没有；数量只支持整数。</FieldHelp></div>
              <p className="publish-resource-read-state">留空表示尚未申报，0表示明确没有。数量填整数；标注必填的项目需在核价前补齐，草稿可暂留空。</p>
              {resourcePreviewState ? <p className="publish-resource-read-state" role="status"><Info size={16} aria-hidden="true" />{resourcePreviewState}</p> : null}
              {resourceRows.length ? <div className="supply-resource-grid" role="list" aria-label="资源库存">{resourceRows.map((item) => {
                const itemCode=item.code, key=item.itemId??itemCode!;
                const itemName=canonicalResourceCode(itemCode)==="df_billable_coffee"?"咖啡豆":item.name;
                const quantity=draft.inventory.find(row=>row.itemId===item.itemId)?.quantity??item.quantity??"";
                const grouped=canonicalResourceCode(itemCode)==="df_billable_level6_bullet";
                const valid=/^(0|[1-9]\d{0,23})$/.test(quantity), remainder=grouped&&valid?BigInt(quantity)%60n:0n;
                const inputValue=grouped&&valid?(BigInt(quantity)/60n).toString():quantity;
                const inputUnit=grouped?"组":resourceUnitLabel(item.unit??"",itemCode);
                const line=item.itemId&&resourcePreview?.available&&!resourcePreviewPending?resourcePreview.lines.find(row=>row.itemId===item.itemId):null;
                const help=grouped?"六级子弹按组填写，每组60发；保存时只换算一次。":itemCode==="top_insure_card_piece"||itemCode==="df_billable_top_insure_card_piece"?"填写可用顶级临时体验卡的张数，永久安全箱容量不算体验卡。":null;
                return <article className="supply-resource-card" key={key} role="listitem" data-resource-code={itemCode??undefined}>
                  <div className="supply-resource-card-head">
                    <span className="supply-resource-art"><InventoryIcon code={itemCode} /></span>
                    <div className="supply-resource-name"><label htmlFor={`quantity-${key}`}>{itemName}</label>{help?<FieldHelp label={itemName}>{help}</FieldHelp>:null}</div>
                    {item.required?<span className="supply-resource-required">必填</span>:null}
                  </div>
                  <div className="publish-owner-rate"><span>单价</span><strong>{line?`¥ ${line.ownerUnitAmount.amount} / ${inputUnit}`:!item.itemId?"待配置":resourcePreviewPending?"读取中…":"暂未取得"}</strong>{line?<FieldHelp label={`${itemName}单价`}>按当前规则预估，实际收入以核价和结算为准。</FieldHelp>:null}</div>
                  {!item.itemId ? <small className="publish-resource-state">此项暂存本页。填写后需等待目录配置，整份资料才能保存或核价。</small> : null}
                  <IntegerStepper id={`quantity-${key}`} label={`${itemName}数量`} value={inputValue} unit={inputUnit} max={grouped?((999999999999999999999999n-remainder)/60n).toString():"999999999999999999999999"} disabled={formDisabled} invalid={quantity!==""&&!valid} onChange={raw=>{
                    const base=raw===""?"":grouped?(BigInt(raw)*60n+remainder).toString():raw;
                    if(item.itemId)changeInventory(item.itemId,base);else setPendingResourceInputs(previous=>({...previous,[itemCode!]:base}));
                  }} />
                  <div className="publish-resource-subtotal"><span>本项预估</span><output>{line?.ownerAmount?`¥ ${line.ownerAmount.amount}`:quantity===""?"未填写":!item.itemId?"待资源配置":resourcePreviewPending?"计算中…":"预估暂不可用"}</output></div>
                  {!item.itemId ? <small className="publish-resource-state">目录待配置 · 数量暂存本页</small> : null}
                  {grouped?<small className="publish-resource-measure">1组 = 60发{remainder>0n?` · 已保留历史余量${remainder}发`:""}</small>:null}
                  {quantity!==""&&!valid?<FieldError text="请填写非负整数，或留空。"/>:null}
                  {item.priced===false?<><small className="publish-resource-state">这份历史资源未进入当前价目。</small><button type="button" className="button quiet" disabled={formDisabled} onClick={()=>setDraft(previous=>({...previous,inventory:previous.inventory.filter(row=>row.itemId!==item.itemId)}))}>不纳入本次申报</button></>:null}
                </article>;
              })}</div>:null}
              {missingResourceRows.length?<p className="publish-resource-state">{missingResourceRows.map(item=>item.name).join("、")}的数量暂存本页，配置完成后可保存。</p>:null}
              <FieldError text={fieldError("inventory")} />
            </div>
            <div className="supply-subsection">
              <div className="publish-assets-heading"><h3><UserRound size={20} aria-hidden="true" />皮肤</h3><FieldHelp label="皮肤">按名称或分类查找，并勾选账号拥有的皮肤。</FieldHelp></div>
              <div className="skin-picker">
                <div className="skin-category-nav" role="group" aria-label="皮肤分类">
                  {catalog?.categories.map((category) => (
                    <button key={category.id} type="button" className={`skin-category-btn${activeSkinCategory === category.id ? " is-active" : ""}`} disabled={formDisabled} onClick={() => { setSkinCategory(category.id); void loadSkinPage({ q: skinQuery.trim(), categoryId: category.id, rarityCode: skinRarity }, false); }}>{category.name}</button>
                  ))}
                </div>
                <div className={`skin-search-row${catalog?.rarities.length ? "" : " skin-search-row--single"}`}>
                  <Input className="skin-search-input" aria-label="搜索皮肤名称" enterKeyHint="search" value={skinQuery} disabled={formDisabled} onChange={(event) => setSkinQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadSkinPage({ q: skinQuery.trim(), categoryId: activeSkinCategory, rarityCode: skinRarity }, false); } }} placeholder="搜索皮肤名称，回车查找" />
                  {catalog?.rarities.length ? <FormSelect label="皮肤稀有度"
                    value={skinRarity}
                    disabled={formDisabled}
                    placeholder="全部稀有度"
                    options={catalog.rarities.map((rarity) => ({ value: rarity.code, label: rarity.name }))}
                    onChange={(val) => {
                      setSkinRarity(val);
                      void loadSkinPage({ q: skinQuery.trim(), categoryId: activeSkinCategory, rarityCode: val }, false);
                    }}
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
                        <span key={id} className="supply-chip">
                          {skinName(id)}
                          <button type="button" className="supply-chip-remove" aria-label={`移除 ${skinName(id)}`} disabled={formDisabled} onClick={() => setDraft((previous) => ({ ...previous, skins: previous.skins.filter((skinId) => skinId !== id) }))}>
                            <Trash2 size={13} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="skin-choices-grid">
                  {visibleSkinRows.map((skin) => {
                    const isSelected = draft.skins.includes(skin.id);
                    return (
                      <label key={skin.id} className={`skin-card${isSelected ? " is-selected" : ""}`}>
                        <SkinCardMedia key={skin.mediaId ?? "missing"} mediaId={skin.mediaId} />
                        <div className="skin-card-copy">
                          <span className="skin-card-name" title={skin.name}>{skin.name}</span>
                          {skin.ownerName || skin.baseName ? <span className="skin-card-owner" title={[skin.ownerName, skin.baseName].filter(Boolean).join(" · ")}>{[skin.ownerName, skin.baseName].filter(Boolean).join(" · ")}</span> : <span className="skin-card-owner">所属对象待核</span>}
                          {skin.rarityCode ? <span className="skin-card-rarity">{rarityNames.get(skin.rarityCode) ?? "稀有度待核"}</span> : null}
                        </div>
                        <input type="checkbox" checked={isSelected} aria-label={`选择 ${skin.name}`} disabled={formDisabled} onChange={() => setDraft((previous) => ({
                          ...previous,
                          skins: isSelected ? previous.skins.filter((id) => id !== skin.id) : [...previous.skins, skin.id],
                        }))} />
                      </label>
                    );
                  })}
                  {catalog && visibleSkinRows.length === 0 ? <p className="supply-muted" style={{ gridColumn: "1 / -1", margin: "10px 0" }}>当前类别没有匹配的皮肤。</p> : null}
                </div>
                {catalog?.nextCursor ? <button type="button" className="button secondary" disabled={formDisabled || loadingCatalog} onClick={() => void loadSkinPage({ q: skinQuery.trim(), categoryId: activeSkinCategory, rarityCode: skinRarity, cursor: catalog.nextCursor ?? undefined }, true)}>{loadingCatalog ? "正在读取…" : "加载更多皮肤"}</button> : null}
              </div>
            </div>
            {catalog?.entitlements.length ? <div className="supply-subsection">
              <h3>权益及有效期</h3>
              <p className="supply-muted">定时权益必须填写到期时间；未知时保持“未知”，不默认永久有效。</p>
              <div className="supply-entitlement-list">{catalog.entitlements.map((item) => { const selected = selectedEntitlement(item.id); const numeric = item.valueKind !== "FLAG"; const valueLabel = item.valueKind === "LEVEL" ? "等级" : item.valueKind === "CAPACITY" ? "容量" : "是否拥有"; return <div key={item.id} className="supply-entitlement"><label className="supply-choice"><input type="checkbox" checked={Boolean(selected)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, event.target.checked, numeric ? "" : undefined, undefined, item.expiryKind)} /><span>{item.name}</span><small>{valueLabel}{item.expiryKind === "TIMED" ? " · 定时权益" : " · 长期权益"}</small></label>{selected && numeric ? <label>{valueLabel}<Input inputMode="numeric" value={selected.value === null ? "" : String(selected.value)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, true, event.target.value, selected.expiresAt ?? undefined, item.expiryKind)} placeholder="填写数值" /></label> : null}{selected && item.expiryKind === "TIMED" ? <label>有效期至<DateTimePicker label={`${item.name}有效期至`} value={beijingInputFromIso(selected.expiresAt)} disabled={formDisabled} onChange={(value) => changeEntitlement(item.id, true, numeric ? String(selected.value ?? "") : undefined, value, item.expiryKind)} /> <small>{selected.expiryKnowledge === "UNKNOWN" ? "未知到期时间不能核价。" : "按北京时间填写。"}</small></label> : null}</div>; })}</div>
              <FieldError text={fieldError("entitlements")} />
            </div> : null}
          </SectionCard>

          <SectionCard id="terms" title={groupMeta.terms.title} hasError={errorGroups.has("terms")} actions={sectionActions()}>
            <div className="publish-terms-flow">
              <section className="publish-term-section">
                <div className="publish-term-section-heading"><Coins size={20} aria-hidden="true" /><h3>余额与每日消耗</h3></div>
                <div className="publish-term-row">
                    <label className="publish-term-label" htmlFor="publish-haff-balance">哈夫币余额（核价必填）</label>
                  {haffInventoryRow ? <div className="publish-term-control publish-haff-control">
                    <div className="publish-input-with-unit"><Input id="publish-haff-balance" inputMode="decimal" maxLength={25} value={haffInput} disabled={formDisabled} aria-label={`${haffInventoryRow.name}数量（M）`} aria-invalid={Boolean(haffProblem())} onChange={(event) => changeHaffM(haffInventoryRow.itemId, event.target.value)} /><span>M</span></div>
                    <small className="publish-inline-hint">填写仓库右上角的现金余额。1 M = 100万哈夫币。</small>
                    {baseFromHaffM(haffInput) ? <small className="publish-quantity-conversion">= {baseQuantityText(baseFromHaffM(haffInput) ?? "")} 哈夫币</small> : null}
                    <FieldError text={haffProblem()?.message} />
                  </div> : <p className="publish-term-unavailable">当前发布目录尚未提供哈夫币计费项，暂不能填写。</p>}
                </div>
                <div className="publish-term-row publish-term-options-row">
                  <span className="publish-term-label">每日消耗</span>
                  <div className="publish-term-control">
                    <FormRadioGroup name="term_option" label="每日消耗" value={draft.termOptionCode} options={options?.termOptions.map((option) => ({ value: option.code, label: `${haffMText(option.dailyConsumption)} / 天` })) ?? []} disabled={formDisabled || !options} onChange={(value) => setDraft({ ...draft, termOptionCode: value })} />
                    <div className="publish-term-estimate"><CalendarClock size={17} aria-hidden="true" /><span>预计租期</span><output aria-label="预计租期">{effectiveQuote ? durationText(effectiveQuote.termSeconds) : "核价后显示"}</output><FieldHelp label="预计租期">按哈夫币余额 ÷ 每日消耗计算，不足一天按一天计；租期与收入由本次核价确认，不能手动填写。</FieldHelp></div>
                  </div>
                </div>
                <details className="publish-rule-disclosure"><summary>每日消耗怎样影响出租？</summary><p>每天的计划消耗越多，同样余额对应的租期越短。日耗也参与普通比例的计算；可用档位与调整值以本次规则为准，不按旧页面的固定加点推算。</p><p>核价后修改余额、日耗或账号能力，需重新核对报价。</p></details>
              </section>

              <section className="publish-term-section">
                <div className="publish-term-section-heading"><Calculator size={20} aria-hidden="true" /><h3>哈夫币兑换比例</h3></div>
                <div className="publish-term-row publish-term-options-row"><span className="publish-term-label">出租方案</span><div className="publish-term-control publish-ratio-control">
                  {showPricingSelect ? <div><FormSelect label="计价方案" value={draft.pricingOptionCode} disabled={disabledPricing} placeholder="选择计价方案" options={[{ value: "", label: "选择计价方案" }, ...(options?.pricingOptionCodes.map((code, index) => ({ value: code, label: `计价方案 ${index + 1}` })) ?? [])]} onChange={(val) => setDraft({ ...draft, pricingOptionCode: val })} /><FieldError text={fieldError("pricingOptionCode")} /></div> : <>
                    {fastLocked ? <div className={`supply-ratio-locked${options?.rentalModes?.fast?.enabled === false ? " is-disabled" : ""}`} aria-label="极速比例（已锁定）"><LockKeyhole size={14} aria-hidden="true" />{options?.rentalModes?.fast?.enabled === false ? "极速比例当前未启用" : "当前使用极速出租"}</div> : <FormRadioGroup name="rental_mode" label="出租比例" variant="segmented" value={rentalMode} options={rentalModeEntries.map((entry) => ({ value: entry, label: rentalModeLabel(entry) }))} disabled={formDisabled} onChange={changeRentalMode} />}
                    <small>{rentalMode === "ordinary" ? "根据安全箱、体力、负重与每日消耗核定，无需手动填写。" : rentalMode === "custom" ? "按允许范围设置自己的兑换比例。" : "使用极速出租方案，比例仍需在允许范围内填写。"}</small>
                    {rentalMode === "ordinary" ? <div className="publish-ratio-equation" aria-label="普通兑换比例"><span>1 元 =</span><output>{quotedHaffRatio ? `${quotedHaffRatio} 万哈夫币` : effectiveQuote ? "本次比例待读取" : "核价后显示"}</output></div> : <label className="publish-ratio-input"><span>兑换比例</span><div className="publish-ratio-equation publish-ratio-equation--input"><span>1 元 =</span><Input data-first-field inputMode="decimal" value={ratioInput} disabled={formDisabled} onChange={(event) => changeRatio(event.target.value)} placeholder="填写比例" aria-label="兑换比例" /><span>万哈夫币</span></div><small>{modeRange ? `允许范围：${modeRange} 万哈夫币` : "允许范围需读取当前规则后确认"}</small></label>}
                  </>}
                  <div className="publish-ratio-explainer"><Info size={17} aria-hidden="true" /><p>比例表示每收入 1 元，对应消耗多少万哈夫币。<strong>数值越大，同等消耗对应的租金越低。</strong></p></div>
                </div></div>
                {fastLocked && options && options.pricingSchema !== "haff-ratio-v2" ? <div className="supply-blockers" role="alert"><strong>极速入口当前不可用</strong><p>当前规则未开放极速比例合同，不能以极速入口上架。</p><Link className="button secondary" href={modeHref(false)}>切换到普通出租</Link></div> : null}
              </section>

              <section className="publish-term-section">
                <div className="publish-term-section-heading"><ShieldCheck size={20} aria-hidden="true" /><h3>赔付与押金</h3></div>
                <div className="publish-term-row publish-term-options-row"><span className="publish-term-label">赔付方案</span><div className="publish-term-control publish-payout-control"><FormRadioGroup name="full_payout" label="赔付方案" variant="segmented" className="publish-payout-group" value={payoutSelected} disabled={formDisabled} onChange={changeFullPayout} options={[{ value: false, label: "普通赔付" }, { value: true, label: "全额包赔" }]} />
                  <div className="publish-payout-feature" data-selected={payoutSelected === true ? "true" : "false"}>
                    <div className="publish-payout-feature-heading"><ShieldCheck size={28} aria-hidden="true" /><div><strong>全额包赔</strong><span>{payoutSelected === true ? "已选择此方案" : payoutSelected === false ? "当前选择普通赔付" : "可选保障 · 尚未选择赔付方案"}</span></div>{payoutSelected === true ? <Check size={18} aria-hidden="true" /> : null}</div>
                    <dl className="publish-payout-facts"><div><dt>服务费率</dt><dd>8%</dd></div><div><dt>基础押金</dt><dd>{recommendation?.available && recommendationFresh ? `${yuanFromCents(recommendation.fullPayoutMinCents)} 元起` : "300 元起"}</dd></div></dl>
                    <p>费用在结算时按结束场景确认，不能直接从本页预计收入统一扣除；具体赔付条件以本次有效条款为准。</p>
                    <button type="button" className="button quiet supply-terms-link" onClick={showTerms}><FileText size={14} aria-hidden="true" />查看赔付规则</button>
                  </div>
                  <small>{payoutSelected === false ? "普通赔付的范围与条件见本次出租协议。" : "选择方案不等于接受条款，上架前仍需阅读并确认。"}</small>
                </div></div>
                <div className="publish-term-row"><label className="publish-term-label" htmlFor="publish-deposit">基础租客押金</label><div className="publish-term-control"><div className="supply-deposit-input-group"><div className="supply-deposit-input-wrap"><Input id="publish-deposit" data-first-field inputMode="decimal" value={depositInput} disabled={formDisabled} onChange={(event) => changeDeposit(event.target.value)} placeholder="填写押金金额" aria-invalid={Boolean(depositProblem())} /><span className="supply-deposit-unit">元</span></div><button type="button" className="button secondary supply-recommend-btn" disabled={formDisabled || recommendationBusy} onClick={() => void recommendDeposit()}>{recommendationBusy ? "计算中…" : "查看推荐押金"}</button></div><div className="publish-deposit-guidance"><Info size={16} aria-hidden="true" /><p>结合账号价值设置押金。押金不计入你的收入；会员实际实付金额在下单时核定。推荐金额需要你点击“采用”才会填入。</p></div><FieldError text={depositProblem()?.message} />{recommendation?.available ? <div className="supply-recommend-result"><small>{recommendationAdopted ? `已采用推荐 ${moneyText({ amount: yuanFromCents(recommendation.amountCents) ?? "0.00" })}。` : recommendationBinding?.mismatch ? "推荐结果与当前账号、版本或规则不匹配，已过期；请重新查看。" : recommendationFresh ? `推荐 ${moneyText({ amount: yuanFromCents(recommendation.amountCents) ?? "0.00" })}（依据当前版本资料）。` : `推荐 ${moneyText({ amount: yuanFromCents(recommendation.amountCents) ?? "0.00" })}已过期：资料已修改，请重新查看。`}</small><button type="button" className="button quiet" disabled={formDisabled || !recommendationFresh || recommendationAdopted} onClick={adoptRecommendation}>{recommendationAdopted ? "已采用" : "采用推荐"}</button></div> : recommendation && !recommendation.available ? <small className="supply-recommend-result">{recommendation.reason === "FUNDING_POLICY_UNCONFIGURED" ? "当前规则未配置推荐依据，可自行填写。" : "补全账号能力与皮肤后可查看推荐。"}</small> : null}</div></div>

                <details id="publish-payout-rules" className="publish-policy-disclosure"><summary>赔付规则说明</summary>
                  <div className="publish-payout-scenes"><div><strong>正常结束 / 号主或账号原因提前结束</strong><p>按实际消耗的号主侧毛收入计算，由号主承担。</p></div><div><strong>租客自愿提前结束，且非号主或账号原因</strong><p>按有效开租清单的全量号主侧毛收入计算，由租客承担；号主不重复承担同一费用。</p></div></div>
                  <p>未选择全额包赔或未正常交付开租，不自动收取。押金、保证金、价差、提前补足及赔款均不计入收费基数。</p>
                  <p>服务费在结算生效时计算一次。保障针对本次租赁导致的约定损失，范围与实际赔付按有效条款处理；不承诺无条件赔付。</p>
                  <p>以上是平台政策说明；本次出租条款在核价后单独阅读和接受。</p>
                </details>
              </section>

              <section className="publish-term-section publish-term-note-section">
                <div className="publish-term-section-heading"><FileText size={20} aria-hidden="true" /><div><h3><label htmlFor="publish-description">备注（选填）</label></h3><p>内容会向租客公开展示。</p></div></div>
                <Textarea id="publish-description" rows={3} maxLength={4000} value={draft.description ?? ""} disabled={formDisabled} aria-invalid={Boolean(fieldError("description"))} onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} placeholder="填写上号配合或账号使用说明（向租客公开展示）" />
                <FieldError text={fieldError("description")} />
              </section>
            </div>
          </SectionCard>

          <SectionCard id="media" title={groupMeta.media.title} hasError={errorGroups.has("media")} actions={sectionActions()}>
            <div className="supply-media-columns">{renderMediaPanel("SHOWCASE")}{hasBanRecord ? renderMediaPanel("PENALTY") : retainedPenaltyCount > 0 ? <details className="publish-retained-media"><summary>已保留 {retainedPenaltyCount} 张封禁截图 · 查看与管理</summary>{renderMediaPanel("PENALTY")}</details> : null}</div>
            <FieldError text={fieldError("mediaBindings")} />
          </SectionCard>
        </div>
      </form>

      <aside ref={railRef} id="publish-quote" tabIndex={-1} className="publish-rail" data-quoted={effectiveQuote ? "true" : "false"} aria-label="出租报价">
        <div className="publish-rail-head">
          <div>
            <h2>出租报价</h2>
          </div>
          <FieldHelp label="查看出租报价">预计收入为号主侧哈夫币和物品的扣费前金额，按全部库存消耗估算。押金不计入收入；实际收入按使用情况和结束场景结算，不代表最终净到账。</FieldHelp>
        </div>
        <div className="publish-quote-status" data-status={quoteStatus} role="status" aria-live="polite">
          <div className="publish-quote-status-title"><Calculator size={20} aria-hidden="true" />{quoteStatusTitle}</div>
          <p className="publish-quote-status-copy">{quoteStatusCopy}</p>
        </div>
        <div className="publish-rail-scroll">
        {published ? <div className="publish-success" role="status"><Check size={20} aria-hidden="true" /><strong>已上架</strong><p>公众列表、详情与“我的出租账号”显示的是同一份发布资料。</p><div className="supply-inline-actions"><Link className="button primary" href={`/accounts/${encodeURIComponent(accountId ?? "")}`}>查看公开详情</Link><Link className="button secondary" href="/account?view=accounts">我的出租账号</Link>{readOnly ? <button type="button" className="button quiet" disabled={Boolean(busy)} onClick={() => void beginEditing()}>编辑资料</button> : null}</div></div> : <>
          {effectiveQuote ? <div className="publish-income-total"><span>预计收入（扣费前）</span><output aria-label="预计收入合计">{breakdown ? `${centsText(breakdown.totalCents)} 元` : "金额待核对"}</output></div> : null}
          <dl className="publish-rail-lines">
            {effectiveQuote ? <div><dt>哈夫币预计收入</dt><dd>{breakdown ? `${centsText(breakdown.haffCents)} 元` : "金额待核对"}</dd></div> : null}
            <div className="publish-live-resource-total"><dt>物品预计收入</dt><dd><output aria-label="物品预估收入">{resourceTotalText}</output></dd></div>
          </dl>
          {effectiveQuote || resourcePreview?.available && resourcePreview.ownerTotal ? <p className="publish-rail-note">按全部库存消耗估算，实际收入按使用情况及结束场景结算。</p> : null}
          <dl className="publish-rail-lines publish-rail-deposits">
            <div><dt>基础租客押金<small>不计入收入</small></dt><dd>{declaredDepositCents !== null ? `${yuanFromCents(declaredDepositCents)} 元` : depositInput.trim() ? "请检查金额" : "未填写"}</dd></div>
            {actualPublisherRequirement !== null && actualPublisherRequirement > 0n ? <div><dt>发布保证金<small>本次规则要求</small></dt><dd>{moneyText(effectiveQuote?.publisherBailRequirement)}</dd></div> : null}
          </dl>
          {effectiveQuote ? <small className="publish-rail-deposit-note">会员实际实付押金以下单时的个人报价为准。</small> : null}
          {effectiveQuote?.expiryDisclosures.length ? <div className="publish-rail-expiry"><strong>权益有效期</strong>{effectiveQuote.expiryDisclosures.map((item) => <p key={item.entitlementId}>{catalog?.entitlements.find((entitlement) => entitlement.id === item.entitlementId)?.name ?? supply?.version?.presentation?.entitlements.find((entitlement) => entitlement.id === item.entitlementId)?.name ?? "该项权益"}：{item.expiresAt ? new Date(item.expiresAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "长期有效"} · 本租期不保证覆盖完整有效期</p>)}</div> : null}
          {effectiveQuote && !quoteConsistent ? <div className="supply-blockers" role="alert"><strong>报价金额待核对</strong><p>本次报价的行金额与合计不一致，暂不能确认上架。</p></div> : null}
          {visibleBlockers.length ? <div className="supply-blockers"><strong>上架前请处理</strong><ul>{visibleBlockers.map((code) => <li key={code}>{blockerText(code)}</li>)}</ul></div> : null}
          {effectiveQuote && quoteConsistent ? agreement ? <details className="publish-terms"><summary>查看本次出租条款（{agreement.title}）</summary><AgreementBody body={agreement.body} /></details> : <p className="supply-muted">本次条款正文尚未读取，暂不能确认上架。</p> : null}
        </>}
        </div>
        {!published ? <div className="publish-rail-footer">
          {readOnly ? <div className="publish-rail-readonly"><p>{reviewState === "SUBMITTED" ? "当前版本正在审核中，不能直接编辑。" : "当前版本不是可编辑草稿。"}</p><button type="button" className="button primary" disabled={identityState !== "confirmed" || !identityRef.current || Boolean(busy)} onClick={() => void beginEditing()}>{busy === "edit" ? "准备草稿中…" : "开始修改"}</button></div> : <>
            {effectiveQuote ? <div className="publish-confirm">
              {quoteConsistent ? <>

                <label className="supply-check"><input type="checkbox" checked={agreementChecked} disabled={formDisabled || !agreement} onChange={(event) => setAgreementChecked(event.target.checked)} />我已阅读并同意本次出租条款与条件</label>
                <button type="button" className="button primary" disabled={primaryDisabled} onClick={() => void confirmPublish()}>{busy === "submit" ? "上架中…" : busy === "accept" ? "确认条款中…" : "确认上架"}</button>
              </> : null}
              <button type="button" className="button quiet" disabled={formDisabled} onClick={() => void quote()}>重新核对报价</button>
              <button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button>
              {rulesAccepted ? <p className="supply-muted">条款已按当前版本确认；资料变化后需重新确认。</p> : null}
            </div> : <div className="publish-rail-actions">
              <button type="button" className="button primary" disabled={primaryDisabled} onClick={() => void quote()}>{primaryLabel}</button>
              <button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button>
              <p className="supply-muted" style={{ textAlign: "center", fontSize: "12px" }}>核对报价与条款后，再确认上架</p>
            </div>}
          </>}
        </div> : null}
      </aside>
    </div>
  </ServiceShell>;
}




