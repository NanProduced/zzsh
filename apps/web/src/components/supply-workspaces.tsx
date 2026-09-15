"use client";

import Link from "next/link";
import { publishUserSessionChange, useUserSession, useUserSessionStore } from "./session/user-session-provider";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertCircle, Check, FileImage, LockKeyhole, Pause, Play, RefreshCw, Send, Trash2, Undo2, Upload } from "lucide-react";
import { ServiceShell } from "./layout/service-shell";
import { AuthForm, WebAuthError, maskPhone, webAuthRequest } from "./auth/auth-form";
import { accountStatusLabel, cancellationFailureMessage, type UserIdentitySnapshot } from "@/app/user-account-status";
import { FavoritesPanel } from "./favorites/favorites-panel";
import { FavoritesProvider } from "./favorites/favorites-context";
import { groupForField, editableDeclaration, supplyApi, supplyBlockerMessages, supplyGroups, SupplyRequestError, uploadSupplyMedia } from "../lib/supply-client";
import { freezeRequest, IdentityPauseGate, isCurrentQuery, mergePageById } from "../lib/supply-workspace-guards";
import type { SupplyGroup } from "../lib/supply-client";
import type { DraftInput, MySupply, OwnerQuote, PublishingCatalog, PublishingOptions, SupplyGame } from "../lib/supply-types";
import type { PublishMode } from "../lib/service-navigation";

type PublishFormProps = { mode: PublishMode; accountId?: string; editRequested?: boolean };
type SessionId = string | null | undefined;
type MediaPurpose = "ACCOUNT_DISPLAY" | "ACCOUNT_EVIDENCE";
type IdentityState = "checking" | "confirmed" | "failed";
type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };
type DraftRequest = { context: RequestContext; accountId: string; body: DraftInput & { expectedRevision: string }; key: string };
type MediaEntry = {
  id: string;
  purpose: MediaPurpose;
  file?: File;
  assetId?: string;
  reviewState?: string;
  publicDisplayEligible?: boolean;
  publiclyReadable?: boolean;
  bindingSaved: boolean;
  status: "uploading" | "bound" | "failed";
  intentKey: string;
  uploadKey: string;
  error?: string;
  context: RequestContext;
};
type SkinQuery = { q?: string; categoryId?: string; rarityCode?: string; cursor?: string };

const groupMeta: Record<Exclude<SupplyGroup, "form">, { id: Exclude<SupplyGroup, "form">; label: string }> = {
  basics: { id: "basics", label: "基本资料" },
  inventory: { id: "inventory", label: "资源数量" },
  skins: { id: "skins", label: "皮肤分类" },
  entitlements: { id: "entitlements", label: "权益有效期" },
  media: { id: "media", label: "图片凭证" },
  rules: { id: "rules", label: "租期与协议" },
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

function moneyText(money: OwnerQuote["ownerTotal"] | null | undefined): string {
  return money ? `${money.amount} ${money.currency === "CNY" ? "元" : money.currency}` : "未配置";
}

function unitText(unit: string): string {
  return ({ HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件" } as Record<string, string>)[unit] ?? "单位待核";
}

function quantityText(value: string | null | undefined, unit: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return "未配置";
  return `${normalized.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${unitText(unit)}`;
}

function durationText(seconds: string | number | null | undefined): string {
  const value = typeof seconds === "string" ? Number(seconds) : seconds;
  if (!value || !Number.isFinite(value)) return "未配置";
  if (value % 86400 === 0) return `${value / 86400} 天`;
  if (value % 3600 === 0) return `${value / 3600} 小时`;
  if (value % 60 === 0) return `${value / 60} 分钟`;
  if (value > 60) return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
  return `${value} 秒`;
}

function stateLabel(state: MySupply["version"] extends infer V ? V extends { reviewState: infer S } ? S : never : never): string {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    SUBMITTED: "审核中",
    WITHDRAWN: "已撤回",
    REJECTED: "已退回",
    APPROVED: "已通过",
    IMPORTED_UNVERIFIED: "待复核",
  };
  return labels[String(state)] ?? "未确认";
}

function mediaReviewLabel(state: string | undefined): string {
  return ({ PENDING: "待审核", APPROVED: "审核通过", REJECTED: "审核退回" } as Record<string, string>)[state ?? ""] ?? "状态待核";
}

function blockerText(code: string): string {
  return supplyBlockerMessages[code] ?? "当前资料暂不能继续，请读取最新状态或稍后重试。";
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "未申报";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间信息暂不可用" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function localDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    Object.values(draft.attributes).some((value) => value !== null),
  );
}

function nextMediaPosition(bindings: DraftInput["mediaBindings"]): number {
  const used = new Set(bindings.map((binding) => binding.position));
  let position = 0;
  while (used.has(position)) position += 1;
  return position;
}

function mergeInventory(draft: DraftInput, catalog: PublishingCatalog | null): DraftInput["inventory"] {
  if (!catalog) return draft.inventory;
  const known = new Map(draft.inventory.map((item) => [item.itemId, item.quantity]));
  const ids = new Set(catalog.items.map((item) => item.id));
  return [
    ...catalog.items
      .map((item) => ({ itemId: item.id, quantity: known.get(item.id) ?? null }))
      .filter((item) => item.quantity !== null),
    ...draft.inventory.filter((item) => !ids.has(item.itemId) && item.quantity !== null),
  ];
}


function FieldError({ text }: { text?: string }) {
  return text ? <span className="supply-field-error" role="alert">{text}</span> : null;
}

function Notice({ error, text }: { error?: SupplyRequestError | null; text?: string }) {
  if (!error && !text) return null;
  return <div className={`supply-notice ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
    {error ? <AlertCircle size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
    <span>{error ? error.message : text}</span>
  </div>;
}

function GroupNav({ errors }: { errors: string[] }) {
  return <nav className="supply-group-nav" aria-label="发布资料分组导航">
    {supplyGroups.map((group) => {
      const hasError = errors.some((path) => groupForField(path) === group);
      return <a key={group} href={`#${group}`} className={hasError ? "has-error" : undefined}>
        {groupMeta[group]?.label ?? group}{hasError ? <span aria-label="有错误">!</span> : null}
      </a>;
    })}
  </nav>;
}

export function PublishForm({ mode, accountId: accountIdProp, editRequested = false }: PublishFormProps) {
  const router = useRouter();
  const sharedSession = useUserSessionStore();
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
  const skinRequestRef = useRef(0);
  const skinQueryRef = useRef({ gameId: "", key: "" });
  const supplyRef = useRef<MySupply | null>(null);
  const draftRef = useRef<DraftInput>(emptyDraft());
  const uploadQueue = useRef(Promise.resolve());
  const cancelledMedia = useRef(new Set<string>());

  const [games, setGames] = useState<SupplyGame[]>([]);
  const [gamesLoaded, setGamesLoaded] = useState(false);
  const [gameId, setGameId] = useState("");
  const [identityState, setIdentityState] = useState<IdentityState>("checking");
  const [accountId, setAccountId] = useState<string | undefined>(accountIdProp);
  const [supply, setSupply] = useState<MySupply | null>(null);
  const [draft, setDraftState] = useState<DraftInput>(emptyDraft);
  const [options, setOptions] = useState<PublishingOptions | null>(null);
  const [catalog, setCatalog] = useState<PublishingCatalog | null>(null);
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
  const invalidateContext = useCallback((message: string, requireAuth: boolean, resetGame = true) => {
    epochRef.current += 1;
    identityPauseGate.current.cancelWaiters();
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    pendingKeys.current.clear();
    lastRetry.current = null;
    uploadQueue.current = Promise.resolve();
    accountRef.current = undefined;
    loadedAccountRef.current = undefined;
    supplyRef.current = null;
    draftRef.current = emptyDraft();
    setAccountId(undefined);
    setSupply(null);
    setDraftState(emptyDraft());
    setMedia([]);
    cancelledMedia.current.clear();
    setEditing(false);
    setServerSnapshot(null);
    setDraftDirty(false);
    setAgreementChecked(false);
    setRulesAccepted(false);
    setBusy("");
    setAuthRequired(requireAuth);
    setError(null);
    setNotice(message);
    setLoadingAccount(false);
    setLoadingCatalog(false);
    if (resetGame) {
      gameRef.current = "";
      setGameId("");
      setGames([]);
      setOptions(null);
      setCatalog(null);
      setSkinNames({});
      skinQueryRef.current = { gameId: "", key: "" };
    }
  }, []);
  const applySupply = useCallback((next: MySupply, loadDraft: boolean, replaceMedia = false) => {
    supplyRef.current = next;
    setSupply(next);
    if (loadDraft && next.version) {
      const nextDraft = editableDeclaration(next.version.declaration);
      draftRef.current = nextDraft;
      setDraftState(nextDraft);
      setEditing(next.version.reviewState === "DRAFT");
    }
    if (replaceMedia) {
      const bindings = next.version?.declaration.mediaBindings ?? [];
      setMedia(bindings.map((binding, index) => ({
        id: `bound-${binding.assetId}-${index}`,
        purpose: binding.purpose,
        reviewState: binding.reviewState,
        publicDisplayEligible: binding.publicDisplayEligible,
        publiclyReadable: binding.publiclyReadable,
        assetId: binding.assetId,
        bindingSaved: true,
        context: { epoch: epochRef.current, identity: identityRef.current, accountId: next.account.id, gameId: next.account.game_id },
        status: "bound",
        intentKey: "",
        uploadKey: "",
      })));
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
    if (nextError.status === 409) void refreshLatest(false);
  }, [currentContext, refreshLatest]);

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
      cancelledMedia.current.clear();
      identityPauseGate.current.cancel();
      unsubscribeIdentity();
    };
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
        setGames(result.games);
        setGamesLoaded(true);
        let selected = result.games[0]?.id ?? "";
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
           }
           setDraftDirty(false);
          setMedia((loaded.version?.declaration.mediaBindings ?? []).map((binding, index) => ({
            id: `bound-${binding.assetId}-${index}`,
            purpose: binding.purpose,
        reviewState: binding.reviewState,
        publicDisplayEligible: binding.publicDisplayEligible,
        publiclyReadable: binding.publiclyReadable,
             assetId: binding.assetId,
             bindingSaved: true,
             context: { epoch: epochRef.current, identity: identityRef.current, accountId: loaded.account.id, gameId: loaded.account.game_id },
             status: "bound",
            intentKey: "",
            uploadKey: "",
          })));
          if (editRequested && loaded.version?.reviewState !== "SUBMITTED") setNotice("点击“开始修改”后，会按当前版本创建可编辑草稿。");
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
  }, [accountIdProp, editRequested, identityState, invalidateContext, reportFailure, waitForIdentity]);

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
      setSkinNames((previous) => Object.fromEntries([
        ...Object.entries(previous),
        ...page.skins.map((skin) => [skin.id, skin.name] as const),
      ]));
      setCatalog((previous) => {
        if (!append || !previous) return page;
        const existing = new Set(previous.skins.map((skin) => skin.id));
        return { ...page, skins: [...previous.skins, ...page.skins.filter((skin) => !existing.has(skin.id))] };
      });
    } catch (failure) {
      if (currentContext(context, controller.signal) && isCurrent()) reportFailure(failure, () => loadSkinPage(query, append), context, "catalog");
    } finally {
      if (currentContext(context, controller.signal) && isCurrent()) setLoadingCatalog(false);
      finishRequest(controller);
    }
  }, [currentContext, gameId, reportFailure, waitForIdentity]);

  const loadCatalog = useCallback(async (requestedGameId = gameId) => {
    if (!requestedGameId) return;
    const requestId = ++skinRequestRef.current;
    const queryKey = JSON.stringify({ q: "", categoryId: "", rarityCode: "" });
    skinQueryRef.current = { gameId: requestedGameId, key: queryKey };
    const context = captureContext(accountRef.current, requestedGameId);
    const controller = beginRequest();
    setOptions(null);
    setCatalog(null);
    setSkinNames({});
    setLoadingCatalog(true);
    try {
      if (!(await waitForIdentity(context))) return;
      const [nextOptions, nextCatalog] = await Promise.all([
        supplyApi.publishingOptions(requestedGameId, controller.signal),
        supplyApi.catalog(requestedGameId, new URLSearchParams({ limit: "30" }), controller.signal),
      ]);
      if (!currentContext(context, controller.signal) || !isCurrentQuery({ id: requestId, key: `${requestedGameId}:${queryKey}` }, skinRequestRef.current, `${skinQueryRef.current.gameId}:${skinQueryRef.current.key}`)) return;
      setOptions(nextOptions);
      setCatalog(nextCatalog);
      setSkinNames(Object.fromEntries(nextCatalog.skins.map((skin) => [skin.id, skin.name])));
      setDraftState((previous) => {
        const next = { ...previous, attributes: { ...previous.attributes } };
        if (!next.termOptionCode && nextOptions.termOptions[0]) next.termOptionCode = nextOptions.termOptions[0].code;
        if (!next.pricingOptionCode && nextOptions.pricingOptionCodes[0]) next.pricingOptionCode = nextOptions.pricingOptionCodes[0];
        draftRef.current = next;
        return next;
      });
    } catch (failure) {
      if (currentContext(context, controller.signal) && isCurrentQuery({ id: requestId, key: `${requestedGameId}:${queryKey}` }, skinRequestRef.current, `${skinQueryRef.current.gameId}:${skinQueryRef.current.key}`)) reportFailure(failure, () => loadCatalog(requestedGameId), context, "catalog");
    } finally {
      if (currentContext(context, controller.signal) && isCurrentQuery({ id: requestId, key: `${requestedGameId}:${queryKey}` }, skinRequestRef.current, `${skinQueryRef.current.gameId}:${skinQueryRef.current.key}`)) setLoadingCatalog(false);
      finishRequest(controller);
    }
  }, [currentContext, gameId, reportFailure, waitForIdentity]);

  useEffect(() => {
    if (!gameId || identityStatusRef.current !== "confirmed") return;
    setSkinQuery("");
    setSkinCategory("");
    setSkinRarity("");
    void loadCatalog();
  }, [gameId, identityState, loadCatalog]);

  const setDraft = (next: DraftInput | ((previous: DraftInput) => DraftInput)) => {
    setDraftState((previous) => {
      const value = typeof next === "function" ? next(previous) : next;
      draftRef.current = value;
      return value;
    });
    setDraftDirty(true);
    setAgreementChecked(false);
    setRulesAccepted(false);
    setSupply((previous) => {
      const value = previous?.version?.quote ? { ...previous, version: { ...previous.version, quote: null, contentHash: null, releaseId: null } } : previous;
      supplyRef.current = value;
      return value;
    });
    setError(null);
    lastRetry.current = null;
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
        if (failure instanceof SupplyRequestError && failure.status === 0 && currentContext(context, signal)) rememberRetry(context, retryBusy, retryAfterReady ?? (() => prepareAndRetry(context, retryBusy)));
        throw failure;
      }
      if (!currentContext(context, signal) || !(await waitForIdentity(context))) return null;
      completeKey("create-account", accountBody);
      id = created.accountId;
      accountRef.current = id;
      loadedAccountRef.current = id;
      setAccountId(id);
      router.replace(`/publish?${mode === "fast" ? "mode=fast&" : ""}accountId=${encodeURIComponent(id)}`);
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
        if (failure instanceof SupplyRequestError && failure.status === 0 && currentContext(context, signal)) rememberRetry(context, retryBusy, retryAfterReady ?? (() => prepareAndRetry(context, retryBusy)));
        throw failure;
      }
      if (!currentContext(context, signal) || !(await waitForIdentity(context))) return null;
      completeKey("create-draft", { accountId: id, ...body });
      currentSupply = next;
      if (!meaningfulDraft(draftRef.current)) {
        const nextDraft = editableDeclaration(next.version!.declaration);
        draftRef.current = nextDraft;
        setDraftState(nextDraft);
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

  const prepareDraftRequest = async (context: RequestContext, retryBusy: string, retryAfterReady?: () => Promise<void>): Promise<DraftRequest | null> => {
    const controller = beginRequest();
    try {
      const ready = await ensureReady(context, controller.signal, retryBusy, retryAfterReady);
      const id = accountRef.current;
      if (!ready || !id || !currentContext(context, controller.signal)) return null;
      const source = draftRef.current;
      const body: DraftInput & { expectedRevision: string } = {
        title: source.title,
        description: source.description?.trim() || null,
        attributes: { ...source.attributes },
        termOptionCode: source.termOptionCode,
        pricingOptionCode: source.pricingOptionCode,
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
      lastRetry.current = null;
      return saved;
    } catch (failure) {
      if (failure instanceof SupplyRequestError && failure.status === 0 && currentContext(request.context, controller.signal)) rememberRetry(request.context, retryBusy, retryAfterUnknown ?? (() => sendDraftRequest(request, retryBusy).then(() => undefined)));
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
      lastRetry.current = null;
      setNotice("报价已更新，请核对租期、金额与有效期说明。");
    } catch (failure) {
      if (failure instanceof SupplyRequestError && failure.status === 0 && currentContext({ ...context, accountId: id }, controller.signal)) rememberRetry({ ...context, accountId: id }, retryBusy, () => sendQuoteRequest(context, saved, retryBusy));
      throw failure;
    } finally {
      finishRequest(controller);
    }
  };

  const runQuoteAfterSave = async (request: DraftRequest, retryBusy: string): Promise<void> => {
    const saved = await sendDraftRequest(request, retryBusy, () => runQuoteAfterSave(request, retryBusy));
    if (saved && currentContext({ ...request.context, accountId: request.accountId })) await sendQuoteRequest(request.context, saved, retryBusy);
  };

  const saveWithContext = async (context: RequestContext): Promise<void> => {
    const request = await prepareDraftRequest(context, "save", () => saveWithContext(context));
    if (request) await runSaveRequest(request, "save");
  };

  const quoteWithContext = async (context: RequestContext): Promise<void> => {
    const request = await prepareDraftRequest(context, "quote", () => quoteWithContext(context));
    if (request) await runQuoteAfterSave(request, "quote");
  };

  const save = async () => {
    const context = captureContext();
    setBusy("save");
    setError(null);
    try {
      await saveWithContext(context);
    } catch (failure) {
      reportFailure(failure, undefined, context, "save");
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };

  const quote = async () => {
    const context = captureContext();
    setBusy("quote");
    setError(null);
    try {
      await quoteWithContext(context);
    } catch (failure) {
      reportFailure(failure, undefined, context, "quote");
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
      lastRetry.current = null;
      onSuccess(next);
    } catch (failure) {
      if (failure instanceof SupplyRequestError && failure.status === 0 && currentContext(context, controller.signal)) rememberRetry(context, retryBusy, () => sendConfirmRequest(action, context, body, key, retryBusy, onSuccess));
      throw failure;
    } finally {
      finishRequest(controller);
    }
  };

  const acceptRules = async () => {
    if (!agreementChecked) {
      setNotice("请先勾选协议确认。");
      return;
    }
    const currentToken = token();
    if (!currentToken) {
      setNotice("请先获取当前资料的报价。");
      return;
    }
    setBusy("accept");
    setError(null);
    const context = captureContext(currentToken.id);
    const body = { expectedRevision: currentToken.expectedRevision, versionId: currentToken.versionId, releaseId: currentToken.releaseId, contentHash: currentToken.contentHash };
    try {
      const keyBody = { accountId: currentToken.id, ...body };
      const frozen = freezeRequest(body, keyFor("accept-rules", keyBody));
      await sendConfirmRequest("accept-rules", context, frozen.body, frozen.key, "accept", (accepted) => {
        applySupply(accepted, true);
        setDraftDirty(false);
        setRulesAccepted(true);
        setNotice("协议已按当前版本确认；若资料改变，需要重新报价并确认。");
      });
    } catch (failure) {
      reportFailure(failure, undefined, context, "accept");
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };

  const submit = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!rulesAccepted) {
      setNotice("请先完成报价后的规则与协议确认。");
      return;
    }
    const currentToken = token();
    if (!currentToken) {
      setNotice("当前报价已失效，请重新获取报价。");
      return;
    }
    setBusy("submit");
    setError(null);
    const context = captureContext(currentToken.id);
    const body = { expectedRevision: currentToken.expectedRevision, versionId: currentToken.versionId, releaseId: currentToken.releaseId, contentHash: currentToken.contentHash };
    try {
      const keyBody = { accountId: currentToken.id, ...body };
      const frozen = freezeRequest(body, keyFor("submit", keyBody));
      await sendConfirmRequest("submit", context, frozen.body, frozen.key, "submit", (submitted) => {
        applySupply(submitted, false);
        setDraftDirty(false);
        setEditing(false);
        setNotice("资料已提交审核；审核完成前不能直接编辑此版本。");
      });
    } catch (failure) {
      reportFailure(failure, undefined, context, "submit");
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };

  const changeAttribute = (key: string, value: string | number | boolean | null) => {
    setDraft((previous) => ({ ...previous, attributes: { ...previous.attributes, [key]: value } }));
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
      const expiry = expiryKind === "TIMED" && expiresAt ? new Date(expiresAt).toISOString() : null;
      next.push({ entitlementId, value: value === undefined ? true : Number.isNaN(numeric) ? null : numeric, expiresAt: expiry, expiryKnowledge: expiryKind === "TIMED" && !expiry ? "UNKNOWN" : "KNOWN" });
      return { ...previous, entitlements: next };
    });
  };
  const selectedEntitlement = (id: string) => draft.entitlements.find((item) => item.entitlementId === id);
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
      setNotice(`${entry.purpose === "ACCOUNT_DISPLAY" ? "公开展示图" : "私有凭证"}已上传到当前资料，保存草稿后才会正式绑定；当前审核状态：${mediaReviewLabel(result.reviewState)}。`);
      lastRetry.current = null;
    } catch (failure) {
      if (cancelledMedia.current.has(entry.id)) return;
      if (currentContext(context, controller.signal)) {
        setMedia((previous) => previous.map((item) => item.id === entry.id ? { ...item, status: "failed", error: failure instanceof SupplyRequestError ? failure.message : "上传未完成" } : item));
        if (failure instanceof SupplyRequestError && failure.status === 0) rememberRetry(context, "upload", () => upload(entry, context));
        reportFailure(failure, undefined, context, "upload");
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
      const entry: MediaEntry = { id: entryId, purpose, file, status: "failed", intentKey: newKey(), uploadKey: newKey(), bindingSaved: false, context };
      setMedia((previous) => [...previous, entry]);
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
    setMedia((previous) => previous.filter((item) => item.id !== entryId));
    setDraft((previous) => {
      if (!entry.assetId) return previous;
      const remaining = previous.mediaBindings.filter((binding) => binding.assetId !== entry.assetId);
      return { ...previous, mediaBindings: remaining.map((binding, position) => ({ ...binding, position })) };
    });
    setNotice("图片已从本次发布资料移除；已上传对象不会被删除，重新保存后按新声明审核。");
  };

  const selectGame = (nextGameId: string) => {
    if (nextGameId === gameId) return;
    if ((meaningfulDraft(draftRef.current) || media.length) && !window.confirm("切换游戏会清空当前未保存资料，确定继续吗？")) return;
    invalidateContext("已切换游戏，请重新填写发布资料。", false, false);
    gameRef.current = nextGameId;
    setGameId(nextGameId);
    setOptions(null);
    setCatalog(null);
    setSkinNames({});
    skinQueryRef.current = { gameId: "", key: "" };
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
      reportFailure(failure, undefined, context, "edit");
    } finally {
      if (currentContext(context)) setBusy("");
    }
  };

  if (identityState === "checking") return <ServiceShell title={mode === "fast" ? "上架出租 · 极速模式" : "上架出租"} description="填写公开账号资料与出租条件；价格、规则和资格以当前结果为准。"><section className="account-guest" aria-busy="true"><LockKeyhole size={30} /><h2>正在确认登录身份</h2><p>确认期间暂不展示私人发布资料，也不会继续发送保存、报价或上传请求。</p></section></ServiceShell>;
  if (identityState === "failed") return <ServiceShell title={mode === "fast" ? "上架出租 · 极速模式" : "上架出租"} description="填写公开账号资料与出租条件；价格、规则和资格以当前结果为准。"><section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>暂时无法确认登录身份</h2><p>私人发布资料仍保留在本页，确认恢复后可继续；当前不会发送新的保存、报价或上传请求。</p><button type="button" className="button secondary" onClick={() => void sharedSession.confirm()}>重试身份确认</button></section></ServiceShell>;

  if (!accountIdProp && gamesLoaded && games.length === 0) return <ServiceShell title="上架出租" description="填写账号资料并提交审核。"><section className="account-guest"><h2>暂未开放上架</h2><p>目前没有开放出租的游戏，请稍后再来。</p><Link className="button secondary" href="/">返回首页</Link></section></ServiceShell>;

  const fieldErrors = error?.details ?? [];
  const fieldError = (path: string) => {
    const item = fieldErrors.find((candidate) => candidate.path === path || candidate.path.startsWith(`${path}.`) || candidate.path.startsWith(`${path}[`));
    return item ? fieldErrorText(path, item.code) : undefined;
  };
  const blockers = [...(catalog?.blockers ?? []), ...(supply?.blockers ?? [])].map((item) => typeof item === "string" ? item : item.code);
  const quoteData = supply?.version?.quote;
  const agreement = supply?.agreement ?? options?.agreement ?? null;
  const readOnly = Boolean(accountId && !editing);
  const formDisabled = identityState !== "confirmed" || !identityRef.current || readOnly || Boolean(busy);
  const reviewState = supply?.version?.reviewState;
  const boundDisplay = media.filter((item) => item.purpose === "ACCOUNT_DISPLAY");
  const boundEvidence = media.filter((item) => item.purpose === "ACCOUNT_EVIDENCE");
  const categoryNames = new Map((catalog?.categories ?? []).map((item) => [item.id, item.name]));
  const rarityNames = new Map((catalog?.rarities ?? []).map((item) => [item.code, item.name]));
  const mediaStatusText = (item: MediaEntry) => item.status === "uploading"
    ? "上传中…"
    : item.status === "failed"
      ? item.error ?? "上传未完成"
      : item.reviewState
        ? `${item.bindingSaved ? "已保存" : "已上传，待保存"} · ${mediaReviewLabel(item.reviewState)}${item.publiclyReadable ? " · 当前公开展示" : item.publicDisplayEligible ? " · 图片可展示，账号尚未公开" : ""}`
        : item.bindingSaved ? "已保存，审核状态待核" : "已上传，待保存；审核状态待核";

  return <ServiceShell title={mode === "fast" ? "上架出租 · 极速模式" : "上架出租"} description="填写公开账号资料与出租条件；价格、规则和资格以当前结果为准。">
    <form className="publish-form supply-workspace" onSubmit={submit}>
      <div className="publish-mode"><Link href="/publish" aria-current={mode === "standard" ? "page" : undefined}>普通出租</Link><Link href="/publish?mode=fast" aria-current={mode === "fast" ? "page" : undefined}>极速出租</Link></div>
      <div className="supply-toolbar"><span>{accountId ? `资料状态：${reviewState ? stateLabel(reviewState) : "未创建草稿"}` : "尚未保存草稿"}</span><span>{options ? "当前规则已读取" : "正在读取规则…"}</span></div>
      {authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>此操作需要登录并确认当前身份。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent(accountId ? `/publish?accountId=${accountId}` : "/publish")}`}>登录 / 注册</Link></div> : null}
      <Notice error={error} text={notice} />
       {error?.status === 409 && serverSnapshot ? <div className="supply-conflict" role="alert"><strong>资料状态已变化</strong><p>已保留本页输入，没有自动覆盖。当前资料状态为 {serverSnapshot.version ? stateLabel(serverSnapshot.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" onClick={() => void refreshLatest(false)}>重新读取最新状态</button><button type="button" className="button secondary" onClick={() => void refreshLatest(true)}>采用最新资料</button></div></div> : null}
       {error?.status === 0 && lastRetry.current ? <div className="supply-conflict"><strong>结果未知</strong><p>本页没有自动重复操作。请重试当前步骤；如需修改内容，请先完成重试后再保存。</p><button type="button" className="button secondary" onClick={() => void retryLast()}>重试当前步骤</button></div> : null}
      {readOnly ? <div className="supply-readonly" role="status"><strong>当前版本不可直接编辑</strong><span>审核中的版本请先撤回；已通过或已退回的版本会在你明确开始修改后创建新草稿。</span><button type="button" className="button secondary" disabled={identityState !== "confirmed" || !identityRef.current || Boolean(busy)} onClick={() => void beginEditing()}>{busy === "edit" ? "准备草稿中…" : "开始修改"}</button></div> : null}
      <GroupNav errors={fieldErrors.map((item) => item.path)} />

      <section id="basics" className="supply-section" aria-labelledby="basics-heading">
        <div className="supply-section-heading"><div><h2 id="basics-heading">基本资料</h2><p>只填写可公开展示和可校验的账号属性，不上传密码或私密凭证。</p></div></div>
        <div className="supply-grid">
          <label>游戏<select value={gameId} disabled={Boolean(accountId) || formDisabled} onChange={(event) => selectGame(event.target.value)}><option value="">选择游戏</option>{games.map((game) => <option key={game.id} value={game.id}>{game.name}</option>)}</select></label>
          <label>账号名称<input maxLength={120} value={draft.title} disabled={formDisabled} aria-invalid={Boolean(fieldError("title"))} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：满仓哈夫币·多套护甲" /> <FieldError text={fieldError("title")} /></label>
          <label className="supply-wide">公开说明<textarea rows={5} maxLength={4000} value={draft.description ?? ""} disabled={formDisabled} aria-invalid={Boolean(fieldError("description"))} onChange={(event) => setDraft({ ...draft, description: event.target.value || null })} placeholder="描述资源组成、使用限制和可提供的服务窗口" /><FieldError text={fieldError("description")} /></label>
          <label>安全箱档位<select value={String(draft.attributes.safe_box_code ?? "")} disabled={formDisabled || !options} onChange={(event) => changeAttribute("safe_box_code", event.target.value || null)}><option value="">未申报</option>{options?.safeBoxCodes.map((code, index) => <option key={code} value={code}>安全箱档位 {index + 1}</option>)}</select><small>受控选项；未知值保持未申报。</small></label>
          <label>活力等级<select value={String(draft.attributes.vit_level ?? "")} disabled={formDisabled || !options} onChange={(event) => changeAttribute("vit_level", event.target.value ? Number(event.target.value) : null)}><option value="">未申报</option>{options?.vitalityLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
          <label>负重等级<select value={String(draft.attributes.bear_level ?? "")} disabled={formDisabled || !options} onChange={(event) => changeAttribute("bear_level", event.target.value ? Number(event.target.value) : null)}><option value="">未申报</option>{options?.bearLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
          <label>潜水等级<input inputMode="numeric" value={String(draft.attributes.dive_level ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("dive_level", event.target.value ? Number.parseInt(event.target.value, 10) : null)} placeholder="未申报" /></label>
          <label>角色等级<input inputMode="numeric" value={String(draft.attributes.character_level ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("character_level", event.target.value ? Number.parseInt(event.target.value, 10) : null)} placeholder="未申报" /></label>
          <label>大武器数量<input inputMode="numeric" value={String(draft.attributes.awm_weapon_count ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("awm_weapon_count", event.target.value ? Number.parseInt(event.target.value, 10) : null)} placeholder="未申报" /></label>
          <label>段位说明<input value={String(draft.attributes.grading_code ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("grading_code", event.target.value || null)} placeholder="未申报" /></label>
          <label>登录方式<input value={String(draft.attributes.login_method_code ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("login_method_code", event.target.value || null)} placeholder="未申报" /></label>
          <label>所在省份<input value={String(draft.attributes.region_province ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("region_province", event.target.value || null)} placeholder="未申报" /></label>
          <label>所在城市<input value={String(draft.attributes.region_city ?? "")} disabled={formDisabled} onChange={(event) => changeAttribute("region_city", event.target.value || null)} placeholder="未申报" /></label>
          <label>有无封禁记录<select value={draft.attributes.ban_record === null ? "" : String(draft.attributes.ban_record)} disabled={formDisabled} onChange={(event) => changeAttribute("ban_record", event.target.value === "" ? null : event.target.value === "true")}><option value="">未申报</option><option value="false">无</option><option value="true">有</option></select></label>
          <label>实名主体是否本人<select value={draft.attributes.face_is_self === null ? "" : String(draft.attributes.face_is_self)} disabled={formDisabled} onChange={(event) => changeAttribute("face_is_self", event.target.value === "" ? null : event.target.value === "true")}><option value="">未申报</option><option value="true">是</option><option value="false">否</option></select></label>
        </div>
      </section>

       <section id="inventory" className="supply-section" aria-labelledby="inventory-heading">
         <div className="supply-section-heading"><div><h2 id="inventory-heading">资源数量</h2><p>按目录标明的单位填写整数数量；空白代表尚未申报，不会被前端替换为 0。</p></div></div>
        {catalog?.blockers.length ? <div className="supply-blockers">{catalog.blockers.map((item) => <p key={`${item.code}-${item.itemId}`}>{blockerText(item.code)}{item.name ? `：${item.name}` : ""}</p>)}</div> : null}
         <div className="supply-table-wrap"><table className="supply-table"><thead><tr><th scope="col">资源</th><th scope="col">单位</th><th scope="col">数量</th></tr></thead><tbody>{catalog?.items.map((item) => { const quantity = draft.inventory.find((row) => row.itemId === item.id)?.quantity ?? ""; return <tr key={item.id}><th scope="row">{item.name}{item.required ? <small>必填</small> : null}</th><td>{unitText(item.unit)}</td><td><input className="supply-quantity" inputMode="numeric" pattern="[0-9]*" maxLength={24} value={quantity ?? ""} disabled={formDisabled} aria-label={`${item.name}数量`} onChange={(event) => changeInventory(item.id, event.target.value)} /></td></tr>; })}</tbody></table></div>
        {!catalog && loadingCatalog ? <p className="supply-muted">正在读取发布目录…</p> : null}
      </section>

      <section id="skins" className="supply-section" aria-labelledby="skins-heading">
         <div className="supply-section-heading"><div><h2 id="skins-heading">皮肤分类</h2><p>用于展示和筛选，不参与额外加价。选择结果由当前目录校验。</p></div></div>
        <div className="supply-filter-row"><label>搜索皮肤<input value={skinQuery} disabled={formDisabled} onChange={(event) => setSkinQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void loadSkinPage({ q: skinQuery.trim(), categoryId: skinCategory, rarityCode: skinRarity }, false); } }} placeholder="输入名称后按 Enter" /></label><label>分类<select value={skinCategory} disabled={formDisabled} onChange={(event) => { setSkinCategory(event.target.value); void loadSkinPage({ q: skinQuery.trim(), categoryId: event.target.value, rarityCode: skinRarity }, false); }}><option value="">全部分类</option>{catalog?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>稀有度<select value={skinRarity} disabled={formDisabled} onChange={(event) => { setSkinRarity(event.target.value); void loadSkinPage({ q: skinQuery.trim(), categoryId: skinCategory, rarityCode: event.target.value }, false); }}><option value="">全部稀有度</option>{catalog?.rarities.map((rarity) => <option key={rarity.code} value={rarity.code}>{rarity.name}</option>)}</select></label></div>
        <div className="supply-choice-list">{catalog?.skins.map((skin) => <label key={skin.id} className="supply-choice"><input type="checkbox" checked={draft.skins.includes(skin.id)} disabled={formDisabled} onChange={(event) => setDraft((previous) => ({ ...previous, skins: event.target.checked ? [...previous.skins, skin.id] : previous.skins.filter((id) => id !== skin.id) }))} /><span>{skin.name}</span><small>{categoryNames.get(skin.categoryId) ?? "分类待核"}{skin.rarityCode ? ` · ${rarityNames.get(skin.rarityCode) ?? "稀有度待核"}` : ""}</small></label>)}</div>
        {draft.skins.length ? <p className="supply-selected">已选择 {draft.skins.length} 项：{draft.skins.map((id) => skinNames[id]).filter(Boolean).join("、") || "目录名称待加载"}</p> : <p className="supply-muted">尚未选择皮肤。</p>}
        {catalog?.nextCursor ? <button type="button" className="button secondary" disabled={formDisabled || loadingCatalog} onClick={() => void loadSkinPage({ q: skinQuery.trim(), categoryId: skinCategory, rarityCode: skinRarity, cursor: catalog.nextCursor ?? undefined }, true)}>{loadingCatalog ? "正在读取…" : "加载更多皮肤"}</button> : null}
      </section>

      <section id="entitlements" className="supply-section" aria-labelledby="entitlements-heading">
        <div className="supply-section-heading"><div><h2 id="entitlements-heading">权益及有效期</h2><p>定时权益必须填写到期时间；未知时保持“未知”，不默认永久有效。</p></div></div>
        <div className="supply-entitlement-list">{catalog?.entitlements.map((item) => { const selected = selectedEntitlement(item.id); const numeric = item.valueKind !== "FLAG"; const valueLabel = item.valueKind === "LEVEL" ? "等级" : item.valueKind === "CAPACITY" ? "容量" : "是否拥有"; return <div key={item.id} className="supply-entitlement"><label className="supply-choice"><input type="checkbox" checked={Boolean(selected)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, event.target.checked, numeric ? "" : undefined, undefined, item.expiryKind)} /><span>{item.name}</span><small>{valueLabel}{item.expiryKind === "TIMED" ? " · 定时权益" : " · 长期权益"}</small></label>{selected && numeric ? <label>{valueLabel}<input inputMode="numeric" value={selected.value === null ? "" : String(selected.value)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, true, event.target.value, selected.expiresAt ?? undefined, item.expiryKind)} placeholder="未申报" /></label> : null}{selected && item.expiryKind === "TIMED" ? <label>有效期至<input type="datetime-local" value={localDateTime(selected.expiresAt)} disabled={formDisabled} onChange={(event) => changeEntitlement(item.id, true, numeric ? String(selected.value ?? "") : undefined, event.target.value, item.expiryKind)} /> <small>{selected.expiryKnowledge === "UNKNOWN" ? "未知到期时间，报价会阻塞。" : "按本地时间填写，提交时转换为标准时间。"}</small></label> : null}</div>; })}</div>
      </section>

      <section id="media" className="supply-section" aria-labelledby="media-heading">
        <div className="supply-section-heading"><div><h2 id="media-heading">图片与凭证</h2><p>公开展示图和私有凭证分开上传。私有凭证只用于审核，不进入公开图片组件。</p></div></div>
         <div className="supply-media-columns">
          {(["ACCOUNT_DISPLAY", "ACCOUNT_EVIDENCE"] as const).map((purpose) => { const rows = purpose === "ACCOUNT_DISPLAY" ? boundDisplay : boundEvidence; return <div className="supply-media-panel" key={purpose}><div className="supply-media-heading"><FileImage size={18} /><div><h3>{purpose === "ACCOUNT_DISPLAY" ? "公开展示图" : "私有审核凭证"}</h3><p>{purpose === "ACCOUNT_DISPLAY" ? "审核通过后可出现在公开详情。" : "不生成公开 URL，不对租客展示。"}</p></div></div><label className="supply-upload"><Upload size={17} />选择图片<input type="file" accept="image/*" multiple disabled={formDisabled || !gameId} onChange={(event) => selectFiles(purpose, event)} /></label><div className="supply-media-list">{rows.map((item) => <div key={item.id} className="supply-media-row"><span>{item.file?.name ?? "已上传图片"}</span><small>{mediaStatusText(item)}</small><div className="supply-inline-actions">{item.status === "failed" && item.file ? <button type="button" className="button quiet" onClick={() => void upload(item)}>重试上传</button> : null}<button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} onClick={() => removeMedia(item.id)}><Trash2 size={15} />移除</button></div></div>)}{rows.length === 0 ? <p className="supply-muted">尚未上传。</p> : null}</div></div>; })}
        </div>
        <FieldError text={fieldError("mediaBindings")} />
      </section>

      <section id="rules" className="supply-section" aria-labelledby="rules-heading">
        <div className="supply-section-heading"><div><h2 id="rules-heading">租期、报价与协议</h2><p>这里显示本次返回的租期、金额、阻塞原因和协议正文。</p></div></div>
         <div className="supply-grid"><label>租期选项<select value={draft.termOptionCode} disabled={formDisabled || !options} onChange={(event) => setDraft({ ...draft, termOptionCode: event.target.value })}><option value="">选择租期</option>{options?.termOptions.map((option) => <option key={option.code} value={option.code}>{option.name} · 每日消耗量 {quantityText(option.dailyConsumption, "HAFF_BASE")}</option>)}</select><FieldError text={fieldError("termOptionCode")} /></label><label>计价选项<select value={draft.pricingOptionCode} disabled={formDisabled || !options} onChange={(event) => setDraft({ ...draft, pricingOptionCode: event.target.value })}><option value="">选择计价方案</option>{options?.pricingOptionCodes.map((code, index) => <option key={code} value={code}>计价方案 {index + 1}</option>)}</select><FieldError text={fieldError("pricingOptionCode")} /></label></div>
        {blockers.length ? <div className="supply-blockers" role="alert"><strong>当前不能提交</strong>{[...new Set(blockers)].map((code) => <p key={code}>{blockerText(code)}</p>)}</div> : null}
        {quoteData ? <div className="supply-quote" aria-live="polite"><div className="supply-quote-heading"><h3>本次报价</h3><span>租期 {durationText(quoteData.termSeconds)}</span></div><dl><div><dt>资源计费</dt><dd>{moneyText(quoteData.resourceTotal)}</dd></div><div><dt>号主侧金额</dt><dd>{moneyText(quoteData.ownerTotal)}</dd></div><div><dt>租客押金</dt><dd>{moneyText(quoteData.tenantDeposit)}</dd></div><div><dt>发布保证金要求</dt><dd>{moneyText(quoteData.publisherBailRequirement)}</dd></div></dl><p className="supply-muted">金额、租期和数量均来自本次报价；单位金额仅作信息展示。没有小时费或皮肤加价。</p>{quoteData.expiryDisclosures.length ? <div className="supply-expiry-list"><strong>权益有效期说明</strong>{quoteData.expiryDisclosures.map((item) => <p key={item.entitlementId}>{catalog?.entitlements.find((entitlement) => entitlement.id === item.entitlementId)?.name ?? "该项权益"}：{item.expiresAt ? formatDate(item.expiresAt) : "未确认到期时间"} · 本租期不保证完整权益有效期</p>)}</div> : null}</div> : <div className="supply-empty-quote"><p>尚未取得报价。保存草稿后可获取报价。</p></div>}
        {agreement ? <div className="supply-agreement"><h3>{agreement.title}</h3><div className="supply-agreement-body">{agreement.body}</div><label className="supply-check"><input type="checkbox" checked={agreementChecked} disabled={formDisabled || !quoteData} onChange={(event) => setAgreementChecked(event.target.checked)} />我已阅读并同意当前协议</label><button type="button" className="button secondary" disabled={formDisabled || !quoteData || busy === "accept"} onClick={() => void acceptRules()}>{busy === "accept" ? "确认中…" : rulesAccepted ? "已按当前版本确认" : "确认规则与协议"}</button></div> : <p className="supply-muted">当前规则协议尚未配置。</p>}
      </section>

      <div className="publish-actions supply-actions"><button type="button" className="button secondary" disabled={formDisabled} onClick={() => void save()}>{busy === "save" ? "保存中…" : "保存草稿"}</button><button type="button" className="button secondary" disabled={formDisabled} onClick={() => void quote()}>{busy === "quote" ? "获取报价中…" : "获取报价"}</button><button className="button primary" disabled={formDisabled || !rulesAccepted}>{busy === "submit" ? "提交中…" : "提交审核"}<Send size={16} /></button><span>草稿保存在账号下；提交后按审核状态继续处理。</span></div>
    </form>
  </ServiceShell>;
}

type AccountRow = { id: string; title: string | null; game_name: string; review_state: string | null; sequence: string | null; owner_paused: boolean; staff_restricted: boolean };
const accountViews = { rentals: "租入订单", leased: "出租订单", accounts: "账号管理", security: "账户安全", favorites: "我的收藏", invite: "我的邀请码" } as const;

function AccountActionError({ error, onRetry }: { error: SupplyRequestError | null; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="supply-notice is-error" role="alert"><AlertCircle size={17} /><span>{error.message}</span>{error.status === 0 && onRetry ? <button type="button" className="button quiet" onClick={onRetry}>重试</button> : null}</div>;
}

function AccountUnavailable({ label }: { label: string }) {
  return <section className="account-guest"><AlertCircle size={30} aria-hidden="true" /><h2>{label}暂未开放</h2><p>这项功能正在准备中，其他个人中心入口仍可使用。</p></section>;
}

export function AccountWorkspace({ view, accountId }: { view: string; accountId?: string }) {
  const router = useRouter();
  const session = useUserSession();
  const active = Object.hasOwn(accountViews, view) ? view as keyof typeof accountViews : "rentals";
  const description = active === "security" ? "查看账号状态并提交注销申请。" : "查看个人供给状态，并按允许的状态流程处理出租账号。";
  useEffect(() => {
    if (session.status !== "guest") return;
    const target = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(target)}`);
  }, [router, session.status]);
  if (session.status === "loading") return <ServiceShell title={accountViews[active]} description={description}><section className="account-guest" aria-busy="true"><h2>正在准备个人中心…</h2><p>请稍候。</p></section></ServiceShell>;
  if (session.status === "error") return <ServiceShell title={accountViews[active]} description={description}><section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>登录状态暂未确认</h2><p>暂未确认登录结果，请重试后继续。</p><button type="button" className="button secondary" onClick={session.revalidate}>重试</button></section></ServiceShell>;
  if (session.status === "guest") return <ServiceShell title={accountViews[active]} description={description}><section className="account-guest" aria-busy="true"><LockKeyhole size={30} /><h2>正在转到登录</h2></section></ServiceShell>;
  return <ServiceShell title={accountViews[active]} description={description}>
    <nav className="account-tabs" aria-label="个人事务分类">{Object.entries(accountViews).map(([key, label]) => <Link key={key} href={`/account?view=${key}${key === "accounts" && accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}`} aria-current={active === key ? "page" : undefined}>{label}</Link>)}</nav>
    {active === "accounts" ? <MyAccountsPanel accountId={accountId} /> : active === "security" ? <AccountSecurityPanel /> : active === "favorites" ? <FavoritesProvider><FavoritesPanel /></FavoritesProvider> : <AccountUnavailable label={accountViews[active]} />}
  </ServiceShell>;
}

type AccountProfile = { id: string; name?: string | null; username?: string | null; phoneNumber?: string | null };
type AccountSessionResponse = { user?: AccountProfile } | null;

function AccountSecurityPanel() {
  const session = useUserSession();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [identity, setIdentity] = useState<UserIdentitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const currentUserIdRef = useRef(session.userId);
  currentUserIdRef.current = session.userId;

  const load = useCallback(async () => {
    const actingUserId = session.userId;
    if (!actingUserId) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const current = await webAuthRequest<AccountSessionResponse>("/get-session", undefined, controller.signal);
      const currentIdentity = await webAuthRequest<UserIdentitySnapshot>("/identity/status", undefined, controller.signal);
      if (controller.signal.aborted || currentUserIdRef.current !== actingUserId || current?.user?.id !== actingUserId) return;
      setProfile(current?.user ?? null);
      setIdentity(currentIdentity);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof WebAuthError && failure.status === 401) {
        session.revalidate();
        return;
      }
      setError("账号安全信息暂时无法读取，请重试。");
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [session.revalidate, session.userId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [load]);

  const cancelAccount = async () => {
    if (busy || !profile || profile.id !== currentUserIdRef.current) return;
    if (!window.confirm("注销会撤销当前会话，并匿名化普通资料。请先处理未完成订单等事项，再继续。确认注销吗？")) return;
    const actingUserId = profile.id;
    setBusy("cancel");
    setError("");
    setNotice("");
    try {
      await webAuthRequest<{ status: UserIdentitySnapshot["accountStatus"] }>("/account/cancel", { reason: "用户在账户安全页提交注销" });
      if (currentUserIdRef.current !== actingUserId) return;
      setNotice("账号已注销，必要历史关联保留；当前会话已撤销。");
      session.revalidate();
      publishUserSessionChange();
    } catch (failure) {
      if (currentUserIdRef.current !== actingUserId) return;
      setError(failure instanceof WebAuthError ? cancellationFailureMessage(failure.status, failure.code) : "注销未完成，请稍后重试。");
    } finally {
      if (currentUserIdRef.current === actingUserId) setBusy("");
    }
  };

  if (loading) return <section className="account-security" aria-busy="true"><div className="account-security-heading"><div><p className="account-security-kicker">账户安全</p><h2>账户与登录安全</h2><p>正在读取当前账号的安全信息。</p></div></div><p className="account-security-loading" role="status">正在读取…</p></section>;
  if (error && !profile) return <section className="account-security" role="alert"><div className="account-security-heading"><div><p className="account-security-kicker">账户安全</p><h2>暂时无法读取</h2><p>{error}</p></div></div><button type="button" className="button secondary" onClick={() => void load()}>重试</button></section>;
  return <section className="account-security" aria-labelledby="account-security-heading">
    <div className="account-security-heading"><div><p className="account-security-kicker">账户安全</p><h2 id="account-security-heading">账户与登录安全</h2><p>查看当前账号信息，或提交注销申请。</p></div></div>
    {error ? <p className="supply-notice is-error" role="alert">{error}</p> : null}
    {notice ? <p className="supply-notice is-success" role="status">{notice}</p> : null}
    <dl className="account-security-facts"><div><dt>账号名</dt><dd>{profile?.username || "未设置"}</dd></div><div><dt>手机号</dt><dd>{profile?.phoneNumber ? maskPhone(profile.phoneNumber) : "未绑定"}</dd></div><div><dt>账号状态</dt><dd>{identity ? accountStatusLabel(identity.accountStatus) : "暂无法确认"}</dd></div></dl>
    <div className="account-security-danger"><div><h3>注销账号</h3><p>注销会撤销会话并匿名化普通资料；未完成订单等事项需先处理。</p></div><button type="button" className="button secondary" disabled={Boolean(busy) || !profile} onClick={() => void cancelAccount()}>{busy === "cancel" ? "提交中…" : "注销账号"}</button></div>
  </section>;
}

function MyAccountsPanel({ accountId: accountIdProp }: { accountId?: string }) {
  const router = useRouter();
  const sharedSession = useUserSessionStore();
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [detail, setDetail] = useState<MySupply | null>(null);
  const [latest, setLatest] = useState<MySupply | null>(null);
  const [identityState, setIdentityState] = useState<IdentityState>("checking");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<SupplyRequestError | null>(null);
  const [notice, setNotice] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const identity = useRef<SessionId>(undefined);
  const identityStatusRef = useRef<IdentityState>("checking");
  const identityPauseGate = useRef(new IdentityPauseGate());
  const controllers = useRef(new Set<AbortController>());
  const pendingKeys = useRef(new Map<string, { fingerprint: string; key: string }>());
  const lastRetry = useRef<RetryTask | null>(null);
  const lastActionRetry = useRef<RetryTask | null>(null);
  const accountRef = useRef(accountIdProp);
  const routeAccountRef = useRef(accountIdProp);
  const listRequestRef = useRef(0);
  const nextCursorRef = useRef<string | null>(null);

  const beginRequest = () => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  };
  const finishRequest = (controller: AbortController) => controllers.current.delete(controller);
  const currentContext = useCallback((context: RequestContext, signal?: AbortSignal) =>
    mounted.current && context.gameId === "accounts" && context.epoch === epoch.current && identity.current === context.identity &&
    (context.accountId === undefined || accountRef.current === context.accountId) && !signal?.aborted, []);
  const waitForIdentity = useCallback((context: RequestContext) =>
    identityPauseGate.current.wait(() => currentContext(context)), [currentContext]);
  const captureContext = (accountId = accountRef.current): RequestContext => ({ epoch: epoch.current, identity: identity.current, accountId, gameId: "accounts" });
  const setIdentityPhase = (next: IdentityState) => {
    identityStatusRef.current = next;
    setIdentityState(next);
  };

  const actionKey = (operation: string, body: unknown) => {
    const fingerprint = JSON.stringify(body);
    const previous = pendingKeys.current.get(operation);
    if (previous?.fingerprint === fingerprint) return previous.key;
    const key = newKey();
    pendingKeys.current.set(operation, { fingerprint, key });
    return key;
  };
  const finishKey = (operation: string, body: unknown) => {
    if (pendingKeys.current.get(operation)?.fingerprint === JSON.stringify(body)) pendingKeys.current.delete(operation);
  };
  const invalidateContext = useCallback((message: string, requireAuth: boolean) => {
    epoch.current += 1;
    identityPauseGate.current.cancelWaiters();
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
    pendingKeys.current.clear();
    lastRetry.current = null;
    lastActionRetry.current = null;
    accountRef.current = undefined;
    setRows([]);
    setDetail(null);
    setLatest(null);
    setNextCursor(null);
    nextCursorRef.current = null;
    setLoading(false);
    setLoadingMore(false);
    setBusy("");
    setError(null);
    setNotice(message);
    setAuthRequired(requireAuth);
  }, []);
  const syncIdentity = useCallback(async (): Promise<boolean> => {
    const snapshot = sharedSession.getSnapshot();
    if (snapshot.status === "loading" || snapshot.status === "error") {
      if (snapshot.status === "error") identityPauseGate.current.markFailed();
      else identityPauseGate.current.startCheck();
      setIdentityPhase(snapshot.status === "loading" ? "checking" : "failed");
      return false;
    }
    const next = snapshot.userId;
    const previous = identity.current;
    identity.current = next;
    if (previous !== undefined && previous !== next) {
      invalidateContext("登录身份已变化，旧账号资料已清除。", !next);
      if (accountIdProp) router.replace("/account?view=accounts");
    }
    identityPauseGate.current.markConfirmed();
    setAuthRequired(!next);
    setIdentityPhase("confirmed");
    return !(previous !== undefined && previous !== next && accountIdProp);
  }, [sharedSession, invalidateContext, router, accountIdProp]);
  const load = useCallback(async (requestedId?: string, append = false, cursor?: string) => {
    if (identityStatusRef.current !== "confirmed") return;
    if (!identity.current) {
      setAuthRequired(true);
      setLoading(false);
      return;
    }
    const id = requestedId ?? accountRef.current;
    if (!append && id !== accountRef.current) {
      accountRef.current = id;
      setDetail(null);
      setLatest(null);
    }
    const requestEpoch = epoch.current;
    const requestId = ++listRequestRef.current;
    const requestCursor = append ? cursor ?? nextCursorRef.current ?? undefined : undefined;
    const request = { id: requestId, key: JSON.stringify({ accountId: id ?? "", append, cursor: requestCursor ?? "" }) };
    const isCurrent = () => isCurrentQuery(request, listRequestRef.current, request.key);
    const context = captureContext(id);
    const controller = beginRequest();
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      if (!(await waitForIdentity(context))) return;
      const params = new URLSearchParams({ limit: "50" });
      if (requestCursor) params.set("cursor", requestCursor);
      const page = await supplyApi.myAccounts(params, controller.signal);
      if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
      lastRetry.current = null;
      if (!append) lastActionRetry.current = null;
      setRows((previous) => {
        if (!append) return page.items;
        return mergePageById(previous, page.items);
      });
      setNextCursor(page.nextCursor);
      nextCursorRef.current = page.nextCursor;
      setAuthRequired(false);
      if (id && !append) {
        if (!(await waitForIdentity(context))) return;
        const next = await supplyApi.mine(id, controller.signal);
        if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
        setDetail(next);
      }
    } catch (failure) {
      if (!currentContext({ ...context, epoch: requestEpoch }, controller.signal) || !isCurrent()) return;
      const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
      setError(nextError);
      if (nextError.status === 401) setAuthRequired(true);
      if (nextError.status === 0) lastRetry.current = { context, busy: append ? "accounts-more" : "accounts", run: () => load(id, append, requestCursor) };
    } finally {
      if (currentContext({ ...context, epoch: requestEpoch }, controller.signal) && isCurrent()) {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
      finishRequest(controller);
    }
  }, [currentContext, waitForIdentity]);
  useEffect(() => {
    mounted.current = true;
    if (routeAccountRef.current !== accountIdProp) {
      routeAccountRef.current = accountIdProp;
      invalidateContext(accountIdProp ? "正在读取新的出租账号。" : "正在读取你的出租账号。", false);
      accountRef.current = accountIdProp;
    }
    const onFocus = () => { void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); }); };
    const unsubscribeIdentity = sharedSession.subscribe(onFocus);
    void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); });
    return () => {
      mounted.current = false;
      epoch.current += 1;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      pendingKeys.current.clear();
      lastRetry.current = null;
      lastActionRetry.current = null;
      identityPauseGate.current.cancel();
      unsubscribeIdentity();
    };
  }, [accountIdProp, invalidateContext, load, syncIdentity, sharedSession]);

  const reloadDetail = async (replace = false) => {
    const id = accountRef.current;
    if (!id || identityStatusRef.current !== "confirmed" || !identity.current) return;
    const context = captureContext(id);
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    try {
      const next = await supplyApi.mine(id, controller.signal);
      if (!currentContext(context, controller.signal)) return;
       if (replace) { setDetail(next); setLatest(null); setNotice("已采用最新状态。"); }
      else setLatest(next);
      setError(null);
      lastRetry.current = null;
      lastActionRetry.current = null;
    } catch (failure) {
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        if (nextError.status === 0) lastRetry.current = { context, busy: "detail", run: () => reloadDetail(replace) };
      }
    } finally {
      finishRequest(controller);
    }
  };
  const executeAction = async (action: "withdraw" | "pause" | "resume", context: RequestContext, body: { accountId: string; expectedRevision: string; versionId: string; action: string }, key: string): Promise<void> => {
    if (!(await waitForIdentity(context))) return;
    const controller = beginRequest();
    try {
      const next = action === "withdraw"
        ? await supplyApi.withdraw(context.accountId!, body.expectedRevision, body.versionId, key, undefined, controller.signal)
        : await supplyApi.setPaused(context.accountId!, action === "pause", body.expectedRevision, key, undefined, controller.signal);
      if (!currentContext(context, controller.signal)) return;
      finishKey(action, body);
      setDetail(next);
      setLatest(null);
      setRows((previous) => previous.map((row) => row.id === context.accountId ? { ...row, review_state: next.version?.reviewState ?? null, owner_paused: next.account.owner_paused, staff_restricted: next.account.staff_restricted } : row));
       setNotice(action === "withdraw" ? "已撤回当前审核版本；修改请创建新草稿。" : action === "pause" ? "已暂停接单。" : "已恢复接单，资格检查已完成。");
      lastActionRetry.current = null;
      lastRetry.current = null;
    } catch (failure) {
      if (currentContext(context, controller.signal)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        if (nextError.status === 0) lastActionRetry.current = { context, busy: action, run: () => executeAction(action, context, body, key) };
        if (nextError.status === 409) void reloadDetail(false);
      }
    } finally {
      if (currentContext(context, controller.signal)) setBusy("");
      finishRequest(controller);
    }
  };
  const runAction = async (action: "withdraw" | "pause" | "resume") => {
    if (identityStatusRef.current !== "confirmed" || !identity.current || !detail?.version) return;
    const id = detail.account.id;
    const context = captureContext(id);
    const body = { accountId: id, expectedRevision: detail.account.revision, versionId: detail.version.id, action };
    const key = actionKey(action, body);
    setBusy(action);
    setError(null);
    await executeAction(action, context, body, key);
  };
  const retryLast = async () => {
    const task = lastActionRetry.current ?? lastRetry.current;
    if (!task || !currentContext(task.context)) {
      lastActionRetry.current = null;
      lastRetry.current = null;
      return;
    }
    if (lastActionRetry.current === task) lastActionRetry.current = null;
    else lastRetry.current = null;
    setBusy(task.busy);
    setError(null);
    try {
      await task.run();
    } catch (failure) {
      if (currentContext(task.context)) {
        const nextError = failure instanceof SupplyRequestError ? failure : new SupplyRequestError(0, null);
        setError(nextError);
        if (nextError.status === 0) lastRetry.current = task;
      }
    } finally {
      if (currentContext(task.context)) setBusy("");
    }
  };

  const visibleDetail = detail && (!accountIdProp || detail.account.id === accountIdProp) ? detail : null;
  if (identityState === "checking") return <section className="account-guest" aria-busy="true"><h2>正在确认登录身份…</h2><p>确认期间暂不展示私人账号状态，也不会继续读取或修改账号。</p></section>;
  if (identityState === "failed") return <section className="account-guest" role="alert"><LockKeyhole size={30} /><h2>暂时无法确认登录身份</h2><p>当前账号状态仍保留在本页，确认恢复后可继续；期间不会读取或修改账号。</p><button type="button" className="button secondary" onClick={() => void syncIdentity().then((confirmed) => { if (confirmed && mounted.current) void load(accountIdProp); })}>重试身份确认</button></section>;
  if (loading && rows.length === 0) return <section className="account-guest" aria-busy="true"><h2>正在读取出租账号…</h2><p>只展示当前登录身份拥有的供给。</p></section>;
  return <section className="my-accounts-panel"><AccountActionError error={error} onRetry={error?.status === 0 ? () => void retryLast() : undefined} />{notice ? <div className="supply-notice" role="status"><Check size={17} />{notice}</div> : null}{authRequired ? <div className="supply-auth-block"><LockKeyhole size={18} /><span>登录后才能查看你的出租账号。</span><Link className="button secondary" href={`/login?next=${encodeURIComponent("/account?view=accounts")}`}>登录 / 注册</Link></div> : null}<div className="my-accounts-layout"><div className="supply-account-list" aria-busy={loading || loadingMore}><div className="supply-list-heading"><h2>我的出租账号</h2><Link href="/publish" className="button primary">新建出租账号</Link></div>{rows.length === 0 ? <div className="supply-empty-quote"><p>{loading ? "正在读取…" : error ? "暂时无法读取账号列表，请查看上方提示。" : "还没有出租账号。"}</p>{!loading && !error ? <Link href="/publish">去发布资料</Link> : null}</div> : rows.map((row) => <Link className={`supply-account-row ${row.id === visibleDetail?.account.id ? "is-current" : ""}`} key={row.id} href={`/account?view=accounts&accountId=${encodeURIComponent(row.id)}`}><span><strong>{row.title ?? "未命名草稿"}</strong><small>{row.game_name} · {row.sequence ? `版本 ${row.sequence}` : "尚无版本"}</small></span><span className="supply-account-state">{row.review_state ? stateLabel(row.review_state as never) : "未创建草稿"}{row.owner_paused ? " · 已暂停" : ""}</span></Link>)}{nextCursor ? <button type="button" className="button secondary" disabled={loadingMore || identityState !== "confirmed"} onClick={() => void load(undefined, true, nextCursor)}>{loadingMore ? "正在读取更多…" : "加载更多账号"}</button> : null}</div>{visibleDetail ? <AccountDetail detail={visibleDetail} latest={latest} busy={busy} identityReady={identityState === "confirmed" && Boolean(identity.current)} onAction={runAction} onRefresh={() => void reloadDetail(false)} onAdopt={() => void reloadDetail(true)} /> : <div className="supply-empty-quote"><p>{error && accountIdProp ? "暂时无法读取所选账号详情，请查看上方提示。" : "选择左侧账号查看详情和生命周期操作。"}</p></div>}</div></section>;
}

function AccountDetail({ detail, latest, busy, identityReady, onAction, onRefresh, onAdopt }: { detail: MySupply; latest: MySupply | null; busy: string; identityReady: boolean; onAction: (action: "withdraw" | "pause" | "resume") => Promise<void>; onRefresh: () => void; onAdopt: () => void }) {
  const version = detail.version;
  const reasons = detail.decisions?.filter((decision) => decision.decision === "REJECT") ?? [];
  const blockers = [...(detail.blockers ?? []), ...(detail.account.staff_restricted ? ["STAFF_RESTRICTED"] : [])];
  const canPause = Boolean(version?.reviewState === "APPROVED" && !detail.account.owner_paused);
  const canResume = Boolean(detail.account.owner_paused);
  return <div className="supply-account-detail"><div className="supply-detail-heading"><div><h2>{version?.declaration.title || "未命名出租账号"}</h2><p>{version ? stateLabel(version.reviewState) : "尚未创建发布版本"}</p></div><Link href={`/publish?accountId=${encodeURIComponent(detail.account.id)}&edit=1`} className="button secondary">{version?.reviewState === "DRAFT" ? "继续编辑" : "创建修改草稿"}</Link></div>{latest ? <div className="supply-conflict"><strong>资料状态已变化</strong><p>当前状态：{latest.version ? stateLabel(latest.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onRefresh}>重新读取</button><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onAdopt}>采用最新状态</button></div></div> : null}{blockers.length ? <div className="supply-blockers" role="alert"><strong>当前限制</strong>{[...new Set(blockers)].map((code) => <p key={code}>{blockerText(code)}</p>)}</div> : null}{reasons.length ? <div className="supply-decisions"><h3>退回原因</h3>{reasons.map((decision) => <p key={decision.id}>{decision.reason}</p>)}</div> : null}<dl className="supply-detail-facts"><div><dt>号主侧金额</dt><dd>{moneyText(version?.quote?.ownerTotal)}</dd></div><div><dt>发布保证金要求</dt><dd>{moneyText(version?.quote?.publisherBailRequirement)}</dd></div><div><dt>公开展示图</dt><dd>{version?.declaration.mediaBindings.filter((item) => item.purpose === "ACCOUNT_DISPLAY").length ?? 0} 张</dd></div><div><dt>私有审核凭证</dt><dd>{version?.declaration.mediaBindings.filter((item) => item.purpose === "ACCOUNT_EVIDENCE").length ?? 0} 张，仅审核可见</dd></div></dl>{version?.declaration.description ? <div className="supply-detail-copy"><h3>公开说明</h3><p>{version.declaration.description}</p></div> : null}<div className="supply-inline-actions">{version?.reviewState === "SUBMITTED" ? <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => void onAction("withdraw")}><Undo2 size={16} />{busy === "withdraw" ? "撤回中…" : "撤回审核"}</button> : null}{canPause ? <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => void onAction("pause")}><Pause size={16} />{busy === "pause" ? "暂停中…" : "暂停接单"}</button> : null}{canResume ? <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => void onAction("resume")}><Play size={16} />{busy === "resume" ? "恢复中…" : "恢复接单"}</button> : null}<button type="button" className="button quiet" disabled={!identityReady || busy !== ""} onClick={onRefresh}><RefreshCw size={15} />读取最新状态</button></div><p className="supply-muted">撤回、暂停和恢复会进行资格与对象检查；本页不展示凭证链接。</p></div>;
}
