"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  FileImage,
  FileText,
  Info,
  LockKeyhole,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { ServiceShell } from "../layout/service-shell";
import { useUserSessionStore } from "../session/user-session-provider";
import {
  editableDeclaration,
  groupForField,
  inventoryEditorRows,
  inventoryPriceHint,
  mergeInventory,
  supplyApi,
  supplyBlockerMessages,
  SupplyRequestError,
  uploadSupplyMedia,
  type CatalogAvailability,
} from "../../lib/supply-client";
import { freezeRequest, IdentityPauseGate, isCurrentQuery } from "../../lib/supply-workspace-guards";
import { MEDIA_ACCEPT_ATTRIBUTE, MEDIA_UPLOAD_HINT, mediaUploadFailureHint } from "../../lib/media-upload";
import { selectDeltaGame } from "../../lib/supply-games";
import {
  baseFromHaffM,
  baseQuantityText,
  beijingInputFromIso,
  buildRentalPricing,
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
  roundGroupText,
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
  RentalMode,
  SupplyGame,
} from "../../lib/supply-types";
import type { PublishMode } from "../../lib/service-navigation";

type PublishFormProps = { mode: PublishMode; gameCode?: string; accountId?: string; editRequested?: boolean };
type SessionId = string | null | undefined;
type MediaPurpose = "ACCOUNT_DISPLAY" | "ACCOUNT_EVIDENCE";
type IdentityState = "checking" | "confirmed" | "failed";
type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };
type WriteIntent = { action: string; context: RequestContext; run: () => Promise<void> };
type DraftRequest = { context: RequestContext; accountId: string; body: DraftInput & { expectedRevision: string }; key: string };
type MediaEntry = {
  id: string;
  purpose: MediaPurpose;
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
  media: { title: "图片与确认" },
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

function unitText(unit: string): string {
  return ({ HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件", DAY: "天" } as Record<string, string>)[unit] ?? "未确认";
}

function quantityText(value: string | null | undefined, unit: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return "未填写";
  return `${normalized.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${unitText(unit)}`;
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
    <span>{error ? localizedErrorMessage(error.message) : text}</span>
  </div>;
}

function GroupSection({ id, icon, title, summary, summaryEmpty, open, hasError, onToggle, onEdit, children }: {
  id: PublishGroupId;
  icon: ReactNode;
  title: string;
  summary: string;
  summaryEmpty: boolean;
  open: boolean;
  hasError: boolean;
  onToggle: () => void;
  onEdit: () => void;
  children: ReactNode;
}) {
  return <section id={`publish-group-${id}`} data-publish-group={id} className={`publish-group${open ? " is-open" : ""}${hasError ? " is-error" : ""}`}>
    <div className="publish-group-heading">
      <h2 className="publish-group-title"><button type="button" className="publish-group-toggle" aria-expanded={open} aria-controls={`publish-panel-${id}`} onClick={onToggle}>
        <span className="publish-group-icon" aria-hidden="true">{icon}</span>
        <span className="publish-group-copy"><strong>{title}</strong><small className={summaryEmpty ? "is-empty" : undefined}>{summary}</small></span>
        <ChevronDown size={18} className="publish-group-chevron" aria-hidden="true" />
      </button></h2>
      <button type="button" className="button quiet publish-group-edit" aria-label={`编辑${title}`} onClick={onEdit}><Pencil size={14} aria-hidden="true" />编辑</button>
    </div>
    <div id={`publish-panel-${id}`} className="publish-group-panel" hidden={!open}>{children}</div>
  </section>;
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
  const draftRef = useRef<DraftInput>(emptyDraft());
  const uploadQueue = useRef(Promise.resolve());
  const cancelledMedia = useRef(new Set<string>());
  const formRef = useRef<HTMLFormElement | null>(null);
  const correctedAccountGameRef = useRef("");

  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const [gameId, setGameId] = useState("");
  const [identityState, setIdentityState] = useState<IdentityState>("checking");
  const [accountId, setAccountId] = useState<string | undefined>(accountIdProp);
  const [supply, setSupply] = useState<MySupply | null>(null);
  const [draft, setDraftState] = useState<DraftInput>(emptyDraft);
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
  const [agreementChecked, setAgreementChecked] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(false);
  const [quoteStale, setQuoteStale] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<PublishGroupId, boolean>>({ account: true, assets: false, terms: false, media: false });
  const [depositInput, setDepositInput] = useState("");
  const [haffInput, setHaffInput] = useState("");
  const [recommendation, setRecommendation] = useState<DepositRecommendation | null>(null);
  const [recommendationBinding, setRecommendationBinding] = useState<RecommendationBinding | null>(null);
  const [recommendationAdopted, setRecommendationAdopted] = useState(false);
  const [recommendationBusy, setRecommendationBusy] = useState(false);
  const [writeIntent, setWriteIntentState] = useState<WriteIntent | null>(null);
  const writeIntentRef = useRef<WriteIntent | null>(null);

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
  const setWritePending = (intent: WriteIntent | null) => {
    writeIntentRef.current = intent;
    setWriteIntentState(intent);
  };
  const rememberWrite = (intent: WriteIntent) => {
    if (currentContext(intent.context)) setWritePending(intent);
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
    setAccountId(undefined);
    setSupply(null);
    setDraftState(emptyDraft());
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
    setOpenGroups({ account: true, assets: false, terms: false, media: false });
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
    const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
    setError(nextError);
    setNotice("");
    if (nextError.status === 401) {
      if (intent) rememberWrite(intent);
      setAuthRequired(true);
      return;
    }
    if (nextError.status === 409) {
      setWritePending(null);
      invalidateConfirmations();
      void refreshLatest(false);
      return;
    }
    if (nextError.status === 0 || (nextError.status === 502 && nextError.idempotencyKey)) {
      if (intent && !writeIntentRef.current) rememberWrite(intent);
      return;
    }
    setWritePending(null);
  }, [currentContext, invalidateConfirmations, refreshLatest]);

  const retryWrite = useCallback(async () => {
    const intent = writeIntentRef.current;
    if (!intent || !currentContext(intent.context)) {
      setWritePending(null);
      return;
    }
    setBusy(intent.action);
    setError(null);
    try {
      await intent.run();
      if (currentContext(intent.context)) setWritePending(null);
    } catch (failure) {
      reportWriteFailure(failure, intent.context, intent);
    } finally {
      if (currentContext(intent.context)) setBusy("");
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

  useEffect(() => {
    if (!draftDirty || !editing || identityState !== "confirmed") return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      const href = anchor?.getAttribute("href");
      if (!href || href.startsWith("#") || anchor?.target === "_blank") return;
      const next = new URL(href, window.location.href);
      if (next.href === window.location.href) return;
      if (!window.confirm("还有未保存的发布资料，确定离开吗？")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardNavigation, true);
    };
  }, [draftDirty, editing, identityState]);

  useEffect(() => {
    if (accountIdProp && loadedAccountRef.current === accountIdProp) return;
    if (!accountIdProp && gameCodeProp && gameRef.current) {
      const currentCode = gamesRef.current.find((game) => game.id === gameRef.current)?.code ?? null;
      if (currentCode && currentCode !== gameCodeProp) {
        const hasUnsaved = meaningfulDraft(draftRef.current) || media.length > 0;
        if (hasUnsaved && !window.confirm("切换游戏会清空当前未保存资料，确定继续吗？")) {
          const params = new URLSearchParams();
          if (mode === "fast") params.set("mode", "fast");
          params.set("game", currentCode);
          router.replace(`/publish?${params.toString()}`);
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
  }, [accountIdProp, editRequested, identityState, gameCodeProp, mode, router, invalidateContext, reportFailure, waitForIdentity]);

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
        created = await supplyApi.createAccount(context.gameId, accountKey, signal);
      } catch (failure) {
        if (failure instanceof SupplyRequestError && (failure.status === 0 || failure.status === 401 || (failure.status === 502 && failure.idempotencyKey)) && currentContext(context, signal)) rememberWrite({ action: retryBusy, context, run: retryAfterReady ?? (() => prepareAndRetry(context, retryBusy)) });
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
        next = await supplyApi.createDraft(id, body.expectedRevision, draftKey, signal);
      } catch (failure) {
        if (failure instanceof SupplyRequestError && (failure.status === 0 || failure.status === 401 || (failure.status === 502 && failure.idempotencyKey)) && currentContext(context, signal)) rememberWrite({ action: retryBusy, context, run: retryAfterReady ?? (() => prepareAndRetry(context, retryBusy)) });
        throw failure;
      }
      if (!currentContext(context, signal) || !(await waitForIdentity(context))) return null;
      completeKey("create-draft", { accountId: id, ...body });
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
    if (baseFromHaffM(haffInput) === null) return { group: "assets", message: "哈夫币请按 M 填写，最多 6 位小数。" };
    return null;
  };

  const prepareDraftRequest = async (context: RequestContext, retryBusy: string, retryAfterReady?: () => Promise<void>): Promise<DraftRequest | null> => {
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
      const saved = await supplyApi.saveDraft(request.accountId, request.body, request.key, controller.signal);
      if (!currentContext(request.context, controller.signal)) return null;
      completeKey("save-draft", keyBody);
      applySupply(saved, true);
      setServerSnapshot(saved);
      setDraftDirty(false);
      setWritePending(null);
      return saved;
    } catch (failure) {
      if (failure instanceof SupplyRequestError && (failure.status === 0 || failure.status === 401 || (failure.status === 502 && failure.idempotencyKey)) && currentContext(request.context, controller.signal)) rememberWrite({ action: retryBusy, context: request.context, run: retryAfterUnknown ?? (() => sendDraftRequest(request, retryBusy).then(() => undefined)) });
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
      const quoted = await supplyApi.quote(id, frozen.body.expectedRevision, frozen.key, controller.signal);
      if (!currentContext({ ...context, accountId: id }, controller.signal)) return;
      completeKey("quote", keyBody);
      applySupply(quoted, true);
      setAgreementChecked(false);
      setRulesAccepted(false);
      setDraftDirty(false);
      setWritePending(null);
      setNotice("报价已更新，请核对预计租期、金额与权益有效期说明。");
    } catch (failure) {
      if (failure instanceof SupplyRequestError && (failure.status === 0 || failure.status === 401 || (failure.status === 502 && failure.idempotencyKey)) && currentContext({ ...context, accountId: id }, controller.signal)) rememberWrite({ action: retryBusy, context: { ...context, accountId: id }, run: () => sendQuoteRequest(context, saved, retryBusy) });
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
    setOpenGroups((previous) => ({ ...previous, [group]: true }));
    requestAnimationFrame(() => {
      const node = firstFocusable(group);
      node?.scrollIntoView({ block: "center" });
      node?.focus({ preventScroll: true });
    });
  };

  const quoteProblem = (): { group: PublishGroupId; message: string } | null => {
    if (!gameId) return { group: "account", message: "请先选择游戏。" };
    if (!draftRef.current.title.trim()) return { group: "account", message: "请先填写账号名称。" };
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
    const problem = haffProblem() ?? pricingProblem() ?? depositProblem();
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
      const next = await supplyApi.confirm(context.accountId!, action, body, key, controller.signal);
      if (!currentContext(context, controller.signal)) return;
      completeKey(action, { accountId: context.accountId, ...body });
      setWritePending(null);
      onSuccess(next);
    } catch (failure) {
      if (failure instanceof SupplyRequestError && (failure.status === 0 || failure.status === 401 || (failure.status === 502 && failure.idempotencyKey)) && currentContext(context, controller.signal)) rememberWrite({ action: retryBusy, context, run: () => sendConfirmRequest(action, context, body, key, retryBusy, onSuccess) });
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
      } else {
        attributes.service_window_cross_midnight = end < start;
        attributes.service_window_timezone = "Asia/Shanghai";
      }
      return { ...previous, attributes };
    });
  };
  const changeInventory = (itemId: string, raw: string) => {
    const value = raw.trim() === "" ? null : raw.trim().replace(/^0+(?=\d)/, "");
    setDraft((previous) => {
      const next = new Map(previous.inventory.map((item) => [item.itemId, item.quantity]));
      next.set(itemId, value);
      return { ...previous, inventory: Array.from(next, ([id, quantity]) => ({ itemId: id, quantity })) };
    });
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
      const result = await uploadSupplyMedia({ gameId: context.gameId, accountId: id, purpose: entry.purpose, file: entry.file, intentKey: entry.intentKey, uploadKey: entry.uploadKey, signal: controller.signal, beforeBytesUpload: () => waitForIdentity(context) });
      if (!currentContext(context, controller.signal)) return;
      if (!result) return;
      if (cancelledMedia.current.has(entry.id)) return;
      setMedia((previous) => previous.map((item) => item.id === entry.id ? { ...item, assetId: result.assetId, reviewState: result.reviewState, bindingSaved: false, status: "bound", error: undefined } : item));
      setDraft((previous) => previous.mediaBindings.some((binding) => binding.assetId === result.assetId)
        ? previous
        : { ...previous, mediaBindings: [...previous.mediaBindings, { assetId: result.assetId, position: nextMediaPosition(previous.mediaBindings) }] });
      setNotice(`${entry.purpose === "ACCOUNT_DISPLAY" ? "公开展示图" : "私有凭证"}已上传到当前资料，保存草稿后才会正式绑定；当前状态：${mediaReviewLabel(result.reviewState)}。`);
      lastRetry.current = null;
    } catch (failure) {
      if (cancelledMedia.current.has(entry.id)) return;
      if (currentContext(context, controller.signal)) {
        setMedia((previous) => previous.map((item) => item.id === entry.id ? { ...item, status: "failed", error: failure instanceof SupplyRequestError ? failure.message : "上传未完成" } : item));
        if (failure instanceof SupplyRequestError && (failure.status === 0 || failure.status === 401 || (failure.status === 502 && failure.idempotencyKey))) rememberWrite({ action: "upload", context, run: () => upload(entry, context) });
        reportWriteFailure(failure, context);
      }
    } finally {
      if (currentContext(context, controller.signal)) setBusy("");
      finishRequest(controller);
    }
  };
  const selectFiles = (purpose: MediaPurpose, event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    const context = captureContext(accountRef.current, gameId);
    if (!currentContext(context)) return;
    for (const file of files) {
      const entryId = newKey();
      cancelledMedia.current.delete(entryId);
      const hint = mediaUploadFailureHint(file);
      const entry: MediaEntry = { id: entryId, purpose, file, status: "failed", error: hint ?? undefined, intentKey: newKey(), uploadKey: newKey(), bindingSaved: false, context, previewUrl: URL.createObjectURL(file) };
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
      mediaBindings: next.filter((item) => item.assetId).map((item, position) => ({ assetId: item.assetId!, position })),
    }));
  };

  const selectGame = (nextGameId: string) => {
    if (nextGameId === gameId) return;
    if ((meaningfulDraft(draftRef.current) || media.length) && !window.confirm("切换游戏会清空当前未保存资料，确定继续吗？")) return;
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
    const groups = new Set(fieldErrors.map((item) => publishGroupForPath(item.path)));
    setOpenGroups((previous) => {
      const next = { ...previous };
      for (const group of groups) next[group] = true;
      return next;
    });
    requestAnimationFrame(() => {
      const node = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? null;
      node?.scrollIntoView({ block: "center" });
      node?.focus({ preventScroll: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorKey]);

  const game = games.find((item) => item.id === gameId) ?? null;
  const gameCrumb = game ? { label: game.name, href: game.code === "delta" ? "/#delta-section" : undefined } : null;
  const breadcrumbs = [{ label: "首页", href: "/" }, ...(gameCrumb ? [gameCrumb] : []), { label: "上架出租" }];
  const publishShell = {
    surface: "editor" as const,
    contextLabel: fastLocked ? "极速出租" : null,
    breadcrumbs,
    backHref: accountIdProp ? `/account?view=accounts&accountId=${encodeURIComponent(accountIdProp)}` : "/accounts",
    backLabel: accountIdProp ? "返回账号管理" : "返回账号列表",
    searchLabel: "在公开账号目录中搜索",
    searchPlaceholder: "搜索账号编号或名称",
  };

  if (identityState === "checking") return <ServiceShell {...publishShell} title="上架出租" description="填写公开账号资料与出租条件；价格、规则和资格以本次核价结果为准。"><section className="account-guest" aria-busy="true"><LockKeyhole size={30} /><h2>正在确认登录身份</h2><p>确认期间暂不展示私人发布资料，也不会继续发送保存、核价或上传请求。</p></section></ServiceShell>;
  if (identityState === "failed") return <ServiceShell {...publishShell} title="上架出租" description="填写公开账号资料与出租条件；价格、规则和资格以本次核价结果为准。"><section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>暂时无法确认登录身份</h2><p>私人发布资料仍保留在本页，确认恢复后可继续；当前不会发送新的保存、核价或上传请求。</p><button type="button" className="button secondary" onClick={() => void sharedSession.confirm()}>重试身份确认</button></section></ServiceShell>;
  if (identityState === "confirmed" && authRequired && identityRef.current) return <ServiceShell {...publishShell} title="上架出租" description="填写公开账号资料与出租条件；价格、规则和资格以本次核价结果为准。"><section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>登录状态已失效</h2><p>私有发布资料已暂停展示；原写回执与待重试步骤仍然保留。重新确认同一登录身份后可继续。</p><button type="button" className="button secondary" onClick={() => void sharedSession.confirm()}>重新确认身份</button></section></ServiceShell>;
  if (!accountIdProp && gamesLoaded && games.length === 0) return <ServiceShell {...publishShell} title="上架出租" description="填写账号资料并提交上架。"><section className="account-guest"><h2>暂未开放上架</h2><p>目前没有开放出租的游戏，请稍后再来。</p><Link className="button secondary" href="/">返回首页</Link></section></ServiceShell>;

  const blockers = [...(catalog?.blockers ?? []).map((item) => item.code), ...(supply?.blockers ?? [])];
  const quoteData = supply?.version?.quote ?? null;
  const breakdown = ownerQuoteBreakdown(quoteData);
  const agreement = supply?.agreement ?? options?.agreement ?? null;
  const readOnly = Boolean(accountId && !editing);
  const published = supply?.version?.reviewState === "PUBLISHED";
  const writePending = writeIntent !== null;
  const formDisabled = identityState !== "confirmed" || !identityRef.current || readOnly || Boolean(busy) || writePending;
  const reviewState = supply?.version?.reviewState;
  const boundDisplay = media.filter((item) => item.purpose === "ACCOUNT_DISPLAY");
  const boundEvidence = media.filter((item) => item.purpose === "ACCOUNT_EVIDENCE");
  const safeBoxOptions = options?.safeBoxOptions ?? [];
  const gradingOptions = options?.gradingOptions ?? [];
  const loginMethodOptions = options?.loginMethodOptions ?? [];
  const currentGrading = String(draft.attributes.grading_code ?? "");
  const currentLoginMethod = String(draft.attributes.login_method_code ?? "");
  const currentSafeBox = String(draft.attributes.safe_box_code ?? "");
  const currentVitality = draft.attributes.vit_level === null || draft.attributes.vit_level === undefined ? "" : String(draft.attributes.vit_level);
  const currentBear = draft.attributes.bear_level === null || draft.attributes.bear_level === undefined ? "" : String(draft.attributes.bear_level);
  const safeBoxKnown = currentSafeBox !== "" && (options?.safeBoxCodes ?? []).includes(currentSafeBox);
  const vitalityKnown = currentVitality !== "" && (options?.vitalityLevels ?? []).some((level) => String(level) === currentVitality);
  const bearKnown = currentBear !== "" && (options?.bearLevels ?? []).some((level) => String(level) === currentBear);
  const safeBoxDisplay = supply?.version?.attributeDisplay?.safeBox;
  const retainedSafeBoxLabel = safeBoxDisplay?.code === currentSafeBox && safeBoxDisplay.displayName
    ? safeBoxDisplay.displayName
    : `未确认（代码 ${currentSafeBox}）`;
  const inventoryRows = inventoryEditorRows(catalog, draft.inventory, supply?.version?.catalogItems, catalog ? "ready" : catalogAvailability);
  const categoryNames = new Map((catalog?.categories ?? []).map((item) => [item.id, item.name]));
  const rarityNames = new Map((catalog?.rarities ?? []).map((item) => [item.code, item.name]));
  const savedSkinNames = new Map((supply?.version?.presentation?.skins ?? []).map((skin) => [skin.id, skin.name]));
  const skinName = (id: string) => skinNames[id] ?? savedSkinNames.get(id) ?? "目录名称待加载";
  const showPricingSelect = options?.pricingSchema !== "haff-ratio-v2";
  const disabledPricing = formDisabled || !options;
  const rentalModes = options?.rentalModes;
  const rentalModeEntries: RentalMode[] = (["ordinary", "custom", "fast"] as const).filter((entry) => rentalModes ? rentalModes[entry]?.enabled : true);
  const modeRange = ratioRangeText(rentalModes?.[rentalMode]);
  const visibleBlockers = [...new Set(blockers)].filter((code) => code !== "PUBLICATION_REQUIRED" && code !== "CONFIRMATION_OR_MEDIA_REQUIRED");
  const termOption = options?.termOptions.find((option) => option.code === draft.termOptionCode) ?? null;
  const payoutSelected = fullPayoutSelected(draft.attributes);
  const displayItems = media.filter((item) => item.purpose === "ACCOUNT_DISPLAY");
  const displayUploading = displayItems.some((item) => item.status === "uploading");
  const displayFailed = displayItems.some((item) => item.status === "failed");
  const displayUploaded = displayItems.some((item) => item.status === "bound");
  const displayReady = displayItems.some((item) => item.status === "bound" && item.bindingSaved);

  const groupSummary: Record<PublishGroupId, { text: string; empty: boolean }> = {
    account: (() => {
      const parts: string[] = [];
      if (draft.title.trim()) parts.push(draft.title.trim());
      if (safeBoxKnown) parts.push(safeBoxOptions.find((option) => option.code === currentSafeBox)?.displayName ?? `安全箱 ${currentSafeBox}`);
      if (vitalityKnown) parts.push(`体力 ${currentVitality}`);
      if (bearKnown) parts.push(`负重 ${currentBear}`);
      if (currentLoginMethod) parts.push(loginMethodOptions.find((option) => option.code === currentLoginMethod)?.displayName ?? `上号 ${currentLoginMethod}`);
      return { text: parts.length ? parts.join(" · ") : "待填写", empty: parts.length === 0 };
    })(),
    assets: (() => {
      const parts: string[] = [];
      const haffItem = (catalog?.items ?? []).find((item) => item.unit === "HAFF_BASE");
      const haffQuantity = haffItem ? draft.inventory.find((row) => row.itemId === haffItem.id)?.quantity ?? null : null;
      const haffText = haffMText(haffQuantity);
      if (haffText) parts.push(`${haffText} 哈夫币`);
      const itemCount = draft.inventory.filter((row) => row.quantity !== null && row.itemId !== haffItem?.id).length;
      if (itemCount) parts.push(`${itemCount} 项物品库存`);
      if (draft.skins.length) parts.push(`皮肤 ${draft.skins.length} 项`);
      if (draft.entitlements.length) parts.push(`权益 ${draft.entitlements.length} 项`);
      return { text: parts.length ? parts.join(" · ") : "待填写", empty: parts.length === 0 };
    })(),
    terms: (() => {
      const parts: string[] = [];
      if (termOption) parts.push(`每日消耗 ${quantityText(termOption.dailyConsumption, "HAFF_BASE")}`);
      if (options?.pricingSchema === "haff-ratio-v2") parts.push(rentalModeLabel(rentalMode));
      if (quoteData) parts.push(`预计租期 ${durationText(quoteData.termSeconds)}`);
      return { text: parts.length ? parts.join(" · ") : "待选择", empty: parts.length === 0 };
    })(),
    media: (() => {
      const parts: string[] = [];
      if (displayItems.length) parts.push(`公开展示图 ${displayItems.length} 张`);
      if (boundEvidence.length) parts.push(`私有凭证 ${boundEvidence.length} 张`);
      if (!parts.length) return { text: "待添加账号截图", empty: true };
      if (displayUploading) parts.push("上传中");
      else if (displayFailed && !displayUploaded) parts.push("有图片上传失败");
      else if (displayReady) parts.push("展示图已保存");
      else if (displayUploaded) parts.push("展示图待保存");
      return { text: parts.join(" · "), empty: false };
    })(),
  };

  const errorGroups = new Set(fieldErrors.map((item) => publishGroupForPath(item.path)));
  const busyText = busy === "save" ? "保存草稿" : busy === "quote" ? "核对报价" : busy === "accept" ? "确认条款" : busy === "submit" ? "确认上架" : busy === "edit" ? "准备草稿" : busy === "recommend" ? "查看推荐押金" : "处理当前操作";
  const effectiveQuote = quoteData && !quoteStale ? quoteData : null;
  const quoteConsistent = !effectiveQuote || Boolean(breakdown);
  const canQuoteNow = optionsAvailability === "ready" && catalogAvailability === "ready";
  const mediaStatusText = (item: MediaEntry) => item.status === "uploading"
    ? "上传中…"
    : item.status === "failed"
      ? item.error ?? "上传未完成"
      : item.reviewState
        ? `${item.bindingSaved ? "已保存" : "已上传，待保存"} · ${mediaReviewLabel(item.reviewState)}${item.publiclyReadable ? " · 当前公开展示" : item.publicDisplayEligible ? " · 图片可展示，账号尚未公开" : ""}`
        : item.bindingSaved ? "已保存，状态待核" : "已上传，待保存；状态待核";

  const openGroup = (group: PublishGroupId) => setOpenGroups((previous) => ({ ...previous, [group]: !previous[group] }));
  const editGroup = (group: PublishGroupId) => {
    setOpenGroups((previous) => ({ ...previous, [group]: true }));
    requestAnimationFrame(() => {
      const node = firstFocusable(group);
      node?.scrollIntoView({ block: "center" });
      node?.focus({ preventScroll: true });
    });
  };
  const rulesText = optionsAvailability === "ready"
    ? "已读取当前出租规则"
    : optionsAvailability === "unavailable"
      ? "该游戏暂未配置出租规则"
      : optionsAvailability === "failed"
        ? "出租规则读取失败"
        : "正在读取出租规则…";
  const inventoryHaffId = (catalog?.items ?? []).find((item) => item.unit === "HAFF_BASE")?.id;
  const selectedSkinGroups = new Map<string, string[]>();
  for (const skin of catalog?.skins ?? []) {
    const key = categoryNames.get(skin.categoryId) ?? "其他分类";
    selectedSkinGroups.set(key, [...(selectedSkinGroups.get(key) ?? []), skin.id]);
  }

  const primaryLabel = effectiveQuote ? "确认上架" : busy === "quote" ? "核对中…" : "核对报价";
  const primaryDisabled = readOnly || Boolean(busy) || writePending || identityState !== "confirmed" || !identityRef.current || (effectiveQuote ? !agreementChecked || !quoteConsistent : false);
  const primaryAction = () => {
    if (primaryDisabled) return;
    if (effectiveQuote) void confirmPublish();
    else void quote();
  };

  const mobileTermsPending = Boolean(effectiveQuote && quoteConsistent && !agreementChecked && agreement?.body && !formDisabled);
  const showTerms = () => {
    const terms = document.querySelector<HTMLDetailsElement>(".publish-terms");
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
  const renderMediaPanel = (purpose: MediaPurpose) => {
    const rows = purpose === "ACCOUNT_DISPLAY" ? boundDisplay : boundEvidence;
    return <div className="supply-media-panel" key={purpose}>
      <div className="supply-media-heading"><FileImage size={18} /><div><h3>{purpose === "ACCOUNT_DISPLAY" ? "公开展示图" : "私有审核凭证"}</h3><p>{purpose === "ACCOUNT_DISPLAY" ? "通过技术校验后可出现在公开详情；直发上架至少需要一张。" : "封禁记录、处罚查询等截图仅供内部核对，不生成公开地址。"}{MEDIA_UPLOAD_HINT}</p></div></div>
      <label className="supply-upload"><Upload size={17} />选择图片<input data-first-field={purpose === "ACCOUNT_DISPLAY" ? true : undefined} type="file" accept={MEDIA_ACCEPT_ATTRIBUTE} multiple disabled={formDisabled || !gameId} onChange={(event) => selectFiles(purpose, event)} /></label>
      <div className="supply-media-list">{rows.map((item) => <div key={item.id} className="supply-media-row">
        <div className="supply-media-preview">{item.previewUrl ? <a href={item.previewUrl} target="_blank" rel="noreferrer" aria-label="预览图片"><img src={item.previewUrl} alt="" /></a> : <span className="supply-media-placeholder" aria-hidden="true"><FileImage size={16} /></span>}</div>
        <div className="supply-media-copy"><span>{item.file?.name ?? "已上传图片"}</span><small>{mediaStatusText(item)}</small>{item.error && item.status === "failed" ? <small className="supply-field-error" role="alert">{item.error}</small> : null}</div>
        <div className="supply-media-actions">
          {item.status === "failed" && item.file ? <button type="button" className="button quiet" onClick={() => void upload(item)}>重试</button> : null}
          <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} aria-label="上移" onClick={() => moveMedia(item.id, -1)}><ArrowUp size={14} /></button>
          <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} aria-label="下移" onClick={() => moveMedia(item.id, 1)}><ArrowDown size={14} /></button>
          <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} onClick={() => removeMedia(item.id)}><Trash2 size={14} />移除</button>
        </div>
      </div>)}{rows.length === 0 ? <p className="supply-muted">尚未上传。</p> : null}</div>
    </div>;
  };

  return <ServiceShell {...publishShell} title="上架出租" description="填写公开账号资料与出租条件；满足资格并确认本次条款后直接上架。">
    <div className="publish-page-layout">
      <form ref={formRef} className="publish-column" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); primaryAction(); }} noValidate>
        <div className="publish-mode"><Link href={modeHref(false)} aria-current={!fastLocked ? "page" : undefined}>普通出租</Link><Link href={modeHref(true)} aria-current={fastLocked ? "page" : undefined}>极速出租</Link></div>
        <div className="supply-toolbar"><span>{accountId ? `资料状态：${reviewState ? stateLabel(reviewState) : "未创建草稿"}` : "尚未保存草稿"}</span><span className={optionsAvailability === "unavailable" || optionsAvailability === "failed" || catalogAvailability === "failed" ? "is-warning" : undefined}>{rulesText}{catalogAvailability === "failed" ? " · 目录读取失败" : ""}</span></div>
        {authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>此操作需要登录并确认当前身份。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent(accountId ? `/publish?accountId=${accountId}` : "/publish")}`}>登录 / 注册</Link></div> : null}
        <Notice error={error} text={notice} />
        {error?.status === 409 && serverSnapshot ? <div className="supply-conflict" role="alert"><strong>资料状态已变化</strong><p>已保留本页输入，没有自动覆盖。当前资料状态为 {serverSnapshot.version ? stateLabel(serverSnapshot.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" onClick={() => void refreshLatest(false)}>重新读取最新状态</button><button type="button" className="button secondary" onClick={() => void refreshLatest(true)}>采用最新资料</button></div></div> : null}
        {writePending ? <div className="supply-conflict" role="alert"><strong>结果未知</strong><p>上次写入已发出但没有收到确认。重新读取只更新服务器展示，不会解除锁定；请重试当前步骤，收到与原请求对应的确定结果后才可继续修改或发起新写入。</p><div className="supply-inline-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void retryWrite()}>重试当前步骤</button><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void refreshLatest(true)}>重新读取最新状态</button></div></div> : null}
        {!writePending && error?.status === 0 && lastRetry.current ? <div className="supply-conflict"><strong>读取未完成</strong><p>本页没有自动重复操作，请重试本次读取。</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void retryLast()}>重试读取</button></div> : null}
        {!writePending && optionsAvailability === "failed" ? <div className="supply-blockers" role="alert"><strong>出租规则读取失败</strong><p>暂不能核对报价；可先保存草稿。</p><button type="button" className="button secondary" disabled={Boolean(busy) || !gameId} onClick={() => void loadOptions(gameId)}>重试读取规则</button></div> : null}
        {readOnly && !published ? <div className="supply-readonly" role="status"><strong>当前版本不可直接编辑</strong><span>已上架、审核中的历史版本或已退回版本会在你明确开始修改后创建新草稿。</span><button type="button" className="button secondary" disabled={identityState !== "confirmed" || !identityRef.current || Boolean(busy)} onClick={() => void beginEditing()}>{busy === "edit" ? "准备草稿中…" : "开始修改"}</button></div> : null}
        {loadingAccount ? <p className="supply-muted" role="status">正在读取账号资料…</p> : null}

        <div className="publish-groups">
          <GroupSection id="account" icon={<FileText size={18} />} title={groupMeta.account.title} summary={groupSummary.account.text} summaryEmpty={groupSummary.account.empty} open={openGroups.account} hasError={errorGroups.has("account")} onToggle={() => openGroup("account")} onEdit={() => editGroup("account")}>
            <div className="supply-grid">
              <label>游戏<select value={gameId} disabled={Boolean(accountId) || formDisabled} onChange={(event) => selectGame(event.target.value)}><option value="">选择游戏</option>{games.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select><small>{accountId ? "资料已按该账号所在游戏读取，不能切换。" : "仅显示已开放出租的游戏。"}</small></label>
              <label>账号名称<input data-first-field maxLength={120} value={draft.title} disabled={formDisabled} aria-invalid={Boolean(fieldError("title"))} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：满仓哈夫币·多套护甲" /><FieldError text={fieldError("title")} /></label>
              <label className="supply-wide">公开说明<textarea rows={4} maxLength={4000} value={draft.description ?? ""} disabled={formDisabled} aria-invalid={Boolean(fieldError("description"))} onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} placeholder="描述资源组成、使用限制和可提供的服务时段" /><FieldError text={fieldError("description")} /></label>
              <label>安全箱档位<select value={currentSafeBox} disabled={formDisabled || !options} onChange={(event) => changeAttribute("safe_box_code", event.target.value || null)}><option value="">未申报</option>{currentSafeBox && !safeBoxKnown ? <option value={currentSafeBox}>{retainedSafeBoxLabel}</option> : null}{options?.safeBoxCodes.map((code) => <option key={code} value={code}>{safeBoxOptions.find((option) => option.code === code)?.displayName ?? `未确认（代码 ${code}）`}</option>)}</select><small>赛季永久保险箱容量，未映射代码会保留原值。</small></label>
              <label>上号方式<select value={currentLoginMethod} disabled={formDisabled || !options} onChange={(event) => changeAttribute("login_method_code", event.target.value || null)}><option value="">未申报</option>{currentLoginMethod && !loginMethodOptions.some((option) => option.code === currentLoginMethod) ? <option value={currentLoginMethod}>未确认（代码 {currentLoginMethod}）</option> : null}{loginMethodOptions.map((option) => <option key={option.code} value={option.code}>{option.displayName ?? `未确认（代码 ${option.code}）`}</option>)}</select><small>配合租客登录账号的方式。</small></label>
              <label>所在省份<input value={String(draft.attributes.region_province ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("region_province", event.target.value || null)} placeholder="未申报" /></label>
              <label>所在城市<input value={String(draft.attributes.region_city ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("region_city", event.target.value || null)} placeholder="未申报" /></label>
              <label>可配合上号时间（北京时间）<span className="supply-time-range"><input type="time" aria-label="开始时间" value={minutesToTimeValue(draft.attributes.service_window_start_minute as number | null)} disabled={formDisabled} onChange={(event) => changeServiceWindow("service_window_start_minute", event.target.value)} /><span aria-hidden="true">至</span><input type="text" inputMode="numeric" maxLength={5} aria-label="结束时间" placeholder="HH:MM" value={minutesToTimeValue(draft.attributes.service_window_end_minute as number | null)} disabled={formDisabled} onChange={(event) => changeServiceWindow("service_window_end_minute", event.target.value)} /></span><small>{typeof draft.attributes.service_window_start_minute === "number" && typeof draft.attributes.service_window_end_minute === "number" && draft.attributes.service_window_end_minute < draft.attributes.service_window_start_minute ? "结束时间早于开始时间，按次日（跨日）理解；结束可填 24:00。" : "留空表示暂不申报时段；结束可填 24:00。"}</small></label>
              <label>体力等级<select value={currentVitality} disabled={formDisabled || !options} onChange={(event) => changeAttribute("vit_level", event.target.value ? Number(event.target.value) : null)}><option value="">未申报</option>{currentVitality && !vitalityKnown ? <option value={currentVitality}>{`${currentVitality}（未确认）`}</option> : null}{options?.vitalityLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
              <label>负重等级<select value={currentBear} disabled={formDisabled || !options} onChange={(event) => changeAttribute("bear_level", event.target.value ? Number(event.target.value) : null)}><option value="">未申报</option>{currentBear && !bearKnown ? <option value={currentBear}>{`${currentBear}（未确认）`}</option> : null}{options?.bearLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
              <label>潜水等级<input inputMode="numeric" value={String(draft.attributes.dive_level ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("dive_level", event.target.value ? Number.parseInt(event.target.value, 10) : null)} placeholder="未申报" /></label>
              <label>账号等级<input inputMode="numeric" value={String(draft.attributes.character_level ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("character_level", event.target.value ? Number.parseInt(event.target.value, 10) : null)} placeholder="未申报" /></label>
              <label>段位<select value={currentGrading} disabled={formDisabled || !options} onChange={(event) => changeAttribute("grading_code", event.target.value || null)}><option value="">未申报</option>{currentGrading && !gradingOptions.some((option) => option.code === currentGrading) ? <option value={currentGrading}>未确认（代码 {currentGrading}）</option> : null}{gradingOptions.map((option) => <option key={option.code} value={option.code}>{option.displayName ?? `未确认（代码 ${option.code}）`}</option>)}</select></label>
              <label>绝密KD<input inputMode="decimal" value={String(draft.attributes.secret_kd ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("secret_kd", event.target.value || null)} placeholder="例如 1.85" /><small>当前赛季绝密模式 KD。</small></label>
              <label>大武器数量<input inputMode="numeric" value={String(draft.attributes.awm_weapon_count ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("awm_weapon_count", event.target.value ? Number.parseInt(event.target.value, 10) : null)} placeholder="未申报" /></label>
              <fieldset className="supply-radio-field"><legend>封禁记录</legend>{([[null, "未申报"], [false, "无"], [true, "有"]] as const).map(([value, label]) => <label key={String(value)} className="supply-radio"><input type="radio" name="ban_record" checked={draft.attributes.ban_record === value} disabled={formDisabled} onChange={() => changeAttribute("ban_record", value)} />{label}</label>)}<small>选择“有”时请在私有审核凭证中提供封禁或处罚查询截图。</small></fieldset>
              <fieldset className="supply-radio-field"><legend>人脸归属</legend>{([[null, "未申报"], [true, "本人"], [false, "非本人"]] as const).map(([value, label]) => <label key={String(value)} className="supply-radio"><input type="radio" name="face_is_self" checked={draft.attributes.face_is_self === value} disabled={formDisabled} onChange={() => changeAttribute("face_is_self", value)} />{label}</label>)}<small>人脸是否为账号号主本人，非本人人脸不可出租。</small></fieldset>
            </div>
          </GroupSection>

          <GroupSection id="assets" icon={<Box size={18} />} title={groupMeta.assets.title} summary={groupSummary.assets.text} summaryEmpty={groupSummary.assets.empty} open={openGroups.assets} hasError={errorGroups.has("assets")} onToggle={() => openGroup("assets")} onEdit={() => editGroup("assets")}>
            <div className="supply-subsection">
              <h3>库存数量</h3>
              <p className="supply-muted">留空表示尚未申报，与 0 不同。</p>
              {catalog?.blockers.length ? <div className="supply-blockers">{catalog.blockers.map((item) => <p key={`${item.code}-${item.itemId}`}>{blockerText(item.code)}{item.name ? `：${item.name}` : ""}</p>)}</div> : null}
              {catalogAvailability === "failed" ? <div className="supply-blockers" role="alert"><strong>发布目录读取失败</strong><p>无法确认当前价目与可申报物品，请重试读取。</p><button type="button" className="button secondary" onClick={() => void loadSkinPage({}, false)}>重试读取目录</button></div> : !catalog && loadingCatalog ? <p className="supply-muted" role="status">正在读取发布目录…</p> : catalog ? <div className="supply-table-wrap"><table className="supply-table"><thead><tr><th scope="col">资源</th><th scope="col">单位</th><th scope="col">数量</th></tr></thead><tbody>{inventoryRows.map((item) => {
                const quantity = item.quantity ?? "";
                const priceHint = inventoryPriceHint(item);
                const conversions: string[] = [];
                const itemCode = catalog.items.find((row) => row.id === item.itemId)?.code ?? supply?.version?.catalogItems?.find((row) => row.id === item.itemId)?.code ?? null;
                if (item.unit === "HAFF_BASE" && item.itemId === inventoryHaffId) {
                  const base = baseQuantityText(quantity);
                  if (base) conversions.push(`= ${base} 哈夫币`);
                }
                if (item.unit === "ROUND") {
                  const quotedPerGroup = quoteData?.lines.find((line) => line.itemId === item.itemId)?.unitQuantity ?? null;
                  const perGroup = quotedPerGroup && /^\d+$/.test(quotedPerGroup) && Number(quotedPerGroup) > 1
                    ? Number(quotedPerGroup)
                    : itemCode === "level6_bullet" ? 60 : null;
                  if (perGroup) {
                    const groups = roundGroupText(quantity, perGroup);
                    if (groups) conversions.push(`每 ${perGroup} 发为 1 组：${groups}`);
                  }
                }
                const isHaff = item.unit === "HAFF_BASE" && item.itemId === inventoryHaffId;
                return <tr key={item.itemId}><th scope="row">{item.name}{item.required ? <small>必填</small> : null}{priceHint ? <small>{priceHint}</small> : null}</th><td>{item.unit ? unitText(item.unit) : "未确认"}</td><td>{isHaff ? <input className="supply-quantity" inputMode="decimal" maxLength={25} value={haffInput} disabled={formDisabled} aria-label={`${item.name}数量（M）`} aria-invalid={Boolean(haffProblem())} onChange={(event) => { setHaffInput(event.target.value); const base = baseFromHaffM(event.target.value); if (event.target.value.trim() === "") changeInventory(item.itemId, ""); else if (base !== null) changeInventory(item.itemId, base); }} /> : <input className="supply-quantity" inputMode="numeric" pattern="[0-9]*" maxLength={24} value={quantity} disabled={formDisabled} aria-label={`${item.name}数量`} aria-invalid={Boolean(fieldError("inventory"))} onChange={(event) => changeInventory(item.itemId, event.target.value)} />}{isHaff ? <small className="supply-quantity-note">按 M 填写（1 M = 1,000,000 哈夫币）</small> : null}{conversions.length ? <small className="supply-quantity-note">{conversions.join(" · ")}</small> : null}<FieldError text={isHaff ? haffProblem()?.message : undefined} /></td></tr>;
              })}</tbody></table></div> : null}
              <FieldError text={fieldError("inventory")} />
            </div>
            <div className="supply-subsection">
              <h3>皮肤</h3>
              <p className="supply-muted">用于展示与筛选；搜索和分类只筛选皮肤。</p>
              <div className="supply-filter-row"><label>搜索皮肤<input value={skinQuery} disabled={formDisabled} onChange={(event) => setSkinQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadSkinPage({ q: skinQuery.trim(), categoryId: skinCategory, rarityCode: skinRarity }, false); } }} placeholder="输入名称后按 Enter" /></label><label>分类<select value={skinCategory} disabled={formDisabled} onChange={(event) => { setSkinCategory(event.target.value); void loadSkinPage({ q: skinQuery.trim(), categoryId: event.target.value, rarityCode: skinRarity }, false); }}><option value="">全部分类</option>{catalog?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>稀有度<select value={skinRarity} disabled={formDisabled} onChange={(event) => { setSkinRarity(event.target.value); void loadSkinPage({ q: skinQuery.trim(), categoryId: skinCategory, rarityCode: event.target.value }, false); }}><option value="">全部稀有度</option>{catalog?.rarities.map((rarity) => <option key={rarity.code} value={rarity.code}>{rarity.name}</option>)}</select></label></div>
              {draft.skins.length ? <div className="supply-selected-chips" aria-label="已选皮肤">{draft.skins.map((id) => <span key={id} className="supply-chip">{skinName(id)}<button type="button" className="supply-chip-remove" aria-label={`移除 ${skinName(id)}`} disabled={formDisabled} onClick={() => setDraft((previous) => ({ ...previous, skins: previous.skins.filter((skinId) => skinId !== id) }))}><Trash2 size={13} /></button></span>)}</div> : <p className="supply-muted">尚未选择皮肤。</p>}
              {[...selectedSkinGroups.entries()].map(([category, ids]) => <div key={category} className="supply-skin-group"><h4>{category}</h4><div className="supply-choice-list">{ids.map((id) => { const skin = catalog?.skins.find((entry) => entry.id === id); if (!skin) return null; return <label key={skin.id} className="supply-choice"><input type="checkbox" checked={draft.skins.includes(skin.id)} disabled={formDisabled} onChange={(event) => setDraft((previous) => ({ ...previous, skins: event.target.checked ? [...previous.skins, skin.id] : previous.skins.filter((skinId) => skinId !== skin.id) }))} /><span>{skin.name}</span><small>{skin.rarityCode ? rarityNames.get(skin.rarityCode) ?? "稀有度待核" : "稀有度待核"}</small></label>; })}</div></div>)}
              {catalog?.nextCursor ? <button type="button" className="button secondary" disabled={formDisabled || loadingCatalog} onClick={() => void loadSkinPage({ q: skinQuery.trim(), categoryId: skinCategory, rarityCode: skinRarity, cursor: catalog.nextCursor ?? undefined }, true)}>{loadingCatalog ? "正在读取…" : "加载更多皮肤"}</button> : null}
            </div>
            {catalog?.entitlements.length ? <div className="supply-subsection">
              <h3>权益及有效期</h3>
              <p className="supply-muted">定时权益必须填写到期时间；未知时保持“未知”，不默认永久有效。</p>
              <div className="supply-entitlement-list">{catalog.entitlements.map((item) => { const selected = selectedEntitlement(item.id); const numeric = item.valueKind !== "FLAG"; const valueLabel = item.valueKind === "LEVEL" ? "等级" : item.valueKind === "CAPACITY" ? "容量" : "是否拥有"; return <div key={item.id} className="supply-entitlement"><label className="supply-choice"><input type="checkbox" checked={Boolean(selected)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, event.target.checked, numeric ? "" : undefined, undefined, item.expiryKind)} /><span>{item.name}</span><small>{valueLabel}{item.expiryKind === "TIMED" ? " · 定时权益" : " · 长期权益"}</small></label>{selected && numeric ? <label>{valueLabel}<input inputMode="numeric" value={selected.value === null ? "" : String(selected.value)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, true, event.target.value, selected.expiresAt ?? undefined, item.expiryKind)} placeholder="未申报" /></label> : null}{selected && item.expiryKind === "TIMED" ? <label>有效期至<input type="datetime-local" value={beijingInputFromIso(selected.expiresAt)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, true, numeric ? String(selected.value ?? "") : undefined, event.target.value, item.expiryKind)} /> <small>{selected.expiryKnowledge === "UNKNOWN" ? "未知到期时间不能核价。" : "按北京时间填写。"}</small></label> : null}</div>; })}</div>
              <FieldError text={fieldError("entitlements")} />
            </div> : null}
          </GroupSection>

          <GroupSection id="terms" icon={<Info size={18} />} title={groupMeta.terms.title} summary={groupSummary.terms.text} summaryEmpty={groupSummary.terms.empty} open={openGroups.terms} hasError={errorGroups.has("terms")} onToggle={() => openGroup("terms")} onEdit={() => editGroup("terms")}>
            <div className="supply-grid">
              <label>每日消耗<select data-first-field value={draft.termOptionCode} disabled={formDisabled || !options} onChange={(event) => setDraft({ ...draft, termOptionCode: event.target.value })}><option value="">选择每日消耗</option>{options?.termOptions.map((option) => <option key={option.code} value={option.code}>{option.name} · 每日消耗 {quantityText(option.dailyConsumption, "HAFF_BASE")}</option>)}</select><small>用于推算预计租期。</small></label>
              <label>预计租期<input readOnly value={quoteData ? durationText(quoteData.termSeconds) : ""} placeholder="核价后显示" /><small>按哈夫币余额与每日消耗计算。</small></label>
              {showPricingSelect ? <label>计价方案<select value={draft.pricingOptionCode} disabled={disabledPricing} onChange={(event) => setDraft({ ...draft, pricingOptionCode: event.target.value })}><option value="">选择计价方案</option>{options?.pricingOptionCodes.map((code, index) => <option key={code} value={code}>计价方案 {index + 1}</option>)}</select><FieldError text={fieldError("pricingOptionCode")} /></label> : null}
            </div>
            {fastLocked && options && options.pricingSchema !== "haff-ratio-v2" ? <div className="supply-blockers" role="alert"><strong>极速入口当前不可用</strong><p>当前规则未开放极速比例合同，不能以极速入口上架。</p><Link className="button secondary" href={modeHref(false)}>切换到普通出租</Link></div> : null}
            {!showPricingSelect ? <div className="supply-pricing-block">
              <fieldset className="supply-radio-field"><legend>哈夫币比例类型</legend>
                {fastLocked ? <div className={`supply-ratio-locked${options?.rentalModes?.fast?.enabled === false ? " is-disabled" : ""}`} aria-label="极速比例（已锁定）"><LockKeyhole size={14} aria-hidden="true" />{options?.rentalModes?.fast?.enabled === false ? "极速比例当前未启用" : "极速比例"}</div> : rentalModeEntries.map((entry) => <label key={entry} className="supply-radio"><input type="radio" name="rental_mode" checked={rentalMode === entry} disabled={formDisabled} onChange={() => changeRentalMode(entry)} />{rentalModeLabel(entry)}</label>)}
                <small>{fastLocked ? "极速入口固定使用极速比例；比例数值仍可填写。" : "切换比例类型会保留其他资料并重新核价。"}</small>
              </fieldset>
              {rentalMode !== "ordinary" ? <label className="supply-ratio-input">填写比例<span className="supply-ratio-value"><input data-first-field inputMode="decimal" value={ratioInput} disabled={formDisabled} onChange={(event) => changeRatio(event.target.value)} placeholder="例如 42" /><span aria-hidden="true">万哈夫币 / 元</span></span><small>{modeRange ? `允许范围：${modeRange}。C 为平台按账号资料核算的普通比例，具体下限以核价结果为准。` : "范围以当前规则为准"}</small></label> : <p className="supply-muted">普通比例由平台按账号条件计算。</p>}
            </div> : null}
            <div className="supply-grid">
              <label>租客押金申报<input data-first-field inputMode="decimal" value={depositInput} disabled={formDisabled} onChange={(event) => changeDeposit(event.target.value)} placeholder="填写押金金额" aria-invalid={Boolean(depositProblem())} /><small>{payoutSelected === true ? "全额包赔的申报下限以当前规则为准。" : "是否免押以正式政策与租客资格为准。"}</small><FieldError text={depositProblem()?.message} /></label>
              <div className="supply-recommend">
                <button type="button" className="button secondary" disabled={formDisabled || recommendationBusy} onClick={() => void recommendDeposit()}>{recommendationBusy ? "计算中…" : "查看推荐押金"}</button>
                {recommendation?.available ? <div className="supply-recommend-result">
                  <small>{recommendationAdopted ? `已采用推荐 ${moneyText({ amount: yuanFromCents(recommendation.amountCents) ?? "0.00" })}。` : recommendationBinding?.mismatch ? "推荐结果与当前账号、版本或规则不匹配，已过期；请重新查看。" : recommendationFresh ? `推荐 ${moneyText({ amount: yuanFromCents(recommendation.amountCents) ?? "0.00" })}（依据当前版本资料）。` : `推荐 ${moneyText({ amount: yuanFromCents(recommendation.amountCents) ?? "0.00" })}已过期：资料已修改，请重新查看。`}</small>
                  <button type="button" className="button quiet" disabled={formDisabled || !recommendationFresh || recommendationAdopted} onClick={adoptRecommendation}>{recommendationAdopted ? "已采用" : "采用推荐"}</button>
                </div> : recommendation && !recommendation.available ? <small>{recommendation.reason === "FUNDING_POLICY_UNCONFIGURED" ? "当前规则未配置推荐依据，可自行填写。" : "补全安全箱、体力、负重、潜水与皮肤后可查看推荐。"}</small> : <small>推荐仅供参考，不会自动覆盖申报。</small>}
              </div>
            </div>
            <fieldset className="supply-radio-field"><legend>赔付方案</legend>
              <label className="supply-radio"><input type="radio" name="full_payout" checked={payoutSelected === false} disabled={formDisabled} onChange={() => changeFullPayout(false)} />普通赔付</label>
              <label className="supply-radio"><input type="radio" name="full_payout" checked={payoutSelected === true} disabled={formDisabled} onChange={() => changeFullPayout(true)} />全额包赔</label>
              {payoutSelected === true && recommendation?.available ? <small>全额包赔的申报下限为 {moneyText({ amount: yuanFromCents(recommendation.fullPayoutMinCents) ?? "0.00" })}。</small> : <small>赔付范围与费用以本次确认的条款和正式政策为准，不自动勾选。</small>}
            </fieldset>
          </GroupSection>

          <GroupSection id="media" icon={<FileImage size={18} />} title={groupMeta.media.title} summary={groupSummary.media.text} summaryEmpty={groupSummary.media.empty} open={openGroups.media} hasError={errorGroups.has("media")} onToggle={() => openGroup("media")} onEdit={() => editGroup("media")}>
            <div className="supply-media-columns">{(["ACCOUNT_DISPLAY", "ACCOUNT_EVIDENCE"] as const).map((purpose) => renderMediaPanel(purpose))}</div>
            <FieldError text={fieldError("mediaBindings")} />
          </GroupSection>
        </div>
      </form>

      <aside className="publish-rail" aria-label="出租报价">
        <div className="publish-rail-head"><div><span className="publish-rail-kicker">出租报价</span><h2>{effectiveQuote ? rentalModeLabel(effectiveQuote.rentalMode ?? rentalMode) : "尚未核价"}</h2></div><Info size={16} aria-hidden="true" /></div>
        {published ? <div className="publish-success" role="status"><Check size={20} aria-hidden="true" /><strong>已上架</strong><p>公众列表、详情与“我的出租账号”显示的是同一份发布资料。</p><div className="supply-inline-actions"><Link className="button primary" href={`/accounts/${encodeURIComponent(accountId ?? "")}`}>查看公开详情</Link><Link className="button secondary" href="/account?view=accounts">我的出租账号</Link>{readOnly ? <button type="button" className="button quiet" disabled={Boolean(busy)} onClick={() => void beginEditing()}>编辑资料</button> : null}</div></div> : <>
          <dl className="publish-rail-lines">
            <div><dt>哈夫币租金</dt><dd>{effectiveQuote && breakdown ? `${centsText(breakdown.haffCents)} 元` : "待核价"}</dd></div>
            <div><dt>物品计费</dt><dd>{effectiveQuote && breakdown ? `${centsText(breakdown.itemCents)} 元` : "待核价"}</dd></div>
            <div className="is-total"><dt>号主侧合计</dt><dd>{effectiveQuote && breakdown ? `${centsText(breakdown.totalCents)} 元` : "待核价"}</dd></div>
          </dl>
          <dl className="publish-rail-lines publish-rail-deposits">
            <div><dt>租客押金</dt><dd>{effectiveQuote ? moneyText(effectiveQuote.tenantDeposit) === "未配置" ? "待确认" : moneyText(effectiveQuote.tenantDeposit) : "待确认"}</dd></div>
            <div><dt>发布保证金</dt><dd>{effectiveQuote ? effectiveQuote.publisherBailRequirement ? moneyText(effectiveQuote.publisherBailRequirement) : "待确认" : "待确认"}</dd></div>
          </dl>
          <p className="publish-rail-note">{effectiveQuote ? "金额来自本次核价；押金与保证金不影响号主侧合计。" : "保存草稿后可核对本版报价。"}</p>
          {effectiveQuote?.expiryDisclosures.length ? <div className="publish-rail-expiry"><strong>权益有效期</strong>{effectiveQuote.expiryDisclosures.map((item) => <p key={item.entitlementId}>{catalog?.entitlements.find((entitlement) => entitlement.id === item.entitlementId)?.name ?? supply?.version?.presentation?.entitlements.find((entitlement) => entitlement.id === item.entitlementId)?.name ?? "该项权益"}：{item.expiresAt ? new Date(item.expiresAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "长期有效"} · 本租期不保证覆盖完整有效期</p>)}</div> : null}
          {effectiveQuote && !quoteConsistent ? <div className="supply-blockers" role="alert"><strong>报价金额待核对</strong><p>本次报价的行金额与合计不一致，暂不能确认上架。</p></div> : null}
          {visibleBlockers.length ? <div className="supply-blockers"><strong>上架前请处理</strong><ul>{visibleBlockers.map((code) => <li key={code}>{blockerText(code)}</li>)}</ul></div> : null}
          {blockers.includes("CONFIRMATION_OR_MEDIA_REQUIRED") ? <p className="publish-rail-note">请核对图片校验状态，并阅读确认本次出租条款后上架。</p> : null}
          {readOnly ? <div className="publish-rail-readonly"><p>{reviewState === "SUBMITTED" ? "当前版本正在审核中，不能直接编辑。" : "当前版本不是可编辑草稿。"}</p><button type="button" className="button primary" disabled={identityState !== "confirmed" || !identityRef.current || Boolean(busy)} onClick={() => void beginEditing()}>{busy === "edit" ? "准备草稿中…" : "开始修改"}</button></div> : <>
            {effectiveQuote ? <div className="publish-confirm">
              {quoteConsistent ? <>
                {agreement ? <details className="publish-terms"><summary>查看本次出租条款（{agreement.title}）</summary><div className="publish-terms-body">{agreement.body}</div></details> : <p className="supply-muted">本次条款正文尚未读取，暂不能确认上架。</p>}
                <label className="supply-check"><input type="checkbox" checked={agreementChecked} disabled={formDisabled || !agreement} onChange={(event) => setAgreementChecked(event.target.checked)} />我已阅读并同意本次出租条款与条件</label>
                <button type="button" className="button primary" disabled={primaryDisabled} onClick={() => void confirmPublish()}>{busy === "submit" ? "上架中…" : busy === "accept" ? "确认条款中…" : "确认上架"}</button>
              </> : null}
              <button type="button" className="button quiet" disabled={formDisabled} onClick={() => void quote()}>重新核对报价</button>
              {rulesAccepted ? <p className="supply-muted">条款已按当前版本确认；资料变化后需重新确认。</p> : null}
            </div> : <div className="publish-rail-actions">
              <button type="button" className="button primary" disabled={primaryDisabled} onClick={() => void quote()}>{primaryLabel}</button>
              <button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button>
              <p className="supply-muted">{canQuoteNow ? "核对报价后需明确同意本次条款，再确认上架。" : optionsAvailability === "unavailable" ? "当前游戏未配置出租规则，可先保存草稿。" : "规则与目录就绪后才能核对报价。"}</p>
            </div>}
          </>}
        </>}
      </aside>
    </div>
    <div className="publish-mobile-actions">
      <button type="button" className="button primary" disabled={mobileTermsPending ? false : primaryDisabled} onClick={mobileTermsPending ? showTerms : primaryAction}>{mobileTermsPending ? "查看报价与条款" : primaryLabel}</button>
      <button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button>
    </div>
  </ServiceShell>;
}




