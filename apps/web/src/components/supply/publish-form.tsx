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

import type {
  PublishFormProps,
  RegionOption,
  SessionId,
  MediaPurpose,
  IdentityState,
  RequestContext,
  AmmoReview,
  RetryTask,
  WriteIntent,
  DraftRequest,
  MediaCategory,
  MediaEntry,
  SkinQuery,
  PublishGroupId,
  OptionsAvailability,
  NavigationIntent,
  UiProblem,
  RecommendationInputs,
  RecommendationBinding,
} from "./publish-form-types";

import {
  ammoQuantityText,
  formatUnitPrice,
  ratioEntryProblem,
  inputsEqual,
  groupMeta,
  INSURANCE_EXPERIENCE_CARD,
  INVENTORY_ITEM_ART,
  emptyAttributes,
  emptyDraft,
  newKey,
  moneyText,
  durationText,
  stateLabel,
  mediaReviewLabel,
  is3x3SafeBoxCode,
  SYSTEM_ERROR_BLOCKER_CODES,
  FORM_ENTRY_BLOCKER_CODES,
  extraBlockerMessages,
  blockerText,
  localizedErrorMessage,
  fieldErrorText,
  publishGroupForPath,
  isAbort,
  meaningfulDraft,
  nextMediaPosition,
  inferNoticeKind,
  formatHaffChineseUnit,
  retiredInsuranceCode,
  numericChoiceOptions,
  retainedNumericChoiceNote,
  serviceTimeOptions,
} from "./publish-form-helpers";

import {
  FieldError,
  Notice,
  AgreementBody,
  SectionCard,
  PublishVisualBanner,
  FieldHelp,
  PendingValue,
  PublishingNotice,
  LoginPlatformIcon,
  InventoryIcon,
  NOTICE_READ_KEY,
} from "./publish-dialogs";

import { RegionPicker } from "./publish-region-picker";
import { PublishOutlineNav } from "./publish-outline-nav";
import { PublishAccountSection } from "./publish-account-section";
import { PublishAssetsSection } from "./publish-assets-section";
import { PublishMediaSection } from "./publish-media-section";
import { PublishTermsSection } from "./publish-terms-section";
import { PublishRail } from "./publish-rail";
import {
  TermsDialog,
  PayoutTermsDialog,
  PreviewMediaDialog,
  PublishSuccessDialog,
} from "./publish-dialog-modals";

// Required by publish-form-behavior.test.mjs:
// RENTAL_COMPLETED: "该账号已有已完成租约，当前规则不允许重新发布；请选择其他账号或联系客服。"
export { extraBlockerMessages } from "./publish-form-helpers";

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
      <PublishOutlineNav activeGroup={activeGroup} errorGroups={errorGroups} groupDone={groupDone} />

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
          <PublishAccountSection
            accountId={accountId}
            games={games}
            gameId={gameId}
            selectGame={selectGame}
            formDisabled={formDisabled}
            options={options}
            draft={draft}
            setDraft={setDraft}
            changeAttribute={changeAttribute}
            errorGroups={errorGroups}
            fieldError={fieldError}
            requireNewAccountFacts={requireNewAccountFacts}
            accountRequiredDone={accountRequiredDone}
            accountRequiredTotal={accountRequiredTotal}
            safeBoxChoiceOptions={safeBoxChoiceOptions}
            currentSafeBox={currentSafeBox}
            declarationOptions={declarationOptions}
            currentGrading={currentGrading}
            gradingOptions={gradingOptions}
            currentGradingDivision={currentGradingDivision}
            currentDivisions={currentDivisions}
            kdProblem={kdProblem}
            currentVitality={currentVitality}
            vitalityChoiceOptions={vitalityChoiceOptions}
            vitalityChoiceNote={vitalityChoiceNote}
            currentBear={currentBear}
            bearChoiceOptions={bearChoiceOptions}
            bearChoiceNote={bearChoiceNote}
            currentDive={currentDive}
            diveChoiceOptions={diveChoiceOptions}
            diveChoiceNote={diveChoiceNote}
            loginChoiceOptions={loginChoiceOptions}
            currentLoginMethod={currentLoginMethod}
            serviceWindowMode={serviceWindowMode}
            serviceWindowStart={serviceWindowStart}
            serviceWindowEnd={serviceWindowEnd}
            serviceWindowAllDay={serviceWindowAllDay}
            serviceWindowEqual={serviceWindowEqual}
            serviceWindowHasLegacyValue={serviceWindowHasLegacyValue}
            changeAllDay={changeAllDay}
            changeServiceWindow={changeServiceWindow}
            applyServiceWindowPreset={applyServiceWindowPreset}
          />

          <PublishAssetsSection
            hasError={errorGroups.has("assets")}
            ownerIncomePreviewPending={ownerIncomePreviewPending}
            resourcePreviewState={resourcePreviewState}
            resourceRows={resourceRows}
            draft={draft}
            ownerPreview={ownerPreview}
            ownerPreviewStale={ownerPreviewStale}
            formDisabled={formDisabled}
            is3x3SafeBoxSelected={is3x3SafeBoxSelected}
            changeInventory={changeInventory}
            setPendingResourceInputs={setPendingResourceInputs}
            setDraft={setDraft}
            missingResourceRows={missingResourceRows}
            inventoryFieldError={inventoryFieldError}
            captureContext={captureContext}
            identityStatusRef={identityStatusRef}
            currentContext={currentContext}
            requireAmmoReview={requireAmmoReview}
            skinTypes={skinTypes}
            selectedSkinCountForCategory={selectedSkinCountForCategory}
            activeSkinCategory={activeSkinCategory}
            clearSkinSearchTimer={clearSkinSearchTimer}
            setSkinCategory={setSkinCategory}
            setSkinOwner={setSkinOwner}
            loadSkinPage={loadSkinPage}
            skinFilters={skinFilters}
            catalog={catalog}
            skinQuery={skinQuery}
            setSkinQuery={setSkinQuery}
            loadingCatalog={loadingCatalog}
            gameId={gameId}
            skinSearchTimerRef={skinSearchTimerRef}
            skinFiltersRef={skinFiltersRef}
            skinOwners={skinOwners}
            skinOwner={skinOwner}
            skinRarity={skinRarity}
            setSkinRarity={setSkinRarity}
            skinName={skinName}
            skinPagePending={skinPagePending}
            skinPageFailed={skinPageFailed}
            skinQueryRef={skinQueryRef}
            activeSkinKind={activeSkinKind}
            visibleSkinRows={visibleSkinRows}
            selectedEntitlement={selectedEntitlement}
            changeEntitlement={changeEntitlement}
            fieldError={fieldError}
          />

          <PublishMediaSection
            hasError={errorGroups.has("media")}
            fieldError={fieldError("mediaBindings")}
            hasBanRecord={hasBanRecord}
            retainedPenaltyCount={retainedPenaltyCount}
            media={media}
            mediaDropActive={mediaDropActive}
            setMediaDropActive={setMediaDropActive}
            dragMediaId={dragMediaId}
            setDragMediaId={setDragMediaId}
            dragOverMediaId={dragOverMediaId}
            setDragOverMediaId={setDragOverMediaId}
            formDisabled={formDisabled}
            gameId={gameId}
            acceptFiles={acceptFiles}
            selectFiles={selectFiles}
            reorderMediaCard={reorderMediaCard}
            setPreviewMedia={setPreviewMedia}
            upload={upload}
            setCoverMedia={setCoverMedia}
            moveMedia={moveMedia}
            removeMedia={removeMedia}
          />

          <PublishTermsSection
            hasError={errorGroups.has("terms")}
            fieldError={fieldError}
            haffBaseIncomplete={haffBaseIncomplete}
            readOnly={readOnly}
            haffBaseMissing={haffBaseMissing}
            scrollToTarget={scrollToTarget}
            haffInventoryRow={haffInventoryRow}
            haffInput={haffInput}
            haffControlsDisabled={haffControlsDisabled}
            changeHaffM={changeHaffM}
            haffErrorMessage={haffErrorMessage}
            termAdjustmentText={termAdjustmentText}
            draft={draft}
            options={options}
            rentalMode={rentalMode}
            setDraft={setDraft}
            invalidateConfirmations={invalidateConfirmations}
            showPricingSelect={showPricingSelect}
            disabledPricing={disabledPricing}
            fastLocked={fastLocked}
            fastReady={fastReady}
            optionsAvailability={optionsAvailability}
            rentalModeEntries={rentalModeEntries}
            ratioRanges={ratioRanges}
            changeRentalMode={changeRentalMode}
            ratioInput={ratioInput}
            ratioInlineProblem={ratioInlineProblem}
            changeRatio={changeRatio}
            selectedRatioRange={selectedRatioRange}
            modeRange={modeRange}
            displayEstimateDuration={displayEstimateDuration}
            durationResult={durationResult}
            ratioKnown={ratioKnown}
            ratioResult={ratioResult}
            rentalModes={rentalModes}
            modeHref={modeHref}
            payoutSelected={payoutSelected}
            formDisabled={formDisabled}
            changeFullPayout={changeFullPayout}
            recommendation={recommendation}
            recommendationFresh={recommendationFresh}
            recommendationAdopted={recommendationAdopted}
            recommendationCatalogFresh={recommendationCatalogFresh}
            recommendationBinding={recommendationBinding}
            recommendationAmountYuan={recommendationAmountYuan}
            recommendationBusy={recommendationBusy}
            adoptRecommendation={adoptRecommendation}
            recommendDeposit={recommendDeposit}
            depositInput={depositInput}
            changeDeposit={changeDeposit}
            depositProblem={depositProblem}
            infoSourceOptions={infoSourceOptions}
            infoSourceValue={infoSourceValue}
            infoSourceLegacy={infoSourceLegacy}
            changeAttribute={changeAttribute}
          />
        </div>
      </form>

      <PublishRail
        railRef={railRef}
        railExpanded={railExpanded}
        setRailExpanded={setRailExpanded}
        effectiveQuote={effectiveQuote}
        ownerPreviewStale={ownerPreviewStale}
        ownerIncomePreviewPending={ownerIncomePreviewPending}
        railSummary={railSummary}
        published={published}
        readOnly={readOnly}
        accountId={accountId}
        netEstimate={netEstimate}
        breakdown={breakdown}
        previewGrossAmount={previewGrossAmount}
        payoutSelected={payoutSelected}
        ownerPreview={ownerPreview}
        pendingTotalHint={pendingTotalHint}
        displayEstimateDuration={displayEstimateDuration}
        resourceTotalText={resourceTotalText}
        declaredDepositCents={declaredDepositCents}
        depositInput={depositInput}
        actualPublisherRequirement={actualPublisherRequirement}
        catalog={catalog}
        supply={supply}
        quoteConsistent={quoteConsistent}
        visibleBlockers={visibleBlockers}
        userBlockers={userBlockers}
        systemBlockers={systemBlockers}
        busy={busy}
        formDisabled={formDisabled}
        refreshLatest={refreshLatest}
        agreement={agreement}
        currentPayoutTerms={currentPayoutTerms}
        payoutTerms={payoutTerms}
        payoutTarget={payoutTarget}
        mustCreateAccount={mustCreateAccount}
        reviewState={reviewState}
        identityState={identityState}
        identityRef={identityRef}
        beginEditing={beginEditing}
        agreementConsent={agreementConsent}
        payoutConsent={payoutConsent}
        primaryDisabled={primaryDisabled}
        blockerHint={blockerHint}
        confirmPublish={confirmPublish}
        primaryLabel={primaryLabel}
        save={save}
        rulesAccepted={rulesAccepted}
        primaryAction={primaryAction}
      />
    </div>

    <TermsDialog
      open={termsModalOpen}
      onOpenChange={setTermsModalOpen}
      agreement={agreement}
      formDisabled={formDisabled}
      onAccept={() => {
        setAgreementChecked(true);
        setTermsModalOpen(false);
      }}
    />

    <PayoutTermsDialog
      open={payoutTermsModalOpen}
      onOpenChange={setPayoutTermsModalOpen}
      currentPayoutTerms={currentPayoutTerms}
      formDisabled={formDisabled}
      onAccept={() => {
        setPayoutAccepted(true);
        setPayoutTermsModalOpen(false);
      }}
    />

    <PreviewMediaDialog
      previewMedia={previewMedia}
      onClose={() => setPreviewMedia(null)}
    />

    <PublishSuccessDialog
      open={publishSuccessOpen}
      onOpenChange={setPublishSuccessOpen}
      successCountdown={successCountdown}
      onNavigateToAccounts={() => {
        setPublishSuccessOpen(false);
        router.push("/account?view=accounts");
      }}
    />
  </ServiceShell>;
}




